# Security policy

## Supported boundary

v0.1 supports a single-user, loopback-only local workspace. It does not support remote hosting, shared users, public URLs, authentication, authorization, or cloud synchronization. Running the tool on a LAN/public interface, behind a tunnel, or with a shared workspace directory is outside this security boundary.

The local HTML response denies framing and uses a restrictive same-origin CSP.
The mutation endpoints require JSON, reject a supplied foreign `Origin`, and
serialize local state mutations with a short private file lock. These are
defense-in-depth controls for the loopback boundary; they are not a replacement
for an authentication/authorization model on a networked deployment.

## Reporting a vulnerability

Use the private vulnerability-reporting channel of the repository that publishes this package. Do not include secrets, private decision records, seed files, or reproduction data containing personal information in a public issue.

This alpha checkout intentionally contains placeholder repository ownership metadata. Before publishing, maintainers must configure the real repository's private reporting channel and confirm that its contact route is visible here. If private reporting is not yet configured, ask the maintainer for a private contact method rather than opening a public issue with exploit details.

## What to include

Provide a minimal, sanitized reproduction; affected version or commit; security impact; and any mitigation already tested. Allow maintainers reasonable time to reproduce and fix the issue before public disclosure.

## Local-data risks

The workspace can contain sensitive free text. `finish` removes temporary workspace state, but it does not erase independent seed files, shell history, copied output, screenshots, backups, or operating-system recovery artifacts. See [local data guidance](docs/local-data.md).
