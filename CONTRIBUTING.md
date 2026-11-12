# Contributing

Thank you for improving a small, local decision tool. Keep changes evidence-bound, deterministic, and within the v0.1 local/no-auth boundary.

## Local setup

Use Node.js 20 or newer, then run:

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm run check
npm run pack:dry-run
```

The project intentionally has no runtime dependencies. The checked-in lockfile keeps the CI install path reproducible.

The loopback E2E test is required in CI. A deliberately constrained local
environment may set `WHYBRANCH_ALLOW_LOOPBACK_SKIP=1` to report an unavailable socket
as skipped while debugging, but do not use that override in CI or release
verification.

## Change expectations

- Add or update tests for a behavior change.
- Preserve deterministic score and graph output for the same normalized ledger and policy version.
- Keep auto-save separate from explicit completion and `consume`.
- Keep loopback mutations same-origin/JSON-only and preserve the workspace lock
  around every read-modify-write state transition.
- Do not add remote storage, accounts, analytics, authentication claims, or browser automation without a separately reviewed security model.
- Write public examples without private user data, local absolute paths, or access tokens.

## Shared agent skill

`integrations/shared/whybranch/` is the canonical workflow source. Keep shared guidance and conditional reference links in `SKILL.md`, with detailed guidance in its supporting references. The Codex and Claude Code adapter files may contain target-specific metadata and a pointer only; do not copy the workflow into them. Run `npm run check` after any integration change.

## README translations

[README.ko.md](README.ko.md) is the source of truth for the README.
[README.md](README.md) is its English translation. Make content changes in
Korean first, then update English in the same change. Keep section order,
examples, commands, feature claims, and limitations aligned. Preserve literal
CLI flags, schema keys, and UI labels when translating surrounding text.
Review meaning in both languages; file and link checks do not verify
translation quality.

## Pull requests

Describe the user-visible behavior, affected policy or schema version, and verification performed. Mention any deliberate compatibility change or data-retention implication. Keep unrelated generated files and local workspace data out of the change.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Contribution license

By submitting a contribution, you confirm that you have the right to submit it
and agree to license it under this project's [MIT License](LICENSE).
