import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  DEFAULT_SCORING_POLICY,
  DECISION_SEMANTICS_VERSION,
  DECISION_SEMANTICS_V1,
  appendEvent,
  computeReadiness,
  createLedgerFromSeed,
  normalizeSeed,
  projectGraph,
} from "whybranch";
import { normalizeSubmission } from "../src/cli/command.mjs";

const basicQuestion = { id: "q", prompt: "What matters?", kind: "free_text" };

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

test("decision-semantics/v1 is a frozen, JSON-serializable public contract", () => {
  assert.equal(DECISION_SEMANTICS_VERSION, "decision-semantics/v1");
  assert.equal(DECISION_SEMANTICS_V1.schema_version, DECISION_SEMANTICS_VERSION);
  assertDeepFrozen(DECISION_SEMANTICS_V1);
  assert.deepEqual(JSON.parse(JSON.stringify(DECISION_SEMANTICS_V1)), DECISION_SEMANTICS_V1);
  assert.equal(DECISION_SEMANTICS_V1.material_items.input_alias_semantics, "normalization_only");
  assert.equal(DECISION_SEMANTICS_V1.graph.identifiers_are_opaque, true);
});

test("the material vocabulary matches seed normalization", () => {
  const material = DECISION_SEMANTICS_V1.material_items;
  for (const [alias, component] of Object.entries(material.input_aliases)) {
    const normalized = normalizeSeed({
      objective: "Normalize " + alias,
      questions: [basicQuestion],
      material_items: [{ id: "item-" + alias, kind: alias, label: alias, impact: 1 }],
    });
    assert.equal(normalized.material_items[0].component, component);
  }

  for (const component of material.components) {
    for (const status of material.valid_statuses[component]) {
      const normalized = normalizeSeed({
        objective: "Normalize " + component + "." + status,
        questions: [basicQuestion],
        material_items: [{ id: "item-" + component + "-" + status, kind: component, label: status, impact: 1, status }],
      });
      assert.equal(normalized.material_items[0].status, status);
    }
    const normalizedDefault = normalizeSeed({
      objective: "Default " + component,
      questions: [basicQuestion],
      material_items: [{ id: "item-" + component, kind: component, label: component, impact: 1 }],
    });
    assert.equal(normalizedDefault.material_items[0].status, material.default_statuses[component]);
  }

  for (const inheritedKey of ["constructor", "__proto__", "toString"]) {
    assert.throws(
      () => normalizeSeed({
        objective: "Reject inherited component aliases",
        questions: [basicQuestion],
        material_items: [{ id: "item", kind: inheritedKey, label: "Item", impact: 3 }],
      }),
      /must name evidence/,
    );
    assert.throws(
      () => normalizeSeed({
        objective: "Reject inherited impact aliases",
        questions: [basicQuestion],
        material_items: [{ id: "item", kind: "evidence", label: "Item", impact: inheritedKey }],
      }),
      /must be an integer/,
    );
    assert.throws(
      () => normalizeSeed({
        objective: "Reject inherited statuses",
        questions: [basicQuestion],
        material_items: [{ id: "item", kind: "evidence", label: "Item", impact: 3, status: inheritedKey }],
      }),
      /status is not valid/,
    );
  }
});

test("the question and response vocabulary matches current validators", () => {
  for (const kind of DECISION_SEMANTICS_V1.questions.kinds) {
    const question = {
      id: "kind-" + kind,
      prompt: kind,
      kind,
      ...(kind === "choice" ? { options: [{ id: "yes", label: "Yes" }] } : {}),
    };
    assert.equal(normalizeSeed({ objective: kind, questions: [question] }).questions[0].kind, kind);
  }

  const multiple = normalizeSeed({
    objective: "Multiple",
    questions: [{
      id: "multiple",
      prompt: "Choose any",
      kind: "choice",
      selection_mode: "multiple",
      options: [{ id: "a", label: "A" }],
    }],
  });
  assert.equal(multiple.questions[0].selection_mode, "multiple");

  const responseSeed = normalizeSeed({ objective: "Responses", questions: [basicQuestion] });
  const inputs = {
    answer: { question_id: "q:q", resolution: "answer", answer: { text: "Answer" } },
    defer: { question_id: "q:q", resolution: "defer", deferral: { reason: "Not yet" } },
    not_applicable: { question_id: "q:q", resolution: "not_applicable", not_applicable: { reason: "Out of scope" } },
    withdrawn: { question_id: "q:q", resolution: "withdrawn", withdrawal: { reason: "Bad premise" } },
  };
  for (const resolution of DECISION_SEMANTICS_V1.responses.resolutions) {
    assert.equal(normalizeSubmission(responseSeed, { responses: [inputs[resolution]] }).responses[0].resolution, resolution);
  }
  assert.equal(
    normalizeSubmission(responseSeed, {
      responses: [{ question_id: "q:q", resolution: "withdraw", withdrawal: { reason: "Bad premise" } }],
    }).responses[0].resolution,
    "withdrawn",
  );
});

test("every projected graph node and edge conforms to the declared domain and range", () => {
  let ledger = createLedgerFromSeed({
    objective: "Exercise the semantic projection",
    questions: [
      { id: "answer", prompt: "Answer?", kind: "free_text" },
      { id: "defer", prompt: "Defer?", kind: "free_text" },
      { id: "na", prompt: "N/A?", kind: "free_text" },
      { id: "withdraw", prompt: "Withdraw?", kind: "free_text" },
    ],
    material_items: [
      { id: "evidence", kind: "evidence", label: "Evidence", impact: 3, status: "verified", related_question_id: "answer" },
      { id: "blocker", kind: "blocker", label: "Blocker", impact: 3, status: "open", related_question_id: "answer" },
      { id: "assumption", kind: "assumption", label: "Assumption", impact: 3, status: "validated", related_question_id: "answer" },
      { id: "contradiction", kind: "contradiction", label: "Counterevidence", impact: 3, status: "open", related_question_id: "answer" },
      { id: "candidate", kind: "candidate", label: "Candidate", impact: 3, status: "active", related_question_id: "answer" },
    ],
  });
  ledger = appendEvent(ledger, {
    type: "pack_advanced",
    payload: { questions: [{ id: "next", prompt: "Next?", kind: "free_text" }] },
  });
  ledger = appendEvent(ledger, {
    event_id: "replay-existing-question",
    type: "pack_advanced",
    payload: { questions: [{ id: "next", prompt: "Next?", kind: "free_text" }] },
  });
  ledger = appendEvent(ledger, {
    type: "pack_completed",
    payload: {
      responses: [
        { question_id: "q:answer", resolution: "answer", answer: { text: "Done" } },
        { question_id: "q:defer", resolution: "defer", deferral: { reason: "Not yet" } },
        { question_id: "q:na", resolution: "not_applicable", not_applicable: { reason: "Out of scope" } },
        { question_id: "q:withdraw", resolution: "withdrawn", withdrawal: { reason: "Bad premise" } },
      ],
    },
  });
  ledger = appendEvent(ledger, { type: "item_reopened", entity_ids: ["assumption"], payload: { item_id: "assumption" } });
  ledger = appendEvent(ledger, { type: "item_resolved", entity_ids: ["blocker"], payload: { item_id: "blocker" } });
  ledger = appendEvent(ledger, { type: "inference_flagged", entity_ids: ["evidence"], payload: { item_id: "evidence" } });
  ledger = appendEvent(ledger, {
    event_id: "unresolved-note",
    type: "unresolved_note",
    entity_ids: ["candidate"],
    payload: { note: "Preserved provenance" },
  });

  const graph = projectGraph(ledger);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const declaredNodes = new Set(DECISION_SEMANTICS_V1.graph.node_types);
  const relationTypes = DECISION_SEMANTICS_V1.graph.relation_types;
  const observedRelations = new Set();

  assert.equal(nodes.size, graph.nodes.length, "graph node IDs must be unique");
  assert.equal(new Set(graph.edges.map((edge) => edge.id)).size, graph.edges.length, "graph edge IDs must be unique");
  for (const node of graph.nodes) assert.ok(declaredNodes.has(node.type), "undeclared node type: " + node.type);
  for (const edge of graph.edges) {
    const relation = relationTypes[edge.type];
    assert.ok(relation, "undeclared relation type: " + edge.type);
    assert.ok(nodes.has(edge.from), "missing source node: " + edge.from);
    assert.ok(nodes.has(edge.to), "missing target node: " + edge.to);
    assert.ok(relation.from.includes(nodes.get(edge.from).type), edge.type + " rejects source type " + nodes.get(edge.from).type);
    assert.ok(relation.to.includes(nodes.get(edge.to).type), edge.type + " rejects target type " + nodes.get(edge.to).type);
    observedRelations.add(edge.type);
  }

  assert.deepEqual([...observedRelations].sort(), Object.keys(relationTypes).sort());
  assert.ok(graph.edges.some((edge) => edge.from === "event:unresolved-note" && edge.type === "affects"));
  assert.ok(!graph.edges.some((edge) => edge.from === "event:unresolved-note" && edge.type === "resolves"));
  assert.ok(!graph.edges.some((edge) => edge.from === "event:replay-existing-question" && edge.type === "introduces"));
  assert.ok(graph.edges.some((edge) => edge.from === "item:evidence" && edge.type === "affects_score"));
  assert.ok(graph.edges.some((edge) => edge.from === "item:blocker" && edge.type === "affects_score"));
  assert.ok(!graph.edges.some((edge) => edge.from === "item:candidate" && edge.type === "affects_score"));
  assert.ok(ledger.events.some((event) => event.type === "unresolved_note"));
  assert.equal(DECISION_SEMANTICS_V1.events.unknown_types_are_preserved, true);
});

test("the public ledger boundary rejects semantic drift and duplicate identities", () => {
  const ledger = createLedgerFromSeed({
    objective: "Protect the public ledger",
    questions: [basicQuestion],
    material_items: [{ id: "evidence", kind: "evidence", label: "Evidence", impact: 3 }],
  });

  assert.throws(
    () => appendEvent(ledger, {
      event_id: "event-ledger-created",
      type: "custom_review",
      payload: {},
    }),
    /duplicate event_id/,
  );
  assert.throws(
    () => appendEvent(ledger, {
      type: "pack_completed",
      payload: { responses: [{ question_id: "q:q", resolution: "invented" }] },
    }),
    /resolution is unsupported/,
  );

  const rogueItemLedger = JSON.parse(JSON.stringify(ledger));
  rogueItemLedger.items[0].component = "rogue";
  assert.throws(() => projectGraph(rogueItemLedger), /invalid material item component/);

  const duplicateEventLedger = JSON.parse(JSON.stringify(ledger));
  duplicateEventLedger.events.push(JSON.parse(JSON.stringify(duplicateEventLedger.events[0])));
  assert.throws(() => projectGraph(duplicateEventLedger), /duplicate event_id/);

  const legacyCompletionLedger = JSON.parse(JSON.stringify(ledger));
  legacyCompletionLedger.events.push({
    event_id: "legacy-defer-without-reason",
    type: "pack_completed",
    occurred_at: null,
    entity_ids: [],
    payload: { responses: [{ question_id: "q:q", resolution: "defer" }] },
  });
  assert.ok(projectGraph(legacyCompletionLedger).nodes.some((node) => node.resolution === "defer"));

  const invalidTransitionLedger = JSON.parse(JSON.stringify(ledger));
  invalidTransitionLedger.events.push({
    event_id: "invalid-evidence-resolution",
    type: "item_resolved",
    occurred_at: null,
    entity_ids: ["evidence"],
    payload: { item_id: "evidence" },
  });
  assert.throws(() => projectGraph(invalidTransitionLedger), /item_resolved is not supported for evidence/);
});

test("generated score events remain unique when a caller reserves their deterministic ID", () => {
  const ledger = createLedgerFromSeed({
    objective: "Protect generated event identities",
    questions: [basicQuestion],
    material_items: [{ id: "blocker", kind: "blocker", label: "Blocker", impact: 3, status: "open" }],
  });
  const resolution = {
    type: "item_resolved",
    entity_ids: ["blocker"],
    payload: { item_id: "blocker" },
  };
  const probe = appendEvent(ledger, { ...resolution, event_id: "probe-resolution" });
  const reservedId = probe.events.find((event) => event.type === "score_changed").event_id;
  const result = appendEvent(ledger, { ...resolution, event_id: reservedId });

  assert.equal(new Set(result.events.map((event) => event.event_id)).size, result.events.length);
  assert.equal(result.events.find((event) => event.type === "score_changed").event_id, reservedId + "-2");
  assert.doesNotThrow(() => projectGraph(result));
});

test("completed responses are canonicalized before the public ledger stores them", () => {
  const ledger = createLedgerFromSeed({ objective: "Canonical completion", questions: [basicQuestion] });
  const completed = appendEvent(ledger, {
    type: "pack_completed",
    payload: {
      responses: [{ question_id: " q:q ", resolution: " answer ", answer: { text: "  Kept once  " } }],
    },
  });
  const stored = completed.events.find((event) => event.type === "pack_completed");

  assert.deepEqual(stored.payload.responses, [{ question_id: "q:q", resolution: "answer", answer: { text: "Kept once" } }]);
  assert.ok(projectGraph(completed).edges.some((edge) => edge.type === "answers"));
  assert.throws(
    () => appendEvent(ledger, { type: "pack_completed", payload: { responses: [] } }),
    /at least one response/,
  );
  assert.throws(
    () => appendEvent(ledger, {
      type: "pack_completed",
      payload: { responses: [{ question_id: "q:q", resolution: "answer", answer: {} }] },
    }),
    /must include an option or text/,
  );
});

test("pack advancement derives introduction metadata only from registered questions", () => {
  const ledger = createLedgerFromSeed({ objective: "Canonical advancement", questions: [basicQuestion] });
  assert.throws(
    () => appendEvent(ledger, {
      type: "pack_advanced",
      payload: { introduced_question_ids: ["q"], question_ids: ["q"] },
    }),
    /requires payload.questions to be an array/,
  );
  assert.throws(
    () => appendEvent(ledger, { type: "pack_advanced", payload: { questions: [] } }),
    /at least one question/,
  );
  assert.throws(
    () => appendEvent(ledger, {
      type: "pack_advanced",
      payload: {
        questions: Array.from({ length: 13 }, (_, index) => ({ id: "q" + index, prompt: "Question " + index, kind: "free_text" })),
      },
    }),
    /no more than 12 questions/,
  );

  const advanced = appendEvent(ledger, {
    type: "pack_advanced",
    payload: { questions: [{ id: "q:next", prompt: "Prefixed ID?", kind: "free_text" }] },
  });
  const graph = projectGraph(advanced);
  assert.ok(graph.edges.some((edge) => edge.type === "introduces" && edge.to === "question:q:next"));

  const replayed = appendEvent(advanced, {
    event_id: "legacy-replay",
    type: "pack_advanced",
    payload: { questions: [{ id: "q:next", prompt: "Prefixed ID?", kind: "free_text" }] },
  });
  const legacyReplay = JSON.parse(JSON.stringify(replayed));
  for (const event of legacyReplay.events.filter((entry) => entry.type === "pack_advanced")) {
    delete event.payload.introduced_question_ids;
  }
  const legacyGraph = projectGraph(legacyReplay);
  assert.equal(
    legacyGraph.edges.filter((edge) => edge.type === "introduces" && edge.to === "question:q:next").length,
    1,
  );
  assert.ok(!legacyGraph.edges.some((edge) => edge.from === "event:legacy-replay" && edge.type === "introduces"));
});

test("material candidate references are safe at both producer and ledger boundaries", () => {
  assert.throws(
    () => createLedgerFromSeed({
      objective: "Unsafe candidate reference",
      questions: [basicQuestion],
      material_items: [{ id: "evidence", kind: "evidence", label: "Evidence", impact: 3, candidate_id: "Candidate A" }],
    }),
    /candidate_id contains unsupported characters/,
  );
  const ledger = createLedgerFromSeed({
    objective: "Safe candidate reference",
    questions: [basicQuestion],
    material_items: [{ id: "evidence", kind: "evidence", label: "Evidence", impact: 3, candidate_id: "candidate-a" }],
  });
  const graph = projectGraph(ledger);
  assert.equal(Object.hasOwn(graph.nodes.find((node) => node.id === "item:evidence"), "source"), false);
});

test("material question references preserve a legal q-prefixed canonical ID", () => {
  const ledger = createLedgerFromSeed({
    objective: "Prefixed material relation",
    questions: [{ id: "q:x", prompt: "Prefixed?", kind: "free_text" }],
    material_items: [{
      id: "evidence",
      kind: "evidence",
      label: "Evidence",
      impact: 3,
      related_question_id: "q:q:x",
    }],
  });

  assert.equal(ledger.items[0].related_question_id, "q:x");
  assert.doesNotThrow(() => computeReadiness(ledger));
  assert.ok(projectGraph(ledger).edges.some((edge) => edge.type === "supports" && edge.to === "question:q:x"));
});

test("graph tuple IDs remain unique when valid identifiers contain colons", () => {
  let ledger = createLedgerFromSeed({
    objective: "Unambiguous graph identities",
    questions: [
      { id: "c", prompt: "C?", kind: "free_text" },
      { id: "b:c", prompt: "B:C?", kind: "free_text" },
    ],
  });
  ledger = appendEvent(ledger, {
    event_id: "a:b",
    type: "pack_completed",
    payload: { responses: [{ question_id: "q:c", resolution: "answer", answer: { text: "First" } }] },
  });
  ledger = appendEvent(ledger, {
    event_id: "a",
    type: "pack_completed",
    payload: { responses: [{ question_id: "q:b:c", resolution: "answer", answer: { text: "Second" } }] },
  });
  const graph = projectGraph(ledger);
  const answers = graph.nodes.filter((node) => node.type === "answer");

  assert.equal(answers.length, 2);
  assert.equal(new Set(graph.nodes.map((node) => node.id)).size, graph.nodes.length);
  assert.equal(new Set(graph.edges.map((edge) => edge.id)).size, graph.edges.length);
});

test("ordinary item amendments preserve a previously flagged inference", () => {
  let ledger = createLedgerFromSeed({
    objective: "Preserve the dispute marker",
    questions: [basicQuestion],
    material_items: [{ id: "evidence", kind: "evidence", label: "Evidence", impact: 3, status: "verified" }],
  });
  ledger = appendEvent(ledger, { type: "inference_flagged", payload: { item_id: "evidence" } });
  ledger = appendEvent(ledger, {
    type: "item_updated",
    payload: { item_id: "evidence", patch: { detail: "Still disputed after a wording amendment" } },
  });

  assert.equal(ledger.items[0].inference_flagged, true);
  assert.equal(projectGraph(ledger).nodes.find((node) => node.id === "item:evidence").inference_flagged, true);
  assert.throws(
    () => appendEvent(ledger, {
      type: "item_updated",
      payload: { item_id: "evidence", patch: { inference_flagged: false } },
    }),
    /cannot change inference_flagged/,
  );
});

test("generated event types cannot be forged through the public append boundary", () => {
  const ledger = createLedgerFromSeed({ objective: "Generated event authority", questions: [basicQuestion] });
  assert.deepEqual(DECISION_SEMANTICS_V1.events.generated_only_types, ["ledger_created", "score_changed"]);
  assert.throws(
    () => appendEvent(ledger, { type: "ledger_created", payload: {} }),
    /generated internally/,
  );
  assert.throws(
    () => appendEvent(ledger, {
      type: "score_changed",
      payload: { previous_value: 0, next_value: 100 },
    }),
    /generated internally/,
  );
});

test("scope changes require a fresh version before opening a coverage blocker", () => {
  const ledger = createLedgerFromSeed({
    objective: "Scope identity",
    scope: "Same scope",
    scope_version: "1",
    questions: [basicQuestion],
    material_items: [{ id: "evidence", kind: "evidence", label: "Evidence", impact: 3, status: "verified" }],
  });
  assert.throws(
    () => appendEvent(ledger, { type: "scope_changed", payload: { scope: "Same scope", scope_version: "1" } }),
    /requires a new scope_version/,
  );
  const changed = appendEvent(ledger, { type: "scope_changed", payload: { scope: "Same scope", scope_version: "2" } });
  assert.throws(
    () => appendEvent(changed, { type: "scope_changed", payload: { scope: "Same scope", scope_version: "1" } }),
    /cannot reuse a prior scope_version/,
  );

  const reservedCoverageId = changed.events.find((event) => event.type === "scope_changed").payload.scope_coverage_item_id;
  const collisionLedger = createLedgerFromSeed({
    objective: "Scope identity with a reserved item ID",
    scope: "Same scope",
    scope_version: "1",
    questions: [basicQuestion],
    material_items: [{ id: reservedCoverageId, kind: "evidence", label: "Reserved", impact: 3, status: "verified" }],
  });
  const collisionChanged = appendEvent(collisionLedger, {
    type: "scope_changed",
    payload: { scope: "Same scope", scope_version: "2" },
  });
  const coverageEvent = collisionChanged.events.find((event) => event.type === "scope_changed");
  assert.equal(coverageEvent.payload.scope_coverage_item_id, reservedCoverageId + "-2");
  assert.equal(collisionChanged.items.find((item) => item.id === reservedCoverageId + "-2").component, "blocker");
});

test("known mutation relations name only the entities they actually mutate", () => {
  const ledger = createLedgerFromSeed({
    objective: "Exact mutation relations",
    questions: [basicQuestion],
    material_items: [
      { id: "a", kind: "blocker", label: "A", impact: 3, status: "open" },
      { id: "b", kind: "blocker", label: "B", impact: 3, status: "open" },
    ],
  });
  const resolved = appendEvent(ledger, {
    event_id: "resolve-a",
    type: "item_resolved",
    entity_ids: ["b"],
    payload: { item_id: "a" },
  });
  const event = resolved.events.find((entry) => entry.event_id === "resolve-a");
  const graph = projectGraph(resolved);

  assert.deepEqual(event.entity_ids, ["a"]);
  assert.ok(graph.edges.some((edge) => edge.from === "event:resolve-a" && edge.type === "resolves" && edge.to === "item:a"));
  assert.ok(!graph.edges.some((edge) => edge.from === "event:resolve-a" && edge.type === "resolves" && edge.to === "item:b"));

  const legacyUnion = JSON.parse(JSON.stringify(resolved));
  legacyUnion.events.find((entry) => entry.event_id === "resolve-a").entity_ids = ["a", "b"];
  const legacyGraph = projectGraph(legacyUnion);
  assert.ok(legacyGraph.edges.some((edge) => edge.from === "event:resolve-a" && edge.type === "resolves" && edge.to === "item:a"));
  assert.ok(!legacyGraph.edges.some((edge) => edge.from === "event:resolve-a" && edge.type === "resolves" && edge.to === "item:b"));
});

test("graph projection rejects a readiness receipt from another ledger", () => {
  const emptyLedger = createLedgerFromSeed({ objective: "No readiness inputs", questions: [basicQuestion] });
  const readyLedger = createLedgerFromSeed({
    objective: "Verified readiness input",
    questions: [basicQuestion],
    material_items: [{ id: "evidence", kind: "evidence", label: "Evidence", impact: 3, status: "verified" }],
  });
  const foreignReadiness = computeReadiness(readyLedger);

  assert.throws(
    () => projectGraph(emptyLedger, foreignReadiness),
    /readiness snapshot does not match/,
  );
});

test("graph projection verifies and preserves a custom scoring-policy receipt", () => {
  const ledger = createLedgerFromSeed({
    objective: "Custom policy receipt",
    questions: [basicQuestion],
    material_items: [
      { id: "evidence", kind: "evidence", label: "Evidence", impact: 3, status: "verified" },
      { id: "blocker", kind: "blocker", label: "Blocker", impact: 3, status: "open" },
    ],
  });
  const customPolicy = {
    id: "evidence-heavy",
    version: "1",
    label: "Evidence-heavy readiness",
    readiness_weights: { evidence: 10, blocker: 1, assumption: 1, contradiction: 1 },
  };
  const readiness = computeReadiness(ledger, customPolicy);
  const graph = projectGraph(ledger, readiness);
  const score = graph.nodes.find((node) => node.type === "score");

  assert.equal(score.value, readiness.score);
  assert.equal(score.policy.id, "evidence-heavy");
  assert.deepEqual(score.policy.definition.readiness_weights, customPolicy.readiness_weights);

  const defaultReceipt = computeReadiness(ledger);
  const legacyDefaultReceipt = JSON.parse(JSON.stringify(defaultReceipt));
  delete legacyDefaultReceipt.policy.definition;
  assert.doesNotThrow(() => projectGraph(ledger, legacyDefaultReceipt));

  const legacyCustomReceipt = JSON.parse(JSON.stringify(readiness));
  delete legacyCustomReceipt.policy.definition;
  assert.throws(() => projectGraph(ledger, legacyCustomReceipt), /readiness snapshot does not match/);
  assert.doesNotThrow(() => projectGraph(ledger, legacyCustomReceipt, customPolicy));

  const partialLedger = createLedgerFromSeed({
    objective: "Legacy partial status-credit receipt",
    questions: [basicQuestion],
    material_items: [{ id: "weak", kind: "evidence", label: "Weak", impact: 3, status: "weak" }],
  });
  const partialPolicy = {
    id: "legacy-partial-credit",
    version: "1",
    label: "Legacy partial credit",
    status_credit: { evidence: { weak: 0.9 } },
  };
  const legacyPartialReceipt = JSON.parse(JSON.stringify(computeReadiness(partialLedger, partialPolicy)));
  delete legacyPartialReceipt.policy.definition;
  legacyPartialReceipt.policy.hash = stableHash({
    id: partialPolicy.id,
    version: partialPolicy.version,
    readiness_weights: DEFAULT_SCORING_POLICY.readiness_weights,
    status_credit: partialPolicy.status_credit,
  });
  assert.doesNotThrow(() => projectGraph(partialLedger, legacyPartialReceipt, partialPolicy));
});

test("seed schema versions and graph ordering are canonical across runtimes", () => {
  for (const schemaVersion of ["decision-graph-seed/v999", "", 7]) {
    assert.throws(
      () => normalizeSeed({ schema_version: schemaVersion, objective: "Wrong schema", questions: [basicQuestion] }),
      /invalid schema version/,
    );
  }
  const ledger = createLedgerFromSeed({
    objective: "Code-point ordering",
    questions: [
      { id: "I", prompt: "Upper?", kind: "free_text" },
      { id: "i", prompt: "Lower?", kind: "free_text" },
    ],
  });
  assert.deepEqual(
    projectGraph(ledger).nodes.filter((node) => node.type === "question").map((node) => node.id),
    ["question:I", "question:i"],
  );
});

test("legacy free-text candidate references remain readable without weakening new writes", () => {
  const ledger = createLedgerFromSeed({
    objective: "Legacy candidate reference",
    questions: [basicQuestion],
    material_items: [{ id: "evidence", kind: "evidence", label: "Evidence", impact: 3, candidate_id: "candidate-a" }],
  });
  const legacyLedger = JSON.parse(JSON.stringify(ledger));
  legacyLedger.items[0].candidate_id = "Candidate A";

  assert.doesNotThrow(() => computeReadiness(legacyLedger));
  assert.doesNotThrow(() => projectGraph(legacyLedger));
});

test("known item events store canonical payload IDs and project their actual target", () => {
  let ledger = createLedgerFromSeed({
    objective: "Canonical mutation payloads",
    questions: [basicQuestion],
    material_items: [{ id: "a", kind: "assumption", label: "A", impact: 3, status: "untested" }],
  });
  ledger = appendEvent(ledger, {
    event_id: "update-a",
    type: "item_updated",
    payload: { item_id: " a ", patch: { detail: "Canonical target" } },
  });
  ledger = appendEvent(ledger, {
    event_id: "add-b",
    type: "material_item_added",
    payload: { item: { id: " b ", kind: "evidence", label: "B", impact: 3 } },
  });
  const update = ledger.events.find((event) => event.event_id === "update-a");
  const added = ledger.events.find((event) => event.event_id === "add-b");
  const graph = projectGraph(ledger);

  assert.equal(update.payload.item_id, "a");
  assert.equal(added.payload.item.id, "b");
  assert.ok(graph.edges.some((edge) => edge.from === "event:update-a" && edge.to === "item:a"));
  assert.ok(graph.edges.some((edge) => edge.from === "event:add-b" && edge.to === "item:b"));
});

test("a completed pack does not acquire relations to items created later", () => {
  let ledger = createLedgerFromSeed({ objective: "Historical completion snapshot", questions: [basicQuestion] });
  ledger = appendEvent(ledger, {
    event_id: "complete-before-item",
    type: "pack_completed",
    payload: { responses: [{ question_id: "q:q", resolution: "answer", answer: { text: "Done" } }] },
  });
  ledger = appendEvent(ledger, {
    event_id: "later-item",
    type: "material_item_added",
    payload: { item: { id: "later", kind: "evidence", label: "Later", impact: 3, related_question_id: "q" } },
  });
  const graph = projectGraph(ledger);

  assert.ok(!graph.edges.some((edge) => edge.from === "event:complete-before-item" && edge.to === "item:later"));
  assert.ok(graph.edges.some((edge) => edge.from === "event:later-item" && edge.to === "item:later"));
});

test("custom status credits must remain finite fractions", () => {
  const ledger = createLedgerFromSeed({
    objective: "Bound custom credits",
    questions: [basicQuestion],
    material_items: [{ id: "evidence", kind: "evidence", label: "Evidence", impact: 3, status: "verified" }],
  });
  for (const credit of [2, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => computeReadiness(ledger, { status_credit: { evidence: { verified: credit } } }),
      /finite number from 0 to 1/,
    );
  }
});

test("scope history compares canonical versions rather than raw whitespace", () => {
  let ledger = createLedgerFromSeed({ objective: "Canonical scope versions", scope_version: "1", questions: [basicQuestion] });
  ledger = appendEvent(ledger, { type: "scope_changed", payload: { scope_version: " 2 " } });
  assert.equal(ledger.events.find((event) => event.type === "scope_changed").payload.scope_version, "2");
  ledger = appendEvent(ledger, { type: "scope_changed", payload: { scope_version: "3" } });
  assert.throws(
    () => appendEvent(ledger, { type: "scope_changed", payload: { scope_version: " 2 " } }),
    /cannot reuse a prior scope_version/,
  );
});

test("embedded seed identity cannot absorb later questions or a foreign schema", () => {
  let ledger = createLedgerFromSeed({ objective: "Embedded seed integrity", questions: [basicQuestion] });
  ledger = appendEvent(ledger, {
    type: "pack_advanced",
    payload: { questions: [{ id: "later", prompt: "Later?", kind: "free_text" }] },
  });
  const foreignSchema = JSON.parse(JSON.stringify(ledger));
  foreignSchema.seed.schema_version = "decision-graph-seed/v999";
  assert.throws(() => projectGraph(foreignSchema), /embedded seed|ledger.seed has an invalid schema version/);

  const absorbedQuestion = JSON.parse(JSON.stringify(ledger));
  absorbedQuestion.seed.questions.push(JSON.parse(JSON.stringify(absorbedQuestion.questions.find((question) => question.id === "later"))));
  assert.throws(() => projectGraph(absorbedQuestion), /embedded seed identity/);
});

test("score delta events distinguish policies that reuse the same name and version", () => {
  const ledger = createLedgerFromSeed({
    objective: "Score-event policy provenance",
    questions: [basicQuestion],
    material_items: [
      { id: "evidence", kind: "evidence", label: "Evidence", impact: 3, status: "verified" },
      { id: "blocker", kind: "blocker", label: "Blocker", impact: 3, status: "open" },
    ],
  });
  const sharedIdentity = { id: "same-policy-name", version: "1", label: "Same label" };
  const evidenceHeavy = {
    ...sharedIdentity,
    readiness_weights: { evidence: 10, blocker: 1, assumption: 1, contradiction: 1 },
  };
  const blockerHeavy = {
    ...sharedIdentity,
    readiness_weights: { evidence: 1, blocker: 10, assumption: 1, contradiction: 1 },
  };
  const resolvedEvidenceHeavy = appendEvent(ledger, {
    type: "item_resolved",
    payload: { item_id: "blocker" },
  }, evidenceHeavy);
  const resolvedBlockerHeavy = appendEvent(ledger, {
    type: "item_resolved",
    payload: { item_id: "blocker" },
  }, blockerHeavy);
  const first = resolvedEvidenceHeavy.events.find((event) => event.type === "score_changed");
  const second = resolvedBlockerHeavy.events.find((event) => event.type === "score_changed");

  assert.equal(first.payload.policy_version, second.payload.policy_version);
  assert.notEqual(first.payload.policy_hash, second.payload.policy_hash);
  assert.notDeepEqual(first.payload.policy_definition.readiness_weights, second.payload.policy_definition.readiness_weights);
  assert.notEqual(first.payload.delta, second.payload.delta);
});
