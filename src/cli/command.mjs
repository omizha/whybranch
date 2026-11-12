import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeSeed,
  createLedgerFromSeed,
  appendEvent,
  computeReadiness,
  projectGraph,
} from "../core/index.mjs";
import { builtInPackIds, getBuiltInPack } from "../packs/interview.mjs";
import {
  WORKSPACE_ENV,
  LEGACY_WORKSPACE_ENV,
  archiveDirectory,
  beginRecoveryCommit,
  bestRecoveryCandidate,
  discoverExistingWorkspaceRoot,
  durableRecoveryRoot,
  ensurePrivateDirectory,
  moveWorkspaceToArchive,
  persistRecoveryReplica,
  quarantineArchivedWorkspace,
  recoveryDirectory,
  restoreArchivedWorkspace,
  sealCheckpoint,
  serializeJson,
  storageReceipt,
  verifyRecoveryReplica,
  workspaceDirectory,
  workspaceRoot,
  writeJsonAtomically,
  writeTextAtomically,
} from "./workspace-store.mjs";

const HOST = "127.0.0.1";
// Persisted format IDs remain stable across the Whybranch rename.
const WORKSPACE_SCHEMA_VERSION = "decision-graph-workspace/v1";
const UI_STATE_SCHEMA_VERSION = "decision-graph-ui-state/v1";
const MAX_BODY_BYTES = 512 * 1024;
const AUTOSAVE_DELAY_MS = 450;
const UI_STATE_SAVE_DELAY_MS = 300;
const WORKSPACE_LOCK_WAIT_MS = 5_000;
const WORKSPACE_LOCK_STALE_MS = 30_000;
const WORKSPACE_LOCK_RETRY_MS = 25;
const SELF_PATH = fileURLToPath(import.meta.url);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string when provided`);
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function reusableWorkspacePort(server, workspacePath) {
  if (!isPlainObject(server) || server.host !== HOST || !Number.isInteger(server.port)) return undefined;
  if (server.port < 1 || server.port > 65_535 || typeof server.url !== "string") return undefined;
  try {
    const url = new URL(server.url);
    if (url.protocol !== "http:" || url.hostname !== HOST || url.pathname !== workspacePath) return undefined;
    if (Number(url.port) !== server.port) return undefined;
    return server.port;
  } catch {
    return undefined;
  }
}

async function listenLoopback(server, port) {
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("error", onError);
      rejectListen(error);
    };
    server.once("error", onError);
    server.listen({ host: HOST, port }, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function createPrivateWorkspaceDirectory(root) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const workspace = `workspace-${randomUUID()}`;
    const directory = workspaceDirectory(root, workspace);
    try {
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
      return { workspace, directory };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not allocate a local workspace id");
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`${label} was not found`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${label} is not valid JSON`);
    }
    throw error;
  }
}

function canonicalResolution(value, field) {
  const normalized = requiredString(value, field);
  const resolution = normalized === "withdraw" ? "withdrawn" : normalized;
  if (!["answer", "defer", "not_applicable", "withdrawn"].includes(resolution)) {
    throw new Error(`${field} is unsupported`);
  }
  return resolution;
}

function questionIdentifier(question) {
  return `q:${question.id}`;
}

function optionIds(question) {
  return new Set((question.options ?? []).map((option) => option.id));
}

function optionalUniqueStringArray(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array when provided`);
  const seen = new Set();
  return value.map((entry, index) => {
    const result = requiredString(entry, `${field}[${index}]`);
    if (seen.has(result)) throw new Error(`${field} must not contain duplicate values`);
    seen.add(result);
    return result;
  });
}

function validateTextFields(response, index, prefix) {
  return {
    text: optionalString(response.text, `${prefix}[${index}].text`),
    otherText: optionalString(response.other_text, `${prefix}[${index}].other_text`),
    note: optionalString(response.note, `${prefix}[${index}].note`),
    clue: optionalString(response.clue, `${prefix}[${index}].clue`),
  };
}

/**
 * Validate the persisted, non-final form state. The browser always sends all
 * questions, including untouched ones, so an empty answer is valid here.
 */
export function normalizeDraft(seed, payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.responses)) {
    throw new Error("draft must include a responses array");
  }
  if (payload.responses.length > seed.questions.length) {
    throw new Error("draft contains too many responses");
  }
  const expected = new Map(seed.questions.map((question) => [questionIdentifier(question), question]));
  const seen = new Set();
  const responses = payload.responses.map((response, index) => {
    if (!isPlainObject(response)) throw new Error(`draft.responses[${index}] must be an object`);
    const questionId = requiredString(response.question_id, `draft.responses[${index}].question_id`);
    const question = expected.get(questionId);
    if (!question || seen.has(questionId)) {
      throw new Error(`draft.responses[${index}] refers to an unknown or duplicate question`);
    }
    seen.add(questionId);
    const resolution = canonicalResolution(response.resolution, `draft.responses[${index}].resolution`);
    const selection = optionalString(response.selection, `draft.responses[${index}].selection`);
    const selections = optionalUniqueStringArray(response.selections, `draft.responses[${index}].selections`);
    const fields = validateTextFields(response, index, "draft.responses");
    const availableOptions = optionIds(question);

    if ((question.selection_mode ?? "single") === "multiple") {
      if (selection) throw new Error(`draft.responses[${index}].selection is only supported for single-select questions`);
      for (const selected of selections ?? []) {
        if (selected === "__other") {
          if (question.allow_other !== true) throw new Error(`draft.responses[${index}].selections does not allow Other`);
        } else if (!availableOptions.has(selected)) {
          throw new Error(`draft.responses[${index}].selections contains an option that is not valid for this question`);
        }
      }
    } else {
      if (selections !== undefined) throw new Error(`draft.responses[${index}].selections is only supported for multiple-select questions`);
      if (selection === "__other" && question.allow_other !== true) {
        throw new Error(`draft.responses[${index}].selection does not allow Other`);
      }
      if (selection && selection !== "__other" && !availableOptions.has(selection)) {
        throw new Error(`draft.responses[${index}].selection is not an option for this question`);
      }
    }
    if (fields.otherText && question.allow_other !== true) {
      throw new Error(`draft.responses[${index}].other_text is not allowed for this question`);
    }
    return Object.fromEntries(Object.entries({
      question_id: questionId,
      resolution,
      ...(question.selection_mode === "multiple" ? { selections: selections?.length ? selections : undefined } : { selection }),
      text: fields.text,
      other_text: fields.otherText,
      note: fields.note,
      clue: fields.clue,
    }).filter(([, value]) => value !== undefined));
  });
  return { responses };
}

const UI_STATE_GRAPH_VIEWS = new Set(["focus", "overview"]);
const UI_STATE_GRAPH_FILTERS = new Set(["all", "unresolved", "score", "history"]);
const UI_STATE_COLLAPSIBLE_GRAPH_TYPES = new Set([
  "question",
  "answer",
  "event",
  "blocker",
  "assumption",
  "evidence",
  "contradiction",
  "candidate",
]);
const UI_STATE_INPUT_KEYS = new Set([
  "score_details_open",
  "graph_legend_open",
  "graph_json_open",
  "graph_view",
  "graph_filter",
  "collapsed_graph_types",
  "selected_node_id",
  "graph_viewport",
]);

function rejectUnknownKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${field} contains unsupported fields: ${unknown.join(", ")}`);
}

function requiredBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function boundedFiniteNumber(value, field, { positive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
    throw new Error(`${field} must be a bounded finite number`);
  }
  if (positive && value <= 0) throw new Error(`${field} must be greater than zero`);
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Normalize the browser-only presentation state that is durable for one exact
 * workspace/ledger revision. This state never changes the decision ledger.
 */
export function normalizeUiState(value, { graphNodeIds } = {}) {
  if (!isPlainObject(value)) throw new Error("ui_state must be an object");
  rejectUnknownKeys(value, UI_STATE_INPUT_KEYS, "ui_state");
  const graphView = requiredString(value.graph_view, "ui_state.graph_view");
  if (!UI_STATE_GRAPH_VIEWS.has(graphView)) throw new Error("ui_state.graph_view is unsupported");
  const graphFilter = requiredString(value.graph_filter, "ui_state.graph_filter");
  if (!UI_STATE_GRAPH_FILTERS.has(graphFilter)) throw new Error("ui_state.graph_filter is unsupported");
  if (!Array.isArray(value.collapsed_graph_types)) {
    throw new Error("ui_state.collapsed_graph_types must be an array");
  }
  const collapsedGraphTypes = [...new Set(value.collapsed_graph_types.map((entry, index) => {
    const type = requiredString(entry, `ui_state.collapsed_graph_types[${index}]`);
    if (!UI_STATE_COLLAPSIBLE_GRAPH_TYPES.has(type)) {
      throw new Error(`ui_state.collapsed_graph_types[${index}] is unsupported`);
    }
    return type;
  }))].sort();
  if (collapsedGraphTypes.length !== value.collapsed_graph_types.length) {
    throw new Error("ui_state.collapsed_graph_types must not contain duplicates");
  }
  let selectedNodeId = null;
  if (value.selected_node_id !== null) {
    selectedNodeId = requiredString(value.selected_node_id, "ui_state.selected_node_id");
    if (selectedNodeId.length > 512) throw new Error("ui_state.selected_node_id is too long");
    if (graphNodeIds && !graphNodeIds.has(selectedNodeId)) {
      throw new Error("ui_state.selected_node_id is not present in the current graph");
    }
  }
  let graphViewport = null;
  if (value.graph_viewport !== null) {
    if (!isPlainObject(value.graph_viewport)) throw new Error("ui_state.graph_viewport must be an object or null");
    const viewportKeys = new Set(["layout_key", "x", "y", "width", "height"]);
    rejectUnknownKeys(value.graph_viewport, viewportKeys, "ui_state.graph_viewport");
    const layoutKey = requiredString(value.graph_viewport.layout_key, "ui_state.graph_viewport.layout_key");
    if (layoutKey.length > 128 || !/^\d+(?:\.\d+)?x\d+(?:\.\d+)?$/.test(layoutKey)) {
      throw new Error("ui_state.graph_viewport.layout_key is invalid");
    }
    graphViewport = {
      layout_key: layoutKey,
      x: boundedFiniteNumber(value.graph_viewport.x, "ui_state.graph_viewport.x"),
      y: boundedFiniteNumber(value.graph_viewport.y, "ui_state.graph_viewport.y"),
      width: boundedFiniteNumber(value.graph_viewport.width, "ui_state.graph_viewport.width", { positive: true }),
      height: boundedFiniteNumber(value.graph_viewport.height, "ui_state.graph_viewport.height", { positive: true }),
    };
  }
  return {
    score_details_open: requiredBoolean(value.score_details_open, "ui_state.score_details_open"),
    graph_legend_open: requiredBoolean(value.graph_legend_open, "ui_state.graph_legend_open"),
    graph_json_open: requiredBoolean(value.graph_json_open, "ui_state.graph_json_open"),
    graph_view: graphView,
    graph_filter: graphFilter,
    collapsed_graph_types: collapsedGraphTypes,
    selected_node_id: selectedNodeId,
    graph_viewport: graphViewport,
  };
}

/**
 * Validate the final handoff. A final answer cannot be an untouched answer
 * state, but a user may explicitly defer, mark N/A, or withdraw a question.
 */
export function normalizeSubmission(seed, payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.responses)) {
    throw new Error("submission must include a responses array");
  }
  if (payload.responses.length !== seed.questions.length) {
    throw new Error("submission must include exactly one response for every question");
  }
  const expected = new Map(seed.questions.map((question) => [questionIdentifier(question), question]));
  const seen = new Set();
  const responses = payload.responses.map((response, index) => {
    if (!isPlainObject(response)) throw new Error(`responses[${index}] must be an object`);
    const questionId = requiredString(response.question_id, `responses[${index}].question_id`);
    const question = expected.get(questionId);
    if (!question || seen.has(questionId)) {
      throw new Error(`responses[${index}] refers to an unknown or duplicate question`);
    }
    seen.add(questionId);
    const resolution = canonicalResolution(response.resolution, `responses[${index}].resolution`);
    if (resolution !== "answer") {
      const sourceKey = resolution === "defer"
        ? "deferral"
        : resolution === "not_applicable"
          ? "not_applicable"
          : "withdrawal";
      const source = response[sourceKey];
      if (!isPlainObject(source)) {
        throw new Error(`responses[${index}].${sourceKey} is required when resolution is ${resolution}`);
      }
      const reason = requiredString(source.reason, `responses[${index}].${sourceKey}.reason`);
      if (resolution === "defer") {
        const clue = optionalString(source.clue, `responses[${index}].deferral.clue`);
        return { question_id: questionId, resolution, deferral: { reason, ...(clue ? { clue } : {}) } };
      }
      if (resolution === "not_applicable") {
        return { question_id: questionId, resolution, not_applicable: { reason } };
      }
      return { question_id: questionId, resolution, withdrawal: { reason } };
    }

    if (!isPlainObject(response.answer)) throw new Error(`responses[${index}].answer is required`);
    const answer = {};
    const selectedOption = optionalString(response.answer.option_id, `responses[${index}].answer.option_id`);
    const selectedOptions = optionalUniqueStringArray(response.answer.option_ids, `responses[${index}].answer.option_ids`);
    const text = optionalString(response.answer.text, `responses[${index}].answer.text`);
    const otherText = optionalString(response.answer.other_text, `responses[${index}].answer.other_text`);
    const availableOptions = optionIds(question);
    if ((question.selection_mode ?? "single") === "multiple") {
      if (selectedOption) throw new Error(`responses[${index}].answer.option_id is only supported for single-select questions`);
      for (const selected of selectedOptions ?? []) {
        if (!availableOptions.has(selected)) {
          throw new Error(`responses[${index}].answer.option_ids contains an option that is not valid for this question`);
        }
      }
      if (selectedOptions?.length) answer.option_ids = selectedOptions;
    } else {
      if (selectedOptions !== undefined) throw new Error(`responses[${index}].answer.option_ids is only supported for multiple-select questions`);
      if (selectedOption && !availableOptions.has(selectedOption)) {
        throw new Error(`responses[${index}].answer.option_id is not an option for this question`);
      }
      if (selectedOption) answer.option_id = selectedOption;
    }
    if (otherText) {
      if (question.allow_other !== true) throw new Error(`responses[${index}].answer.other_text is not allowed for this question`);
      answer.other_text = otherText;
    }
    if (text) answer.text = text;
    if (Object.keys(answer).length === 0) {
      throw new Error(`responses[${index}].answer must include an option or text`);
    }
    return { question_id: questionId, resolution, answer };
  });
  return { responses };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonForScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function isLocalHostHeader(host) {
  return typeof host === "string" && /^127\.0\.0\.1(?::\d+)?$/.test(host);
}

function requestHasJsonContentType(request) {
  const value = request.headers["content-type"];
  return typeof value === "string" && /^application\/json(?:\s*;|\s*$)/i.test(value);
}

function requestHasSameOrigin(request) {
  const origin = request.headers.origin;
  // Browser same-origin requests send this header. A missing Origin is allowed
  // for a local command-line client, but a supplied cross-origin value is not.
  if (origin === undefined) return true;
  return typeof origin === "string" && origin === `http://${request.headers.host}`;
}

function mutationRequestProblem(request) {
  if (!requestHasSameOrigin(request)) {
    return { status: 403, error: "cross-origin mutation requests are not allowed" };
  }
  if (!requestHasJsonContentType(request)) {
    return { status: 415, error: "mutation requests must use application/json" };
  }
  return undefined;
}

function publicCompletion(completion) {
  if (!completion) return undefined;
  return {
    completed_at: completion.completed_at,
    provenance_event_id: completion.provenance_event_id,
    normalized_response_patch: completion.normalized_response_patch,
    readiness: completion.readiness,
    graph: completion.graph,
  };
}

async function snapshotForLedger(ledger) {
  const readiness = await computeReadiness(ledger);
  const graph = await projectGraph(ledger, readiness);
  return { readiness, graph };
}

function completionEvent(ledger, revision, completedAt, normalizedResponsePatch) {
  const answeredQuestionIds = new Set(normalizedResponsePatch.responses.map((response) => response.question_id.replace(/^q:/, "")));
  const affectedItemIds = (ledger.items ?? [])
    .filter((item) => answeredQuestionIds.has(item.related_question_id))
    .map((item) => item.id)
    .sort();
  return {
    event_id: `pack-${randomUUID()}`,
    type: "pack_completed",
    occurred_at: completedAt,
    entity_ids: affectedItemIds,
    payload: {
      workspace_revision: revision,
      question_ids: [...answeredQuestionIds].sort(),
      responses: normalizedResponsePatch.responses,
    },
  };
}

function currentSummary(state, snapshot) {
  const latestScoreEvent = [...state.ledger.events].reverse().find((event) => event.type === "score_changed");
  return {
    workspace_id: state.workspace_id,
    url: state.url ?? undefined,
    revision: state.current.revision,
    ledger_revision: state.ledger.revision,
    phase: state.current.phase,
    objective: state.current.seed.objective,
    draft_saved_at: state.current.draft_saved_at ?? undefined,
    ui_state_saved_at: isPlainObject(state.current.ui_state)
      && state.current.ui_state.workspace_revision === state.current.revision
      && state.current.ui_state.ledger_revision === state.ledger.revision
      ? state.current.ui_state.saved_at
      : undefined,
    completed_at: state.current.completed_at ?? undefined,
    recovery_lineage: isPlainObject(state.recovery_lineage)
      ? { ...state.recovery_lineage }
      : undefined,
    storage_health: isPlainObject(state.storage_health) ? { ...state.storage_health } : undefined,
    durability_warnings: Array.isArray(state.durability_warnings)
      ? state.durability_warnings.map((warning) => ({ ...warning }))
      : [],
    // Status always projects the latest ledger. A completed handoff retains
    // its own immutable snapshot under completion, while a correction can
    // explicitly re-evaluate the workspace without pretending the old score
    // was edited by hand.
    readiness: snapshot.readiness,
    graph: snapshot.graph,
    latest_score_change: latestScoreEvent
      ? {
        event_id: latestScoreEvent.event_id,
        occurred_at: latestScoreEvent.occurred_at,
        ...latestScoreEvent.payload,
      }
      : undefined,
    material_items: state.ledger.items.map((item) => ({
      id: item.id,
      label: item.label,
      component: item.component,
      status: item.status,
      impact: item.impact,
      inference_flagged: item.inference_flagged === true,
    })),
  };
}

function readinessReceipt(readiness) {
  if (!isPlainObject(readiness)) return undefined;
  return {
    label: readiness.label,
    score: readiness.score,
    unresolved_burden: readiness.unresolved_burden,
    ledger_revision: readiness.ledger_revision,
    scope_version: readiness.scope_version,
    policy: isPlainObject(readiness.policy)
      ? { id: readiness.policy.id, version: readiness.policy.version }
      : undefined,
    open_item_ids: Array.isArray(readiness.open_item_ids) ? readiness.open_item_ids : [],
  };
}

/**
 * Commands that create or advance a form emit a compact receipt. `status`
 * and `consume` intentionally retain the full graph/ledger projections for
 * the agent that needs to reason over them.
 */
function workspaceReceipt(summary) {
  return {
    workspace_id: summary.workspace_id,
    url: summary.url,
    revision: summary.revision,
    ledger_revision: summary.ledger_revision,
    phase: summary.phase,
    objective: summary.objective,
    draft_saved_at: summary.draft_saved_at,
    ui_state_saved_at: summary.ui_state_saved_at,
    completed_at: summary.completed_at,
    recovery_lineage: summary.recovery_lineage,
    storage_health: summary.storage_health,
    durability_warnings: summary.durability_warnings,
    readiness: readinessReceipt(summary.readiness),
    material_item_count: Array.isArray(summary.material_items) ? summary.material_items.length : 0,
  };
}

function normalizePersistedUiState(value, state, graph) {
  if (!isPlainObject(value)) throw new Error("workspace ui_state must be an object");
  const persistedKeys = new Set([
    "schema_version",
    "workspace_revision",
    "ledger_revision",
    "saved_at",
    ...UI_STATE_INPUT_KEYS,
  ]);
  rejectUnknownKeys(value, persistedKeys, "workspace ui_state");
  if (value.schema_version !== UI_STATE_SCHEMA_VERSION) {
    throw new Error("workspace ui_state has an unsupported schema version");
  }
  if (!Number.isInteger(value.workspace_revision) || value.workspace_revision < 1
    || value.workspace_revision > state.current.revision) {
    throw new Error("workspace ui_state has an invalid workspace revision");
  }
  if (!Number.isInteger(value.ledger_revision) || value.ledger_revision < 0
    || value.ledger_revision > state.ledger.revision) {
    throw new Error("workspace ui_state has an invalid ledger revision");
  }
  const savedAt = requiredString(value.saved_at, "workspace ui_state.saved_at");
  if (Number.isNaN(Date.parse(savedAt))) throw new Error("workspace ui_state.saved_at must be an ISO timestamp");
  const isCurrent = value.workspace_revision === state.current.revision
    && value.ledger_revision === state.ledger.revision;
  const normalized = normalizeUiState(
    Object.fromEntries([...UI_STATE_INPUT_KEYS].map((key) => [key, value[key]])),
    isCurrent
      ? { graphNodeIds: new Set((graph.nodes ?? []).map((node) => node.id)) }
      : {},
  );
  return {
    schema_version: UI_STATE_SCHEMA_VERSION,
    workspace_revision: value.workspace_revision,
    ledger_revision: value.ledger_revision,
    saved_at: savedAt,
    ...normalized,
  };
}

function jsonValueIsSubset(value, canonicalValue) {
  if (Array.isArray(value)) {
    return Array.isArray(canonicalValue)
      && value.length === canonicalValue.length
      && value.every((entry, index) => jsonValueIsSubset(entry, canonicalValue[index]));
  }
  if (isPlainObject(value)) {
    return isPlainObject(canonicalValue)
      && Object.entries(value).every(([key, entry]) => (
        Object.prototype.hasOwnProperty.call(canonicalValue, key)
        && jsonValueIsSubset(entry, canonicalValue[key])
      ));
  }
  return Object.is(value, canonicalValue);
}

function packEventMatchesLedger(event, ledgerEvent) {
  if (!isPlainObject(event) || !isPlainObject(ledgerEvent)) return false;
  if (JSON.stringify(event) === JSON.stringify(ledgerEvent)) return true;
  if (!["pack_completed", "pack_advanced", "scope_changed"].includes(event.type)
    || event.event_id !== ledgerEvent.event_id
    || event.type !== ledgerEvent.type
    || event.occurred_at !== ledgerEvent.occurred_at) {
    return false;
  }
  const allowedKeys = new Set(["event_id", "type", "occurred_at", "entity_ids", "affected_item_ids", "payload"]);
  if (Object.keys(event).some((key) => !allowedKeys.has(key))
    || !jsonValueIsSubset(event.payload ?? {}, ledgerEvent.payload ?? {})) {
    return false;
  }
  const legacyEntityIds = event.entity_ids ?? event.affected_item_ids;
  if (event.type === "scope_changed") {
    // Pre-migration writers captured the caller's empty entity list before
    // appendEvent derived the scope-coverage blocker ID.
    return legacyEntityIds === undefined
      || (Array.isArray(legacyEntityIds) && legacyEntityIds.length === 0);
  }
  const canonicalEntityIds = ledgerEvent.entity_ids ?? [];
  return legacyEntityIds === undefined
    ? canonicalEntityIds.length === 0
    : JSON.stringify(legacyEntityIds) === JSON.stringify(canonicalEntityIds);
}

function assertWorkspaceShape(value, expectedId) {
  if (!isPlainObject(value) || value.schema_version !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error("workspace has an invalid shape");
  }
  if (value.workspace_id !== expectedId || !isPlainObject(value.current)) {
    throw new Error("workspace has an invalid identity or current pack");
  }
  if (!Number.isInteger(value.current.revision) || value.current.revision < 1) {
    throw new Error("workspace has an invalid revision");
  }
  if (value.storage_generation !== undefined
    && (!Number.isInteger(value.storage_generation) || value.storage_generation < 0)) {
    throw new Error("workspace has an invalid storage generation");
  }
  if (value.storage_health !== undefined
    && (!isPlainObject(value.storage_health) || !["healthy", "degraded"].includes(value.storage_health.status))) {
    throw new Error("workspace has an invalid storage health receipt");
  }
  if (!["open", "completed"].includes(value.current.phase)) {
    throw new Error("workspace has an invalid current pack phase");
  }
  const originalSeed = JSON.stringify(value.current.seed);
  const normalizedSeed = normalizeSeed(value.current.seed);
  if (JSON.stringify(normalizedSeed) !== originalSeed) {
    throw new Error("workspace seed is valid but not canonical; explicit migration is required");
  }
  value.current.seed = normalizedSeed;
  const originalDraft = JSON.stringify(value.current.draft ?? { responses: [] });
  const normalizedDraft = normalizeDraft(value.current.seed, value.current.draft ?? { responses: [] });
  if (JSON.stringify(normalizedDraft) !== originalDraft) {
    throw new Error("workspace draft is valid but not canonical; explicit migration is required");
  }
  value.current.draft = normalizedDraft;
  if (!Array.isArray(value.history) || !Array.isArray(value.pack_events)) {
    throw new Error("workspace history and pack_events must be explicit arrays");
  }
  const readiness = computeReadiness(value.ledger);
  const graph = projectGraph(value.ledger, readiness);
  if (value.current.ui_state !== undefined && value.current.ui_state !== null) {
    const originalUiState = JSON.stringify(value.current.ui_state);
    const normalizedUiState = normalizePersistedUiState(value.current.ui_state, value, graph);
    if (JSON.stringify(normalizedUiState) !== originalUiState) {
      throw new Error("workspace ui_state is valid but not canonical; explicit migration is required");
    }
    value.current.ui_state = normalizedUiState;
  }
  if (value.current.phase === "completed") {
    if (!isPlainObject(value.current.completion)
      || !isPlainObject(value.current.completion.normalized_response_patch)
      || !Array.isArray(value.current.completion.normalized_response_patch.responses)) {
      throw new Error("completed workspace is missing its normalized completion provenance");
    }
    const provenance = value.ledger.events.find((event) => event.event_id === value.current.completion.provenance_event_id);
    if (!provenance || provenance.type !== "pack_completed"
      || JSON.stringify(provenance.payload?.responses) !== JSON.stringify(value.current.completion.normalized_response_patch.responses)) {
      throw new Error("completed workspace response does not match its canonical ledger provenance event");
    }
  } else if (value.current.completion !== undefined && value.current.completion !== null) {
    throw new Error("open workspace must not contain a completed response");
  }
  if (value.history.length !== value.current.revision - 1
    || value.history.some((entry, index) => !isPlainObject(entry) || entry.revision !== index + 1)) {
    throw new Error("workspace history must contain one contiguous entry for every prior revision");
  }
  const ledgerEvents = new Map(value.ledger.events.map((event) => [event.event_id, event]));
  for (const event of value.pack_events) {
    const ledgerEvent = isPlainObject(event) ? ledgerEvents.get(event.event_id) : undefined;
    if (!ledgerEvent || !packEventMatchesLedger(event, ledgerEvent)) {
      throw new Error("workspace pack event is missing from the canonical ledger");
    }
  }
  return value;
}

async function readWorkspace(directory, workspace) {
  const state = await readJson(join(directory, "workspace.json"), "workspace");
  return assertWorkspaceShape(state, workspace);
}

async function saveWorkspace(directory, state) {
  const root = resolve(directory, "..");
  const next = {
    ...state,
    storage_generation: (Number.isInteger(state.storage_generation) ? state.storage_generation : 0) + 1,
    storage_health: { status: "healthy", verified_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  };
  const workspaceFile = join(directory, "workspace.json");
  await beginRecoveryCommit(root, next.workspace_id, next);
  try {
    await writeJsonAtomically(workspaceFile, next);
  } catch (error) {
    // A directory-fsync error can be reported after atomic rename committed.
    // Detect that exact byte state so callers do not replay random-ID ledger
    // mutations. If the target is not exact, the active commit is genuinely
    // unknown and the error must remain visible.
    let committed = false;
    try {
      committed = await readFile(workspaceFile, "utf8") === serializeJson(next);
    } catch {
      committed = false;
    }
    if (!committed) throw error;
  }
  try {
    await persistRecoveryReplica(root, next.workspace_id, next);
    return next;
  } catch (error) {
    // The canonical atomic write already committed. Return a visibly degraded
    // state instead of throwing an ordinary failure that could make a caller
    // retry a random-ID ledger mutation and duplicate it.
    const degraded = {
      ...next,
      storage_health: {
        status: "degraded",
        detected_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
    };
    let degradedMarkError;
    try {
      await beginRecoveryCommit(root, degraded.workspace_id, degraded);
      await writeJsonAtomically(workspaceFile, degraded);
    } catch (markError) {
      degradedMarkError = markError;
    }
    if (!degradedMarkError) {
      // Best-effort realignment prevents a post-commit replica error from
      // leaving equal generations that differ only by the persisted health
      // marker. Failure remains a degraded receipt, never a replay signal.
      await persistRecoveryReplica(root, degraded.workspace_id, degraded).catch(() => {});
    } else {
      degraded.storage_health.marking_error = degradedMarkError instanceof Error
        ? degradedMarkError.message
        : String(degradedMarkError);
    }
    return degraded;
  }
}

async function checkpointWorkspace(directory, state) {
  return sealCheckpoint(resolve(directory, ".."), state.workspace_id, state);
}

async function appendDurabilityWarning(directory, state, kind, error) {
  const warning = {
    kind,
    recorded_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
  return saveWorkspace(directory, {
    ...state,
    durability_warnings: [...(Array.isArray(state.durability_warnings) ? state.durability_warnings : []), warning],
  });
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function acquireWorkspaceLock(directory) {
  const lockFile = join(directory, ".workspace.lock");
  const deadline = Date.now() + WORKSPACE_LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`);
      } finally {
        await handle.close();
      }
      return async () => {
        await rm(lockFile, { force: true });
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      try {
        const metadata = await stat(lockFile);
        if (Date.now() - metadata.mtimeMs > WORKSPACE_LOCK_STALE_MS) {
          let ownerIsAlive = false;
          try {
            const owner = JSON.parse(await readFile(lockFile, "utf8"));
            if (Number.isInteger(owner?.pid) && owner.pid > 0) {
              try {
                process.kill(owner.pid, 0);
                ownerIsAlive = true;
              } catch (ownerError) {
                // EPERM means a process exists but this process cannot signal
                // it. ESRCH is the only portable indication that the owner is
                // gone and the stale lock may be reclaimed.
                ownerIsAlive = ownerError?.code !== "ESRCH";
              }
            }
          } catch {
            // An unreadable/partial stale lock cannot prove a live owner.
          }
          if (!ownerIsAlive) {
            await rm(lockFile, { force: true });
            continue;
          }
        }
      } catch (statError) {
        if (!statError || statError.code !== "ENOENT") throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error("workspace is busy with another local mutation; retry shortly");
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, WORKSPACE_LOCK_RETRY_MS));
    }
  }
}

async function withWorkspaceLock(directory, action) {
  const release = await acquireWorkspaceLock(directory);
  try {
    return await action();
  } finally {
    try {
      await release();
    } catch (error) {
      // A concurrent `finish` can remove the lock together with its workspace.
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
}

async function withListenerStartLock(lockDirectory, action) {
  const listenerLockDirectory = join(lockDirectory, "listener-start");
  await ensurePrivateDirectory(listenerLockDirectory);
  return withWorkspaceLock(listenerLockDirectory, action);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    throw new Error("usage: whybranch <start|status|consume|advance|finish|recover> [options]");
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${token} requires a value`);
    index += 1;
    if (token === "--seed-file") options.seedFile = value;
    else if (token === "--pack") options.pack = value;
    else if (token === "--patch-file") options.patchFile = value;
    else if (token === "--item-file") options.itemFile = value;
    else if (token === "--workspace") options.workspace = value;
    else if (token === "--item") options.itemId = value;
    else if (token === "--reason") options.reason = value;
    else throw new Error(`unsupported option: ${token}`);
  }
  return { command, options };
}

function usage() {
  return {
    usage: [
      "whybranch start (--seed-file <seed.json> | --pack interview)",
      "whybranch status --workspace <workspace-id>",
      "whybranch consume --workspace <workspace-id>",
      "whybranch advance --workspace <workspace-id> --seed-file <next-seed.json>",
      "whybranch add-item --workspace <workspace-id> --item-file <item.json>",
      "whybranch amend-item --workspace <workspace-id> --item <item-id> --patch-file <patch.json>",
      "whybranch flag-inference --workspace <workspace-id> --item <item-id> --reason <text>",
      "whybranch finish --workspace <workspace-id>",
      "whybranch recover --workspace <workspace-id>",
    ],
  };
}

async function loadSeed(seedFile) {
  if (!seedFile) throw new Error("--seed-file is required");
  const file = resolve(seedFile);
  return normalizeSeed(await readJson(file, "seed file"));
}

async function loadStartSeed({ seedFile, pack }) {
  if (seedFile && pack) throw new Error("start accepts either --seed-file or --pack, not both");
  if (pack) {
    const builtIn = getBuiltInPack(pack);
    if (!builtIn) throw new Error(`unknown built-in pack: ${pack}. Available packs: ${builtInPackIds().join(", ")}`);
    return normalizeSeed(builtIn.seed);
  }
  return loadSeed(seedFile);
}

async function loadItemPatch(patchFile) {
  if (!patchFile) throw new Error("--patch-file is required");
  const patch = await readJson(resolve(patchFile), "item patch file");
  if (!isPlainObject(patch)) throw new Error("item patch file must contain a JSON object");
  return patch;
}

async function loadMaterialItem(itemFile) {
  if (!itemFile) throw new Error("--item-file is required");
  const item = await readJson(resolve(itemFile), "material item file");
  if (!isPlainObject(item)) throw new Error("material item file must contain a JSON object");
  return item;
}

async function waitForServer(directory) {
  const serverFile = join(directory, "server.json");
  const errorFile = join(directory, "error.json");
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const server = await readJson(serverFile, "local server");
      if (isPlainObject(server) && server.host === HOST && typeof server.url === "string") return server;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith("was not found")) throw error;
    }
    try {
      const failure = await readJson(errorFile, "local server error");
      if (isPlainObject(failure) && typeof failure.error === "string") throw new Error(failure.error);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith("was not found")) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("local workflow server did not become ready in time");
}

async function waitForServerClosed(lockDirectory, workspace) {
  const receiptFile = join(lockDirectory, "server-closed.json");
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const receipt = await readJson(receiptFile, "server close receipt");
      if (receipt.workspace_id === workspace && typeof receipt.closed_at === "string") return receipt;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith("was not found")) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return undefined;
}

async function startWorkspace(seed, root) {
  await ensurePrivateDirectory(root);
  const { workspace, directory } = await createPrivateWorkspaceDirectory(root);
  const createdAt = new Date().toISOString();
  const ledger = await createLedgerFromSeed(seed);
  const initial = {
    schema_version: WORKSPACE_SCHEMA_VERSION,
    workspace_id: workspace,
    created_at: createdAt,
    updated_at: createdAt,
    url: undefined,
    server: undefined,
    history: [],
    pack_events: [],
    ledger,
    current: {
      revision: 1,
      phase: "open",
      seed,
      draft: { responses: [] },
      draft_saved_at: undefined,
      completed_at: undefined,
      completion: undefined,
    },
  };
  await saveWorkspace(directory, initial);
  let child;
  try {
    child = spawn(process.execPath, [SELF_PATH, "serve", "--workspace", workspace], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [WORKSPACE_ENV]: root },
    });
    child.unref();
    const server = await waitForServer(directory);
    const state = await readWorkspace(directory, workspace);
    const storageHealth = await verifyRecoveryReplica(root, workspace);
    if (storageHealth.status !== "healthy") {
      throw new Error("workspace recovery replica is not healthy; start will not hand off a non-durable session");
    }
    await checkpointWorkspace(directory, state);
    const snapshot = await snapshotForLedger(state.ledger);
    return {
      ...workspaceReceipt(currentSummary(state, snapshot)),
      workspace_id: workspace,
      url: server.url,
      storage_health: storageHealth,
      storage: storageReceipt(root, workspace),
      handoff: "작성 내용은 자동 저장됩니다. 완료하려면 Codex로 계속을 누른 뒤, 채팅에 계속이라고 입력하세요.",
    };
  } catch (error) {
    // A listener failure must not turn into state deletion. Preserve the exact
    // workspace ID and its recovery records so the caller can retry/recover
    // deliberately instead of losing an evidence-bearing seed or draft.
    try {
      if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
    } catch {
      // Preserve the original listener/start failure below.
    }
    const health = await verifyRecoveryReplica(root, workspace);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `workspace ${workspace} was persisted but its listener was not handed off (${reason}); storage_health=${health.status}. Run recover --workspace ${workspace}`,
    );
  }
}

async function statusWorkspace(root, workspace) {
  const directory = workspaceDirectory(root, workspace);
  const lockDirectory = recoveryDirectory(durableRecoveryRoot(root), workspace);
  await ensurePrivateDirectory(lockDirectory);
  return withWorkspaceLock(lockDirectory, async () => {
    const state = await readWorkspace(directory, workspace);
    return {
      ...currentSummary(state, await snapshotForLedger(state.ledger)),
      storage_health: await verifyRecoveryReplica(root, workspace),
      storage: storageReceipt(root, workspace),
    };
  });
}

async function requireHealthyMutationBase(root, workspace) {
  const health = await verifyRecoveryReplica(root, workspace);
  if (health.status !== "healthy") {
    const error = new Error(
      "workspace storage is degraded; run status and recover for this exact workspace before another mutation",
    );
    error.storage_health = health;
    throw error;
  }
  return health;
}

async function mutateWorkspace(root, workspace, action) {
  const directory = workspaceDirectory(root, workspace);
  const lockDirectory = recoveryDirectory(durableRecoveryRoot(root), workspace);
  await ensurePrivateDirectory(lockDirectory);
  return withWorkspaceLock(lockDirectory, async () => {
    const state = await readWorkspace(directory, workspace);
    await requireHealthyMutationBase(root, workspace);
    return action(directory, state);
  });
}

async function consumeWorkspace(root, workspace) {
  const directory = workspaceDirectory(root, workspace);
  const lockDirectory = recoveryDirectory(durableRecoveryRoot(root), workspace);
  await ensurePrivateDirectory(lockDirectory);
  return withWorkspaceLock(lockDirectory, async () => {
    const state = await readWorkspace(directory, workspace);
    if (state.current.phase !== "completed" || !state.current.completion) {
      throw new Error("the current answer pack has not been completed with Codex로 계속 yet");
    }
    const snapshot = await snapshotForLedger(state.ledger);
    return {
      ...currentSummary(state, snapshot),
      storage_health: await verifyRecoveryReplica(root, workspace),
      storage: storageReceipt(root, workspace),
      completion: publicCompletion(state.current.completion),
      ledger: state.ledger,
      pack_events: state.pack_events,
      history: state.history.map((entry) => ({
        revision: entry.revision,
        objective: entry.objective,
        completed_at: entry.completed_at,
      })),
    };
  });
}

async function advanceWorkspace(root, workspace, seed) {
  return mutateWorkspace(root, workspace, async (directory, state) => {
    if (state.current.phase !== "completed" || !state.current.completion) {
      throw new Error("advance requires the current answer pack to be completed first");
    }
    // Seal the exact completed state after any agent-side ledger mutations and
    // before the browser pack is replaced.
    await checkpointWorkspace(directory, state);
    const nextRevision = state.current.revision + 1;
    const completed = state.current.completion;
    const scopeChanged = seed.scope_version !== state.ledger.scope.version;
    if (!scopeChanged && seed.scope && seed.scope !== state.ledger.scope.label) {
      throw new Error("advance changes the scope label without a new scope_version");
    }
    const transition = {
      event_id: `pack-${randomUUID()}`,
      type: "pack_advanced",
      occurred_at: new Date().toISOString(),
      payload: {
        previous_revision: state.current.revision,
        next_revision: nextRevision,
        question_ids: seed.questions.map((question) => question.id),
        questions: seed.questions,
        scope_changed: scopeChanged,
      },
    };
    const scopeEvent = scopeChanged
      ? {
        event_id: `scope-${randomUUID()}`,
        type: "scope_changed",
        occurred_at: new Date().toISOString(),
        entity_ids: [],
        payload: {
          scope: seed.scope ?? state.ledger.scope.label,
          scope_version: seed.scope_version,
        },
      }
      : undefined;
    const ledgerAfterScope = scopeEvent
      ? await appendEvent(state.ledger, scopeEvent)
      : state.ledger;
    const nextLedger = await appendEvent(ledgerAfterScope, transition);
    const transitionEvent = nextLedger.events.find((event) => event.event_id === transition.event_id);
    const scopeLedgerEvent = scopeEvent
      ? nextLedger.events.find((event) => event.event_id === scopeEvent.event_id)
      : undefined;
    if (!transitionEvent || (scopeEvent && !scopeLedgerEvent)) {
      throw new Error("pack transition provenance is missing from the canonical ledger");
    }
    const next = {
      ...state,
      history: [...state.history, {
        revision: state.current.revision,
        objective: state.current.seed.objective,
        completed_at: completed.completed_at,
        normalized_response_patch: completed.normalized_response_patch,
        readiness: completed.readiness,
        graph: completed.graph,
      }],
      // A new seed replaces only the browser's current question pack. The
      // decision ledger stays continuous for the whole workspace; it is never
      // recreated by advance. appendEvent retains this transition as canonical
      // provenance while preserving unknown generic event types.
      ledger: nextLedger,
      pack_events: [
        ...state.pack_events,
        ...(scopeLedgerEvent ? [scopeLedgerEvent] : []),
        transitionEvent,
      ],
      current: {
        revision: nextRevision,
        phase: "open",
        seed,
        draft: { responses: [] },
        draft_saved_at: undefined,
        completed_at: undefined,
        completion: undefined,
      },
    };
    let saved = await saveWorkspace(directory, next);
    try {
      await checkpointWorkspace(directory, saved);
    } catch (error) {
      saved = await appendDurabilityWarning(directory, saved, "checkpoint_after_advance_failed", error);
    }
    const snapshot = await snapshotForLedger(saved.ledger);
    return {
      ...workspaceReceipt(currentSummary(saved, snapshot)),
      storage: storageReceipt(root, workspace),
      advanced_from_revision: state.current.revision,
      transition,
      scope_transition: scopeEvent,
      message: "The current pack was replaced at the existing local URL. Reload is automatic for an open browser tab.",
    };
  });
}

async function flagInferenceWorkspace(root, workspace, itemId, reason) {
  const normalizedItemId = requiredString(itemId, "--item");
  const normalizedReason = requiredString(reason, "--reason");
  return mutateWorkspace(root, workspace, async (directory, state) => {
    const before = await snapshotForLedger(state.ledger);
    const event = {
      event_id: `correction-${randomUUID()}`,
      type: "inference_flagged",
      occurred_at: new Date().toISOString(),
      entity_ids: [normalizedItemId],
      payload: { item_id: normalizedItemId, reason: normalizedReason },
    };
    const ledger = await appendEvent(state.ledger, event);
    const after = await snapshotForLedger(ledger);
    const saved = await saveWorkspace(directory, { ...state, ledger });
    return {
      ...currentSummary(saved, after),
      storage: storageReceipt(root, workspace),
      correction: {
        event_id: event.event_id,
        type: event.type,
        item_id: normalizedItemId,
        reason: normalizedReason,
        previous_readiness: before.readiness,
        next_readiness: after.readiness,
      },
    };
  });
}

async function amendItemWorkspace(root, workspace, itemId, patch) {
  const normalizedItemId = requiredString(itemId, "--item");
  return mutateWorkspace(root, workspace, async (directory, state) => {
    const before = await snapshotForLedger(state.ledger);
    const event = {
      event_id: `amendment-${randomUUID()}`,
      type: "item_updated",
      occurred_at: new Date().toISOString(),
      entity_ids: [normalizedItemId],
      payload: { item_id: normalizedItemId, patch },
    };
    const ledger = await appendEvent(state.ledger, event);
    const after = await snapshotForLedger(ledger);
    const saved = await saveWorkspace(directory, { ...state, ledger });
    return {
      ...currentSummary(saved, after),
      storage: storageReceipt(root, workspace),
      correction: {
        event_id: event.event_id,
        type: event.type,
        item_id: normalizedItemId,
        patch,
        previous_readiness: before.readiness,
        next_readiness: after.readiness,
      },
    };
  });
}

async function addItemWorkspace(root, workspace, item) {
  return mutateWorkspace(root, workspace, async (directory, state) => {
    const before = await snapshotForLedger(state.ledger);
    const event = {
      event_id: `addition-${randomUUID()}`,
      type: "material_item_added",
      occurred_at: new Date().toISOString(),
      payload: { item },
    };
    const ledger = await appendEvent(state.ledger, event);
    const after = await snapshotForLedger(ledger);
    const saved = await saveWorkspace(directory, { ...state, ledger });
    return {
      ...currentSummary(saved, after),
      storage: storageReceipt(root, workspace),
      addition: {
        event_id: event.event_id,
        type: event.type,
        item_id: item.id,
        previous_readiness: before.readiness,
        next_readiness: after.readiness,
      },
    };
  });
}

async function ensureArchivedRecoveryReplica(root, workspace, archivedDirectory, archivedState) {
  const archivedFile = join(archivedDirectory, "workspace.json");
  const archivedText = await readFile(archivedFile, "utf8");
  const validate = (value) => assertWorkspaceShape(value, workspace);
  let candidate = await bestRecoveryCandidate(root, workspace, validate);
  let repairError;
  const isExactLatest = () => candidate?.source === "replica:latest"
    && candidate.exact === true
    && candidate.text === archivedText;

  if (!isExactLatest()) {
    try {
      await persistRecoveryReplica(root, workspace, archivedState);
    } catch (error) {
      repairError = error;
    }
    candidate = await bestRecoveryCandidate(root, workspace, validate);
  }

  if (isExactLatest()) {
    return {
      candidate,
      storage_health: {
        status: "healthy",
        verified_at: new Date().toISOString(),
        generation: storageGeneration(archivedState),
        replica_checksum: candidate.checksum,
      },
      durability_warnings: [],
    };
  }

  const message = repairError instanceof Error
    ? repairError.message
    : "the archive does not have a byte-identical checksum-verified latest recovery replica";
  return {
    candidate,
    storage_health: {
      status: "degraded",
      verified_at: new Date().toISOString(),
      generation: storageGeneration(archivedState),
      error: message,
    },
    durability_warnings: [{
      kind: "archive_recovery_replica_degraded",
      recorded_at: new Date().toISOString(),
      error: message,
    }],
  };
}

async function finishWorkspace(root, workspace) {
  const directory = workspaceDirectory(root, workspace);
  const archiveRoot = durableRecoveryRoot(root);
  const archivedDirectory = archiveDirectory(archiveRoot, workspace);
  const lockDirectory = recoveryDirectory(durableRecoveryRoot(root), workspace);
  await ensurePrivateDirectory(lockDirectory);
  return withWorkspaceLock(lockDirectory, async () => {
    const activeExists = await pathExists(directory);
    const archivedExists = await pathExists(archivedDirectory);
    if (!activeExists) {
      if (archivedExists) {
        const archivedState = await readWorkspace(archivedDirectory, workspace);
        const archiveDurability = await ensureArchivedRecoveryReplica(
          root,
          workspace,
          archivedDirectory,
          archivedState,
        );
        return {
          workspace_id: workspace,
          finished: true,
          archived: true,
          already_archived: true,
          revision: archivedState.current.revision,
          ledger_revision: archivedState.ledger.revision,
          recovery_exact: archiveDurability.storage_health.status === "healthy",
          recovery_record: archiveDurability.storage_health.status === "healthy"
            ? archiveDurability.candidate.source
            : undefined,
          storage_health: archiveDurability.storage_health,
          durability_warnings: archiveDurability.durability_warnings,
          archive_path: archivedDirectory,
          storage: {
            ...storageReceipt(root, workspace),
            workspace_file: join(archivedDirectory, "workspace.json"),
          },
        };
      }
      throw new Error("workspace state was not found; the cause is unknown");
    }
    if (archivedExists) {
      throw new Error("both active and archived workspace state exist; refusing to choose or overwrite either copy");
    }
    const state = await readWorkspace(directory, workspace);
    const listenerWasReachable = await listenerIsReachable(state);
    await rm(join(lockDirectory, "server-closed.json"), { force: true });
    const checkpoint = await checkpointWorkspace(directory, state);
    const archivedAt = new Date().toISOString();
    const saved = await saveWorkspace(directory, {
      ...state,
      lifecycle: "archived",
      archived_at: archivedAt,
    });
    const destination = await moveWorkspaceToArchive(root, workspace, { archiveRoot });
    const archiveDurability = await ensureArchivedRecoveryReplica(
      root,
      workspace,
      destination,
      saved,
    );
    const closeReceipt = listenerWasReachable
      ? await waitForServerClosed(lockDirectory, workspace)
      : undefined;
    return {
      workspace_id: workspace,
      finished: true,
      archived: true,
      already_archived: false,
      archived_at: archivedAt,
      archive_path: destination,
      listener_was_reachable: listenerWasReachable,
      listener_closed: listenerWasReachable ? Boolean(closeReceipt) : true,
      listener_close_warning: listenerWasReachable && !closeReceipt
        ? "The workspace is archived, but loopback listener shutdown was not confirmed within four seconds."
        : undefined,
      revision: saved.current.revision,
      ledger_revision: saved.ledger.revision,
      recovery_exact: archiveDurability.storage_health.status === "healthy",
      recovery_record: archiveDurability.storage_health.status === "healthy"
        ? archiveDurability.candidate.source
        : undefined,
      storage_health: archiveDurability.storage_health,
      durability_warnings: archiveDurability.durability_warnings,
      checkpoint,
      storage: {
        ...storageReceipt(root, workspace),
        workspace_file: join(destination, "workspace.json"),
      },
    };
  });
}

async function listenerIsReachable(state) {
  if (typeof state.url !== "string") return false;
  try {
    const target = new URL("/api/status", state.url);
    if (target.protocol !== "http:" || target.hostname !== HOST) return false;
    const response = await fetch(target, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return false;
    const body = await response.json();
    return body.workspace_id === state.workspace_id;
  } catch {
    return false;
  }
}

async function launchWorkspaceServer(root, workspace, directory) {
  await rm(join(directory, "server.json"), { force: true });
  await rm(join(directory, "error.json"), { force: true });
  const child = spawn(process.execPath, [SELF_PATH, "serve", "--workspace", workspace], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [WORKSPACE_ENV]: root },
  });
  child.unref();
  try {
    return await waitForServer(directory);
  } catch (error) {
    try {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    } catch {
      // Preserve the workspace and recovery records even if listener restart fails.
    }
    throw error;
  }
}

function storageGeneration(state) {
  return Number.isInteger(state.storage_generation) ? state.storage_generation : 0;
}

function sameWorkspaceContentExceptStorageHealth(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const { storage_health: leftHealth, ...leftContent } = left;
  const { storage_health: rightHealth, ...rightContent } = right;
  return JSON.stringify(leftContent) === JSON.stringify(rightContent)
    && (leftHealth?.status === "degraded" || rightHealth?.status === "degraded");
}

function hasUnresolvedRecoveryGap(state) {
  return isPlainObject(state.recovery_lineage) && state.recovery_lineage.exact_latest === false;
}

function recoveryGapWarning(state) {
  return hasUnresolvedRecoveryGap(state)
    ? state.recovery_lineage.warning
      ?? "This workspace descends from an older verified boundary; later unsealed changes may be missing."
    : undefined;
}

async function recoverWorkspace(root, workspace) {
  const requestedRoot = root;
  const durableRoot = durableRecoveryRoot(root);
  const lockDirectory = recoveryDirectory(durableRoot, workspace);
  await ensurePrivateDirectory(lockDirectory);
  let directory;
  const recovery = await withWorkspaceLock(lockDirectory, async () => {
    root = requestedRoot;
    if (durableRoot !== requestedRoot) {
      const [legacyActive, legacyArchive, durableActive, durableArchive] = await Promise.all([
        pathExists(workspaceDirectory(requestedRoot, workspace)),
        pathExists(archiveDirectory(requestedRoot, workspace)),
        pathExists(workspaceDirectory(durableRoot, workspace)),
        pathExists(archiveDirectory(durableRoot, workspace)),
      ]);
      if ((legacyActive || legacyArchive) && (durableActive || durableArchive)) {
        throw new Error("workspace state exists in both the persistent and legacy temporary roots; recovery refuses to choose a lineage");
      }
      // Root selection is made under the same durable lock used by finish, so
      // a legacy active cannot move to a persistent archive between discovery
      // and restoration.
      if (!legacyActive && !legacyArchive) root = durableRoot;
    }
    await ensurePrivateDirectory(root);
    directory = workspaceDirectory(root, workspace);
    const archivedDirectory = archiveDirectory(root, workspace);
    const activeExists = await pathExists(directory);
    const archivedExists = await pathExists(archivedDirectory);
    if (activeExists && archivedExists) {
      throw new Error("both active and archived workspace state exist; recovery refuses to choose a lineage");
    }

    let state;
    let recoveredFrom = "live";
    let sourceExact = true;
    let backupRepaired = false;
    let quarantinedArchivePath;
    const candidate = await bestRecoveryCandidate(root, workspace, (value) => assertWorkspaceShape(value, workspace));

    if (archivedExists) {
      let archiveReadError;
      try {
        state = await readWorkspace(archivedDirectory, workspace);
      } catch (archiveError) {
        archiveReadError = archiveError;
      }
      if (archiveReadError) {
        if (!candidate) {
          throw new Error(`archived workspace is invalid and no checksum-verified recovery record exists: ${archiveReadError.message}`);
        }
        await beginRecoveryCommit(root, workspace, candidate.value);
        quarantinedArchivePath = await quarantineArchivedWorkspace(root, workspace);
        await ensurePrivateDirectory(directory);
        await writeTextAtomically(join(directory, "workspace.json"), candidate.text);
        state = await readWorkspace(directory, workspace);
        recoveredFrom = candidate.source;
        sourceExact = candidate.exact;
      } else {
        await beginRecoveryCommit(root, workspace, state);
        await restoreArchivedWorkspace(root, workspace);
        recoveredFrom = "archive";
      }
    } else if (activeExists) {
      let activeReadError;
      try {
        state = await readWorkspace(directory, workspace);
      } catch (activeError) {
        activeReadError = activeError;
      }
      if (!activeReadError && state.lifecycle === "archived") {
        state = await appendDurabilityWarning(
          directory,
          { ...state, lifecycle: "active", archived_at: undefined },
          "interrupted_finish_recovered",
          new Error("finish marked the active workspace archived but did not move it"),
        );
        recoveredFrom = "live:interrupted-finish";
      }
      if (activeReadError) {
        if (!candidate) throw new Error("no checksum-verified recovery record exists for this workspace");
        await beginRecoveryCommit(root, workspace, candidate.value);
        await writeTextAtomically(join(directory, "workspace.json"), candidate.text);
        state = await readWorkspace(directory, workspace);
        recoveredFrom = candidate.source;
        sourceExact = candidate.exact;
      } else if (!candidate) {
        state = await saveWorkspace(directory, state);
        backupRepaired = state.storage_health?.status === "healthy";
      } else if (storageGeneration(candidate.value) > storageGeneration(state)) {
        await beginRecoveryCommit(root, workspace, candidate.value);
        await writeTextAtomically(join(directory, "workspace.json"), candidate.text);
        state = await readWorkspace(directory, workspace);
        recoveredFrom = candidate.source;
        sourceExact = candidate.exact;
      } else if (storageGeneration(candidate.value) < storageGeneration(state)) {
        state = await saveWorkspace(directory, state);
        backupRepaired = state.storage_health?.status === "healthy";
      } else {
        if (JSON.stringify(candidate.value) !== JSON.stringify(state)) {
          if (!sameWorkspaceContentExceptStorageHealth(state, candidate.value)) {
            throw new Error("active and recovery state have the same storage generation but different content");
          }
          state = await saveWorkspace(directory, state);
          backupRepaired = state.storage_health?.status === "healthy";
        }
        if ((candidate.source !== "replica:latest" || candidate.exact !== true) && !backupRepaired) {
          state = await saveWorkspace(directory, state);
          backupRepaired = state.storage_health?.status === "healthy";
        }
      }
    } else {
      if (!candidate) {
        throw new Error("workspace state is unavailable and no checksum-verified recovery record exists; the cause is unknown");
      }
      await ensurePrivateDirectory(directory);
      await beginRecoveryCommit(root, workspace, candidate.value);
      await writeTextAtomically(join(directory, "workspace.json"), candidate.text);
      state = await readWorkspace(directory, workspace);
      recoveredFrom = candidate.source;
      sourceExact = candidate.exact;
    }

    const exact = sourceExact && !hasUnresolvedRecoveryGap(state);
    const warning = exact
      ? undefined
      : recoveryGapWarning(state)
        ?? "Recovery used an older verified record. Changes after its revision, including an unsealed draft, may be missing.";
    if (recoveredFrom !== "live") {
      const recoveredAt = new Date().toISOString();
      state = await saveWorkspace(directory, {
        ...state,
        lifecycle: "active",
        archived_at: undefined,
        recovered_at: recoveredAt,
        recovery_lineage: {
          ...(isPlainObject(state.recovery_lineage) ? state.recovery_lineage : {}),
          recovered_at: recoveredAt,
          source: recoveredFrom,
          source_revision: state.current.revision,
          source_ledger_revision: state.ledger.revision,
          exact_latest: exact,
          warning,
        },
      });
    }
    return {
      state,
      recoveredFrom,
      exact,
      warning,
      backupRepaired,
      quarantinedArchivePath,
    };
  });

  const { state, recoveredFrom, exact, warning, backupRepaired, quarantinedArchivePath } = recovery;
  const listenerRestarted = await withListenerStartLock(lockDirectory, async () => {
    const latest = await readWorkspace(directory, workspace);
    if (await listenerIsReachable(latest)) return false;
    await launchWorkspaceServer(root, workspace, directory);
    return true;
  });
  const restored = await readWorkspace(directory, workspace);
  const storageHealth = await verifyRecoveryReplica(root, workspace);
  return {
    ...workspaceReceipt(currentSummary(restored, await snapshotForLedger(restored.ledger))),
    workspace_id: workspace,
    recovered: recoveredFrom !== "live",
    recovered_from: recoveredFrom,
    recovery_exact: exact,
    recovery_warning: warning,
    recovery_lineage: restored.recovery_lineage,
    backup_repaired: backupRepaired,
    quarantined_archive_path: quarantinedArchivePath,
    listener_restarted: listenerRestarted,
    url_changed: typeof state.url === "string" && restored.url !== state.url,
    previous_url: typeof state.url === "string" && restored.url !== state.url ? state.url : undefined,
    storage_health: storageHealth,
    storage: storageReceipt(root, workspace),
  };
}

async function requestBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(JSON.stringify(body));
}

function sendHtml(response, body) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; media-src 'none'",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

function displayHeuristicScore(value) {
  return typeof value === "number" ? `${value} / 100` : String(value);
}

function panelMarkup(title, items, emptyText = "없음") {
  if (!Array.isArray(items) || items.length === 0) {
    return `<section class="panel"><h2>${escapeHtml(title)}</h2><p class="subtle">${escapeHtml(emptyText)}</p></section>`;
  }
  const content = items.map((item) => {
    if (typeof item === "string") return `<li>${escapeHtml(item)}</li>`;
    if (!isPlainObject(item)) return "";
    const label = item.label ?? item.title ?? item.text ?? item.prompt ?? "기록 항목";
    const detail = item.detail ?? item.rationale ?? item.reason;
    const unlock = item.unlock_condition;
    return `<li><strong>${escapeHtml(label)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ""}${unlock ? `<p class="subtle"><strong>열리는 조건:</strong> ${escapeHtml(unlock)}</p>` : ""}</li>`;
  }).join("");
  return `<section class="panel"><h2>${escapeHtml(title)}</h2><ul>${content}</ul></section>`;
}

function displayReadiness(readiness) {
  if (!isPlainObject(readiness)) return "결정 준비도: 계산 정보 없음";
  const candidates = [readiness.score, readiness.value, readiness.overall, readiness.readiness];
  const score = candidates.find((value) => typeof value === "number" || typeof value === "string");
  if (score === undefined || score === null) return "결정 준비도: 해당 없음";
  return `결정 준비도 (heuristic): ${displayHeuristicScore(score)}`;
}

function displayUnresolvedBurden(readiness) {
  if (!isPlainObject(readiness) || typeof readiness.unresolved_burden !== "number") {
    return "남은 불확실성 (heuristic): N/A";
  }
  return `남은 불확실성 (heuristic): ${displayHeuristicScore(readiness.unresolved_burden)}`;
}

function scoreChangeMarkup(change) {
  if (!isPlainObject(change)) {
    return '<section id="latest-score-change" class="score-change subtle"><strong>최근 준비도 변화</strong><p>아직 명시적 원장 항목 변화가 없습니다. 답변 저장만으로 점수는 추정하지 않습니다.</p></section>';
  }
  const previous = change.previous_value ?? "N/A";
  const next = change.next_value ?? "N/A";
  const affected = Array.isArray(change.affected_item_ids) && change.affected_item_ids.length > 0
    ? change.affected_item_ids.join(", ")
    : "범위 또는 평가 가능 항목";
  return `<section id="latest-score-change" class="score-change"><strong>최근 준비도 변화</strong><p>${escapeHtml(displayHeuristicScore(previous))} → ${escapeHtml(displayHeuristicScore(next))}</p><p class="subtle">${escapeHtml(change.explanation ?? "원장 항목이 변경되어 재계산되었습니다.")}</p><p class="subtle">규칙: ${escapeHtml(change.rule_id ?? "unknown")} · 영향 항목: ${escapeHtml(affected)}</p></section>`;
}

/**
 * The browser is intentionally generated by the CLI itself. There are no
 * external assets, cookies, browser storage, authentication, or tokens.
 */
export function renderDocument(state, snapshot) {
  const { current } = state;
  const seed = current.seed;
  const completion = publicCompletion(current.completion);
  const initialStatus = currentSummary(state, snapshot);
  const initialUiState = isPlainObject(current.ui_state)
    && current.ui_state.workspace_revision === current.revision
    && current.ui_state.ledger_revision === state.ledger.revision
    ? current.ui_state
    : undefined;
  const meta = [
    seed.scope ? `<p><strong>범위:</strong> ${escapeHtml(seed.scope)}</p>` : "",
    seed.horizon ? `<p><strong>기간:</strong> ${escapeHtml(seed.horizon)}</p>` : "",
    seed.working_assumption ? `<p><strong>작업 가정:</strong> ${escapeHtml(seed.working_assumption)}</p>` : "",
  ].join("");
  const ambiguity = isPlainObject(seed.ambiguity)
    ? `<p><strong>초기 모호성 메모:</strong> ${escapeHtml(seed.ambiguity.estimate ?? "정량화하지 않음")}${seed.ambiguity.rationale ? ` · ${escapeHtml(seed.ambiguity.rationale)}` : ""}</p>`
    : `<p><strong>초기 모호성 메모:</strong> 정량화하지 않음</p>`;
  const completedMarkup = completion
    ? `<section id="complete" class="complete"><h2>저장되었습니다.</h2><p>Codex 채팅에 <code>계속</code>이라고 입력하세요. 다음 Answer Pack은 같은 URL에서 <code>advance</code>로 교체됩니다.</p></section>`
    : `<section id="complete" class="complete" hidden><h2>저장되었습니다.</h2><p>Codex 채팅에 <code>계속</code>이라고 입력하세요. 다음 Answer Pack은 같은 URL에서 <code>advance</code>로 교체됩니다.</p></section>`;
  const durabilityMessages = [
    recoveryGapWarning(state),
    state.storage_health?.status === "degraded"
      ? "라이브 원장은 저장되었지만 복구 복제본 상태가 저하되었습니다. 새 답변을 확정하기 전에 Codex에서 복구 상태를 확인하세요."
      : undefined,
    ...(Array.isArray(state.durability_warnings)
      ? state.durability_warnings.map((warning) => `내구성 경고: ${warning.kind ?? "unknown"}`)
      : []),
  ].filter(Boolean);
  const durabilityMarkup = `<section id="durability-alert" class="durability-warning" role="alert"${durabilityMessages.length === 0 ? " hidden" : ""}>${durabilityMessages.length > 0 ? durabilityMessages.map((message) => `<p>${escapeHtml(message)}</p>`).join("") : ""}</section>`;
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Whybranch 워크스페이스</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f5f7fb; }
    body { margin: 0; padding: 28px 16px 72px; } main { max-width: 930px; margin: 0 auto; }
    h1 { margin: 0 0 10px; font-size: clamp(25px, 5vw, 32px); } h2 { font-size: 17px; margin: 0 0 9px; } h3 { margin: 0; font-size: 18px; }
    p { line-height: 1.55; } .lede, .subtle { color: #5b667a; } .meta p { margin: 5px 0; }
    .eyebrow { color: #3158a5; font-weight: 700; margin: 0 0 8px; } .workspace { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #5b667a; }
    .panel, .question, .preview, .complete, details { background: #fff; border: 1px solid #dbe2ef; border-radius: 12px; padding: 17px; margin-top: 15px; box-shadow: 0 1px 2px rgb(15 23 42 / 0.04); }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(175px, 1fr)); gap: 10px; margin-top: 15px; }
    .metric { background: #edf4ff; border: 1px solid #cadcfb; border-radius: 10px; padding: 12px; } .metric strong { display: block; margin-bottom: 4px; }
    ul { padding-left: 20px; margin: 0; } li + li { margin-top: 9px; } li p { margin: 4px 0 0; }
    .question-header { display: flex; gap: 12px; align-items: flex-start; } .question-header > div { min-width: 0; } .question-header h3 { line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; } .number { color: #1d63d6; font-weight: 750; min-width: 22px; }
    .prompt-detail, .description, .effect, .draft { margin: 11px 0 0 34px; } .rich-text > :first-child { margin-top: 0; } .rich-text > :last-child { margin-bottom: 0; } .rich-text > p { white-space: pre-wrap; } .inline-code { display: inline; padding: 0.08em 0.32em; border-radius: 4px; background: #e9eef8; color: #263650; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; overflow-wrap: anywhere; } .code-block { margin: 13px 0; overflow: hidden; border: 1px solid #c7d3e8; border-radius: 9px; background: #101827; color: #dbeafe; } .code-block-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 11px; border-bottom: 1px solid #2b3c59; background: #17243a; color: #b7c9e9; font: 700 12px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.04em; } .code-copy { margin: 0; padding: 5px 8px; border: 1px solid #48658e; border-radius: 6px; background: #233a5e; color: #eff6ff; font: inherit; cursor: pointer; } .code-copy:focus-visible { outline: 3px solid #9ec5ff; outline-offset: 2px; } .code-block pre { max-height: 340px; margin: 0; overflow: auto; padding: 14px; white-space: pre; overflow-wrap: normal; background: transparent; color: inherit; border-radius: 0; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; } .code-block code { font: inherit; } .effect { background: #eef6ff; border-radius: 8px; padding: 9px; } .draft { background: #f7f8fb; border-radius: 8px; padding: 9px; white-space: pre-wrap; }
    fieldset { border: 0; margin: 15px 0 0 34px; padding: 0; } legend { font-weight: 650; margin-bottom: 8px; } label { display: block; margin: 8px 0; }
    input[type=radio], input[type=checkbox] { margin-right: 7px; } textarea { display: block; box-sizing: border-box; width: 100%; min-height: 84px; margin-top: 7px; padding: 10px; border: 1px solid #b9c6dd; border-radius: 8px; font: inherit; resize: vertical; }
    .option-effect { display: block; margin: 3px 0 0 24px; font-size: 13px; color: #5b667a; } .field-note { margin-top: 12px; } .field-note[hidden] { display: none; }
    .resolution-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin: 10px 0; } .resolution-choice { min-height: 68px; box-sizing: border-box; margin: 0; padding: 10px; border: 1px solid #cbd7ea; border-radius: 9px; background: #fbfdff; cursor: pointer; } .resolution-choice:hover { border-color: #7ba6e8; background: #f5f9ff; } .resolution-choice.is-selected { border-color: #1769df; background: #edf4ff; box-shadow: 0 0 0 1px #1769df inset; } .resolution-choice input { vertical-align: top; margin-top: 3px; } .resolution-choice-copy { display: inline-block; width: calc(100% - 25px); vertical-align: top; } .resolution-choice-copy strong { display: block; } .resolution-choice-copy span { display: block; margin-top: 3px; color: #52627a; font-size: 12px; line-height: 1.4; } .resolution-common, .resolution-effect, .defer-panel { margin: 10px 0 0; padding: 9px 10px; border-radius: 8px; font-size: 13px; line-height: 1.45; } .resolution-common { color: #52627a; background: #f7f8fb; } .resolution-effect { border: 1px solid #bdd3f5; background: #eef6ff; color: #183d71; } .resolution-effect strong { display: block; margin-bottom: 2px; } .defer-panel { border: 1px solid #cbd7ea; background: #fbfdff; } .defer-panel[hidden] { display: none; } .defer-action { margin: 0; font-weight: 650; } .defer-action span { display: block; margin-bottom: 6px; } .defer-action select { display: block; box-sizing: border-box; width: 100%; margin-top: 4px; padding: 9px 10px; border: 1px solid #9eb5d8; border-radius: 8px; background: #fff; color: #172033; font: inherit; } textarea[aria-invalid="true"], select[aria-invalid="true"] { border-color: #b42318; box-shadow: 0 0 0 1px #b42318 inset; }
    button { margin-top: 20px; background: #1769df; color: #fff; border: 0; border-radius: 9px; padding: 12px 15px; font: inherit; font-weight: 700; cursor: pointer; } button:disabled { opacity: .56; cursor: wait; }
    pre { max-height: 360px; margin: 10px 0 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 8px; background: #101827; color: #dbeafe; padding: 12px; font-size: 12px; } .error { color: #b42318; } .complete h2 { color: #166534; } .durability-warning { margin-top: 15px; padding: 13px 15px; border: 1px solid #d97706; border-radius: 10px; background: #fff7ed; color: #7c2d12; } .durability-warning p { margin: 0; } .durability-warning p + p { margin-top: 7px; }
    details > summary { cursor: pointer; font-weight: 700; } details[open] > summary { margin-bottom: 10px; } code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .graph-intro { margin: 8px 0; } .graph-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 13px 0 8px; } .graph-tabs, .graph-filters, .graph-explorer-controls, .graph-navigation { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; } .graph-filter-label, .graph-navigation-status { color: #5b667a; font-size: 13px; font-weight: 650; } .graph-navigation-status { font-weight: 500; } button.graph-control, button.graph-close { margin: 0; padding: 7px 10px; border: 1px solid #b9c6dd; border-radius: 999px; background: #fff; color: #263650; font-size: 13px; font-weight: 700; } button.graph-control:hover, button.graph-control[aria-pressed="true"] { border-color: #1769df; background: #eaf2ff; color: #0e4ba2; } button.graph-control:focus-visible, button.graph-close:focus-visible { outline: 3px solid #9ec5ff; outline-offset: 2px; } .graph-canvas { overflow: hidden; border: 1px solid #dbe2ef; border-radius: 9px; background: #fbfdff; } #graph-svg { display: block; width: 100%; height: 320px; touch-action: none; user-select: none; } .graph-summary { margin: 8px 0; } .graph-hover { min-height: 1.5em; margin: 8px 0 0; color: #40526f; font-size: 13px; } .graph-inspector { margin-top: 12px; padding: 12px; border: 1px solid #bad0f2; border-radius: 9px; background: #eef5ff; } .graph-inspector-header { display: flex; gap: 10px; align-items: center; justify-content: space-between; } .graph-inspector-header h4 { margin: 0; font-size: 15px; } button.graph-close { padding: 5px 9px; } .graph-inspector p { margin: 8px 0 0; } .graph-inspector dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 10px; margin: 10px 0 0; font-size: 13px; } .graph-inspector dt { color: #5b667a; } .graph-inspector dd { margin: 0; overflow-wrap: anywhere; } .graph-inspector ul { margin: 10px 0 0; font-size: 13px; } .graph-legend { margin-top: 10px; padding: 10px; box-shadow: none; background: #f7f8fb; } .graph-legend p { margin: 6px 0 0; font-size: 13px; } .answer-summary, .material-summary, .score-change { margin: 12px 0 0; padding: 10px; background: #f7f8fb; border-radius: 8px; } .answer-summary ul, .material-summary ul { margin-top: 7px; } .score-change p { margin: 5px 0 0; }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Whybranch · 로컬 워크스페이스</p>
      <h1>${escapeHtml(seed.objective)}</h1>
      <p class="workspace">workspace ${escapeHtml(state.workspace_id)} · revision ${current.revision}</p>
      <div class="meta">${meta}${ambiguity}</div>
      <p class="lede">입력은 포커스를 옮기지 않아도 마지막 변경 후 약 0.45초에 이 컴퓨터의 영속 로컬 워크스페이스와 복구 복제본에 자동 저장됩니다. 완료는 자동 저장과 별개입니다. 완료하려면 <code>Codex로 계속</code>을 누른 뒤 Codex 채팅에 <code>계속</code>이라고 입력하세요.</p>
    </header>
    ${durabilityMarkup}
    <section class="summary" aria-label="현재 요약">
      <div class="metric"><strong>현재 revision</strong><span id="revision-summary">${current.revision}</span></div>
      <div class="metric"><strong>상태</strong><span id="phase-summary">${current.phase === "completed" ? "완료됨" : "작성 중"}</span></div>
      <div class="metric"><strong>준비도</strong><span id="readiness-summary">${escapeHtml(displayReadiness(initialStatus.readiness))}</span></div>
      <div class="metric"><strong>남은 불확실성</strong><span id="uncertainty-summary">${escapeHtml(displayUnresolvedBurden(initialStatus.readiness))}</span><small class="subtle">확률이 아닌 공개 정책 기반 미해결 부담입니다.</small></div>
    </section>
    ${panelMarkup("현재 차단점", seed.current_blockers)}
    ${panelMarkup("잠긴 후속 질문", seed.potential_follow_ups)}
    ${panelMarkup("후보 관련 불확실성", seed.candidate_uncertainties, "후보: 아직 없음")}
    <details id="score-graph" ${(initialUiState ? initialUiState.score_details_open : Boolean(completion)) ? "open" : ""}><summary>점수와 그래프 열기</summary><p class="subtle">점수는 정책 버전과 영향 항목이 기록된 재현 가능한 휴리스틱입니다. 확률이나 사실 판정이 아닙니다.</p>${scoreChangeMarkup(initialStatus.latest_score_change)}<h3>결정 그래프</h3><p class="graph-intro subtle">이 맵은 원장에 기록된 질문·근거·반증·차단점·답변·이벤트의 관계를 탐색하는 도구입니다. 선과 배치는 인과관계나 우선순위를 뜻하지 않습니다.</p><div class="graph-controls"><div class="graph-tabs" role="group" aria-label="그래프 보기"><button class="graph-control" type="button" data-graph-view="focus" aria-pressed="true">현재 판단</button><button class="graph-control" type="button" data-graph-view="overview" aria-pressed="false">탐색 지도</button></div><div id="graph-filters" class="graph-filters" role="group" aria-label="탐색 지도 필터"><span class="graph-filter-label">표시 범위</span><button class="graph-control" type="button" data-graph-filter="all" aria-pressed="true">전체</button><button class="graph-control" type="button" data-graph-filter="unresolved" aria-pressed="false">미해결</button><button class="graph-control" type="button" data-graph-filter="score" aria-pressed="false">점수 영향</button><button class="graph-control" type="button" data-graph-filter="history" aria-pressed="false">이력 간선 포함</button></div><div id="graph-explorer-controls" class="graph-explorer-controls" role="group" aria-label="그래프 묶음"><button class="graph-control" type="button" data-graph-groups="history">이력·답변 접기</button><button class="graph-control" type="button" data-graph-groups="expand">모두 펼치기</button></div><div id="graph-navigation" class="graph-navigation" role="group" aria-label="탐색 지도 이동과 확대"><button class="graph-control" type="button" data-graph-zoom="out" aria-label="그래프 축소">−</button><button class="graph-control" type="button" data-graph-zoom="reset">맞추기</button><button class="graph-control" type="button" data-graph-zoom="in" aria-label="그래프 확대">+</button><span id="graph-navigation-status" class="graph-navigation-status" aria-live="polite">100%</span></div></div><p id="ui-state-status" class="subtle" role="status" aria-live="polite">화면 상태 저장 준비됨</p><p id="graph-summary" class="graph-summary subtle">그래프를 계산 중입니다.</p><div class="graph-canvas"><svg id="graph-svg" viewBox="0 0 720 280" role="img" aria-label="결정 그래프"></svg></div><p id="graph-hover" class="graph-hover subtle" role="status" aria-live="polite">노드에 마우스를 올리거나 키보드로 선택하면 요약이 표시됩니다.</p><section id="graph-inspector" class="graph-inspector" hidden aria-live="polite"><div class="graph-inspector-header"><h4 id="graph-inspector-title">선택한 항목</h4><button id="graph-inspector-close" class="graph-close" type="button">닫기</button></div><p id="graph-inspector-label"></p><dl id="graph-inspector-meta"></dl><ul id="graph-inspector-relations"></ul></section><details id="graph-legend" class="graph-legend"${initialUiState?.graph_legend_open ? " open" : ""}><summary>그래프 읽는 법</summary><p><strong>현재 판단</strong>은 현재 질문, 미해결 항목, 활성 후보와 준비도에 연결된 항목만 보여 줍니다. <strong>탐색 지도</strong>에서는 차선 제목을 눌러 질문·근거·답변·이력 묶음을 접거나 펼칠 수 있습니다. 접힌 묶음은 원장 데이터를 지우지 않으며, 숨긴 노드와 관계 수를 요약에 표시합니다.</p><p>탐색 지도는 빈 공간을 드래그해 이동하고, 트랙패드 핀치 또는 <code>⌘/Ctrl</code>+휠과 <code>− / +</code> 버튼으로 확대·축소합니다. 호버는 미리보기, 클릭 또는 키보드 Enter는 상세 고정입니다. 전체 지형도에서의 위치는 읽기 편한 역할별 묶음일 뿐 원인·영향의 방향을 뜻하지 않습니다.</p></details><section id="material-summary" class="material-summary"><strong>점수·그래프 대상 원장 항목</strong><p class="subtle">원 답/근거를 고치거나 추론 오류를 표시할 때 아래 ID를 사용하세요. 점수는 직접 수정할 수 없습니다.</p><ul id="material-summary-list"></ul></section><section id="answer-summary" class="answer-summary" hidden><strong>이번 팩의 기록된 답변</strong><ul id="answer-summary-list"></ul></section><h3>Readiness detail</h3><pre id="readiness-json"></pre><details id="graph-json-details"${initialUiState?.graph_json_open ? " open" : ""}><summary>Graph JSON 보기</summary><pre id="graph-json"></pre></details></details>
    <form id="decision-form" novalidate ${completion ? "hidden" : ""}>
      <div id="questions"></div>
      <section class="preview"><h2>작성 중 미리보기</h2><pre id="preview">아직 입력한 답변이 없습니다.</pre></section>
      <p id="autosave-status" class="subtle" role="status" aria-live="polite">자동 저장 준비됨</p>
      <p id="error" class="error" role="alert"></p>
      <button id="submit" type="submit">Codex로 계속</button>
    </form>
    ${completedMarkup}
  </main>
  <script>
    const seed = ${jsonForScript(seed)};
    const initialDraft = ${jsonForScript(current.draft ?? { responses: [] })};
    const initialStatus = ${jsonForScript(initialStatus)};
    const initialCompletion = ${jsonForScript(completion ?? null)};
    const initialUiState = ${jsonForScript(initialUiState ?? null)};
    const AUTOSAVE_DELAY_MS = ${AUTOSAVE_DELAY_MS};
    const UI_STATE_SAVE_DELAY_MS = ${UI_STATE_SAVE_DELAY_MS};
    const questionContainer = document.getElementById("questions");
    const form = document.getElementById("decision-form");
    const preview = document.getElementById("preview");
    const error = document.getElementById("error");
    const submit = document.getElementById("submit");
    const complete = document.getElementById("complete");
    const autosaveStatus = document.getElementById("autosave-status");
    const uiStateStatus = document.getElementById("ui-state-status");
    const durabilityAlert = document.getElementById("durability-alert");
    let saveTimer;
    let draftGeneration = 0;
    let savingDraft = false;
    let uiStateSaveTimer;
    let uiStateGeneration = 0;
    let savingUiState = false;
    let uiStateLedgerRevision = initialStatus.ledger_revision;
    let completed = Boolean(initialCompletion);
    let model = initialStatus;
    let graphCompletion = initialCompletion;
    let graphView = "focus";
    let graphFilter = "all";
    let selectedGraphNodeId = null;
    const defaultCollapsedGraphTypes = new Set(["answer", "event"]);
    let collapsedGraphTypes = new Set(defaultCollapsedGraphTypes);
    let graphViewport = null;
    let graphViewportLayoutKey = "";
    let activeGraphLayout = null;
    let activeGraphSvg = null;
    const graphViewButtons = Array.from(document.querySelectorAll("[data-graph-view]"));
    const graphFilterButtons = Array.from(document.querySelectorAll("[data-graph-filter]"));
    const graphGroupButtons = Array.from(document.querySelectorAll("[data-graph-groups]"));
    const graphZoomButtons = Array.from(document.querySelectorAll("[data-graph-zoom]"));
    const graphFilters = document.getElementById("graph-filters");
    const graphExplorerControls = document.getElementById("graph-explorer-controls");
    const graphNavigation = document.getElementById("graph-navigation");

    function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
    function renderInlineCode(value) {
      return String(value).split(/(\x60[^\x60\\n]+\x60)/g).map(function (part) {
        if (part.length >= 2 && part.startsWith("\x60") && part.endsWith("\x60")) {
          return '<code class="inline-code">' + escapeHtml(part.slice(1, -1)) + '</code>';
        }
        return escapeHtml(part);
      }).join("");
    }
    function renderTextParagraphs(value) {
      return String(value).split(/\\n{2,}/).filter(function (paragraph) { return paragraph.length > 0; }).map(function (paragraph) {
        return '<p>' + renderInlineCode(paragraph).replaceAll("\\n", "<br>") + '</p>';
      }).join("");
    }
    function renderRichText(value) {
      const source = String(value).replace(/\\r\\n?/g, "\\n");
      // Normal fenced Markdown is \`\`\`ts\\n…\`\`\`. Some generated packs
      // accidentally emit \`\`\` ts type Foo = …\`\`\` on one line; accept
      // that narrowly when the content begins like source code so it still
      // receives the readable, copyable code treatment instead of becoming a
      // long prose line.
      const fence = /\x60{3}[ \\t]*([A-Za-z0-9_+-]*)(?:[ \\t]*\\n|[ \\t]+(?=(?:const|let|var|type|interface|function|async|class|import|export|return|if|for|while|try|throw|new|await|Promise)\\b))([\\s\\S]*?)\x60{3}/g;
      let result = "";
      let cursor = 0;
      let match;
      while ((match = fence.exec(source)) !== null) {
        result += renderTextParagraphs(source.slice(cursor, match.index));
        const language = match[1] || "code";
        const code = match[2].replace(/\\n$/, "");
        result += '<section class="code-block" data-code-language="' + escapeHtml(language) + '"><div class="code-block-header"><span>' + escapeHtml(language.toUpperCase()) + '</span><button class="code-copy" type="button" data-code-copy>복사</button></div><pre><code>' + escapeHtml(code) + '</code></pre></section>';
        cursor = fence.lastIndex;
      }
      result += renderTextParagraphs(source.slice(cursor));
      return result || '<p></p>';
    }
    function renderQuestionPrompt(value) {
      const source = String(value).replace(/\\r\\n?/g, "\\n");
      const separator = /\\n{2,}/.exec(source);
      if (!separator) return { heading: renderInlineCode(source), detail: "" };
      const heading = source.slice(0, separator.index).trim();
      const detail = source.slice(separator.index + separator[0].length).trim();
      return {
        heading: renderInlineCode(heading),
        detail: detail ? '<div class="prompt-detail rich-text">' + renderRichText(detail) + '</div>' : "",
      };
    }
    function questionKey(question) { return "q:" + question.id; }
    function resolutionDefinition(resolution) {
      const canonicalResolution = resolution === "withdraw" ? "withdrawn" : resolution;
      const definitions = {
        answer: {
          label: "답변",
          summary: "질문에 대한 선택·근거를 기록",
          effect: "선택 또는 자유 답변이 완료 기록에 저장됩니다.",
        },
        defer: {
          label: "보류",
          summary: "유효하지만 지금은 답할 수 없음",
          effect: "미해결로 기록됩니다. 다음 팩에서 다시 볼 근거가 되지만, 자동으로 재질문되지는 않습니다.",
          noteLabel: "보류 메모 (필수)",
          notePlaceholder: "지금 보류하는 이유와 다시 확인할 단서를 함께 적으세요.\\n예: 실제 사용자 반응을 확인한 뒤 판단",
        },
        not_applicable: {
          label: "해당 없음",
          summary: "이번 결정·사람·범위에는 적용되지 않음",
          effect: "이번 팩의 범위 밖이라고 기록됩니다. 범위가 자동으로 바뀌거나 재질문되지는 않습니다.",
          noteLabel: "해당 없음 이유 (필수)",
          notePlaceholder: "이 질문이 이번 결정 범위에 적용되지 않는 이유를 적으세요.",
        },
        withdrawn: {
          label: "질문 철회",
          summary: "질문 자체가 중복·전제 오류·범위 오류",
          effect: "질문을 답하지 않기로 기록합니다. 기존 기록은 남고, 필요하면 다음 팩에 수정된 질문을 새로 추가합니다.",
          noteLabel: "철회 이유 (필수)",
          notePlaceholder: "질문 자체가 왜 잘못되었거나 중복되었는지 적으세요.",
        },
      };
      return definitions[canonicalResolution] || definitions.answer;
    }
    function topLevelResolutionDefinition(resolution) {
      const definitions = {
        answer: {
          label: "답변",
          summary: "질문에 대한 선택·근거를 기록",
        },
        defer: {
          label: "보류",
          summary: "지금은 답변을 확정하지 않음",
        },
      };
      return definitions[resolution] || definitions.answer;
    }
    function renderResolutionChoice(question, resolution, selected) {
      const definition = topLevelResolutionDefinition(resolution);
      return '<label class="resolution-choice' + (selected ? ' is-selected' : '') + '" data-resolution-choice="' + escapeHtml(question.id) + '" data-resolution="' + escapeHtml(resolution) + '"><input type="radio" name="resolution:' + escapeHtml(question.id) + '" value="' + escapeHtml(resolution) + '"' + (selected ? ' checked' : '') + '> <span class="resolution-choice-copy"><strong>' + escapeHtml(definition.label) + '</strong><span>' + escapeHtml(definition.summary) + '</span></span></label>';
    }
    function renderQuestion(question, index) {
      const prompt = renderQuestionPrompt(question.prompt);
      const optionInputType = question.selection_mode === "multiple" ? "checkbox" : "radio";
      const name = "option:" + question.id;
      const options = (question.options || []).map(function (option) {
        return '<label><input type="' + optionInputType + '" name="' + escapeHtml(name) + '" value="' + escapeHtml(option.id) + '"> ' + escapeHtml(option.label) + (option.recording_effect ? '<span class="option-effect"><strong>에이전트 검토 기준:</strong> ' + escapeHtml(option.recording_effect) + '</span>' : "") + '</label>';
      }).join("");
      const other = question.allow_other ? '<label><input type="' + optionInputType + '" name="' + escapeHtml(name) + '" value="__other"> 기타 / 직접 작성</label>' : "";
      const selectionHint = question.selection_mode === "multiple" ? '<p class="subtle">복수 선택 가능' + (question.allow_other ? ' · 기타를 다른 선택과 함께 고를 수 있습니다.' : "") + '</p>' : "";
      const freeText = '<label>답변<textarea data-answer-text="' + escapeHtml(question.id) + '" placeholder="자유롭게 작성하세요."></textarea></label>';
      const choice = '<div class="answer-inputs">' + selectionHint + options + other + (question.kind === "mixed" ? '<label>추가 설명 또는 자유 답변<textarea data-answer-text="' + escapeHtml(question.id) + '" placeholder="선택 이유, 실제 장면, 보류 사유 등을 작성하세요."></textarea></label>' : "") + (question.allow_other ? '<label data-other-for="' + escapeHtml(question.id) + '" hidden>기타 답변<textarea data-other-text="' + escapeHtml(question.id) + '" placeholder="직접 작성하세요."></textarea></label>' : "") + '</div>';
      const answerInputs = question.kind === "free_text" ? freeText : choice;
      const description = question.description ? '<div class="description rich-text">' + renderRichText(question.description) + '</div>' : "";
      const effect = question.answer_effect ? '<div class="effect rich-text"><strong>답변이 확인할 범위:</strong> ' + renderInlineCode(question.answer_effect) + '</div>' : "";
      const draft = question.draft_response ? '<p class="draft"><strong>근거 기반 초안 (선택 전):</strong>\\n' + escapeHtml(question.draft_response) + '</p>' : "";
      const resolutionChoices = ["answer", "defer"].map(function (resolution) { return renderResolutionChoice(question, resolution, resolution === "answer"); }).join("");
      const deferControls = '<div class="defer-panel" data-defer-panel="' + escapeHtml(question.id) + '" hidden><label class="defer-action"><span>보류 처리</span><select data-defer-action="' + escapeHtml(question.id) + '" aria-describedby="defer-action-help-' + escapeHtml(question.id) + '"><option value="defer">다음 팩에서 다시 질문</option><option value="not_applicable">이번 결정 범위에서 제외</option><option value="withdrawn">질문 자체를 철회</option></select></label><p id="defer-action-help-' + escapeHtml(question.id) + '" class="subtle">처리 방식은 완료 기록과 그래프에 남습니다. 자동으로 다음 질문을 만들거나 준비도를 바꾸지는 않습니다.</p><label class="field-note" data-note-for="' + escapeHtml(question.id) + '" hidden><span data-note-label="' + escapeHtml(question.id) + '"></span><textarea data-note-text="' + escapeHtml(question.id) + '"></textarea></label></div>';
      return '<article class="question" data-question="' + escapeHtml(question.id) + '"><div class="question-header"><span class="number">' + (index + 1) + '</span><div><h3>' + prompt.heading + '</h3></div></div>' + prompt.detail + description + effect + draft + '<fieldset><legend>현재 답변 상태</legend><div class="resolution-options">' + resolutionChoices + '</div><p class="resolution-common"><strong>보류:</strong> 아직 답을 확정하지 않을 때 선택하세요. 보류 처리에서 다음 팩에 다시 질문할지 정합니다.</p><div class="resolution-effect" data-resolution-effect="' + escapeHtml(question.id) + '" aria-live="polite"></div><div data-answer-for="' + escapeHtml(question.id) + '">' + answerInputs + '</div>' + deferControls + '</fieldset></article>';
    }
    questionContainer.innerHTML = seed.questions.map(renderQuestion).join("");
    function initializeCodeCopyControls() {
      questionContainer.querySelectorAll("[data-code-copy]").forEach(function (button) {
        button.addEventListener("click", async function () {
          const code = button.closest(".code-block")?.querySelector("code")?.textContent || "";
          if (!code || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
            button.textContent = "복사 불가";
            return;
          }
          try {
            await navigator.clipboard.writeText(code);
            button.textContent = "복사됨";
          } catch {
            button.textContent = "복사 실패";
          }
          window.setTimeout(function () { button.textContent = "복사"; }, 1_500);
        });
      });
    }
    initializeCodeCopyControls();
    function selectorEscape(value) { return CSS.escape(value); }
    function selectedResolution(question) { return form.querySelector('input[name="resolution:' + selectorEscape(question.id) + '"]:checked').value; }
    function selectedDeferAction(question) { const input = form.querySelector('[data-defer-action="' + selectorEscape(question.id) + '"]'); return input ? input.value : "defer"; }
    function effectiveResolution(question) { return selectedResolution(question) === "defer" ? selectedDeferAction(question) : "answer"; }
    function selectedOption(question) { const input = form.querySelector('input[name="option:' + selectorEscape(question.id) + '"]:checked'); return input ? input.value : undefined; }
    function selectedOptions(question) { return Array.from(form.querySelectorAll('input[name="option:' + selectorEscape(question.id) + '"]:checked')).map(function (input) { return input.value; }); }
    function hasOtherSelection(question) { return question.selection_mode === "multiple" ? selectedOptions(question).includes("__other") : selectedOption(question) === "__other"; }
    function textValue(prefix, questionId) { const input = form.querySelector(prefix + selectorEscape(questionId) + '"]'); return input ? input.value.trim() : ""; }
    function responseFor(question) {
      const resolution = effectiveResolution(question); const questionId = questionKey(question);
      const note = textValue('[data-note-text="', question.id);
      if (resolution !== "answer") {
        const response = { question_id: questionId, resolution: resolution };
        if (resolution === "defer" && note) response.deferral = { reason: note };
        if (resolution === "not_applicable" && note) response.not_applicable = { reason: note };
        if (resolution === "withdrawn" && note) response.withdrawal = { reason: note };
        return response;
      }
      const answer = {}; const text = textValue('[data-answer-text="', question.id); const otherText = textValue('[data-other-text="', question.id);
      if (question.selection_mode === "multiple") { const ids = selectedOptions(question).filter(function (value) { return value !== "__other"; }); if (ids.length) answer.option_ids = ids; if (selectedOptions(question).includes("__other")) answer.other_text = otherText; }
      else { const option = selectedOption(question); if (option && option !== "__other") answer.option_id = option; if (option === "__other") answer.other_text = otherText; }
      if (text) answer.text = text;
      return { question_id: questionId, resolution: resolution, answer: answer };
    }
    function draftFor(question) {
      const response = { question_id: questionKey(question), resolution: effectiveResolution(question) };
      if (question.selection_mode === "multiple") { const selections = selectedOptions(question); if (selections.length) response.selections = selections; } else { const selection = selectedOption(question); if (selection) response.selection = selection; }
      const values = [["text", '[data-answer-text="'], ["other_text", '[data-other-text="'], ["note", '[data-note-text="']];
      values.forEach(function (pair) { const value = textValue(pair[1], question.id); if (value) response[pair[0]] = value; });
      return response;
    }
    function updateVisibility(question) {
      const topLevelResolution = selectedResolution(question); const resolution = effectiveResolution(question); const definition = resolutionDefinition(resolution); const answer = form.querySelector('[data-answer-for="' + selectorEscape(question.id) + '"]'); const deferPanel = form.querySelector('[data-defer-panel="' + selectorEscape(question.id) + '"]'); const note = form.querySelector('[data-note-for="' + selectorEscape(question.id) + '"]'); const noteLabel = form.querySelector('[data-note-label="' + selectorEscape(question.id) + '"]'); const noteInput = form.querySelector('[data-note-text="' + selectorEscape(question.id) + '"]'); const resolutionEffect = form.querySelector('[data-resolution-effect="' + selectorEscape(question.id) + '"]');
      answer.hidden = topLevelResolution !== "answer"; if (deferPanel) deferPanel.hidden = topLevelResolution !== "defer"; note.hidden = topLevelResolution !== "defer";
      if (resolutionEffect) { resolutionEffect.replaceChildren(); const title = document.createElement("strong"); const detail = document.createElement("span"); title.textContent = definition.label + " — " + definition.summary; detail.textContent = definition.effect; resolutionEffect.append(title, detail); }
      if (noteLabel) noteLabel.textContent = definition.noteLabel || "";
      if (noteInput) { noteInput.placeholder = definition.notePlaceholder || ""; noteInput.required = false; if (topLevelResolution === "defer") noteInput.setAttribute("aria-required", "true"); else noteInput.removeAttribute("aria-required"); noteInput.removeAttribute("aria-invalid"); }
      form.querySelectorAll('[data-resolution-choice="' + selectorEscape(question.id) + '"]').forEach(function (choice) { choice.classList.toggle("is-selected", choice.dataset.resolution === topLevelResolution); });
      const other = form.querySelector('[data-other-for="' + selectorEscape(question.id) + '"]'); if (other) other.hidden = !(topLevelResolution === "answer" && hasOtherSelection(question));
    }
    function updatePreview() { preview.textContent = JSON.stringify({ responses: seed.questions.map(responseFor) }, null, 2); }
    function setAutosaveStatus(message, failed) { autosaveStatus.textContent = message; autosaveStatus.classList.toggle("error", Boolean(failed)); }
    function showDurabilityReceipt(body) { const warnings = Array.isArray(body && body.durability_warnings) ? body.durability_warnings : []; if ((!body || !body.storage_health || body.storage_health.status === "healthy") && warnings.length === 0) return; durabilityAlert.hidden = false; durabilityAlert.textContent = "변경 사항은 라이브 워크스페이스에 저장되었지만 복구 내구성 경고가 있습니다. 채팅에서 storage_health와 durability_warnings를 확인하세요."; }
    function restoreDraft() {
      const responses = Array.isArray(initialDraft.responses) ? initialDraft.responses : []; const questions = new Map(seed.questions.map(function (question) { return [questionKey(question), question]; }));
      responses.forEach(function (response) { const question = questions.get(response.question_id); if (!question) return; const persistedResolution = response.resolution === "withdraw" ? "withdrawn" : response.resolution; const resolution = persistedResolution === "answer" ? "answer" : "defer"; const resolutionInput = form.querySelector('input[name="resolution:' + selectorEscape(question.id) + '"][value="' + selectorEscape(resolution) + '"]'); if (resolutionInput) resolutionInput.checked = true; const deferAction = form.querySelector('[data-defer-action="' + selectorEscape(question.id) + '"]'); if (deferAction && resolution === "defer") deferAction.value = persistedResolution === "defer" ? "defer" : persistedResolution;
        const selections = question.selection_mode === "multiple" ? response.selections : response.selection ? [response.selection] : []; (Array.isArray(selections) ? selections : []).forEach(function (selection) { const option = form.querySelector('input[name="option:' + selectorEscape(question.id) + '"][value="' + selectorEscape(selection) + '"]'); if (option) option.checked = true; });
        const restoredNote = persistedResolution === "defer" && typeof response.clue === "string" && response.clue.trim() ? [response.note, "다시 볼 조건: " + response.clue].filter(function (value) { return typeof value === "string" && value.trim(); }).join("\\n") : response.note; [[ '[data-answer-text="', response.text ], [ '[data-other-text="', response.other_text ], [ '[data-note-text="', restoredNote ]].forEach(function (pair) { const input = form.querySelector(pair[0] + selectorEscape(question.id) + '"]'); if (input && typeof pair[1] === "string") input.value = pair[1]; });
      }); return responses.length > 0;
    }
    function saveDraftSoon(delay) { if (completed) return; draftGeneration += 1; clearTimeout(saveTimer); setAutosaveStatus("자동 저장 대기 중"); saveTimer = setTimeout(function () { void saveDraft(); }, delay === undefined ? AUTOSAVE_DELAY_MS : delay); }
    async function saveDraft() { if (completed || savingDraft) return; clearTimeout(saveTimer); const generation = draftGeneration; savingDraft = true; setAutosaveStatus("자동 저장 중"); try { const response = await fetch("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: initialStatus.revision, responses: seed.questions.map(draftFor) }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "자동 저장에 실패했습니다."); showDurabilityReceipt(body); if (generation === draftGeneration) setAutosaveStatus(body.storage_health && body.storage_health.status === "degraded" ? "원장 저장됨 · 복구 복제본 점검 필요" : "자동 저장됨", body.storage_health && body.storage_health.status === "degraded"); } catch (caught) { if (!completed) setAutosaveStatus(caught instanceof Error ? "자동 저장 실패: " + caught.message : "자동 저장에 실패했습니다.", true); } finally { savingDraft = false; if (!completed && generation !== draftGeneration) saveDraftSoon(0); } }
    function setUiStateStatus(message, failed) { uiStateStatus.textContent = message; uiStateStatus.classList.toggle("error", Boolean(failed)); }
    function uiStatePayload() { return { score_details_open: document.getElementById("score-graph").open, graph_legend_open: document.getElementById("graph-legend").open, graph_json_open: document.getElementById("graph-json-details").open, graph_view: graphView, graph_filter: graphFilter, collapsed_graph_types: Array.from(collapsedGraphTypes).sort(), selected_node_id: selectedGraphNodeId, graph_viewport: graphViewport && graphViewportLayoutKey ? { layout_key: graphViewportLayoutKey, x: graphViewport.x, y: graphViewport.y, width: graphViewport.width, height: graphViewport.height } : null }; }
    function restoreUiState() { if (!initialUiState || initialUiState.workspace_revision !== initialStatus.revision || initialUiState.ledger_revision !== initialStatus.ledger_revision) return false; graphView = initialUiState.graph_view; graphFilter = initialUiState.graph_filter; collapsedGraphTypes = new Set(initialUiState.collapsed_graph_types || []); selectedGraphNodeId = initialUiState.selected_node_id || null; if (initialUiState.graph_viewport) { graphViewport = { x: initialUiState.graph_viewport.x, y: initialUiState.graph_viewport.y, width: initialUiState.graph_viewport.width, height: initialUiState.graph_viewport.height }; graphViewportLayoutKey = initialUiState.graph_viewport.layout_key; } document.getElementById("score-graph").open = initialUiState.score_details_open; document.getElementById("graph-legend").open = initialUiState.graph_legend_open; document.getElementById("graph-json-details").open = initialUiState.graph_json_open; return true; }
    function saveUiStateSoon(delay) { uiStateGeneration += 1; clearTimeout(uiStateSaveTimer); setUiStateStatus("화면 상태 저장 대기 중"); uiStateSaveTimer = setTimeout(function () { void saveUiState(); }, delay === undefined ? UI_STATE_SAVE_DELAY_MS : delay); }
    async function saveUiState() { if (savingUiState) return; clearTimeout(uiStateSaveTimer); const generation = uiStateGeneration; savingUiState = true; setUiStateStatus("화면 상태 저장 중"); try { const response = await fetch("/api/ui-state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: initialStatus.revision, ledger_revision: uiStateLedgerRevision, ui_state: uiStatePayload() }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "화면 상태 저장에 실패했습니다."); showDurabilityReceipt(body); if (generation === uiStateGeneration) setUiStateStatus(body.storage_health && body.storage_health.status === "degraded" ? "화면 저장됨 · 복구 복제본 점검 필요" : "화면 상태 저장됨", body.storage_health && body.storage_health.status === "degraded"); } catch (caught) { setUiStateStatus(caught instanceof Error ? "화면 상태 저장 실패: " + caught.message : "화면 상태 저장에 실패했습니다.", true); } finally { savingUiState = false; if (generation !== uiStateGeneration) saveUiStateSoon(0); } }
    function svgElement(name, attributes) { const element = document.createElementNS("http://www.w3.org/2000/svg", name); Object.entries(attributes || {}).forEach(function (entry) { element.setAttribute(entry[0], String(entry[1])); }); return element; }
    function resolutionLabel(resolution) { return resolutionDefinition(resolution).label; }
    function answerText(response) { const question = seed.questions.find(function (entry) { return questionKey(entry) === response.question_id; }); const prompt = question ? question.prompt : response.question_id; if (response.resolution !== "answer") { const source = response.resolution === "defer" ? response.deferral : response.resolution === "not_applicable" ? response.not_applicable : response.withdrawal; const parts = [resolutionLabel(response.resolution)]; if (source && source.reason) parts.push((response.resolution === "defer" ? "보류 메모: " : "이유: ") + source.reason); if (response.resolution === "defer" && source && source.clue) parts.push("다시 볼 조건: " + source.clue); return prompt + ": " + parts.join(" · "); } const answer = response.answer || {}; const selected = []; if (answer.option_id && question) { const option = question.options.find(function (entry) { return entry.id === answer.option_id; }); if (option) selected.push(option.label); } (answer.option_ids || []).forEach(function (id) { const option = question && question.options.find(function (entry) { return entry.id === id; }); if (option) selected.push(option.label); }); if (answer.other_text) selected.push("기타: " + answer.other_text); if (answer.text) selected.push(answer.text); return prompt + ": " + selected.join(" · "); }
    function renderAnswerSummary(completion) { const section = document.getElementById("answer-summary"); const list = document.getElementById("answer-summary-list"); list.replaceChildren(); const responses = completion && completion.normalized_response_patch && Array.isArray(completion.normalized_response_patch.responses) ? completion.normalized_response_patch.responses : []; section.hidden = responses.length === 0; responses.forEach(function (response) { const item = document.createElement("li"); item.textContent = answerText(response); list.appendChild(item); }); }
    function displayHeuristicScore(value) { return typeof value === "number" ? String(value) + " / 100" : String(value); }
    function renderScoreChange(change) { const section = document.getElementById("latest-score-change"); section.replaceChildren(); const title = document.createElement("strong"); title.textContent = "최근 준비도 변화"; section.appendChild(title); const first = document.createElement("p"); const detail = document.createElement("p"); detail.className = "subtle"; const meta = document.createElement("p"); meta.className = "subtle"; if (!change || typeof change !== "object") { first.textContent = "아직 명시적 원장 항목 변화가 없습니다. 답변 저장만으로 점수는 추정하지 않습니다."; section.appendChild(first); return; } first.textContent = displayHeuristicScore(change.previous_value ?? "N/A") + " → " + displayHeuristicScore(change.next_value ?? "N/A"); detail.textContent = change.explanation || "원장 항목이 변경되어 재계산되었습니다."; const affected = Array.isArray(change.affected_item_ids) && change.affected_item_ids.length ? change.affected_item_ids.join(", ") : "범위 또는 평가 가능 항목"; meta.textContent = "규칙: " + (change.rule_id || "unknown") + " · 영향 항목: " + affected; section.append(first, detail, meta); }
    function renderMaterialItems(items) { const list = document.getElementById("material-summary-list"); list.replaceChildren(); if (!Array.isArray(items) || items.length === 0) { const empty = document.createElement("li"); empty.textContent = "명시적 점수 항목이 없습니다. 준비도와 남은 불확실성은 N/A입니다."; list.appendChild(empty); return; } items.slice().sort(function (left, right) { return left.id.localeCompare(right.id); }).forEach(function (entry) { const item = document.createElement("li"); item.textContent = entry.id + " · " + entry.component + " · " + entry.status + " · 영향 " + entry.impact + (entry.inference_flagged ? " · 추론 오류 표시됨" : ""); list.appendChild(item); }); }
    function graphLabel(node, completion) { if (completion && node.id === "event:" + completion.provenance_event_id) { const responses = completion.normalized_response_patch && completion.normalized_response_patch.responses || []; return "답변 완료 · " + responses.length + "개"; } if (node.type === "answer" && node.resolution) return resolutionLabel(node.resolution); return node.label || node.id; }
    function shortGraphLabel(node, completion, limit) { const label = graphLabel(node, completion); return label.length > limit ? label.slice(0, Math.max(1, limit - 1)) + "…" : label; }
    function graphTypeLabel(type) { return ({ decision: "결정", score: "준비도", question: "질문", answer: "답변", event: "이벤트", blocker: "차단점", assumption: "가정", evidence: "근거", contradiction: "반증", candidate: "후보" })[type] || type; }
    function graphEdgeLabel(type) { return ({ asks: "질문", tracks: "원장 추적", supports: "근거", blocks: "차단", assumes: "가정", contradicts: "반증", records: "기록", answers: "답변", defers: "보류", marks_not_applicable: "범위 밖", withdraws: "질문 철회", affects: "변경", reopens: "재개", resolves: "해결", flags: "오류 표시", introduces: "질문 추가", scored_as: "준비도", affects_score: "준비도 계산 입력" })[type] || type; }
    function isMaterialGraphNode(node) { return ["blocker", "assumption", "evidence", "contradiction", "candidate"].includes(node.type); }
    function graphNodeColor(node) { return ({ decision: "#1d63d6", score: "#167c62", question: "#4773ba", answer: "#7657a5", event: "#8791a5", blocker: "#b42318", assumption: "#b54708", evidence: "#0f766e", contradiction: "#a21caf", candidate: "#6d28d9" })[node.type] || "#64748b"; }
    function graphStatusColor(node) {
      if (node.inference_flagged) return "#b42318";
      if (!node.status) return graphNodeColor(node);
      if (["verified", "resolved", "validated", "frozen", "archived"].includes(node.status)) return "#16845b";
      if (["corroborated", "mitigated", "partial", "planned", "investigating", "active"].includes(node.status)) return "#b7791f";
      return "#c2413d";
    }
    function graphNodePreview(node, completion) {
      const parts = [graphTypeLabel(node.type), graphLabel(node, completion)];
      if (node.status) parts.push("상태 " + node.status);
      if (node.impact !== undefined) parts.push("영향 " + node.impact);
      if (node.value !== undefined) parts.push("값 " + node.value);
      if (node.inference_flagged) parts.push("추론 오류 표시");
      return parts.join(" · ");
    }
    function graphScoreRelatedIds(edges) { return new Set(edges.filter(function (edge) { return edge.type === "affects_score"; }).map(function (edge) { return edge.from; })); }
    function graphNeedsAttention(node, scoreRelatedIds) {
      if (!isMaterialGraphNode(node)) return false;
      if (node.inference_flagged) return true;
      const fullyCredited = { evidence: "verified", blocker: "resolved", assumption: "validated", contradiction: "resolved" };
      if (scoreRelatedIds.has(node.id) && fullyCredited[node.type] !== node.status) return true;
      return node.type === "candidate" && ["emerging", "active", "reopened"].includes(node.status);
    }
    function isPrimaryGraphEdge(edge) { return ["supports", "blocks", "assumes", "contradicts", "answers", "defers", "marks_not_applicable", "withdraws", "scored_as", "affects_score"].includes(edge.type); }
    function isFocusGraphEdge(edge) { return isPrimaryGraphEdge(edge) || ["asks", "tracks"].includes(edge.type); }
    function graphNodeSort(left, right) { const priority = { decision: 0, question: 1, blocker: 2, assumption: 3, evidence: 4, contradiction: 5, candidate: 6, answer: 7, event: 8, score: 9 }; const difference = (priority[left.type] ?? 99) - (priority[right.type] ?? 99); return difference || left.id.localeCompare(right.id); }
    function currentQuestionNodeIds() { return new Set(seed.questions.map(function (question) { return "question:" + question.id; })); }
    function buildFocusGraph(graph) {
      const allNodes = graph.nodes || []; const allEdges = graph.edges || []; const scoreRelatedIds = graphScoreRelatedIds(allEdges); const selected = new Set();
      allNodes.forEach(function (node) { if (node.type === "decision" || node.type === "score") selected.add(node.id); });
      currentQuestionNodeIds().forEach(function (id) { selected.add(id); });
      const attention = allNodes.filter(function (node) { return graphNeedsAttention(node, scoreRelatedIds); }); attention.forEach(function (node) { selected.add(node.id); });
      // Focus intentionally keeps only this pack's questions. A score-related
      // historical item can point to an old question, but following that edge
      // here would turn a "current action" view back into the full history.
      const nodes = allNodes.filter(function (node) { return selected.has(node.id); }).sort(graphNodeSort);
      const visible = new Set(nodes.map(function (node) { return node.id; }));
      const edges = allEdges.filter(function (edge) { return visible.has(edge.from) && visible.has(edge.to) && isFocusGraphEdge(edge); });
      return { nodes: nodes, edges: edges, attention_count: attention.length, current_question_count: Array.from(currentQuestionNodeIds()).filter(function (id) { return visible.has(id); }).length };
    }
    function addContextQuestions(selected, allEdges) {
      allEdges.forEach(function (edge) {
        if (!isFocusGraphEdge(edge)) return;
        if (selected.has(edge.from) && edge.to.startsWith("question:")) selected.add(edge.to);
        if (selected.has(edge.to) && edge.from.startsWith("question:")) selected.add(edge.from);
      });
    }
    function buildOverviewGraph(graph, filter, collapsedTypes) {
      const allNodes = graph.nodes || []; const allEdges = graph.edges || []; const scoreRelatedIds = graphScoreRelatedIds(allEdges); let selected;
      if (filter === "all" || filter === "history") selected = new Set(allNodes.map(function (node) { return node.id; }));
      else {
        selected = new Set(allNodes.filter(function (node) {
          if (node.type === "decision" || node.type === "score") return true;
          if (filter === "score") return scoreRelatedIds.has(node.id);
          return graphNeedsAttention(node, scoreRelatedIds);
        }).map(function (node) { return node.id; }));
        addContextQuestions(selected, allEdges);
      }
      const sourceNodes = allNodes.filter(function (node) { return selected.has(node.id); }).sort(graphNodeSort);
      const nodes = sourceNodes.filter(function (node) { return !collapsedTypes.has(node.type); });
      const include = filter === "history" ? function () { return true; } : filter === "all" ? isPrimaryGraphEdge : isFocusGraphEdge;
      const edges = allEdges.filter(function (edge) { return selected.has(edge.from) && selected.has(edge.to) && include(edge); });
      const visibleIds = new Set(nodes.map(function (node) { return node.id; }));
      const visibleEdges = edges.filter(function (edge) { return visibleIds.has(edge.from) && visibleIds.has(edge.to); });
      const collapsedNodeCount = sourceNodes.length - nodes.length;
      const collapsedEdgeCount = edges.length - visibleEdges.length;
      return { nodes: nodes, edges: visibleEdges, source_nodes: sourceNodes, source_edges: edges, total_node_count: allNodes.length, total_edge_count: allEdges.length, collapsed_node_count: collapsedNodeCount, collapsed_edge_count: collapsedEdgeCount };
    }
    function spacedY(index, count, height) { if (count <= 1) return Math.round(height / 2); return 66 + Math.round(index * ((height - 132) / (count - 1))); }
    function focusLayout(nodes) {
      const questions = nodes.filter(function (node) { return node.type === "question"; }); const materials = nodes.filter(isMaterialGraphNode); const other = nodes.filter(function (node) { return !["decision", "score", "question"].includes(node.type) && !isMaterialGraphNode(node); }); const rows = Math.max(questions.length, materials.length, other.length, 1); const height = Math.max(320, 124 + rows * 64); const positions = new Map();
      nodes.filter(function (node) { return node.type === "decision"; }).forEach(function (node) { positions.set(node.id, { x: 94, y: Math.round(height / 2) }); });
      nodes.filter(function (node) { return node.type === "score"; }).forEach(function (node) { positions.set(node.id, { x: 910, y: Math.round(height / 2) }); });
      questions.forEach(function (node, index) { positions.set(node.id, { x: 325, y: spacedY(index, questions.length, height) }); });
      materials.forEach(function (node, index) { positions.set(node.id, { x: 622, y: spacedY(index, materials.length, height) }); });
      other.forEach(function (node, index) { positions.set(node.id, { x: 780, y: spacedY(index, other.length, height) }); });
      return { width: 1000, height: height, positions: positions };
    }
    function overviewLayout(selectedNodes, allNodes, collapsedTypes) {
      const lanes = [
        { type: "decision", label: "결정", x: 62, columns: 1, step: 0 },
        { type: "question", label: "질문", x: 158, columns: 2, step: 42 },
        { type: "evidence", label: "근거", x: 280, columns: 1, step: 0 },
        { type: "blocker", label: "차단점", x: 365, columns: 1, step: 0 },
        { type: "assumption", label: "가정", x: 450, columns: 1, step: 0 },
        { type: "contradiction", label: "반증", x: 535, columns: 1, step: 0 },
        { type: "candidate", label: "후보", x: 620, columns: 1, step: 0 },
        { type: "answer", label: "답변", x: 710, columns: 2, step: 38 },
        { type: "event", label: "이력", x: 835, columns: 7, step: 34 },
        { type: "score", label: "준비도", x: 1110, columns: 1, step: 0 },
      ];
      const buckets = new Map(lanes.map(function (lane) { return [lane.type, selectedNodes.filter(function (node) { return node.type === lane.type; }).sort(function (left, right) { return left.id.localeCompare(right.id); })]; }));
      const totalBuckets = new Map(lanes.map(function (lane) { return [lane.type, allNodes.filter(function (node) { return node.type === lane.type; }).sort(function (left, right) { return left.id.localeCompare(right.id); })]; }));
      const visibleBuckets = new Map(lanes.map(function (lane) { return [lane.type, (buckets.get(lane.type) || []).filter(function (node) { return !collapsedTypes.has(node.type); })]; }));
      const maxRows = Math.max(1, ...lanes.map(function (lane) { return Math.ceil((visibleBuckets.get(lane.type) || []).length / lane.columns); })); const height = Math.max(360, 86 + maxRows * 30); const positions = new Map();
      lanes.forEach(function (lane) { const nodes = visibleBuckets.get(lane.type) || []; nodes.forEach(function (node, index) { const row = Math.floor(index / lane.columns); const column = index % lane.columns; const x = lane.x + column * lane.step; const y = lane.type === "decision" || lane.type === "score" ? Math.round(height / 2) : 58 + row * 30; positions.set(node.id, { x: x, y: y }); }); });
      return { width: 1180, height: height, positions: positions, lanes: lanes, buckets: buckets, totalBuckets: totalBuckets, visibleBuckets: visibleBuckets };
    }
    function appendArrowDefinition(svg) { const defs = svgElement("defs"); const marker = svgElement("marker", { id: "graph-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" }); marker.appendChild(svgElement("path", { d: "M 0 0 L 8 4 L 0 8 z", fill: "#95a4ba" })); defs.appendChild(marker); svg.appendChild(defs); }
    function graphEdgeStyle(edge, history) {
      const styles = { supports: ["#227c61", 1.9, ""], blocks: ["#b42318", 2.1, ""], assumes: ["#b7791f", 1.8, "4 2"], contradicts: ["#a21caf", 2.1, ""], answers: ["#536fae", 1.7, ""], defers: ["#b7791f", 1.8, "4 2"], marks_not_applicable: ["#64748b", 1.5, "3 3"], withdraws: ["#b42318", 1.6, "2 3"], scored_as: ["#167c62", 2.1, ""], affects_score: ["#0f766e", 2.1, "5 3"], asks: ["#94a3b8", 1.1, "3 3"], tracks: ["#c1cad7", 1.0, "2 4"], records: ["#c1cad7", 1.0, "2 4"], affects: ["#c1cad7", 1.0, "2 4"], reopens: ["#c2413d", 1.4, "4 2"], resolves: ["#16845b", 1.4, "4 2"], flags: ["#b42318", 1.5, "4 2"], introduces: ["#c1cad7", 1.0, "2 4"] }; const style = styles[edge.type] || ["#c1cad7", 1.0, "2 4"]; return { stroke: style[0], width: style[1], dash: style[2], opacity: history && !isPrimaryGraphEdge(edge) ? 0.34 : isPrimaryGraphEdge(edge) ? 0.88 : 0.6 };
    }
    function renderGraphEdges(svg, edges, positions, history) { edges.forEach(function (edge) { const from = positions.get(edge.from); const to = positions.get(edge.to); if (!from || !to) return; const style = graphEdgeStyle(edge, history); const line = svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: style.stroke, "stroke-width": style.width, "stroke-dasharray": style.dash, opacity: style.opacity, "marker-end": "url(#graph-arrow)", "aria-hidden": "true", "pointer-events": "none", "data-edge-type": edge.type }); const title = svgElement("title"); title.textContent = graphEdgeLabel(edge.type); line.appendChild(title); svg.appendChild(line); }); }
    function isCollapsibleGraphType(type) { return !["decision", "score"].includes(type); }
    function renderGraphLaneHeaders(svg, layout, visibleIds, collapsedTypes, onToggle) { layout.lanes.forEach(function (lane) { const bucket = layout.buckets.get(lane.type) || []; const totalBucket = layout.totalBuckets.get(lane.type) || []; const visibleCount = bucket.filter(function (node) { return visibleIds.has(node.id); }).length; const total = totalBucket.length; const collapsed = collapsedTypes.has(lane.type); const selectedCount = bucket.length; const count = selectedCount === total ? String(total) : String(selectedCount) + "/" + total; const label = lane.label + " " + count + (collapsed && selectedCount > 0 ? " · 접힘" : ""); const x = lane.x + ((lane.columns - 1) * lane.step) / 2; const clickable = isCollapsibleGraphType(lane.type) && selectedCount > 0; const group = svgElement("g", { "data-graph-lane": lane.type, cursor: clickable ? "pointer" : "default" }); if (clickable) { group.setAttribute("role", "button"); group.setAttribute("tabindex", "0"); group.setAttribute("aria-expanded", String(!collapsed)); group.setAttribute("aria-label", lane.label + " 묶음 " + (collapsed ? "펼치기" : "접기") + ", " + selectedCount + "개 표시 대상"); }
      const width = Math.max(58, 18 + label.length * 7); group.appendChild(svgElement("rect", { x: x - width / 2, y: 7, width: width, height: 24, rx: 8, fill: collapsed ? "#eef4ff" : "transparent", stroke: collapsed ? "#94b8f4" : "transparent", "stroke-width": 1 })); const text = svgElement("text", { x: x, y: 23, fill: collapsed ? "#0e4ba2" : "#55657d", "text-anchor": "middle", "font-size": 11, "font-weight": 700, "pointer-events": "none" }); text.textContent = label; group.appendChild(text); const title = svgElement("title"); title.textContent = clickable ? lane.label + " " + (collapsed ? "펼치기" : "접기") + " · 화면 상태만 바뀌며 원장 데이터는 유지됩니다." : label; group.appendChild(title); if (clickable) { const activate = function () { onToggle(lane.type); }; group.addEventListener("click", activate); group.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } }); } svg.appendChild(group); }); }
    function graphLayoutKey(layout) { return layout.width + "x" + layout.height; }
    function resetGraphViewport() { graphViewport = null; graphViewportLayoutKey = ""; activeGraphLayout = null; activeGraphSvg = null; }
    function clampGraphViewport(viewport, layout) { const width = Math.min(layout.width, Math.max(layout.width * 0.24, viewport.width)); const height = layout.height * (width / layout.width); const maxX = Math.max(0, layout.width - width); const maxY = Math.max(0, layout.height - height); return { x: Math.min(maxX, Math.max(0, viewport.x)), y: Math.min(maxY, Math.max(0, viewport.y)), width: width, height: height }; }
    function ensureGraphViewport(layout) { const key = graphLayoutKey(layout); if (!graphViewport || graphViewportLayoutKey !== key) { graphViewport = { x: 0, y: 0, width: layout.width, height: layout.height }; graphViewportLayoutKey = key; } graphViewport = clampGraphViewport(graphViewport, layout); return graphViewport; }
    function updateGraphNavigationStatus(layout) { const status = document.getElementById("graph-navigation-status"); if (!layout || !graphViewport) { status.textContent = "100%"; return; } status.textContent = Math.round((layout.width / graphViewport.width) * 100) + "%"; }
    function applyGraphViewport(svg, layout) { const viewport = ensureGraphViewport(layout); svg.setAttribute("viewBox", viewport.x + " " + viewport.y + " " + viewport.width + " " + viewport.height); updateGraphNavigationStatus(layout); }
    function zoomGraphViewport(layout, multiplier, anchorX, anchorY) { const current = ensureGraphViewport(layout); const nextWidth = Math.min(layout.width, Math.max(layout.width * 0.24, current.width / multiplier)); const nextHeight = layout.height * (nextWidth / layout.width); const x = current.x + (current.width - nextWidth) * anchorX; const y = current.y + (current.height - nextHeight) * anchorY; graphViewport = clampGraphViewport({ x: x, y: y, width: nextWidth, height: nextHeight }, layout); if (activeGraphSvg) applyGraphViewport(activeGraphSvg, layout); saveUiStateSoon(); }
    function attachGraphNavigation(svg, layout) { let drag; const isInteractiveTarget = function (target) { return target instanceof Element && Boolean(target.closest("[data-graph-node], [data-graph-lane]")); }; svg.addEventListener("wheel", function (event) { if (!(event.ctrlKey || event.metaKey)) return; event.preventDefault(); const rect = svg.getBoundingClientRect(); const x = rect.width ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0.5; const y = rect.height ? Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) : 0.5; zoomGraphViewport(layout, Math.exp(-event.deltaY * 0.002), x, y); }, { passive: false }); svg.addEventListener("pointerdown", function (event) { if (event.button !== 0 || isInteractiveTarget(event.target)) return; const rect = svg.getBoundingClientRect(); const viewport = ensureGraphViewport(layout); drag = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: viewport.x, y: viewport.y, unitX: rect.width ? viewport.width / rect.width : 1, unitY: rect.height ? viewport.height / rect.height : 1 }; svg.setPointerCapture(event.pointerId); svg.style.cursor = "grabbing"; event.preventDefault(); }); svg.addEventListener("pointermove", function (event) { if (!drag || drag.pointerId !== event.pointerId) return; graphViewport = clampGraphViewport({ x: drag.x - (event.clientX - drag.clientX) * drag.unitX, y: drag.y - (event.clientY - drag.clientY) * drag.unitY, width: ensureGraphViewport(layout).width, height: ensureGraphViewport(layout).height }, layout); applyGraphViewport(svg, layout); }); const endDrag = function (event) { if (!drag || drag.pointerId !== event.pointerId) return; drag = undefined; svg.style.cursor = "grab"; if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId); saveUiStateSoon(); }; svg.addEventListener("pointerup", endDrag); svg.addEventListener("pointercancel", endDrag); }
    function updateGraphHover(node, completion) { document.getElementById("graph-hover").textContent = node ? graphNodePreview(node, completion) : "노드에 마우스를 올리거나 키보드로 선택하면 요약이 표시됩니다."; }
    function renderGraphInspector(graph, node, completion) {
      const section = document.getElementById("graph-inspector"); const title = document.getElementById("graph-inspector-title"); const label = document.getElementById("graph-inspector-label"); const meta = document.getElementById("graph-inspector-meta"); const relations = document.getElementById("graph-inspector-relations"); meta.replaceChildren(); relations.replaceChildren();
      if (!node) { section.hidden = true; return; }
      section.hidden = false; title.textContent = graphTypeLabel(node.type) + " 상세"; label.textContent = graphLabel(node, completion);
      const scoreRelated = graphScoreRelatedIds(graph.edges || []); const entries = [["ID", node.id], ["유형", graphTypeLabel(node.type)]]; if (node.status) entries.push(["상태", node.status]); if (node.impact !== undefined) entries.push(["영향", String(node.impact)]); if (node.value !== undefined) entries.push(["값", String(node.value)]); if (node.source) entries.push(["출처", node.source]); if (node.question_id) entries.push(["질문", node.question_id]); if (node.resolution) { const definition = resolutionDefinition(node.resolution); entries.push(["응답 상태", definition.label]); entries.push(["의미", definition.summary]); entries.push(["다음 동작", definition.effect]); } if (node.reason) entries.push([node.resolution === "defer" ? (node.reentry_clue ? "보류 이유" : "보류 메모") : "사유", node.reason]); if (node.reentry_clue) entries.push(["다시 볼 조건", node.reentry_clue]); if (scoreRelated.has(node.id)) entries.push(["준비도", "현재 계산 입력으로 연결됨"]); if (node.inference_flagged) entries.push(["검토", "추론 오류가 표시됨"]); entries.forEach(function (entry) { const term = document.createElement("dt"); const detail = document.createElement("dd"); term.textContent = entry[0]; detail.textContent = entry[1]; meta.append(term, detail); });
      const nodeById = new Map((graph.nodes || []).map(function (entry) { return [entry.id, entry]; })); const connected = (graph.edges || []).filter(function (edge) { return edge.from === node.id || edge.to === node.id; }); if (connected.length === 0) { const item = document.createElement("li"); item.textContent = "기록된 직접 관계가 없습니다."; relations.appendChild(item); return; } connected.slice(0, 12).forEach(function (edge) { const otherId = edge.from === node.id ? edge.to : edge.from; const other = nodeById.get(otherId); const item = document.createElement("li"); item.textContent = graphEdgeLabel(edge.type) + " · " + (other ? graphTypeLabel(other.type) + ": " + graphLabel(other, completion) : otherId); relations.appendChild(item); }); if (connected.length > 12) { const item = document.createElement("li"); item.textContent = "외 " + (connected.length - 12) + "개 관계는 Graph JSON에서 확인할 수 있습니다."; relations.appendChild(item); }
    }
    function attachGraphNodeEvents(group, node, graph, completion) {
      const activate = function () { selectedGraphNodeId = node.id; renderGraph(graph, completion); saveUiStateSoon(); };
      group.setAttribute("tabindex", "0"); group.setAttribute("role", "button"); group.setAttribute("aria-label", graphNodePreview(node, completion)); const title = svgElement("title"); title.textContent = graphNodePreview(node, completion) + " · 클릭하면 상세 고정"; group.appendChild(title);
      group.addEventListener("pointerenter", function () { updateGraphHover(node, completion); }); group.addEventListener("focus", function () { updateGraphHover(node, completion); }); group.addEventListener("pointerleave", function () { if (selectedGraphNodeId !== node.id) updateGraphHover(null, completion); }); group.addEventListener("click", activate); group.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } });
    }
    function renderFocusNode(svg, node, position, graph, completion) {
      const selected = selectedGraphNodeId === node.id; const group = svgElement("g", { transform: "translate(" + position.x + " " + position.y + ")", cursor: "pointer", "data-graph-node": node.id }); const fill = node.type === "decision" || node.type === "score" ? graphNodeColor(node) : "#f8fbff"; const stroke = selected ? "#0e4ba2" : node.type === "decision" || node.type === "score" ? fill : graphStatusColor(node); const textFill = node.type === "decision" || node.type === "score" ? "#ffffff" : "#1d355a"; group.appendChild(svgElement("rect", { x: -104, y: -28, width: 208, height: 56, rx: 11, fill: fill, stroke: stroke, "stroke-width": selected ? 3 : 1.7 })); const type = svgElement("text", { x: 0, y: -10, fill: textFill, "text-anchor": "middle", "font-size": 10, "font-weight": 750 }); type.textContent = graphTypeLabel(node.type); group.appendChild(type); const label = svgElement("text", { x: 0, y: 7, fill: textFill, "text-anchor": "middle", "font-size": 11 }); label.textContent = shortGraphLabel(node, completion, 34); group.appendChild(label); const detail = svgElement("text", { x: 0, y: 20, fill: textFill, "text-anchor": "middle", "font-size": 9 }); detail.textContent = node.status ? node.status : node.value !== undefined ? String(node.value) : ""; group.appendChild(detail); attachGraphNodeEvents(group, node, graph, completion); svg.appendChild(group); }
    function renderOverviewNode(svg, node, position, graph, completion) {
      const selected = selectedGraphNodeId === node.id; const group = svgElement("g", { transform: "translate(" + position.x + " " + position.y + ")", cursor: "pointer", "data-graph-node": node.id }); const fill = graphNodeColor(node); const stroke = selected ? "#0e4ba2" : isMaterialGraphNode(node) ? graphStatusColor(node) : fill; if (node.type === "decision" || node.type === "score") { group.appendChild(svgElement("rect", { x: -29, y: -14, width: 58, height: 28, rx: 8, fill: fill, stroke: selected ? "#0e4ba2" : fill, "stroke-width": selected ? 3 : 1.2 })); const text = svgElement("text", { x: 0, y: 4, fill: "#ffffff", "text-anchor": "middle", "font-size": 9, "font-weight": 750 }); text.textContent = node.type === "decision" ? "결정" : node.value !== undefined ? String(node.value) : "점수"; group.appendChild(text); } else { const radius = node.type === "event" ? 3.4 : isMaterialGraphNode(node) ? 6.4 : 4.5; group.appendChild(svgElement("circle", { cx: 0, cy: 0, r: radius, fill: fill, stroke: stroke, "stroke-width": selected ? 3 : isMaterialGraphNode(node) ? 2 : 1.1 })); } attachGraphNodeEvents(group, node, graph, completion); svg.appendChild(group); }
    function toggleGraphLane(type) { if (!isCollapsibleGraphType(type)) return; if (collapsedGraphTypes.has(type)) collapsedGraphTypes.delete(type); else collapsedGraphTypes.add(type); resetGraphViewport(); renderGraph(model.graph, graphCompletion); saveUiStateSoon(); }
    function toggleHistoryAnswerGroups() { const hasCollapsed = collapsedGraphTypes.has("answer") || collapsedGraphTypes.has("event"); if (hasCollapsed) { collapsedGraphTypes.delete("answer"); collapsedGraphTypes.delete("event"); } else { collapsedGraphTypes.add("answer"); collapsedGraphTypes.add("event"); } resetGraphViewport(); renderGraph(model.graph, graphCompletion); saveUiStateSoon(); }
    function updateGraphControls() { const isOverview = graphView === "overview"; graphViewButtons.forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.graphView === graphView)); }); graphFilterButtons.forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.graphFilter === graphFilter)); }); graphFilters.hidden = !isOverview; graphExplorerControls.hidden = !isOverview; graphNavigation.hidden = !isOverview; graphGroupButtons.forEach(function (button) { const historyCollapsed = collapsedGraphTypes.has("answer") || collapsedGraphTypes.has("event"); if (button.dataset.graphGroups === "history") { button.textContent = historyCollapsed ? "이력·답변 펼치기" : "이력·답변 접기"; button.setAttribute("aria-pressed", String(historyCollapsed)); } }); }
    function renderGraph(graph, completion) {
      const svg = document.getElementById("graph-svg"); const summary = document.getElementById("graph-summary"); svg.replaceChildren(); const allNodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []; const allEdges = graph && Array.isArray(graph.edges) ? graph.edges : []; updateGraphControls();
      if (allNodes.length === 0) { selectedGraphNodeId = null; renderGraphInspector({ nodes: [], edges: [] }, null, completion); summary.textContent = "표시할 그래프 항목이 아직 없습니다."; const text = svgElement("text", { x: 28, y: 48, fill: "#5b667a", "font-size": 14 }); text.textContent = "그래프 항목이 아직 없습니다."; svg.appendChild(text); return; }
      const view = graphView === "focus" ? buildFocusGraph({ nodes: allNodes, edges: allEdges }) : buildOverviewGraph({ nodes: allNodes, edges: allEdges }, graphFilter, collapsedGraphTypes); const visibleIds = new Set(view.nodes.map(function (node) { return node.id; })); if (selectedGraphNodeId && !visibleIds.has(selectedGraphNodeId)) selectedGraphNodeId = null;
      const layout = graphView === "focus" ? focusLayout(view.nodes) : overviewLayout(view.source_nodes, allNodes, collapsedGraphTypes); svg.style.height = layout.height + "px"; svg.setAttribute("role", "group"); svg.setAttribute("preserveAspectRatio", "xMidYMid meet"); svg.setAttribute("aria-label", graphView === "focus" ? "현재 판단 그래프" : "탐색 지도"); appendArrowDefinition(svg); svg.appendChild(svgElement("rect", { x: 0, y: 0, width: layout.width, height: layout.height, fill: "transparent", "data-graph-background": "true" }));
      if (graphView === "overview") { renderGraphLaneHeaders(svg, layout, visibleIds, collapsedGraphTypes, toggleGraphLane); renderGraphEdges(svg, view.edges, layout.positions, graphFilter === "history"); } else renderGraphEdges(svg, view.edges, layout.positions, false); view.nodes.forEach(function (node) { const position = layout.positions.get(node.id); if (!position) return; if (graphView === "focus") renderFocusNode(svg, node, position, { nodes: allNodes, edges: allEdges }, completion); else renderOverviewNode(svg, node, position, { nodes: allNodes, edges: allEdges }, completion); });
      if (graphView === "overview") { activeGraphLayout = layout; activeGraphSvg = svg; applyGraphViewport(svg, layout); attachGraphNavigation(svg, layout); } else { resetGraphViewport(); svg.setAttribute("viewBox", "0 0 " + layout.width + " " + layout.height); }
      const selectedNode = selectedGraphNodeId ? allNodes.find(function (node) { return node.id === selectedGraphNodeId; }) : null; renderGraphInspector({ nodes: allNodes, edges: allEdges }, selectedNode, completion); if (selectedNode) updateGraphHover(selectedNode, completion); else updateGraphHover(null, completion);
      const collapsedNote = graphView === "overview" && view.collapsed_node_count ? " 차선 접기로 " + view.collapsed_node_count + "개 노드와 " + view.collapsed_edge_count + "개 관계를 화면에서 숨겼습니다." : "";
      if (graphView === "focus") summary.textContent = "현재 질문 " + view.current_question_count + "개와 준비도 계산·미해결·활성 항목 " + view.attention_count + "개를 표시합니다. 전체 " + allNodes.length + "개 노드 중 나머지 항목과 이력은 탐색 지도에서 확인하세요.";
      else if (graphFilter === "history") summary.textContent = "탐색 지도 · " + view.nodes.length + "/" + allNodes.length + "개 노드와 " + view.edges.length + "/" + allEdges.length + "개 관계를 표시합니다. 이력 간선은 의사결정 근거가 아니라 변경·기록 경로입니다." + collapsedNote;
      else if (graphFilter === "all") summary.textContent = "탐색 지도 · " + view.nodes.length + "/" + allNodes.length + "개 노드를 표시합니다. 관계 " + view.edges.length + "/" + allEdges.length + "개는 현재 판단에 직접 읽을 수 있는 핵심 관계만 남겼습니다." + collapsedNote;
      else summary.textContent = "탐색 지도 · " + view.nodes.length + "/" + allNodes.length + "개 노드와 " + view.edges.length + "개 관련 관계를 표시합니다. 숨긴 항목은 선택한 필터에 해당하지 않습니다." + collapsedNote;
    }
    function renderModel(completion) { if (completion && completion.normalized_response_patch) graphCompletion = completion; const readiness = model.readiness === undefined ? null : model.readiness; const graph = model.graph === undefined ? null : model.graph; document.getElementById("readiness-json").textContent = JSON.stringify(readiness, null, 2); document.getElementById("graph-json").textContent = JSON.stringify(graph, null, 2); const candidates = readiness && typeof readiness === "object" ? [readiness.score, readiness.value, readiness.overall, readiness.readiness] : []; const score = candidates.find(function (value) { return typeof value === "number" || typeof value === "string"; }); document.getElementById("readiness-summary").textContent = score === undefined ? "결정 준비도: 해당 없음" : "결정 준비도 (heuristic): " + displayHeuristicScore(score); const burden = readiness && typeof readiness.unresolved_burden === "number" ? readiness.unresolved_burden : null; document.getElementById("uncertainty-summary").textContent = burden === null ? "남은 불확실성 (heuristic): N/A" : "남은 불확실성 (heuristic): " + displayHeuristicScore(burden); renderScoreChange(model.latest_score_change); renderGraph(graph, graphCompletion); renderAnswerSummary(completion && completion.normalized_response_patch ? completion : null); renderMaterialItems(model.material_items); }
    function showCompletion(completion, applyCompletionSnapshot) { if (applyCompletionSnapshot && completion) model = Object.assign({}, model, { readiness: completion.readiness || model.readiness, graph: completion.graph || model.graph }); completed = true; clearTimeout(saveTimer); form.hidden = true; complete.hidden = false; document.getElementById("phase-summary").textContent = "완료됨"; if (applyCompletionSnapshot) document.getElementById("score-graph").open = true; renderModel(completion); if (applyCompletionSnapshot) saveUiStateSoon(0); }
    graphViewButtons.forEach(function (button) { button.addEventListener("click", function () { graphView = button.dataset.graphView; selectedGraphNodeId = null; resetGraphViewport(); renderGraph(model.graph, graphCompletion); saveUiStateSoon(); }); });
    graphFilterButtons.forEach(function (button) { button.addEventListener("click", function () { graphView = "overview"; graphFilter = button.dataset.graphFilter; if (graphFilter === "history") collapsedGraphTypes.delete("event"); selectedGraphNodeId = null; resetGraphViewport(); renderGraph(model.graph, graphCompletion); saveUiStateSoon(); }); });
    graphGroupButtons.forEach(function (button) { button.addEventListener("click", function () { if (button.dataset.graphGroups === "history") toggleHistoryAnswerGroups(); else if (button.dataset.graphGroups === "expand") { collapsedGraphTypes.clear(); resetGraphViewport(); renderGraph(model.graph, graphCompletion); saveUiStateSoon(); } }); });
    graphZoomButtons.forEach(function (button) { button.addEventListener("click", function () { if (!activeGraphLayout || !activeGraphSvg) return; if (button.dataset.graphZoom === "reset") { graphViewport = { x: 0, y: 0, width: activeGraphLayout.width, height: activeGraphLayout.height }; graphViewportLayoutKey = graphLayoutKey(activeGraphLayout); applyGraphViewport(activeGraphSvg, activeGraphLayout); saveUiStateSoon(); return; } zoomGraphViewport(activeGraphLayout, button.dataset.graphZoom === "in" ? 1.35 : 1 / 1.35, 0.5, 0.5); }); });
    document.getElementById("graph-inspector-close").addEventListener("click", function () { selectedGraphNodeId = null; renderGraph(model.graph, graphCompletion); saveUiStateSoon(); });
    [document.getElementById("score-graph"), document.getElementById("graph-legend"), document.getElementById("graph-json-details")].forEach(function (details) { details.addEventListener("toggle", function () { saveUiStateSoon(); }); });
    const restored = restoreDraft(); seed.questions.forEach(function (question) { form.querySelectorAll('[name="resolution:' + selectorEscape(question.id) + '"], [name="option:' + selectorEscape(question.id) + '"], [data-defer-action="' + selectorEscape(question.id) + '"], [data-answer-text="' + selectorEscape(question.id) + '"], [data-other-text="' + selectorEscape(question.id) + '"], [data-note-text="' + selectorEscape(question.id) + '"]').forEach(function (element) { element.addEventListener("input", function () { updateVisibility(question); updatePreview(); saveDraftSoon(); }); element.addEventListener("change", function () { updateVisibility(question); updatePreview(); saveDraftSoon(); }); }); updateVisibility(question); });
    const restoredUiState = restoreUiState(); updatePreview(); renderModel(initialCompletion); if (restored && !completed) setAutosaveStatus("자동 저장된 초안을 복원했습니다."); if (restoredUiState) setUiStateStatus("저장된 화면 상태를 복원했습니다."); if (initialCompletion) showCompletion(initialCompletion, false);
    function responseIssue(question, response, index) {
      if (response.resolution === "answer") {
        const answer = response.answer || {};
        if (answer.option_id || (Array.isArray(answer.option_ids) && answer.option_ids.length) || answer.text || answer.other_text) return undefined;
        return { message: "질문 " + (index + 1) + "에 답변을 입력하거나 보류를 선택하세요." };
      }
      if (response.resolution === "defer") {
        if (!response.deferral || !response.deferral.reason) return { message: "질문 " + (index + 1) + "의 보류 메모를 적어주세요.", selector: '[data-note-text="' + selectorEscape(question.id) + '"]' };
        return undefined;
      }
      if (response.resolution === "not_applicable" && (!response.not_applicable || !response.not_applicable.reason)) {
        return { message: "질문 " + (index + 1) + "이 이번 범위에 해당하지 않는 이유를 적어주세요.", selector: '[data-note-text="' + selectorEscape(question.id) + '"]' };
      }
      if (response.resolution === "withdrawn" && (!response.withdrawal || !response.withdrawal.reason)) {
        return { message: "질문 " + (index + 1) + "을 철회하는 이유를 적어주세요.", selector: '[data-note-text="' + selectorEscape(question.id) + '"]' };
      }
      return undefined;
    }
    form.addEventListener("submit", async function (event) { event.preventDefault(); error.textContent = ""; const responses = seed.questions.map(responseFor); const issue = responses.map(function (response, index) { return responseIssue(seed.questions[index], response, index); }).find(Boolean); if (issue) { error.textContent = issue.message; if (issue.selector) { const input = form.querySelector(issue.selector); if (input) { input.setAttribute("aria-invalid", "true"); input.focus(); } } return; } completed = true; clearTimeout(saveTimer); submit.disabled = true; try { const response = await fetch("/api/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: initialStatus.revision, responses: responses }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "저장에 실패했습니다."); uiStateLedgerRevision = body.ledger_revision; showDurabilityReceipt(body); showCompletion(body.completion, true); } catch (caught) { error.textContent = caught instanceof Error ? caught.message : "저장에 실패했습니다."; submit.disabled = false; completed = false; } });
    setInterval(async function () { try { const response = await fetch("/api/status", { cache: "no-store" }); if (!response.ok) return; const status = await response.json(); if (status.revision !== initialStatus.revision || status.ledger_revision !== initialStatus.ledger_revision || status.phase !== initialStatus.phase) window.location.reload(); } catch {} }, 1000);
  </script>
</body>
</html>`;
}

/**
 * Run the loopback server for one workspace. The server never owns canonical
 * state in memory: every request re-reads workspace.json, which lets advance
 * replace the answer pack at the same URL from another CLI process.
 */
export async function serveWorkspace(root, workspace) {
  const directory = workspaceDirectory(root, workspace);
  const lockDirectory = recoveryDirectory(durableRecoveryRoot(root), workspace);
  const workspacePath = `/workspaces/${workspace}`;
  let server;
  let watcher;
  let closeReason;
  try {
    await ensurePrivateDirectory(lockDirectory);
    await readWorkspace(directory, workspace);
    server = createServer(async (request, response) => {
      try {
        if (!isLocalHostHeader(request.headers.host)) {
          sendJson(response, 403, { error: "loopback requests only" });
          return;
        }
        const url = new URL(request.url ?? "/", `http://${HOST}`);
        const state = await readWorkspace(directory, workspace);
        if (request.method === "GET" && url.pathname === workspacePath) {
          const snapshot = await snapshotForLedger(state.ledger);
          sendHtml(response, renderDocument({ ...state, storage_health: await verifyRecoveryReplica(root, workspace) }, snapshot));
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/status") {
          sendJson(response, 200, {
            ...currentSummary(state, await snapshotForLedger(state.ledger)),
            storage_health: await verifyRecoveryReplica(root, workspace),
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/ui-state") {
          const problem = mutationRequestProblem(request);
          if (problem) {
            sendJson(response, problem.status, { error: problem.error });
            return;
          }
          const payload = await requestBody(request);
          const result = await withWorkspaceLock(lockDirectory, async () => {
            const latest = await readWorkspace(directory, workspace);
            await requireHealthyMutationBase(root, workspace);
            if (!isPlainObject(payload)
              || payload.revision !== latest.current.revision
              || payload.ledger_revision !== latest.ledger.revision) {
              return { status: 409, body: { error: "this browser view is stale; reload the workspace" } };
            }
            rejectUnknownKeys(payload, new Set(["revision", "ledger_revision", "ui_state"]), "ui state request");
            const snapshot = await snapshotForLedger(latest.ledger);
            const normalized = normalizeUiState(payload.ui_state, {
              graphNodeIds: new Set((snapshot.graph.nodes ?? []).map((node) => node.id)),
            });
            const savedAt = new Date().toISOString();
            const uiState = {
              schema_version: UI_STATE_SCHEMA_VERSION,
              workspace_revision: latest.current.revision,
              ledger_revision: latest.ledger.revision,
              saved_at: savedAt,
              ...normalized,
            };
            const saved = await saveWorkspace(directory, {
              ...latest,
              current: { ...latest.current, ui_state: uiState },
            });
            return {
              status: 200,
              body: {
                ok: true,
                revision: saved.current.revision,
                ledger_revision: saved.ledger.revision,
                saved_at: savedAt,
                storage_health: saved.storage_health,
                durability_warnings: saved.durability_warnings ?? [],
              },
            };
          });
          sendJson(response, result.status, result.body);
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/draft") {
          const problem = mutationRequestProblem(request);
          if (problem) {
            sendJson(response, problem.status, { error: problem.error });
            return;
          }
          const payload = await requestBody(request);
          const result = await withWorkspaceLock(lockDirectory, async () => {
            const latest = await readWorkspace(directory, workspace);
            await requireHealthyMutationBase(root, workspace);
            if (latest.current.phase !== "open") {
              return { status: 409, body: { error: "this answer pack is already completed" } };
            }
            if (!isPlainObject(payload) || payload.revision !== latest.current.revision) {
              return { status: 409, body: { error: "this browser view is stale; reload the workspace" } };
            }
            const draft = normalizeDraft(latest.current.seed, payload);
            const savedAt = new Date().toISOString();
            const saved = await saveWorkspace(directory, {
              ...latest,
              current: { ...latest.current, draft, draft_saved_at: savedAt },
            });
            return {
              status: 200,
              body: {
                ok: true,
                revision: saved.current.revision,
                saved_at: savedAt,
                storage_health: saved.storage_health,
                durability_warnings: saved.durability_warnings ?? [],
              },
            };
          });
          sendJson(response, result.status, result.body);
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/complete") {
          const problem = mutationRequestProblem(request);
          if (problem) {
            sendJson(response, problem.status, { error: problem.error });
            return;
          }
          const payload = await requestBody(request);
          const result = await withWorkspaceLock(lockDirectory, async () => {
            const latest = await readWorkspace(directory, workspace);
            await requireHealthyMutationBase(root, workspace);
            if (latest.current.phase !== "open") {
              return { status: 409, body: { error: "this answer pack is already completed" } };
            }
            if (!isPlainObject(payload) || payload.revision !== latest.current.revision) {
              return { status: 409, body: { error: "this browser view is stale; reload the workspace" } };
            }
            const normalizedResponsePatch = normalizeSubmission(latest.current.seed, payload);
            const completedAt = new Date().toISOString();
            const provenance = completionEvent(latest.ledger, latest.current.revision, completedAt, normalizedResponsePatch);
            const nextLedger = await appendEvent(latest.ledger, provenance);
            const provenanceLedgerEvent = nextLedger.events.find((event) => event.event_id === provenance.event_id);
            if (!provenanceLedgerEvent) {
              throw new Error("pack completion provenance is missing from the canonical ledger");
            }
            const snapshot = await snapshotForLedger(nextLedger);
            const completion = {
              completed_at: completedAt,
              provenance_event_id: provenance.event_id,
              normalized_response_patch: normalizedResponsePatch,
              readiness: snapshot.readiness,
              graph: snapshot.graph,
            };
            let saved = await saveWorkspace(directory, {
              ...latest,
              ledger: nextLedger,
              pack_events: [...latest.pack_events, provenanceLedgerEvent],
              current: {
                ...latest.current,
                phase: "completed",
                completed_at: completedAt,
                completion,
              },
            });
            try {
              await checkpointWorkspace(directory, saved);
            } catch (checkpointError) {
              saved = await appendDurabilityWarning(directory, saved, "completion_checkpoint_failed", checkpointError);
            }
            return {
              status: 200,
              body: {
                ok: true,
                workspace_id: saved.workspace_id,
                revision: saved.current.revision,
                ledger_revision: saved.ledger.revision,
                completion: publicCompletion(completion),
                storage_health: saved.storage_health,
                durability_warnings: saved.durability_warnings ?? [],
              },
            };
          });
          sendJson(response, result.status, result.body);
          return;
        }
        sendJson(response, 404, { error: "not found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid request";
        if (isPlainObject(error?.storage_health)) {
          sendJson(response, 503, { error: message, storage_health: error.storage_health });
          return;
        }
        const gone = message.includes("was not found");
        sendJson(response, gone ? 410 : 400, { error: gone ? "workspace state is unavailable; the cause is unknown" : message });
      }
    });
    // A replacement server for an existing workspace should keep its URL when
    // the old listener has already stopped. This lets long-lived answer packs
    // receive renderer fixes without making users chase a new browser tab.
    const beforeListen = await readWorkspace(directory, workspace);
    const preferredPort = reusableWorkspacePort(beforeListen.server, workspacePath);
    try {
      await listenLoopback(server, preferredPort ?? 0);
    } catch (error) {
      if (!preferredPort || error?.code !== "EADDRINUSE") throw error;
      await listenLoopback(server, 0);
    }
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== HOST) {
      throw new Error("local workflow server did not bind to 127.0.0.1");
    }
    const url = `http://${HOST}:${address.port}${workspacePath}`;
    const saved = await withWorkspaceLock(lockDirectory, async () => {
      const state = await readWorkspace(directory, workspace);
      await requireHealthyMutationBase(root, workspace);
      return saveWorkspace(directory, {
        ...state,
        url,
        server: { host: HOST, port: address.port, url, started_at: new Date().toISOString() },
      });
    });
    await writeJsonAtomically(join(directory, "server.json"), saved.server);
    watcher = setInterval(async () => {
      try {
        await readWorkspace(directory, workspace);
      } catch (error) {
        if (error instanceof Error && error.message.includes("was not found") && !closeReason) {
          closeReason = "workspace_unavailable";
          server.close();
        }
      }
    }, 750);
    await new Promise((resolveClose, rejectClose) => {
      server.once("close", resolveClose);
      server.once("error", rejectClose);
    });
    if (closeReason === "workspace_unavailable") {
      await writeJsonAtomically(join(lockDirectory, "server-closed.json"), {
        workspace_id: workspace,
        closed_at: new Date().toISOString(),
        reason: closeReason,
      });
    }
    return { workspace_id: workspace, state: "closed" };
  } catch (error) {
    try {
      await writeJsonAtomically(join(directory, "error.json"), { error: error instanceof Error ? error.message : "local workflow server failed" });
    } catch {
      // The original startup failure is the useful one.
    }
    if (server) server.close();
    throw error;
  } finally {
    if (watcher) clearInterval(watcher);
  }
}

/**
 * Programmatic command entry point. The optional rootDir is a test seam;
 * normal CLI callers use the local workspace root selected by the CLI.
 */
export async function run(argv = process.argv.slice(2), { rootDir } = {}) {
  const { command, options } = parseArguments(argv);
  if (options.help) return usage();
  const rootWasConfigured = rootDir !== undefined
    || Object.prototype.hasOwnProperty.call(process.env, WORKSPACE_ENV)
    || Object.prototype.hasOwnProperty.call(process.env, LEGACY_WORKSPACE_ENV);
  let root = workspaceRoot(rootDir);
  const targetsExistingWorkspace = new Set([
    "status",
    "consume",
    "advance",
    "flag-inference",
    "amend-item",
    "add-item",
    "finish",
    "recover",
    "serve",
  ]).has(command);
  if (!rootWasConfigured && targetsExistingWorkspace && options.workspace) {
    root = await discoverExistingWorkspaceRoot(options.workspace, { persistentRoot: root });
  }
  if (options.pack && command !== "start") throw new Error("--pack is supported only by start");
  if (command === "start") {
    return startWorkspace(await loadStartSeed(options), root);
  }
  if (command === "status") {
    if (!options.workspace) throw new Error("status requires --workspace");
    return statusWorkspace(root, options.workspace);
  }
  if (command === "consume") {
    if (!options.workspace) throw new Error("consume requires --workspace");
    return consumeWorkspace(root, options.workspace);
  }
  if (command === "advance") {
    if (!options.workspace) throw new Error("advance requires --workspace");
    return advanceWorkspace(root, options.workspace, await loadSeed(options.seedFile));
  }
  if (command === "flag-inference") {
    if (!options.workspace) throw new Error("flag-inference requires --workspace");
    if (!options.itemId) throw new Error("flag-inference requires --item");
    if (!options.reason) throw new Error("flag-inference requires --reason");
    return flagInferenceWorkspace(root, options.workspace, options.itemId, options.reason);
  }
  if (command === "amend-item") {
    if (!options.workspace) throw new Error("amend-item requires --workspace");
    if (!options.itemId) throw new Error("amend-item requires --item");
    return amendItemWorkspace(root, options.workspace, options.itemId, await loadItemPatch(options.patchFile));
  }
  if (command === "add-item") {
    if (!options.workspace) throw new Error("add-item requires --workspace");
    return addItemWorkspace(root, options.workspace, await loadMaterialItem(options.itemFile));
  }
  if (command === "finish") {
    if (!options.workspace) throw new Error("finish requires --workspace");
    return finishWorkspace(root, options.workspace);
  }
  if (command === "recover") {
    if (!options.workspace) throw new Error("recover requires --workspace");
    return recoverWorkspace(root, options.workspace);
  }
  // serve is an implementation detail used only by the detached child started
  // above. Keeping it here avoids a second dependency-bearing executable.
  if (command === "serve") {
    if (!options.workspace) throw new Error("serve requires --workspace");
    return serveWorkspace(root, options.workspace);
  }
  throw new Error(`unsupported command: ${command}`);
}

export async function main(argv = process.argv.slice(2)) {
  const output = await run(argv);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
