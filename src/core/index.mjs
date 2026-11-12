import { createHash } from "node:crypto";
import {
  COMPONENTS,
  COMPONENT_ALIASES,
  COMPONENT_STATUS_CREDIT,
  DEFAULT_STATUS,
} from "./decision-semantics.mjs";

export {
  DECISION_SEMANTICS_VERSION,
  DECISION_SEMANTICS_V1,
} from "./decision-semantics.mjs";

export const LEDGER_SCHEMA_VERSION = "decision-graph-ledger/v1";
export const SEED_SCHEMA_VERSION = "decision-graph-seed/v1";

const IMPACT_ALIASES = Object.freeze({ low: 1, medium: 3, high: 5, critical: 5 });

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
  if (typeof value === "string") {
    const alias = value.trim().toLowerCase();
    if (Object.hasOwn(IMPACT_ALIASES, alias)) return IMPACT_ALIASES[alias];
  }
  throw new Error(`${field} must be an integer from 1 to 5 or low, medium, high, or critical`);
}

function normalizeComponent(value, field) {
  const key = nonEmptyString(value, field).toLowerCase();
  if (!Object.hasOwn(COMPONENT_ALIASES, key)) throw new Error(`${field} must name evidence, blocker, assumption, contradiction, or candidate`);
  return COMPONENT_ALIASES[key];
}

function normalizeMaterialItem(item, index, questionIds, allowLegacyCandidateId = false) {
  if (!isPlainObject(item)) throw new Error(`seed.material_items[${index}] must be an object`);
  const component = normalizeComponent(item.component ?? item.kind, `seed.material_items[${index}].kind`);
  const id = safeIdentifier(item.id, `seed.material_items[${index}].id`);
  const statuses = COMPONENT_STATUS_CREDIT[component];
  const status = (item.status ?? DEFAULT_STATUS[component]).toString().trim().toLowerCase();
  if (!Object.hasOwn(statuses, status)) {
    throw new Error(`seed.material_items[${index}].status is not valid for ${component}`);
  }
  let relatedQuestionId = optionalString(item.related_question_id ?? item.question_id, `seed.material_items[${index}].related_question_id`);
  if (relatedQuestionId) {
    const prefixedQuestionId = relatedQuestionId.replace(/^q:/, "");
    relatedQuestionId = questionIds.has(relatedQuestionId)
      ? relatedQuestionId
      : questionIds.has(prefixedQuestionId)
        ? prefixedQuestionId
        : undefined;
    if (!relatedQuestionId) throw new Error(`seed.material_items[${index}].related_question_id does not name a question`);
  }
  const candidateId = optionalString(item.candidate_id, `seed.material_items[${index}].candidate_id`);
  const normalized = {
    id,
    component,
    label: nonEmptyString(item.label, `seed.material_items[${index}].label`),
    impact: normalizeImpact(item.impact, `seed.material_items[${index}].impact`),
    status,
    evidence_grade: optionalString(item.evidence_grade, `seed.material_items[${index}].evidence_grade`),
    source: optionalString(item.source, `seed.material_items[${index}].source`),
    related_question_id: relatedQuestionId,
    candidate_id: candidateId === undefined || allowLegacyCandidateId
      ? candidateId
      : safeIdentifier(candidateId, `seed.material_items[${index}].candidate_id`),
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
  const schemaVersion = input.schema_version ?? SEED_SCHEMA_VERSION;
  if (schemaVersion !== SEED_SCHEMA_VERSION) throw new Error("seed has an invalid schema version");
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
    schema_version: schemaVersion,
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

const COMPLETED_RESPONSE_RESOLUTIONS = new Set(["answer", "defer", "not_applicable", "withdrawn"]);

function assertStoredIdentifier(value, field) {
  const normalized = safeIdentifier(value, field);
  if (normalized !== value) throw new Error(field + " must already be normalized");
  return normalized;
}

function normalizeCompletedResponses(value, questions, field, allowLegacy = false) {
  if (!Array.isArray(value)) throw new Error(field + " must be an array");
  if (value.length === 0) throw new Error(field + " must contain at least one response");
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set();
  const normalizedResponses = [];
  for (const [index, response] of value.entries()) {
    const responseField = field + "[" + index + "]";
    if (!isPlainObject(response)) throw new Error(responseField + " must be an object");
    const rawQuestionId = safeIdentifier(response.question_id, responseField + ".question_id");
    const prefixedQuestionId = rawQuestionId.replace(/^q:/, "");
    const questionId = questionById.has(prefixedQuestionId)
      ? prefixedQuestionId
      : questionById.has(rawQuestionId)
        ? rawQuestionId
        : undefined;
    if (!questionId || seen.has(questionId)) {
      throw new Error(responseField + " refers to an unknown or duplicate question");
    }
    seen.add(questionId);
    const question = questionById.get(questionId);
    const rawResolution = response.resolution === undefined && allowLegacy
      ? "answer"
      : nonEmptyString(response.resolution, responseField + ".resolution");
    const resolution = rawResolution === "withdraw" ? "withdrawn" : rawResolution;
    if (!COMPLETED_RESPONSE_RESOLUTIONS.has(resolution)) {
      throw new Error(responseField + ".resolution is unsupported");
    }
    if (resolution === "answer") {
      if (!isPlainObject(response.answer)) throw new Error(responseField + ".answer is required");
      const answer = {};
      const optionId = optionalString(response.answer.option_id, responseField + ".answer.option_id");
      const optionIdsInput = response.answer.option_ids;
      let optionIds;
      if (optionIdsInput !== undefined && optionIdsInput !== null) {
        if (!Array.isArray(optionIdsInput)) throw new Error(responseField + ".answer.option_ids must be an array when provided");
        optionIds = optionIdsInput.map((value, optionIndex) => safeIdentifier(value, responseField + ".answer.option_ids[" + optionIndex + "]"));
        if (new Set(optionIds).size !== optionIds.length) throw new Error(responseField + ".answer.option_ids must not contain duplicates");
      }
      const availableOptions = new Set((question.options ?? []).map((option) => option.id));
      if ((question.selection_mode ?? "single") === "multiple") {
        if (optionId) throw new Error(responseField + ".answer.option_id is only supported for single-select questions");
        for (const selected of optionIds ?? []) {
          if (!availableOptions.has(selected)) throw new Error(responseField + ".answer.option_ids contains an option that is not valid for this question");
        }
        if (optionIds?.length) answer.option_ids = optionIds;
      } else {
        if (optionIds !== undefined) throw new Error(responseField + ".answer.option_ids is only supported for multiple-select questions");
        if (optionId && !availableOptions.has(optionId)) throw new Error(responseField + ".answer.option_id is not an option for this question");
        if (optionId) answer.option_id = optionId;
      }
      const otherText = optionalString(response.answer.other_text, responseField + ".answer.other_text");
      if (otherText) {
        if (question.allow_other !== true) throw new Error(responseField + ".answer.other_text is not allowed for this question");
        answer.other_text = otherText;
      }
      const answerText = optionalString(response.answer.text, responseField + ".answer.text");
      if (answerText) answer.text = answerText;
      if (Object.keys(answer).length === 0) {
        throw new Error(responseField + ".answer must include an option or text");
      }
      normalizedResponses.push({ question_id: "q:" + questionId, resolution, answer });
      continue;
    }
    const detailKey = resolution === "defer"
      ? "deferral"
      : resolution === "not_applicable"
        ? "not_applicable"
        : "withdrawal";
    if (!isPlainObject(response[detailKey])) {
      if (allowLegacy) {
        normalizedResponses.push({ question_id: "q:" + questionId, resolution });
        continue;
      }
      throw new Error(responseField + "." + detailKey + " is required when resolution is " + resolution);
    }
    if (allowLegacy && (response[detailKey].reason === undefined || response[detailKey].reason === "")) {
      normalizedResponses.push({ question_id: "q:" + questionId, resolution, [detailKey]: {} });
      continue;
    }
    const reason = nonEmptyString(response[detailKey].reason, responseField + "." + detailKey + ".reason");
    const detail = { reason };
    if (resolution === "defer") {
      const clue = optionalString(response[detailKey].clue, responseField + ".deferral.clue");
      if (clue) detail.clue = clue;
    }
    normalizedResponses.push({ question_id: "q:" + questionId, resolution, [detailKey]: detail });
  }
  return normalizedResponses;
}

function normalizeLedger(ledger) {
  if (!isPlainObject(ledger) || ledger.schema_version !== LEDGER_SCHEMA_VERSION) {
    throw new Error("ledger has an invalid schema version");
  }
  if (!Number.isInteger(ledger.revision) || ledger.revision < 0) throw new Error("ledger revision must be a non-negative integer");
  if (!Array.isArray(ledger.items) || !Array.isArray(ledger.events) || !Array.isArray(ledger.questions)) {
    throw new Error("ledger is missing canonical arrays");
  }
  assertStoredIdentifier(ledger.decision_id, "ledger.decision_id");
  if (!isPlainObject(ledger.seed)) throw new Error("ledger.seed must be an object");
  if (ledger.seed.schema_version !== SEED_SCHEMA_VERSION) throw new Error("ledger.seed has an invalid schema version");
  const seedObjective = nonEmptyString(ledger.seed.objective, "ledger.seed.objective");
  if (seedObjective !== ledger.seed.objective) throw new Error("ledger.seed.objective must already be normalized");
  const seedScope = optionalString(ledger.seed.scope, "ledger.seed.scope");
  if (seedScope !== ledger.seed.scope) throw new Error("ledger.seed.scope must already be normalized");
  const seedQuestionsInput = optionalArray(ledger.seed.questions, "ledger.seed.questions");
  if (seedQuestionsInput.length === 0 || seedQuestionsInput.length > 12) {
    throw new Error("ledger.seed.questions must contain from 1 to 12 questions");
  }
  const seedQuestionIds = new Set();
  const seedQuestions = seedQuestionsInput.map((question, index) => {
    const normalized = normalizeQuestion(question, index, seedQuestionIds);
    if (JSON.stringify(canonical(normalized)) !== JSON.stringify(canonical(question))) {
      throw new Error("ledger.seed.questions[" + index + "] must already be normalized");
    }
    return normalized;
  });
  const expectedDecisionId = `decision-${hash({ objective: seedObjective, scope: seedScope, questions: seedQuestions.map((question) => question.id) }).slice(0, 20)}`;
  if (ledger.decision_id !== expectedDecisionId) throw new Error("ledger.decision_id does not match the embedded seed identity");
  if (!isPlainObject(ledger.scope)) throw new Error("ledger.scope must be an object");
  nonEmptyString(ledger.scope.label, "ledger.scope.label");
  nonEmptyString(ledger.scope.version, "ledger.scope.version");

  const questionIds = new Set();
  for (const [index, question] of ledger.questions.entries()) {
    const normalized = normalizeQuestion(question, index, questionIds);
    if (JSON.stringify(canonical(normalized)) !== JSON.stringify(canonical(question))) {
      throw new Error("ledger.questions[" + index + "] must already be normalized");
    }
  }
  for (const seedQuestion of seedQuestions) {
    const ledgerQuestion = ledger.questions.find((question) => question.id === seedQuestion.id);
    if (!ledgerQuestion || JSON.stringify(canonical(ledgerQuestion)) !== JSON.stringify(canonical(seedQuestion))) {
      throw new Error("ledger.seed question does not match the canonical ledger question: " + seedQuestion.id);
    }
  }

  const itemIds = new Set();
  for (const [index, item] of ledger.items.entries()) {
    if (!isPlainObject(item) || !Object.values(COMPONENTS).includes(item.component)) {
      throw new Error("ledger.items[" + index + "] has an invalid material item component");
    }
    const itemId = assertStoredIdentifier(item.id, "ledger.items[" + index + "].id");
    if (itemIds.has(itemId)) throw new Error("ledger.items contains duplicate id: " + itemId);
    itemIds.add(itemId);
    const normalized = normalizeMaterialItem(item, index, questionIds, true);
    if (normalized.component !== item.component || normalized.status !== item.status || normalized.impact !== item.impact) {
      throw new Error("ledger.items[" + index + "] is not canonical");
    }
    if (normalized.related_question_id !== item.related_question_id) {
      throw new Error("ledger.items[" + index + "].related_question_id must already be normalized");
    }
    if (item.candidate_id !== undefined) {
      const candidateId = nonEmptyString(item.candidate_id, "ledger.items[" + index + "].candidate_id");
      if (candidateId !== item.candidate_id) throw new Error("ledger.items[" + index + "].candidate_id must already be normalized");
    }
  }

  const eventIds = new Set();
  for (const [index, event] of ledger.events.entries()) {
    if (!isPlainObject(event)) throw new Error("ledger.events[" + index + "] must be an object");
    const eventId = assertStoredIdentifier(event.event_id, "ledger.events[" + index + "].event_id");
    if (eventIds.has(eventId)) throw new Error("ledger.events contains duplicate event_id: " + eventId);
    eventIds.add(eventId);
    assertStoredIdentifier(event.type, "ledger.events[" + index + "].type");
    if (!Array.isArray(event.entity_ids)) throw new Error("ledger.events[" + index + "].entity_ids must be an array");
    const entityIds = new Set();
    for (const [entityIndex, entityId] of event.entity_ids.entries()) {
      const normalized = assertStoredIdentifier(entityId, "ledger.events[" + index + "].entity_ids[" + entityIndex + "]");
      if (entityIds.has(normalized)) throw new Error("ledger.events[" + index + "].entity_ids must not contain duplicates");
      entityIds.add(normalized);
    }
    if (!isPlainObject(event.payload)) throw new Error("ledger.events[" + index + "].payload must be an object");
    if (event.type === "pack_completed") {
      normalizeCompletedResponses(event.payload.responses, ledger.questions, "ledger.events[" + index + "].payload.responses", true);
    }
    if (["item_created", "material_item_added", "item_updated", "item_reopened", "item_resolved", "inference_flagged"].includes(event.type)) {
      const payloadItemId = event.type === "item_created" || event.type === "material_item_added"
        ? event.payload.item?.id ?? event.payload.material_item?.id
        : event.payload.item_id;
      const targetId = safeIdentifier(payloadItemId ?? event.entity_ids[0], "ledger.events[" + index + "] target item id");
      const targetItem = ledger.items.find((item) => item.id === targetId);
      if (!targetItem) throw new Error("ledger.events[" + index + "] refers to an unknown material item: " + targetId);
      if (event.type === "item_reopened" && !Object.hasOwn(COMPONENT_STATUS_CREDIT[targetItem.component], "reopened")) {
        throw new Error("item_reopened is not supported for " + targetItem.component);
      }
      if (event.type === "item_resolved" && !Object.hasOwn(COMPONENT_STATUS_CREDIT[targetItem.component], "resolved")) {
        throw new Error("item_resolved is not supported for " + targetItem.component);
      }
    }
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
  if (incomingQuestions.length === 0) throw new Error("pack_advanced payload.questions must contain at least one question");
  if (incomingQuestions.length > 12) throw new Error("pack_advanced payload.questions must contain no more than 12 questions");
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
  if (event.type === "ledger_created" || event.type === "score_changed") {
    throw new Error(event.type + " is generated internally and cannot be appended by a caller");
  }
  if (previous.events.some((entry) => entry.event_id === event.event_id)) {
    throw new Error("event creates duplicate event_id: " + event.event_id);
  }
  let items = clone(previous.items);
  let scope = clone(previous.scope);
  let questions = clone(previous.questions);
  let questionIds = new Set(questions.map((question) => question.id));

  if (event.type === "pack_completed") {
    event.payload.responses = normalizeCompletedResponses(event.payload.responses, questions, "event.payload.responses");
    const answeredQuestionIds = new Set(event.payload.responses.map((response) => response.question_id.replace(/^q:/, "")));
    event.entity_ids = items
      .filter((item) => item.related_question_id && answeredQuestionIds.has(item.related_question_id))
      .map((item) => item.id)
      .sort();
  }

  if (event.type === "item_created" || event.type === "material_item_added") {
    const item = normalizeMaterialItem(itemForEvent(event), items.length, questionIds);
    if (items.some((entry) => entry.id === item.id)) throw new Error(`event creates duplicate material item: ${item.id}`);
    items.push(item);
    event.payload.item = clone(item);
    delete event.payload.material_item;
    event.entity_ids = [item.id];
  } else if (event.type === "item_updated") {
    const itemId = safeIdentifier(event.payload.item_id ?? event.entity_ids[0], "event.payload.item_id");
    const patch = event.payload.patch;
    if (!isPlainObject(patch)) throw new Error("item_updated requires payload.patch");
    for (const immutableField of ["id", "kind", "component", "inference_flagged"]) {
      if (Object.hasOwn(patch, immutableField)) {
        throw new Error(`item_updated cannot change ${immutableField}`);
      }
    }
    items = replaceItem(items, itemId, (current) => {
      const normalized = normalizeMaterialItem({ ...current, ...patch, id: current.id, kind: current.component }, 0, questionIds);
      return current.inference_flagged === true ? { ...normalized, inference_flagged: true } : normalized;
    });
    event.payload.item_id = itemId;
    event.entity_ids = [itemId];
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
    event.payload.item_id = itemId;
    event.entity_ids = [itemId];
  } else if (event.type === "scope_changed") {
    const version = optionalString(event.payload.scope_version, "event.payload.scope_version");
    if (!version) throw new Error("scope_changed requires payload.scope_version");
    if (version === previous.scope.version) throw new Error("scope_changed requires a new scope_version");
    const priorScopeVersions = new Set([
      previous.seed.scope_version,
      ...previous.events
        .filter((entry) => entry.type === "scope_changed")
        .map((entry) => entry.payload.scope_version),
    ].filter((entry) => typeof entry === "string").map((entry) => entry.trim()));
    if (priorScopeVersions.has(version)) throw new Error("scope_changed cannot reuse a prior scope_version");
    const scopeLabel = optionalString(event.payload.scope, "event.payload.scope") ?? scope.label;
    scope = { label: scopeLabel, version };
    event.payload.scope = scopeLabel;
    event.payload.scope_version = version;
    // A material scope revision makes prior coverage incomplete until it is
    // reviewed again. Record that explicitly as a visible blocker instead of
    // silently carrying the former score into a new decision boundary.
    const baseCoverageId = `scope-coverage-${hash({ label: scope.label, version: scope.version }).slice(0, 12)}`;
    let coverageId = baseCoverageId;
    let coverageSuffix = 2;
    while (items.some((item) => item.id === coverageId)) {
      coverageId = `${baseCoverageId}-${coverageSuffix}`;
      coverageSuffix += 1;
    }
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
    event.payload.scope_coverage_item_id = coverageId;
    event.entity_ids = [coverageId];
  } else if (event.type === "pack_advanced") {
    const registration = registerQuestions(questions, event.payload.questions);
    questions = registration.questions;
    questionIds = new Set(questions.map((question) => question.id));
    event.payload.questions = registration.normalized;
    event.payload.question_ids = registration.normalized.map((question) => question.id);
    event.payload.introduced_question_ids = registration.additions.map((question) => question.id);
    event.entity_ids = [];
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
  if (scoreEvent) {
    const baseEventId = scoreEvent.event_id;
    let suffix = 2;
    while (updated.events.some((entry) => entry.event_id === scoreEvent.event_id)) {
      scoreEvent.event_id = `${baseEventId}-${suffix}`;
      suffix += 1;
    }
    updated.events.push(scoreEvent);
  }
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
  const suppliedCredits = policy.status_credit;
  if (suppliedCredits !== undefined && !isPlainObject(suppliedCredits)) {
    throw new Error("policy.status_credit must be an object when provided");
  }
  for (const component of Object.keys(suppliedCredits ?? {})) {
    if (!Object.hasOwn(COMPONENT_STATUS_CREDIT, component)) {
      throw new Error("policy.status_credit names an unknown component: " + component);
    }
  }
  const statusCredit = {};
  for (const [component, defaults] of Object.entries(COMPONENT_STATUS_CREDIT)) {
    const overrides = suppliedCredits?.[component];
    if (overrides !== undefined && !isPlainObject(overrides)) {
      throw new Error("policy.status_credit." + component + " must be an object when provided");
    }
    for (const status of Object.keys(overrides ?? {})) {
      if (!Object.hasOwn(defaults, status)) {
        throw new Error("policy.status_credit." + component + " names an unknown status: " + status);
      }
    }
    const credits = { ...defaults, ...(overrides ?? {}) };
    for (const [status, credit] of Object.entries(credits)) {
      if (typeof credit !== "number" || !Number.isFinite(credit) || credit < 0 || credit > 1) {
        throw new Error("policy.status_credit." + component + "." + status + " must be a finite number from 0 to 1");
      }
    }
    statusCredit[component] = credits;
  }
  return {
    id: optionalString(policy.id, "policy.id") ?? DEFAULT_SCORING_POLICY.id,
    version: optionalString(policy.version, "policy.version") ?? DEFAULT_SCORING_POLICY.version,
    label: optionalString(policy.label, "policy.label") ?? DEFAULT_SCORING_POLICY.label,
    readiness_weights: weights,
    status_credit: statusCredit,
  };
}

function normalizeLegacyPolicy(policyInput) {
  const normalized = normalizePolicy(policyInput);
  return {
    ...normalized,
    status_credit: policyInput?.status_credit ?? DEFAULT_SCORING_POLICY.status_credit,
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
function computeReadinessFromNormalized(ledger, policy, includePolicyDefinition = true) {
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
    policy: {
      id: policy.id,
      version: policy.version,
      hash: policyHash,
      ...(includePolicyDefinition
        ? {
            definition: {
              label: policy.label,
              readiness_weights: clone(policy.readiness_weights),
              status_credit: clone(policy.status_credit),
            },
          }
        : {}),
    },
    ledger_revision: ledger.revision,
    scope_version: ledger.scope.version,
    dimensions,
    open_item_ids: [...new Set(open)].sort(),
    rationale,
  };
}

export function computeReadiness(ledgerInput, policyInput = DEFAULT_SCORING_POLICY) {
  return computeReadinessFromNormalized(normalizeLedger(ledgerInput), normalizePolicy(policyInput));
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
      policy_hash: next?.policy?.hash ?? null,
      ...(isPlainObject(next?.policy?.definition)
        ? { policy_definition: clone(next.policy.definition) }
        : {}),
      rule_id: scopeReset ? "scope-rebaseline" : "impact-and-component-weighted-readiness",
      previous_value: previousValue,
      next_value: nextValue,
      delta,
      affected_item_ids: affectedItemIds,
      explanation,
    },
  };
}

function graphEdgeId(from, type, to) {
  return `edge:${encodeURIComponent(from)}:${encodeURIComponent(type)}:${encodeURIComponent(to)}`;
}

function graphAnswerNodeId(eventId, questionId) {
  return `answer:${encodeURIComponent(eventId)}:${encodeURIComponent(questionId)}`;
}

function storedItemId(value, ledger) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return ledger.items.some((item) => item.id === normalized) ? normalized : undefined;
}

function projectedEventEntityIds(event, ledger) {
  if (event.type === "item_created" || event.type === "material_item_added") {
    const payloadId = event.payload?.item?.id ?? event.payload?.material_item?.id;
    return [storedItemId(payloadId, ledger) ?? event.entity_ids?.find((id) => storedItemId(id, ledger))].filter(Boolean);
  }
  if (["item_updated", "item_reopened", "item_resolved", "inference_flagged"].includes(event.type)) {
    return [storedItemId(event.payload?.item_id, ledger) ?? event.entity_ids?.find((id) => storedItemId(id, ledger))].filter(Boolean);
  }
  if (event.type === "scope_changed") {
    return [storedItemId(event.payload?.scope_coverage_item_id, ledger) ?? event.entity_ids?.find((id) => storedItemId(id, ledger))].filter(Boolean);
  }
  if (event.type === "pack_completed") return event.entity_ids ?? [];
  if (event.type === "pack_advanced" || event.type === "ledger_created") return [];
  return event.entity_ids ?? [];
}

function resolveLedgerQuestionId(value, ledger) {
  if (typeof value !== "string") return undefined;
  const rawQuestionId = value.trim();
  const prefixedQuestionId = rawQuestionId.replace(/^q:/, "");
  if (ledger.questions.some((question) => question.id === rawQuestionId)) return rawQuestionId;
  if (ledger.questions.some((question) => question.id === prefixedQuestionId)) return prefixedQuestionId;
  return undefined;
}

function introducedQuestionsByEvent(ledger) {
  const initialQuestionIds = Array.isArray(ledger.seed.questions)
    ? ledger.seed.questions.map((question) => question?.id).filter((id) => typeof id === "string")
    : [];
  const seen = new Set(initialQuestionIds);
  const introducedByEvent = new Map();
  for (const event of ledger.events) {
    if (event.type !== "pack_advanced") continue;
    const questionIds = Array.isArray(event.payload?.question_ids)
      ? event.payload.question_ids
      : Array.isArray(event.payload?.questions)
        ? event.payload.questions.map((question) => question?.id)
        : Array.isArray(event.payload?.introduced_question_ids)
          ? event.payload.introduced_question_ids
          : [];
    const canonicalQuestionIds = questionIds
      .map((questionId) => resolveLedgerQuestionId(questionId, ledger))
      .filter(Boolean);
    const requestedIntroductions = Array.isArray(event.payload?.introduced_question_ids)
      ? event.payload.introduced_question_ids
          .map((questionId) => resolveLedgerQuestionId(questionId, ledger))
          .filter(Boolean)
      : canonicalQuestionIds;
    introducedByEvent.set(event.event_id, [...new Set(requestedIntroductions.filter((questionId) => !seen.has(questionId)))]);
    for (const questionId of canonicalQuestionIds) seen.add(questionId);
  }
  return introducedByEvent;
}

/**
 * Project the ledger into stable nodes and semantic edges. Layout is left to
 * the UI; callers must not treat visual proximity as causal proof.
 */
export function projectGraph(ledgerInput, readinessInput = undefined, legacyPolicyInput = undefined) {
  const ledger = normalizeLedger(ledgerInput);
  let readiness;
  if (readinessInput === undefined) {
    readiness = computeReadiness(ledger);
  } else {
    const definition = readinessInput?.policy?.definition;
    let comparableReadiness;
    if (isPlainObject(definition)) {
      const receiptPolicy = {
          id: readinessInput.policy.id,
          version: readinessInput.policy.version,
          label: definition.label,
          readiness_weights: definition.readiness_weights,
          status_credit: definition.status_credit,
        };
      readiness = computeReadiness(ledger, receiptPolicy);
      comparableReadiness = readiness;
    } else if (legacyPolicyInput !== undefined) {
      readiness = computeReadinessFromNormalized(ledger, normalizeLegacyPolicy(legacyPolicyInput), false);
      comparableReadiness = readiness;
    } else {
      readiness = computeReadiness(ledger);
      comparableReadiness = clone(readiness);
      delete comparableReadiness.policy.definition;
    }
    if (JSON.stringify(canonical(readinessInput)) !== JSON.stringify(canonical(comparableReadiness))) {
      throw new Error("readiness snapshot does not match the canonical ledger and scoring policy receipt");
    }
  }
  const nodes = [];
  const edges = [];
  const introducedByEvent = introducedQuestionsByEvent(ledger);
  const decisionNodeId = `decision:${ledger.decision_id}`;
  nodes.push({ id: decisionNodeId, type: "decision", label: ledger.seed.objective, scope_version: ledger.scope.version });
  for (const question of ledger.questions) {
    const id = `question:${question.id}`;
    nodes.push({ id, type: "question", label: question.prompt });
    edges.push({ id: graphEdgeId(decisionNodeId, "asks", id), from: decisionNodeId, to: id, type: "asks" });
  }
  for (const item of ledger.items) {
    const id = `item:${item.id}`;
    nodes.push({
      id,
      type: item.component,
      label: item.label,
      status: item.status,
      impact: item.impact,
      ...(item.source === undefined ? {} : { source: item.source }),
      inference_flagged: item.inference_flagged === true,
    });
    edges.push({ id: graphEdgeId(decisionNodeId, "tracks", id), from: decisionNodeId, to: id, type: "tracks" });
    if (item.related_question_id) {
      const questionId = `question:${item.related_question_id}`;
      const edgeType = item.component === COMPONENTS.blocker ? "blocks" : item.component === COMPONENTS.contradiction ? "contradicts" : item.component === COMPONENTS.assumption ? "assumes" : "supports";
      edges.push({ id: graphEdgeId(id, edgeType, questionId), from: id, to: questionId, type: edgeType });
    }
  }
  for (const event of ledger.events) {
    const eventId = `event:${event.event_id}`;
    nodes.push({ id: eventId, type: "event", label: event.type, occurred_at: event.occurred_at });
    const completedResponses = event.type === "pack_completed"
      ? normalizeCompletedResponses(
          event.payload.responses,
          ledger.questions,
          "event " + event.event_id + " responses",
          true,
        )
      : [];
    for (const entityId of projectedEventEntityIds(event, ledger)) {
      const item = ledger.items.find((entry) => entry.id === entityId);
      if (!item) continue;
      const target = `item:${item.id}`;
      const edgeType = event.type === "item_reopened"
        ? "reopens"
        : event.type === "item_resolved"
          ? "resolves"
          : event.type === "inference_flagged"
            ? "flags"
            : "affects";
      edges.push({ id: graphEdgeId(eventId, edgeType, target), from: eventId, to: target, type: edgeType });
    }
    if (event.type === "pack_advanced") {
      for (const canonicalQuestionId of introducedByEvent.get(event.event_id) ?? []) {
        const target = `question:${canonicalQuestionId}`;
        if (nodes.some((node) => node.id === target)) {
          edges.push({ id: graphEdgeId(eventId, "introduces", target), from: eventId, to: target, type: "introduces" });
        }
      }
    }
    if (event.type === "pack_completed" && Array.isArray(event.payload?.responses)) {
      for (const response of completedResponses) {
        const normalizedQuestionId = response.question_id.replace(/^q:/, "");
        const questionNodeId = `question:${normalizedQuestionId}`;
        if (!nodes.some((node) => node.id === questionNodeId)) continue;
        const answerNodeId = graphAnswerNodeId(event.event_id, normalizedQuestionId);
        const rawResolution = typeof response.resolution === "string" ? response.resolution : "answer";
        const resolution = rawResolution === "withdraw" ? "withdrawn" : rawResolution;
        const resolutionDetail = resolution === "defer"
          ? response.deferral
          : resolution === "not_applicable"
            ? response.not_applicable
            : resolution === "withdrawn"
              ? response.withdrawal
              : undefined;
        const reason = isPlainObject(resolutionDetail) && typeof resolutionDetail.reason === "string"
          ? resolutionDetail.reason
          : undefined;
        const reentryClue = resolution === "defer" && isPlainObject(resolutionDetail) && typeof resolutionDetail.clue === "string"
          ? resolutionDetail.clue
          : undefined;
        const relationType = resolution === "defer"
          ? "defers"
          : resolution === "not_applicable"
            ? "marks_not_applicable"
            : resolution === "withdrawn"
              ? "withdraws"
              : "answers";
        nodes.push({
          id: answerNodeId,
          type: "answer",
          label: resolution,
          question_id: normalizedQuestionId,
          resolution,
          ...(reason ? { reason } : {}),
          ...(reentryClue ? { reentry_clue: reentryClue } : {}),
        });
        edges.push({ id: graphEdgeId(eventId, "records", answerNodeId), from: eventId, to: answerNodeId, type: "records" });
        edges.push({ id: graphEdgeId(answerNodeId, relationType, questionNodeId), from: answerNodeId, to: questionNodeId, type: relationType });
      }
    }
  }
  const scoreNodeId = `score:${ledger.revision}:${readiness.policy?.hash?.slice(0, 12) ?? "none"}`;
  nodes.push({ id: scoreNodeId, type: "score", label: readiness.label ?? "Decision Readiness", value: readiness.score, unresolved_burden: readiness.unresolved_burden, policy: readiness.policy });
  edges.push({ id: graphEdgeId(decisionNodeId, "scored_as", scoreNodeId), from: decisionNodeId, to: scoreNodeId, type: "scored_as" });
  for (const item of ledger.items) {
    if (!Object.hasOwn(DEFAULT_SCORING_POLICY.readiness_weights, item.component)) continue;
    const itemNodeId = "item:" + item.id;
    edges.push({ id: graphEdgeId(itemNodeId, "affects_score", scoreNodeId), from: itemNodeId, to: scoreNodeId, type: "affects_score" });
  }
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) {
    throw new Error("graph projection produced duplicate node IDs");
  }
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) {
    throw new Error("graph projection produced duplicate edge IDs");
  }
  const compareIds = (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  nodes.sort(compareIds);
  edges.sort(compareIds);
  return {
    schema_version: "decision-graph-projection/v1",
    ledger_revision: ledger.revision,
    scope_version: ledger.scope.version,
    policy_hash: readiness.policy?.hash ?? null,
    nodes,
    edges,
  };
}
