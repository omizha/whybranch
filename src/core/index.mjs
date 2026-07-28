import { createHash } from "node:crypto";

export const LEDGER_SCHEMA_VERSION = "decision-graph-ledger/v1";
export const SEED_SCHEMA_VERSION = "decision-graph-seed/v1";

const COMPONENTS = Object.freeze({
  evidence: "evidence",
  blocker: "blocker",
  assumption: "assumption",
  contradiction: "contradiction",
  candidate: "candidate",
});

const COMPONENT_ALIASES = Object.freeze({
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

const IMPACT_ALIASES = Object.freeze({ low: 1, medium: 3, high: 5, critical: 5 });

const COMPONENT_STATUS_CREDIT = Object.freeze({
  [COMPONENTS.evidence]: Object.freeze({ unknown: 0, weak: 0.25, corroborated: 0.6, verified: 1, disputed: 0 }),
  [COMPONENTS.blocker]: Object.freeze({ open: 0, planned: 0.25, mitigated: 0.6, resolved: 1, reopened: 0 }),
  [COMPONENTS.assumption]: Object.freeze({ untested: 0, partial: 0.5, validated: 1, invalidated: 0, reopened: 0 }),
  [COMPONENTS.contradiction]: Object.freeze({ open: 0, investigating: 0.25, mitigated: 0.6, resolved: 1, reopened: 0 }),
  [COMPONENTS.candidate]: Object.freeze({ emerging: 0.25, active: 0.5, frozen: 1, reopened: 0, archived: 1 }),
});

const DEFAULT_STATUS = Object.freeze({
  [COMPONENTS.evidence]: "unknown",
  [COMPONENTS.blocker]: "open",
  [COMPONENTS.assumption]: "untested",
  [COMPONENTS.contradiction]: "open",
  [COMPONENTS.candidate]: "emerging",
});

const DISPLAY_DIMENSIONS = Object.freeze([
  [COMPONENTS.evidence, "information_completeness", "Information completeness"],
  [COMPONENTS.blocker, "blocker_clearance", "Blocker clearance"],
  [COMPONENTS.assumption, "assumption_validation", "Assumption validation"],
  [COMPONENTS.contradiction, "contradiction_stability", "Counterevidence stability"],
  [COMPONENTS.candidate, "candidate_convergence", "Candidate convergence"],
]);

export const DEFAULT_SCORING_POLICY = Object.freeze({
  id: "decision-readiness-heuristic",
  version: "2",
  label: "Decision Readiness (heuristic/v2)",
  // Candidate convergence remains visible, but is deliberately excluded from
  // the headline. A team can converge too early while evidence is still weak.
  readiness_weights: Object.freeze({
    [COMPONENTS.evidence]: 1,
    [COMPONENTS.blocker]: 1.25,
    [COMPONENTS.assumption]: 1,
    [COMPONENTS.contradiction]: 1.25,
  }),
  status_credit: COMPONENT_STATUS_CREDIT,
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  return nonEmptyString(value, field);
}

function safeIdentifier(value, field) {
  const normalized = nonEmptyString(value, field);
  if (!/^[A-Za-z0-9:_-]+$/.test(normalized)) throw new Error(`${field} contains unsupported characters`);
  return normalized;
}

function optionalArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array when provided`);
  return value;
}

function normalizePanelItems(value, field, labelKeys = ["label", "text", "title"]) {
  return optionalArray(value, field).map((item, index) => {
    if (typeof item === "string") return { label: nonEmptyString(item, `${field}[${index}]`) };
    if (!isPlainObject(item)) throw new Error(`${field}[${index}] must be a string or object`);
    const label = labelKeys.map((key) => item[key]).find((candidate) => typeof candidate === "string" && candidate.trim() !== "");
    const normalized = {
      label: nonEmptyString(label, `${field}[${index}].label`),
      detail: optionalString(item.detail ?? item.reason ?? item.rationale, `${field}[${index}].detail`),
      unlock_condition: optionalString(item.unlock_condition, `${field}[${index}].unlock_condition`),
    };
    return Object.fromEntries(Object.entries(normalized).filter(([, entry]) => entry !== undefined));
  });
}

function normalizeQuestion(question, index, seen) {
  if (!isPlainObject(question)) throw new Error(`seed.questions[${index}] must be an object`);
  const id = safeIdentifier(question.id, `seed.questions[${index}].id`);
  if (seen.has(id)) throw new Error(`seed.questions contains duplicate id: ${id}`);
  seen.add(id);
  const kind = question.kind ?? "mixed";
  if (!new Set(["mixed", "choice", "free_text"]).has(kind)) {
    throw new Error(`seed.questions[${index}].kind must be mixed, choice, or free_text`);
  }
  const selectionMode = question.selection_mode ?? "single";
  if (!new Set(["single", "multiple"]).has(selectionMode)) {
    throw new Error(`seed.questions[${index}].selection_mode must be single or multiple`);
  }
  const optionSeen = new Set();
  const options = optionalArray(question.options, `seed.questions[${index}].options`).map((option, optionIndex) => {
    if (!isPlainObject(option)) throw new Error(`seed.questions[${index}].options[${optionIndex}] must be an object`);
    const optionId = safeIdentifier(option.id, `seed.questions[${index}].options[${optionIndex}].id`);
    if (optionId === "__other") throw new Error(`seed.questions[${index}].options[${optionIndex}].id is reserved`);
    if (optionSeen.has(optionId)) throw new Error(`seed.questions[${index}].options has duplicate ids`);
    optionSeen.add(optionId);
    const normalized = {
      id: optionId,
      label: nonEmptyString(option.label, `seed.questions[${index}].options[${optionIndex}].label`),
      recording_effect: optionalString(option.recording_effect, `seed.questions[${index}].options[${optionIndex}].recording_effect`),
    };
    return Object.fromEntries(Object.entries(normalized).filter(([, entry]) => entry !== undefined));
  });
  if (kind === "choice" && options.length === 0) throw new Error(`seed.questions[${index}] is choice but has no options`);
  if (selectionMode === "multiple" && (kind === "free_text" || options.length === 0)) {
    throw new Error(`seed.questions[${index}].selection_mode multiple requires options`);
  }
  const normalized = {
    id,
    prompt: nonEmptyString(question.prompt, `seed.questions[${index}].prompt`),
    description: optionalString(question.description, `seed.questions[${index}].description`),
    answer_effect: optionalString(question.answer_effect, `seed.questions[${index}].answer_effect`),
    draft_response: optionalString(question.draft_response, `seed.questions[${index}].draft_response`),
    kind,
    selection_mode: selectionMode,
    options,
    allow_other: question.allow_other === true,
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, entry]) => entry !== undefined));
}

function normalizeImpact(value, field) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5) return value;
  if (typeof value === "string" && IMPACT_ALIASES[value.trim().toLowerCase()] !== undefined) return IMPACT_ALIASES[value.trim().toLowerCase()];
  throw new Error(`${field} must be an integer from 1 to 5 or low, medium, high, or critical`);
}

function normalizeComponent(value, field) {
  const key = nonEmptyString(value, field).toLowerCase();
  const component = COMPONENT_ALIASES[key];
  if (!component) throw new Error(`${field} must name evidence, blocker, assumption, contradiction, or candidate`);
  return component;
}

function normalizeMaterialItem(item, index, questionIds) {
  if (!isPlainObject(item)) throw new Error(`seed.material_items[${index}] must be an object`);
  const component = normalizeComponent(item.component ?? item.kind, `seed.material_items[${index}].kind`);
  const id = safeIdentifier(item.id, `seed.material_items[${index}].id`);
  const statuses = COMPONENT_STATUS_CREDIT[component];
  const status = (item.status ?? DEFAULT_STATUS[component]).toString().trim().toLowerCase();
  if (statuses[status] === undefined) {
    throw new Error(`seed.material_items[${index}].status is not valid for ${component}`);
  }
  let relatedQuestionId = optionalString(item.related_question_id ?? item.question_id, `seed.material_items[${index}].related_question_id`);
  if (relatedQuestionId) {
    relatedQuestionId = relatedQuestionId.replace(/^q:/, "");
    if (!questionIds.has(relatedQuestionId)) throw new Error(`seed.material_items[${index}].related_question_id does not name a question`);
  }
  const normalized = {
    id,
    component,
    label: nonEmptyString(item.label, `seed.material_items[${index}].label`),
    impact: normalizeImpact(item.impact, `seed.material_items[${index}].impact`),
    status,
    evidence_grade: optionalString(item.evidence_grade, `seed.material_items[${index}].evidence_grade`),
    source: optionalString(item.source, `seed.material_items[${index}].source`),
    related_question_id: relatedQuestionId,
    candidate_id: optionalString(item.candidate_id, `seed.material_items[${index}].candidate_id`),
    detail: optionalString(item.detail ?? item.rationale ?? item.reason, `seed.material_items[${index}].detail`),
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, entry]) => entry !== undefined));
}

/**
 * Normalize only explicit score inputs. Text in a question or panel never
 * becomes a hidden score input; callers must provide material_items instead.
 */
export function normalizeSeed(input) {
  if (!isPlainObject(input)) throw new Error("seed must be an object");
  const questionSeen = new Set();
  const questionsInput = optionalArray(input.questions, "seed.questions");
  if (questionsInput.length === 0) throw new Error("seed.questions must contain at least one question");
  if (questionsInput.length > 12) throw new Error("seed.questions must contain no more than 12 questions");
  const questions = questionsInput.map((question, index) => normalizeQuestion(question, index, questionSeen));
  const itemSeen = new Set();
  const materialItems = optionalArray(input.material_items, "seed.material_items").map((item, index) => {
    const normalized = normalizeMaterialItem(item, index, questionSeen);
    if (itemSeen.has(normalized.id)) throw new Error("seed.material_items contains duplicate ids");
    itemSeen.add(normalized.id);
    return normalized;
  });
  const ambiguity = input.ambiguity === undefined || input.ambiguity === null
    ? undefined
    : (() => {
      if (!isPlainObject(input.ambiguity)) throw new Error("seed.ambiguity must be an object when provided");
      const estimate = input.ambiguity.estimate;
      if (estimate !== undefined && estimate !== null && typeof estimate !== "string" && !(typeof estimate === "number" && Number.isFinite(estimate))) {
        throw new Error("seed.ambiguity.estimate must be a string or finite number");
      }
      return Object.fromEntries(Object.entries({
        estimate: estimate === undefined || estimate === null || estimate === "" ? undefined : String(estimate),
        rationale: optionalString(input.ambiguity.rationale, "seed.ambiguity.rationale"),
      }).filter(([, entry]) => entry !== undefined));
    })();
  const normalized = {
    schema_version: input.schema_version ?? SEED_SCHEMA_VERSION,
    objective: nonEmptyString(input.objective, "seed.objective"),
    scope: optionalString(input.scope, "seed.scope"),
    horizon: optionalString(input.horizon, "seed.horizon"),
    scope_version: optionalString(input.scope_version, "seed.scope_version") ?? "1",
    created_at: optionalString(input.created_at, "seed.created_at"),
    working_assumption: optionalString(input.working_assumption, "seed.working_assumption"),
    ambiguity,
    current_blockers: normalizePanelItems(input.current_blockers, "seed.current_blockers"),
    potential_follow_ups: normalizePanelItems(input.potential_follow_ups, "seed.potential_follow_ups", ["label", "prompt", "question", "text"]),
    candidate_uncertainties: normalizePanelItems(input.candidate_uncertainties, "seed.candidate_uncertainties", ["label", "uncertainty", "text", "title"]),
    questions,
    material_items: materialItems,
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, entry]) => entry !== undefined));
}

function normalizeLedger(ledger) {
  if (!isPlainObject(ledger) || ledger.schema_version !== LEDGER_SCHEMA_VERSION) {
    throw new Error("ledger has an invalid schema version");
  }
  if (!Number.isInteger(ledger.revision) || ledger.revision < 0) throw new Error("ledger revision must be a non-negative integer");
  if (!Array.isArray(ledger.items) || !Array.isArray(ledger.events) || !Array.isArray(ledger.questions)) {
    throw new Error("ledger is missing canonical arrays");
  }
  return clone(ledger);
}

export function createLedgerFromSeed(seedInput) {
  const seed = normalizeSeed(seedInput);
  const decisionId = `decision-${hash({ objective: seed.objective, scope: seed.scope, questions: seed.questions.map((question) => question.id) }).slice(0, 20)}`;
  const initialEvents = [
    {
      event_id: "event-ledger-created",
      type: "ledger_created",
      occurred_at: seed.created_at ?? null,
      entity_ids: [decisionId],
      payload: { scope_version: seed.scope_version },
    },
    ...seed.material_items.map((item) => ({
      event_id: `event-item-created-${item.id}`,
      type: "item_created",
      occurred_at: seed.created_at ?? null,
      entity_ids: [item.id],
      payload: { item: clone(item) },
    })),
  ];
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    decision_id: decisionId,
    revision: 0,
    scope: { label: seed.scope ?? seed.objective, version: seed.scope_version },
    seed,
    questions: clone(seed.questions),
    items: clone(seed.material_items),
    events: initialEvents,
  };
}

function normalizeEvent(event, nextRevision) {
  if (!isPlainObject(event)) throw new Error("event must be an object");
  const type = safeIdentifier(event.type, "event.type");
  const payload = event.payload === undefined ? {} : event.payload;
  if (!isPlainObject(payload)) throw new Error("event.payload must be an object when provided");
  const entityIds = optionalArray(event.entity_ids ?? event.affected_item_ids, "event.entity_ids").map((id, index) => safeIdentifier(id, `event.entity_ids[${index}]`));
  return {
    event_id: event.event_id ? safeIdentifier(event.event_id, "event.event_id") : `event-${nextRevision}-${type}`,
    type,
    occurred_at: optionalString(event.occurred_at, "event.occurred_at") ?? null,
    entity_ids: [...new Set(entityIds)].sort(),
    payload: clone(payload),
  };
}

function replaceItem(items, itemId, replace) {
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) throw new Error(`event refers to unknown material item: ${itemId}`);
  const next = [...items];
  next[index] = replace(next[index]);
  return next;
}

function itemForEvent(event) {
  return event.payload.item ?? event.payload.material_item;
}

function registerQuestions(existingQuestions, incomingQuestions) {
  if (!Array.isArray(incomingQuestions)) throw new Error("pack_advanced requires payload.questions to be an array");
  const seen = new Set();
  const normalized = incomingQuestions.map((question, index) => normalizeQuestion(question, index, seen));
  const existingById = new Map(existingQuestions.map((question) => [question.id, question]));
  const additions = [];
  for (const question of normalized) {
    const previous = existingById.get(question.id);
    if (previous) {
      if (JSON.stringify(canonical(previous)) !== JSON.stringify(canonical(question))) {
        throw new Error(`pack_advanced reuses question id with a different definition: ${question.id}`);
      }
    } else {
      additions.push(question);
      existingById.set(question.id, question);
    }
  }
  return {
    questions: [...existingQuestions, ...additions],
    normalized,
    additions,
  };
}

/**
 * Apply a canonical event without mutating the prior ledger. Unknown event
 * types are retained as provenance events; only documented mutation types
 * change item or scope state.
 */
export function appendEvent(ledgerInput, eventInput, policy = DEFAULT_SCORING_POLICY) {
  const previous = normalizeLedger(ledgerInput);
  const nextRevision = previous.revision + 1;
  const event = normalizeEvent(eventInput, nextRevision);
  let items = clone(previous.items);
  let scope = clone(previous.scope);
  let questions = clone(previous.questions);
  let questionIds = new Set(questions.map((question) => question.id));

  if (event.type === "item_created" || event.type === "material_item_added") {
    const item = normalizeMaterialItem(itemForEvent(event), items.length, questionIds);
    if (items.some((entry) => entry.id === item.id)) throw new Error(`event creates duplicate material item: ${item.id}`);
    items.push(item);
    event.entity_ids = [...new Set([...event.entity_ids, item.id])].sort();
  } else if (event.type === "item_updated") {
    const itemId = safeIdentifier(event.payload.item_id ?? event.entity_ids[0], "event.payload.item_id");
    const patch = event.payload.patch;
    if (!isPlainObject(patch)) throw new Error("item_updated requires payload.patch");
    for (const immutableField of ["id", "kind", "component"]) {
      if (Object.hasOwn(patch, immutableField)) {
        throw new Error(`item_updated cannot change ${immutableField}`);
      }
    }
    items = replaceItem(items, itemId, (current) => normalizeMaterialItem({ ...current, ...patch, id: current.id, kind: current.component }, 0, questionIds));
    event.entity_ids = [...new Set([...event.entity_ids, itemId])].sort();
  } else if (event.type === "item_reopened" || event.type === "item_resolved" || event.type === "inference_flagged") {
    const itemId = safeIdentifier(event.payload.item_id ?? event.entity_ids[0], "event.payload.item_id");
    items = replaceItem(items, itemId, (current) => {
      if (event.type === "inference_flagged") {
        // A disputed assistant inference must stop receiving its prior credit
        // until evidence is reinterpreted. This is intentionally a ledger
        // state change, not a cosmetic annotation or a manual score edit.
        const status = current.component === COMPONENTS.evidence ? "disputed" : "reopened";
        return { ...current, status, inference_flagged: true };
      }
      const status = event.type === "item_reopened" ? "reopened" : "resolved";
      if (COMPONENT_STATUS_CREDIT[current.component][status] === undefined) {
        throw new Error(`${status} is not supported for ${current.component}`);
      }
      return { ...current, status };
    });
    event.entity_ids = [...new Set([...event.entity_ids, itemId])].sort();
  } else if (event.type === "scope_changed") {
    const version = optionalString(event.payload.scope_version, "event.payload.scope_version");
    if (!version) throw new Error("scope_changed requires payload.scope_version");
    scope = { label: optionalString(event.payload.scope, "event.payload.scope") ?? scope.label, version };
    // A material scope revision makes prior coverage incomplete until it is
    // reviewed again. Record that explicitly as a visible blocker instead of
    // silently carrying the former score into a new decision boundary.
    const coverageId = `scope-coverage-${hash({ label: scope.label, version: scope.version }).slice(0, 12)}`;
    if (!items.some((item) => item.id === coverageId)) {
      const coverage = normalizeMaterialItem({
        id: coverageId,
        kind: "blocker",
        label: `Scope ${scope.version} coverage needs revalidation`,
        impact: "high",
        status: "open",
        source: "scope_changed",
        detail: "A material scope change requires an explicit coverage review before prior readiness can be relied on.",
      }, items.length, questionIds);
      items.push(coverage);
      event.entity_ids = [...new Set([...event.entity_ids, coverageId])].sort();
      event.payload.scope_coverage_item_id = coverageId;
    }
  } else if (event.type === "pack_advanced" && event.payload.questions !== undefined) {
    const registration = registerQuestions(questions, event.payload.questions);
    questions = registration.questions;
    questionIds = new Set(questions.map((question) => question.id));
    event.payload.questions = registration.normalized;
    event.payload.question_ids = registration.normalized.map((question) => question.id);
  }

  const updated = {
    ...previous,
    revision: nextRevision,
    scope,
    questions,
    items,
    events: [...previous.events, event],
  };
  const before = computeReadiness(previous, policy);
  const after = computeReadiness(updated, policy);
  const scoreEvent = createScoreEvent(before, after, event);
  if (scoreEvent) updated.events.push(scoreEvent);
  return updated;
}

function normalizePolicy(policyInput) {
  const policy = policyInput ?? DEFAULT_SCORING_POLICY;
  if (!isPlainObject(policy)) throw new Error("scoring policy must be an object");
  const weights = { ...DEFAULT_SCORING_POLICY.readiness_weights, ...(policy.readiness_weights ?? {}) };
  for (const [component, weight] of Object.entries(weights)) {
    if (!Object.values(COMPONENTS).includes(component) || component === COMPONENTS.candidate || typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
      throw new Error(`invalid readiness weight for ${component}`);
    }
  }
  return {
    id: optionalString(policy.id, "policy.id") ?? DEFAULT_SCORING_POLICY.id,
    version: optionalString(policy.version, "policy.version") ?? DEFAULT_SCORING_POLICY.version,
    label: optionalString(policy.label, "policy.label") ?? DEFAULT_SCORING_POLICY.label,
    readiness_weights: weights,
    status_credit: policy.status_credit ?? DEFAULT_SCORING_POLICY.status_credit,
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function scoreComponent(items, component, policy) {
  const relevant = items.filter((item) => item.component === component);
  if (relevant.length === 0) {
    return { value: null, state: "not_evaluated", item_count: 0, weighted_total: 0, weighted_credit: 0, open_item_ids: [] };
  }
  const credits = policy.status_credit?.[component] ?? COMPONENT_STATUS_CREDIT[component];
  let weightedTotal = 0;
  let weightedCredit = 0;
  const openItemIds = [];
  for (const item of relevant) {
    const credit = credits[item.status];
    if (typeof credit !== "number") throw new Error(`policy does not define ${component}.${item.status}`);
    weightedTotal += item.impact;
    weightedCredit += item.impact * credit;
    if (credit < 1) openItemIds.push(item.id);
  }
  return {
    value: round((weightedCredit / weightedTotal) * 100),
    state: "evaluated",
    item_count: relevant.length,
    weighted_total: weightedTotal,
    weighted_credit: round(weightedCredit),
    open_item_ids: openItemIds.sort(),
  };
}

/**
 * Compute a deterministic, policy-labelled review metric. N/A components are
 * excluded rather than treated as 100, and candidate convergence is visible
 * but not part of the headline readiness score.
 */
export function computeReadiness(ledgerInput, policyInput = DEFAULT_SCORING_POLICY) {
  const ledger = normalizeLedger(ledgerInput);
  const policy = normalizePolicy(policyInput);
  const policyHash = hash({ id: policy.id, version: policy.version, readiness_weights: policy.readiness_weights, status_credit: policy.status_credit });
  const dimensions = {};
  for (const [component, key, label] of DISPLAY_DIMENSIONS) {
    dimensions[key] = { label, component, ...scoreComponent(ledger.items, component, policy) };
  }
  const includedItems = ledger.items
    .filter((item) => Object.hasOwn(policy.readiness_weights, item.component))
    .map((item) => {
      const credits = policy.status_credit?.[item.component] ?? COMPONENT_STATUS_CREDIT[item.component];
      const credit = credits[item.status];
      if (typeof credit !== "number") throw new Error(`policy does not define ${item.component}.${item.status}`);
      return {
        item,
        weight: policy.readiness_weights[item.component] * item.impact,
        credit,
      };
    });
  let score = null;
  if (includedItems.length > 0) {
    // The headline weights each material item by both impact and component
    // policy. This lets a newly discovered high-impact open item change the
    // number even if another item in that component is already unresolved.
    // Component summaries remain visible to explain where the burden sits.
    const totalWeight = includedItems.reduce((total, { weight }) => total + weight, 0);
    const weightedCredit = includedItems.reduce((total, { weight, credit }) => total + (weight * credit), 0);
    score = round((weightedCredit / totalWeight) * 100);
  }
  const open = Object.values(dimensions).flatMap((dimension) => dimension.open_item_ids ?? []);
  const rationale = [];
  if (score === null) rationale.push("No material scoring items are recorded; readiness is N/A rather than inferred from free text.");
  for (const dimension of Object.values(dimensions)) {
    if (dimension.state === "not_evaluated") rationale.push(`${dimension.label} is N/A because no explicit material item is recorded.`);
    else if (dimension.open_item_ids.length > 0) rationale.push(`${dimension.label} remains open for: ${dimension.open_item_ids.join(", ")}.`);
  }
  return {
    schema_version: "decision-readiness/v1",
    label: policy.label,
    score,
    unresolved_burden: score === null ? null : round(100 - score),
    policy: { id: policy.id, version: policy.version, hash: policyHash },
    ledger_revision: ledger.revision,
    scope_version: ledger.scope.version,
    dimensions,
    open_item_ids: [...new Set(open)].sort(),
    rationale,
  };
}

export function createScoreEvent(previous, next, cause = {}) {
  const previousValue = previous?.score ?? null;
  const nextValue = next?.score ?? null;
  const delta = previousValue === null || nextValue === null ? null : round(nextValue - previousValue);
  const dimensionsChanged = JSON.stringify(canonical(previous?.dimensions ?? {})) !== JSON.stringify(canonical(next?.dimensions ?? {}));
  const changed = previousValue !== nextValue || previous?.scope_version !== next?.scope_version || dimensionsChanged;
  if (!changed) return undefined;
  const affectedItemIds = [...new Set(cause.entity_ids ?? cause.affected_item_ids ?? [])].sort();
  const causeType = cause.type ?? "recalculated";
  const scopeReset = previous?.scope_version !== next?.scope_version;
  const explanation = scopeReset
    ? `Scope changed from ${previous?.scope_version ?? "unknown"} to ${next?.scope_version ?? "unknown"}; a scope-coverage blocker was opened and prior readiness must be revalidated.`
    : previousValue === null || nextValue === null
      ? `Readiness changed availability after ${causeType}; one or more required dimensions became evaluated or N/A.`
      : delta === 0
        ? `A readiness component changed after ${causeType}, while the headline score remained unchanged.`
        : `Readiness changed by ${delta >= 0 ? "+" : ""}${delta} after ${causeType}.`;
  return {
    event_id: `score-${next?.ledger_revision ?? "unknown"}-${hash({ causeType, previousValue, nextValue, affectedItemIds }).slice(0, 12)}`,
    type: "score_changed",
    occurred_at: cause.occurred_at ?? null,
    entity_ids: affectedItemIds,
    payload: {
      policy_version: `${next?.policy?.id ?? "unknown"}/v${next?.policy?.version ?? "unknown"}`,
      rule_id: scopeReset ? "scope-rebaseline" : "impact-and-component-weighted-readiness",
      previous_value: previousValue,
      next_value: nextValue,
      delta,
      affected_item_ids: affectedItemIds,
      explanation,
    },
  };
}

/**
 * Project the ledger into stable nodes and semantic edges. Layout is left to
 * the UI; callers must not treat visual proximity as causal proof.
 */
export function projectGraph(ledgerInput, readinessInput = undefined) {
  const ledger = normalizeLedger(ledgerInput);
  const readiness = readinessInput ?? computeReadiness(ledger);
  const nodes = [];
  const edges = [];
  const decisionNodeId = `decision:${ledger.decision_id}`;
  nodes.push({ id: decisionNodeId, type: "decision", label: ledger.seed.objective, scope_version: ledger.scope.version });
  for (const question of ledger.questions) {
    const id = `question:${question.id}`;
    nodes.push({ id, type: "question", label: question.prompt });
    edges.push({ id: `edge:${decisionNodeId}:asks:${id}`, from: decisionNodeId, to: id, type: "asks" });
  }
  for (const item of ledger.items) {
    const id = `item:${item.id}`;
    nodes.push({ id, type: item.component, label: item.label, status: item.status, impact: item.impact, source: item.source ?? "unspecified", inference_flagged: item.inference_flagged === true });
    edges.push({ id: `edge:${decisionNodeId}:tracks:${id}`, from: decisionNodeId, to: id, type: "tracks" });
    if (item.related_question_id) {
      const questionId = `question:${item.related_question_id}`;
      const edgeType = item.component === COMPONENTS.blocker ? "blocks" : item.component === COMPONENTS.contradiction ? "contradicts" : item.component === COMPONENTS.assumption ? "assumes" : "supports";
      edges.push({ id: `edge:${id}:${edgeType}:${questionId}`, from: id, to: questionId, type: edgeType });
    }
  }
  for (const event of ledger.events) {
    const eventId = `event:${event.event_id}`;
    nodes.push({ id: eventId, type: "event", label: event.type, occurred_at: event.occurred_at });
    for (const entityId of event.entity_ids ?? []) {
      const item = ledger.items.find((entry) => entry.id === entityId);
      if (!item) continue;
      const target = `item:${item.id}`;
      const edgeType = event.type.includes("reopen") ? "reopens" : event.type.includes("resolve") ? "resolves" : event.type.includes("flag") ? "flags" : "affects";
      edges.push({ id: `edge:${eventId}:${edgeType}:${target}`, from: eventId, to: target, type: edgeType });
    }
    if (event.type === "pack_advanced") {
      for (const questionId of event.payload?.question_ids ?? []) {
        const target = `question:${String(questionId).replace(/^q:/, "")}`;
        if (nodes.some((node) => node.id === target)) {
          edges.push({ id: `edge:${eventId}:introduces:${target}`, from: eventId, to: target, type: "introduces" });
        }
      }
    }
    if (event.type === "pack_completed" && Array.isArray(event.payload?.responses)) {
      for (const response of event.payload.responses) {
        if (!isPlainObject(response) || typeof response.question_id !== "string") continue;
        const normalizedQuestionId = response.question_id.replace(/^q:/, "");
        const questionNodeId = `question:${normalizedQuestionId}`;
        if (!nodes.some((node) => node.id === questionNodeId)) continue;
        const answerNodeId = `answer:${event.event_id}:${normalizedQuestionId}`;
        const resolution = typeof response.resolution === "string" ? response.resolution : "answer";
        nodes.push({ id: answerNodeId, type: "answer", label: resolution, question_id: normalizedQuestionId, resolution });
        edges.push({ id: `edge:${eventId}:records:${answerNodeId}`, from: eventId, to: answerNodeId, type: "records" });
        edges.push({ id: `edge:${answerNodeId}:answers:${questionNodeId}`, from: answerNodeId, to: questionNodeId, type: "answers" });
      }
    }
  }
  const scoreNodeId = `score:${ledger.revision}:${readiness.policy?.hash?.slice(0, 12) ?? "none"}`;
  nodes.push({ id: scoreNodeId, type: "score", label: readiness.label ?? "Decision Readiness", value: readiness.score, unresolved_burden: readiness.unresolved_burden, policy: readiness.policy });
  edges.push({ id: `edge:${decisionNodeId}:scored_as:${scoreNodeId}`, from: decisionNodeId, to: scoreNodeId, type: "scored_as" });
  for (const itemId of readiness.open_item_ids ?? []) {
    const itemNodeId = `item:${itemId}`;
    if (nodes.some((node) => node.id === itemNodeId)) edges.push({ id: `edge:${itemNodeId}:affects_score:${scoreNodeId}`, from: itemNodeId, to: scoreNodeId, type: "affects_score" });
  }
  nodes.sort((left, right) => left.id.localeCompare(right.id));
  edges.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schema_version: "decision-graph-projection/v1",
    ledger_revision: ledger.revision,
    scope_version: ledger.scope.version,
    policy_hash: readiness.policy?.hash ?? null,
    nodes,
    edges,
  };
}
