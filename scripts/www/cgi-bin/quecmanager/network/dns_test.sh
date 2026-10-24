#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# =============================================================================
# dns_test.sh — CGI: resolve one domain through every configured DNS provider
# =============================================================================
# GET ?domain=<name>  ->  the Contract-2 JSON from docs/specs/dns-edge-selection.md
#                         (qmanager_dns_test output, passed through verbatim)
#
# WHY THIS EXISTS
#   The owner wants to see, per provider, which IP a domain gets and how far away
#   it is. This is the endpoint behind the page's domain tester, and it is also how
#   a human verifies the edge-selection algorithm's decisions: the same measurement
#   that decides group membership is exposed one domain at a time.
#
# DESIGN NOTES
#   * The domain is validated HERE as well as in the helper. A CGI is the trust
#     boundary: it must not hand arbitrary bytes to a root-adjacent helper, and a
#     rejected request should not cost a fork to discover.
#   * Output is passed through verbatim. Re-encoding JSON in shell is how shapes
#     drift between backend and UI; one producer, one consumer.
#   * A timeout that fires is reported as `timeout`, never as an empty result —
#     "no provider answered" and "the probe never ran" are different facts.
#
# Endpoint: GET /cgi-bin/quecmanager/network/dns_test.sh?domain=youtube.com
# =============================================================================

qlog_init "cgi_dns_test"
cgi_headers
cgi_handle_options

require_auth

BIN="/usr/bin/qmanager_dns_test"
TEST_TIMEOUT="${DNS_TEST_TIMEOUT:-50}"

if [ "$REQUEST_METHOD" != "GET" ]; then
    cgi_method_not_allowed
fi

# --- query string -> domain -------------------------------------------------
# Parsed without a URL-decoder dependency: a domain is [A-Za-z0-9.-], so anything
# outside that set after a minimal %XX pass is rejected rather than "cleaned".
_raw="${QUERY_STRING:-}"
_domain=""
_rest="$_raw"
while [ -n "$_rest" ]; do
    _pair="${_rest%%&*}"
    case "$_pair" in
        domain=*) _domain="${_pair#domain=}" ;;
    esac
    [ "$_rest" = "$_pair" ] && break
    _rest="${_rest#*&}"
done

# Only %2E (.) and %2D (-) can legitimately appear; decode those two, then validate.
_domain=$(printf '%s' "$_domain" | sed -e 's/%2[eE]/./g' -e 's/%2[dD]/-/g')

if [ -z "$_domain" ]; then
    cgi_error "missing_domain" "Pass ?domain=<name>"
    exit 0
fi
if ! printf '%s' "$_domain" | grep -qE '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'; then
    cgi_error "invalid_domain" "Not a valid hostname: $_domain"
    exit 0
fi
if [ "${#_domain}" -gt 253 ]; then
    cgi_error "invalid_domain" "Domain longer than 253 characters"
    exit 0
fi

if [ ! -x "$BIN" ]; then
    cgi_error "helper_missing" "qmanager_dns_test is not installed"
    exit 0
fi

qlog_info "dns test: $_domain"

# --- run the measurement ----------------------------------------------------
# Bounded: the helper queries every provider (default 8) with a per-query timeout.
# Without a bound here a wedged WAN would hold the CGI open until lighttpd's own
# timeout, which the UI renders as a generic failure instead of a DNS result.
_out=$(qm_timeout "$TEST_TIMEOUT" "$BIN" --json "$_domain" 2>/dev/null </dev/null)
_rc=$?

if [ "$_rc" -eq 124 ]; then
    qlog_warn "dns test timed out after ${TEST_TIMEOUT}s: $_domain"
    cgi_error "timeout" "Provider sweep did not finish in ${TEST_TIMEOUT}s"
    exit 0
fi

if [ -z "$_out" ]; then
    qlog_warn "dns test produced no output (rc=$_rc): $_domain"
    cgi_error "probe_failed" "No measurement produced (rc=$_rc)"
    exit 0
fi

# Reject a truncated/garbled body rather than emitting it: the UI parses strictly.
if ! printf '%s' "$_out" | jq -e '.domain and (.results | type == "array")' >/dev/null 2>&1; then
    qlog_warn "dns test emitted malformed JSON: $_domain"
    cgi_error "malformed_result" "Probe output was not the expected shape"
    exit 0
fi

printf '%s\n' "$_out"
exit 0
