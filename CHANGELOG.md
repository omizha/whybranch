# Changelog

All notable changes are documented here. This repository follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic
versioning once the public API reaches `1.0.0`.

## [Unreleased]

### Added

- Local loopback workspace CLI with draft autosave, explicit completion, and
  stable-URL answer-pack advancement.
- Evidence-bound ledger, deterministic graph projection, and labelled
  readiness heuristic.
- Shared Whybranch skill source with thin Codex and Claude Code adapters.
- Frozen `decision-semantics/v1` package exports and conformance tests that
  publish the current material-item, response, event, node, and relation
  vocabulary without changing ledger or score output.
- Persistent platform-state storage, exact rolling recovery replicas, immutable
  pack-boundary checkpoints, non-destructive archives, and verified workspace
  recovery with loopback restart.

### Changed

- Renamed the product, npm package, CLI, and shared agent skill to Whybranch.
  The skill is now invoked as `$whybranch`; the executable is `whybranch`.
  Frozen wire schema identifiers remain unchanged for compatibility.
- New state defaults to the `whybranch` platform directory and uses
  `WHYBRANCH_WORKSPACE_ROOT`. The former `DGI_WORKSPACE_ROOT`, existing workspace
  locations, and source-level `bin/decision-graph.mjs` entry point remain
  compatible. Existing evidence stays in place; conflicting old/new lineage
  for one workspace ID fails instead of being silently selected.

- The response surface now has only `답변` and `보류`. A nested `보류 처리`
  selector records whether to ask again in a later pack, exclude the question
  from the current decision scope, or withdraw the question. The ledger still
  preserves the three distinct non-answer states and their graph relations;
  none changes readiness or creates a follow-up automatically.
- A deferred answer now uses one required `보류 메모` rather than separate
  reason and re-entry fields. Legacy completed records retain their original
  re-entry detail.
- The graph panel now separates a current-decision focus from a pannable,
  zoomable explorer map. Explorer lane collapse is a transient browser-only
  view state; it never rewrites the ledger, graph JSON, score, or provenance.
- Malformed one-line TypeScript fences from generated prompts now render as
  bounded, copyable code blocks rather than one long prose line.
- `Decision Readiness` now uses `heuristic/v2`: an
  impact-and-component-weighted item-level aggregate. Do not compare v1 and
  v2 snapshots as though they used the same policy.
- Known completion and advancement events now cross one canonical validation
  boundary, generated score-event IDs remain unique under caller collisions,
  and graph tuple IDs are deterministic but opaque.
- Workspace state now defaults to the operating system's application-state
  directory instead of an OS temporary directory. `WHYBRANCH_WORKSPACE_ROOT` is
  the explicit override and must be consistent across commands.
- `finish` now stops the listener and archives exact state under the workspace
  root instead of deleting the workspace. The CLI exposes no purge command.
- `recover --workspace` now validates the newest exact rolling replica or
  immutable pack-boundary checkpoint, restores the same workspace identity,
  and restarts its loopback URL. Its receipt identifies the recovery source,
  distinguishes exact-latest recovery from rollback to an older verified
  record, and warns when later changes may be missing. Missing state alone no
  longer implies a known deletion or expiry cause.

### Removed

- Browser Voice/STT, local model-asset management, and the `voice_input` seed
  contract. All answer fields now use the normal text-input and auto-save path.
  Existing seed fields are ignored for compatibility and should be removed when
  the seed is next edited.

### Security

- Loopback-only server, persistent private local workspace storage, and no
  account, cookie, token, or remote-sync requirement in the supported workflow.
- Same-origin/JSON-only mutation boundary, frame denial, restrictive response
  headers, serialized local workspace writes, and startup-failure cleanup.
- Recovery replicas and checkpoints preserve exact ledger provenance outside
  the active workspace directory. Chat summaries and derived artifacts are not
  treated as backups or authoritative recovery sources.

## [0.1.0-alpha.0] - 2026-07-28

- Initial public-contract alpha.
