/**
 * Claude Code CLI resolution and Windows-safe execution.
 *
 * On Windows, npm-installed tools are typically `.cmd` shims. Node's `execFile()`
 * cannot launch `.cmd`/`.bat` without a shell — see Node child_process docs.
 * This module provides a single executor used by Setup, Drivers, Status, etc.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function claudeExecutable(): string {
  return process.platform === "win32" ? "claude.cmd" : "claude";
}

/** Commands that are known Windows npm/cmd shims even without an extension. */
const WINDOWS_CMD_SHIMS = new Set([
  "claude",
  "claude.cmd",
  "npx",
  "npx.cmd",
  "npm",
  "npm.cmd",
  "ai-config-sync",
  "ai-config-sync.cmd",
  "agent-sync",
  "agent-sync.cmd",
]);

export interface RunCommandOptions {
  timeout?: number;
  maxBuffer?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Override binary (default: claudeExecutable()). */
  command?: string;
  /** Encoding for stdout/stderr (default utf8). */
  encoding?: BufferEncoding;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Quote a single argument for `cmd.exe /d /s /c` so special characters stay
 * inside one argv after the shell parses the command line.
 */
export function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"&|<>^()%!"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Whether this command should be launched via cmd.exe on Windows.
 * - Explicit .cmd/.bat extension
 * - Bare names known to be npm shims (claude, npx, npm, …)
 * - Resolved PATH entry that ends with .cmd/.bat
 */
export function needsWindowsCmdShell(command: string): boolean {
  if (process.platform !== "win32") return false;
  if (/\.cmd$/i.test(command) || /\.bat$/i.test(command)) return true;
  const base = path.basename(command).toLowerCase();
  if (WINDOWS_CMD_SHIMS.has(base)) return true;
  // If PATH resolves to a .cmd/.bat, treat as shell command
  try {
    const pathEnv = process.env.PATH ?? process.env.Path ?? "";
    const parts = pathEnv.split(path.delimiter).filter(Boolean);
    for (const dir of parts) {
      for (const ext of [".cmd", ".bat", ""]) {
        const candidate = path.join(dir, command + (ext && !command.includes(".") ? ext : ""));
        if (fs.existsSync(candidate) && /\.(cmd|bat)$/i.test(candidate)) {
          return true;
        }
      }
      // also bare name + .cmd
      const withCmd = path.join(dir, `${command}.cmd`);
      if (fs.existsSync(withCmd)) return true;
    }
  } catch {
    /* ignore PATH probe failures */
  }
  return false;
}

/**
 * Resolve the command that should actually be spawned on Windows for shims.
 * Prefer explicit `.cmd` when the bare name is a known shim.
 */
export function resolveWindowsCommand(command: string): string {
  if (process.platform !== "win32") return command;
  if (/\.cmd$/i.test(command) || /\.bat$/i.test(command) || path.isAbsolute(command)) {
    return command;
  }
  const base = path.basename(command).toLowerCase();
  if (WINDOWS_CMD_SHIMS.has(base) && !base.endsWith(".cmd")) {
    return `${command}.cmd`;
  }
  return command;
}

/**
 * Run an external command. On Windows, when the binary looks like a `.cmd`/`.bat`
 * (or is a known npm shim such as claude/npx), execute via `cmd.exe /d /s /c`
 * with properly quoted arguments. On POSIX, use spawn without shell.
 */
export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const timeout = options.timeout ?? 120_000;
  const maxBuffer = options.maxBuffer ?? 5 * 1024 * 1024;
  const encoding = options.encoding ?? "utf8";

  const resolved = resolveWindowsCommand(command);
  const useCmdShell = needsWindowsCmdShell(resolved) || needsWindowsCmdShell(command);

  return new Promise((resolve, reject) => {
    let child;
    if (useCmdShell) {
      const cmdline = [quoteCmdArg(resolved), ...args.map(quoteCmdArg)].join(" ");
      child = spawn("cmd.exe", ["/d", "/s", "/c", cmdline], {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
      });
    } else {
      child = spawn(resolved, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        shell: false,
      });
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeout);

    child.stdout?.setEncoding(encoding);
    child.stderr?.setEncoding(encoding);
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > maxBuffer) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        const e = new Error(
          `Command timed out after ${timeout}ms: ${command} ${args.join(" ")}`,
        ) as Error & { code?: string; stdout?: string; stderr?: string };
        e.code = "ETIMEDOUT";
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
        return;
      }
      if (code !== 0) {
        const e = new Error(
          `Command failed (${code}): ${command} ${args.join(" ")}\n${stderr || stdout}`,
        ) as Error & {
          code?: number | string;
          stdout?: string;
          stderr?: string;
        };
        e.code = code ?? "FAILED";
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/** Run the Claude Code CLI with Windows-safe spawning. */
export async function runClaude(
  args: string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const command = options.command ?? claudeExecutable();
  return runCommand(command, args, options);
}
