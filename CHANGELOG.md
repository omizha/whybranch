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
- Shared Decision Graph skill source with thin Codex and Claude Code adapters.

### Changed

- `Decision Readiness` now uses `heuristic/v2`: an
  impact-and-component-weighted item-level aggregate. Do not compare v1 and
  v2 snapshots as though they used the same policy.

### Security

- Loopback-only server, local temporary workspace storage, and no account,
  cookie, token, or remote-sync requirement in the supported workflow.
- Same-origin/JSON-only mutation boundary, frame denial, restrictive response
  headers, serialized local workspace writes, and startup-failure cleanup.

## [0.1.0-alpha.0] - 2026-07-28

- Initial public-contract alpha.
