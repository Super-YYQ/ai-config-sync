/**
 * Claude Code CLI resolution and Windows-safe execution.
 *
 * On Windows, `claude` is typically a `.cmd` shim. Node's `execFile()` cannot
 * launch `.cmd`/`.bat` without a shell — see Node child_process docs.
 * This module provides a single executor used by Setup, Drivers, Status, etc.
 */
import { spawn } from "node:child_process";

export function claudeExecutable(): string {
  return process.platform === "win32" ? "claude.cmd" : "claude";
}

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
  // Empty → empty quotes
  if (arg.length === 0) return '""';
  // If no meta chars, leave as-is
  if (!/[\s"&|<>^()%!"]/.test(arg)) return arg;
  // Double quotes and wrap
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Run an external command. On Windows, when the binary looks like a `.cmd`/`.bat`
 * (or is bare `claude` which resolves to a cmd shim), execute via `cmd.exe /d /s /c`
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

  const isWin = process.platform === "win32";
  const looksLikeCmd =
    isWin &&
    (/\.cmd$/i.test(command) ||
      /\.bat$/i.test(command) ||
      command.toLowerCase() === "claude" ||
      command.toLowerCase() === "claude.cmd");

  return new Promise((resolve, reject) => {
    let child;
    if (looksLikeCmd) {
      // cmd.exe /d /s /c <cmdline> — keep args as array elements joined with quotes
      const cmdline = [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ");
      child = spawn("cmd.exe", ["/d", "/s", "/c", cmdline], {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        // Do not set shell:true — we already invoke cmd.exe
      });
    } else {
      child = spawn(command, args, {
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
