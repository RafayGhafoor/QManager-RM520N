#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# =============================================================================
# fetch_signal_history.sh — CGI Endpoint for Signal History Chart Data
# =============================================================================
# Three shapes behind one endpoint, and the FIRST one is byte-for-byte what this
# endpoint has always returned, because the dashboard chart reads it:
#
#   1. NO query string  -> the per-antenna signal history NDJSON file served as
#                          a JSON array. Nothing below the early exit runs.
#   2. ?range=now|1h|3h|6h|12h|24h|7d|30d|90d
#                       -> {success, range, generated_at, bucket_sec, snapshot,
#                           series:{<panel>:[{ts,v}]}, missing:[<panel>]}
#   3. ?view=cells&range=<range>
#                       -> shape 2 plus view, window, coverage, and
#                          cells:{availability, availability_sec, outages,
#                                 events, stats, timeline}.
#                          Contract: docs/specs/cell-history.md
#                          (§Response contract is authoritative).
#
# The view parameter is parsed exactly like range, except that an unknown view
# is IGNORED rather than fatal (the same rule as an unknown panel id): only the
# literal `cells` switches the response, and a caller that omits it gets shape 2
# or 1 with no new keys anywhere.
#
# ?panels=<csv> narrows the series to the named panels. Unknown ids are IGNORED,
# not fatal — a newer UI naming a panel an older device does not have gets the
# panels it does have.
#
# PANELS (the whole vocabulary): rsrp sinr rsrq rssi temp cqi rank mcs tx_power
# total_cells — and, with ?view=cells only, cpu mem dl ul.
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
# -----------------------------------------------------------------------------
# ?view=cells — the serving-cell history, off the SAME single pass
# -----------------------------------------------------------------------------
# One endpoint, one archive reader, one awk pass. The archive columns needed for
# cell identity are resolved through the same by-name `col[]` map, so a pre-v2
# day file simply has no such names and reads as "no identity data" — which is
# how `coverage.cell_from` stays honest instead of claiming "no cell changes"
# over time nobody recorded.
#
# Every derived shape shares ONE gap threshold, 3 minutes (GAP_THRESHOLD): the
# archive gains a row a minute, but only when Tier 3 read something, so real
# deltas are 60-90 s. A logger outage must never be painted as an NR outage, so
# an outage span ends — and a timeline run ends — at that threshold.
#
#   availability  buckets of min(range bucket, 3600) s. `n` counts the samples
#                 where nr_avail was DETERMINED (1 or 0, never null); `up` counts
#                 those with the NR leg. A bucket that held samples but could not
#                 determine availability is emitted with n:0, so the strip draws
#                 "no data" rather than a hole. A bucket with no samples at all is
#                 simply absent: that is a gap, not a measured zero.
#   outages       contiguous nr_avail == 0 runs, cut at the gap threshold. A null
#                 sample neither opens nor closes a span (spec R5): "we did not
#                 look" is not evidence either way.
#   events        each sample compared against the LAST KNOWN value of every
#                 identity field, not against the previous row. The NR columns go
#                 empty while NR is detached, so a pairwise diff misses "NR came
#                 back on a different PCI". Newest first; one entry per instant.
#   stats         per LTE PCI ("(none)" when a sample had no LTE PCI): samples,
#                 and nr_down / nr_known — availability ON that cell.
#   timeline      contiguous runs of one serving cell; a run ends at a PCI or band
#                 change or at a gap. Keyed on exactly the fields it reports.
#
# window.end is the newest archived row clamped to now, never the wall clock. Every absent value is null, and bands stay STRINGS exactly as stored ("B3",
# "N78"): parse_serving_cell builds the prefix itself and two firmwares disagree
# on the bare form, so nothing here adds a prefix or parses a band to a number. A
# band field that is nothing but the prefix ("B", "N") is ABSENT, never a band.
#
# COST. awk aggregates; jq only shapes a few thousand TSV lines. No jq runs per
# archive row — the full 30-day archive is ~43k rows, which is the slow path on a
# single core (docs/reference/sites-monitor.md).
#
# snapshot in this view is the detailed-metrics snapshot PLUS `cell`, plus one
# field the TypeScript contract declares and the wire shape's prose does not spell
# out: `as_of`, the newest archived sample's own timestamp (null when the window
# is empty), so the identity card can say "as of" without inventing a clock read.
#
# WINDOW. The window ENDS at the newest archived row, not at the wall clock — an
# archive that stopped updating shows its last window instead of an empty
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
# The reader accepts every schema version the device may still hold: retention is
# 30 days, so a v1 day file written before the v2 columns existed is still inside
# the window and must keep serving its PHY series. It declares no identity
# columns, which is exactly what makes coverage honest for it.
ARCHIVE_NAME="qm_phy_archive"
ARCHIVE_VERSIONS="1 2 3"
SANE_EPOCH=1700000000
PANELS="rsrp sinr rsrq rssi temp cqi rank mcs tx_power total_cells"

# The gap threshold every derived cells shape shares, in seconds: 3 minutes. The
# archive gains a row a minute and only when Tier 3 read something, so real deltas
# are 60-90 s. Wider than that is a hole in the record, and a hole must break the
# line rather than be bridged (docs/specs/cell-history.md, "outages").
GAP_THRESHOLD=180

# Identity fields, in the order a change list is emitted. `nr_avail` leads because
# it is the field this page exists to explain; `rat`/`registered` are deliberately
# absent — a registration flap is not a cell change, and `registered` is a boolean
# whose flapping would drown the table.
CELL_FIELDS="nr_avail lte_pci lte_band lte_earfcn lte_bw nr_pci nr_band nr_arfcn nr_bw lte_cellid nr_cellid network_type bands"

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

# --- view --------------------------------------------------------------------
# Parsed exactly like range, with one difference: an unknown value is not an
# error. Only the literal `cells` switches the response shape, so a caller that
# names a view this build does not serve gets the series it already knows (the
# same "unknown id is ignored" rule as ?panels).
view=$(qparam view "")
cells_view=0
if [ "$view" = "cells" ]; then
    cells_view=1
    # cpu mem dl ul are cells-view panels: they only mean anything next to cell
    # identity, so the detailed-metrics vocabulary is left exactly as it is.
    PANELS="$PANELS cpu mem dl ul ca bw"
fi

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

# Availability bucket width: the range's own bucket, capped at an hour. The
# availability strip is per-hour at most, so a 30-day request is 720 columns
# rather than the 7200 s buckets the series use. range=now has no bucket of its
# own and no window to bucket; 60 s is the finest width the source supports (one
# archive row a minute), which keeps the field a number on every response.
avail_sec=$bucket
case "$avail_sec" in ''|null|*[!0-9]*) avail_sec=60 ;; esac
[ "$avail_sec" -gt 3600 ] && avail_sec=3600

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

# --- snapshot.cell (view=cells only) -----------------------------------------
# The serving cell as the LIVE cache has it — the same object the archive row's
# identity columns are written from, read from /tmp instead of from a CSV line.
# Only `?view=cells` asks for it, so shape 2 pays nothing for it.
#
# Bands stay strings; a missing number is null. The poller records no NR
# bandwidth (the cache has no such field), so `nr_bw` is null here rather than
# borrowed from the CA component list, which would be a second source for a
# number this device does not report.
#
# nr_avail is the cache's analogue of the poller's three-valued rule: 1 when the
# cache carries an NR serving cell, 0 when a serving-cell read clearly happened
# and carried none, null when there is nothing to judge (no cache, both RATs
# silent: the "we did not look" case that must stay distinguishable).
CELL_JQ='
def n: if type == "number" then . else null end;
def s: if (type == "string") and (length > 0) and (. != "unknown") then . else null end;
def bd: if (type == "string") and (length > 0) and (. != "B") and (. != "N") then . else null end;
(.lte // {}) as $l
| (.nr // {}) as $r
| (.network // {}) as $w
| (.phy // {}) as $p
| {lte_pci: ($l.pci | n), lte_earfcn: ($l.earfcn | n), lte_band: ($l.band | bd),
   lte_bw: ($l.bandwidth | n), lte_cellid: ($l.cell_id | n), lte_tac: ($l.tac | n),
   nr_pci: ($r.pci | n), nr_arfcn: ($r.arfcn | n), nr_band: ($r.band | bd),
   nr_bw: null, nr_cellid: ($r.cell_id | n), nr_tac: ($r.tac | n),
   network_type: ($w.type | s),
   registered: (if ($p.registered | type) == "boolean" then $p.registered else null end),
   nr_avail: (if (($r.pci | n) != null) or (($r.rsrp | n) != null) then 1
              elif (($l.pci | n) != null) or (($w.type | s) != null) then 0
              else null end)}'

cell=null
if [ "$cells_view" = "1" ]; then
    cell=$(jq -c "$CELL_JQ" "$STATUS_FILE" 2>/dev/null)
    case "$cell" in
        "{"*) ;;
        *) cell='{"lte_pci":null,"lte_earfcn":null,"lte_band":null,"lte_bw":null,"lte_cellid":null,"lte_tac":null,"nr_pci":null,"nr_arfcn":null,"nr_band":null,"nr_bw":null,"nr_cellid":null,"nr_tac":null,"network_type":null,"registered":null,"nr_avail":null}' ;;
    esac
fi

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
    else if (p == "cpu")        { v = num(F[col["cpu_pct"]]) }
    else if (p == "mem")        { v = num(F[col["mem_pct"]]) }
    else if (p == "dl")         { v = num(F[col["dl_bps"]]) }
    else if (p == "ul")         { v = num(F[col["ul_bps"]]) }
    else if (p == "ca")         { v = num(F[col["ca_cc"]]) }
    else if (p == "bw")         { v = num(F[col["bw_mhz"]]) }
    else v = ""
    return v
}
# schema marker: "#qm_phy_archive,<ver>,ts,<col>,<col>,..."
# Columns are numbered from the marker, so ncol (the field count of a row) and
# every index below come from the file rather than from this program. The VERSION
# is an allowlist: v1 day files are still inside the retention window and hold
# valid PHY series, they simply declare no identity columns.
function schema(line,   a, k, nn, i) {
    if (substr(line, 1, 1) != "#") return 0
    nn = split(substr(line, 2), a, ",")
    if (nn < 3) return 0
    if (a[1] != schema_name) return 0
    if (index(" " schema_vers " ", " " a[2] " ") == 0) return 0
    for (i = 3; i <= nn; i++) col[a[i]] = i - 2
    ncol = nn - 2
    return 1
}
# One identity column from one row: "" when this file declares no such column
# (a v1 file), and "" for a literal "null" rather than the word.
function icol(name, F,   v) {
    v = F[col[name]]
    return (v == "null") ? "" : v
}
# Fill IV[] with this row identity values and report whether the row says
# anything about cells at all. A row with no identity column — every v1 row, and
# a v2 row where the modem named no cell — is not a cell sample: skipping it here
# is what makes coverage.cell_from honest instead of "no cell changes".
function ident_row(F,   i, v, any) {
    any = 0
    for (i = 1; i <= nid; i++) {
        v = icol(ID[i], F)
        IV[ID[i]] = v
        if (v != "") any = 1
    }
    return any
}
# The two spans are streamed: a run is printed the moment it ends, so neither
# needs an array of its own.
function close_out() {
    if (in_out) printf "O\t%d\t%d\t%d\n", out_start, out_end, out_n
    in_out = 0; out_n = 0
}
function close_run() {
    if (run_n > 0)
        printf "T\t%d\t%d\t%d\t%s\t%s\t%s\t%d\t%d\n", run_start, run_end, run_n,
               run_lpci, run_lband, run_nband, run_known, run_up
    run_n = 0; run_known = 0; run_up = 0
}
# The band/CA combo run. Separate from the cell run above on purpose: a serving
# cell can stay put while an aggregated carrier comes or goes, and THAT is the
# change worth a segment — the combo is what changed, not the PCI.
function close_band() {
    if (bn > 0)
        printf "B\t%d\t%d\t%d\t%s\t%s\t%s\n", b_start, b_end, bn,
               b_key, b_ca, b_bw
    bn = 0
}
BEGIN {
    np = split(panels, PL, " ")
    nid = split(idfields, ID, " ")
    have_schema = 0
    ab = avail_bucket + 0
    if (ab <= 0) ab = 3600
    gap = gap_sec + 0
    nW = 0; Wfirst = 0; Wlast = 0; cov_from = ""
    in_out = 0; out_n = 0; last_id_ts = 0; run_n = 0
    bn = 0; b_last_ts = 0
}
# A new file re-arms the schema check, so a day file whose marker this build does
# not accept is skipped instead of being read with the wrong column map.
FILENAME != prevfile { prevfile = FILENAME; have_schema = 0 }
{
    if (substr($0, 1, 1) == "#") { if (!have_schema) have_schema = schema($0); next }
    if (!have_schema) next
    # awks numeric coercion takes the longest numeric PREFIX of the line, so this
    # is the timestamp without splitting 42 fields. It matters: the full 30-day
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

    # Window margin: every row that reached here is inside the window and carries
    # the file own field count. Emitted only in the cells view.
    if (nW == 0) Wfirst = t
    Wlast = t
    nW++

    if (!cells_view) next
    if (!ident_row(F)) next
    if (cov_from == "") cov_from = t

    av = (IV["nr_avail"] == "1") ? 1 : ((IV["nr_avail"] == "0") ? 0 : -1)

    # availability — one bucket per bucket that held samples, even when nothing
    # in it could determine availability (n stays 0, so the strip draws "no data"
    # instead of closing the hole).
    abk = int(t / ab) * ab
    if (!(abk in A_n)) { A_n[abk] = 0; A_up[abk] = 0 }
    if (av >= 0) { A_n[abk]++; if (av == 1) A_up[abk]++ }

    # events — against the LAST KNOWN value of each field, never the previous
    # row: the NR columns go empty while NR is detached, so a pairwise diff would
    # miss "NR dropped and came back on a different PCI".
    for (i = 1; i <= nid; i++) {
        f = ID[i]; v = IV[f]
        if (v == "") continue
        if (!(f in LK)) { LK[f] = v; continue }
        if (v != LK[f]) { printf "E\t%d\t%s\t%s\t%s\n", t, f, LK[f], v; LK[f] = v }
    }

    # outages — contiguous nr_avail == 0 runs, cut at the gap threshold measured
    # from the previous CELL sample. A null (av < 0) neither opens nor closes a
    # span: it is not evidence about the NR leg either way (spec R5).
    if (av == 0) {
        if (in_out && (t - last_id_ts) <= gap) { out_end = t; out_n++ }
        else { close_out(); in_out = 1; out_start = t; out_end = t; out_n = 1 }
    } else if (av == 1) {
        close_out()
    }

    # timeline — contiguous runs of one serving cell, keyed on exactly the fields
    # it reports (an invisible boundary would be a segment nobody can explain).
    rkey = IV["lte_pci"] SUBSEP IV["lte_band"] SUBSEP IV["nr_band"]
    if (run_n > 0 && rkey == run_key && (t - last_id_ts) <= gap) {
        run_end = t; run_n++
        if (av >= 0) { run_known++; if (av == 1) run_up++ }
    } else {
        close_run()
        run_key = rkey; run_start = t; run_end = t; run_n = 1
        run_lpci = IV["lte_pci"]; run_lband = IV["lte_band"]; run_nband = IV["nr_band"]
        run_known = (av >= 0) ? 1 : 0
        run_up = (av == 1) ? 1 : 0
    }

    # bands / CA — a run per contiguous combo, plus a per-combo rollup. Keyed on
    # the combo string alone ("B3+B1+N78"), so an aggregated carrier appearing or
    # disappearing starts a new segment even when the serving cell is unchanged.
    # A row that named no combo — every pre-v3 row — contributes nothing here
    # rather than opening a run whose label is empty, so a window that straddles
    # the schema bump does not invent a "no bands" period.
    bval = IV["bands"]
    if (bval != "") {
        bca = icol("ca_cc", F); bbw = icol("bw_mhz", F)
        if (bn > 0 && bval == b_key && (t - b_last_ts) <= gap) {
            b_end = t; bn++
            if (bca != "") b_ca = bca
            if (bbw != "") b_bw = bbw
        } else {
            close_band()
            b_key = bval; b_start = t; b_end = t; bn = 1; b_ca = bca; b_bw = bbw
        }
        b_last_ts = t
        if (!(bval in K_n)) { K_n[bval] = 0; K_first[bval] = t; K_ca[bval] = bca; K_bw[bval] = bbw }
        K_n[bval]++
        K_last[bval] = t
        if (bca != "") K_ca[bval] = bca
        if (bbw != "") K_bw[bval] = bbw
    }

    # stats — time on cell against availability on that cell. The PCI is the key
    # an operator recognises; "(none)" keeps a 5G-SA sample distinguishable
    # instead of folding it into a cell that has no PCI.
    skey = (IV["lte_pci"] != "") ? IV["lte_pci"] : "(none)"
    if (!(skey in S_n)) {
        S_n[skey] = 0; S_down[skey] = 0; S_known[skey] = 0
        S_band[skey] = IV["lte_band"]; S_cid[skey] = IV["lte_cellid"]
        S_first[skey] = t
    }
    S_n[skey]++
    if (IV["lte_band"] != "") S_band[skey] = IV["lte_band"]
    if (IV["lte_cellid"] != "") S_cid[skey] = IV["lte_cellid"]
    S_last[skey] = t
    if (av >= 0) { S_known[skey]++; if (av == 0) S_down[skey]++ }

    last_id_ts = t
}
END {
    if (cells_view) {
        close_out()
        close_run()
        close_band()
        # Exactly one W line and one C line, always, so the shaper never has to
        # deal with their absence.
        printf "W\t%d\t%d\t%d\n", nW, Wfirst, Wlast
        printf "C\t%s\n", cov_from
        for (k in A_n) printf "A\t%d\t%d\t%d\n", k, A_n[k], A_up[k]
        for (k in S_n)
            printf "S\t%s\t%s\t%s\t%d\t%d\t%d\t%d\t%d\n",
                   k, S_band[k], S_cid[k], S_n[k], S_down[k], S_known[k],
                   S_first[k], S_last[k]
        for (k in K_n)
            printf "K\t%s\t%d\t%d\t%d\t%s\t%s\n",
                   k, K_n[k], K_first[k], K_last[k], K_ca[k], K_bw[k]
    }
    for (k in N)
        printf "V\t%s\t%d\t%.1f\n", PANEL[k], BTS[k], SUM[k] / N[k]
}
'

JQ_ASSEMBLE='
[inputs | split("\t") | select(.[0] == "V")
 | {p: .[1], ts: (.[2] | tonumber), v: (.[3] | tonumber)}] as $rows
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

# The cells view: the same series, then the identity-derived shapes. Every line
# arriving on stdin is one of the tagged records the awk pass emits (V/A/E/O/S/T,
# plus the single W window line and C coverage line); this program only groups,
# sorts and shapes them, so jq never sees an archive row. `s0` is the whole
# absent-is-null rule: awk writes an empty field, JSON gets null.
JQ_CELLS='
def s0: if . == "" then null else . end;
def n0: if . == "" or . == "0" then null else (tonumber) end;
# For a count whose ZERO is a real answer (aggregated carriers: "0" means no
# carrier aggregation, which is a reading, not a gap). n0 above would turn it
# into null, which reads as "not reported".
def n1: if . == "" then null else (tonumber) end;
[inputs | split("\t")] as $rows
| ([$rows[] | select(.[0] == "V")
    | {p: .[1], ts: (.[2] | tonumber), v: (.[3] | tonumber)}]) as $pts
| ($pts | group_by(.p)
   | map({key: .[0].p, value: (map({ts: .ts, v: .v}) | sort_by(.ts))})
   | from_entries) as $series
| ($rows | map(select(.[0] == "W")) | (.[0] // [])) as $w
| ($rows | map(select(.[0] == "C")) | (.[0] // [])) as $cov
| ([$rows[] | select(.[0] == "A")
    | {ts: (.[1] | tonumber), n: (.[2] | tonumber), up: (.[3] | tonumber)}]
   | sort_by(.ts)) as $avail
| ([$rows[] | select(.[0] == "O")
    | {start_ts: (.[1] | tonumber), end_ts: (.[2] | tonumber),
       samples: (.[3] | tonumber)}]
   | sort_by(.start_ts)) as $outages
| ([$rows[] | select(.[0] == "B")
    | {start_ts: (.[1] | tonumber), end_ts: (.[2] | tonumber),
       samples: (.[3] | tonumber), bands: (.[4] | s0),
       ca_cc: (.[5] | n1), bw_mhz: (.[6] | n1)}]
   | sort_by(.start_ts)) as $bandruns
| ([$rows[] | select(.[0] == "K")
    | {bands: (.[1] | s0), samples: (.[2] | tonumber),
       first_ts: (.[3] | tonumber), last_ts: (.[4] | tonumber),
       ca_cc: (.[5] | n1), bw_mhz: (.[6] | n1)}]
   | sort_by(-.samples)) as $combos
| ([$rows[] | select(.[0] == "E")
    | {ts: (.[1] | tonumber), field: .[2], from: (.[3] | s0), to: (.[4] | s0)}]
   | group_by(.ts)
   | map({ts: .[0].ts, changes: map({field: .field, from: .from, to: .to})})
   | sort_by(.ts) | reverse) as $events
| ([$rows[] | select(.[0] == "S")
    | {key: .[1], lte_pci: (.[1] | s0 | if . == "(none)" then null else . end), lte_band: (.[2] | s0),
       lte_cellid: (.[3] | s0), samples: (.[4] | tonumber),
       nr_down: (.[5] | tonumber), nr_known: (.[6] | tonumber),
       first_ts: (.[7] | tonumber), last_ts: (.[8] | tonumber)}]
   | sort_by(-.samples)) as $stats
| ([$rows[] | select(.[0] == "T")
    | {start_ts: (.[1] | tonumber), end_ts: (.[2] | tonumber),
       samples: (.[3] | tonumber), lte_pci: (.[4] | s0), lte_band: (.[5] | s0),
       nr_band: (.[6] | s0), known: (.[7] | tonumber), up: (.[8] | tonumber)}]
   | sort_by(.start_ts)) as $runs
| {success: true,
   view: "cells",
   range: $range,
   generated_at: $gen,
   bucket_sec: $bucket,
   window: {start: $start, end: $end,
            samples: (($w[1] // "0") | tonumber),
            first_ts: (($w[2] // "") | n0),
            last_ts: (($w[3] // "") | n0)},
   coverage: {cell_from: (($cov[1] // "") | s0
                         | if . == null then null else tonumber end)},
   snapshot: ($snapshot + {cell: $cell, as_of: (($w[3] // "") | n0)}),
   series: ($panels | map(. as $p | {key: $p, value: ($series[$p] // [])}) | from_entries),
   missing: [$panels[] | select((($series[.] // []) | length) == 0)],
   cells: {availability: $avail,
           availability_sec: $avail_sec,
           outages: $outages,
           events: $events,
           stats: $stats,
           timeline: ($runs | map(. as $r
             | {start_ts: $r.start_ts, end_ts: $r.end_ts, samples: $r.samples,
                lte_pci: $r.lte_pci, lte_band: $r.lte_band, nr_band: $r.nr_band,
                nr_avail_pct: (if $r.known > 0
                               then (($r.up * 100 / $r.known) | floor)
                               else null end)})),
           bands: $bandruns,
           combos: $combos}}
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

# shape_response <jq-program> — reads the tagged TSV lines on stdin and answers
# the response body. One definition for both views: the cells program uses every
# argument, the series program ignores the cells-only ones, and neither shape can
# drift from the other's argument handling. `cell` is null unless view=cells.
shape_response() {
    jq -nR --argjson snapshot "$snapshot" --argjson cell "$cell" \
        --arg range "$range" --argjson gen "$now" --argjson bucket "$bucket" \
        --argjson panels "$panels_json" --argjson start "$start" \
        --argjson end "$end" --argjson avail_sec "$avail_sec" "$1"
}

# The window's provisional end is the wall clock; the newest archived row
# replaces it below as soon as one is known (docs/reference/latency-monitor.md:64).
# range=now keeps it: there is no window to be honest about, only a snapshot.
end=$now
start=$(( end - span ))

if [ "$live_mode" = "true" ] || [ "$now" -lt "$SANE_EPOCH" ]; then
    panels_json='[]'
    if [ "$cells_view" = "1" ]; then
        printf '' | shape_response "$JQ_CELLS"
    else
        printf '' | shape_response "$JQ_ASSEMBLE"
    fi
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

if [ -z "$files" ]; then
    # No archive yet (fresh install, or the writer is disabled): an empty series
    # with every requested panel in missing[] is the honest answer, and the cells
    # view adds empty arrays rather than an error or a fabricated window.
    if [ "$cells_view" = "1" ]; then
        printf '' | shape_response "$JQ_CELLS"
    else
        printf '' | shape_response "$JQ_ASSEMBLE"
    fi
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
# ONE pass serves both views. The cells-only arguments are inert when
# cells_view=0, and the program then emits nothing but V lines, which is what
# keeps the view-absent response byte-identical to before this change.
#
# shellcheck disable=SC2086
awk -v panels="$PANELS" -v start="$start" -v end="$end" -v bucket="$bucket" \
    -v schema_name="$ARCHIVE_NAME" -v schema_vers="$ARCHIVE_VERSIONS" \
    -v cells_view="$cells_view" -v avail_bucket="$avail_sec" \
    -v gap_sec="$GAP_THRESHOLD" -v idfields="$CELL_FIELDS" \
    "$AWK_AGG" $files 2>/dev/null \
    | if [ "$cells_view" = "1" ]; then
          shape_response "$JQ_CELLS"
      else
          shape_response "$JQ_ASSEMBLE"
      fi
