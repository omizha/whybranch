# Decision Graph Interview

Decision Graph Interview is a zero-dependency, local CLI for running an evidence-bound decision interview in one browser workspace. It keeps questions, answers, blockers, assumptions, counterevidence, readiness changes, and graph projection traceable to the same local ledger.

It is deliberately a local tool, not a hosted collaboration service: the normal path uses `127.0.0.1`, has no account or authentication, and does not send workspace data to a service.

## v0.1 status

This is an alpha public-contract repository. The command and package name below are intended for the `decision-graph-interview` npm package, but publication and ownership of that package name must be verified before relying on `npx`. Until then, use a checked-out copy.

## Quick start

Requires Node.js 20 or newer.

Start with the included example, or create a small seed file such as `decision.json`:

```json
{
  "objective": "Choose a first validation for a local decision tool",
  "scope": "One developer workflow",
  "horizon": "This week",
  "questions": [
    {
      "id": "risk",
      "prompt": "Which risk must the first validation address?",
      "kind": "choice",
      "selection_mode": "single",
      "options": [
        { "id": "privacy", "label": "Local-data handling" },
        { "id": "adoption", "label": "Agent workflow fit" }
      ],
      "allow_other": true
    }
  ],
  "material_items": [
    {
      "id": "assumption-local-only",
      "kind": "assumption",
      "label": "The first release is single-user and loopback-only",
      "impact": "high"
    }
  ]
}
```

From a checkout:

```sh
npm install
node ./bin/decision-graph.mjs start --seed-file ./examples/first-decision.json
```

After the package is published and its npm ownership is verified, the equivalent command is expected to be:

```sh
npx --yes decision-graph-interview@<published-version> start --seed-file ./decision.json
```

`start` prints JSON similar to this:

```json
{
  "workspace_id": "local-workspace-id",
  "url": "http://127.0.0.1:PORT/workspaces/local-workspace-id",
  "revision": 1
}
```

Open the returned URL. Edits are auto-saved locally. The user must still use the form's explicit completion control (for the Korean UI, `Codex로 계속`) before the agent consumes answers.

## One workspace, not a trail of tabs

Keep the `workspace_id` from `start` and use the same local URL for the full decision.

```text
start → user edits and auto-saves → explicit completion → consume
      → agent reasons → advance same workspace/revision → … → finish
```

```sh
# Inspect a known workspace without guessing.
node ./bin/decision-graph.mjs status --workspace <workspace_id>

# Read normalized answers only after explicit completion.
node ./bin/decision-graph.mjs consume --workspace <workspace_id>

# Show a follow-up pack in the same browser workspace.
node ./bin/decision-graph.mjs advance --workspace <workspace_id> --seed-file ./next-pack.json

# Add a newly discovered explicit blocker, assumption, evidence, or counterevidence.
node ./bin/decision-graph.mjs add-item --workspace <workspace_id> --item-file ./examples/new-blocker.json

# Amend an existing material item after correcting its evidence or interpretation.
node ./bin/decision-graph.mjs amend-item --workspace <workspace_id> --item <item_id> --patch-file ./examples/validate-assumption.patch.json

# Flag a bad inference against a visible material-item ID, then recalculate.
# This never edits a score directly.
node ./bin/decision-graph.mjs flag-inference --workspace <workspace_id> --item <item_id> --reason "The cited evidence does not support this inference."

# Remove temporary local workspace state when done.
node ./bin/decision-graph.mjs finish --workspace <workspace_id>
```

`advance` returns a new revision while retaining the workspace and URL. When the next seed carries a different `scope_version`, `advance` records a `scope_changed` event and opens a visible high-impact scope-coverage blocker before the pack transition; increment that version only for a material scope change. This deliberately increases remaining uncertainty until the new scope is revalidated. `consume` must not treat an auto-saved draft as a completed answer.

## Readiness and graph

`Decision Readiness (heuristic/v2)` is a transparent, deterministic review metric. It is **not** a probability, prediction, recommendation, confidence estimate, or a measure of the user's certainty. Given the same normalized ledger and policy version, it must produce the same score and graph projection.

The score can go down when new counterevidence, a high-impact blocker, a reopened candidate, or a meaningful scope change appears. The workspace summary also exposes **remaining uncertainty (heuristic)** (`unresolved_burden`): it is the policy-derived unresolved burden, not a probability or a prediction. Every change should identify its policy version, rule, affected items, and a plain-language explanation. The graph is the ledger's inspectable projection: it helps show what supports, blocks, contradicts, or re-opens a decision; its visual layout is not causal proof.

If a readiness result rests on a bad premise, correct the underlying material evidence with `add-item` or `amend-item`, or use `flag-inference` with the material-item ID shown in the graph panel. These commands append ledger events and recalculate under the same policy; none accepts a manual score override. The original completed response remains immutable provenance; capture a changed user answer in a follow-up pack rather than overwriting it.

See [score and graph semantics](docs/score-and-graph.md) and [the architecture](docs/architecture.md).

## Local data and no-auth boundary

The standard workflow stores the seed, workspace state, drafts, and result only on the local machine while the workspace is active. It makes no account, authentication, cloud-sync, telemetry, or remote-collaboration claim.

No authentication is appropriate only because the supported server is loopback-only and single-user. Browser mutations require JSON and reject a supplied foreign origin; local state mutations are serialized with a private file lock. Do not bind it to a LAN/public interface, share its local state directory, or treat the workspace URL as an access-control mechanism. Use `finish` to remove temporary workspace state and delete private seed files after use. If `start` cannot bring up the listener, it removes the unreachable workspace rather than returning its URL.

See [local data and privacy](docs/local-data.md) for limits and operating guidance.

## Agent integrations

Codex and Claude Code use one canonical skill source; their adapter folders contain only install metadata and thin pointers, not copied workflow text. See [agent integrations](docs/agent-integrations.md).

## Contributing and security

Run the full local gate before proposing a change:

```sh
npm test
npm run lint
npm run check
npm run pack:dry-run
```

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [RELEASING.md](RELEASING.md) before participating or publishing.

See [CHANGELOG.md](CHANGELOG.md) for the alpha release boundary.
