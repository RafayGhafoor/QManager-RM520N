/* efscli -- one-shot line client for qcom-efsd's abstract unix socket.
 *
 * The upstream helper (catxeon/qcom-efs-browser, daemon/) is a root daemon that
 * listens on the abstract socket @qcom_efsd and speaks one JSON object per line.
 * Upstream's only client is an Android app; this device has no Android, no
 * Python and nothing that can open an abstract socket, so this is the 50-line
 * replacement for driving it over ssh.
 *
 * Build (no toolchain install needed, zig provides musl for armv7):
 *   zig cc -target arm-linux-musleabihf -Os -static -o efscli efscli.c
 *
 * Usage:
 *   efscli '{"cmd":"open"}'
 *   efscli -socket qcom_efsd '{"cmd":"ls","path":"/nv"}'
 *
 * Two details that cost an hour each if you get them wrong:
 *   1. An abstract socket matches on the EXACT sockaddr length -- a NUL byte
 *      followed by the name, and nothing after it. sizeof(struct sockaddr_un)
 *      includes 100-odd trailing zeros and never matches ("Connection refused").
 *   2. The daemon keeps the session open after replying, so reading to EOF
 *      hangs. Read until the first newline and exit.
 */
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    const char *name = "qcom_efsd";
    int a = 1;
    if (argc > 1 && (!strcmp(argv[1], "-socket") || !strcmp(argv[1], "-s")) && argc > 2) {
        name = argv[2];
        a = 3;
    }
    if (a >= argc) {
        fprintf(stderr, "usage: %s [-socket NAME] '<json>'\n", argv[0]);
        return 2;
    }

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); return 3; }

    struct sockaddr_un sa;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    sa.sun_path[0] = 0;                                   /* abstract */
    snprintf(sa.sun_path + 1, sizeof sa.sun_path - 1, "%s", name);

    /* Detail 1: exact length, NUL + name and nothing after. */
    socklen_t sl = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + strlen(name));
    if (connect(fd, (struct sockaddr *)&sa, sl) < 0) { perror("connect"); return 4; }

    char *req = argv[a];
    size_t off = 0, len = strlen(req);
    while (off < len) {
        ssize_t w = write(fd, req + off, len - off);
        if (w <= 0) { perror("write"); return 5; }
        off += (size_t)w;
    }
    if (write(fd, "\n", 1) != 1) { perror("write"); return 5; }

    /* Detail 2: stop at the first complete line, do not wait for EOF. */
    static char buf[1 << 20];
    size_t have = 0;
    for (;;) {
        ssize_t r = read(fd, buf + have, sizeof buf - 1 - have);
        if (r < 0) { perror("read"); return 6; }
        if (r == 0) break;
        have += (size_t)r;
        buf[have] = 0;
        char *nl = memchr(buf, '\n', have);
        if (nl) { *nl = 0; have = (size_t)(nl - buf); break; }
    }
    buf[have] = 0;
    fputs(buf, stdout);
    fputc('\n', stdout);
    close(fd);
    return 0;
}
