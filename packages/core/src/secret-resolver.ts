/**
 * Resolve secretRef values from local providers only.
 * Never logs or returns values into config files.
 */

export type SecretProviderName =
  | "env"
  | "local-only"
  | "credential-manager"
  | "bitwarden"
  | "keepassxc";

export interface SecretResolveResult {
  ok: boolean;
  /** Present only for runtime use — callers must not persist. */
  value?: string;
  provider: SecretProviderName;
  message: string;
}

function envCandidates(ref: string): string[] {
  const upper = ref.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  const slash = ref.replace(/\//g, "_").toUpperCase();
  return [
    ref,
    upper,
    slash,
    `SECRET_${upper}`,
    `ACS_${upper}`,
  ];
}

export function resolveSecretFromEnv(ref: string): SecretResolveResult {
  for (const key of envCandidates(ref)) {
    const v = process.env[key];
    if (v !== undefined && v !== "") {
      return {
        ok: true,
        value: v,
        provider: "env",
        message: `resolved via env:${key}`,
      };
    }
  }
  return {
    ok: false,
    provider: "env",
    message: `Secret ref "${ref}" not found in environment (tried ${envCandidates(ref).join(", ")})`,
  };
}

/**
 * MVP resolver: env only. Other providers return actionable manual messages.
 */
export async function resolveSecret(
  ref: string,
  provider: SecretProviderName = "env",
): Promise<SecretResolveResult> {
  if (provider === "env" || provider === "local-only") {
    return resolveSecretFromEnv(ref);
  }
  if (provider === "credential-manager") {
    // Windows Credential Manager integration deferred — check env fallback
    const env = resolveSecretFromEnv(ref);
    if (env.ok) return { ...env, message: `${env.message} (credential-manager fallback)` };
    return {
      ok: false,
      provider,
      message: `Credential Manager provider not fully wired; set env for "${ref}" or use --provider env`,
    };
  }
  return {
    ok: false,
    provider,
    message: `Provider "${provider}" is not implemented in MVP. Use env secretRef mapping.`,
  };
}

/** Check many refs; never includes secret values in the report. */
export async function checkSecrets(
  refs: string[],
  provider: SecretProviderName = "env",
): Promise<Array<{ ref: string; ok: boolean; message: string }>> {
  const out: Array<{ ref: string; ok: boolean; message: string }> = [];
  for (const ref of refs) {
    const r = await resolveSecret(ref, provider);
    out.push({ ref, ok: r.ok, message: r.message });
  }
  return out;
}

/** Extract secretRef strings from a nested config-like object. */
export function collectSecretRefs(node: unknown, acc: Set<string> = new Set()): string[] {
  if (node === null || node === undefined) return [...acc];
  if (typeof node === "string") return [...acc];
  if (Array.isArray(node)) {
    for (const item of node) collectSecretRefs(item, acc);
    return [...acc];
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.secretRef === "string") acc.add(obj.secretRef);
    for (const v of Object.values(obj)) collectSecretRefs(v, acc);
  }
  return [...acc];
}
