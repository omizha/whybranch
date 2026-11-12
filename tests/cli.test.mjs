import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalizeDraft,
  normalizeSubmission,
  normalizeUiState,
  renderDocument,
  run,
} from "../src/cli/command.mjs";
import {
  computeReadiness,
  createLedgerFromSeed,
  projectGraph,
} from "../src/core/index.mjs";
import { beginRecoveryCommit, persistRecoveryReplica } from "../src/cli/workspace-store.mjs";

function seed(questionId = "risk", prompt = "Which risk needs attention first?") {
  return {
    objective: "Choose the first validation for a local decision tool",
    scope: "one developer workflow",
    horizon: "this week",
    questions: [
      {
        id: questionId,
        prompt,
        kind: "mixed",
        selection_mode: "multiple",
        options: [
          { id: "privacy", label: "Local-data handling" },
          { id: "adoption", label: "Agent workflow fit" },
        ],
        allow_other: true,
      },
    ],
    material_items: [
      {
        id: "assumption-local-only",
        kind: "assumption",
        label: "The first release is single-user and loopback-only",
        impact: "high",
      },
    ],
  };
}

function renderedDocument(currentSeed) {
  const ledger = createLedgerFromSeed(currentSeed);
  const snapshot = {
    readiness: computeReadiness(ledger),
    graph: projectGraph(ledger),
  };
  return renderDocument({
    workspace_id: "workspace-00000000-0000-4000-8000-000000000000",
    ledger,
    pack_events: [],
    history: [],
    current: {
      revision: 1,
      phase: "open",
      seed: currentSeed,
      draft: { responses: [] },
      completion: null,
    },
  }, snapshot);
}

function renderedBrowserScript(currentSeed) {
  const html = renderedDocument(currentSeed);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "document should contain one browser script");
  return script;
}

function questionTextRuntime(script) {
  const start = script.indexOf("    function escapeHtml");
  const end = script.indexOf("    function questionKey");
  assert.ok(start >= 0 && end > start, "browser script should contain question text renderers");
  return new Function(`${script.slice(start, end)}\nreturn { renderInlineCode, renderRichText, renderQuestionPrompt };`)();
}

function graphProjectionRuntime(script, currentSeed) {
  const start = script.indexOf("    function graphLabel");
  const end = script.indexOf("    function spacedY");
  assert.ok(start >= 0 && end > start, "browser script should contain graph projection helpers");
  return new Function(`const seed = ${JSON.stringify(currentSeed)};\n${script.slice(start, end)}\nreturn { buildFocusGraph, buildOverviewGraph, graphNeedsAttention, graphScoreRelatedIds };`)();
}

function loopbackUnavailable(error) {
  return /\b(EACCES|EPERM|EADDRNOTAVAIL)\b|bind to 127\.0\.0\.1|listen .*127\.0\.0\.1/i.test(String(error?.message ?? error));
}

test("normalizes draft selections and auditable final non-answer resolutions", () => {
  const currentSeed = seed();
  assert.deepEqual(
    normalizeDraft(currentSeed, {
      responses: [{
        question_id: "q:risk",
        resolution: "answer",
        selections: ["privacy", "__other"],
        other_text: "A locally stored note",
      }],
    }),
    {
      responses: [{
        question_id: "q:risk",
        resolution: "answer",
        selections: ["privacy", "__other"],
        other_text: "A locally stored note",
      }],
    },
  );
  assert.deepEqual(
    normalizeDraft(currentSeed, {
      responses: [{
        question_id: "q:risk",
        resolution: "withdraw",
        note: "The premise duplicates a prior question.",
      }],
    }),
    {
      responses: [{
        question_id: "q:risk",
        resolution: "withdrawn",
        note: "The premise duplicates a prior question.",
      }],
    },
  );
  assert.deepEqual(
    normalizeSubmission(currentSeed, {
      responses: [{
        question_id: "q:risk",
        resolution: "withdrawn",
        withdrawal: { reason: "Out of scope for this pack" },
      }],
    }),
    {
      responses: [{
        question_id: "q:risk",
        resolution: "withdrawn",
        withdrawal: { reason: "Out of scope for this pack" },
      }],
    },
  );
  assert.deepEqual(
    normalizeSubmission(currentSeed, {
      responses: [{
        question_id: "q:risk",
        resolution: "defer",
        deferral: {
          reason: "The actual usage evidence is not available yet",
          clue: "Revisit after the first moderated session",
        },
      }],
    }),
    {
      responses: [{
        question_id: "q:risk",
        resolution: "defer",
        deferral: {
          reason: "The actual usage evidence is not available yet",
          clue: "Revisit after the first moderated session",
        },
      }],
    },
  );
  assert.deepEqual(
    normalizeSubmission(currentSeed, {
      responses: [{
        question_id: "q:risk",
        resolution: "not_applicable",
        not_applicable: { reason: "This pack only covers local browser behavior" },
      }],
    }),
    {
      responses: [{
        question_id: "q:risk",
        resolution: "not_applicable",
        not_applicable: { reason: "This pack only covers local browser behavior" },
      }],
    },
  );
  assert.deepEqual(
    normalizeSubmission(currentSeed, {
      responses: [{ question_id: "q:risk", resolution: "defer", deferral: { reason: "Need more evidence; revisit after user research." } }],
    }),
    {
      responses: [{ question_id: "q:risk", resolution: "defer", deferral: { reason: "Need more evidence; revisit after user research." } }],
    },
  );
  assert.throws(
    () => normalizeSubmission(currentSeed, {
      responses: [{ question_id: "q:risk", resolution: "not_applicable" }],
    }),
    /not_applicable/i,
  );
  assert.throws(
    () => normalizeSubmission(currentSeed, {
      responses: [{ question_id: "q:risk", resolution: "withdrawn", withdrawal: {} }],
    }),
    /withdrawal\.reason/i,
  );
  assert.throws(
    () => normalizeSubmission(currentSeed, {
      responses: [{
        question_id: "q:risk",
        resolution: "answer",
        answer: { option_id: "privacy" },
      }],
    }),
    /single-select/i,
  );
});

test("normalizes revision-scoped browser UI state without accepting unknown or invalid graph state", () => {
  const normalized = normalizeUiState({
    score_details_open: true,
    graph_legend_open: false,
    graph_json_open: true,
    graph_view: "overview",
    graph_filter: "history",
    collapsed_graph_types: ["event", "answer"],
    selected_node_id: "item:assumption-local-only",
    graph_viewport: {
      layout_key: "1200x640",
      x: 15.5,
      y: 7,
      width: 720,
      height: 384,
    },
  }, { graphNodeIds: new Set(["item:assumption-local-only"]) });
  assert.deepEqual(normalized.collapsed_graph_types, ["answer", "event"]);
  assert.equal(normalized.selected_node_id, "item:assumption-local-only");
  assert.equal(normalized.graph_viewport.width, 720);
  assert.throws(
    () => normalizeUiState({ ...normalized, unexpected: true }),
    /unsupported fields/i,
  );
  assert.throws(
    () => normalizeUiState({ ...normalized, collapsed_graph_types: ["event", "event"] }),
    /must not contain duplicates/i,
  );
  assert.throws(
    () => normalizeUiState({ ...normalized, selected_node_id: "item:missing" }, { graphNodeIds: new Set() }),
    /not present in the current graph/i,
  );
  assert.throws(
    () => normalizeUiState({ ...normalized, graph_viewport: { ...normalized.graph_viewport, width: Number.POSITIVE_INFINITY } }),
    /bounded finite number/i,
  );
});

test("generated browser script is parseable, escapes seed HTML, and keeps the current ledger snapshot", () => {
  const maliciousSeed = seed("script", "Will a closing script tag remain data?");
  maliciousSeed.objective = "</script><script>window.__unsafe = true</script>";
  const ledger = createLedgerFromSeed(maliciousSeed);
  const snapshot = {
    readiness: computeReadiness(ledger),
    graph: projectGraph(ledger),
  };
  const html = renderDocument({
    workspace_id: "workspace-00000000-0000-4000-8000-000000000000",
    ledger,
    pack_events: [],
    history: [],
    current: {
      revision: 1,
      phase: "completed",
      seed: maliciousSeed,
      draft: { responses: [] },
      completion: {
        completed_at: "2026-07-28T00:00:00.000Z",
        provenance_event_id: "event-test",
        normalized_response_patch: { responses: [] },
        readiness: snapshot.readiness,
        graph: snapshot.graph,
      },
    },
  }, snapshot);
  assert.doesNotMatch(html, /<\/script><script>window\.__unsafe/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "document should contain one browser script");
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /let model = initialStatus/);
  assert.match(script, /showCompletion\(initialCompletion, false\)/);
  assert.match(script, /const AUTOSAVE_DELAY_MS = 450/);
  assert.match(html, /data-answer-text=/);
  assert.match(html, /보류 처리/);
  assert.match(html, /다음 팩에서 다시 질문/);
  assert.match(html, /이번 결정 범위에서 제외/);
  assert.match(html, /질문 자체를 철회/);
  assert.match(html, /data-defer-action=/);
  assert.match(html, /보류 메모 \(필수\)/);
  assert.doesNotMatch(html, /다시 물을 조건 \(필수\)/);
  assert.doesNotMatch(html, /data-clue-text=/);
  assert.match(script, /function resolutionDefinition/);
  assert.match(script, /function effectiveResolution/);
  assert.match(script, /marks_not_applicable/);
  assert.doesNotMatch(html, /data-voice-|getUserMedia|SpeechRecognition|AudioWorklet|sherpa-onnx/i);
});

test("graph UI offers a current-decision focus and an explorable, collapsible ledger map", () => {
  const html = renderedDocument(seed());
  const script = renderedBrowserScript(seed());
  assert.match(html, /data-graph-view="focus"/);
  assert.match(html, /data-graph-view="overview"/);
  assert.match(html, /탐색 지도/);
  assert.match(html, /data-graph-filter="history"/);
  assert.match(html, /data-graph-groups="history"/);
  assert.match(html, /data-graph-groups="expand"/);
  assert.match(html, /data-graph-zoom="in"/);
  assert.match(html, /data-graph-zoom="out"/);
  assert.match(html, /data-graph-zoom="reset"/);
  assert.match(html, /graph-inspector/);
  assert.match(script, /function buildFocusGraph/);
  assert.match(script, /function buildOverviewGraph/);
  assert.match(script, /function toggleGraphLane/);
  assert.match(script, /function attachGraphNavigation/);
  assert.match(script, /collapsedGraphTypes/);
  assert.match(script, /graphFilter === "history"\) collapsedGraphTypes\.delete\("event"\)/);
  assert.match(script, /탐색 지도 · " \+ view\.nodes\.length/);
  assert.match(script, /selectedGraphNodeId/);
  assert.doesNotMatch(script, /allNodes\.slice\(\)\.sort\([\s\S]{0,180}\)\.slice\(0, 12\)/);
});

test("focus remains on the current pack while explorer collapse is a non-destructive UI projection", () => {
  const currentSeed = seed();
  const graph = {
    nodes: [
      { id: "decision:main", type: "decision", label: "Decision" },
      { id: "score:readiness", type: "score", label: "Readiness" },
      { id: "question:risk", type: "question", label: "Current question" },
      { id: "question:past", type: "question", label: "Historical question" },
      { id: "blocker:open", type: "blocker", label: "Open blocker", status: "open" },
      { id: "answer:1", type: "answer", label: "Historical answer" },
      { id: "event:1", type: "event", label: "Historical event" },
    ],
    edges: [
      { from: "decision:main", to: "question:risk", type: "asks" },
      { from: "decision:main", to: "question:past", type: "asks" },
      { from: "blocker:open", to: "question:past", type: "blocks" },
      { from: "blocker:open", to: "score:readiness", type: "affects_score" },
      { from: "decision:main", to: "score:readiness", type: "scored_as" },
      { from: "event:1", to: "answer:1", type: "records" },
    ],
  };
  const before = structuredClone(graph);
  const runtime = graphProjectionRuntime(renderedBrowserScript(currentSeed), currentSeed);

  const focus = runtime.buildFocusGraph(graph);
  assert.deepEqual(focus.nodes.map((node) => node.id), [
    "decision:main",
    "question:risk",
    "blocker:open",
    "score:readiness",
  ]);
  assert.equal(focus.current_question_count, 1);
  assert.equal(focus.nodes.some((node) => node.id === "question:past"), false);

  const overview = runtime.buildOverviewGraph(graph, "history", new Set(["answer", "event"]));
  assert.equal(overview.source_nodes.length, 7);
  assert.equal(overview.nodes.length, 5);
  assert.equal(overview.collapsed_node_count, 2);
  assert.equal(overview.collapsed_edge_count, 1);
  assert.deepEqual(graph, before, "collapse must not mutate the ledger graph");

  const scoreRelated = runtime.graphScoreRelatedIds([
    { from: "blocker:open", to: "score:readiness", type: "affects_score" },
    { from: "blocker:resolved", to: "score:readiness", type: "affects_score" },
  ]);
  assert.equal(runtime.graphNeedsAttention({ id: "blocker:open", type: "blocker", status: "open" }, scoreRelated), true);
  assert.equal(runtime.graphNeedsAttention({ id: "blocker:resolved", type: "blocker", status: "resolved" }, scoreRelated), false);
});

test("fenced question code preserves whitespace and cannot become executable HTML", () => {
  const text = questionTextRuntime(renderedBrowserScript(seed()));
  const rendered = text.renderRichText([
    "설명에 `runWithLimit`를 포함합니다.",
    "",
    "```ts",
    "const source = '<script>unsafe()</script>';",
    "await runWithLimit(tasks, 3);",
    "```",
    "",
    "코드를 읽고 설명하세요.",
  ].join("\n"));

  assert.match(rendered, /class="code-block"/);
  assert.match(rendered, /data-code-language="ts"/);
  assert.match(rendered, /<pre><code>const source = &#39;&lt;script&gt;unsafe\(\)&lt;\/script&gt;&#39;;\nawait runWithLimit/);
  assert.doesNotMatch(rendered, /<script>unsafe\(\)<\/script>/);
  assert.match(rendered, /<code class="inline-code">runWithLimit<\/code>/);
  assert.match(rendered, /data-code-copy/);
});

test("a malformed one-line TypeScript fence still renders as a bounded, copyable code block", () => {
  const text = questionTextRuntime(renderedBrowserScript(seed()));
  const rendered = text.renderRichText("아래 코드를 읽으세요. ``` ts type Task<T> = () => Promise<T>;\nconst next = 0; ``` 그리고 순서를 설명하세요.");

  assert.match(rendered, /class="code-block"/);
  assert.match(rendered, /data-code-language="ts"/);
  assert.match(rendered, /type Task&lt;T&gt; = \(\) =&gt; Promise&lt;T&gt;;\nconst next = 0;/);
  assert.match(rendered, /그리고 순서를 설명하세요/);
});

test("a multiline question keeps a short heading and renders later paragraphs as escaped rich text", () => {
  const text = questionTextRuntime(renderedBrowserScript(seed()));
  const rendered = text.renderQuestionPrompt([
    "첫 불일치 지점을 고르세요.",
    "",
    "[계약]",
    "1) ACCEPTED는 이동이 아닙니다.",
    "2) <script>unsafe()</script>는 데이터입니다.",
    "",
    "[시간축]",
    "10:00 API → ACCEPTED",
  ].join("\n"));

  assert.equal(rendered.heading, "첫 불일치 지점을 고르세요.");
  assert.match(rendered.detail, /^<div class="prompt-detail rich-text">/);
  assert.match(rendered.detail, /<p>\[계약\]<br>1\) ACCEPTED는 이동이 아닙니다\.<br>2\) &lt;script&gt;unsafe\(\)&lt;\/script&gt;는 데이터입니다\.<\/p>/);
  assert.match(rendered.detail, /<p>\[시간축\]<br>10:00 API → ACCEPTED<\/p>/);
  assert.doesNotMatch(rendered.detail, /<script>unsafe\(\)<\/script>/);

  const singleLine = text.renderQuestionPrompt("짧은 질문입니다.");
  assert.deepEqual(singleLine, { heading: "짧은 질문입니다.", detail: "" });
});

test("one loopback workspace autosaves, completes, advances in place, and finishes", { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "whybranch-cli-test-"));
  const firstSeed = join(root, "first-seed.json");
  const secondSeed = join(root, "second-seed.json");
  const addedItem = join(root, "added-item.json");
  const amendedItem = join(root, "amended-item.json");
  const followupItem = join(root, "followup-item.json");
  await writeFile(firstSeed, `${JSON.stringify(seed(), null, 2)}\n`, "utf8");
  const broaderSeed = {
    ...seed("next", "What should be checked after the first result?"),
    scope: "a broader developer workflow",
    scope_version: "2",
  };
  await writeFile(secondSeed, `${JSON.stringify(broaderSeed, null, 2)}\n`, "utf8");
  await writeFile(addedItem, `${JSON.stringify({
    id: "evidence-first-user",
    kind: "evidence",
    label: "A first user completed the local handoff",
    impact: "high",
    status: "verified",
  }, null, 2)}\n`, "utf8");
  await writeFile(amendedItem, `${JSON.stringify({ status: "validated", detail: "The score label was reviewed by a user." }, null, 2)}\n`, "utf8");
  await writeFile(followupItem, `${JSON.stringify({
    id: "evidence-followup",
    kind: "evidence",
    label: "The follow-up answer supplied direct evidence",
    impact: "medium",
    status: "verified",
    related_question_id: "next",
  }, null, 2)}\n`, "utf8");
  let workspaceId;
  try {
    await assert.rejects(
      () => run(["voice"], { rootDir: root }),
      /unsupported command: voice/i,
    );
    await assert.rejects(
      () => run(["start", "--seed-file", firstSeed, "--pack", "interview"], { rootDir: root }),
      /either --seed-file or --pack/i,
    );
    await assert.rejects(
      () => run(["start", "--pack", "missing"], { rootDir: root }),
      /unknown built-in pack: missing/i,
    );
    let started;
    try {
      started = await run(["start", "--seed-file", firstSeed], { rootDir: root });
    } catch (error) {
      if (loopbackUnavailable(error) && (process.env.WHYBRANCH_ALLOW_LOOPBACK_SKIP ?? process.env.DGI_ALLOW_LOOPBACK_SKIP) === "1") {
        t.skip(`loopback binding is unavailable in this environment: ${error.message}`);
        return;
      }
      throw error;
    }
    workspaceId = started.workspace_id;
    assert.match(workspaceId, /^workspace-/);
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/workspaces\/workspace-/);
    assert.equal(started.revision, 1);
    assert.equal(started.storage.durability, "persistent-local");
    assert.match(started.storage.recovery_replica, /recovery\/workspace-.*\/workspace\.latest\.json$/);

    await assert.rejects(
      () => run(["consume", "--workspace", workspaceId], { rootDir: root }),
      /has not been completed/i,
    );

    const draftResponse = await fetch(`${new URL(started.url).origin}/api/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        responses: [{
          question_id: "q:risk",
          resolution: "answer",
          selections: ["privacy", "__other"],
          other_text: "Keep it local",
          text: "Draft detail",
        }],
      }),
    });
    assert.equal(draftResponse.status, 200);
    const afterDraft = await run(["status", "--workspace", workspaceId], { rootDir: root });
    assert.equal(afterDraft.phase, "open");
    assert.ok(afterDraft.draft_saved_at);
    const selectedUiNode = afterDraft.graph.nodes.find((node) => node.type === "assumption")?.id
      ?? afterDraft.graph.nodes[0].id;
    const uiStateResponse = await fetch(`${new URL(started.url).origin}/api/ui-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: afterDraft.revision,
        ledger_revision: afterDraft.ledger_revision,
        ui_state: {
          score_details_open: true,
          graph_legend_open: true,
          graph_json_open: false,
          graph_view: "overview",
          graph_filter: "history",
          collapsed_graph_types: ["answer"],
          selected_node_id: selectedUiNode,
          graph_viewport: { layout_key: "1200x640", x: 18, y: 9, width: 720, height: 384 },
        },
      }),
    });
    assert.equal(uiStateResponse.status, 200);
    const uiStateReceipt = await uiStateResponse.json();
    assert.equal(uiStateReceipt.ledger_revision, afterDraft.ledger_revision);
    assert.equal(uiStateReceipt.storage_health.status, "healthy");
    const activeStateAfterUiSave = JSON.parse(await readFile(join(root, workspaceId, "workspace.json"), "utf8"));
    assert.equal(activeStateAfterUiSave.current.ui_state.workspace_revision, 1);
    assert.equal(activeStateAfterUiSave.current.ui_state.ledger_revision, afterDraft.ledger_revision);
    assert.equal(activeStateAfterUiSave.current.ui_state.graph_view, "overview");
    assert.deepEqual(activeStateAfterUiSave.current.ui_state.collapsed_graph_types, ["answer"]);
    const staleUiStateResponse = await fetch(`${new URL(started.url).origin}/api/ui-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 0,
        ledger_revision: afterDraft.ledger_revision,
        ui_state: activeStateAfterUiSave.current.ui_state,
      }),
    });
    assert.equal(staleUiStateResponse.status, 409);
    const restoredPage = await fetch(started.url);
    assert.equal(restoredPage.status, 200);
    assert.match(restoredPage.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(restoredPage.headers.get("content-security-policy") ?? "", /media-src 'none'/);
    assert.equal(restoredPage.headers.get("x-frame-options"), "DENY");
    assert.equal(restoredPage.headers.get("x-content-type-options"), "nosniff");
    const restoredHtml = await restoredPage.text();
    assert.match(restoredHtml, /Keep it local/);
    assert.match(restoredHtml, /const AUTOSAVE_DELAY_MS = 450/);
    assert.match(restoredHtml, /const UI_STATE_SAVE_DELAY_MS = 300/);
    assert.match(restoredHtml, /"graph_view":"overview"/);
    assert.match(restoredHtml, /id="graph-legend" class="graph-legend" open/);
    assert.match(restoredHtml, /결정 준비도 \(heuristic\):/);
    assert.match(restoredHtml, /\/ 100/);

    const pendingWitnessActive = JSON.parse(await readFile(join(root, workspaceId, "workspace.json"), "utf8"));
    await beginRecoveryCommit(root, workspaceId, {
      ...pendingWitnessActive,
      storage_generation: pendingWitnessActive.storage_generation + 1,
    });
    const pendingWitnessRepaired = await run(["recover", "--workspace", workspaceId], { rootDir: root });
    assert.equal(pendingWitnessRepaired.backup_repaired, true);
    assert.equal(pendingWitnessRepaired.storage_health.status, "healthy");

    const healthMismatchActive = JSON.parse(await readFile(join(root, workspaceId, "workspace.json"), "utf8"));
    await persistRecoveryReplica(root, workspaceId, {
      ...healthMismatchActive,
      storage_health: { status: "healthy", verified_at: "2026-08-24T00:00:00.000Z" },
    });
    await writeFile(join(root, workspaceId, "workspace.json"), `${JSON.stringify({
      ...healthMismatchActive,
      storage_health: { status: "degraded", detected_at: "2026-08-24T00:00:01.000Z", error: "simulated post-commit replica failure" },
    }, null, 2)}\n`, "utf8");
    const mutationWhileDegraded = await fetch(`${new URL(started.url).origin}/api/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, responses: [] }),
    });
    assert.equal(mutationWhileDegraded.status, 503);
    const healthRepaired = await run(["recover", "--workspace", workspaceId], { rootDir: root });
    assert.equal(healthRepaired.backup_repaired, true);
    assert.equal(healthRepaired.storage_health.status, "healthy");

    const foreignOrigin = await fetch(`${new URL(started.url).origin}/api/draft`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://example.test" },
      body: JSON.stringify({ revision: 1, responses: [] }),
    });
    assert.equal(foreignOrigin.status, 403);
    const plainTextMutation = await fetch(`${new URL(started.url).origin}/api/draft`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ revision: 1, responses: [] }),
    });
    assert.equal(plainTextMutation.status, 415);

    const completeResponse = await fetch(`${new URL(started.url).origin}/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        responses: [{
          question_id: "q:risk",
          resolution: "answer",
          answer: {
            option_ids: ["privacy", "adoption"],
            other_text: "Keep it local",
            text: "Final detail",
          },
        }],
      }),
    });
    assert.equal(completeResponse.status, 200);
    const duplicate = await fetch(`${new URL(started.url).origin}/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, responses: [] }),
    });
    assert.equal(duplicate.status, 409);

    const consumed = await run(["consume", "--workspace", workspaceId], { rootDir: root });
    assert.equal(consumed.phase, "completed");
    assert.equal(consumed.completion.normalized_response_patch.responses[0].answer.text, "Final detail");
    assert.ok(consumed.ledger.events.some((event) => event.type === "pack_completed"));
    assert.ok(consumed.graph.nodes.some((node) => node.type === "answer" && node.question_id === "risk"));
    assert.ok(consumed.graph.edges.some((edge) => edge.type === "answers" && edge.to === "question:risk"));

    const added = await run([
      "add-item",
      "--workspace", workspaceId,
      "--item-file", addedItem,
    ], { rootDir: root });
    assert.equal(added.addition.type, "material_item_added");
    assert.ok(added.readiness.score > consumed.readiness.score);
    assert.ok(added.material_items.some((item) => item.id === "evidence-first-user"));

    const concurrentItems = await Promise.all(["one", "two", "three"].map(async (suffix) => {
      const itemFile = join(root, `concurrent-${suffix}.json`);
      await writeFile(itemFile, `${JSON.stringify({
        id: `evidence-concurrent-${suffix}`,
        kind: "evidence",
        label: `Concurrent local evidence ${suffix}`,
        impact: "low",
        status: "verified",
      }, null, 2)}\n`, "utf8");
      return run(["add-item", "--workspace", workspaceId, "--item-file", itemFile], { rootDir: root });
    }));
    assert.equal(concurrentItems.length, 3);
    const afterConcurrentWrites = await run(["status", "--workspace", workspaceId], { rootDir: root });
    assert.equal(afterConcurrentWrites.material_items.filter((item) => item.id.startsWith("evidence-concurrent-")).length, 3);

    const flagged = await run([
      "flag-inference",
      "--workspace", workspaceId,
      "--item", "evidence-first-user",
      "--reason", "The prior inference overstates the available evidence.",
    ], { rootDir: root });
    assert.equal(flagged.correction.type, "inference_flagged");
    assert.equal(flagged.correction.item_id, "evidence-first-user");
    assert.ok(flagged.readiness.score < added.readiness.score);
    assert.equal(flagged.material_items.find((item) => item.id === "evidence-first-user").inference_flagged, true);
    assert.equal(flagged.graph.nodes.find((node) => node.id === "item:evidence-first-user").inference_flagged, true);

    const amended = await run([
      "amend-item",
      "--workspace", workspaceId,
      "--item", "assumption-local-only",
      "--patch-file", amendedItem,
    ], { rootDir: root });
    assert.equal(amended.correction.type, "item_updated");
    assert.ok(amended.readiness.score > flagged.readiness.score);
    assert.equal(amended.material_items.find((item) => item.id === "assumption-local-only").status, "validated");

    const advanced = await run(["advance", "--workspace", workspaceId, "--seed-file", secondSeed], { rootDir: root });
    assert.equal(advanced.workspace_id, workspaceId);
    assert.equal(advanced.url, started.url);
    assert.equal(advanced.revision, 2);
    assert.equal(advanced.phase, "open");
    assert.equal(advanced.transition.payload.previous_revision, 1);
    assert.equal(advanced.transition.payload.next_revision, 2);
    assert.deepEqual(advanced.transition.payload.question_ids, ["next"]);
    assert.deepEqual(advanced.transition.payload.questions, broaderSeed.questions);
    assert.equal(advanced.transition.payload.scope_changed, true);
    assert.equal(advanced.readiness.scope_version, "2");
    assert.equal(advanced.scope_transition.type, "scope_changed");
    const legacyPackEventState = JSON.parse(await readFile(join(root, workspaceId, "workspace.json"), "utf8"));
    legacyPackEventState.pack_events = legacyPackEventState.pack_events.map((event) => {
      const legacy = JSON.parse(JSON.stringify(event));
      if (legacy.type === "pack_advanced") {
        delete legacy.entity_ids;
        delete legacy.payload.introduced_question_ids;
      }
      if (legacy.type === "scope_changed") {
        legacy.entity_ids = [];
        delete legacy.payload.scope_coverage_item_id;
      }
      return legacy;
    });
    await writeFile(
      join(root, workspaceId, "workspace.json"),
      `${JSON.stringify(legacyPackEventState, null, 2)}\n`,
      "utf8",
    );
    await persistRecoveryReplica(root, workspaceId, legacyPackEventState);
    const afterAdvanceStatus = await run(["status", "--workspace", workspaceId], { rootDir: root });
    assert.equal(afterAdvanceStatus.material_items.find((item) => item.id === "evidence-first-user").inference_flagged, true);
    const followupAdded = await run([
      "add-item",
      "--workspace", workspaceId,
      "--item-file", followupItem,
    ], { rootDir: root });
    assert.ok(followupAdded.graph.nodes.some((node) => node.id === "question:next"));
    assert.ok(followupAdded.graph.edges.some((edge) => edge.from === "item:evidence-followup" && edge.to === "question:next" && edge.type === "supports"));
    assert.ok(followupAdded.graph.edges.some((edge) => edge.type === "introduces" && edge.to === "question:next"));
    const advancedPage = await fetch(started.url);
    assert.equal(advancedPage.status, 200);
    assert.match(await advancedPage.text(), /What should be checked after the first result\?/);
    const durableUiStateResponse = await fetch(`${new URL(started.url).origin}/api/ui-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: followupAdded.revision,
        ledger_revision: followupAdded.ledger_revision,
        ui_state: {
          score_details_open: true,
          graph_legend_open: false,
          graph_json_open: true,
          graph_view: "overview",
          graph_filter: "score",
          collapsed_graph_types: ["answer", "event"],
          selected_node_id: "question:next",
          graph_viewport: { layout_key: "1440x720", x: 21, y: 11, width: 900, height: 450 },
        },
      }),
    });
    assert.equal(durableUiStateResponse.status, 200);

    const finished = await run(["finish", "--workspace", workspaceId], { rootDir: root });
    assert.equal(finished.workspace_id, workspaceId);
    assert.equal(finished.finished, true);
    assert.equal(finished.archived, true);
    assert.equal(finished.already_archived, false);
    assert.equal(finished.listener_closed, true);
    assert.equal(finished.recovery_exact, true);
    assert.equal(finished.storage_health.status, "healthy");
    const archivedState = JSON.parse(await readFile(join(root, "archive", workspaceId, "workspace.json"), "utf8"));
    assert.equal(archivedState.workspace_id, workspaceId);
    assert.equal(archivedState.current.revision, 2);
    assert.equal(archivedState.ledger.revision, followupAdded.ledger_revision);
    assert.equal(archivedState.current.ui_state.graph_filter, "score");
    assert.equal(archivedState.current.ui_state.graph_viewport.x, 21);
    assert.equal(archivedState.lifecycle, "archived");
    const recoveries = await Promise.all([
      run(["recover", "--workspace", workspaceId], { rootDir: root }),
      run(["recover", "--workspace", workspaceId], { rootDir: root }),
    ]);
    const recovered = recoveries.find((entry) => entry.recovered_from === "archive") ?? recoveries[0];
    assert.equal(recovered.workspace_id, workspaceId);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recovered_from, "archive");
    assert.equal(recovered.recovery_exact, true);
    assert.match(recovered.url, /^http:\/\/127\.0\.0\.1:\d+\/workspaces\/workspace-/);
    assert.equal(new Set(recoveries.map((entry) => entry.url)).size, 1);
    assert.equal(recoveries.filter((entry) => entry.listener_restarted).length, 1);
    const recoveredPage = await fetch(recovered.url);
    assert.equal(recoveredPage.status, 200);
    const recoveredHtml = await recoveredPage.text();
    assert.match(recoveredHtml, /"graph_filter":"score"/);
    assert.match(recoveredHtml, /"layout_key":"1440x720"/);
    assert.match(recoveredHtml, /id="graph-json-details" open/);
    const refinished = await run(["finish", "--workspace", workspaceId], { rootDir: root });
    assert.equal(refinished.archived, true);
    await writeFile(join(root, "recovery", workspaceId, "workspace.latest.json"), "{corrupt", "utf8");
    const alreadyFinished = await run(["finish", "--workspace", workspaceId], { rootDir: root });
    assert.equal(alreadyFinished.already_archived, true);
    assert.equal(alreadyFinished.recovery_exact, true);
    assert.equal(alreadyFinished.storage_health.status, "healthy");
    workspaceId = undefined;

    const packStarted = await run(["start", "--pack", "interview"], { rootDir: root });
    workspaceId = packStarted.workspace_id;
    assert.match(packStarted.url, /^http:\/\/127\.0\.0\.1:\d+\/workspaces\/workspace-/);
    const packPage = await fetch(packStarted.url);
    assert.equal(packPage.status, 200);
    const packHtml = await packPage.text();
    assert.match(packHtml, /한국어 모의 면접/);
    assert.match(packHtml, /data-answer-text=/);
    assert.doesNotMatch(packHtml, /data-voice-|getUserMedia|SpeechRecognition|AudioWorklet|sherpa-onnx/i);
    const packFinished = await run(["finish", "--workspace", workspaceId], { rootDir: root });
    assert.equal(packFinished.workspace_id, workspaceId);
    assert.equal(packFinished.finished, true);
    assert.equal(packFinished.archived, true);
    workspaceId = undefined;
  } finally {
    if (workspaceId) {
      await run(["finish", "--workspace", workspaceId], { rootDir: root }).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});
