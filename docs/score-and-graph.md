# Score and graph semantics

## Decision Readiness (heuristic/v2)

Decision Readiness is a policy-labelled, reproducible indicator of how reviewable the current decision record is. It helps decide whether to ask, validate, re-open, or act next. It does not predict success.

Do not call it any of the following:

- probability of a decision being correct;
- confidence interval, forecast, or likelihood of success;
- user confidence or agreement;
- a ranking of people, teams, or options; or
- authorization to act without a separate decision.

For the same normalized ledger and `heuristic/v2` policy, the system should produce the same component values, aggregate readiness, delta events, and graph projection. Compare snapshots only when their policy version is the same.

### Current aggregation rule

Each component first receives an impact-weighted value from its explicit
material items. The headline is then the **impact-and-component-weighted
arithmetic mean across the evaluated evidence, blocker, assumption, and
counterevidence items**. Candidate convergence remains visible but is not
folded into the headline. A component with no explicit items is `N/A` and is
excluded rather than silently counted as 100. Weighting at the item level means
a newly discovered high-impact open blocker can lower readiness even when an
older blocker is already open; the separate open-item list keeps a non-zero
score from hiding a material blocker.

## What can change readiness

The policy evaluates the state of evidence and unresolved decision risk, not the attractiveness of an answer. A score may move in either direction.

| Ledger change | Typical readiness effect | Why |
| --- | --- | --- |
| Direct evidence resolves a high-impact blocker | Increase | The next action is less dependent on an unknown. |
| A claim gains corroborating evidence | Increase | The decision record becomes more reviewable. |
| New high-impact blocker or untested assumption | Decrease | A material condition is again unresolved. |
| Counterevidence arrives or a candidate re-opens | Decrease | Prior convergence is no longer justified. |
| Scope changes materially | Decrease and re-baseline | A visible high-impact scope-coverage blocker opens until the new boundary is revalidated. |
| A question is deferred with an explicit hold memo | No direct change | The uncertainty is explicit, but an answer resolution alone does not mutate a material item. |

A higher score never erases the underlying evidence, trade-offs, counterevidence, or re-open conditions.

## Final response states

The browser presents only two top-level choices: **Answer** (`답변`) and
**Defer** (`보류`). Selecting `보류` reveals a **defer handling** control:

- `Ask again in a later pack` records **Defer** with one hold memo.
- `Exclude from this decision scope` records **Not applicable**.
- `Withdraw the question itself` records **Withdrawn**.

This keeps the response surface simple while retaining the exact provenance
meaning below. These are not three names for an empty response:

| State | Use when | Required record | What the system does | What it does not do |
| --- | --- | --- | --- | --- |
| **Defer** (`보류`) | The question is valid, but the user cannot answer it yet. | One required hold memo: why it is not final now and, when useful, what to revisit. | Preserves an unresolved response and its memo in the completed record and graph. | Does not automatically create or ask the follow-up, or change readiness by itself. |
| **Not applicable** (`해당 없음`) | The question is valid in general but does not apply to this decision, person, or current scope. | Reason. | Records that the question was out of scope for this pack. | Does not change the scope or silently suppress a future, newly scoped question. |
| **Withdrawn** (`질문 철회`) | The question itself is duplicate, based on a bad premise, or otherwise should not be asked. | Reason. | Records the withdrawal while retaining the original question and provenance. | Does not erase history; a corrected question must use a new question ID in a later pack. |

All three are visible in the graph as different answer-to-question relations.
They are provenance states, not automatic workflow engines: the calling agent
must still make an explicit later `advance` with any follow-up pack. The
browser's handling control does not create a follow-up automatically.

For wire-format compatibility, the browser stores a new merged hold memo in
`deferral.reason`. Older completed records that also contain `deferral.clue`
remain unchanged and continue to show that detail separately.

## Explain every delta

Each change event must be inspectable. At minimum, expose:

```json
{
  "policy_version": "heuristic/v2",
  "policy_hash": "normalized-policy-sha256",
  "policy_definition": {
    "label": "Decision Readiness",
    "readiness_weights": {},
    "status_credit": {}
  },
  "rule_id": "policy-specific-rule",
  "previous_value": 0,
  "next_value": 0,
  "affected_item_ids": ["ledger-item-id"],
  "explanation": "Plain-language reason for the change"
}
```

Exact numeric fields and component names may evolve during the alpha, but the explanation, affected items, and policy identity are not optional. A user must be able to correct the evidence or flag an inference error, then obtain a recalculated snapshot rather than editing a score by hand.

## Graph is a deterministic ledger projection

The graph makes the state visible: questions and answers, evidence, assumptions, blockers, counterevidence, candidates, and follow-up conditions can be traced back to their source record. Given the same ledger and policy version, node IDs, edge meaning, ordering rules, and graph data must be deterministic.

A readiness snapshot carries the normalized policy definition used to produce
it. When a caller supplies that snapshot to graph projection, the core
recomputes it against the canonical ledger and rejects a stale, foreign, or
altered receipt. This keeps custom policies usable without allowing a caller to
inject an unrelated score node.

Legacy default-policy receipts that predate the embedded policy definition are
verified against the default policy automatically. A legacy custom-policy
receipt cannot be reconstructed safely from its one-way policy hash; callers
must pass the original custom policy as the third `projectGraph` argument while
migrating that receipt.

The graph should answer practical questions such as:

- What evidence supports or contradicts this candidate?
- Which blocker keeps the next action conditional?
- What changed this readiness snapshot?
- Which assumption would re-open the decision if it failed?

It must not imply causation merely from proximity, route length, color, or visual prominence.

### Browser views

The browser presents the same projection in two deliberate views:

- **Current decision** shows the current pack's questions, material items that
  are still open or affect readiness, active candidates, and the readiness
  node. It is a focused navigation view, not a truncated copy of the ledger.
- **Explorer map** starts with compact type/status markers and deliberately
  collapses completed answers and history as a browser-only view state.
  Clicking a type lane expands or collapses that group without changing the
  graph JSON, ledger, score, or provenance. Hover/focus previews a node and
  click/Enter pins its identity, status, score relevance, and recorded direct
  relations in an inspector.

The full map initially emphasizes direct review relations (`supports`,
`blocks`, `assumes`, `contradicts`, answer-to-question links, and score impact) so
that automatic question-tracking and historical bookkeeping lines do not
overwhelm the decision state. Its **include history edges** filter exposes the
complete projection when provenance is the question and expands the history
lane. The explorer supports blank-space drag, trackpad-pinch or Cmd/Ctrl-wheel
zoom, and explicit zoom/reset controls. Type lanes are a readable grouping,
not a causal layout or a priority ranking; pan and zoom improve inspection,
not the semantic meaning of a line.

## Correcting a bad premise

When a score seems wrong, correct the ledger instead of manually overwriting the number:

1. Amend or add the missing evidence, scope detail, blocker, assumption, or counterevidence.
2. Mark an inference as disputed when the evidence does not support it.
3. Recalculate under the stated policy version.
4. Inspect the delta event and affected graph items.

This preserves a reproducible audit trail and allows readiness to fall when new information genuinely re-opens the decision.

For a local workspace, use an explicit material-item event. These files contain
only the item or patch; none contains a score.

```sh
# New evidence, blocker, assumption, or counterevidence
whybranch add-item --workspace <workspace_id> --item-file ./new-item.json

# Correct an existing material record while preserving its ID and component
whybranch amend-item --workspace <workspace_id> --item <item_id> --patch-file ./item-patch.json

# Dispute an assistant inference; its prior readiness credit is reopened
whybranch flag-inference --workspace <workspace_id> --item <item_id> --reason "Why the inference is unsupported"
```

The graph panel lists the material-item IDs and whether an inference has already been flagged. Each command records provenance and recalculates; it does not take a numeric score as input. A user changing a completed answer gets a new answer-pack record rather than a destructive edit of the old response. The UI may also show `unresolved_burden` as **remaining uncertainty (heuristic)**. It is the exact policy-derived inverse burden for this ledger and policy version, not a probability. It can increase again when a new high-impact blocker, contradiction, reopened candidate, or scope change is recorded.
