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

const requiredFiles = [
  "package.json",
  "package-lock.json",
  "bin/decision-graph.mjs",
  "src/core/index.mjs",
  "src/cli/command.mjs",
  "examples/first-decision.json",
  "README.md",
  "CHANGELOG.md",
  "RELEASING.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "docs/architecture.md",
  "docs/score-and-graph.md",
  "docs/local-data.md",
  "docs/agent-integrations.md",
  ".github/workflows/ci.yml",
  "integrations/shared/decision-graph-interview/SKILL.md",
  "integrations/shared/decision-graph-interview/agents/openai.yaml",
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
  expect(packageJson.bin?.["decision-graph"] === "./bin/decision-graph.mjs", "package.json must publish the decision-graph binary");
  expect(Array.isArray(packageJson.files) && packageJson.files.includes("integrations"), "npm package files must include integrations");
  expect(Array.isArray(packageJson.files) && packageJson.files.includes("examples"), "npm package files must include examples");
  expect(Array.isArray(packageJson.files) && packageJson.files.includes("docs"), "npm package files must include linked documentation");
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
expect(readme.includes("Decision Readiness (heuristic/v2)"), "README must state the score policy label");
expect(/not a hosted collaboration service/i.test(readme), "README must state the local-service boundary");
expect(/must be verified before relying on `npx`/i.test(readme), "README must flag npm package availability as unverified");
expect(readme.includes("advance --workspace"), "README must document stable-workspace advance");
expect(readme.includes("add-item --workspace") && readme.includes("amend-item --workspace"), "README must document explicit material-item correction commands");
expect(readme.includes("finish --workspace"), "README must document workspace cleanup");

const privacy = read("docs/local-data.md");
expect(/loopback/i.test(privacy) && /no-auth/i.test(privacy), "local-data documentation must state the loopback and no-auth boundary");

const score = read("docs/score-and-graph.md");
expect(/not predict success/i.test(score), "score documentation must reject predictive interpretation");
expect(/policy_version/.test(score) && /affected_item_ids/.test(score), "score documentation must require explainable delta events");

const ci = read(".github/workflows/ci.yml");
for (const requiredSnippet of ["20.x", "22.x", "npm ci --ignore-scripts", "npm test", "npm run lint", "npm run check", "npm run pack:dry-run"]) {
  expect(ci.includes(requiredSnippet), `CI must run ${requiredSnippet}`);
}

const canonicalRelativePath = "integrations/shared/decision-graph-interview/SKILL.md";
const canonicalPath = requireFile(canonicalRelativePath);
const canonical = canonicalPath ? readFileSync(canonicalPath, "utf8") : "";
expect(/^---\nname: decision-graph-interview\ndescription: .+\n---\n/m.test(canonical), "canonical SKILL.md must have valid required frontmatter");
expect(!canonical.includes("[TODO:"), "canonical SKILL.md must not contain template TODOs");
expect(canonical.includes("decision-graph start --seed-file"), "canonical SKILL.md must document the start command");
expect(canonical.includes("<dgi-cli> advance --workspace"), "canonical SKILL.md must document workspace advance with the resolved CLI notation");
expect(canonical.includes("<dgi-cli> add-item --workspace") && canonical.includes("<dgi-cli> amend-item --workspace"), "canonical SKILL.md must document explicit material-item updates with the resolved CLI notation");

const canonicalHash = createHash("sha256").update(canonical).digest("hex");
const adapters = [
  { agent: "codex", base: "integrations/codex", destination: "${CODEX_HOME:-~/.codex}/skills/decision-graph-interview/SKILL.md" },
  { agent: "claude-code", base: "integrations/claude-code", destination: ".claude/skills/decision-graph-interview/SKILL.md" },
];

for (const adapter of adapters) {
  const manifestRelativePath = `${adapter.base}/manifest.json`;
  const wrapperRelativePath = `${adapter.base}/SKILL.md`;
  const manifest = parseJson(manifestRelativePath);
  const wrapper = read(wrapperRelativePath);
  if (!manifest) continue;

  expect(manifest.format_version === 1, `${manifestRelativePath} must use format_version 1`);
  expect(manifest.agent === adapter.agent, `${manifestRelativePath} must identify ${adapter.agent}`);
  expect(manifest.skill_name === "decision-graph-interview", `${manifestRelativePath} must identify the shared skill`);
  expect(manifest.materialization === "copy", `${manifestRelativePath} must materialize the canonical source by copy`);
  expect(manifest.default_destination === adapter.destination, `${manifestRelativePath} must declare the documented destination`);
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
    expect(wrapper.includes(`decision-graph-interview-canonical-source: ${manifest.canonical_source}`), `${wrapperRelativePath} must point to its manifest canonical source`);
  }

  expect(/^---\nname: decision-graph-interview\ndescription: .+\n---\n/m.test(wrapper), `${wrapperRelativePath} must remain a valid thin skill wrapper`);
  expect(!wrapper.includes("decision-graph start --seed-file"), `${wrapperRelativePath} must not duplicate workflow commands`);
  expect(wrapper.length < canonical.length, `${wrapperRelativePath} must remain thinner than the canonical skill (${canonicalHash.slice(0, 12)})`);
}

if (failures.length > 0) {
  process.stderr.write(`public contract check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`public contract check passed (canonical skill ${canonicalHash.slice(0, 12)}).\n`);
}
