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
| A question is deferred with a bounded re-entry condition | Context-dependent | The uncertainty is explicit, but not falsely resolved. |

A higher score never erases the underlying evidence, trade-offs, counterevidence, or re-open conditions.

## Explain every delta

Each change event must be inspectable. At minimum, expose:

```json
{
  "policy_version": "heuristic/v2",
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

The graph should answer practical questions such as:

- What evidence supports or contradicts this candidate?
- Which blocker keeps the next action conditional?
- What changed this readiness snapshot?
- Which assumption would re-open the decision if it failed?

It must not imply causation merely from proximity, route length, color, or visual prominence. Summary-first display is preferred; expand the graph when the user needs provenance or an explanation.

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
decision-graph add-item --workspace <workspace_id> --item-file ./new-item.json

# Correct an existing material record while preserving its ID and component
decision-graph amend-item --workspace <workspace_id> --item <item_id> --patch-file ./item-patch.json

# Dispute an assistant inference; its prior readiness credit is reopened
decision-graph flag-inference --workspace <workspace_id> --item <item_id> --reason "Why the inference is unsupported"
```

The graph panel lists the material-item IDs and whether an inference has already been flagged. Each command records provenance and recalculates; it does not take a numeric score as input. A user changing a completed answer gets a new answer-pack record rather than a destructive edit of the old response. The UI may also show `unresolved_burden` as **remaining uncertainty (heuristic)**. It is the inverse burden produced by this policy, not a probability.
