/**
 * Merge Codex hooks.json in the official event-map shape:
 * { hooks: { SessionStart: [ { hooks: [ { type, command, timeout } ] } ] } }
 * Also supports legacy array form and migrates managed entry.
 *
 * Windows: include commandWindows when an absolute CLI path is known so
 * environments without PATH still invoke the correct binary.
 */

export interface CodexHookCommand {
  type: "command";
  command: string;
  /** Windows-specific command (absolute path preferred). */
  commandWindows?: string;
  timeout?: number;
  id?: string;
}

const MANAGED_ID = "ai-config-sync-session-start";
const MANAGED_COMMAND = "ai-config-sync scan --light --write-pending";

export interface MergeCodexHookOptions {
  /** Absolute path to ai-config-sync CLI (or node + cjs). Used for commandWindows. */
  cliAbsoluteCommand?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isManagedHookCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") return false;
  return cmd.includes("ai-config-sync") && cmd.includes("scan");
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
            (isManagedHookCommand(h.command) ||
              isManagedHookCommand(h.commandWindows) ||
              h.id === MANAGED_ID)
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
          isManagedHookCommand(h.command) ||
          isManagedHookCommand(h.commandWindows)),
    );
  }
  return false;
}

function buildManagedCommand(
  options?: MergeCodexHookOptions,
): CodexHookCommand {
  const managedCmd: CodexHookCommand = {
    type: "command",
    command: MANAGED_COMMAND,
    timeout: 20,
    id: MANAGED_ID,
  };
  if (options?.cliAbsoluteCommand) {
    // Prefer absolute path on Windows; keep portable command for other platforms
    managedCmd.commandWindows = options.cliAbsoluteCommand.includes("scan")
      ? options.cliAbsoluteCommand
      : `${options.cliAbsoluteCommand} scan --light --write-pending`;
  }
  return managedCmd;
}

/**
 * Ensure managed SessionStart command exists without dropping other hooks.
 */
export function mergeManagedCodexSessionStart(
  doc: unknown,
  options?: MergeCodexHookOptions,
): {
  next: Record<string, unknown>;
  changed: boolean;
} {
  if (hasManagedCodexSessionStart(doc)) {
    // Optionally refresh commandWindows if absolute path provided and missing
    if (options?.cliAbsoluteCommand && isPlainObject(doc) && isPlainObject(doc.hooks)) {
      const hooks = { ...(doc.hooks as Record<string, unknown>) };
      const session = Array.isArray(hooks.SessionStart)
        ? [...(hooks.SessionStart as unknown[])]
        : [];
      let refreshed = false;
      const nextSession = session.map((block) => {
        if (!isPlainObject(block) || !Array.isArray(block.hooks)) return block;
        const nextHooks = (block.hooks as unknown[]).map((h) => {
          if (
            isPlainObject(h) &&
            (h.id === MANAGED_ID || isManagedHookCommand(h.command))
          ) {
            if (!h.commandWindows) {
              refreshed = true;
              return {
                ...h,
                commandWindows: options.cliAbsoluteCommand!.includes("scan")
                  ? options.cliAbsoluteCommand
                  : `${options.cliAbsoluteCommand} scan --light --write-pending`,
              };
            }
          }
          return h;
        });
        return { ...block, hooks: nextHooks };
      });
      if (refreshed) {
        return {
          next: { ...doc, hooks: { ...hooks, SessionStart: nextSession } },
          changed: true,
        };
      }
    }
    return {
      next: isPlainObject(doc) ? { ...doc } : { hooks: {} },
      changed: false,
    };
  }

  const managedCmd = buildManagedCommand(options);

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
