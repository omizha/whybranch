# Local data and privacy

## What the supported workflow does

The supported v0.1 path is a local process bound to `127.0.0.1`. A seed file is read locally, the browser sends edits to that loopback process, and the completed result is returned locally to the calling CLI or agent. The normal flow does not require an account, authentication, cloud service, telemetry endpoint, remote database, cookie-based login, or browser automation.

Workspace state must persist long enough to restore an auto-saved draft and preserve revisions in the same local workspace. It is still local-file data: operating-system account access and filesystem permissions protect it, not application authentication.

All workspace mutations are serialized with a short private local file lock so a
browser save and an agent-side `advance`, `add-item`, `amend-item`, or
`flag-inference` command do not overwrite each other's ledger event. This is a
single-user coordination guard, not a multi-user collaboration model.

## What no authentication means

No-auth is a deliberate scope limit, not a security substitute. Treat a workspace as single-user and local-only.

- Keep the listener on loopback; do not expose it through a LAN address, reverse proxy, tunnel, or public port.
- Do not share the workspace directory or assume that a local URL grants user-level access control.
- Do not use the tool for shared, untrusted-user, or externally hosted workflows without adding a different security model.
- The local server rejects supplied cross-origin mutation requests and requires
  `application/json` for browser writes. These request checks reduce accidental
  cross-site writes; they do not turn a loopback URL into user authentication.

## Sensitive inputs

Seeds, free-text answers, evidence references, and CLI output can contain sensitive information. Before starting a session:

- avoid putting secrets, access tokens, credentials, or unnecessary personal data in a seed;
- store seed files in a private local location and avoid committing them;
- be careful when copying terminal output or graph exports into chats, issues, or logs; and
- use synthetic examples for bug reports whenever possible.

`finish --workspace <workspace_id>` removes temporary workspace state. It does not delete an independently created seed file, copied terminal output, screenshots, backups, or shell history. Delete those separately when appropriate.

If `start` cannot create a reachable loopback server, it terminates its child
process and removes the just-created workspace rather than returning an
unreachable URL. v0.1 does not perform age-based workspace garbage collection:
call `finish` after a completed or abandoned decision.

## User-visible behavior

Auto-save protects an in-progress local draft across a page refresh. It does not submit an answer, wake an agent, or authorize the agent to consume user evidence. The user must use the explicit completion control before `consume` returns a normalized result.

If the user abandons the workspace, preserve the draft until they choose to finish/discard it or local retention is otherwise managed. Do not represent a draft as an answer merely because it is present on disk.
