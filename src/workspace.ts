import { spawn } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

/** A YOLO task's private checkout: changes land here, never in the operator's tree. */
export interface IsolatedWorkspace {
  repoRoot: string;
  path: string;
  cwd: string;
  base: string;
  patchDirectory: string;
}

export interface TaskChanges {
  state: "pending" | "applied" | "discarded" | "none";
  files: number;
  insertions: number;
  deletions: number;
  /** `git diff --stat`, bounded. */
  summary: string;
  repo?: string;
  worktree?: string;
  patchPath?: string;
  base?: string;
  error?: string;
}

/** Async so a large checkout never blocks Pi's event loop (and TUI). */
function git(args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1_024 * 1_024) child.kill("SIGKILL");
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `git ${args[0]} failed: ${(Buffer.concat(err).toString("utf8") || stdout).trim().slice(0, 500)}`,
          ),
        );
    });
    child.stdin.end(input ?? "");
  });
}

/** Why a YOLO root would or would not get a worktree; nothing is created. */
/** `untracked`/`ignored`: entries the snapshot leaves out (`git stash create` copies tracked state only). */
export type IsolationPreview =
  | {
      isolated: true;
      untracked?: number;
      ignored?: number;
      examples?: string[];
    }
  | { isolated: false; reason: "not-git" | "no-commit" | "disabled" };

const lines = (text: string) => text.split("\n").filter(Boolean);

/** What isolate() would do for `cwd`, for the operator's confirmation. Read-only git queries. */
export async function isolationPreview(
  cwd: string,
  enabled = true,
): Promise<IsolationPreview> {
  if (!enabled) return { isolated: false, reason: "disabled" };
  let root: string;
  try {
    root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    return { isolated: false, reason: "not-git" };
  }
  try {
    await git(["rev-parse", "--verify", "HEAD"], root);
  } catch {
    return { isolated: false, reason: "no-commit" };
  }
  // Counted for the warning only; a failed count never blocks the confirmation.
  try {
    const untracked = lines(
      await git(["ls-files", "--others", "--exclude-standard"], root),
    );
    // --directory collapses ignored trees (node_modules/) into one entry.
    const ignored = lines(
      await git(
        [
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
        ],
        root,
      ),
    );
    return {
      isolated: true,
      untracked: untracked.length,
      ignored: ignored.length,
      examples: [...ignored, ...untracked].slice(0, 3),
    };
  } catch {
    return { isolated: true };
  }
}

/**
 * Creates a detached worktree at a snapshot of the operator's tracked state
 * (commit + staged + unstaged, via `git stash create`; untracked files are not
 * included). Returns undefined when `cwd` is not inside a git repository with a commit.
 */
export async function isolate(
  cwd: string,
): Promise<IsolatedWorkspace | undefined> {
  let repoRoot: string;
  try {
    repoRoot = realpathSync(
      (await git(["rev-parse", "--show-toplevel"], cwd)).trim(),
    );
    await git(["rev-parse", "--verify", "HEAD"], repoRoot);
  } catch {
    return undefined;
  }
  const base =
    (await git(["stash", "create"], repoRoot)).trim() ||
    (await git(["rev-parse", "HEAD"], repoRoot)).trim();
  const path = realpathSync(mkdtempSync(join(tmpdir(), "pi-orch-wt-")));
  const patchDirectory = mkdtempSync(join(tmpdir(), "pi-orch-patch-"));
  try {
    await git(["worktree", "add", "--detach", path, base], repoRoot);
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    rmSync(patchDirectory, { recursive: true, force: true });
    throw error;
  }
  const sub = relative(repoRoot, realpathSync(cwd));
  return {
    repoRoot,
    path,
    cwd:
      sub && !sub.startsWith("..") && !isAbsolute(sub) ? join(path, sub) : path,
    base,
    patchDirectory,
  };
}

/** Stages everything in the worktree (its own index) and records the diff against the snapshot. */
export async function collectChanges(
  workspace: IsolatedWorkspace,
): Promise<TaskChanges> {
  await git(["add", "-A"], workspace.path);
  const numstat = (
    await git(["diff", "--cached", "--numstat", workspace.base], workspace.path)
  ).trim();
  if (!numstat)
    return {
      state: "none",
      files: 0,
      insertions: 0,
      deletions: 0,
      summary: "",
    };
  let insertions = 0,
    deletions = 0;
  const lines = numstat.split("\n");
  for (const line of lines) {
    const [added, removed] = line.split("\t");
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0; // "-" for binary files
  }
  const patchPath = join(workspace.patchDirectory, "changes.patch");
  writeFileSync(
    patchPath,
    await git(["diff", "--cached", "--binary", workspace.base], workspace.path),
    { mode: 0o600 },
  );
  const summary = (
    await git(
      ["diff", "--cached", "--stat=120", workspace.base],
      workspace.path,
    )
  )
    .trim()
    .slice(0, 4_000);
  return {
    state: "pending",
    files: lines.length,
    insertions,
    deletions,
    summary,
    repo: workspace.repoRoot,
    worktree: workspace.path,
    patchPath,
    base: workspace.base,
  };
}

/** Removes the worktree and its patch. Safe to call twice. */
export async function discardWorkspace(
  repoRoot: string,
  worktree: string | undefined,
  patchPath: string | undefined,
): Promise<void> {
  if (worktree) {
    try {
      await git(["worktree", "remove", "--force", worktree], repoRoot);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
      try {
        await git(["worktree", "prune"], repoRoot);
      } catch {
        /* best effort */
      }
    }
  }
  if (patchPath)
    rmSync(join(patchPath, ".."), { recursive: true, force: true });
}

/**
 * Applies the recorded patch to the operator's working tree (not the index).
 * Checks first: on conflict nothing is written and the worktree is kept.
 */
export async function applyChanges(
  repoRoot: string,
  patchPath: string,
): Promise<void> {
  const patch = readFileSync(patchPath, "utf8");
  await git(["apply", "--check", "--whitespace=nowarn", "-"], repoRoot, patch);
  await git(["apply", "--whitespace=nowarn", "-"], repoRoot, patch);
}
