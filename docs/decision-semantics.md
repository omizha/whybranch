# Decision semantics

`decision-semantics/v1` is the machine-readable meaning contract for the
current Whybranch ledger and projection. It publishes the vocabulary the
runtime already uses; it does not migrate a workspace, add hidden facts, or
change readiness.

The package exports:

```js
import {
  DECISION_SEMANTICS_VERSION,
  DECISION_SEMANTICS_V1,
} from "whybranch";
```

The descriptor declares:

- material-item components, accepted input aliases, statuses, and defaults;
- question kinds, selection modes, and final response resolutions;
- projected graph node types and the allowed source and target types for every
  relation;
- known ledger event types and the rule that unknown event types remain
  provenance, including which known events are caller appendable and which are
  generated internally;
- the authority boundary between the canonical ledger, graph projection,
  readiness review aid, recommendation, and external action.

This v1 descriptor supports vocabulary and graph domain/range checks. It is not
a complete JSON Schema: the existing seed, submission, event, and ledger
validators remain authoritative for required properties, identifier
uniqueness, conditional fields, and cardinality.

Projected node and edge IDs are deterministic but opaque. Consumers should use
the explicit `from`, `type`, and `to` fields instead of parsing delimiters from
an ID.

The ledger boundary is strict for new known events but retains a narrow legacy
read path for older answer responses that omitted the explicit `answer`
resolution, completed non-answer responses that omitted a reason, and the
alpha producer's free-text `candidate_id`. Reading such a record does not
manufacture the missing explanation, answer content, or candidate identity;
new writes require a safe candidate identifier.

Input aliases are compatibility rules, not claims that two concepts are
identical. In particular, the current `claim → evidence` alias describes
existing normalization. A future first-class Claim must use a new semantic and
wire contract rather than silently reinterpreting historical evidence.

## Why the core does not use an ontology stack

The current problem is closed-record validation: required response states,
allowed status values, stable identifiers, and deterministic projection.
The current JSON ledger and contract tests can express those requirements
directly.

- **OWL 2** is useful when independent consumers need shared class and property
  entailments. Its open-world semantics do not by themselves enforce Whybranch's
  completion, required-field, or unresolved-state rules. See the
  [W3C OWL 2 Primer](https://www.w3.org/TR/owl2-primer/).
- **A reasoner** computes consequences entailed by a formal knowledge model.
  Whybranch currently needs explicit validation and reviewable state changes, so
  every derived conclusion would need an inspectable derivation and must stay
  outside the canonical ledger until explicitly accepted. If RDF is adopted
  later, structural and cardinality validation is closer to
  [SHACL](https://www.w3.org/TR/shacl/) than to unrestricted inference.
- **A graph database** optimizes storage and traversal. It does not define what
  evidence authority or a relation means. A local workspace currently projects
  its graph in-process from a local JSON ledger. A separate persistence/query
  layer would add another schema and migration boundary; a server deployment
  would additionally require authentication, backup, and operations. The
  repository contains no workload evidence that this solves a current
  bottleneck.
- **Microsoft Fabric Ontology** binds shared business entities and relationships
  to enterprise data in OneLake. It is relevant as a downstream adapter when a
  real customer already uses that environment, not as Whybranch's local canonical
  ledger. See the
  [Fabric Ontology overview](https://learn.microsoft.com/en-us/fabric/iq/ontology/overview).

## Adoption gates

These thresholds are Whybranch project decision gates, not industry standards.

Before a trial, check in its candidate and version, fixture or workload
manifest, competency questions and expected answers, baseline, environment,
metric definitions, sample size, SLA and cost ceiling, authority owner, and
rollback criterion.

| Candidate | Evidence required before a trial | Smallest trial | Production-use gate — canonical ledger unchanged |
| --- | --- | --- | --- |
| OWL vocabulary | Two independent external consumers and at least three real competency questions that require class or property entailment | Use one shared mapping over checked-in fixtures covering every v1 component, status family, relation type, an unknown event, a missing `source`, and a revised ledger | Both consumers' result sets exactly match the checked-in expected answers; preserve the presence or absence and exact value of every canonical identifier field and `source` string; represent authority absent from v1 as unknown |
| Reasoner | At least five versioned multi-hop rules are independently implemented in two or more named code paths, plus at least three recurring conclusions have checked-in inputs and expected results | Name the formalism and engine, then run checked-in positive, negative, and contradictory fixtures three times in a versioned shadow schema carrying `authority: system_inference`, rule or axiom ID, input IDs, engine configuration, and timestamp | 100% expected logical results, zero unsupported results, identical canonicalized inferred facts and derivation references across three runs excluding timestamps and run-specific metadata, and a byte-identical ledger; at least 20 distinct conclusions evaluated under a predeclared actionability rubric, with numerator, denominator, and reviewer count reported and at least 80% useful |
| Graph database | An explicit scope decision for cross-workspace querying, a workload forecast stating workspaces, nodes, edges, and bytes, and measured failure of the in-memory and SQLite baselines against a predeclared SLA | Verify 100% query-result parity across in-memory JSON, SQLite edge tables, and the selected graph database on the same machine, warm-up, and run protocol | Use only as a ledger-rebuildable read model; meet the p95 and peak-RSS SLA and improve at least one predeclared metric over both simpler baselines by the agreed margin within the migration and operations budget; delete that read model, rebuild it solely from canonical ledgers, and re-establish 100% query-result parity before production use |
| Fabric Ontology | A design partner already using Fabric/OneLake, at least two teams and two agents sharing the vocabulary, three cross-domain competency questions, and cloud security, cost, and governance approval | Export one synthetic Whybranch workspace, bind synthetic OneLake data from two domains, export a later revision, refresh once, and have both named agents answer the three versioned questions | Preserve Whybranch IDs and revision watermark, expose lineage for every bound field, flag stale revisions before use, answer every question correctly from both agents, and demonstrate one predeclared OneLake governance or cross-domain capability unavailable from JSON-LD alone; explicitly accept current support status, tenant, capacity, setup-time, and operating-cost limits |

Even after a gate passes, the canonical path remains:

```text
ledger ── deterministic readiness and graph
   └──── optional semantic export
              ├─ validation
              └─ shadow inference
```

An inferred result stays labelled as assistant or system inference until a
user explicitly accepts it. It must not rewrite the canonical ledger or alter
readiness by itself.

## Next semantic revision

Do not add concepts to v1 merely because they are desirable. Introduce a new
wire-aware semantic revision only when the ledger can represent and validate
them. Candidate additions are:

- typed provenance and authority for user-direct evidence, faithful summaries,
  external sources, assistant inference, and system-derived state;
- first-class item-to-item relations such as evidence supporting a candidate;
- separate Claim, DecisionFrame, Recommendation, HumanDecision, and Approval
  entities;
- optional one-way JSON-LD and PROV-O export after a real consumer exists.

Historical `source` strings and input aliases must remain unmodified. A
migration must label unknown provenance as unknown instead of manufacturing
authority from text.
