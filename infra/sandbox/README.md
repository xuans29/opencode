# OpenCode Tool Sandbox

This image runs model-initiated Shell, Python, and TypeScript tools in a short-lived Linux container. A missing or
disabled sandbox, invalid configuration, exhausted queue, missing image, or unavailable runtime fails the tool call.
There is no host-execution fallback.

## Deployment and trust boundary

This implementation supports **one OpenCode service instance per operating-system user**. It is not a multi-tenant
security boundary. The service-wide pool is the resource boundary for that one user, and each Session has a smaller
concurrency and queue boundary. Do not let mutually untrusted users share one service process, database, data
directory, credential store, or container-runtime account.

Use rootless Docker or Podman. Do not expose the Docker/Podman socket, other host IPC sockets or FIFOs, nested mounts,
hard links to sensitive files, the host home directory, OpenCode data directory, or credentials beneath an allowed
workspace root. Network namespace isolation does not neutralize filesystem IPC endpoints. Configure host filesystem
quotas because the read-write workspace bind mount is not covered by the container's tmpfs or aggregate disk quota.

Build the default image from the repository root:

```sh
docker build -t opencode-sandbox:latest infra/sandbox
```

The Dockerfile pins Bun to an exact release tag. Production builds should additionally pin the base image by digest,
record the resulting sandbox image digest/SBOM, scan it, and set `OPENCODE_SANDBOX_IMAGE` to that immutable digest.
The runtime uses `--pull=never`, so the administrator-approved image must already exist locally. A custom image must
contain `/usr/bin/timeout` plus the executables required by its Shell or Script profile; the runtime forcibly replaces
the image entrypoint with `/usr/bin/timeout`.

## Isolation provided

Every call gets a new named container with:

- no network or IPC namespace sharing;
- host proxy variables are explicitly cleared instead of relying on Docker or Podman defaults;
- a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, and a numeric non-root UID:GID;
- bounded CPU, memory/swap, PIDs, output, input, argument count, individual argument/file size, and `/tmp` size;
- no container log driver, bounded file descriptors, disabled core dumps, and a hard deadline covering queueing and
  execution;
- a stable per-process label, a non-sensitive profile label, and a short hash instead of the raw Session ID.

The active Location is canonicalized and mounted read-write at `/workspace`. The filesystem root is always rejected.
Set `OPENCODE_SANDBOX_WORKSPACE_ROOTS` in production; only projects beneath those administrator-owned canonical roots
are then accepted. The working directory is canonicalized separately and must remain inside the project. These checks reduce
path and symlink escapes at admission time, but they do not make a shared workspace private: Sessions using the same
Location still see and modify the same files, and a privileged host actor can race bind-mount paths. Use separate
worktrees/volumes when Sessions require filesystem isolation.

The Linux programs installed in the image are an administrator-approved runtime surface, not a command whitelist.
Python and TypeScript can start other executables present in the image. Keep the image minimal and treat changes to it
as security-sensitive.

Shell background syntax is not parsed or rejected. Background processes cannot survive the one-shot container's exit,
and the container is still terminated at the whole-call deadline.

## Administrator configuration

Only service environment variables control these settings; a project cannot relax them through `opencode.json`.
Numeric values are parsed strictly and then validated as positive (queue sizes and argument count may be zero).
Invalid values fail service construction.

| Variable                                  |                       Default | Meaning                                                       |
| ----------------------------------------- | ----------------------------: | ------------------------------------------------------------- |
| `OPENCODE_SANDBOX_ENABLED`                |                        `true` | Strictly `true` or `false`; disabling still fails closed      |
| `OPENCODE_SANDBOX_RUNTIME`                |                      `docker` | Strictly `docker` or `podman`                                 |
| `OPENCODE_SANDBOX_IMAGE`                  |     `opencode-sandbox:latest` | Administrator-built image reference; digest recommended       |
| `OPENCODE_SANDBOX_USER`                   | host UID:GID or `65532:65532` | Canonical numeric non-zero UID:GID only                       |
| `OPENCODE_SANDBOX_CPU`                    |                           `1` | CPUs per container                                            |
| `OPENCODE_SANDBOX_MEMORY_MB`              |                        `1024` | Memory and swap ceiling in MiB                                |
| `OPENCODE_SANDBOX_PIDS`                   |                          `64` | Processes per container                                       |
| `OPENCODE_SANDBOX_TIMEOUT_MS`             |                      `120000` | Whole-call deadline, including queueing                       |
| `OPENCODE_SANDBOX_MAX_OUTPUT_BYTES`       |                    `10485760` | Combined stdout/stderr captured per call                      |
| `OPENCODE_SANDBOX_MAX_INPUT_BYTES`        |                     `1048576` | UTF-8 identity, paths, command, arguments, and stdin combined |
| `OPENCODE_SANDBOX_MAX_ARGS`               |                         `128` | Maximum argument count                                        |
| `OPENCODE_SANDBOX_MAX_ARG_BYTES`          |                       `65536` | Maximum UTF-8 bytes in a path, command, or one argument       |
| `OPENCODE_SANDBOX_MAX_FILE_BYTES`         |                    `67108864` | Per-file `RLIMIT_FSIZE`; not an aggregate workspace quota     |
| `OPENCODE_SANDBOX_TMPFS_MB`               |                          `64` | `/tmp` tmpfs ceiling                                          |
| `OPENCODE_SANDBOX_MAX_CONCURRENT`         |                           `4` | Running containers in this single-user service                |
| `OPENCODE_SANDBOX_MAX_PENDING`            |                          `16` | Additional service-wide queued calls                          |
| `OPENCODE_SANDBOX_MAX_SESSION_CONCURRENT` |                           `1` | Running containers for one Session                            |
| `OPENCODE_SANDBOX_MAX_SESSION_PENDING`    |                           `4` | Additional queued calls for one Session                       |
| `OPENCODE_SANDBOX_WORKSPACE_ROOTS`        |                         unset | Allowed roots separated by the host OS path delimiter         |

The in-container timeout is deliberately shorter than the whole-call deadline so cleanup has an opportunity to run.
Timeout exit code 124 is normalized to the same typed timeout error. Cleanup failures are logged with the container
name; deployment monitoring should alert on repeated failures and periodically remove stale containers bearing the
`ai.opencode.sandbox=true` label after abnormal service or runtime termination.
