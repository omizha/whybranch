# Architecture

Decision Graph Interview has one supported v0.1 boundary: a local CLI starts a loopback workspace, the browser captures responses, and the CLI returns normalized state to the calling agent. It does not need a database server, cloud account, session cookie, or remote callback.

```text
private seed file
       │
       ▼
decision-graph start
       │  { workspace_id, url, revision }
       ▼
127.0.0.1 workspace ── auto-saved draft ── explicit completion
       │                                            │
       └────────────── consume normalized result ◀──┘
                              │
                         score + graph snapshot
                              │
                       advance same workspace
                              │
                            finish cleanup
```

## Stable workspace contract

- `start --seed-file <path>` creates one workspace and returns `workspace_id`, loopback `url`, and `revision`.
- `status --workspace <id>` inspects that exact workspace. It must not guess from an arbitrary latest workspace.
- `consume --workspace <id>` returns only a completed, normalized result. A saved draft is deliberately not consumable as user evidence.
- `advance --workspace <id> --seed-file <path>` replaces the displayed answer pack in the same workspace and returns a later revision. A changed seed `scope_version` explicitly records `scope_changed` and opens a visible scope-coverage blocker before the pack transition; changing a scope label without a new version is rejected.
- `add-item --workspace <id> --item-file <path>` appends a newly discovered explicit material item and recalculates the projections.
- `amend-item --workspace <id> --item <item-id> --patch-file <path>` amends the status or evidence detail of an existing material item while preserving its identity and component.
- `flag-inference --workspace <id> --item <item-id> --reason <text>` appends an `inference_flagged` ledger event for a visible material item, reopens/disputes the credited inference, then projects readiness and graph again. It is a correction route, not a score override.
- `finish --workspace <id>` removes temporary workspace state when the conversation is complete or discarded.

The URL stays stable across `advance`; revision makes the state transition explicit. This is why a sequence of answer packs should not create a sequence of browser tabs.

## Canonical ledger and projections

The workspace ledger is the canonical state. It holds the decision frame, response provenance, material items, unresolved conditions, and revision history. The readiness snapshot and decision graph are projections derived from that state, not browser-only decorations.

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
- A claim that a score or graph proves a real-world outcome
