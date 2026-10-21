#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# =============================================================================
# fetch_signal_history.sh — CGI Endpoint for Signal History Chart Data
# =============================================================================
# Two shapes behind one endpoint, and the FIRST one is byte-for-byte what this
# endpoint has always returned, because the dashboard chart reads it:
#
#   1. NO query string  -> the per-antenna signal history NDJSON file served as
#                          a JSON array. Nothing below the early exit runs.
#   2. ?range=now|1h|3h|6h|12h|24h|7d|30d|90d
#                       -> {success, range, generated_at, bucket_sec, snapshot,
#                           series:{<panel>:[{ts,v}]}, missing:[<panel>]}
#
# ?panels=<csv> narrows the series to the named panels. Unknown ids are IGNORED,
# not fatal — a newer UI naming a panel an older device does not have gets the
# panels it does have.
#
# PANELS (the whole vocabulary): rsrp sinr rsrq rssi temp cqi rank mcs tx_power
# total_cells.
#
# EVERY value is a JSON number or null, never 0 for absent: 0 dBm is a
# measurement, null is "the modem did not say", and a chart must draw the second
# as a gap rather than as a reading of zero.
#
# SNAPSHOT = the live PHY depth the poller's Tier 3 publishes into
# /tmp/qmanager_status.json as `phy` (lib/qmanager/phy_metrics.sh owns the shape
# and its joins). It is served verbatim after a type-normalising pass, so an
# older cache — or a fresh boot before the first Tier-3 pass — still answers with
# the full key set and nulls, never with a missing key the UI has to guess at.
#
# SERIES = the durable archive, /usrdata/qmanager/metrics/YYYY-MM-DD.csv, one row
# per minute, written by the poller (spec R3). Line 1 of each file is the schema
# marker and carries the column names; columns are resolved BY NAME below, so a
# column added later does not shift these readers.
#
# Panel -> column resolution, in one place, because the panel names are
# RAT-neutral and the archive carries both RATs:
#     rsrp        nr_rsrp    -> lte_rsrp
#     rsrq        nr_rsrq    -> lte_rsrq
#     sinr        nr_sinr    -> lte_sinr
#     rssi        lte_rssi              (NR has no RSSI)
#     cqi         nr_cqi     -> lte_cqi
#     rank        nr_mimo_layers -> lte_mimo_layers
#     mcs         nr_dl_mcs  -> nr_ul_mcs -> lte_ul_mcs
#     tx_power    nr_tx_power           (LTE TX power does not exist on RG520N-EB)
#     temp        temp                  (device temperature, from the poller)
#     total_cells total_cells           (carrier components being aggregated)
# NR first on the shared names because on this modem NR is the leg that carries
# traffic in NSA; on an LTE-only attach the NR columns are empty and the LTE
# column answers. The stored nulls make that fallback exact rather than a guess.
#
# WINDOW. The window ENDS at the newest archived row, not at the wall clock —
# an archive that stopped updating shows its last window instead of an empty
# chart (docs/reference/latency-monitor.md:64). Bucket sizes are chosen so every
# range yields 60-360 points; the source is one row per minute, so a 6h range
# unbucketed would be 360 points for a chart a few hundred pixels wide.
#
# MISSING[] names the requested panels with no archived value anywhere in the
# window, so the UI can disable a pill rather than draw an empty chart. It is
# computed per response, so a panel that has data at 7d but not at 1h is
# "present" at 7d and "missing" at 1h — which is what a pill should reflect.
#
# Retention keeps the archive at 30 days, so a 90d request serves the 30 days
# that exist. It does not pretend to have more.
#
# Endpoint: GET /cgi-bin/quecmanager/at_cmd/fetch_signal_history.sh
# Response: application/json
#
# Install location: /www/cgi-bin/quecmanager/at_cmd/fetch_signal_history.sh
# =============================================================================

SIGNAL_HISTORY_FILE="/tmp/qmanager_signal_history.json"
STATUS_FILE="/tmp/qmanager_status.json"
ARCHIVE_DIR="${QM_PHY_ARCHIVE_DIR:-/usrdata/qmanager/metrics}"
ARCHIVE_SCHEMA="qm_phy_archive,1"
SANE_EPOCH=1700000000
PANELS="rsrp sinr rsrq rssi temp cqi rank mcs tx_power total_cells"

qlog_init "cgi_fetch_signal_history"
cgi_headers
cgi_handle_options

# --- The pre-feature endpoint, untouched -------------------------------------
# Not one line below this block executes for it: no range parse, no archive
# read, no jq program of its own. serve_ndjson_as_array is the same helper, on
# the same file, that this endpoint has always called.
if [ -z "$QUERY_STRING" ]; then
    serve_ndjson_as_array "$SIGNAL_HISTORY_FILE"
    exit 0
fi

# qparam <name> [default] — one value out of QUERY_STRING.
# Panel ids and range names are [a-z0-9_] only, so no URL-decoding is done;
# anything percent-escaped simply fails to match and is treated as unknown.
qparam() {
    local q="$QUERY_STRING" pair
    while [ -n "$q" ]; do
        pair="${q%%&*}"
        case "$pair" in
            "$1="*) printf '%s' "${pair#*=}"; return 0 ;;
        esac
        case "$q" in
            *"&"*) q="${q#*&}" ;;
            *) q="" ;;
        esac
    done
    printf '%s' "${2:-}"
}

# The accepted list is the contract's own wording; it is repeated to the caller
# in both `message` and `detail` because this endpoint's API contract (shared by
# the backend and the page) names the field `message` while every other CGI here
# names it `detail` (cgi_base.sh cgi_error). Serving both keeps either caller
# working; the string is identical so there is nothing to disagree about.
emit_invalid_range() {
    local msg out
    msg="range must be now, 1h, 3h, 6h, 12h, 24h, 7d, 30d or 90d"
    out=$(jq -n --arg m "$msg" \
        '{success:false, error:"invalid_range", message:$m, detail:$m}' 2>/dev/null)
    if [ -n "$out" ]; then
        printf '%s\n' "$out"
    else
        printf '{"success":false,"error":"invalid_range","message":"%s","detail":"%s"}\n' "$msg" "$msg"
    fi
    exit 0
}

range=$(qparam range "")
live_mode=false
bucket=""
case "$range" in
    now) live_mode=true; span=0;     bucket=null ;;
    1h)  span=3600;    bucket=60 ;;
    3h)  span=10800;   bucket=180 ;;
    6h)  span=21600;   bucket=300 ;;
    12h) span=43200;   bucket=600 ;;
    24h) span=86400;   bucket=900 ;;
    7d)  span=604800;  bucket=3600 ;;
    30d) span=2592000; bucket=7200 ;;
    90d) span=7776000; bucket=21600 ;;
    *)   emit_invalid_range ;;
esac

# --- panels filter -----------------------------------------------------------
panels_req=$(qparam panels "")
if [ -n "$panels_req" ]; then
    sel=""
    for p in $PANELS; do
        case ",$panels_req," in
            *",$p,"*) sel="$sel $p" ;;
        esac
    done
    sel="${sel# }"
    # A filter that matches nothing is ignored rather than treated as "no
    # series": an unknown id is not an error, and an empty answer would look
    # like an outage.
    [ -n "$sel" ] && PANELS="$sel"
fi

now=$(date +%s)
case "$now" in ''|*[!0-9]*) now=0 ;; esac

# --- snapshot ----------------------------------------------------------------
# Type-normalised pass over the poller's `phy` object. Every field is emitted,
# null when absent, so the page never has to distinguish "key missing" from
# "no value".
SNAPSHOT_JQ='
def n: if type == "number" then . else null end;
def s: if type == "string" then . else null end;
(.phy // {}) as $p
| (($p.lte) // {}) as $l
| (($p.nr)  // {}) as $r
| (($p.rrc) // {}) as $c
| {lte: {rsrp: ($l.rsrp | n), rsrq: ($l.rsrq | n), rssi: ($l.rssi | n),
         sinr: ($l.sinr | n), cqi: ($l.cqi | n), ri: ($l.ri | n),
         pmi: ($l.pmi | n), mimo_layers: ($l.mimo_layers | n),
         tm_mode: ($l.tm_mode | n), ul_mcs: ($l.ul_mcs | n)},
   nr: {rsrp: ($r.rsrp | n), rsrq: ($r.rsrq | n), sinr: ($r.sinr | n),
        cqi: ($r.cqi | n), ri: ($r.ri | n), pmi: ($r.pmi | n),
        mimo_layers: ($r.mimo_layers | n), dl_mcs: ($r.dl_mcs | n),
        ul_mcs: ($r.ul_mcs | n), tx_power: ($r.tx_power | n)},
   rrc: {rat: ($c.rat | s), state: ($c.state | n)},
   registered: (if ($p.registered | type) == "boolean" then $p.registered else null end),
   carrier: ($p.carrier | s),
   beams: (if ($p.beams | type) == "array" then [$p.beams[] | select(type == "object")] else [] end)}'

snapshot=$(jq -c "$SNAPSHOT_JQ" "$STATUS_FILE" 2>/dev/null)
case "$snapshot" in
    "{"*) ;;
    *) snapshot='{"lte":{"rsrp":null,"rsrq":null,"rssi":null,"sinr":null,"cqi":null,"ri":null,"pmi":null,"mimo_layers":null,"tm_mode":null,"ul_mcs":null},"nr":{"rsrp":null,"rsrq":null,"sinr":null,"cqi":null,"ri":null,"pmi":null,"mimo_layers":null,"dl_mcs":null,"ul_mcs":null,"tx_power":null},"rrc":{"rat":null,"state":null},"registered":null,"carrier":null,"beams":[]}' ;;
esac

# --- series ------------------------------------------------------------------
# One awk pass over the day files. awk and not jq: the full 30-day archive is
# ~43k rows, and jq on that many objects is the slow path on a single core
# (sites.sh measures 3.3s for a comparable row count; docs/reference/
# sites-monitor.md). awk emits one TSV line per panel+bucket and jq only shapes
# the ~thousands of results.
#
# Columns are resolved BY NAME from `col[]`, filled from the schema marker line,
# not by position: the marker exists so a future column cannot silently shift
# these readers.
AWK_AGG='
function isnum(v) { return v ~ /^-?[0-9]+([.][0-9]+)?$/ }
function num(v) { return (v != "" && v != "null" && isnum(v)) ? v + 0 : "" }
# panel value from one row, following the documented preference chain
function pv(p, F,   v) {
    if (p == "rsrp")        { v = num(F[col["nr_rsrp"]]);          if (v == "") v = num(F[col["lte_rsrp"]]) }
    else if (p == "rsrq")   { v = num(F[col["nr_rsrq"]]);          if (v == "") v = num(F[col["lte_rsrq"]]) }
    else if (p == "sinr")   { v = num(F[col["nr_sinr"]]);          if (v == "") v = num(F[col["lte_sinr"]]) }
    else if (p == "rssi")   { v = num(F[col["lte_rssi"]]) }
    else if (p == "cqi")    { v = num(F[col["nr_cqi"]]);           if (v == "") v = num(F[col["lte_cqi"]]) }
    else if (p == "rank")   { v = num(F[col["nr_mimo_layers"]]);   if (v == "") v = num(F[col["lte_mimo_layers"]]) }
    else if (p == "mcs")    { v = num(F[col["nr_dl_mcs"]]);
                              if (v == "") v = num(F[col["nr_ul_mcs"]]);
                              if (v == "") v = num(F[col["lte_ul_mcs"]]) }
    else if (p == "tx_power")    { v = num(F[col["nr_tx_power"]]) }
    else if (p == "temp")        { v = num(F[col["temp"]]) }
    else if (p == "total_cells") { v = num(F[col["total_cells"]]) }
    else v = ""
    return v
}
# schema marker: "#qm_phy_archive,1,ts,<col>,<col>,..."
# Columns are numbered from the marker, so ncol (the field count of a row) and
# every index below come from the file rather than from this program.
function schema(line,   a, k, nn, i) {
    if (substr(line, 1, 1) != "#") return 0
    nn = split(substr(line, 2), a, ",")
    if (nn < 3) return 0
    if (a[1] != schema_name) return 0
    if (a[2] != schema_ver) return 0
    for (i = 3; i <= nn; i++) col[a[i]] = i - 2
    ncol = nn - 2
    return 1
}
BEGIN {
    np = split(panels, PL, " ")
    have_schema = 0
}
# A new file re-arms the schema check, so a day file written by a different
# schema version is skipped instead of being read with the wrong column map.
FILENAME != prevfile { prevfile = FILENAME; have_schema = 0 }
{
    if (substr($0, 1, 1) == "#") { if (!have_schema) have_schema = schema($0); next }
    if (!have_schema) next
    # awks numeric coercion takes the longest numeric PREFIX of the line, so this
    # is the timestamp without splitting 23 fields. It matters: the full 30-day
    # archive is ~43k rows and a short range must reject almost all of them.
    t = $0 + 0
    if (t <= 0 || t < start || t > end) next
    nf = split($0, F, ",")
    if (nf != ncol) next                       # torn or foreign row
    b = (bucket > 0) ? int(t / bucket) * bucket : t
    for (i = 1; i <= np; i++) {
        v = pv(PL[i], F)
        if (v == "") continue
        k = PL[i] SUBSEP b
        if (!(k in N)) { PANEL[k] = PL[i]; BTS[k] = b; N[k] = 0; SUM[k] = 0 }
        N[k]++
        SUM[k] += v
    }
}
END {
    for (k in N)
        printf "%s\t%d\t%.1f\n", PANEL[k], BTS[k], SUM[k] / N[k]
}
'

JQ_ASSEMBLE='
[inputs | split("\t")
 | {p: .[0], ts: (.[1] | tonumber), v: (.[2] | tonumber)}] as $rows
| ($rows | group_by(.p)
   | map({key: .[0].p, value: (map({ts: .ts, v: .v}) | sort_by(.ts))})
   | from_entries) as $series
| {success: true,
   range: $range,
   generated_at: $gen,
   bucket_sec: $bucket,
   snapshot: $snapshot,
   series: ($panels | map(. as $p | {key: $p, value: ($series[$p] // [])}) | from_entries),
   missing: [$panels[] | select((($series[.] // []) | length) == 0)]}
'

# `empty` when the archive cannot be read at all (range=now, or a clock below
# the sane-epoch gate): no rows are read and no panels are requested, so series
# is {} and missing is empty — the pill logic then shows "no data" for this
# range instead of the page claiming a panel is broken.
panels_json=$(printf '%s\n' "$PANELS" | jq -Rc 'split(" ")' 2>/dev/null)
case "$panels_json" in
    "["*) ;;
    *) panels_json='[]' ;;
esac

if [ "$live_mode" = "true" ] || [ "$now" -lt "$SANE_EPOCH" ]; then
    printf '' | jq -nR --argjson snapshot "$snapshot" --arg range "$range" \
        --argjson gen "$now" --argjson bucket "$bucket" --argjson panels '[]' \
        "$JQ_ASSEMBLE"
    exit 0
fi

# Window end = newest archived row, not the wall clock.
files=""
newest=""
for f in "$ARCHIVE_DIR"/*.csv; do
    [ -f "$f" ] || continue
    files="$files $f"
    newest="$f"
done

end=$now
start=$(( end - span ))
if [ -z "$files" ]; then
    # No archive yet (fresh install, or the writer is disabled): an empty series
    # with every requested panel in missing[] is the honest answer.
    printf '' | jq -nR --argjson snapshot "$snapshot" --arg range "$range" \
        --argjson gen "$now" --argjson bucket "$bucket" \
        --argjson panels "$panels_json" \
        "$JQ_ASSEMBLE"
    exit 0
fi

last_ts=$(tail -n 1 "$newest" 2>/dev/null | cut -d, -f1)
case "$last_ts" in ''|*[!0-9]*) last_ts="" ;; esac
if [ -n "$last_ts" ] && [ "$last_ts" -ge "$SANE_EPOCH" ]; then
    end=$last_ts
    [ "$end" -gt "$now" ] && end=$now
    start=$(( end - span ))
fi

# Every day file is handed to awk and the WINDOW is applied per row there, on
# the timestamp prefix, before a row is split into fields. That keeps the reader
# free of `date -d @epoch` (which is not guaranteed on this busybox and returns
# nothing here on the Mac), and it keeps one mechanism responsible for the
# window instead of two. Retention bounds the input at 30 files (~43k rows).
#
# shellcheck disable=SC2086
awk -v panels="$PANELS" -v start="$start" -v end="$end" -v bucket="$bucket" \
    -v schema_name="${ARCHIVE_SCHEMA%%,*}" -v schema_ver="${ARCHIVE_SCHEMA#*,}" \
    "$AWK_AGG" $files 2>/dev/null \
    | jq -nR --argjson snapshot "$snapshot" --arg range "$range" \
        --argjson gen "$now" --argjson bucket "$bucket" \
        --argjson panels "$panels_json" \
        "$JQ_ASSEMBLE"
