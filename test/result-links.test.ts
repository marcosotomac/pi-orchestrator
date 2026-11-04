import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactFileLinks } from "../src/result-links.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { capabilities } from "../src/types.ts";

test("file:// links become path:line: relative inside the task directories, dead worktree paths removed", () => {
  const wt = "/var/folders/4n/x/T/pi-orch-wt-Yx4EDx";
  const text = [
    `[Bun](file:///private${wt}/package.json#L23) y [\`turbo.json\`](file://${wt}/turbo.json)`,
    `[app/[id]/page.tsx](file://${wt}/apps/web/app/[id]/page.tsx#L5-L9) · [.git/config](file:///Users/u/other/.git/config#L7-L9)`,
    `bare file://${wt}/src/a.ts#L3 and [x](https://example.com) unchanged; [y](file://relative) kept`,
    `[espacio](file:///Users/u/My%20Docs/a.md#L1-L1)`,
  ].join("\n");
  assert.equal(compactFileLinks(text, [wt, "/Users/u/repo"]), [
    "Bun (`package.json:23`) y `turbo.json`",
    "`apps/web/app/[id]/page.tsx:5-9` · `/Users/u/other/.git/config:7-9`",
    "bare src/a.ts:3 and [x](https://example.com) unchanged; [y](file://relative) kept",
    "espacio (`/Users/u/My Docs/a.md:1`)",
  ].join("\n"));
  assert.equal(compactFileLinks("no links", []), "no links");
});

test("orchestrator compacts file:// links in published results", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "orch-links-")));
  const core = new Orchestrator({ cwd, adapters: { antigravity: { capabilities, run: async () => `see [a.ts](file://${cwd}/src/a.ts#L10)` } } });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try { assert.equal((await core.wait(null, core.delegate(null, "antigravity", "p", "k").id)).result, "see `src/a.ts:10`"); }
  finally { await core.close(); }
});
