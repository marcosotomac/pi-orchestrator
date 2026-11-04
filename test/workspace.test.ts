import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyChanges,
  collectChanges,
  discardWorkspace,
  isolate,
} from "../src/workspace.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-orch-repo-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "pkg", "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "gone.txt"), "bye\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
}

test("a worktree snapshots tracked uncommitted work, isolates writes and applies back as a reviewed patch", async () => {
  const root = repo();
  try {
    writeFileSync(
      join(root, "pkg", "a.txt"),
      "one\ntwo\nthree\nfour (operator, uncommitted)\n",
    );
    writeFileSync(join(root, "untracked.txt"), "not in the snapshot\n");
    const ws = (await isolate(join(root, "pkg")))!;
    assert.ok(ws, "git repo with a commit");
    assert.equal(
      ws.cwd,
      join(ws.path, "pkg"),
      "the task keeps its subdirectory",
    );
    assert.match(
      readFileSync(join(ws.path, "pkg", "a.txt"), "utf8"),
      /operator, uncommitted/,
      "uncommitted tracked work is visible to the worker",
    );
    assert.equal(
      existsSync(join(ws.path, "untracked.txt")),
      false,
      "untracked files are not part of the snapshot",
    );
    // The worker edits, creates and deletes inside its worktree only.
    writeFileSync(
      join(ws.path, "pkg", "a.txt"),
      "ONE\ntwo\nthree\nfour (operator, uncommitted)\n",
    );
    writeFileSync(join(ws.path, "pkg", "new.txt"), "created\n");
    unlinkSync(join(ws.path, "gone.txt"));
    assert.equal(
      readFileSync(join(root, "pkg", "a.txt"), "utf8").startsWith("one"),
      true,
      "the operator's tree is untouched",
    );
    const changes = await collectChanges(ws);
    assert.equal(changes.state, "pending");
    assert.deepEqual(
      [changes.files, changes.insertions, changes.deletions],
      [3, 2, 2],
    );
    assert.match(changes.summary, /pkg\/new\.txt/);
    await applyChanges(root, changes.patchPath!);
    assert.equal(
      readFileSync(join(root, "pkg", "a.txt"), "utf8"),
      "ONE\ntwo\nthree\nfour (operator, uncommitted)\n",
      "applied on top of the operator's uncommitted work",
    );
    assert.equal(
      readFileSync(join(root, "pkg", "new.txt"), "utf8"),
      "created\n",
    );
    assert.equal(existsSync(join(root, "gone.txt")), false);
    assert.equal(
      readFileSync(join(root, "untracked.txt"), "utf8"),
      "not in the snapshot\n",
    );
    await discardWorkspace(root, changes.worktree, changes.patchPath);
    assert.equal(existsSync(ws.path), false);
    assert.equal(existsSync(changes.patchPath!), false);
    assert.doesNotMatch(
      git(root, "worktree", "list"),
      /pi-orch-wt-/,
      "no stale worktree registration",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a conflicting patch writes nothing; no changes means nothing pending; non-repos are not isolated", async () => {
  const root = repo();
  try {
    const ws = (await isolate(root))!;
    writeFileSync(join(ws.path, "pkg", "a.txt"), "worker\ntwo\nthree\n");
    const changes = await collectChanges(ws);
    writeFileSync(
      join(root, "pkg", "a.txt"),
      "operator changed it meanwhile\ntwo\nthree\n",
    );
    await assert.rejects(
      applyChanges(root, changes.patchPath!),
      /git apply failed/,
    );
    assert.equal(
      readFileSync(join(root, "pkg", "a.txt"), "utf8"),
      "operator changed it meanwhile\ntwo\nthree\n",
      "nothing half-applied",
    );
    assert.equal(
      existsSync(changes.worktree!),
      true,
      "the worktree is kept for manual review",
    );
    await discardWorkspace(root, changes.worktree, changes.patchPath);
    const clean = (await isolate(root))!;
    assert.equal((await collectChanges(clean)).state, "none");
    await discardWorkspace(root, clean.path, undefined);
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "pi-orch-plain-")));
    assert.equal(await isolate(plain), undefined);
    rmSync(plain, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the core isolates YOLO roots in a worktree, children inherit it, and only the operator applies or discards", async () => {
  const { Orchestrator } = await import("../src/orchestrator.ts");
  const { capabilities } = await import("../src/types.ts");
  const root = repo();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "pi-orch-outside-")));
  const seen: Record<string, string> = {};
  let core!: InstanceType<typeof Orchestrator>;
  const run = async (ctx: any) => {
    seen[ctx.prompt] = ctx.task.cwd;
    if (ctx.prompt.startsWith("write")) {
      writeFileSync(
        join(ctx.task.cwd, "pkg", "a.txt"),
        `${ctx.prompt}\ntwo\nthree\n`,
      );
      if (ctx.prompt === "write-with-child") {
        const child = core.delegate(
          ctx.task.id,
          "codex",
          "child-read",
          "child",
        );
        assert.throws(
          () =>
            core.delegate(
              ctx.task.id,
              "codex",
              "x",
              "x",
              undefined,
              undefined,
              undefined,
              outside,
            ),
          /parent's directory/,
        );
        await core.wait(ctx.task.id, child.id, 10_000);
      }
    }
    return "ok";
  };
  core = new Orchestrator({
    cwd: root,
    isolateWrites: true,
    allowedRoots: [outside],
    maxConcurrent: 4,
    adapters: { codex: { capabilities, run } },
  });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    const yolo = await core.wait(
      null,
      core.delegate(
        null,
        "codex",
        "write-with-child",
        "w",
        undefined,
        undefined,
        "yolo",
      ).id,
    );
    assert.equal(yolo.workspace, "worktree");
    assert.notEqual(
      seen["write-with-child"],
      root,
      "the runtime ran in a worktree",
    );
    assert.equal(
      seen["child-read"],
      seen["write-with-child"],
      "the child sees its parent's worktree",
    );
    assert.equal(
      readFileSync(join(root, "pkg", "a.txt"), "utf8"),
      "one\ntwo\nthree\n",
      "the operator's tree is untouched",
    );
    assert.equal(yolo.changes?.state, "pending");
    assert.equal(yolo.changes?.files, 1);
    await assert.rejects(
      core.applyChanges(yolo.id, yolo.id),
      /Only the operator/,
    );
    const applied = await core.applyChanges(null, yolo.id);
    assert.equal(applied.changes?.state, "applied");
    assert.equal(
      readFileSync(join(root, "pkg", "a.txt"), "utf8"),
      "write-with-child\ntwo\nthree\n",
    );
    await assert.rejects(
      core.applyChanges(null, yolo.id),
      /no pending changes/,
    );
    assert.equal(
      existsSync(seen["write-with-child"]!),
      false,
      "worktree removed after apply",
    );

    const second = await core.wait(
      null,
      core.delegate(
        null,
        "codex",
        "write-again",
        "w2",
        undefined,
        undefined,
        "yolo",
      ).id,
    );
    const discarded = await core.discardChanges(null, second.id);
    assert.equal(discarded.changes?.state, "discarded");
    assert.equal(
      readFileSync(join(root, "pkg", "a.txt"), "utf8"),
      "write-with-child\ntwo\nthree\n",
      "discard writes nothing",
    );

    const restricted = await core.wait(
      null,
      core.delegate(null, "codex", "read-only", "r").id,
    );
    assert.equal(restricted.workspace, undefined);
    assert.equal(seen["read-only"], root, "restricted tasks are not isolated");
    const placed = await core.wait(
      null,
      core.delegate(
        null,
        "codex",
        "elsewhere",
        "e",
        undefined,
        undefined,
        undefined,
        outside,
      ).id,
    );
    assert.equal(seen["elsewhere"], outside);
    assert.equal(placed.cwd, outside);
    assert.throws(
      () =>
        core.delegate(
          null,
          "codex",
          "nope",
          "n",
          undefined,
          undefined,
          undefined,
          tmpdir(),
        ),
      /outside the allowed roots/,
    );
    const notGit = await core.wait(
      null,
      core.delegate(
        null,
        "codex",
        "write-outside",
        "wo",
        undefined,
        undefined,
        "yolo",
        outside,
      ).id,
    );
    assert.equal(
      notGit.workspace,
      "in-place",
      "no git repository: runs in place, and says so",
    );
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
