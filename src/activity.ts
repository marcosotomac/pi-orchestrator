/**
 * Short, untrusted "what the runtime is doing" targets: a path becomes its last
 * name and a command its first words, so activity never carries long absolute
 * paths. The core still redacts credentials and bounds the whole line.
 */
export function pathTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const clean = value.replace(/^file:\/\//, "").replace(/[/\\]+$/, "");
  return clean.split(/[/\\]/).pop()?.slice(0, 60) || undefined;
}

export function commandTarget(value: unknown): string | undefined {
  const text = Array.isArray(value) ? value.join(" ") : value;
  if (typeof text !== "string" || !text.trim()) return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 50 ? `${line.slice(0, 49)}…` : line;
}

/** "engine: action · target" (target optional); presentation translates the action. */
export function activityText(
  engine: string,
  action: string,
  target?: string,
): string {
  return target ? `${engine}: ${action} · ${target}` : `${engine}: ${action}`;
}
