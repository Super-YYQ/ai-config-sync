import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BootstrapSession } from "../../packages/cli/src/bootstrap-session.js";
import {
  startBootstrapWeb,
  type BootstrapWebHandle,
} from "../../packages/cli/src/bootstrap-web.js";
import { removeTempDir } from "../helpers/temp-dir.js";

describe("local Bootstrap Web page", () => {
  let root: string | undefined;
  let handle: BootstrapWebHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    await removeTempDir(root);
  });

  it("rejects ports that browsers refuse to fetch", async () => {
    await expect(
      startBootstrapWeb({ port: 6000, openBrowser: false }),
    ).rejects.toThrow("Port 6000 is blocked by Web browsers");
  });

  it("serves the UI locally and protects every API with the session token", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "acs-bootstrap-web-"));
    const home = path.join(root, "home");
    const configRepo = path.join(root, "config");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(configRepo, { recursive: true });
    handle = await startBootstrapWeb({
      session: new BootstrapSession({ home }),
      port: 0,
      openBrowser: false,
      idleTimeoutMs: 60_000,
    });

    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/`);
    const page = await fetch(handle.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("恢复你的 AI 工作环境");

    const denied = await fetch(`${handle.url}api/status`);
    expect(denied.status).toBe(403);

    const headers = {
      "Content-Type": "application/json",
      "X-AI-Config-Sync-Token": handle.token,
    };
    const connected = await fetch(`${handle.url}api/connect`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        configPath: configRepo,
        profile: "home",
        claude: false,
        codex: false,
      }),
    });
    expect(connected.status).toBe(200);
    expect((await connected.json()).connection.linked).toBe(true);

    const planned = await fetch(`${handle.url}api/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ offline: true }),
    });
    expect(planned.status).toBe(200);
    expect(Array.isArray((await planned.json()).plan.actions)).toBe(true);

    const refused = await fetch(`${handle.url}api/apply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: false }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: "Apply requires explicit confirmation",
    });
  });
});
