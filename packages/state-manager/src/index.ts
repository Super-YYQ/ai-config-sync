import fs from "node:fs/promises";
import path from "node:path";
import {
  backupsDir,
  cacheDir,
  defaultStateRoot,
  ensureDir,
  loadState,
  localConfigPath,
  logsDir,
  pathExists,
  pendingEventsPath,
  readJsonFile,
  saveState,
  writeJsonFile,
  type PendingBatch,
  type PendingEvent,
  type StateFile,
} from "@ai-config-sync/core";

export type PathOpKind = "create" | "replace" | "merge" | "delete" | "touch";

export interface PathOperation {
  kind: PathOpKind;
  path: string;
  /** True if path existed before this apply step. */
  existedBefore: boolean;
  /** Relative path under backup dir when a snapshot was taken. */
  backupRel?: string;
  note?: string;
}

export interface BackupRecord {
  id: string;
  createdAt: string;
  reason: string;
  /** Snapshots of paths that existed before apply. */
  files: Array<{ original: string; backup: string; existedBefore: boolean }>;
  /** Full transaction log for precise rollback. */
  pathOps: PathOperation[];
  operations?: unknown[];
  /** If auto-rolled back after failure. */
  rolledBack?: boolean;
  rolledBackAt?: string;
}

export async function ensureStateDirs(home?: string): Promise<string> {
  const root = defaultStateRoot(home);
  await ensureDir(root);
  await ensureDir(backupsDir(home));
  await ensureDir(cacheDir(home));
  await ensureDir(logsDir(home));
  return root;
}

export async function getState(home?: string): Promise<StateFile> {
  await ensureStateDirs(home);
  return loadState(path.join(defaultStateRoot(home), "state.json"));
}

export async function putState(state: StateFile, home?: string): Promise<void> {
  await ensureStateDirs(home);
  await saveState(path.join(defaultStateRoot(home), "state.json"), state);
}

export async function markInstalled(
  resourceId: string,
  target: "claude" | "codex",
  info: {
    status: "installed" | "missing" | "drift" | "failed" | "manual";
    version?: string;
    commit?: string;
    path?: string;
    hash?: string;
    notes?: string;
  },
  home?: string,
): Promise<StateFile> {
  const state = await getState(home);
  const entry = state.installed[resourceId] ?? {};
  entry[target] = {
    ...info,
    lastChecked: new Date().toISOString(),
  };
  state.installed[resourceId] = entry;
  await putState(state, home);
  return state;
}

export async function loadPending(home?: string): Promise<PendingBatch[]> {
  const p = pendingEventsPath(home);
  if (!(await pathExists(p))) return [];
  const data = await readJsonFile<{ batches?: PendingBatch[] } | PendingBatch[]>(
    p,
  );
  if (Array.isArray(data)) return data;
  return data.batches ?? [];
}

export async function savePending(
  batches: PendingBatch[],
  home?: string,
): Promise<void> {
  await ensureStateDirs(home);
  await writeJsonFile(pendingEventsPath(home), { batches });
}

export async function appendPendingEvents(
  events: PendingEvent[],
  home?: string,
): Promise<PendingBatch> {
  const batches = await loadPending(home);
  const now = new Date();
  const batchId = `${now.toISOString().replace(/[:.]/g, "").slice(0, 15)}-local`;
  const batch: PendingBatch = {
    batchId,
    events: events.map((e) => ({
      ...e,
      detectedAt: e.detectedAt ?? now.toISOString(),
    })),
    status: "pending-review",
    createdAt: now.toISOString(),
  };
  batches.push(batch);
  await savePending(batches, home);
  return batch;
}

/**
 * Begin a transactional backup: snapshot existing paths; record creates later via recordPathOp.
 */
export async function beginTransaction(
  plannedPaths: string[],
  reason: string,
  home?: string,
  operations?: unknown[],
): Promise<BackupRecord> {
  await ensureStateDirs(home);
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(backupsDir(home), id);
  await ensureDir(dir);
  const record: BackupRecord = {
    id,
    createdAt: new Date().toISOString(),
    reason,
    files: [],
    pathOps: [],
    operations,
  };

  const seen = new Set<string>();
  for (const original of plannedPaths) {
    if (!original || !path.isAbsolute(original)) continue;
    if (original.includes(`${path.sep}node_modules${path.sep}`)) continue;
    const key = original;
    if (seen.has(key)) continue;
    seen.add(key);

    const existed = await pathExists(original);
    if (!existed) {
      record.pathOps.push({
        kind: "create",
        path: original,
        existedBefore: false,
        note: "planned-create",
      });
      continue;
    }

    let st;
    try {
      st = await fs.lstat(original);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      record.pathOps.push({
        kind: "replace",
        path: original,
        existedBefore: true,
        note: "symlink-skipped-snapshot",
      });
      continue;
    }

    const base = path.basename(original) || "root";
    const safeBase = base.replace(/^\.+/, "dot") || "root";
    let finalDest = path.join(dir, safeBase);
    let i = 1;
    while (await pathExists(finalDest)) {
      finalDest = path.join(dir, `${safeBase}.${i}`);
      i++;
    }
    await fs.cp(original, finalDest, {
      recursive: true,
      dereference: true,
      errorOnExist: false,
      force: true,
    });
    const backupRel = path.relative(dir, finalDest);
    record.files.push({
      original,
      backup: finalDest,
      existedBefore: true,
    });
    record.pathOps.push({
      kind: "replace",
      path: original,
      existedBefore: true,
      backupRel,
    });
  }

  await persistTransaction(record, home);
  return record;
}

/** @deprecated use beginTransaction */
export async function createBackup(
  files: string[],
  reason: string,
  home?: string,
  operations?: unknown[],
): Promise<BackupRecord> {
  return beginTransaction(files, reason, home, operations);
}

export async function recordPathOp(
  tx: BackupRecord,
  op: PathOperation,
  home?: string,
): Promise<void> {
  // de-dupe by path+kind preference: keep first existedBefore truth
  const existing = tx.pathOps.find((p) => p.path === op.path);
  if (existing) {
    if (!existing.existedBefore && op.existedBefore) {
      existing.existedBefore = true;
      existing.backupRel = op.backupRel ?? existing.backupRel;
    }
    if (op.kind === "create" && existing.kind === "replace") {
      /* keep replace */
    } else if (op.kind !== existing.kind && op.kind !== "touch") {
      existing.kind = op.kind;
    }
  } else {
    tx.pathOps.push(op);
  }
  await persistTransaction(tx, home);
}

/** After apply succeeds for a path that was planned create — confirm it now exists. */
export async function confirmCreatedPaths(
  tx: BackupRecord,
  paths: string[],
  home?: string,
): Promise<void> {
  for (const p of paths) {
    if (!p || !path.isAbsolute(p)) continue;
    const existedBefore = tx.pathOps.some(
      (o) => o.path === p && o.existedBefore,
    );
    if (!existedBefore) {
      await recordPathOp(
        tx,
        { kind: "create", path: p, existedBefore: false },
        home,
      );
    }
  }
}

async function persistTransaction(
  record: BackupRecord,
  home?: string,
): Promise<void> {
  const dir = path.join(backupsDir(home), record.id);
  await ensureDir(dir);
  await writeJsonFile(path.join(dir, "operations.json"), record);
}

export async function listBackups(home?: string): Promise<BackupRecord[]> {
  const root = backupsDir(home);
  if (!(await pathExists(root))) return [];
  const names = await fs.readdir(root);
  const out: BackupRecord[] = [];
  for (const name of names) {
    const op = path.join(root, name, "operations.json");
    if (await pathExists(op)) {
      const rec = await readJsonFile<BackupRecord>(op);
      // migrate old records
      if (!rec.pathOps) rec.pathOps = [];
      if (rec.files) {
        for (const f of rec.files) {
          if (!rec.pathOps.some((p) => p.path === f.original)) {
            rec.pathOps.push({
              kind: "replace",
              path: f.original,
              existedBefore: f.existedBefore ?? true,
              backupRel: path.relative(
                path.join(backupsDir(home), rec.id),
                f.backup,
              ),
            });
          }
        }
      }
      out.push(rec);
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Precise rollback:
 * - existedBefore=false → delete path (created by apply)
 * - existedBefore=true + backup → restore snapshot
 */
export async function rollbackBackup(
  id: string | "last",
  home?: string,
): Promise<BackupRecord> {
  const backups = await listBackups(home);
  if (backups.length === 0) throw new Error("No backups available");
  const record =
    id === "last" ? backups[0]! : backups.find((b) => b.id === id);
  if (!record) throw new Error(`Backup not found: ${id}`);

  const txDir = path.join(backupsDir(home), record.id);

  // Process creates first (delete new stuff), then restores
  const ops = [...(record.pathOps ?? [])].reverse();
  for (const op of ops) {
    if (!op.existedBefore) {
      // was created by apply — remove
      if (await pathExists(op.path)) {
        await fs.rm(op.path, { recursive: true, force: true });
      }
      continue;
    }
    if (op.backupRel) {
      const backupPath = path.join(txDir, op.backupRel);
      if (await pathExists(backupPath)) {
        // remove current then restore clean snapshot
        if (await pathExists(op.path)) {
          await fs.rm(op.path, { recursive: true, force: true });
        }
        await ensureDir(path.dirname(op.path));
        await fs.cp(backupPath, op.path, { recursive: true, force: true });
        continue;
      }
    }
    // fallback: files[] list
    const file = record.files?.find((f) => f.original === op.path);
    if (file && (await pathExists(file.backup))) {
      if (await pathExists(op.path)) {
        await fs.rm(op.path, { recursive: true, force: true });
      }
      await ensureDir(path.dirname(op.path));
      await fs.cp(file.backup, op.path, { recursive: true, force: true });
    }
  }

  // Also restore any files[] not in pathOps (legacy)
  for (const file of record.files ?? []) {
    if (record.pathOps?.some((p) => p.path === file.original)) continue;
    if (!(await pathExists(file.backup))) continue;
    if (await pathExists(file.original)) {
      await fs.rm(file.original, { recursive: true, force: true });
    }
    await ensureDir(path.dirname(file.original));
    await fs.cp(file.backup, file.original, { recursive: true, force: true });
  }

  record.rolledBack = true;
  record.rolledBackAt = new Date().toISOString();
  await persistTransaction(record, home);
  await appendLog(`rollback ${record.id}`, home);
  return record;
}

export async function appendLog(
  line: string,
  home?: string,
): Promise<void> {
  await ensureStateDirs(home);
  const file = path.join(logsDir(home), "operations.log");
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  await fs.appendFile(file, entry, "utf8");
}

export function hasLocalConfig(home?: string): Promise<boolean> {
  return pathExists(localConfigPath(home));
}
