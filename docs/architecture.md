# Architecture

Whybranch has one supported v0.1 boundary: a local CLI starts a loopback workspace, the browser captures responses, and the CLI returns normalized state to the calling agent. It does not need a database server, cloud account, session cookie, or remote callback.

```text
private seed file
       │
       ▼
whybranch start
       │  { workspace_id, url, revision }
       ▼
127.0.0.1 workspace ── auto-saved draft ── explicit completion
       │                         │                  │
       ├── healthy writes ──────┴──── rolling exact replica
       │                                            │
       ├── pack boundary ─────────── immutable checkpoint
       │                                            │
       └────────────── consume normalized result ◀──┘
                              │
                         score + graph snapshot
                              │
                       advance same workspace
                              │
                   finish → non-destructive archive
```

## Stable workspace contract

- `start --seed-file <path>` creates one workspace and returns `workspace_id`, loopback `url`, and `revision`. `start --pack interview` resolves the included first-party interview seed through the same path.
- `status --workspace <id>` inspects that exact workspace. It must not guess from an arbitrary latest workspace.
- `consume --workspace <id>` returns only a completed, normalized result. A saved draft is deliberately not consumable as user evidence.
- `advance --workspace <id> --seed-file <path>` replaces the displayed answer pack in the same workspace and returns a later revision. A changed seed `scope_version` explicitly records `scope_changed` and opens a visible scope-coverage blocker before the pack transition; changing a scope label without a new version is rejected.
- `add-item --workspace <id> --item-file <path>` appends a newly discovered explicit material item and recalculates the projections.
- `amend-item --workspace <id> --item <item-id> --patch-file <path>` amends the status or evidence detail of an existing material item while preserving its identity and component.
- `flag-inference --workspace <id> --item <item-id> --reason <text>` appends an `inference_flagged` ledger event for a visible material item, reopens/disputes the credited inference, then projects readiness and graph again. It is a correction route, not a score override.
- `recover --workspace <id>` reopens an archive or restores missing or corrupt active state from the newest checksum-verified replica or immutable pack-boundary checkpoint, then restarts the loopback URL for the same workspace identity. Its receipt distinguishes an exact-latest replica from a rollback that may omit later unsealed changes.
- `finish --workspace <id>` stops the active listener and moves exact workspace state into the archive. It is non-destructive and is not a purge.

The URL stays stable across `advance`; revision makes the state transition explicit. This is why a sequence of answer packs should not create a sequence of browser tabs.

## Persistence and recovery contract

The default root is the platform state directory: macOS uses
`~/Library/Application Support/whybranch`, Linux uses
`${XDG_STATE_HOME:-~/.local/state}/whybranch`, and Windows uses
`%LOCALAPPDATA%/whybranch`. `WHYBRANCH_WORKSPACE_ROOT` can override the
root and must remain consistent for the workspace's lifetime. The legacy
`DGI_WORKSPACE_ROOT` is a fallback only when the new variable is unset. Known
legacy workspaces are resolved by ID and operated on in place, preserving
their original recovery and lock roots; ambiguous old/new lineage fails. See
[rename compatibility](local-data.md#rename-compatibility) for lookup details
and the intentionally unchanged wire identifiers.

The active workspace, rolling replica, immutable pack-boundary checkpoints,
and archive are separate records under that root. Recovery records live outside
the active workspace directory so loss or corruption of active state cannot
remove the only exact copy. Each replica or checkpoint preserves the full
workspace schema and is verified before recovery. A restored workspace keeps
its workspace ID and provenance; recovery does not synthesize ledger events
from chat summaries or other derived artifacts. The recovery receipt names its
source and whether it recovered the exact latest replica. A fallback to an
older verified record carries a warning because changes after that record,
including an unsealed draft, may be missing.

The atomic active-state commit and verified-replica commit are separately
observable. If active state commits but replica verification fails, the result
is a persisted `degraded` success rather than an ordinary retryable failure,
because replaying a random-ID event could duplicate provenance. No subsequent
mutation is allowed by the operating contract until `status`/`recover` verifies
the same generation and bytes in both records.

Before the active commit, an atomic marker records the target storage generation
and payload checksum as pending. After the replica commit, that marker becomes a
committed witness for the replica's storage generation and payload checksum.
Recovery calls the latest slot exact only when that committed witness matches.
A crash after the pending marker or active commit but before the replica/witness
commit therefore produces a conservative rollback warning instead of a false
`recovery_exact: true` claim.

An absent active file establishes only that it is unavailable. It does not by
itself establish whether the cause was corruption, filesystem cleanup, manual
deletion, or another failure. Unless independent evidence identifies the cause,
the cause remains unknown.

## Built-in packs and browser capabilities

The current pack surface is deliberately closed and declarative. A built-in
pack supplies a normal seed and may opt into existing schema capabilities such
as `selection_mode: "multiple"`. It cannot ship browser JavaScript, server
routes, score rules, model URLs or paths, or automatic ledger mutations. Text
responses use the normal answer field and the existing local draft and
completion APIs. This keeps packs from silently changing the local trust or
scoring boundary.

## Canonical ledger and projections

The workspace ledger is the canonical state. It holds the decision frame,
response provenance, material items, unresolved conditions, and revision
history. The rolling replica, immutable checkpoints, and archive are exact
durability copies of that state. Chat summaries and other derived views are not
backups. The readiness snapshot and decision graph are projections derived from
the ledger, not browser-only decorations.

`decision-semantics/v1` publishes the closed vocabulary currently used by those
records and projections. It is a compatibility descriptor, not a second source
of truth or an inference engine. See [decision semantics](decision-semantics.md).

Keep these categories distinct:

| Category | Meaning |
| --- | --- |
| User evidence | Direct response or a faithful summary of one; never silently inferred. |
| Assistant inference | A labelled interpretation made from evidence. |
| Assumption | A provisional condition that can be tested or invalidated. |
| Blocker | An unresolved item that can change the next decision. |
| Counterevidence | Material that weakens a claim or re-opens a candidate. |
| Candidate | An evidence-backed path, never automatically approved. |

The graph may summarize these items first and expand details on request, but it must preserve an item's identity and provenance. A UI must not add nodes or score changes that are absent from the ledger.

## Seed and result boundary

A seed supplies the decision frame, the current question pack, and optional material items. Prefer three to five independent foundation questions in the first pack. A follow-up pack may be smaller only when it is genuinely conditional on known prior evidence.

Completed results normalize responses, preserve the selected resolution, and include a readiness/graph snapshot whenever the policy can calculate one. Treat omitted fields as unknown rather than manufacturing data. The CLI's validation error is authoritative for an alpha schema change; do not recover by silently weakening the decision record.

`advance` preserves the existing ledger and appends a pack transition. Its next seed changes the visible questions and panels; it does not silently overwrite prior material items. Add or amend evidence through explicit `add-item` / `amend-item` ledger events, including `flag-inference` for a disputed inference. Preserve the raw completed response as provenance: a user correction belongs in a subsequent answer pack, then any supported material interpretation is recorded explicitly.

## Out of scope for v0.1

- Remote or multi-user workspaces
- Authentication or authorization
- Cloud synchronization and agent wake-up callbacks
- Browser-driven agent automation
- Third-party executable pack or plugin code
- Audio capture, retention, replay, or external transcription integration
- A claim that a score or graph proves a real-world outcome
