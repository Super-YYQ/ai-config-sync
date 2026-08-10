import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BootstrapSession } from "../../packages/cli/src/bootstrap-session.js";
import { removeTempDir } from "../helpers/temp-dir.js";

describe("BootstrapSession", () => {
  let root: string | undefined;

  afterEach(async () => removeTempDir(root));

  async function fixture(): Promise<{
    session: BootstrapSession;
    configRepo: string;
  }> {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "acs-bootstrap-session-"));
    const home = path.join(root, "home");
    const configRepo = path.join(root, "config");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(configRepo, { recursive: true });
    return { session: new BootstrapSession({ home }), configRepo };
  }

  it("requires a reviewed plan before apply", async () => {
    const { session } = await fixture();
    await expect(session.apply()).rejects.toThrow("No reviewed Bootstrap Plan");
  });

  it("connects, retains the exact reviewed plan, and consumes it on apply", async () => {
    const { session, configRepo } = await fixture();
    const setup = await session.connect({
      configPath: configRepo,
      profile: "home",
      claude: false,
      codex: false,
    });

    expect(setup.status).not.toBe("failed");
    expect((await session.connection()).linked).toBe(true);

    const reviewedPlan = await session.plan({ offline: true });
    expect(session.latestPlan()).toBe(reviewedPlan);

    const result = await session.apply({ offline: true });
    expect(result.plan).toEqual(reviewedPlan);
    expect(session.latestPlan()).toBeUndefined();
  });
});
