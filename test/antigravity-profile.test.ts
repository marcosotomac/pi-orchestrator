import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityEnvironment } from "../src/antigravity-profile.ts";

test(
  "ACP uses its private OAuth profile and matching helper, removing ambient Google auth without mutating the parent",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "orch-acp-profile-"));
    const settings = join(root, "antigravity-acp", "settings.json");
    mkdirSync(join(root, "antigravity-acp"), { mode: 0o700 });
    writeFileSync(
      settings,
      JSON.stringify({ auth: { type: "oauth-personal" } }),
      { mode: 0o600 },
    );
    writeFileSync(join(root, "localharness_external"), "fixture", {
      mode: 0o700,
    });
    const previous = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = "fixture-must-not-reach-runtime";
    try {
      const env = antigravityEnvironment(
        join(root, "agy_acp_server.par"),
        root,
      );
      assert.equal(env.GOOGLE_API_KEY, undefined);
      assert.equal(env.GEMINI_HOME, root);
      assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, "1");
      assert.equal(env.BROWSER, "/usr/bin/false");
      assert.equal(
        env.ANTIGRAVITY_HARNESS_PATH,
        join(root, "localharness_external"),
      );
      assert.equal(
        process.env.GOOGLE_API_KEY,
        "fixture-must-not-reach-runtime",
      );
      chmodSync(settings, 0o644);
      assert.throws(
        () => antigravityEnvironment(join(root, "agy_acp_server.par"), root),
        /private.*profile/,
      );
      chmodSync(settings, 0o600);
      rmSync(settings);
      symlinkSync("/etc/passwd", settings);
      assert.throws(
        () => antigravityEnvironment(join(root, "agy_acp_server.par"), root),
        /private.*profile/,
      );
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
