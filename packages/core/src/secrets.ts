/**
 * Secret scanning for commit-time safety.
 * Blocks obvious API keys / tokens; does not store or log matched values.
 */

export interface SecretFinding {
  rule: string;
  line: number;
  /** Redacted preview only. */
  preview: string;
  path?: string;
}

const RULES: Array<{ name: string; re: RegExp }> = [
  {
    name: "aws-access-key",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    name: "github-pat",
    re: /\bghp_[A-Za-z0-9]{36,}\b/g,
  },
  {
    name: "github-fine-grained",
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: "openai-key",
    re: /\bsk-[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "anthropic-key",
    re: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
  },
  {
    name: "generic-bearer",
    re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi,
  },
  {
    name: "private-key-header",
    re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g,
  },
  {
    name: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: "high-entropy-assignment",
    // key= / token: long base64-ish — conservative
    re: /(?:api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*['"]?[A-Za-z0-9/+_=-]{24,}['"]?/gi,
  },
];

function redact(match: string): string {
  if (match.length <= 8) return "***";
  return `${match.slice(0, 4)}…${match.slice(-4)} (len=${match.length})`;
}

export function scanTextForSecrets(
  text: string,
  path?: string,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(line)) !== null) {
        findings.push({
          rule: rule.name,
          line: i + 1,
          preview: redact(m[0]),
          path,
        });
      }
    }
  }
  return findings;
}

export function scanFilesForSecrets(
  files: Array<{ path: string; content: string }>,
): SecretFinding[] {
  return files.flatMap((f) => scanTextForSecrets(f.content, f.path));
}

/** Strip absolute user paths and obvious secrets before sending content to a cloud model. */
export function sanitizeForAi(text: string, homeHint?: string): string {
  let out = text;
  if (homeHint) {
    const escaped = homeHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "~");
  }
  // Windows user paths
  out = out.replace(/[A-Za-z]:\\Users\\[^\\/\s]+/gi, "~");
  out = out.replace(/\/Users\/[^/\s]+/g, "~");
  out = out.replace(/\/home\/[^/\s]+/g, "~");
  // redact secret-like tokens
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, "[REDACTED]");
  }
  return out;
}
