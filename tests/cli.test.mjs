import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalizeDraft,
  normalizeSubmission,
  renderDocument,
  run,
} from "../src/cli/command.mjs";
import {
  computeReadiness,
  createLedgerFromSeed,
  projectGraph,
} from "../src/core/index.mjs";

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

function loopbackUnavailable(error) {
  return /\b(EACCES|EPERM|EADDRNOTAVAIL)\b|bind to 127\.0\.0\.1|listen .*127\.0\.0\.1/i.test(String(error?.message ?? error));
}

test("normalizes draft selections and final withdrawn resolutions", () => {
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
});

test("one loopback workspace autosaves, completes, advances in place, and finishes", { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "decision-graph-cli-test-"));
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
    let started;
    try {
      started = await run(["start", "--seed-file", firstSeed], { rootDir: root });
    } catch (error) {
      if (loopbackUnavailable(error) && process.env.DGI_ALLOW_LOOPBACK_SKIP === "1") {
        t.skip(`loopback binding is unavailable in this environment: ${error.message}`);
        return;
      }
      throw error;
    }
    workspaceId = started.workspace_id;
    assert.match(workspaceId, /^workspace-/);
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/workspaces\/workspace-/);
    assert.equal(started.revision, 1);

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
    const restoredPage = await fetch(started.url);
    assert.equal(restoredPage.status, 200);
    assert.match(restoredPage.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(restoredPage.headers.get("x-frame-options"), "DENY");
    assert.equal(restoredPage.headers.get("x-content-type-options"), "nosniff");
    const restoredHtml = await restoredPage.text();
    assert.match(restoredHtml, /Keep it local/);
    assert.match(restoredHtml, /const AUTOSAVE_DELAY_MS = 450/);
    assert.match(restoredHtml, /결정 준비도 \(heuristic\):/);
    assert.match(restoredHtml, /\/ 100/);

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

    const finished = await run(["finish", "--workspace", workspaceId], { rootDir: root });
    assert.deepEqual(finished, { workspace_id: workspaceId, finished: true });
    workspaceId = undefined;
  } finally {
    if (workspaceId) {
      await run(["finish", "--workspace", workspaceId], { rootDir: root }).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});
