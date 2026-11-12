import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
  "package.json",
  "README.md",
  "README.ko.md",
  "CHANGELOG.md",
  "RELEASING.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "bin",
  "src",
  "examples",
  "docs",
  "integrations",
  ".github",
  "scripts/lint.mjs",
  "scripts/check-public-contract.mjs",
];
const textExtensions = new Set([".md", ".json", ".mjs", ".yml", ".yaml"]);
const errors = [];
const files = [];

function collect(pathname) {
  const absolute = join(root, pathname);
  if (!existsSync(absolute)) {
    errors.push(`Missing owned file or directory: ${pathname}`);
    return;
  }

  if (statSync(absolute).isFile()) {
    files.push(absolute);
    return;
  }

  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) collect(relative(root, child));
    else if (entry.isFile()) files.push(child);
  }
}

for (const pathname of roots) collect(pathname);

for (const file of files.sort()) {
  const extension = extname(file);
  if (!textExtensions.has(extension)) continue;

  const contents = readFileSync(file, "utf8");
  const label = relative(root, file);
  if (!contents.endsWith("\n")) errors.push(`${label}: missing final newline`);
  if (contents.includes("\r\n")) errors.push(`${label}: use LF line endings`);
  if (/^[^\n]*[ \t]+$/m.test(contents)) errors.push(`${label}: trailing whitespace`);
  if (label.endsWith("SKILL.md") && contents.includes("[TODO:")) {
    errors.push(`${label}: unfinished skill template text`);
  }

  if (extension === ".json") {
    try {
      JSON.parse(contents);
    } catch (error) {
      errors.push(`${label}: invalid JSON (${error.message})`);
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`lint failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`lint passed for ${files.length} public-documentation files.\n`);
}
