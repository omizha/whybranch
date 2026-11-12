import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LEGACY_WORKSPACE_ENV,
  WORKSPACE_ENV,
  archiveDirectory,
  beginRecoveryCommit,
  bestRecoveryCandidate,
  defaultWorkspaceRoot,
  discoverExistingWorkspaceRoot,
  durableRecoveryRoot,
  ensurePrivateDirectory,
  legacyPersistentWorkspaceRoot,
  legacyWorkspaceRoot,
  moveWorkspaceToArchive,
  persistRecoveryReplica,
  readVerifiedJson,
  recoveryDirectory,
  restoreArchivedWorkspace,
  sealCheckpoint,
  storageReceipt,
  verifyRecoveryReplica,
  workspaceDirectory,
  workspaceRoot,
} from "../src/cli/workspace-store.mjs";

const WORKSPACE_ID = "workspace-00000000-0000-4000-8000-000000000001";

function state({ generation = 1, revision = 48, ledgerRevision = 268, marker = "current" } = {}) {
  return {
    schema_version: "decision-graph-workspace/v1",
    workspace_id: WORKSPACE_ID,
    storage_generation: generation,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: `2026-08-01T00:00:${String(generation).padStart(2, "0")}.000Z`,
    url: `http://127.0.0.1:43111/workspaces/${WORKSPACE_ID}`,
    history: [],
    pack_events: [],
    ledger: {
      revision: ledgerRevision,
      events: Array.from({ length: ledgerRevision }, (_, index) => ({
        event_id: `event-${String(index + 1).padStart(3, "0")}`,
        type: "test_event",
      })),
    },
    current: {
      revision,
      phase: "open",
      seed: { objective: "Preserve the exact decision record" },
      draft: { responses: [{ question_id: "q:durability", resolution: "answer", text: marker }] },
    },
  };
}

function validate(candidate) {
  assert.equal(candidate.workspace_id, WORKSPACE_ID);
  assert.equal(candidate.schema_version, "decision-graph-workspace/v1");
  return candidate;
}

test("new and legacy default roots retain their platform-specific persistent locations", () => {
  const cases = [
    [{ platformName: "darwin", homeDirectory: "/Users/example", environment: {} }, "/Users/example/Library/Application Support/"],
    [{ platformName: "linux", homeDirectory: "/home/example", environment: {} }, "/home/example/.local/state/"],
    [{ platformName: "linux", homeDirectory: "/home/example", environment: { XDG_STATE_HOME: "/state" } }, "/state/"],
    [{ platformName: "win32", homeDirectory: "C:\\Users\\example", environment: {} }, "C:\\Users\\example\\AppData\\Local\\"],
    [{ platformName: "win32", homeDirectory: "C:\\Users\\example", environment: { LOCALAPPDATA: "D:\\Local" } }, "D:\\Local\\"],
  ];
  for (const [options, parent] of cases) {
    assert.equal(defaultWorkspaceRoot(options), `${parent}whybranch`);
    assert.equal(legacyPersistentWorkspaceRoot(options), `${parent}decision-graph-interview`);
  }
  assert.equal(legacyWorkspaceRoot(), join(tmpdir(), "decision-graph-interview"));
  assert.equal(durableRecoveryRoot(legacyWorkspaceRoot()), legacyPersistentWorkspaceRoot());
  assert.equal(durableRecoveryRoot(defaultWorkspaceRoot()), defaultWorkspaceRoot());
});

test("root override takes precedence over Whybranch env, then legacy env, without hiding invalid configuration", (t) => {
  const original = new Map([WORKSPACE_ENV, LEGACY_WORKSPACE_ENV].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  assert.equal(WORKSPACE_ENV, "WHYBRANCH_WORKSPACE_ROOT");
  assert.equal(LEGACY_WORKSPACE_ENV, "DGI_WORKSPACE_ROOT");
  const oldRoot = join(tmpdir(), "legacy-configured-root");
  const newRoot = join(tmpdir(), "whybranch-configured-root");
  const explicitRoot = join(tmpdir(), "explicit-configured-root");
  delete process.env[WORKSPACE_ENV];
  delete process.env[LEGACY_WORKSPACE_ENV];
  assert.equal(workspaceRoot(), defaultWorkspaceRoot());
  process.env[LEGACY_WORKSPACE_ENV] = oldRoot;
  assert.equal(workspaceRoot(), oldRoot);
  process.env[WORKSPACE_ENV] = newRoot;
  assert.equal(workspaceRoot(), newRoot);
  assert.equal(workspaceRoot(explicitRoot), explicitRoot);
  for (const invalid of ["", "  ", "relative/root"]) {
    process.env[WORKSPACE_ENV] = invalid;
    assert.throws(() => workspaceRoot(), /non-empty absolute paths/);
    assert.equal(workspaceRoot(explicitRoot), explicitRoot);
  }
  delete process.env[WORKSPACE_ENV];
  process.env[LEGACY_WORKSPACE_ENV] = "relative/legacy";
  assert.throws(() => workspaceRoot(), /non-empty absolute paths/);
  process.env[WORKSPACE_ENV] = newRoot;
  assert.throws(() => workspaceRoot(""), /non-empty absolute paths/);
});

function discoveryRoots(sandbox) {
  return {
    persistentRoot: join(sandbox, "whybranch"),
    legacyPersistentRoot: join(sandbox, "legacy-persistent-root"),
    legacyRoot: join(sandbox, "legacy-temporary-root"),
  };
}

test("discovery reads each new or old persistent active, archive, and recovery-only workspace in place", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "whybranch-root-discovery-test-"));
  const roots = discoveryRoots(sandbox);
  try {
    assert.equal(await discoverExistingWorkspaceRoot(WORKSPACE_ID, roots), roots.persistentRoot);
    assert.deepEqual(await readdir(sandbox), []);
    for (const root of [roots.persistentRoot, roots.legacyPersistentRoot]) {
      for (const directoryFor of [workspaceDirectory, archiveDirectory, recoveryDirectory]) {
        const directory = directoryFor(root, WORKSPACE_ID);
        await ensurePrivateDirectory(directory);
        assert.equal(await discoverExistingWorkspaceRoot(WORKSPACE_ID, roots), root);
        await rm(directory, { recursive: true });
      }
    }
    for (const directoryFor of [workspaceDirectory, archiveDirectory]) {
      const directory = directoryFor(roots.legacyRoot, WORKSPACE_ID);
      await ensurePrivateDirectory(directory);
      assert.equal(await discoverExistingWorkspaceRoot(WORKSPACE_ID, roots), roots.legacyRoot);
      await ensurePrivateDirectory(recoveryDirectory(roots.legacyPersistentRoot, WORKSPACE_ID));
      assert.equal(await discoverExistingWorkspaceRoot(WORKSPACE_ID, roots), roots.legacyRoot);
      await rm(directory, { recursive: true });
      await rm(recoveryDirectory(roots.legacyPersistentRoot, WORKSPACE_ID), { recursive: true });
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("discovery rejects all new/old lineage conflicts, including recovery-only and old active/archive splits", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "whybranch-root-conflict-test-"));
  const roots = discoveryRoots(sandbox);
  try {
    const persistentLocations = [workspaceDirectory, archiveDirectory, recoveryDirectory];
    for (const newLocation of persistentLocations) {
      const newDirectory = newLocation(roots.persistentRoot, WORKSPACE_ID);
      await ensurePrivateDirectory(newDirectory);
      for (const oldRoot of [roots.legacyPersistentRoot, roots.legacyRoot]) {
        const oldLocations = oldRoot === roots.legacyRoot ? [workspaceDirectory, archiveDirectory] : persistentLocations;
        for (const oldLocation of oldLocations) {
          const oldDirectory = oldLocation(oldRoot, WORKSPACE_ID);
          await ensurePrivateDirectory(oldDirectory);
          await assert.rejects(() => discoverExistingWorkspaceRoot(WORKSPACE_ID, roots), /refusing to choose a lineage/);
          await rm(oldDirectory, { recursive: true });
        }
      }
      await rm(newDirectory, { recursive: true });
    }
    for (const oldLocation of [workspaceDirectory, archiveDirectory]) {
      const oldDirectory = oldLocation(roots.legacyPersistentRoot, WORKSPACE_ID);
      await ensurePrivateDirectory(oldDirectory);
      for (const temporaryLocation of [workspaceDirectory, archiveDirectory]) {
        const temporaryDirectory = temporaryLocation(roots.legacyRoot, WORKSPACE_ID);
        await ensurePrivateDirectory(temporaryDirectory);
        await assert.rejects(() => discoverExistingWorkspaceRoot(WORKSPACE_ID, roots), /refusing to choose a lineage/);
        await rm(temporaryDirectory, { recursive: true });
      }
      await rm(oldDirectory, { recursive: true });
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("discovery deduplicates equivalent normalized roots", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "whybranch-root-alias-test-"));
  const roots = discoveryRoots(sandbox);
  try {
    await ensurePrivateDirectory(recoveryDirectory(roots.persistentRoot, WORKSPACE_ID));
    assert.equal(await discoverExistingWorkspaceRoot(WORKSPACE_ID, {
      ...roots,
      legacyPersistentRoot: `${roots.persistentRoot}/.`,
    }), roots.persistentRoot);
    await ensurePrivateDirectory(workspaceDirectory(roots.persistentRoot, WORKSPACE_ID));
    assert.equal(await discoverExistingWorkspaceRoot(WORKSPACE_ID, {
      persistentRoot: roots.persistentRoot,
      legacyPersistentRoot: `${roots.persistentRoot}/.`,
      legacyRoot: `${roots.persistentRoot}/unused/..`,
    }), roots.persistentRoot);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("legacy active state writes replicas and checkpoints only to the durable root", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "whybranch-legacy-store-test-"));
  const legacyRoot = join(sandbox, "legacy-temporary-root");
  const persistentRoot = join(sandbox, "persistent-root");
  const options = { legacyRoot, persistentRoot };
  try {
    const live = workspaceDirectory(legacyRoot, WORKSPACE_ID);
    await ensurePrivateDirectory(live);
    const current = state();
    const activeText = `${JSON.stringify(current, null, 2)}\n`;
    await writeFile(join(live, "workspace.json"), activeText, "utf8");

    assert.equal(durableRecoveryRoot(legacyRoot, options), persistentRoot);
    const replica = await persistRecoveryReplica(legacyRoot, WORKSPACE_ID, current, options);
    const checkpoint = await sealCheckpoint(legacyRoot, WORKSPACE_ID, current, options);
    const receipt = storageReceipt(legacyRoot, WORKSPACE_ID, options);
    assert.equal(receipt.durability, "legacy-temporary-active-with-persistent-recovery");
    assert.equal(replica.latest_file, join(persistentRoot, "recovery", WORKSPACE_ID, "workspace.latest.json"));
    assert.match(checkpoint.file, new RegExp(`^${persistentRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/recovery/`));
    await assert.rejects(
      () => readFile(join(legacyRoot, "recovery", WORKSPACE_ID, "workspace.latest.json"), "utf8"),
      /ENOENT/,
    );
    assert.equal((await verifyRecoveryReplica(legacyRoot, WORKSPACE_ID, options)).status, "healthy");
    const legacyCandidate = await bestRecoveryCandidate(legacyRoot, WORKSPACE_ID, validate, options);
    assert.equal(legacyCandidate.source, "replica:latest");

    await rm(live, { recursive: true, force: true });
    assert.equal(
      await discoverExistingWorkspaceRoot(WORKSPACE_ID, {
        persistentRoot: join(sandbox, "whybranch"), legacyPersistentRoot: persistentRoot, legacyRoot,
      }),
      persistentRoot,
    );
    const recovered = await bestRecoveryCandidate(persistentRoot, WORKSPACE_ID, validate);
    assert.equal(recovered.source, "replica:latest");
    assert.equal(recovered.value.current.revision, 48);
    assert.equal(recovered.value.ledger.events.length, 268);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a legacy temporary active workspace is archived under the persistent root", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "whybranch-legacy-archive-test-"));
  const legacyRoot = join(sandbox, "legacy-temporary-root");
  const persistentRoot = join(sandbox, "persistent-root");
  try {
    const live = workspaceDirectory(legacyRoot, WORKSPACE_ID);
    await ensurePrivateDirectory(live);
    const activeText = `${JSON.stringify(state(), null, 2)}\n`;
    await writeFile(join(live, "workspace.json"), activeText, "utf8");
    const archived = await moveWorkspaceToArchive(legacyRoot, WORKSPACE_ID, {
      archiveRoot: persistentRoot,
    });
    assert.equal(archived, archiveDirectory(persistentRoot, WORKSPACE_ID));
    assert.equal(await readFile(join(archived, "workspace.json"), "utf8"), activeText);
    await assert.rejects(() => readFile(join(live, "workspace.json"), "utf8"), /ENOENT/);
    assert.equal(
      await discoverExistingWorkspaceRoot(WORKSPACE_ID, {
        persistentRoot: join(sandbox, "whybranch"), legacyPersistentRoot: persistentRoot, legacyRoot,
      }),
      persistentRoot,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an exact external replica preserves revision 48 and all 268 ledger events", async () => {
  const root = await mkdtemp(join(tmpdir(), "whybranch-store-test-"));
  try {
    const live = workspaceDirectory(root, WORKSPACE_ID);
    await ensurePrivateDirectory(live);
    const current = state();
    await writeFile(join(live, "workspace.json"), `${JSON.stringify(current, null, 2)}\n`, "utf8");
    const replica = await persistRecoveryReplica(root, WORKSPACE_ID, current);
    const checkpoint = await sealCheckpoint(root, WORKSPACE_ID, current);
    const replicaEnvelope = JSON.parse(await readFile(replica.latest_file, "utf8"));
    assert.equal(replicaEnvelope.record_version, "decision-graph-recovery-record/v1");
    assert.equal(replicaEnvelope.payload, `${JSON.stringify(current, null, 2)}\n`);
    const commitWitness = JSON.parse(await readFile(storageReceipt(root, WORKSPACE_ID).recovery_commit_witness, "utf8"));
    assert.equal(commitWitness.record_version, "decision-graph-recovery-commit/v1");
    assert.equal(storageReceipt(root, WORKSPACE_ID).recovery_replica, replica.latest_file);
    assert.match(checkpoint.file, /revision-000048-open-ledger-000268-generation-00000001\.json$/);

    await rm(live, { recursive: true, force: true });
    const recovered = await bestRecoveryCandidate(root, WORKSPACE_ID, validate);
    assert.equal(recovered.source, "replica:latest");
    assert.equal(recovered.exact, true);
    assert.equal(recovered.value.current.revision, 48);
    assert.equal(recovered.value.current.draft.responses[0].text, "current");
    assert.equal(recovered.value.ledger.revision, 268);
    assert.equal(recovered.value.ledger.events.length, 268);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a latest replica without its matching commit witness is not reported as exact", async () => {
  const root = await mkdtemp(join(tmpdir(), "whybranch-commit-witness-test-"));
  try {
    const first = state({ generation: 1, marker: "committed" });
    const pending = state({ generation: 2, marker: "active-commit-started-before-replica" });
    await persistRecoveryReplica(root, WORKSPACE_ID, first);
    await beginRecoveryCommit(root, WORKSPACE_ID, pending);
    const candidate = await bestRecoveryCandidate(root, WORKSPACE_ID, validate);
    assert.equal(candidate.source, "replica:latest");
    assert.equal(candidate.value.storage_generation, 1);
    assert.equal(candidate.exact, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checksum failure falls back explicitly and immutable checkpoints cannot be overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "whybranch-store-test-"));
  try {
    const first = state({ generation: 1, marker: "previous" });
    const latest = state({ generation: 2, marker: "latest" });
    await persistRecoveryReplica(root, WORKSPACE_ID, first);
    await persistRecoveryReplica(root, WORKSPACE_ID, latest);
    const latestFile = join(recoveryDirectory(root, WORKSPACE_ID), "workspace.latest.json");
    await writeFile(latestFile, "{corrupt", "utf8");
    const recovered = await bestRecoveryCandidate(root, WORKSPACE_ID, validate);
    assert.equal(recovered.source, "replica:previous");
    assert.equal(recovered.exact, false);
    assert.equal(recovered.value.current.draft.responses[0].text, "previous");

    const sealed = await sealCheckpoint(root, WORKSPACE_ID, first);
    const originalBytes = await readFile(sealed.file, "utf8");
    await sealCheckpoint(root, WORKSPACE_ID, first);
    await assert.rejects(
      () => sealCheckpoint(root, WORKSPACE_ID, { ...first, extra: "different immutable bytes" }),
      /immutable checkpoint already exists with different state/i,
    );
    assert.equal(await readFile(sealed.file, "utf8"), originalBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive and restore move only the exact workspace while recovery records remain separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "whybranch-store-test-"));
  try {
    const live = workspaceDirectory(root, WORKSPACE_ID);
    await ensurePrivateDirectory(live);
    await writeFile(join(live, "workspace.json"), "preserved\n", "utf8");
    await persistRecoveryReplica(root, WORKSPACE_ID, state());
    const archived = await moveWorkspaceToArchive(root, WORKSPACE_ID);
    assert.equal(archived, archiveDirectory(root, WORKSPACE_ID));
    assert.equal(await readFile(join(archived, "workspace.json"), "utf8"), "preserved\n");
    const replica = await readVerifiedJson(join(recoveryDirectory(root, WORKSPACE_ID), "workspace.latest.json"));
    assert.equal(replica.value.ledger.revision, 268);
    const restored = await restoreArchivedWorkspace(root, WORKSPACE_ID);
    assert.equal(restored, live);
    assert.equal(await readFile(join(restored, "workspace.json"), "utf8"), "preserved\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
