import { z } from "zod";

/** Schema version shared across config files. */
export const SCHEMA_VERSION = 1 as const;

export const TargetToolSchema = z.enum(["claude", "codex"]);
export type TargetTool = z.output<typeof TargetToolSchema>;

export const ResourceKindSchema = z.enum([
  "skill",
  "plugin",
  "integration",
  "hook",
  "mcp",
  "instruction",
]);
export type ResourceKind = z.output<typeof ResourceKindSchema>;

export const VersionPolicySchema = z.enum([
  "locked",
  "latest-confirm",
  "latest",
  "vendored",
]);
export type VersionPolicy = z.output<typeof VersionPolicySchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.output<typeof RiskLevelSchema>;

export const DriverNameSchema = z.enum([
  "claude-marketplace",
  "repository-layout",
  "generic-skill",
  "npx-skills",
  "manual",
]);
export type DriverName = z.output<typeof DriverNameSchema>;

export const SourceProviderSchema = z.enum([
  "github",
  "git",
  "marketplace",
  "npx",
  "local",
  "vendored",
  "unknown",
]);
export type SourceProvider = z.output<typeof SourceProviderSchema>;

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export const SourceSchema = z.object({
  provider: SourceProviderSchema.default("unknown"),
  repository: z.string().optional(),
  url: z.string().optional(),
  path: z.string().optional(),
  ref: z.string().optional(),
  commit: z.string().optional(),
  marketplace: z.string().optional(),
  package: z.string().optional(),
});
export type Source = z.output<typeof SourceSchema>;

// ---------------------------------------------------------------------------
// Recipe operations & recipe model
// ---------------------------------------------------------------------------

export const OperationTypeSchema = z.enum([
  "copy-directory",
  "copy-skill",
  "copy-hook-scripts",
  "merge-json",
  "merge-toml",
  "merge-hook-manifest",
  "run-cli",
  "enable-feature",
  "register-marketplace",
  "install-plugin",
  "enable-plugin",
  "manual",
]);
export type OperationType = z.output<typeof OperationTypeSchema>;

export const RecipeOperationSchema = z.object({
  type: OperationTypeSchema,
  /** Source path relative to source root, or absolute when needed. */
  from: z.string().optional(),
  /** Destination path template (may use ~ and tool dirs). */
  to: z.string().optional(),
  /** Dot-path for merge-toml / merge-json field writes. */
  path: z.string().optional(),
  value: z.unknown().optional(),
  /** CLI argv template for run-cli. */
  command: z.array(z.string()).optional(),
  /** Extra free-form args. */
  args: z.record(z.unknown()).optional(),
});
export type RecipeOperation = z.output<typeof RecipeOperationSchema>;

export const RecipeEvidenceSchema = z.object({
  path: z.string(),
  section: z.string().optional(),
  note: z.string().optional(),
});
export type RecipeEvidence = z.output<typeof RecipeEvidenceSchema>;

export const TargetRecipeSchema = z.object({
  driver: DriverNameSchema,
  scope: z.enum(["user", "project", "local"]).default("user"),
  marketplaceRepository: z.string().optional(),
  marketplace: z.string().optional(),
  plugin: z.string().optional(),
  sourcePaths: z
    .object({
      skill: z.string().optional(),
      hookManifest: z.string().optional(),
      hookScripts: z.string().optional(),
      plugin: z.string().optional(),
      instruction: z.string().optional(),
    })
    .optional(),
  operations: z.array(RecipeOperationSchema).default([]),
  requiredPaths: z.array(z.string()).default([]),
  requirements: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  risk: RiskLevelSchema.default("medium"),
  evidence: z.array(RecipeEvidenceSchema).default([]),
  confidence: z.number().min(0).max(1).optional(),
  requiresApproval: z.boolean().default(true),
});
export type TargetRecipe = z.output<typeof TargetRecipeSchema>;

/**
 * Logical resource/recipe id. May contain ':' (e.g. hooks:SessionStart)
 * but must not be used directly as a filename — use toStorageKey().
 */
export const ResourceIdSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((v) => !v.includes(".."), { message: "resource id must not contain .." })
  .refine((v) => !/[\/\\]/.test(v), {
    message: "resource id must not contain path separators",
  });

export const RecipeSchema = z.object({
  id: ResourceIdSchema,
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  source: SourceSchema.optional(),
  targets: z.record(TargetToolSchema, TargetRecipeSchema).default({}),
  versionPolicy: VersionPolicySchema.default("latest-confirm"),
  risk: RiskLevelSchema.default("medium"),
  notes: z.string().optional(),
  confirmedAt: z.string().optional(),
  confirmedBy: z.string().optional(),
});
export type Recipe = z.output<typeof RecipeSchema>;

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const ResourceTargetConfigSchema = z.object({
  enabled: z.boolean().default(true),
  recipeRef: z.string().optional(),
  scope: z.enum(["user", "project", "local"]).optional(),
});
export type ResourceTargetConfig = z.output<typeof ResourceTargetConfigSchema>;

export const ResourceSchema = z.object({
  id: ResourceIdSchema,
  kind: ResourceKindSchema,
  source: SourceSchema.optional(),
  targets: z
    .object({
      claude: ResourceTargetConfigSchema.optional(),
      codex: ResourceTargetConfigSchema.optional(),
    })
    .default({}),
  profiles: z.array(z.string()).default(["base"]),
  versionPolicy: VersionPolicySchema.default("latest-confirm"),
  notes: z.string().optional(),
});
export type Resource = z.output<typeof ResourceSchema>;

export const ResourcesFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  resources: z.array(ResourceSchema).default([]),
});
export type ResourcesFile = z.output<typeof ResourcesFileSchema>;

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export const ProfileSchema = z.object({
  profile: z.string().min(1),
  extends: z.array(z.string()).default([]),
  include: z
    .object({
      resources: z.array(z.string()).default([]),
    })
    .default({ resources: [] }),
  exclude: z
    .object({
      resources: z.array(z.string()).default([]),
    })
    .default({ resources: [] }),
  security: z
    .object({
      maxRisk: RiskLevelSchema.default("medium"),
      allowAutomaticLatest: z.boolean().default(false),
      secrets: z
        .object({
          provider: z
            .enum(["local-only", "env", "credential-manager", "bitwarden", "keepassxc"])
            .default("local-only"),
        })
        .default({ provider: "local-only" }),
    })
    .default({}),
  ownership: z
    .object({
      claude: z.array(z.string()).default([]),
      codex: z.array(z.string()).default([]),
    })
    .optional(),
});
export type Profile = z.output<typeof ProfileSchema>;

// ---------------------------------------------------------------------------
// Config repository root (config.yaml in private repo)
// ---------------------------------------------------------------------------

export const ConfigRepoSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  name: z.string().optional(),
  defaultProfile: z.string().default("home"),
  targets: z
    .object({
      claude: z.boolean().default(true),
      codex: z.boolean().default(true),
    })
    .default({ claude: true, codex: true }),
  security: z
    .object({
      blockSecretCommit: z.boolean().default(true),
      maxRiskWithoutConfirm: RiskLevelSchema.default("low"),
    })
    .default({}),
  ai: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(["off", "analyze-only"]).default("off"),
    })
    .default({ enabled: false, mode: "off" }),
});
export type ConfigRepo = z.output<typeof ConfigRepoSchema>;

// ---------------------------------------------------------------------------
// Lock file
// ---------------------------------------------------------------------------

export const LockEntrySchema = z.object({
  resourceId: z.string(),
  target: TargetToolSchema.optional(),
  commit: z.string().optional(),
  version: z.string().optional(),
  hash: z.string().optional(),
  recipeId: z.string().optional(),
  resolvedAt: z.string().optional(),
});
export type LockEntry = z.output<typeof LockEntrySchema>;

export const LockFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  entries: z.array(LockEntrySchema).default([]),
});
export type LockFile = z.output<typeof LockFileSchema>;

// ---------------------------------------------------------------------------
// Local machine config (~/.ai-config-sync/config.yaml)
// ---------------------------------------------------------------------------

export const LocalConfigSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  configRepository: z.object({
    remote: z.string().optional(),
    localPath: z.string(),
  }),
  profile: z.string().default("home"),
  targets: z
    .object({
      claude: z.boolean().default(true),
      codex: z.boolean().default(true),
    })
    .default({ claude: true, codex: true }),
  ai: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(["off", "analyze-only"]).default("analyze-only"),
    })
    .default({ enabled: false, mode: "off" }),
});
export type LocalConfig = z.output<typeof LocalConfigSchema>;

// ---------------------------------------------------------------------------
// State (machine-local install state)
// ---------------------------------------------------------------------------

export const InstalledTargetStateSchema = z.object({
  status: z.enum(["installed", "missing", "drift", "failed", "manual"]),
  version: z.string().optional(),
  commit: z.string().optional(),
  path: z.string().optional(),
  hash: z.string().optional(),
  lastChecked: z.string().optional(),
  notes: z.string().optional(),
});
export type InstalledTargetState = z.output<typeof InstalledTargetStateSchema>;

export const StateFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  profile: z.string().optional(),
  lastAppliedCommit: z.string().optional(),
  lastSuccessfulApply: z.string().optional(),
  installed: z
    .record(
      z.string(),
      z.object({
        claude: InstalledTargetStateSchema.optional(),
        codex: InstalledTargetStateSchema.optional(),
      }),
    )
    .default({}),
});
export type StateFile = z.output<typeof StateFileSchema>;

// ---------------------------------------------------------------------------
// Pending events
// ---------------------------------------------------------------------------

export const PendingEventSchema = z.object({
  type: z.enum([
    "resource-added",
    "resource-removed",
    "resource-modified",
    "config-changed",
    "upstream-update",
    "recipe-stale",
  ]),
  target: TargetToolSchema.optional(),
  path: z.string().optional(),
  resourceId: z.string().optional(),
  sourceCandidate: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  message: z.string().optional(),
  detectedAt: z.string().optional(),
});
export type PendingEvent = z.output<typeof PendingEventSchema>;

export const PendingBatchSchema = z.object({
  batchId: z.string(),
  events: z.array(PendingEventSchema).default([]),
  status: z
    .enum(["pending-review", "reviewed", "applied", "dismissed"])
    .default("pending-review"),
  createdAt: z.string().optional(),
});
export type PendingBatch = z.output<typeof PendingBatchSchema>;

// ---------------------------------------------------------------------------
// Plan / Apply
// ---------------------------------------------------------------------------

export const PlanActionTypeSchema = z.enum([
  "CREATE",
  "UPDATE",
  "DELETE",
  "MERGE",
  "COPY",
  "ENABLE",
  "MANUAL",
  "SKIP",
]);
export type PlanActionType = z.output<typeof PlanActionTypeSchema>;

export const PlanActionSchema = z.object({
  id: z.string(),
  type: PlanActionTypeSchema,
  target: TargetToolSchema.optional(),
  resourceId: z.string().optional(),
  description: z.string(),
  risk: RiskLevelSchema.default("medium"),
  driver: DriverNameSchema.optional(),
  operation: RecipeOperationSchema.optional(),
  paths: z.array(z.string()).default([]),
  requiresConfirmation: z.boolean().default(true),
});
export type PlanAction = z.output<typeof PlanActionSchema>;

export const PlanSchema = z.object({
  id: z.string(),
  profile: z.string(),
  configRepository: z.string().optional(),
  createdAt: z.string(),
  actions: z.array(PlanActionSchema).default([]),
  summary: z.string().optional(),
});
export type Plan = z.output<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// Candidate recipe (AI output)
// ---------------------------------------------------------------------------

export const CandidateRecipeSchema = z.object({
  target: TargetToolSchema,
  driver: DriverNameSchema,
  operations: z.array(RecipeOperationSchema).default([]),
  sourcePaths: TargetRecipeSchema.shape.sourcePaths.optional(),
  requiredPaths: z.array(z.string()).default([]),
  evidence: z.array(RecipeEvidenceSchema).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  risk: RiskLevelSchema.default("medium"),
  requiresApproval: z.boolean().default(true),
  notes: z.string().optional(),
});
export type CandidateRecipe = z.output<typeof CandidateRecipeSchema>;

// ---------------------------------------------------------------------------
// Secret refs
// ---------------------------------------------------------------------------

export const SecretRefSchema = z.object({
  secretRef: z.string().min(1),
});
export type SecretRef = z.output<typeof SecretRefSchema>;
