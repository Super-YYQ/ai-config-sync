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

export interface BackupRecord {
  id: string;
  createdAt: string;
  reason: string;
  files: Array<{ original: string; backup: string }>;
  operations?: unknown[];
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

export async function createBackup(
  files: string[],
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
    operations,
  };

  for (const original of files) {
    if (!(await pathExists(original))) continue;
    // Never backup relative paths or traversal segments
    if (!path.isAbsolute(original)) continue;
    if (original.includes(`${path.sep}node_modules${path.sep}`)) continue;

    let st;
    try {
      st = await fs.lstat(original);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;

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
    record.files.push({ original, backup: finalDest });
  }

  await writeJsonFile(path.join(dir, "operations.json"), record);
  return record;
}

export async function listBackups(home?: string): Promise<BackupRecord[]> {
  const root = backupsDir(home);
  if (!(await pathExists(root))) return [];
  const names = await fs.readdir(root);
  const out: BackupRecord[] = [];
  for (const name of names) {
    const op = path.join(root, name, "operations.json");
    if (await pathExists(op)) {
      out.push(await readJsonFile<BackupRecord>(op));
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function rollbackBackup(
  id: string | "last",
  home?: string,
): Promise<BackupRecord> {
  const backups = await listBackups(home);
  if (backups.length === 0) throw new Error("No backups available");
  const record =
    id === "last" ? backups[0]! : backups.find((b) => b.id === id);
  if (!record) throw new Error(`Backup not found: ${id}`);

  for (const file of record.files) {
    await ensureDir(path.dirname(file.original));
    await fs.cp(file.backup, file.original, { recursive: true, force: true });
  }
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
