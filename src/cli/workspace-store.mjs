import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";

export const WORKSPACE_ENV = "WHYBRANCH_WORKSPACE_ROOT";
export const LEGACY_WORKSPACE_ENV = "DGI_WORKSPACE_ROOT";

function applicationStateRoot(application, {
  platformName = platform(),
  homeDirectory = homedir(),
  environment = process.env,
} = {}) {
  const platformJoin = platformName === "win32" ? win32.join : posix.join;
  if (platformName === "darwin") {
    return platformJoin(homeDirectory, "Library", "Application Support", application);
  }
  if (platformName === "win32") {
    return platformJoin(environment.LOCALAPPDATA || platformJoin(homeDirectory, "AppData", "Local"), application);
  }
  return platformJoin(environment.XDG_STATE_HOME || platformJoin(homeDirectory, ".local", "state"), application);
}

export function defaultWorkspaceRoot(options) {
  return applicationStateRoot("whybranch", options);
}

export function legacyPersistentWorkspaceRoot(options) {
  return applicationStateRoot("decision-graph-interview", options);
}

export function workspaceRoot(override) {
  const configured = override ?? process.env[WORKSPACE_ENV] ?? process.env[LEGACY_WORKSPACE_ENV];
  if (configured !== undefined) {
    if (typeof configured !== "string" || configured.trim() === "" || !isAbsolute(configured)) {
      throw new Error(`${WORKSPACE_ENV}, ${LEGACY_WORKSPACE_ENV}, and rootDir must be non-empty absolute paths`);
    }
    return resolve(configured);
  }
  return resolve(defaultWorkspaceRoot());
}

export function legacyWorkspaceRoot() {
  return resolve(join(tmpdir(), "decision-graph-interview"));
}

export function isLegacyWorkspaceRoot(root) {
  return resolve(root) === legacyWorkspaceRoot();
}

/**
 * Legacy releases kept the active workspace below the OS temporary
 * directory. Its recovery lineage and locks must stay in the old persistent
 * location so old and new servers continue coordinating on the same files.
 *
 * `persistentRoot` and `legacyRoot` are internal test seams. Production
 * callers omit them and always resolve to the platform locations above.
 */
export function durableRecoveryRoot(root, {
  persistentRoot = legacyPersistentWorkspaceRoot(),
  legacyRoot = legacyWorkspaceRoot(),
} = {}) {
  return resolve(root) === resolve(legacyRoot) ? resolve(persistentRoot) : resolve(root);
}

export function validateWorkspaceId(value) {
  if (typeof value !== "string" || !/^workspace-[a-f0-9-]{36}$/i.test(value)) {
    throw new Error("workspace must be a workspace id returned by start");
  }
  return value;
}

function containedDirectory(parent, child) {
  const directory = resolve(parent, child);
  if (directory !== join(parent, child)) {
    throw new Error("workspace resolves outside the local workspace root");
  }
  return directory;
}

export function workspaceDirectory(root, workspace) {
  return containedDirectory(root, validateWorkspaceId(workspace));
}

export function archiveDirectory(root, workspace) {
  return containedDirectory(join(root, "archive"), validateWorkspaceId(workspace));
}

export function recoveryDirectory(root, workspace) {
  return containedDirectory(join(root, "recovery"), validateWorkspaceId(workspace));
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Directory fsync is not available on every supported filesystem. File
    // fsync plus atomic rename remains the portability floor.
    if (!error || !["EINVAL", "EISDIR", "EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeTextAtomically(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await syncDirectory(dirname(file));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export async function writeJsonAtomically(file, value) {
  await writeTextAtomically(file, serializeJson(value));
}

async function writeVerifiedText(file, text) {
  const record = serializeJson({
    record_version: "decision-graph-recovery-record/v1",
    payload_sha256: sha256(text),
    payload: text,
  });
  await writeTextAtomically(file, record);
  await rm(`${file}.sha256`, { force: true });
}

export async function readVerifiedJson(file) {
  const storedText = await readFile(file, "utf8");
  const stored = JSON.parse(storedText);
  if (stored?.record_version === "decision-graph-recovery-record/v1") {
    if (typeof stored.payload !== "string" || !/^[a-f0-9]{64}$/i.test(stored.payload_sha256 ?? "")) {
      throw new Error(`${basename(file)} has an invalid recovery envelope`);
    }
    const checksum = sha256(stored.payload);
    if (checksum !== stored.payload_sha256.toLowerCase()) {
      throw new Error(`${basename(file)} failed checksum verification`);
    }
    return { value: JSON.parse(stored.payload), text: stored.payload, checksum, file };
  }
  // Read the pre-envelope sidecar format so already-created recovery records
  // remain usable during the alpha migration.
  const text = storedText;
  const sidecar = await readFile(`${file}.sha256`, "utf8");
  const expected = sidecar.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(expected) || sha256(text) !== expected.toLowerCase()) {
    throw new Error(`${basename(file)} failed checksum verification`);
  }
  return { value: JSON.parse(text), text, checksum: expected.toLowerCase(), file };
}

function replicaFile(root, workspace, slot) {
  return join(recoveryDirectory(root, workspace), `workspace.${slot}.json`);
}

function commitWitnessFile(root, workspace) {
  return join(recoveryDirectory(root, workspace), "workspace.committed.json");
}

async function readMatchingCommitWitness(root, workspace, candidate) {
  try {
    const witness = JSON.parse(await readFile(commitWitnessFile(root, workspace), "utf8"));
    const generation = Number.isInteger(candidate.value.storage_generation)
      ? candidate.value.storage_generation
      : 0;
    if (witness?.record_version !== "decision-graph-recovery-commit/v1"
      || witness.phase !== "committed"
      || witness.workspace_id !== workspace
      || witness.storage_generation !== generation
      || witness.replica_checksum !== candidate.checksum) {
      return undefined;
    }
    return witness;
  } catch {
    return undefined;
  }
}

export async function beginRecoveryCommit(root, workspace, state, options) {
  const recoveryRoot = durableRecoveryRoot(root, options);
  const directory = recoveryDirectory(recoveryRoot, workspace);
  await ensurePrivateDirectory(directory);
  const text = serializeJson(state);
  const file = commitWitnessFile(recoveryRoot, workspace);
  await writeJsonAtomically(file, {
    record_version: "decision-graph-recovery-commit/v1",
    phase: "pending",
    workspace_id: workspace,
    storage_generation: Number.isInteger(state.storage_generation) ? state.storage_generation : 0,
    target_checksum: sha256(text),
    started_at: new Date().toISOString(),
  });
  return { file, target_checksum: sha256(text) };
}

export async function persistRecoveryReplica(root, workspace, state, options) {
  const recoveryRoot = durableRecoveryRoot(root, options);
  // Keep this public primitive safe for archive repair and test/migration
  // callers too. saveWorkspace records the intent before touching active
  // state; repeating the same pending marker here closes direct-call gaps
  // before the latest replica slot is rotated or replaced.
  await beginRecoveryCommit(root, workspace, state, options);
  const directory = recoveryDirectory(recoveryRoot, workspace);
  await ensurePrivateDirectory(directory);
  const latestFile = replicaFile(recoveryRoot, workspace, "latest");
  try {
    const latest = await readVerifiedJson(latestFile);
    await writeVerifiedText(replicaFile(recoveryRoot, workspace, "previous"), latest.text);
  } catch (error) {
    const recoverable = error?.code === "ENOENT"
      || error instanceof SyntaxError
      || String(error?.message ?? "").includes("verification")
      || String(error?.message ?? "").includes("recovery envelope");
    if (!recoverable) {
      throw error;
    }
  }
  const text = serializeJson(state);
  await writeVerifiedText(latestFile, text);
  const checksum = sha256(text);
  const commitFile = commitWitnessFile(recoveryRoot, workspace);
  await writeJsonAtomically(commitFile, {
    record_version: "decision-graph-recovery-commit/v1",
    phase: "committed",
    workspace_id: workspace,
    storage_generation: Number.isInteger(state.storage_generation) ? state.storage_generation : 0,
    replica_checksum: checksum,
    committed_at: new Date().toISOString(),
  });
  return {
    latest_file: latestFile,
    commit_file: commitFile,
    checksum,
  };
}

function checkpointFilename(state) {
  const revision = String(state.current.revision).padStart(6, "0");
  const ledgerRevision = String(state.ledger.revision).padStart(6, "0");
  const generation = String(Number.isInteger(state.storage_generation) ? state.storage_generation : 0).padStart(8, "0");
  return `revision-${revision}-${state.current.phase}-ledger-${ledgerRevision}-generation-${generation}.json`;
}

export async function sealCheckpoint(root, workspace, state, options) {
  const recoveryRoot = durableRecoveryRoot(root, options);
  const directory = join(recoveryDirectory(recoveryRoot, workspace), "checkpoints");
  await ensurePrivateDirectory(directory);
  const file = join(directory, checkpointFilename(state));
  const text = serializeJson(state);
  const checksum = sha256(text);
  const record = serializeJson({
    record_version: "decision-graph-recovery-record/v1",
    payload_sha256: checksum,
    payload: text,
  });
  const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(record, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close();
    if (!error || error.code !== "EEXIST") throw error;
    const existing = await readVerifiedJson(file);
    if (existing.text !== text) {
      throw new Error(`immutable checkpoint already exists with different state: ${basename(file)}`);
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true }).catch(() => {});
  }
  return { file, checksum };
}

async function verifiedCandidate(file, validate) {
  try {
    const candidate = await readVerifiedJson(file);
    return { ...candidate, value: validate(candidate.value) };
  } catch {
    return undefined;
  }
}

export async function bestRecoveryCandidate(root, workspace, validate, options) {
  const recoveryRoot = durableRecoveryRoot(root, options);
  const directory = recoveryDirectory(recoveryRoot, workspace);
  const candidates = [];
  for (const slot of ["latest", "previous"]) {
    const candidate = await verifiedCandidate(replicaFile(recoveryRoot, workspace, slot), validate);
    if (candidate) {
      const exact = slot === "latest"
        && Boolean(await readMatchingCommitWitness(recoveryRoot, workspace, candidate));
      candidates.push({ ...candidate, source: `replica:${slot}`, exact });
    }
  }
  const checkpointDirectory = join(directory, "checkpoints");
  try {
    const names = (await readdir(checkpointDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      const candidate = await verifiedCandidate(join(checkpointDirectory, name), validate);
      if (candidate) candidates.push({ ...candidate, source: `checkpoint:${name}`, exact: false });
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  candidates.sort((left, right) => {
    const leftGeneration = Number.isInteger(left.value.storage_generation) ? left.value.storage_generation : 0;
    const rightGeneration = Number.isInteger(right.value.storage_generation) ? right.value.storage_generation : 0;
    if (leftGeneration !== rightGeneration) return rightGeneration - leftGeneration;
    return String(right.value.updated_at ?? "").localeCompare(String(left.value.updated_at ?? ""));
  });
  return candidates[0];
}

export function storageReceipt(root, workspace, options) {
  const recoveryRoot = durableRecoveryRoot(root, options);
  const legacyActive = recoveryRoot !== resolve(root);
  return {
    durability: legacyActive
      ? "legacy-temporary-active-with-persistent-recovery"
      : "persistent-local",
    workspace_file: join(workspaceDirectory(root, workspace), "workspace.json"),
    recovery_replica: replicaFile(recoveryRoot, workspace, "latest"),
    recovery_commit_witness: commitWitnessFile(recoveryRoot, workspace),
    checkpoint_directory: join(recoveryDirectory(recoveryRoot, workspace), "checkpoints"),
  };
}

export async function verifyRecoveryReplica(root, workspace, options) {
  try {
    const activeText = await readFile(join(workspaceDirectory(root, workspace), "workspace.json"), "utf8");
    const active = JSON.parse(activeText);
    const recoveryRoot = durableRecoveryRoot(root, options);
    const replica = await readVerifiedJson(replicaFile(recoveryRoot, workspace, "latest"));
    const witness = await readMatchingCommitWitness(recoveryRoot, workspace, replica);
    const activeGeneration = Number.isInteger(active.storage_generation) ? active.storage_generation : 0;
    const replicaGeneration = Number.isInteger(replica.value.storage_generation) ? replica.value.storage_generation : 0;
    if (active.workspace_id !== workspace || replica.value.workspace_id !== workspace) {
      throw new Error("active or replica workspace identity does not match");
    }
    if (activeGeneration !== replicaGeneration || activeText !== replica.text) {
      throw new Error("active workspace and latest recovery replica are not the same generation and bytes");
    }
    if (!witness) {
      throw new Error("latest recovery replica has no matching commit witness");
    }
    return {
      status: "healthy",
      verified_at: new Date().toISOString(),
      generation: activeGeneration,
      replica_checksum: replica.checksum,
    };
  } catch (error) {
    return {
      status: "degraded",
      verified_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

async function workspaceStateExists(root, workspace) {
  const [active, archived] = await Promise.all([
    pathExists(workspaceDirectory(root, workspace)),
    pathExists(archiveDirectory(root, workspace)),
  ]);
  return active || archived;
}

/**
 * Read existing workspaces in place across the new and legacy locations.
 * Temporary active/archive state and its old persistent recovery are a single
 * lineage; any other state present in distinct roots is ambiguous. Discovery
 * never creates directories or migrates the user's stored records.
 */
export async function discoverExistingWorkspaceRoot(workspace, {
  persistentRoot = defaultWorkspaceRoot(),
  legacyPersistentRoot = legacyPersistentWorkspaceRoot(),
  legacyRoot = legacyWorkspaceRoot(),
} = {}) {
  const persistent = resolve(persistentRoot);
  const legacyPersistent = resolve(legacyPersistentRoot);
  const legacy = resolve(legacyRoot);
  validateWorkspaceId(workspace);
  const roots = [...new Set([persistent, legacyPersistent, legacy])];
  const states = await Promise.all(roots.map(async (root) => ({
    root,
    state: await workspaceStateExists(root, workspace),
    recovery: root !== legacy || root === legacyPersistent
      ? await pathExists(recoveryDirectory(root, workspace))
      : false,
  })));
  const temporaryState = states.find(({ root }) => root === legacy).state;
  const candidates = states.filter(({ root, state, recovery }) => (
    state || (recovery && !(temporaryState && root === legacyPersistent && root !== legacy))
  ));
  if (candidates.length > 1) {
    throw new Error(
      "workspace state exists in multiple Whybranch or legacy roots; refusing to choose a lineage",
    );
  }
  return candidates[0]?.root ?? persistent;
}

export async function moveWorkspaceToArchive(root, workspace, { archiveRoot = root } = {}) {
  const source = workspaceDirectory(root, workspace);
  const destinationRoot = resolve(archiveRoot);
  const destination = archiveDirectory(destinationRoot, workspace);
  await ensurePrivateDirectory(dirname(destination));
  let staging;
  try {
    await rename(source, destination);
  } catch (error) {
    if (!error || error.code !== "EXDEV") throw error;
    // Legacy temporary roots can live on a different filesystem from the
    // persistent state root. Copy to a hidden sibling, verify the canonical
    // workspace bytes, atomically install the archive, and only then remove
    // the disposable source.
    staging = join(dirname(destination), `.${validateWorkspaceId(workspace)}.${randomUUID()}.tmp`);
    try {
      await cp(source, staging, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
      const [sourceText, stagedText] = await Promise.all([
        readFile(join(source, "workspace.json"), "utf8"),
        readFile(join(staging, "workspace.json"), "utf8"),
      ]);
      if (sourceText !== stagedText) {
        throw new Error("cross-filesystem archive copy did not preserve exact workspace bytes");
      }
      const stagedWorkspace = await open(join(staging, "workspace.json"), "r");
      try {
        await stagedWorkspace.sync();
      } finally {
        await stagedWorkspace.close();
      }
      await rename(staging, destination);
      staging = undefined;
      await syncDirectory(dirname(destination));
      await rm(source, { recursive: true, force: false });
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
  await syncDirectory(root);
  if (destinationRoot !== resolve(root)) await syncDirectory(destinationRoot);
  await syncDirectory(dirname(destination));
  return destination;
}

export async function restoreArchivedWorkspace(root, workspace) {
  const source = archiveDirectory(root, workspace);
  const destination = workspaceDirectory(root, workspace);
  await rename(source, destination);
  await syncDirectory(root);
  await syncDirectory(dirname(source));
  return destination;
}

export async function quarantineArchivedWorkspace(root, workspace) {
  const source = archiveDirectory(root, workspace);
  const parent = join(root, "quarantine");
  await ensurePrivateDirectory(parent);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = join(parent, `${validateWorkspaceId(workspace)}-${timestamp}`);
  await rename(source, destination);
  await syncDirectory(dirname(source));
  await syncDirectory(parent);
  return destination;
}
