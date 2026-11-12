# README screenshots

These are region captures of the running Whybranch `0.1.0-alpha.0` UI,
taken on 2026-09-23 with Chrome at a 1280 CSS-pixel viewport width and
2× device scale. The UI and text were not generated or retouched.

Source: [`examples/first-decision.json`](../../../examples/first-decision.json).
All seed data and draft answers are illustrative, not actual user outcomes.
The current UI labels are Korean; the public seed uses English questions.

- `question-form.png`: first question, with `autosave` and `handoff` selected
  and the following unsubmitted draft:
  > First check that a draft survives reload. Then ask a new user to find the explicit completion step.
- `decision-graph.png`: **탐색 지도** (exploration map), **미해결**
  (unresolved) filter, default fit, and `item:blocker-first-user` selected.

To refresh, start the public seed in an isolated demo state directory:

```sh
WHYBRANCH_WORKSPACE_ROOT="<demo-state-directory>" node ./bin/whybranch.mjs start --seed-file ./examples/first-decision.json
```

Open the returned URL, reproduce the states above, wait for saving to complete,
and capture the question card and graph with its detail panel. Preserve the
actual UI. Use the same state directory when running `finish` afterward.
Update the Korean README captions first, then align the English README.
