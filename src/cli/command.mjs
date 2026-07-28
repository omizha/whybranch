import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeSeed,
  createLedgerFromSeed,
  appendEvent,
  computeReadiness,
  projectGraph,
} from "../core/index.mjs";

const HOST = "127.0.0.1";
const WORKSPACE_ENV = "DGI_WORKSPACE_ROOT";
const WORKSPACE_SCHEMA_VERSION = "decision-graph-workspace/v1";
const MAX_BODY_BYTES = 512 * 1024;
const AUTOSAVE_DELAY_MS = 450;
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

function workspaceRoot(override) {
  return resolve(override ?? process.env[WORKSPACE_ENV] ?? join(tmpdir(), "decision-graph-interview"));
}

function validateWorkspaceId(value) {
  if (typeof value !== "string" || !/^workspace-[a-f0-9-]{36}$/i.test(value)) {
    throw new Error("workspace must be a workspace id returned by start");
  }
  return value;
}

function workspaceDirectory(root, workspace) {
  const id = validateWorkspaceId(workspace);
  const directory = resolve(root, id);
  if (directory !== join(root, id)) {
    throw new Error("workspace resolves outside the local workspace root");
  }
  return directory;
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
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

async function writeJsonAtomically(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
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
      const source = resolution === "defer"
        ? response.deferral
        : resolution === "not_applicable"
          ? response.not_applicable
          : response.withdrawal;
      const reason = isPlainObject(source) ? optionalString(source.reason, `responses[${index}].reason`) : undefined;
      const clue = resolution === "defer" && isPlainObject(source)
        ? optionalString(source.clue, `responses[${index}].clue`)
        : undefined;
      if (resolution === "defer") {
        const deferral = Object.fromEntries(Object.entries({ reason, clue }).filter(([, value]) => value !== undefined));
        return Object.keys(deferral).length > 0 ? { question_id: questionId, resolution, deferral } : { question_id: questionId, resolution };
      }
      if (resolution === "not_applicable") {
        return reason ? { question_id: questionId, resolution, not_applicable: { reason } } : { question_id: questionId, resolution };
      }
      return reason ? { question_id: questionId, resolution, withdrawal: { reason } } : { question_id: questionId, resolution };
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
    completed_at: state.current.completed_at ?? undefined,
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
    completed_at: summary.completed_at,
    readiness: readinessReceipt(summary.readiness),
    material_item_count: Array.isArray(summary.material_items) ? summary.material_items.length : 0,
  };
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
  if (!["open", "completed"].includes(value.current.phase)) {
    throw new Error("workspace has an invalid current pack phase");
  }
  value.current.seed = normalizeSeed(value.current.seed);
  value.current.draft = normalizeDraft(value.current.seed, value.current.draft ?? { responses: [] });
  if (!Array.isArray(value.history)) value.history = [];
  if (!Array.isArray(value.pack_events)) value.pack_events = [];
  return value;
}

async function readWorkspace(directory, workspace) {
  const state = await readJson(join(directory, "workspace.json"), "workspace");
  return assertWorkspaceShape(state, workspace);
}

async function saveWorkspace(directory, state) {
  const next = {
    ...state,
    updated_at: new Date().toISOString(),
  };
  await writeJsonAtomically(join(directory, "workspace.json"), next);
  return next;
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
          await rm(lockFile, { force: true });
          continue;
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

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    throw new Error("usage: decision-graph <start|status|consume|advance|finish> [options]");
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
      "decision-graph start --seed-file <seed.json>",
      "decision-graph status --workspace <workspace-id>",
      "decision-graph consume --workspace <workspace-id>",
      "decision-graph advance --workspace <workspace-id> --seed-file <next-seed.json>",
      "decision-graph add-item --workspace <workspace-id> --item-file <item.json>",
      "decision-graph amend-item --workspace <workspace-id> --item <item-id> --patch-file <patch.json>",
      "decision-graph flag-inference --workspace <workspace-id> --item <item-id> --reason <text>",
      "decision-graph finish --workspace <workspace-id>",
    ],
  };
}

async function loadSeed(seedFile) {
  if (!seedFile) throw new Error("--seed-file is required");
  const file = resolve(seedFile);
  return normalizeSeed(await readJson(file, "seed file"));
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
    const snapshot = await snapshotForLedger(state.ledger);
    return {
      ...workspaceReceipt(currentSummary(state, snapshot)),
      workspace_id: workspace,
      url: server.url,
      handoff: "작성 내용은 자동 저장됩니다. 완료하려면 Codex로 계속을 누른 뒤, 채팅에 계속이라고 입력하세요.",
    };
  } catch (error) {
    // `start` never reports a workspace that cannot be reached. Avoid leaving
    // its seed/draft state behind if spawn or loopback readiness fails.
    try {
      if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
    } catch {
      // The workspace removal below is still the important cleanup boundary.
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 2 });
    throw error;
  }
}

async function statusWorkspace(root, workspace) {
  const directory = workspaceDirectory(root, workspace);
  const state = await readWorkspace(directory, workspace);
  return currentSummary(state, await snapshotForLedger(state.ledger));
}

async function mutateWorkspace(root, workspace, action) {
  const directory = workspaceDirectory(root, workspace);
  return withWorkspaceLock(directory, async () => {
    const state = await readWorkspace(directory, workspace);
    return action(directory, state);
  });
}

async function consumeWorkspace(root, workspace) {
  const directory = workspaceDirectory(root, workspace);
  const state = await readWorkspace(directory, workspace);
  if (state.current.phase !== "completed" || !state.current.completion) {
    throw new Error("the current answer pack has not been completed with Codex로 계속 yet");
  }
  const snapshot = await snapshotForLedger(state.ledger);
  return {
    ...currentSummary(state, snapshot),
    completion: publicCompletion(state.current.completion),
    ledger: state.ledger,
    pack_events: state.pack_events,
    history: state.history.map((entry) => ({
      revision: entry.revision,
      objective: entry.objective,
      completed_at: entry.completed_at,
    })),
  };
}

async function advanceWorkspace(root, workspace, seed) {
  return mutateWorkspace(root, workspace, async (directory, state) => {
    if (state.current.phase !== "completed" || !state.current.completion) {
      throw new Error("advance requires the current answer pack to be completed first");
    }
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
      ledger: await appendEvent(ledgerAfterScope, transition),
      pack_events: [...state.pack_events, ...(scopeEvent ? [scopeEvent] : []), transition],
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
    const saved = await saveWorkspace(directory, next);
    const snapshot = await snapshotForLedger(saved.ledger);
    return {
      ...workspaceReceipt(currentSummary(saved, snapshot)),
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

async function finishWorkspace(root, workspace) {
  const directory = workspaceDirectory(root, workspace);
  return withWorkspaceLock(directory, async () => {
    await readWorkspace(directory, workspace);
    await rm(directory, { recursive: true, force: false, maxRetries: 2 });
    return { workspace_id: workspace, finished: true };
  });
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
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
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
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Decision Graph 워크스페이스</title>
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
    .question-header { display: flex; gap: 12px; align-items: flex-start; } .number { color: #1d63d6; font-weight: 750; min-width: 22px; }
    .description, .effect, .draft { margin: 11px 0 0 34px; } .effect { background: #eef6ff; border-radius: 8px; padding: 9px; } .draft { background: #f7f8fb; border-radius: 8px; padding: 9px; white-space: pre-wrap; }
    fieldset { border: 0; margin: 15px 0 0 34px; padding: 0; } legend { font-weight: 650; margin-bottom: 8px; } label { display: block; margin: 8px 0; }
    input[type=radio], input[type=checkbox] { margin-right: 7px; } textarea { display: block; box-sizing: border-box; width: 100%; min-height: 84px; margin-top: 7px; padding: 10px; border: 1px solid #b9c6dd; border-radius: 8px; font: inherit; resize: vertical; }
    .option-effect { display: block; margin: 3px 0 0 24px; font-size: 13px; color: #5b667a; } .field-note { margin-top: 12px; } .field-note[hidden] { display: none; }
    button { margin-top: 20px; background: #1769df; color: #fff; border: 0; border-radius: 9px; padding: 12px 15px; font: inherit; font-weight: 700; cursor: pointer; } button:disabled { opacity: .56; cursor: wait; }
    pre { max-height: 360px; margin: 10px 0 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 8px; background: #101827; color: #dbeafe; padding: 12px; font-size: 12px; } .error { color: #b42318; } .complete h2 { color: #166534; }
    details > summary { cursor: pointer; font-weight: 700; } details[open] > summary { margin-bottom: 10px; } code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .graph-canvas { overflow-x: auto; border: 1px solid #dbe2ef; border-radius: 9px; background: #fbfdff; } #graph-svg { display: block; min-width: 620px; width: 100%; height: 280px; } .graph-summary { margin: 8px 0; } .answer-summary, .material-summary, .score-change { margin: 12px 0 0; padding: 10px; background: #f7f8fb; border-radius: 8px; } .answer-summary ul, .material-summary ul { margin-top: 7px; } .score-change p { margin: 5px 0 0; }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Decision Graph · 로컬 워크스페이스</p>
      <h1>${escapeHtml(seed.objective)}</h1>
      <p class="workspace">workspace ${escapeHtml(state.workspace_id)} · revision ${current.revision}</p>
      <div class="meta">${meta}${ambiguity}</div>
      <p class="lede">입력은 포커스를 옮기지 않아도 마지막 변경 후 약 0.45초에 이 컴퓨터의 임시 워크스페이스에 자동 저장됩니다. 완료는 자동 저장과 별개입니다. 완료하려면 <code>Codex로 계속</code>을 누른 뒤 Codex 채팅에 <code>계속</code>이라고 입력하세요.</p>
    </header>
    <section class="summary" aria-label="현재 요약">
      <div class="metric"><strong>현재 revision</strong><span id="revision-summary">${current.revision}</span></div>
      <div class="metric"><strong>상태</strong><span id="phase-summary">${current.phase === "completed" ? "완료됨" : "작성 중"}</span></div>
      <div class="metric"><strong>준비도</strong><span id="readiness-summary">${escapeHtml(displayReadiness(initialStatus.readiness))}</span></div>
      <div class="metric"><strong>남은 불확실성</strong><span id="uncertainty-summary">${escapeHtml(displayUnresolvedBurden(initialStatus.readiness))}</span><small class="subtle">확률이 아닌 공개 정책 기반 미해결 부담입니다.</small></div>
    </section>
    ${panelMarkup("현재 차단점", seed.current_blockers)}
    ${panelMarkup("잠긴 후속 질문", seed.potential_follow_ups)}
    ${panelMarkup("후보 관련 불확실성", seed.candidate_uncertainties, "후보: 아직 없음")}
    <details id="score-graph" ${completion ? "open" : ""}><summary>점수와 그래프 열기</summary><p class="subtle">점수는 정책 버전과 영향 항목이 기록된 재현 가능한 휴리스틱입니다. 확률이나 사실 판정이 아닙니다.</p>${scoreChangeMarkup(initialStatus.latest_score_change)}<h3>Graph summary</h3><p id="graph-summary" class="graph-summary subtle">그래프를 계산 중입니다.</p><div class="graph-canvas"><svg id="graph-svg" viewBox="0 0 720 280" role="img" aria-label="Decision Graph"></svg></div><section id="material-summary" class="material-summary"><strong>점수·그래프 대상 원장 항목</strong><p class="subtle">원 답/근거를 고치거나 추론 오류를 표시할 때 아래 ID를 사용하세요. 점수는 직접 수정할 수 없습니다.</p><ul id="material-summary-list"></ul></section><section id="answer-summary" class="answer-summary" hidden><strong>이번 팩의 기록된 답변</strong><ul id="answer-summary-list"></ul></section><h3>Readiness detail</h3><pre id="readiness-json"></pre><details><summary>Graph JSON 보기</summary><pre id="graph-json"></pre></details></details>
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
    const AUTOSAVE_DELAY_MS = ${AUTOSAVE_DELAY_MS};
    const questionContainer = document.getElementById("questions");
    const form = document.getElementById("decision-form");
    const preview = document.getElementById("preview");
    const error = document.getElementById("error");
    const submit = document.getElementById("submit");
    const complete = document.getElementById("complete");
    const autosaveStatus = document.getElementById("autosave-status");
    let saveTimer;
    let draftGeneration = 0;
    let savingDraft = false;
    let completed = Boolean(initialCompletion);
    let model = initialStatus;

    function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
    function questionKey(question) { return "q:" + question.id; }
    function renderQuestion(question, index) {
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
      const description = question.description ? '<p class="description">' + escapeHtml(question.description) + '</p>' : "";
      const effect = question.answer_effect ? '<p class="effect"><strong>답변이 확인할 범위:</strong> ' + escapeHtml(question.answer_effect) + '</p>' : "";
      const draft = question.draft_response ? '<p class="draft"><strong>근거 기반 초안 (선택 전):</strong>\\n' + escapeHtml(question.draft_response) + '</p>' : "";
      return '<article class="question" data-question="' + escapeHtml(question.id) + '"><div class="question-header"><span class="number">' + (index + 1) + '</span><div><h3>' + escapeHtml(question.prompt) + '</h3></div></div>' + description + effect + draft + '<fieldset><legend>현재 답변 상태</legend><label><input type="radio" name="resolution:' + escapeHtml(question.id) + '" value="answer" checked> 답변</label><label><input type="radio" name="resolution:' + escapeHtml(question.id) + '" value="defer"> 보류</label><label><input type="radio" name="resolution:' + escapeHtml(question.id) + '" value="not_applicable"> 해당 없음</label><label><input type="radio" name="resolution:' + escapeHtml(question.id) + '" value="withdrawn"> 질문 철회</label><div data-answer-for="' + escapeHtml(question.id) + '">' + answerInputs + '</div><label class="field-note" data-note-for="' + escapeHtml(question.id) + '" hidden>보류 / 해당 없음 / 철회 이유 (선택)<textarea data-note-text="' + escapeHtml(question.id) + '" placeholder="이유나 단서를 남길 수 있습니다."></textarea></label><label class="field-note" data-clue-for="' + escapeHtml(question.id) + '" hidden>보류의 실마리 (선택)<textarea data-clue-text="' + escapeHtml(question.id) + '" placeholder="다음에 확인할 사실이나 비교할 선택지를 남길 수 있습니다."></textarea></label></fieldset></article>';
    }
    questionContainer.innerHTML = seed.questions.map(renderQuestion).join("");
    function selectorEscape(value) { return CSS.escape(value); }
    function selectedResolution(question) { return form.querySelector('input[name="resolution:' + selectorEscape(question.id) + '"]:checked').value; }
    function selectedOption(question) { const input = form.querySelector('input[name="option:' + selectorEscape(question.id) + '"]:checked'); return input ? input.value : undefined; }
    function selectedOptions(question) { return Array.from(form.querySelectorAll('input[name="option:' + selectorEscape(question.id) + '"]:checked')).map(function (input) { return input.value; }); }
    function hasOtherSelection(question) { return question.selection_mode === "multiple" ? selectedOptions(question).includes("__other") : selectedOption(question) === "__other"; }
    function textValue(prefix, questionId) { const input = form.querySelector(prefix + selectorEscape(questionId) + '"]'); return input ? input.value.trim() : ""; }
    function responseFor(question) {
      const resolution = selectedResolution(question); const questionId = questionKey(question);
      const note = textValue('[data-note-text="', question.id); const clue = textValue('[data-clue-text="', question.id);
      if (resolution !== "answer") {
        const response = { question_id: questionId, resolution: resolution };
        if (resolution === "defer" && (note || clue)) response.deferral = Object.assign({}, note ? { reason: note } : {}, clue ? { clue: clue } : {});
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
      const response = { question_id: questionKey(question), resolution: selectedResolution(question) };
      if (question.selection_mode === "multiple") { const selections = selectedOptions(question); if (selections.length) response.selections = selections; } else { const selection = selectedOption(question); if (selection) response.selection = selection; }
      const values = [["text", '[data-answer-text="'], ["other_text", '[data-other-text="'], ["note", '[data-note-text="'], ["clue", '[data-clue-text="']];
      values.forEach(function (pair) { const value = textValue(pair[1], question.id); if (value) response[pair[0]] = value; });
      return response;
    }
    function updateVisibility(question) {
      const resolution = selectedResolution(question); const answer = form.querySelector('[data-answer-for="' + selectorEscape(question.id) + '"]'); const note = form.querySelector('[data-note-for="' + selectorEscape(question.id) + '"]'); const clue = form.querySelector('[data-clue-for="' + selectorEscape(question.id) + '"]');
      answer.hidden = resolution !== "answer"; note.hidden = resolution === "answer"; clue.hidden = resolution !== "defer";
      const other = form.querySelector('[data-other-for="' + selectorEscape(question.id) + '"]'); if (other) other.hidden = !(resolution === "answer" && hasOtherSelection(question));
    }
    function updatePreview() { preview.textContent = JSON.stringify({ responses: seed.questions.map(responseFor) }, null, 2); }
    function setAutosaveStatus(message, failed) { autosaveStatus.textContent = message; autosaveStatus.classList.toggle("error", Boolean(failed)); }
    function restoreDraft() {
      const responses = Array.isArray(initialDraft.responses) ? initialDraft.responses : []; const questions = new Map(seed.questions.map(function (question) { return [questionKey(question), question]; }));
      responses.forEach(function (response) { const question = questions.get(response.question_id); if (!question) return; const resolution = response.resolution === "withdraw" ? "withdrawn" : response.resolution; const resolutionInput = form.querySelector('input[name="resolution:' + selectorEscape(question.id) + '"][value="' + selectorEscape(resolution) + '"]'); if (resolutionInput) resolutionInput.checked = true;
        const selections = question.selection_mode === "multiple" ? response.selections : response.selection ? [response.selection] : []; (Array.isArray(selections) ? selections : []).forEach(function (selection) { const option = form.querySelector('input[name="option:' + selectorEscape(question.id) + '"][value="' + selectorEscape(selection) + '"]'); if (option) option.checked = true; });
        [[ '[data-answer-text="', response.text ], [ '[data-other-text="', response.other_text ], [ '[data-note-text="', response.note ], [ '[data-clue-text="', response.clue ]].forEach(function (pair) { const input = form.querySelector(pair[0] + selectorEscape(question.id) + '"]'); if (input && typeof pair[1] === "string") input.value = pair[1]; });
      }); return responses.length > 0;
    }
    function saveDraftSoon(delay) { if (completed) return; draftGeneration += 1; clearTimeout(saveTimer); setAutosaveStatus("자동 저장 대기 중"); saveTimer = setTimeout(function () { void saveDraft(); }, delay === undefined ? AUTOSAVE_DELAY_MS : delay); }
    async function saveDraft() { if (completed || savingDraft) return; clearTimeout(saveTimer); const generation = draftGeneration; savingDraft = true; setAutosaveStatus("자동 저장 중"); try { const response = await fetch("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: initialStatus.revision, responses: seed.questions.map(draftFor) }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "자동 저장에 실패했습니다."); if (generation === draftGeneration) setAutosaveStatus("자동 저장됨"); } catch (caught) { if (!completed) setAutosaveStatus(caught instanceof Error ? "자동 저장 실패: " + caught.message : "자동 저장에 실패했습니다.", true); } finally { savingDraft = false; if (!completed && generation !== draftGeneration) saveDraftSoon(0); } }
    function svgElement(name, attributes) { const element = document.createElementNS("http://www.w3.org/2000/svg", name); Object.entries(attributes || {}).forEach(function (entry) { element.setAttribute(entry[0], String(entry[1])); }); return element; }
    function answerText(response) { const question = seed.questions.find(function (entry) { return questionKey(entry) === response.question_id; }); const prompt = question ? question.prompt : response.question_id; if (response.resolution !== "answer") return prompt + ": " + (response.resolution === "defer" ? "보류" : response.resolution === "not_applicable" ? "해당 없음" : "질문 철회"); const answer = response.answer || {}; const selected = []; if (answer.option_id && question) { const option = question.options.find(function (entry) { return entry.id === answer.option_id; }); if (option) selected.push(option.label); } (answer.option_ids || []).forEach(function (id) { const option = question && question.options.find(function (entry) { return entry.id === id; }); if (option) selected.push(option.label); }); if (answer.other_text) selected.push("기타: " + answer.other_text); if (answer.text) selected.push(answer.text); return prompt + ": " + selected.join(" · "); }
    function renderAnswerSummary(completion) { const section = document.getElementById("answer-summary"); const list = document.getElementById("answer-summary-list"); list.replaceChildren(); const responses = completion && completion.normalized_response_patch && Array.isArray(completion.normalized_response_patch.responses) ? completion.normalized_response_patch.responses : []; section.hidden = responses.length === 0; responses.forEach(function (response) { const item = document.createElement("li"); item.textContent = answerText(response); list.appendChild(item); }); }
    function displayHeuristicScore(value) { return typeof value === "number" ? String(value) + " / 100" : String(value); }
    function renderScoreChange(change) { const section = document.getElementById("latest-score-change"); section.replaceChildren(); const title = document.createElement("strong"); title.textContent = "최근 준비도 변화"; section.appendChild(title); const first = document.createElement("p"); const detail = document.createElement("p"); detail.className = "subtle"; const meta = document.createElement("p"); meta.className = "subtle"; if (!change || typeof change !== "object") { first.textContent = "아직 명시적 원장 항목 변화가 없습니다. 답변 저장만으로 점수는 추정하지 않습니다."; section.appendChild(first); return; } first.textContent = displayHeuristicScore(change.previous_value ?? "N/A") + " → " + displayHeuristicScore(change.next_value ?? "N/A"); detail.textContent = change.explanation || "원장 항목이 변경되어 재계산되었습니다."; const affected = Array.isArray(change.affected_item_ids) && change.affected_item_ids.length ? change.affected_item_ids.join(", ") : "범위 또는 평가 가능 항목"; meta.textContent = "규칙: " + (change.rule_id || "unknown") + " · 영향 항목: " + affected; section.append(first, detail, meta); }
    function renderMaterialItems(items) { const list = document.getElementById("material-summary-list"); list.replaceChildren(); if (!Array.isArray(items) || items.length === 0) { const empty = document.createElement("li"); empty.textContent = "명시적 점수 항목이 없습니다. 준비도와 남은 불확실성은 N/A입니다."; list.appendChild(empty); return; } items.slice().sort(function (left, right) { return left.id.localeCompare(right.id); }).forEach(function (entry) { const item = document.createElement("li"); item.textContent = entry.id + " · " + entry.component + " · " + entry.status + " · 영향 " + entry.impact + (entry.inference_flagged ? " · 추론 오류 표시됨" : ""); list.appendChild(item); }); }
    function graphLabel(node, completion) { if (completion && node.id === "event:" + completion.provenance_event_id) { const responses = completion.normalized_response_patch && completion.normalized_response_patch.responses || []; return "답변 완료 · " + responses.length + "개"; } const label = node.label || node.id; return label.length > 26 ? label.slice(0, 25) + "…" : label; }
    function renderGraph(graph, completion) {
      const svg = document.getElementById("graph-svg"); const summary = document.getElementById("graph-summary"); svg.replaceChildren(); const allNodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []; const allEdges = graph && Array.isArray(graph.edges) ? graph.edges : [];
      if (allNodes.length === 0) { summary.textContent = "표시할 그래프 항목이 아직 없습니다."; const text = svgElement("text", { x: 28, y: 48, fill: "#5b667a", "font-size": 14 }); text.textContent = "그래프 항목이 아직 없습니다."; svg.appendChild(text); return; }
      const priority = { decision: 0, score: 1, question: 2, answer: 3, event: 4, blocker: 5, assumption: 6, evidence: 7, contradiction: 8, candidate: 9 };
      const nodes = allNodes.slice().sort(function (left, right) { const difference = (priority[left.type] ?? 99) - (priority[right.type] ?? 99); return difference || left.id.localeCompare(right.id); }).slice(0, 12);
      const positions = new Map(); const decision = nodes.find(function (node) { return node.type === "decision"; }); const score = nodes.find(function (node) { return node.type === "score"; }); if (decision) positions.set(decision.id, { x: 82, y: 140 }); if (score) positions.set(score.id, { x: 638, y: 140 }); const remaining = nodes.filter(function (node) { return node !== decision && node !== score; }); const rows = Math.max(1, Math.ceil(remaining.length / 2)); remaining.forEach(function (node, index) { positions.set(node.id, { x: index % 2 === 0 ? 276 : 470, y: 35 + Math.round((Math.floor(index / 2) + 0.5) * (210 / rows)) }); });
      const selected = new Set(nodes.map(function (node) { return node.id; })); const edges = allEdges.filter(function (edge) { return selected.has(edge.from) && selected.has(edge.to); }); summary.textContent = allNodes.length + " nodes · " + allEdges.length + " edges · 요약에 " + nodes.length + "개 항목 표시";
      edges.forEach(function (edge) { const from = positions.get(edge.from); const to = positions.get(edge.to); if (!from || !to) return; svg.appendChild(svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: "#9fb4d8", "stroke-width": 1.5, "stroke-dasharray": edge.type === "affects_score" ? "4 3" : "" })); });
      nodes.forEach(function (node) { const position = positions.get(node.id); if (!position) return; const group = svgElement("g", { transform: "translate(" + position.x + " " + position.y + ")" }); const fill = node.type === "decision" ? "#1d63d6" : node.type === "score" ? "#167c62" : node.type === "event" ? "#8a4baf" : "#e8f0ff"; const stroke = node.type === "decision" || node.type === "score" || node.type === "event" ? fill : "#7aa0df"; const textFill = node.type === "decision" || node.type === "score" || node.type === "event" ? "#ffffff" : "#18345f"; group.appendChild(svgElement("rect", { x: -72, y: -22, width: 144, height: 44, rx: 10, fill: fill, stroke: stroke, "stroke-width": 1.2 })); const type = svgElement("text", { x: 0, y: -5, fill: textFill, "text-anchor": "middle", "font-size": 10, "font-weight": 700 }); type.textContent = node.type; group.appendChild(type); const label = svgElement("text", { x: 0, y: 10, fill: textFill, "text-anchor": "middle", "font-size": 10 }); label.textContent = graphLabel(node, completion); group.appendChild(label); svg.appendChild(group); });
    }
    function renderModel(completion) { const readiness = model.readiness === undefined ? null : model.readiness; const graph = model.graph === undefined ? null : model.graph; document.getElementById("readiness-json").textContent = JSON.stringify(readiness, null, 2); document.getElementById("graph-json").textContent = JSON.stringify(graph, null, 2); const candidates = readiness && typeof readiness === "object" ? [readiness.score, readiness.value, readiness.overall, readiness.readiness] : []; const score = candidates.find(function (value) { return typeof value === "number" || typeof value === "string"; }); document.getElementById("readiness-summary").textContent = score === undefined ? "결정 준비도: 해당 없음" : "결정 준비도 (heuristic): " + displayHeuristicScore(score); const burden = readiness && typeof readiness.unresolved_burden === "number" ? readiness.unresolved_burden : null; document.getElementById("uncertainty-summary").textContent = burden === null ? "남은 불확실성 (heuristic): N/A" : "남은 불확실성 (heuristic): " + displayHeuristicScore(burden); renderScoreChange(model.latest_score_change); renderGraph(graph, completion && completion.normalized_response_patch ? completion : null); renderAnswerSummary(completion && completion.normalized_response_patch ? completion : null); renderMaterialItems(model.material_items); }
    function showCompletion(completion, applyCompletionSnapshot) { if (applyCompletionSnapshot && completion) model = Object.assign({}, model, { readiness: completion.readiness || model.readiness, graph: completion.graph || model.graph }); completed = true; clearTimeout(saveTimer); form.hidden = true; complete.hidden = false; document.getElementById("phase-summary").textContent = "완료됨"; document.getElementById("score-graph").open = true; renderModel(completion); }
    const restored = restoreDraft(); seed.questions.forEach(function (question) { form.querySelectorAll('[name="resolution:' + selectorEscape(question.id) + '"], [name="option:' + selectorEscape(question.id) + '"], [data-answer-text="' + selectorEscape(question.id) + '"], [data-other-text="' + selectorEscape(question.id) + '"], [data-note-text="' + selectorEscape(question.id) + '"], [data-clue-text="' + selectorEscape(question.id) + '"]').forEach(function (element) { element.addEventListener("input", function () { updateVisibility(question); updatePreview(); saveDraftSoon(); }); element.addEventListener("change", function () { updateVisibility(question); updatePreview(); saveDraftSoon(); }); }); updateVisibility(question); });
    updatePreview(); renderModel(initialCompletion); if (restored && !completed) setAutosaveStatus("자동 저장된 초안을 복원했습니다."); if (initialCompletion) showCompletion(initialCompletion, false);
    function emptyAnswerIssue(question, response, index) { if (response.resolution !== "answer") return undefined; const answer = response.answer || {}; if (answer.option_id || (Array.isArray(answer.option_ids) && answer.option_ids.length) || answer.text || answer.other_text) return undefined; return "질문 " + (index + 1) + "에 답변을 입력하거나 보류/해당 없음/질문 철회를 선택하세요."; }
    form.addEventListener("submit", async function (event) { event.preventDefault(); error.textContent = ""; const responses = seed.questions.map(responseFor); const issue = responses.map(function (response, index) { return emptyAnswerIssue(seed.questions[index], response, index); }).find(Boolean); if (issue) { error.textContent = issue; return; } completed = true; clearTimeout(saveTimer); submit.disabled = true; try { const response = await fetch("/api/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: initialStatus.revision, responses: responses }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "저장에 실패했습니다."); showCompletion(body.completion, true); } catch (caught) { error.textContent = caught instanceof Error ? caught.message : "저장에 실패했습니다."; submit.disabled = false; completed = false; } });
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
  const workspacePath = `/workspaces/${workspace}`;
  let server;
  let watcher;
  try {
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
          sendHtml(response, renderDocument(state, snapshot));
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/status") {
          sendJson(response, 200, currentSummary(state, await snapshotForLedger(state.ledger)));
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/draft") {
          const problem = mutationRequestProblem(request);
          if (problem) {
            sendJson(response, problem.status, { error: problem.error });
            return;
          }
          const payload = await requestBody(request);
          const result = await withWorkspaceLock(directory, async () => {
            const latest = await readWorkspace(directory, workspace);
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
            return { status: 200, body: { ok: true, revision: saved.current.revision, saved_at: savedAt } };
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
          const result = await withWorkspaceLock(directory, async () => {
            const latest = await readWorkspace(directory, workspace);
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
            const snapshot = await snapshotForLedger(nextLedger);
            const completion = {
              completed_at: completedAt,
              provenance_event_id: provenance.event_id,
              normalized_response_patch: normalizedResponsePatch,
              readiness: snapshot.readiness,
              graph: snapshot.graph,
            };
            const saved = await saveWorkspace(directory, {
              ...latest,
              ledger: nextLedger,
              pack_events: [...latest.pack_events, provenance],
              current: {
                ...latest.current,
                phase: "completed",
                completed_at: completedAt,
                completion,
              },
            });
            return {
              status: 200,
              body: { ok: true, workspace_id: saved.workspace_id, revision: saved.current.revision, completion: publicCompletion(completion) },
            };
          });
          sendJson(response, result.status, result.body);
          return;
        }
        sendJson(response, 404, { error: "not found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid request";
        const gone = message.includes("was not found");
        sendJson(response, gone ? 410 : 400, { error: gone ? "workspace has been finished" : message });
      }
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen({ host: HOST, port: 0 }, resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== HOST) {
      throw new Error("local workflow server did not bind to 127.0.0.1");
    }
    const url = `http://${HOST}:${address.port}${workspacePath}`;
    const state = await readWorkspace(directory, workspace);
    const saved = await saveWorkspace(directory, {
      ...state,
      url,
      server: { host: HOST, port: address.port, url, started_at: new Date().toISOString() },
    });
    await writeJsonAtomically(join(directory, "server.json"), saved.server);
    watcher = setInterval(async () => {
      try {
        await readWorkspace(directory, workspace);
      } catch (error) {
        if (error instanceof Error && error.message.includes("was not found")) server.close();
      }
    }, 750);
    await new Promise((resolveClose, rejectClose) => {
      server.once("close", resolveClose);
      server.once("error", rejectClose);
    });
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
 * Programmatic command entry point. The optional rootDir is deliberately a
 * test seam; normal CLI callers use the private system temporary directory or
 * DGI_WORKSPACE_ROOT, never a browser-provided path.
 */
export async function run(argv = process.argv.slice(2), { rootDir } = {}) {
  const { command, options } = parseArguments(argv);
  if (options.help) return usage();
  const root = workspaceRoot(rootDir);
  if (command === "start") {
    return startWorkspace(await loadSeed(options.seedFile), root);
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
