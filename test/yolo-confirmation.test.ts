import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { yoloConfirmation } from "../src/presentation.ts";
import { isolationPreview } from "../src/workspace.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

test("isolation preview tells apart a repo with commits, one without, no repo and disabled isolation", async () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "orch-iso-plain-")));
  assert.deepEqual(await isolationPreview(plain), {
    isolated: false,
    reason: "not-git",
  });
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "orch-iso-empty-")));
  git(empty, "init", "-q");
  assert.deepEqual(await isolationPreview(empty), {
    isolated: false,
    reason: "no-commit",
  });
  writeFileSync(join(empty, "a.txt"), "a");
  writeFileSync(join(empty, ".gitignore"), ".env\nnode_modules/\n");
  git(empty, "add", ".");
  git(empty, "commit", "-qm", "init");
  assert.deepEqual(await isolationPreview(empty), {
    isolated: true,
    untracked: 0,
    ignored: 0,
    examples: [],
  });
  writeFileSync(join(empty, "new.ts"), "x");
  writeFileSync(join(empty, ".env"), "SECRET=1");
  mkdirSync(join(empty, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(empty, "node_modules", "dep", "i.js"), "");
  assert.deepEqual(
    await isolationPreview(empty),
    {
      isolated: true,
      untracked: 1,
      ignored: 2,
      examples: [".env", "node_modules/", "new.ts"],
    },
    "an ignored tree counts once",
  );
  assert.deepEqual(await isolationPreview(empty, false), {
    isolated: false,
    reason: "disabled",
  });
});

test("YOLO confirmation states what each engine really enforces", () => {
  const isolated = { isolated: true } as const;
  const agy = yoloConfirmation("antigravity", isolated, "on");
  assert.match(agy, /no es un sandbox/);
  assert.match(
    agy,
    /⚠ SIN SANDBOX: Antigravity puede escribir fuera del worktree, usar la red y leer credenciales/,
  );
  assert.match(
    yoloConfirmation("codex", isolated, "on"),
    /Sandbox de Codex: escribe solo en el directorio de trabajo y temporales, sin red/,
  );
  assert.match(
    yoloConfirmation("claude", isolated, "on"),
    /solo para Bash \(sin red\)\. Write\/Edit no pasan por ese sandbox/,
  );
  for (const engine of ["codex", "claude"] as const)
    assert.match(
      yoloConfirmation(engine, isolated, "off"),
      /⚠ SIN SANDBOX \(PI_ORCHESTRATOR_YOLO_SANDBOX=off\)/,
    );
  assert.match(
    yoloConfirmation("codex", { isolated: false, reason: "not-git" }, "on"),
    /⚠ SIN AISLAMIENTO: no es un repositorio git/,
  );
  assert.match(
    yoloConfirmation("codex", { isolated: false, reason: "no-commit" }, "on"),
    /⚠ SIN AISLAMIENTO: el repositorio no tiene commits/,
  );
  assert.match(
    yoloConfirmation("codex", { isolated: false, reason: "disabled" }, "on"),
    /PI_ORCHESTRATOR_ISOLATE_WRITES=0/,
  );
  for (const engine of ["codex", "claude", "antigravity"] as const)
    assert.doesNotMatch(
      yoloConfirmation(engine, isolated, "on"),
      /aislado con sandbox/,
    );
  assert.doesNotMatch(
    yoloConfirmation(
      "codex",
      { isolated: true, untracked: 0, ignored: 0, examples: [] },
      "on",
    ),
    /No se copian/,
  );
  assert.match(
    yoloConfirmation(
      "codex",
      {
        isolated: true,
        untracked: 1,
        ignored: 2,
        examples: [".env", "node_modules/", "new.ts"],
      },
      "on",
    ),
    /⚠ No se copian al worktree: 1 archivo sin versionar y 2 rutas ignoradas \(p\. ej\. \.env, node_modules\/, new\.ts\)\. Si la tarea los necesita/,
  );
});
