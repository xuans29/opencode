# Security

## IMPORTANT

We do not accept AI generated security reports. We receive a large number of
these and we absolutely do not have the resources to review them all. If you
submit one that will be an automatic ban from the project.

## Threat Model

### Overview

OpenCode is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### Model-Facing Sandbox

The built-in, model-facing `shell` and `script` tools run in disposable Linux
containers. They fail closed when the container runtime or sandbox image is
unavailable instead of falling back to the host. The container boundary is
designed to remove network access, use a non-root user and read-only root
filesystem, drop capabilities, and enforce bounded process, compute, time,
temporary-storage, and output resources.

The active Location accepted by the service is mounted read-write at
`/workspace`. An allowed command or script can therefore read, create, modify,
or delete files anywhere in that mounted Location. The filesystem root is
rejected. A Location is also rejected when it is the same as, contains, or is
contained by OpenCode's managed data, cache, configuration, or state
directories, so service-managed archives and credentials cannot be exposed by
selecting them or one of their ancestors as a project. Administrators can
restrict eligible projects further with `OPENCODE_SANDBOX_WORKSPACE_ROOTS`;
without that setting, choosing another broad Location also broadens the files
intentionally exposed to model-executed code. The sandbox is a process and
host-filesystem boundary; it is not a read-only workspace, a replacement for
tool permissions, or protection for secrets placed inside the mounted project.

Treat filesystem IPC endpoints and nested mounts inside the Location as part of
the exposed workspace authority. In particular, `--network=none` does not block
access to a host Unix socket that was deliberately placed under the bind mount.
Do not place container-runtime sockets, agent sockets, FIFOs, sensitive nested
mounts, or hard links to sensitive files beneath an allowed workspace root.

A report that demonstrates model-facing `shell` or `script` code escaping this
documented container boundary—for example, reaching host files outside the
mounted Location or obtaining network access—is in scope. The container runtime
and host configuration remain part of the trusted computing base. For stronger
defense in depth, run the entire OpenCode service inside a dedicated container
or virtual machine and use a rootless container runtime for tool sandboxes.

### Other Execution Boundaries

The following capabilities are not routed through the model-facing
`shell`/`script` sandbox:

- File tools execute in the OpenCode host process and rely on path validation
  and permission decisions. They intentionally operate on the active Location.
- PTY sessions and the Shell HTTP/API service start host processes when invoked
  by an authorized client.
- User-configured plugins and MCP servers are trusted extensions and may execute
  with their own documented host or remote authority.

Do not treat a permission prompt as a general-purpose isolation boundary. A
permission decides whether a requested operation may proceed; it does not make
an allowed operation harmless.

### Server Mode

Server mode is opt-in only. When enabled, set `OPENCODE_SERVER_PASSWORD` to
require HTTP Basic Auth and restrict the listening interface appropriately.
Without a password, the server runs unauthenticated with a warning. Any client
that can access the service may reach capabilities such as file operations, PTY,
and host Shell APIs.

One server process is a single-user boundary, not a multi-tenant service. Its
authentication credential grants access to the service and does not establish
separate user or tenant identities for Session ownership, credentials,
permissions, or resource quotas. Mutually untrusted users require separate
service processes, operating-system accounts, data/config directories, and
container-runtime boundaries.

### Out of Scope

| Category                                     | Rationale                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Authorized server operations**             | Operations requested by a correctly authenticated client are expected; authentication bypasses are not |
| **Writes inside a mounted Location**         | Read-write workspace access is an explicit property of allowed sandbox, file, and host-shell execution |
| **LLM provider data handling**               | Data sent to your configured LLM provider is governed by their policies                                |
| **Configured plugin or MCP server behavior** | Extensions selected by the user are trusted components with their own authority                        |
| **Malicious config files**                   | Users control their own config; modifying it is not an attack vector                                   |

---

# Reporting Security Issues

We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/anomalyco/opencode/security/advisories/new) tab.

The team will send a response indicating the next steps in handling your report. After the initial reply to your report, the security team will keep you informed of the progress towards a fix and full announcement, and may ask for additional information or guidance.

## Escalation

If you do not receive an acknowledgement of your report within 6 business days, you may send an email to security@anoma.ly
