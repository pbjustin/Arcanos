/* Trusted linux/amd64 preview entrypoint. No candidate code runs before this
 * inherited kernel filter. It permits inbound TCP servers and replies on their
 * accepted sockets, but no new outbound connections, UDP, raw sockets or DNS.
 * This is a process boundary, not a claim about Railway's network firewall. */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if !defined(__x86_64__)
#error Gaming preview requires reviewed linux/amd64 syscall policy
#endif
#define DENY (SECCOMP_RET_ERRNO | EPERM)
#define DENY_CALL(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (n), 0, 1), BPF_STMT(BPF_RET | BPF_K, DENY)

static void fail(void) {
    fputs("GAMING_PREVIEW_KERNEL_NETWORK_BOUNDARY_FAILED\n", stderr);
    exit(125);
}

int main(int argc, char **argv) {
    if (argc < 2) fail();
    /* No inherited socket or privileged descriptor may reach the child. */
    if (syscall(SYS_close_range, 3U, ~0U, 0U) != 0) fail();
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        /* Reject the alternate x32 ABI rather than letting it evade numbers. */
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        DENY_CALL(SYS_connect),
        DENY_CALL(SYS_sendto),
        DENY_CALL(SYS_sendmsg),
        DENY_CALL(SYS_sendmmsg),
        /* socketpair creates connected local IPC endpoints, needed by libuv
         * spawn. It cannot address a remote host; connect remains denied. */
        DENY_CALL(SYS_io_uring_setup),
        DENY_CALL(SYS_io_uring_enter),
        DENY_CALL(SYS_io_uring_register),
        DENY_CALL(SYS_ptrace),
        DENY_CALL(SYS_process_vm_writev),
        DENY_CALL(SYS_pidfd_getfd),
        DENY_CALL(SYS_bpf),
        /* Only TCP listener sockets are needed; exclude AF_PACKET/UNIX/UDP. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 13),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, DENY),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
        BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~(SOCK_NONBLOCK | SOCK_CLOEXEC)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, DENY),
        /* SCTP association options can bypass connect; admit TCP only. */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, IPPROTO_TCP, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, DENY),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])), .filter = filter };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
        || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0
        || prctl(PR_GET_SECCOMP, 0, 0, 0, 0) != SECCOMP_MODE_FILTER
        || prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) fail();
    /* Verify denials without sending packets or resolving any external name. */
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) fail();
    errno = 0;
    if (connect(fd, NULL, 0) != -1 || errno != EPERM) fail();
    errno = 0;
    if (sendto(fd, "", 0, 0, NULL, 0) != -1 || errno != EPERM) fail();
    close(fd);
    errno = 0;
    if (socket(AF_INET, SOCK_DGRAM, 0) != -1 || errno != EPERM) fail();
    errno = 0;
    if (socket(AF_INET, SOCK_STREAM, IPPROTO_SCTP) != -1 || errno != EPERM) fail();
    errno = 0;
    if (syscall(SYS_io_uring_setup, 0, NULL) != -1 || errno != EPERM) fail();
    fputs("GAMING_PREVIEW_KERNEL_NETWORK_BOUNDARY=ENFORCED linux/amd64 connect+datagram+io_uring denied\n", stderr);
    /* Exec with a fresh, closed environment before Node itself can process
     * NODE_OPTIONS or expose ambient values through /proc/<supervisor>/environ.
     * The exec discards this launcher's original environment memory as well. */
    const char *keys[] = { "PATH", "PORT", "NODE_ENV", "ARCANOS_PROCESS_KIND",
        "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_NAME",
        "RAILWAY_SERVICE_ID", "RAILWAY_DEPLOYMENT_ID", "RAILWAY_PUBLIC_DOMAIN" };
    char *clean[sizeof(keys) / sizeof(keys[0]) + 1];
    size_t count = 0;
    extern char **environ;
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        const size_t length = strlen(keys[i]);
        for (char **entry = environ; *entry; entry++) {
            if (strncmp(*entry, keys[i], length) == 0 && (*entry)[length] == '=') {
                clean[count++] = *entry;
                break;
            }
        }
    }
    clean[count] = NULL;
    execve(argv[1], &argv[1], clean);
    fail();
}
