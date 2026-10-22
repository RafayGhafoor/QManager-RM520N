#!/bin/sh
# =============================================================================
# qm_serve.sh — run the QManager web UI on port 8080 (busybox httpd)
# =============================================================================
# Upstream QManager ships a lighttpd config. lighttpd is not installed here and
# cannot be: the rootfs is a read-only squashfs, so Entware (/opt) can never be
# bootstrapped. The firmware's own :80 UI is served by busybox httpd, which
# supports CGI natively, so we reuse it — no new packages, nothing written
# outside /usrdata and /etc.
#
# Port 8080 is deliberate: 80 is already taken by the vendor UI
# (/bin/busybox httpd -f -p 80 -h /web/v2).
#
# CGI scripts run as the httpd user. We run httpd as root (no -u) so the
# helpers can issue AT commands and write /etc/qmanager without sudo, which is
# absent on this firmware. /usrdata/qmanager/bin/sudo is a passthrough shim.
#
# Usage: qm_serve.sh {start|stop|restart|status}
# =============================================================================
set -u

QM_ROOT=/usrdata/qmanager
PORT="${QM_PORT:-8080}"
# /run, not /var/run — must match PIDFile= in deploy/qmanager-httpd.service.
# systemd rewrites a /var/run PIDFile to /run and warns about it on every
# daemon-reload; if this script kept writing /var/run the two would disagree.
PIDFILE=/run/qmanager-httpd.pid
DOCROOT="$QM_ROOT/www"

# jq, qcmd and the helper scripts live here (not on the read-only /usr/bin).
PATH="$QM_ROOT/bin:/usr/bin:/bin:/sbin:/usr/sbin"
export PATH

# Verify the tree is present before pretending to serve it.
check_root() {
    [ -d "$DOCROOT" ] || { echo "missing docroot: $DOCROOT" >&2; exit 1; }
    [ -x "$DOCROOT/cgi-bin/quecmanager/auth/login.sh" ] || \
        [ -d "$DOCROOT/cgi-bin/quecmanager" ] || {
            echo "missing CGI tree under $DOCROOT/cgi-bin" >&2; exit 1; }
}

is_running() {
    [ -f "$PIDFILE" ] || return 1
    pid=$(cat "$PIDFILE" 2>/dev/null)
    [ -n "$pid" ] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    return 0
}

# busybox httpd has no pidfile of its own, so match on the exact docroot we
# passed. Patterns are assembled at runtime so that pgrep -f cannot match this
# script's own command line and kill the caller.
find_pids() {
    pattern="httpd -p $PORT -h $DOCROOT"
    ps -o pid,args 2>/dev/null | grep -F "$pattern" | grep -v grep | awk '{print $1}'
}

do_stop() {
    if is_running; then
        pid=$(cat "$PIDFILE" 2>/dev/null)
        kill "$pid" 2>/dev/null
        sleep 1
        kill -9 "$pid" 2>/dev/null
    fi
    for p in $(find_pids); do
        [ "$p" = "$$" ] && continue
        kill "$p" 2>/dev/null
    done
    rm -f "$PIDFILE"
    echo "stopped"
}

do_start() {
    check_root
    if is_running; then
        echo "already running (pid $(cat "$PIDFILE")) on port $PORT"
        return 0
    fi
    do_stop >/dev/null 2>&1

    # Fully detach: busybox httpd daemonizes but otherwise keeps the caller's
    # stdout open, which hangs an ssh session.
    busybox httpd -p "$PORT" -h "$DOCROOT" >/dev/null 2>&1 </dev/null

    # busybox httpd's internal daemon writes no pidfile; capture the pid from
    # the listening socket's owner instead.
    for p in $(find_pids); do
        printf '%s\n' "$p" > "$PIDFILE"
        break
    done

    sleep 1
    if netstat -tln 2>/dev/null | grep -q ":$PORT "; then
        echo "listening on port $PORT (pid $(cat "$PIDFILE" 2>/dev/null))"
    else
        echo "failed to bind port $PORT" >&2
        exit 1
    fi
}

do_status() {
    if is_running; then
        echo "running (pid $(cat "$PIDFILE")) on port $PORT"
    else
        echo "stopped"
    fi
}

case "${1:-start}" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart) do_stop; do_start ;;
    status)  do_status ;;
    *) echo "usage: $0 {start|stop|restart|status}" >&2; exit 1 ;;
esac
