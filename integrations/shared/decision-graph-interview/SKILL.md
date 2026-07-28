---
name: decision-graph-interview
description: Run a batched, evidence-bound Decision Graph interview in one local browser workspace. Use when the user explicitly invokes $decision-graph-interview, asks for an interactive local decision form, browser workspace, answer session, or visible decision graph. Keep ordinary advice and explicitly chat-only requests in chat.
---

# Decision Graph Interview

Use one loopback-only workspace to capture user evidence without forcing a conclusion early. Treat the browser as a temporary response-capture surface and the agent conversation as the reasoning continuity layer.

## Choose the delivery mode

- Start a local workspace for an explicit `$decision-graph-interview` invocation or a request for an interactive form, local browser workspace, answer session, or decision graph.
- Stay in chat only when the user explicitly asks to avoid a form or asks for ordinary advice, writing, explanation, or a decision that can be answered directly.
- Do not silently start a browser workspace because a request merely contains a trade-off.

## Prepare a first pack

1. Infer the objective, scope, horizon, known constraints, and any working assumption from the request. Start with `scope_version: "1"`; retain it for a follow-up pack unless the decision scope materially changes, then increment it explicitly.
2. Separate current blockers, conditionally locked follow-ups, and candidate-specific uncertainty. Do not convert a plausible answer into user evidence.
3. Create three to five independent foundation questions. Keep genuinely dependent questions out of the first pack and record their unlock condition.
4. Use `selection_mode: "multiple"` only when several answers can independently be true. Leave it as `single` for mutually exclusive choices.
5. Include optional material items only for known assumptions, blockers, evidence, or counterevidence. Never preselect a candidate, ranking, or conclusion.

## Run the stable workspace

Resolve the local CLI once. Prefer the installed `decision-graph` binary. When
working from a checkout before npm publication, use the checkout binary with
Node instead; do not assume `npx` can resolve an unpublished package:

```sh
# Installed package
decision-graph start --seed-file /path/to/seed.json

# Checked-out source fallback
node /absolute/path/to/decision-graph-interview-open/bin/decision-graph.mjs start --seed-file /path/to/seed.json
```

Write the seed to a private temporary file and use the chosen command form for
every command in this session. Read the JSON result and retain its
`workspace_id`, `url`, and `revision` in the current task state. The returned
loopback URL is authoritative; never invent a URL, workspace identifier, or
completion state.

In the command snippets below, `<dgi-cli>` is notation rather than a literal
shell command. Replace it with the exact form resolved above for this session:
either `decision-graph` or `node /absolute/path/to/decision-graph-interview-open/bin/decision-graph.mjs`. Do not switch command forms mid-workspace.

Tell the user to open that URL. Explain, in the user's language, that edits auto-save locally but are not final. For Korean, use:

> 작성 내용은 자동 저장됩니다. 완료하려면 `Codex로 계속`을 누른 뒤, 이 채팅에 `계속`이라고 입력해 주세요.

Do not duplicate the complete answer pack in chat. A compact decision frame and the URL are enough.

Use `<dgi-cli> status --workspace <workspace_id>` only to inspect the known workspace. Do not use a broad or ambiguous "latest" lookup.

## Consume, advance, and finish

When the user explicitly signals completion, run:

```sh
<dgi-cli> consume --workspace <workspace_id>
```

Consume only a completed result. Treat the normalized responses as user evidence, preserving wording or making a faithful short summary. A saved draft is not a completed answer. If the workspace is not complete, say so and preserve it; do not create a replacement workspace or infer responses.

After considering the completed result, keep the same URL and workspace for the next independent pack:

```sh
<dgi-cli> advance --workspace <workspace_id> --seed-file /path/to/next-seed.json
```

Use the returned revision to distinguish state changes. Call `finish --workspace <workspace_id>` when the decision session is over or the user asks to discard it. Do not finish a workspace merely because an auto-saved draft exists.

```sh
<dgi-cli> finish --workspace <workspace_id>
```

If a completed response materially supports a new or amended **explicit**
ledger item, record that interpretation separately. Never change the raw user
response or invent an item merely because an option sounds plausible:

```sh
# A new verified/open material item derived from consumed evidence
<dgi-cli> add-item --workspace <workspace_id> --item-file /path/to/item.json

# Correct a known material item's status/detail without changing its ID/kind
<dgi-cli> amend-item --workspace <workspace_id> --item <item_id> --patch-file /path/to/patch.json
```

If the user corrects their own completed answer, preserve the old response as
provenance and use a follow-up pack to capture the correction before recording
any material interpretation.

When a score appears to rest on a wrong inference, use the material-item IDs shown in the graph panel rather than editing the number:

```sh
<dgi-cli> flag-inference --workspace <workspace_id> --item <item_id> --reason "The evidence does not support this inference."
```

This appends an `inference_flagged` ledger event and recalculates the same policy. The displayed remaining uncertainty (heuristic) is a policy burden, not a probability.

## Interpret score and graph correctly

- Describe `Decision Readiness (heuristic/v2)` as a reproducible review aid, never as probability, confidence in the real world, success likelihood, or a recommendation by itself.
- Explain every score change with its policy version, rule, affected ledger items, and plain-language reason.
- Expect readiness to decrease when the ledger adds a high-impact blocker, counterevidence, a reopened candidate, or a material scope change. A new `scope_version` opens a visible scope-coverage blocker; do not describe the former score as still covering the new boundary.
- Treat the graph as a deterministic projection of the ledger. Use it to inspect provenance, open questions, assumptions, blockers, evidence, and re-open conditions; do not present its layout as causal proof.

## Protect local data

- The normal workflow is loopback-only and has no account, authentication, cloud sync, browser automation, or remote collaboration service.
- Do not expose the loopback URL on a network interface, share a workspace directory, or place secrets in a seed unless the user has explicitly accepted that local-file risk.
- Remove temporary seed files when they are no longer needed. Use `finish` to remove the workspace state.

## Quality gate

- Use a single stable workspace and advance its revision rather than opening a new browser tab for every pack.
- Keep user evidence, assistant inference, working assumptions, and recommendations visibly distinct.
- A new high-impact blocker, counterevidence, or corrected material fact reaches the score only through an explicit `add-item`, `amend-item`, or `flag-inference` event; `advance` must not silently merge a new seed's material items.
- Preserve unresolved conditions and a credible re-open path when they could change the decision.
- Keep action authorization separate: a decision brief can recommend a next step but cannot silently take an external action.
