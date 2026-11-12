# Security policy

## Supported boundary

v0.1 supports a single-user, loopback-only local workspace. It does not support remote hosting, shared users, public URLs, authentication, authorization, or cloud synchronization. Running the tool on a LAN/public interface, behind a tunnel, or with a shared workspace directory is outside this security boundary.

The local HTML response denies framing and uses a restrictive same-origin CSP.
The mutation endpoints require JSON, reject a supplied foreign `Origin`, and
serialize local state mutations with a short private file lock. These are
defense-in-depth controls for the loopback boundary; they are not a replacement
for an authentication/authorization model on a networked deployment.

Workspace data persists in the platform state directory by default. Each
healthy accepted write updates an exact rolling replica outside the active
workspace directory, and pack boundaries add immutable checkpoints. The latest
replica is exact only when its pre-active pending marker has become a matching
generation/checksum commit witness. A
`storage_health: degraded` receipt means the canonical write may have committed
without a verified recovery copy; stop further mutation and repair or recover
that exact workspace ID before continuing.
`WHYBRANCH_WORKSPACE_ROOT` may relocate all of this state; the former
`DGI_WORKSPACE_ROOT` remains a fallback when the new variable is unset. An
override must point to a private directory and remain consistent for the
workspace's lifetime. Legacy workspaces retain their existing private storage
and recovery locations; see [rename compatibility](docs/local-data.md#rename-compatibility).

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/omizha/whybranch/security/advisories/new).

Do not post exploit details, secrets, private decision records, seed files, or
personal reproduction data in a public issue.

## What to include

Provide a minimal, sanitized reproduction; affected version or commit; security impact; and any mitigation already tested. Allow maintainers reasonable time to reproduce and fix the issue before public disclosure.

## Local-data risks

The active workspace, rolling replica, immutable pack-boundary checkpoints, and archive can
all contain the same sensitive free text. Protect the whole state root, not
only the active workspace directory. Chat summaries and derived documents are
not exact backups and may create additional copies with different retention.

`finish` stops the listener and archives exact workspace state; it does not
erase workspace or recovery records, independent seed files, shell history,
copied output, screenshots, backups, or operating-system recovery artifacts.
The CLI exposes no purge command. Manual filesystem deletion is outside the CLI
contract and must target an exact reviewed path. See [local data
guidance](docs/local-data.md).

A missing active file does not establish that it was finished, expired, or
intentionally deleted. Recovery accepts only a checksum-verified archive,
replica, or checkpoint. A fallback to an older valid record can omit later
changes and an unsealed draft, so treat its warning as a data-loss boundary. If
no record is valid, treat the cause and unavailable evidence as unknown rather
than inferring them from a chat recap.
