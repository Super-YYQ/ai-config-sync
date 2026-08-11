import type {
  CandidateRecipe,
  Recipe,
  Resource,
} from "@ai-config-sync/core";
import type { ScannedResource } from "@ai-config-sync/scanner";

export type CaptureProposalStatus =
  | "ready"
  | "blocked"
  | "system-excluded"
  | "needs-review";

export interface CaptureItem {
  scanned: ScannedResource;
  /** All scanned installs merged into this logical resource. */
  scannedAll?: ScannedResource[];
  candidate?: CandidateRecipe;
  suggestedResource: Resource;
  suggestedRecipe?: Recipe;
  needsAi: boolean;
  usedAi?: boolean;
  status?: CaptureProposalStatus;
  blockReason?: string;
}

export interface CaptureCommitResult {
  resourcesPath: string;
  recipePaths: string[];
  /** Generated read-only views of the assets stored in the config repository. */
  catalogPaths: string[];
  /** Relative paths under config repo that this capture created or modified. */
  changedRelPaths: string[];
}

export interface CaptureTxEntry {
  /** Relative path under config repo. */
  path: string;
  existedBefore: boolean;
  backupPath?: string;
  type: "file" | "directory";
}

export interface CaptureTransaction {
  id: string;
  stagingRoot: string;
  backupRoot: string;
  entries: CaptureTxEntry[];
}
