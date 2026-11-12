# Local data and privacy

## What the supported workflow does

The supported v0.1 path is a local process bound to `127.0.0.1`. A seed file is read locally, the browser sends edits to that loopback process, and the completed result is returned locally to the calling CLI or agent. The normal flow does not require an account, authentication, cloud service, telemetry endpoint, remote database, cookie-based login, or browser automation.

Workspace state is persistent local-file data. By default the CLI uses the
platform state directory:

- macOS: `~/Library/Application Support/whybranch`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/whybranch`
- Windows: `%LOCALAPPDATA%/whybranch`

`WHYBRANCH_WORKSPACE_ROOT` overrides this location. Keep the same override for
every command that addresses a workspace. Operating-system account access and
filesystem permissions protect these records, not application authentication.

All workspace mutations are serialized with a short private local file lock so a
browser save and an agent-side `advance`, `add-item`, `amend-item`, or
`flag-inference` command do not overwrite each other's ledger event. This is a
single-user coordination guard, not a multi-user collaboration model.

A healthy accepted write also updates an exact rolling recovery replica outside
the active workspace directory. The CLI seals immutable checkpoints at pack
boundaries there as well. Before changing active state, the CLI durably marks
the target generation `pending`; only after the replica is written does that
marker become a commit witness binding the latest replica's storage generation
and checksum to the completed active→replica write. Merely occupying the
`latest` slot is not proof of exact-latest recovery. If the
canonical atomic write commits but its replica
cannot be verified, the operation returns and persists
`storage_health.status: "degraded"` rather than inviting a retry that could
duplicate a ledger event. Treat that as a stop condition: keep the receipt, run
`status` and `recover` for the same workspace ID, and make no further mutation
until the active generation and latest replica verify as identical. Healthy
replicas and checkpoints preserve exact drafts, responses, revisions, and
ledger events if active state becomes missing or corrupt. Chat summaries, task
state, copied terminal output, and derived documents are not substitutes for
them.

`workspace.json` also persists the current revision's browser presentation
state: score/details disclosure state, graph view, filter, collapsed graph
types, pinned node, and graph viewport after pan or zoom. The loopback
`/api/ui-state` mutation uses the same workspace lock and rolling recovery
replica. Each write must match both the current workspace revision and ledger
revision; an older page receives `409`, and a stored state from an older scope
is ignored rather than applied to a changed graph. A degraded replica result is
shown in the page's durability warning and status text.

## Rename compatibility

New workspaces use the `whybranch` platform directory unless an override is
set. Root selection prefers an explicitly supplied `rootDir`, then
`WHYBRANCH_WORKSPACE_ROOT`, then the legacy `DGI_WORKSPACE_ROOT`, then the new
platform default. The old environment variable remains a compatibility
fallback; if both variables are set, the Whybranch variable wins.

When no root override is supplied, commands addressing an existing workspace
also look up its ID in the former `decision-graph-interview` platform directory
and the former temporary `decision-graph-interview` directory. Existing state
is operated on in place, with no automatic bulk move. A legacy temporary
workspace keeps its recovery records and locks in the old persistent platform
directory. If the same ID has lineage in both old and new storage, the command
fails instead of guessing; select the intended root explicitly before
continuing.

Persisted `decision-graph-*/v1` format identifiers and the exported
`decision-semantics/v1` contract retain their existing names. They are wire
compatibility identifiers, and renaming them would rewrite historical,
checksummed evidence. The source checkout also retains
`bin/decision-graph.mjs` as a forwarding entry point for existing absolute
calls; the published command is `whybranch`.

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

`finish --workspace <workspace_id>` stops the active loopback workspace and
moves its exact state into the `archive` area under the platform state root. It
does not purge the workspace, its recovery records, an independently created
seed file, copied terminal output, screenshots, backups, or shell history. The
CLI intentionally exposes no purge command; filesystem retention or deletion
must be managed separately and carefully.

If `start` cannot create a reachable loopback server, it terminates its child
process rather than returning an unreachable URL. Do not infer from a missing
active file alone that a workspace was finished, expired, or intentionally
deleted; without supporting evidence, the cause is unknown.

## Recovery and archival

Use `status --workspace <workspace_id>` first when a known URL stops responding.
If active state is present, the workspace can be served again without changing
its identity. If active state is missing or corrupt, run:

```sh
whybranch recover --workspace <workspace_id>
```

Recovery can reopen a non-destructive archive or validate the newest rolling
replica or immutable pack-boundary checkpoint. It restores the same workspace
identity and restarts its loopback URL. Verify the returned revision, ledger
revision, `recovered_from`, `recovery_exact`, and `recovery_warning` before
resuming. A checkpoint is exact for the boundary it sealed but may roll back
changes made afterward, including an unsealed draft; the receipt reports that
possibility rather than claiming exact-latest recovery. If no verified recovery
record exists, report the completed-revision and open-draft
boundaries as unknown or missing; do not reconstruct exact user evidence from a
chat recap.

Call `finish` after a completed or abandoned decision when the active listener
is no longer needed. Archived state remains recoverable local data; finishing
is closure, not deletion.

## User-visible behavior

Auto-save protects an in-progress local draft across a page refresh and updates
the rolling replica. It does not submit an answer, wake an agent, or authorize
the agent to consume user evidence. The user must use the explicit completion
control before `consume` returns a normalized result. Pack transitions seal
immutable boundary checkpoints before the next browser pack replaces it.

Draft saves are debounced for 450 ms and presentation-state saves for 300 ms, so
the UI must show a completed save receipt before closure is treated as durable.
Input or display changes made inside the final debounce/request window can be
lost if the page or process is killed before the request finishes; neither a
chat recap nor the rendered pixels are a substitute for that receipt. Durable
presentation state restores after refresh or a listener restart, but does not
preserve browser-window placement, scroll position, hover/focus, tab history,
or exact rendered pixels.

If the user abandons the workspace, preserve and archive the draft until local
retention is otherwise managed. Do not represent a draft as an answer merely
because it is present on disk, and do not describe an archive as a purge.
