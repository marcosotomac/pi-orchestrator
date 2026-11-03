import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { RunStore } from "../src/journal.ts";

// Archives are read only. Never probe, adopt or signal their process identities.
const files = process.argv.slice(2).map((path) => resolve(path));
try {
  assert.equal(files.length, 5);
  const wanted = new Set(["single", "antigravity/codex", "antigravity/claude", "codex/antigravity", "claude/antigravity"]);
  const runs = files.map((path) => {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const report = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(report.passed, true);
    const key = report.parentEngine ? `${report.parentEngine}/${report.childEngine}` : "single";
    assert.ok(wanted.delete(key));
    const store = new RunStore(join(dirname(path), "state"));
    const run = store.read(report.runId);
    assert.ok(run.closedAt); assert.deepEqual(run.tasks, report.tasks);
    assert.equal(run.tasks.length, key === "single" ? 1 : 2);
    for (const task of run.tasks) {
      assert.equal(task.state, "completed"); assert.ok(task.runtimeSessionId); assert.ok(task.runtimeProcess?.exitedAt);
      assert.ok(task.result?.includes(key === "single" ? "ACP-" : "NEST-"));
      const events = report.events.filter((event: any) => event.task.id === task.id);
      const exit = events.findIndex((event: any) => event.type === "process-exited");
      assert.ok(exit >= 0 && exit < events.findIndex((event: any) => event.type === "settled"));
    }
    if (key !== "single") {
      const parent = run.tasks.find((task) => !task.parentId)!;
      const child = run.tasks.find((task) => task.parentId === parent.id)!;
      assert.equal(parent.engine, report.parentEngine); assert.equal(child.engine, report.childEngine);
      assert.ok(parent.result?.includes(child.id));
    }
    return { case: key, report: relative(process.cwd(), path), runId: run.runId, taskCount: run.tasks.length, closed: true, exitBeforeSettlement: true };
  });
  assert.equal(wanted.size, 0);
  const sources: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (/\.(?:ts|cjs|py)$/.test(path)) sources.push(path);
    }
  };
  for (const path of ["src", "scripts", "test"]) collect(path);
  sources.push("package.json", "package-lock.json");
  const sourceHashes = Object.fromEntries(sources.sort().map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
  const initialize = JSON.parse(readFileSync("artifacts/antigravity-initialize.json", "utf8"));
  const auth = JSON.parse(readFileSync("artifacts/antigravity-auth.json", "utf8"));
  assert.equal(initialize.agentInfo.name, "antigravity-acp"); assert.equal(initialize.agentInfo.version, "1.4.5"); assert.equal(auth.authenticated, true);
  const verification = { verifiedAt: new Date().toISOString(), sourceHashes, runtime: initialize.agentInfo, oauthAcknowledged: true, runs,
    localTests: 147, localEvidence: "artifacts/recovery-acp-tests.log", pythonInstallerTests: 6, pythonTuiTests: 3,
    cleanupScope: "The live harness checked groups from its own coordinator. This verifier only reads reports/journals, without census or signals from archived PIDs.",
    historicalFailuresPreserved: ["artifacts/antigravity-nested-antigravity-codex-XzABdD/report.json", "artifacts/antigravity-nested-antigravity-codex-mzxLIF/report.json"],
    limits: ["Recovery is an explicit new attempt, not native session adoption/resume", "Native Antigravity tree cancellation not yet tested", "No main Pi model choosing Antigravity tested", "No full human TUI review", "Approval mode is not full machine isolation", "ACP release is proprietary; official Google terms apply"] };
  assert.match(readFileSync(verification.localEvidence, "utf8"), /pass 147\b/);
  writeFileSync("artifacts/antigravity-verification.json", JSON.stringify(verification, null, 2), { mode: 0o600 });
  console.log("PASS: five real Antigravity cases correlated with private closed journals; no archived process actions.");
  console.log("Evidence: artifacts/antigravity-verification.json");
} catch {
  console.error("FAIL: evidence verification; no task content or assertion diff printed."); process.exitCode = 1;
}
