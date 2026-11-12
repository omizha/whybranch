import test from "node:test";
import assert from "node:assert/strict";

import {
  appendEvent,
  computeReadiness,
  createLedgerFromSeed,
  normalizeSeed,
  projectGraph,
} from "../src/core/index.mjs";
import { interviewPack } from "../src/packs/interview.mjs";

const seed = {
  objective: "Validate a local decision workflow",
  scope: "A first public release",
  scope_version: "1",
  questions: [{ id: "privacy", prompt: "What local-data boundary matters?", kind: "choice", options: [{ id: "loopback", label: "Loopback only" }], allow_other: true }],
  material_items: [
    { id: "evidence-local", kind: "evidence", label: "Loopback binding is tested", impact: "high", status: "verified", related_question_id: "privacy" },
    { id: "blocker-reload", kind: "blocker", label: "Reload behavior needs validation", impact: 3, status: "open", related_question_id: "privacy" },
    { id: "assumption-user", kind: "assumption", label: "A user can understand score deltas", impact: "medium", status: "untested" },
    { id: "conflict-tab", kind: "contradiction", label: "Repeated links create tabs", impact: "high", status: "open" },
  ],
};

test("normalizes explicit material items without inferring score inputs from text", () => {
  const normalized = normalizeSeed(seed);
  assert.equal(normalized.material_items[0].impact, 5);
  assert.equal(normalized.material_items[2].status, "untested");
  assert.throws(() => normalizeSeed({ ...seed, material_items: [{ id: "hidden", kind: "assumption", label: "No impact" }] }), /impact/);
});

test("same ledger yields the same readiness and graph projection", () => {
  const ledger = createLedgerFromSeed(seed);
  const first = computeReadiness(ledger);
  const second = computeReadiness(JSON.parse(JSON.stringify(ledger)));
  assert.deepEqual(first, second);
  assert.deepEqual(projectGraph(ledger, first), projectGraph(JSON.parse(JSON.stringify(ledger)), second));
  assert.equal(first.score, 27.8);
  assert.equal(first.dimensions.information_completeness.value, 100);
  assert.equal(first.dimensions.blocker_clearance.value, 0);
});

test("resolving a high-impact blocker cannot lower blocker clearance", () => {
  const ledger = createLedgerFromSeed(seed);
  const before = computeReadiness(ledger);
  const next = appendEvent(ledger, { type: "item_resolved", entity_ids: ["blocker-reload"], payload: { item_id: "blocker-reload" } });
  const after = computeReadiness(next);
  assert.ok(after.dimensions.blocker_clearance.value >= before.dimensions.blocker_clearance.value);
  assert.ok(next.events.some((event) => event.type === "score_changed"));
});

test("evidence updates preserve item identity and component while recalculating readiness", () => {
  const ledger = createLedgerFromSeed(seed);
  const amended = appendEvent(ledger, {
    type: "item_updated",
    entity_ids: ["assumption-user"],
    payload: { item_id: "assumption-user", patch: { status: "validated", detail: "A user reviewed the score label." } },
  });
  const item = amended.items.find((entry) => entry.id === "assumption-user");
  assert.equal(item.component, "assumption");
  assert.equal(item.status, "validated");
  assert.ok(computeReadiness(amended).score > computeReadiness(ledger).score);
  assert.throws(
    () => appendEvent(ledger, {
      type: "item_updated",
      entity_ids: ["assumption-user"],
      payload: { item_id: "assumption-user", patch: { component: "evidence" } },
    }),
    /cannot change component/,
  );
});

test("flagging a credited inference reopens it and removes its prior readiness credit", () => {
  const ledger = createLedgerFromSeed(seed);
  const before = computeReadiness(ledger);
  const flagged = appendEvent(ledger, {
    type: "inference_flagged",
    entity_ids: ["evidence-local"],
    payload: { item_id: "evidence-local", reason: "The source does not establish this claim." },
  });
  const after = computeReadiness(flagged);
  const item = flagged.items.find((entry) => entry.id === "evidence-local");
  assert.equal(item.status, "disputed");
  assert.equal(item.inference_flagged, true);
  assert.ok(after.score < before.score);
  assert.ok(flagged.events.some((event) => event.type === "score_changed"));
});

test("reopening a resolved contradiction reduces its stability and creates semantic graph edges", () => {
  const ledger = createLedgerFromSeed({ ...seed, material_items: seed.material_items.map((item) => item.id === "conflict-tab" ? { ...item, status: "resolved" } : item) });
  const before = computeReadiness(ledger);
  const reopened = appendEvent(ledger, { type: "item_reopened", entity_ids: ["conflict-tab"], payload: { item_id: "conflict-tab" } });
  const after = computeReadiness(reopened);
  assert.ok(after.dimensions.contradiction_stability.value < before.dimensions.contradiction_stability.value);
  assert.ok(projectGraph(reopened, after).edges.some((edge) => edge.type === "reopens"));
});

test("graph projection preserves the different semantics of final non-answer states", () => {
  const ledger = createLedgerFromSeed(seed);
  const completed = appendEvent(ledger, {
    type: "pack_completed",
    payload: {
      responses: [{
        question_id: "q:privacy",
        resolution: "defer",
        deferral: {
          reason: "A usability session has not happened yet",
          clue: "Revisit after the first moderated session",
        },
      }],
    },
  });
  const graph = projectGraph(completed, computeReadiness(completed));
  const deferred = graph.nodes.find((node) => node.type === "answer" && node.resolution === "defer");
  assert.equal(deferred?.reason, "A usability session has not happened yet");
  assert.equal(deferred?.reentry_clue, "Revisit after the first moderated session");
  assert.ok(graph.edges.some((edge) => edge.type === "defers" && edge.to === "question:privacy"));

  const mergedMemo = appendEvent(ledger, {
    type: "pack_completed",
    payload: {
      responses: [{
        question_id: "q:privacy",
        resolution: "defer",
        deferral: { reason: "Need real usage evidence; revisit after the first moderated session." },
      }],
    },
  });
  const mergedGraph = projectGraph(mergedMemo, computeReadiness(mergedMemo));
  const mergedDeferred = mergedGraph.nodes.find((node) => node.type === "answer" && node.resolution === "defer");
  assert.equal(mergedDeferred?.reason, "Need real usage evidence; revisit after the first moderated session.");
  assert.equal(mergedDeferred?.reentry_clue, undefined);
  assert.ok(mergedGraph.edges.some((edge) => edge.type === "defers" && edge.to === "question:privacy"));

  const notApplicable = appendEvent(ledger, {
    type: "pack_completed",
    payload: {
      responses: [{
        question_id: "q:privacy",
        resolution: "not_applicable",
        not_applicable: { reason: "This decision has no remote users" },
      }],
    },
  });
  assert.ok(projectGraph(notApplicable).edges.some((edge) => edge.type === "marks_not_applicable"));

  const withdrawn = appendEvent(ledger, {
    type: "pack_completed",
    payload: {
      responses: [{
        question_id: "q:privacy",
        resolution: "withdrawn",
        withdrawal: { reason: "The premise duplicates another question" },
      }],
    },
  });
  assert.ok(projectGraph(withdrawn).edges.some((edge) => edge.type === "withdraws"));
});

test("a scope change records a new scope version rather than silently comparing the old baseline", () => {
  const ledger = createLedgerFromSeed(seed);
  const before = computeReadiness(ledger);
  const changed = appendEvent(ledger, { type: "scope_changed", payload: { scope: "A broader public release", scope_version: "2" } });
  const after = computeReadiness(changed);
  assert.equal(changed.scope.version, "2");
  assert.ok(after.score < before.score);
  assert.ok(changed.items.some((item) => item.component === "blocker" && item.source === "scope_changed" && item.status === "open"));
  assert.ok(changed.events.some((event) => event.type === "score_changed" && event.payload.rule_id === "scope-rebaseline"));
});

test("no explicit material items yields N/A instead of fabricated readiness", () => {
  const ledger = createLedgerFromSeed({ objective: "No hidden score", questions: [{ id: "q", prompt: "Question", kind: "free_text" }] });
  const snapshot = computeReadiness(ledger);
  assert.equal(snapshot.score, null);
  assert.equal(snapshot.dimensions.information_completeness.state, "not_evaluated");
});

test("the built-in interview pack uses the standard text-answer contract", () => {
  const normalized = normalizeSeed(interviewPack.seed);
  assert.equal(normalized.questions.length, 3);
  assert.deepEqual(normalized.material_items, []);
  assert.ok(normalized.questions.every((question) => !("voice_input" in question)));
  const legacySeed = normalizeSeed({
    objective: "Legacy seed compatibility",
    questions: [{ id: "answer", prompt: "Explain", kind: "free_text", voice_input: { mode: "browser-local" } }],
  });
  assert.ok(!("voice_input" in legacySeed.questions[0]));
});
