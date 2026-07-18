import path from "node:path";
import {
  claudeSkillsDir,
  codexSkillsDir,
  hashDirectory,
  pathExists,
  shortHash,
  type Resource,
  type TargetTool,
  type VersionPolicy,
} from "@ai-config-sync/core";
import { getState } from "@ai-config-sync/state-manager";
import { getHeadCommit } from "@ai-config-sync/git-sync";

export type DriftKind =
  | "missing"
  | "hash-mismatch"
  | "version-mismatch"
  | "local-only"
  | "extra-unmanaged"
  | "in-sync";

export interface DriftItem {
  resourceId: string;
  target: TargetTool;
  kind: DriftKind;
  message: string;
  desiredHash?: string;
  actualHash?: string;
  path?: string;
}

function installPath(
  home: string,
  target: TargetTool,
  resourceId: string,
): string {
  return target === "claude"
    ? path.join(claudeSkillsDir(home), resourceId)
    : path.join(codexSkillsDir(home), resourceId);
}

export async function computeResourceDrift(options: {
  home: string;
  resource: Resource;
  target: TargetTool;
  sourceRoot?: string;
}): Promise<DriftItem> {
  const { home, resource, target, sourceRoot } = options;
  const dest = installPath(home, target, resource.id);
  const exists = await pathExists(dest);

  if (!exists) {
    return {
      resourceId: resource.id,
      target,
      kind: "missing",
      message: `Not installed: ${dest}`,
      path: dest,
    };
  }

  let actualHash: string | undefined;
  let desiredHash: string | undefined;
  try {
    actualHash = shortHash(await hashDirectory(dest));
  } catch {
    /* ignore */
  }

  if (sourceRoot) {
    try {
      // Prefer hashing skill subdir if present as sources/skills style single skill root
      if (await pathExists(path.join(sourceRoot, "SKILL.md"))) {
        desiredHash = shortHash(await hashDirectory(sourceRoot));
      }
    } catch {
      /* ignore */
    }
  }

  if (desiredHash && actualHash && desiredHash !== actualHash) {
    return {
      resourceId: resource.id,
      target,
      kind: "hash-mismatch",
      message: `Local copy differs from source (local=${actualHash} source=${desiredHash})`,
      desiredHash,
      actualHash,
      path: dest,
    };
  }

  const state = await getState(home);
  const st = state.installed[resource.id]?.[target];
  if (st?.hash && actualHash && st.hash !== actualHash) {
    return {
      resourceId: resource.id,
      target,
      kind: "hash-mismatch",
      message: `Local copy drifted since last apply (was ${st.hash}, now ${actualHash})`,
      desiredHash: st.hash,
      actualHash,
      path: dest,
    };
  }

  return {
    resourceId: resource.id,
    target,
    kind: "in-sync",
    message: "In sync",
    actualHash,
    path: dest,
  };
}

export interface UpdateCheck {
  resourceId: string;
  policy: VersionPolicy;
  action: "none" | "confirm-update" | "auto-update" | "locked" | "unavailable";
  currentCommit?: string;
  message: string;
}

export async function checkVersionPolicy(options: {
  resource: Resource;
  sourceRoot?: string;
  lockedCommit?: string;
}): Promise<UpdateCheck> {
  const policy = options.resource.versionPolicy;
  if (!options.sourceRoot) {
    return {
      resourceId: options.resource.id,
      policy,
      action: "unavailable",
      message: "No local source to check version",
    };
  }

  const head = await getHeadCommit(options.sourceRoot).catch(() => undefined);

  if (policy === "locked") {
    const want = options.lockedCommit ?? options.resource.source?.commit;
    if (want && head && !head.startsWith(want) && !want.startsWith(head.slice(0, 7))) {
      return {
        resourceId: options.resource.id,
        policy,
        action: "locked",
        currentCommit: head,
        message: `Locked to ${want}; cache at ${head.slice(0, 8)} — will checkout locked commit`,
      };
    }
    return {
      resourceId: options.resource.id,
      policy,
      action: "none",
      currentCommit: head,
      message: "Locked version satisfied",
    };
  }

  if (policy === "latest") {
    return {
      resourceId: options.resource.id,
      policy,
      action: "auto-update",
      currentCommit: head,
      message: "latest policy: may pull updates on update command",
    };
  }

  // latest-confirm / vendored
  return {
    resourceId: options.resource.id,
    policy,
    action: policy === "vendored" ? "none" : "confirm-update",
    currentCommit: head,
    message:
      policy === "vendored"
        ? "Vendored snapshot — no remote update"
        : "latest-confirm: show changes before update",
  };
}
