/**
 * Rewrites `file://` links in runtime answers as `path:line` references.
 *
 * Measured on the stored history (2026-11-04): Antigravity answers carried up to
 * 33 links each, pointing into a YOLO worktree (`/var/…/pi-orch-wt-XXXX/…`) that
 * is deleted when the diff is applied or discarded, so they were dead links, and
 * the coordinating model paid for every character again on each later turn.
 * Paths inside the task's directories become relative; others stay absolute.
 */

const LINE = /^L(\d+)(?:-L?(\d+))?$/;
// Labels may hold one level of brackets (Next.js routes such as `app/[id]/page.tsx`).
const MARKDOWN = /\[((?:[^[\]\n]|\[[^[\]\n]{0,100}\]){0,300})\]\((file:\/\/[^)\s]{1,2048})\)/g;
const BARE = /(?<![(\w])file:\/\/[^\s)\]>"'`]{1,2048}/g;

/** macOS tmpdir paths appear both as /var/… and /private/var/…. */
const canonical = (path: string) => path.replace(/^\/private(?=\/(?:var|tmp)\/)/, "");

function reference(url: string, roots: string[]): string | undefined {
  let path: string, fragment = "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:" || (parsed.host && parsed.host !== "localhost")) return undefined;
    path = canonical(decodeURIComponent(parsed.pathname));
    fragment = decodeURIComponent(parsed.hash.slice(1));
  } catch { return undefined; }
  if (!path.startsWith("/")) return undefined;
  for (const root of roots) {
    if (path === root) { path = "."; break; }
    if (path.startsWith(`${root}/`)) { path = path.slice(root.length + 1); break; }
  }
  const line = LINE.exec(fragment);
  return line ? `${path}:${line[1]}${line[2] && line[2] !== line[1] ? `-${line[2]}` : ""}` : path;
}

export function compactFileLinks(text: string, directories: (string | undefined)[]): string {
  if (!text.includes("file://")) return text;
  // Longest first, so a worktree nested in the task cwd wins.
  const roots = [...new Set(directories.filter((value): value is string => typeof value === "string" && value.startsWith("/")).map((value) => canonical(value.replace(/\/+$/, ""))))].sort((a, b) => b.length - a.length);
  const markdown = text.replace(MARKDOWN, (whole, label: string, url: string) => {
    const ref = reference(url, roots);
    if (!ref) return whole;
    const name = label.trim().replace(/^`+|`+$/g, "");
    const path = ref.replace(/:\d+(?:-\d+)?$/, "");
    // The label usually repeats the path; keep it only when it says something else.
    const redundant = !name || name === ref || name === path || path.endsWith(`/${name}`) || ref.endsWith(`/${name}`) || name.endsWith(path) || name.endsWith(ref);
    return redundant ? `\`${ref}\`` : `${label} (\`${ref}\`)`;
  });
  return markdown.replace(BARE, (url) => reference(url, roots) ?? url);
}
