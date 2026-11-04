/**
 * Read-only command policy for Antigravity restricted tasks.
 *
 * Measured with Antigravity 1.4.5 (live probe, 2026-11-04): native file reads,
 * listings and searches need no client permission; only `execute` tool calls do,
 * with the shell text in `rawInput.CommandLine`. Every inspection command in a
 * restricted task therefore waited for a human dialog (serialized, one at a time),
 * which is why read-only analysis was being moved to YOLO.
 *
 * This is an allowlist, never a denylist: anything not recognised here falls back
 * to the existing human-permission path. No shell features that could write,
 * substitute or chain arbitrary programs are accepted. It is not a sandbox: an
 * approved command still reads whatever the operator's account can read, as
 * restricted Codex/Claude workers can.
 */
export type CommandVerdict = { ok: true; commands: string[] } | { ok: false; reason: string };

interface Token { text: string; quoted: boolean }

const MAX_COMMAND = 2_000;
/** Redirections that only discard or merge output. */
const SAFE_REDIRECTS = new Set(["2>/dev/null", ">/dev/null", "1>/dev/null", "2>&1", "&>/dev/null"]);

/** Splits into pipeline segments. Rejects substitution, escapes, chaining and file redirection. */
function tokenize(line: string): Token[][] | string {
  if (!line.trim() || line.length > MAX_COMMAND) return "empty or too long";
  if (/[\x00-\x1f\x7f]/.test(line)) return "control character";
  if (/[`$\\]/.test(line)) return "substitution or escape";
  const segments: Token[][] = [[]];
  let current = "", quoted = false, quote: string | undefined, started = false;
  const push = () => {
    if (started) segments.at(-1)!.push({ text: current, quoted });
    current = ""; quoted = false; started = false;
  };
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) quote = undefined; else current += char;
      continue;
    }
    if (char === "'" || char === "\"") { quote = char; quoted = true; started = true; continue; }
    if (char === " " || char === "\t") { push(); continue; }
    if (char === "|") {
      push();
      if (line[index + 1] === "|" || !segments.at(-1)!.length) return "chaining";
      segments.push([]);
      continue;
    }
    current += char; started = true;
  }
  if (quote) return "unbalanced quote";
  push();
  for (const segment of segments) {
    if (!segment.length) return "empty pipeline segment";
    for (let index = segment.length - 1; index >= 0; index--) {
      const token = segment[index]!;
      if (token.quoted) continue;
      if (SAFE_REDIRECTS.has(token.text)) { segment.splice(index, 1); continue; }
      if (/[;&<>(){}!]/.test(token.text)) return "shell operator";
    }
    if (!segment.length) return "empty pipeline segment";
  }
  return segments;
}

const flags = (args: string[]) => args.filter((arg) => arg.startsWith("-"));
const positionals = (args: string[]) => args.filter((arg) => !arg.startsWith("-"));
const any = () => true;
const none = (args: string[]) => args.length === 0;
const onlyFlags = (allowed: string[]) => (args: string[]) => args.every((arg) => allowed.includes(arg));
const versionOnly = (args: string[]) => args.length === 1 && ["--version", "-v", "-V", "version"].includes(args[0]!);
const firstIs = (allowed: string[]) => (args: string[]) => args.length > 0 && allowed.includes(args[0]!);
const noneOf = (blocked: string[]) => (args: string[]) => !args.some((arg) => blocked.some((bad) => arg === bad || arg.startsWith(`${bad}=`)));

const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog", "cat-file", "rev-list", "grep", "count-objects", "for-each-ref", "merge-base", "name-rev", "whatchanged"]);
/** Subcommand options that run programs, open a pager or write files. */
const GIT_BLOCKED = /^(--output|--ext-diff|--textconv|--open-files-in-pager|-O|--exec|--upload-pack|--receive-pack)/;

function git(args: string[]): boolean {
  // Only `-C DIR` and `--no-pager` may precede the subcommand; `-c key=value` (config injection) never matches one.
  let index = 0;
  while (args[index] === "-C" || args[index] === "--no-pager") index += args[index] === "-C" ? 2 : 1;
  const [sub, ...rest] = args.slice(index);
  if (!sub || rest.some((arg) => GIT_BLOCKED.test(arg))) return false;
  if (GIT_READ.has(sub)) return true;
  switch (sub) {
    case "branch": return rest.every((arg) => ["-a", "-r", "-v", "-vv", "--all", "--remotes", "--list", "--show-current", "--merged", "--no-merged", "--no-color"].includes(arg));
    case "remote": return rest.length === 0 || (rest.length === 1 && rest[0] === "-v") || (["show", "get-url"].includes(rest[0]!) && rest.length <= 2);
    case "tag": return rest.length === 0 || ["-l", "--list"].includes(rest[0]!);
    case "config": return ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(rest[0] ?? "") && !rest.some((arg) => /^--(add|unset|replace-all|rename-section|remove-section|edit|file)/.test(arg) || arg === "-e" || arg === "-f");
    case "stash": return ["list", "show"].includes(rest[0] ?? "");
    case "worktree": return rest[0] === "list";
    case "reflog": return rest.length === 0 || rest[0] === "show";
    default: return false;
  }
}

/** Command name → argument check. Programs that can execute others (xargs, env, awk, sed, sh…) are absent on purpose. */
const RULES: Record<string, (args: string[]) => boolean> = {
  ls: any, cat: any, head: any, wc: any, du: any, df: any, stat: any, file: (args) => !args.some((arg) => /^-[a-zA-Z]*C/.test(arg) || arg === "--compile"), pwd: none, which: any, whoami: none, id: any,
  uname: any, sw_vers: any, vm_stat: any, uptime: none, ps: any, lsof: any, basename: any, dirname: any, realpath: any, readlink: any,
  echo: any, grep: any, egrep: any, fgrep: any, cut: any, tr: any, jq: noneOf(["--rawfile", "--slurpfile"]), mdls: any, mdfind: any,
  system_profiler: any, nproc: none, memory_pressure: onlyFlags(["-Q"]), iostat: any, netstat: any,
  tail: noneOf(["-f", "-F", "--follow", "--retry"]),
  date: (args) => !args.some((arg) => arg === "-s" || arg.startsWith("--set")) && positionals(args).every((arg) => arg.startsWith("+")),
  hostname: (args) => positionals(args).length === 0,
  top: (args) => args.includes("-l"),
  sysctl: (args) => !args.some((arg) => arg.includes("=") || arg === "-w"),
  sort: (args) => !args.some((arg) => arg.startsWith("--output") || arg.startsWith("--compress-program") || arg.startsWith("--temporary-directory") || (/^-[a-zA-Z]+$/.test(arg) && /[oT]/.test(arg))),
  uniq: (args) => positionals(args).length <= 1,
  find: noneOf(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]),
  rg: (args) => !args.some((arg) => arg.startsWith("--pre")),
  tree: (args) => !flags(args).some((arg) => arg === "-o" || arg.startsWith("--output")),
  git,
  docker: (args) => ["ps", "images", "info", "version", "inspect", "--version"].includes(args[0] ?? "") ||
    (["system", "volume", "image", "container", "network", "builder"].includes(args[0] ?? "") && ["df", "ls", "inspect"].includes(args[1] ?? "")) ||
    (args[0] === "stats" && args.includes("--no-stream")),
  brew: (args) => ["list", "ls", "info", "outdated", "deps", "leaves", "config", "--prefix", "--cache", "--version", "--cellar"].includes(args[0] ?? "") || (args[0] === "services" && args[1] === "list"),
  npm: (args) => versionOnly(args) || ["ls", "list", "root", "prefix", "outdated", "view", "explain", "why"].includes(args[0] ?? "") || (args[0] === "config" && ["get", "list", "ls"].includes(args[1] ?? "")) || (args[0] === "cache" && args[1] === "ls"),
  pnpm: (args) => versionOnly(args) || ["ls", "list", "root", "outdated", "why"].includes(args[0] ?? "") || (args[0] === "store" && args[1] === "path"),
  diskutil: (args) => ["list", "info"].includes(args[0] ?? "") || (args[0] === "apfs" && args[1] === "list"),
  launchctl: firstIs(["list", "print", "print-disabled"]),
  defaults: (args) => ["read", "read-type", "domains", "find"].includes(args[0] ?? ""),
  pmset: (args) => args[0] === "-g",
  tmutil: firstIs(["listlocalsnapshots", "listbackups", "destinationinfo", "latestbackup"]),
  xcrun: (args) => args[0] === "simctl" && args[1] === "list",
};
for (const name of ["node", "bun", "yarn", "deno", "python", "python3", "java", "go", "rustc", "cargo", "tsc", "ruby", "php", "swift"]) RULES[name] = versionOnly;

/** True only when every pipeline segment is a recognised read-only invocation. */
export function readOnlyCommand(line: unknown): CommandVerdict {
  if (typeof line !== "string") return { ok: false, reason: "no command text" };
  const segments = tokenize(line);
  if (typeof segments === "string") return { ok: false, reason: segments };
  const commands: string[] = [];
  for (const segment of segments) {
    const [head, ...rest] = segment.map((token) => token.text);
    if (!head || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(head) || segment[0]!.quoted) return { ok: false, reason: "command must be a bare program name" };
    const rule = Object.hasOwn(RULES, head) ? RULES[head] : undefined;
    if (!rule) return { ok: false, reason: `not in the read-only allowlist: ${head}` };
    if (!rule(rest)) return { ok: false, reason: `arguments not allowed for ${head}` };
    commands.push(head);
  }
  return { ok: true, commands };
}

/** Default on; PI_ORCHESTRATOR_ANTIGRAVITY_READONLY_AUTO=0 restores a human dialog for every command. */
export function readOnlyAutoApproval(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.PI_ORCHESTRATOR_ANTIGRAVITY_READONLY_AUTO?.trim();
  if (value === undefined || value === "" || value === "1") return true;
  if (value === "0") return false;
  throw new Error("Invalid PI_ORCHESTRATOR_ANTIGRAVITY_READONLY_AUTO (expected 0 or 1)");
}
