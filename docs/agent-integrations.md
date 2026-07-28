# Agent integrations

Codex and Claude Code share one canonical workflow source:

```text
integrations/shared/decision-graph-interview/SKILL.md
```

The adapter directories contain only target-specific installation metadata and a pointer to that source. They deliberately do not fork the workflow text. `npm run check` verifies that each adapter still resolves to the canonical skill and remains a thin wrapper.

The skill also needs the CLI that owns the local workspace. Before relying on an
installed `decision-graph` command, either install a published package whose
ownership you have verified, or keep a checked-out source copy and use its
`node /absolute/path/to/decision-graph-interview-open/bin/decision-graph.mjs`
fallback. Do not assume `npx` can resolve this alpha package before publication.

## Install the shared skill in Codex

From a checked-out package, copy the canonical source into the normal Codex skill location:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills/decision-graph-interview"
cp ./integrations/shared/decision-graph-interview/SKILL.md \
  "${CODEX_HOME:-$HOME/.codex}/skills/decision-graph-interview/SKILL.md"
```

Restart or open a new Codex task if the client does not refresh installed skills automatically. Invoke it explicitly with `$decision-graph-interview` when a local decision workspace is wanted.

For a local source checkout before package publication, either expose the
binary with a deliberate local `npm link`/installation step or keep the source
fallback path in the installed skill. Copying `SKILL.md` alone does not install
the CLI binary.

## Install the shared skill in Claude Code

For a project-local installation, copy the same file into the project's Claude Code skills directory:

```sh
mkdir -p .claude/skills/decision-graph-interview
cp ./integrations/shared/decision-graph-interview/SKILL.md \
  .claude/skills/decision-graph-interview/SKILL.md
```

Use your Claude Code installation's documented global skill directory if a user-level rather than project-level installation is needed. The canonical source remains the same.

## Adapter metadata

| Adapter | Metadata | Default destination |
| --- | --- | --- |
| Codex | `integrations/codex/manifest.json` | `${CODEX_HOME:-~/.codex}/skills/decision-graph-interview/SKILL.md` |
| Claude Code | `integrations/claude-code/manifest.json` | `.claude/skills/decision-graph-interview/SKILL.md` |

The `SKILL.md` files in those adapter directories are review-time pointers. Do not install a pointer by itself: materialize the shared source at the destination instead.

## Agent handoff contract

1. The agent starts the workspace and records its `workspace_id`, loopback URL, and revision.
2. The user edits in the browser; auto-save is local and non-final.
3. The user explicitly completes the form, then signals the agent in chat.
4. The agent consumes only the completed normalized result.
5. If a premise is wrong, the agent corrects evidence through a ledger event or runs `flag-inference` for the visible material-item ID; it never manually overwrites a score.
6. The agent advances the same workspace for a follow-up pack or finishes it at the end.

An adapter must not introduce browser automation, webhooks, external storage, authentication claims, or a second persistence model.
