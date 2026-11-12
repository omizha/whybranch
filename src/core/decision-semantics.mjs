function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const COMPONENTS = deepFreeze({
  evidence: "evidence",
  blocker: "blocker",
  assumption: "assumption",
  contradiction: "contradiction",
  candidate: "candidate",
});

export const COMPONENT_ALIASES = deepFreeze({
  evidence: COMPONENTS.evidence,
  claim: COMPONENTS.evidence,
  blocker: COMPONENTS.blocker,
  risk: COMPONENTS.blocker,
  assumption: COMPONENTS.assumption,
  contradiction: COMPONENTS.contradiction,
  conflict: COMPONENTS.contradiction,
  counterevidence: COMPONENTS.contradiction,
  candidate: COMPONENTS.candidate,
});

export const COMPONENT_STATUS_CREDIT = deepFreeze({
  [COMPONENTS.evidence]: { unknown: 0, weak: 0.25, corroborated: 0.6, verified: 1, disputed: 0 },
  [COMPONENTS.blocker]: { open: 0, planned: 0.25, mitigated: 0.6, resolved: 1, reopened: 0 },
  [COMPONENTS.assumption]: { untested: 0, partial: 0.5, validated: 1, invalidated: 0, reopened: 0 },
  [COMPONENTS.contradiction]: { open: 0, investigating: 0.25, mitigated: 0.6, resolved: 1, reopened: 0 },
  [COMPONENTS.candidate]: { emerging: 0.25, active: 0.5, frozen: 1, reopened: 0, archived: 1 },
});

export const DEFAULT_STATUS = deepFreeze({
  [COMPONENTS.evidence]: "unknown",
  [COMPONENTS.blocker]: "open",
  [COMPONENTS.assumption]: "untested",
  [COMPONENTS.contradiction]: "open",
  [COMPONENTS.candidate]: "emerging",
});

export const DECISION_SEMANTICS_VERSION = "decision-semantics/v1";

const MATERIAL_NODE_TYPES = Object.values(COMPONENTS);
const SCORED_MATERIAL_NODE_TYPES = [
  COMPONENTS.evidence,
  COMPONENTS.blocker,
  COMPONENTS.assumption,
  COMPONENTS.contradiction,
];

export const DECISION_SEMANTICS_V1 = deepFreeze({
  schema_version: DECISION_SEMANTICS_VERSION,
  describes: {
    seed_schema: "decision-graph-seed/v1",
    ledger_schema: "decision-graph-ledger/v1",
    readiness_schema: "decision-readiness/v1",
    graph_projection_schema: "decision-graph-projection/v1",
  },
  material_items: {
    components: MATERIAL_NODE_TYPES,
    input_aliases: {
      claim: COMPONENTS.evidence,
      risk: COMPONENTS.blocker,
      conflict: COMPONENTS.contradiction,
      counterevidence: COMPONENTS.contradiction,
    },
    input_alias_semantics: "normalization_only",
    valid_statuses: Object.fromEntries(
      Object.entries(COMPONENT_STATUS_CREDIT).map(([component, statuses]) => [component, Object.keys(statuses)]),
    ),
    default_statuses: DEFAULT_STATUS,
  },
  questions: {
    kinds: ["mixed", "choice", "free_text"],
    selection_modes: ["single", "multiple"],
  },
  responses: {
    resolutions: ["answer", "defer", "not_applicable", "withdrawn"],
    input_aliases: { withdraw: "withdrawn" },
  },
  graph: {
    identifiers_are_opaque: true,
    node_types: ["decision", "question", "answer", "event", ...MATERIAL_NODE_TYPES, "score"],
    relation_types: {
      asks: { from: ["decision"], to: ["question"] },
      tracks: { from: ["decision"], to: MATERIAL_NODE_TYPES },
      supports: { from: [COMPONENTS.evidence, COMPONENTS.candidate], to: ["question"] },
      blocks: { from: [COMPONENTS.blocker], to: ["question"] },
      assumes: { from: [COMPONENTS.assumption], to: ["question"] },
      contradicts: { from: [COMPONENTS.contradiction], to: ["question"] },
      records: { from: ["event"], to: ["answer"] },
      answers: { from: ["answer"], to: ["question"] },
      defers: { from: ["answer"], to: ["question"] },
      marks_not_applicable: { from: ["answer"], to: ["question"] },
      withdraws: { from: ["answer"], to: ["question"] },
      affects: { from: ["event"], to: MATERIAL_NODE_TYPES },
      reopens: { from: ["event"], to: [COMPONENTS.blocker, COMPONENTS.assumption, COMPONENTS.contradiction, COMPONENTS.candidate] },
      resolves: { from: ["event"], to: [COMPONENTS.blocker, COMPONENTS.contradiction] },
      flags: { from: ["event"], to: MATERIAL_NODE_TYPES },
      introduces: { from: ["event"], to: ["question"] },
      scored_as: { from: ["decision"], to: ["score"] },
      affects_score: { from: SCORED_MATERIAL_NODE_TYPES, to: ["score"] },
    },
  },
  events: {
    known_types: [
      "ledger_created",
      "item_created",
      "material_item_added",
      "item_updated",
      "item_reopened",
      "item_resolved",
      "inference_flagged",
      "scope_changed",
      "pack_advanced",
      "pack_completed",
      "score_changed",
    ],
    caller_appendable_types: [
      "item_created",
      "material_item_added",
      "item_updated",
      "item_reopened",
      "item_resolved",
      "inference_flagged",
      "scope_changed",
      "pack_advanced",
      "pack_completed",
    ],
    generated_only_types: ["ledger_created", "score_changed"],
    unknown_types_are_preserved: true,
  },
  authority_boundaries: {
    ledger_is_canonical: true,
    graph_is_projection: true,
    readiness_is_probability: false,
    readiness_is_recommendation: false,
    readiness_grants_action_authority: false,
  },
});
