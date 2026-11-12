import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function pathAt(relativePath) {
  return join(root, relativePath);
}

function requireFile(relativePath) {
  const pathname = pathAt(relativePath);
  if (!existsSync(pathname)) {
    failures.push(`Missing required public file: ${relativePath}`);
    return undefined;
  }
  return pathname;
}

function read(relativePath) {
  const pathname = requireFile(relativePath);
  return pathname ? readFileSync(pathname, "utf8") : "";
}

function parseJson(relativePath) {
  try {
    return JSON.parse(read(relativePath));
  } catch (error) {
    failures.push(`${relativePath} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function markdownSection(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start === -1) return "";
  const next = markdown.indexOf("\n## ", start + marker.length);
  return markdown.slice(start, next === -1 ? markdown.length : next);
}

const requiredFiles = [
  "package.json",
  "package-lock.json",
  "bin/whybranch.mjs",
  "src/core/index.mjs",
  "src/core/decision-semantics.mjs",
  "src/cli/command.mjs",
  "src/cli/workspace-store.mjs",
  "src/packs/interview.mjs",
  "examples/first-decision.json",
  "README.md",
  "README.ko.md",
  "CHANGELOG.md",
  "RELEASING.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "docs/architecture.md",
  "docs/decision-semantics.md",
  "docs/score-and-graph.md",
  "docs/local-data.md",
  "docs/agent-integrations.md",
  ".github/workflows/ci.yml",
  "integrations/shared/whybranch/SKILL.md",
  "integrations/shared/whybranch/agents/openai.yaml",
  "integrations/codex/manifest.json",
  "integrations/codex/SKILL.md",
  "integrations/claude-code/manifest.json",
  "integrations/claude-code/SKILL.md",
];

for (const relativePath of requiredFiles) requireFile(relativePath);

const packageJson = parseJson("package.json");
if (packageJson) {
  expect(packageJson.type === "module", "package.json must declare ESM support");
  expect(packageJson.engines?.node === ">=20", "package.json must support Node 20 or newer");
  expect(packageJson.bin?.["whybranch"] === "./bin/whybranch.mjs", "package.json must publish the whybranch binary");
  expect(Array.isArray(packageJson.files) && packageJson.files.includes("integrations"), "npm package files must include integrations");
  expect(Array.isArray(packageJson.files) && packageJson.files.includes("examples"), "npm package files must include examples");
  expect(Array.isArray(packageJson.files) && packageJson.files.includes("docs"), "npm package files must include linked documentation");
  expect(Array.isArray(packageJson.files) && packageJson.files.includes("README.ko.md"), "npm package files must include the source Korean README");
  expect(Array.isArray(packageJson.files) && packageJson.files.includes("CODE_OF_CONDUCT.md"), "npm package files must include the code of conduct");
  expect(Array.isArray(packageJson.files) && packageJson.files.includes("RELEASING.md"), "npm package files must include release guidance");
  for (const scriptName of ["test", "lint", "check", "pack:dry-run"]) {
    expect(typeof packageJson.scripts?.[scriptName] === "string", `package.json is missing ${scriptName} script`);
  }
}

const example = parseJson("examples/first-decision.json");
if (example) {
  expect(typeof example.objective === "string" && Array.isArray(example.questions) && example.questions.length > 0, "example seed must be runnable-looking");
  expect(Array.isArray(example.material_items) && example.material_items.length > 0, "example seed must show explicit scoring inputs");
}

const readme = read("README.md");
const readmeKo = read("README.ko.md");
expect(readme.includes("](README.ko.md)"), "English README must link to its Korean source");
expect(readmeKo.includes("](README.md)"), "Korean README must link to its English translation");
expect(readme.includes("Decision Readiness (heuristic/v2)"), "README must state the score policy label");
expect(/not a hosted collaboration service/i.test(readme), "README must state the local-service boundary");
expect(/must be verified before relying on `npx`/i.test(readme), "README must flag npm package availability as unverified");
expect(readme.includes("advance --workspace"), "README must document stable-workspace advance");
expect(readme.includes("add-item --workspace") && readme.includes("amend-item --workspace"), "README must document explicit material-item correction commands");
expect(readme.includes("finish --workspace") && /archive exact state/i.test(readme), "README must document non-destructive workspace archival");
expect(readme.includes("recover --workspace"), "README must document verified workspace recovery");
expect(readme.includes("decision-semantics/v1"), "README must document the public decision semantics descriptor");

const privacy = read("docs/local-data.md");
expect(/loopback/i.test(privacy) && /no-auth/i.test(privacy), "local-data documentation must state the loopback and no-auth boundary");
expect(/rolling recovery replica/i.test(privacy) && /immutable checkpoints/i.test(privacy), "local-data documentation must state the durable recovery boundary");

const score = read("docs/score-and-graph.md");
expect(/not predict success/i.test(score), "score documentation must reject predictive interpretation");
expect(/policy_version/.test(score) && /affected_item_ids/.test(score), "score documentation must require explainable delta events");

const semantics = read("docs/decision-semantics.md");
expect(semantics.includes("DECISION_SEMANTICS_VERSION") && semantics.includes("DECISION_SEMANTICS_V1"), "decision semantics documentation must name the public exports");
expect(/Input aliases are compatibility rules/i.test(semantics), "decision semantics must distinguish normalization aliases from concept identity");
expect(/Adoption gates/.test(semantics), "decision semantics must document gates for heavier ontology infrastructure");

const ci = read(".github/workflows/ci.yml");
for (const requiredSnippet of ["20.x", "22.x", "npm ci --ignore-scripts", "npm test", "npm run lint", "npm run check", "npm run pack:dry-run"]) {
  expect(ci.includes(requiredSnippet), `CI must run ${requiredSnippet}`);
}

const canonicalRelativePath = "integrations/shared/whybranch/SKILL.md";
const canonicalPath = requireFile(canonicalRelativePath);
const canonical = canonicalPath ? readFileSync(canonicalPath, "utf8") : "";
expect(/^---\nname: whybranch\ndescription: .+\n---\n/m.test(canonical), "canonical SKILL.md must have valid required frontmatter");
expect(!canonical.includes("[TODO:"), "canonical SKILL.md must not contain template TODOs");
expect(canonical.includes("whybranch start --seed-file"), "canonical SKILL.md must document the start command");
expect(canonical.includes("start --pack interview"), "canonical SKILL.md must document the built-in interview pack");
expect(/browser.*preflight/i.test(canonical), "canonical SKILL.md must prohibit browser preflight tab churn");
expect(canonical.includes("<whybranch-cli> advance --workspace"), "canonical SKILL.md must document workspace advance with the resolved CLI notation");
expect(canonical.includes("<whybranch-cli> add-item --workspace") && canonical.includes("<whybranch-cli> amend-item --workspace"), "canonical SKILL.md must document explicit material-item updates with the resolved CLI notation");
expect(canonical.includes("<whybranch-cli> recover --workspace"), "canonical SKILL.md must document verified recovery of the same workspace");
expect(/not backups of exact drafts/i.test(canonical), "canonical SKILL.md must not treat chat continuity as an exact ledger backup");

const approvalGate = markdownSection(canonical, "Gate implementation approval");
expect(approvalGate.length > 0, "canonical SKILL.md must define an implementation-approval gate");
const implementationRecordRelativePath = "references/implementation-authority.md";
const implementationRecord = read(join(dirname(canonicalRelativePath), implementationRecordRelativePath));
expect(approvalGate.includes(`](${implementationRecordRelativePath})`), "implementation gate must link its supporting reference relative to the skill directory");

const inventoryCategories = [
  "DIRECT_DEPENDENCIES",
  "RUNTIME_PACKAGE_MANAGER",
  "STYLE_SYSTEM",
  "STYLE_TOKENS_LAYOUT",
  "ICONS_ASSETS",
  "ARCHITECTURE",
  "DATA_PERSISTENCE",
  "AUTH",
  "DEPLOYMENT",
  "TEST_TOOLING",
];
for (const category of inventoryCategories) {
  expect(implementationRecord.includes(`\`${category}\``), `detailed implementation record must document ${category}`);
}

const inventoryFields = [
  "choice_id",
  "exact_value",
  "provenance_state",
  "provenance_locator",
  "affected_paths",
  "authorized_mutation",
];
for (const field of inventoryFields) {
  expect(implementationRecord.includes(`\`${field}\``), `detailed implementation record must document ${field}`);
}

const locatorFields = [
  "workspace_id",
  "scope_version",
  "revision",
  "ledger_revision",
  "completion_event_id",
  "manifest_digest",
  "baseline_ref",
  "decision_sources",
  "execution_sources",
];
for (const field of locatorFields) {
  expect(implementationRecord.includes(`\`${field}\``), `detailed authority locator must document ${field}`);
}

const canonicalHash = createHash("sha256").update(canonical).digest("hex");
const adapters = [
  { agent: "codex", base: "integrations/codex", destination: "${CODEX_HOME:-~/.codex}/skills/whybranch/SKILL.md" },
  { agent: "claude-code", base: "integrations/claude-code", destination: ".claude/skills/whybranch/SKILL.md" },
];

for (const adapter of adapters) {
  const manifestRelativePath = `${adapter.base}/manifest.json`;
  const wrapperRelativePath = `${adapter.base}/SKILL.md`;
  const manifest = parseJson(manifestRelativePath);
  const wrapper = read(wrapperRelativePath);
  if (!manifest) continue;

  expect(manifest.format_version === 1, `${manifestRelativePath} must use format_version 1`);
  expect(manifest.agent === adapter.agent, `${manifestRelativePath} must identify ${adapter.agent}`);
  expect(manifest.skill_name === "whybranch", `${manifestRelativePath} must identify the shared skill`);
  expect(manifest.materialization === "copy", `${manifestRelativePath} must materialize the canonical source by copy`);
  expect(manifest.default_destination === adapter.destination, `${manifestRelativePath} must declare the documented destination`);
  expect(Array.isArray(manifest.supporting_files) && manifest.supporting_files.includes(implementationRecordRelativePath), `${manifestRelativePath} must include the implementation record reference when installing the skill`);
  expect(typeof manifest.canonical_source === "string", `${manifestRelativePath} must point to a canonical source`);

  if (typeof manifest.canonical_source === "string" && canonicalPath) {
    const sourcePath = resolve(dirname(pathAt(manifestRelativePath)), manifest.canonical_source);
    let resolvesToCanonical = false;
    try {
      resolvesToCanonical = realpathSync(sourcePath) === realpathSync(canonicalPath);
    } catch {
      // The explicit failure below is more useful than an exception.
    }
    expect(resolvesToCanonical, `${manifestRelativePath} must resolve to the one shared SKILL.md`);
    expect(wrapper.includes(`whybranch-canonical-source: ${manifest.canonical_source}`), `${wrapperRelativePath} must point to its manifest canonical source`);
  }

  expect(/^---\nname: whybranch\ndescription: .+\n---\n/m.test(wrapper), `${wrapperRelativePath} must remain a valid thin skill wrapper`);
  expect(!wrapper.includes("whybranch start --seed-file"), `${wrapperRelativePath} must not duplicate workflow commands`);
  expect(wrapper.length < canonical.length, `${wrapperRelativePath} must remain thinner than the canonical skill (${canonicalHash.slice(0, 12)})`);
}

if (failures.length > 0) {
  process.stderr.write(`public contract check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`public contract check passed (canonical skill ${canonicalHash.slice(0, 12)}).\n`);
}
