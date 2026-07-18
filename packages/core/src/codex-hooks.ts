/**
 * Merge Codex hooks.json in the official event-map shape:
 * { hooks: { SessionStart: [ { hooks: [ { type, command, timeout } ] } ] } }
 * Also supports legacy array form and migrates managed entry.
 */

export interface CodexHookCommand {
  type: "command";
  command: string;
  timeout?: number;
  id?: string;
}

const MANAGED_ID = "ai-config-sync-session-start";
const MANAGED_COMMAND = "ai-config-sync scan --light --write-pending";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function hasManagedCodexSessionStart(doc: unknown): boolean {
  if (!isPlainObject(doc)) return false;
  const hooks = doc.hooks;
  // event-map
  if (isPlainObject(hooks)) {
    const session = hooks.SessionStart;
    if (Array.isArray(session)) {
      for (const block of session) {
        if (!isPlainObject(block) || !Array.isArray(block.hooks)) continue;
        for (const h of block.hooks) {
          if (
            isPlainObject(h) &&
            typeof h.command === "string" &&
            h.command.includes("ai-config-sync") &&
            h.command.includes("scan")
          ) {
            return true;
          }
        }
      }
    }
  }
  // legacy array
  if (Array.isArray(hooks)) {
    return hooks.some(
      (h) =>
        isPlainObject(h) &&
        (h.id === MANAGED_ID ||
          (typeof h.command === "string" &&
            h.command.includes("ai-config-sync"))),
    );
  }
  return false;
}

/**
 * Ensure managed SessionStart command exists without dropping other hooks.
 */
export function mergeManagedCodexSessionStart(doc: unknown): {
  next: Record<string, unknown>;
  changed: boolean;
} {
  if (hasManagedCodexSessionStart(doc)) {
    return {
      next: isPlainObject(doc) ? { ...doc } : { hooks: {} },
      changed: false,
    };
  }

  const managedCmd: CodexHookCommand = {
    type: "command",
    command: MANAGED_COMMAND,
    timeout: 20,
    id: MANAGED_ID,
  };

  // Start from existing
  let next: Record<string, unknown>;
  if (isPlainObject(doc)) {
    next = { ...doc };
  } else {
    next = {};
  }

  const hooksVal = next.hooks;

  // Legacy array → migrate to event-map while preserving entries
  if (Array.isArray(hooksVal)) {
    const eventMap: Record<string, unknown[]> = {};
    for (const entry of hooksVal) {
      if (!isPlainObject(entry)) continue;
      const event = String(entry.event ?? "SessionStart");
      const cmd: CodexHookCommand = {
        type: "command",
        command: String(entry.command ?? ""),
        timeout:
          typeof entry.timeout_ms === "number"
            ? Math.ceil(entry.timeout_ms / 1000)
            : typeof entry.timeout === "number"
              ? entry.timeout
              : 20,
        id: typeof entry.id === "string" ? entry.id : undefined,
      };
      if (!cmd.command) continue;
      const list = eventMap[event] ?? [];
      list.push({ hooks: [cmd] });
      eventMap[event] = list;
    }
    const session = eventMap.SessionStart ?? [];
    session.push({ hooks: [managedCmd] });
    eventMap.SessionStart = session;
    next.hooks = eventMap;
    return { next, changed: true };
  }

  // Empty or object map
  const eventMap: Record<string, unknown[]> = isPlainObject(hooksVal)
    ? { ...(hooksVal as Record<string, unknown[]>) }
    : {};

  // Normalize non-array values
  for (const [k, v] of Object.entries(eventMap)) {
    if (!Array.isArray(v)) {
      eventMap[k] = [];
    }
  }

  const session = Array.isArray(eventMap.SessionStart)
    ? [...eventMap.SessionStart]
    : [];
  session.push({ hooks: [managedCmd] });
  eventMap.SessionStart = session;
  next.hooks = eventMap;
  return { next, changed: true };
}

export { MANAGED_ID, MANAGED_COMMAND };
