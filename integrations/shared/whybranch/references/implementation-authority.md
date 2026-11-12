# Implementation authority records

Use this reference for repository implementation with several material choices
to track, a handoff requiring traceable scope, or an actual repository approval
contract. It is not part of ordinary discovery, career writing, or preference
interviews. The user's task and scoped instructions authorize work; this record
only connects proposed changes to that authority.

Reuse an existing task or repository record. For a small change, a concise scope
note with the relevant user instruction and affected files can be sufficient.
Use the detailed format below when tracking multiple choices or when the target
repository requires it. Preserve the repository's own schema and guards rather
than adding a parallel approval system.

## Detailed record

Keep the implementation manifest internal and proportional to the work: scope,
baseline identity, allowed paths, material choices, before/after values, and
authorization sources. Cover only categories the work could choose or change;
do not create placeholder rows or questions for unrelated categories:

- `DIRECT_DEPENDENCIES`: direct additions/removals, exact target versions, and
  version-range policy.
- `RUNTIME_PACKAGE_MANAGER`: runtime and package-manager names and versions.
- `STYLE_SYSTEM` and `STYLE_TOKENS_LAYOUT`: styling method, global tokens, and
  material layout behavior.
- `ICONS_ASSETS`: icon packages, local SVGs, fonts, and generated assets.
- `ARCHITECTURE`, `DATA_PERSISTENCE`, `AUTH`, `DEPLOYMENT`, and `TEST_TOOLING`
  when affected by the work.

For this detailed format, record `choice_id`, `exact_value`, `provenance_state`,
`provenance_locator`, `affected_paths`, and `authorized_mutation` for each
applicable choice. Locate the source mandate, `USER_CONFIRMED` decision, or
`USER_DELEGATED` scope. Values selected by the agent within delegation keep that
provenance; do not claim the user selected those exact values. Existing code,
an assistant recommendation, or an unlocated `SOURCE_REQUIRED` claim cannot
resolve a disputed material choice; leave it `UNRESOLVED`.

Bind a structured `authority_locator` with `decision_sources`,
`execution_sources`, `manifest_digest`, and `baseline_ref` when using the
detailed format. Each source states its scope and original evidence; one source
may establish both the choice and authority to apply it. These fields do not
require separate user answers.

## Locate original evidence

- For completed browser answers, bind `workspace_id`, `scope_version`,
  `revision`, `ledger_revision`, `completion_event_id`, and the relevant
  question/option IDs or submitted free text. Retain each original revision;
  never copy old answers into a new completion event.
- For chat instructions, use an available task/message locator and the relevant
  wording. If no stable message ID is available, identify its position in the
  accessible conversation and quote the instruction. Do not invent ledger
  fields for chat or rewrite it as a browser answer.
- Resolve browser sources against the canonical ledger and chat sources against
  the actual messages. Summaries, draft screenshots, and the manifest itself
  cannot substitute for those sources.

These are agent verification records, not new CLI inputs or claims of runtime
enforcement. Do not rewrite historical approvals to fit a new record format.

## Use the record without adding approval rounds

Check scope, values, paths, and relevant baseline changes against existing
authority before mutation. Preserve concurrent edits and later user
corrections. A changed digest, a new revision, a derived file list, unrelated
worktree changes, or a failed agent-side preflight does not itself revoke
authority. Follow any actual repository enforcement contract; if it conflicts
with the requested work, identify that conflict instead of bypassing it.

If authority is missing, prepare a concrete proposal and ask only about the
unresolved choice or scope change. Explain what changes and why in plain
language, showing versions or paths only when they matter to the decision.
Keep JSON, digests, internal IDs, and full inventories out of question options;
provide readable supporting detail only when useful. One answer can select and
authorize the change. Require separate approval stages only when the user or
the target repository actually requires them.
