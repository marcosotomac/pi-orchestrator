import { RuntimeCleanupError } from "./types.ts";

export type FailureCategory = "authentication" | "network" | "quota" | "transient" | "protocol" | "cleanup" | "unknown";
/** automaticRetry: whether the core may retry once (transient/network, read-only, no children). */
export interface FailureDiagnostic { category: FailureCategory; recovery: string; automaticRetry: boolean }

export class RuntimeRequestError extends Error {
  constructor(readonly category: FailureCategory) { super(`Runtime request failed (${category}); inspect private runtime evidence`); }
}

/** External details may guide advice but are never reflected in the public error. */
export function runtimeRequestError(payload: unknown): RuntimeRequestError {
  let diagnostic = diagnoseFailure(undefined);
  if (payload && typeof payload === "object") {
    const value = payload as { message?: unknown; code?: unknown };
    if (typeof value.message === "string") diagnostic = diagnoseFailure(new Error(value.message.slice(0, 8192)));
    if (value.code === 401 || value.code === 403) diagnostic = { ...diagnostic, category: "authentication" };
    if (value.code === 429) diagnostic = { ...diagnostic, category: "quota" };
  }
  return new RuntimeRequestError(diagnostic.category);
}

/** Advisory classification only; never grants authority or retries work. No external text is returned. */
export function diagnoseFailure(error: unknown): FailureDiagnostic {
  let message = "", code = "";
  try {
    if (error instanceof Error) {
      message = error.message.toLowerCase();
      const value = (error as NodeJS.ErrnoException).code;
      if (typeof value === "string") code = value;
    }
  } catch { /* Hostile objects are unknown. */ }
  let category: FailureCategory = "unknown";
  if (error instanceof RuntimeRequestError) category = error.category;
  else if (error instanceof RuntimeCleanupError) category = "cleanup";
  else if (/authentication failed|authentication required|oauth|unauthorized|invalid.api.key/.test(message)) category = "authentication";
  // Provider-side, short-lived (measured: Codex "Selected model is at capacity").
  else if (/at capacity|overloaded|temporarily unavailable|service unavailable|server error|\b(502|503|504|529)\b|try again later/.test(message)) category = "transient";
  else if (/quota|rate.limit|resource.exhausted|insufficient.credit/.test(message)) category = "quota";
  else if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code) || /network|fetch failed/.test(message)) category = "network";
  else if (/protocol|json|unexpected|different turn|does not belong|invalid result|duplicate|malformed|returned no/.test(message)) category = "protocol";
  const recovery = {
    authentication: "Authenticate separately with the selected runtime; do not import another runtime's credentials.",
    network: "Check connectivity. Inspect task and descendants before explicitly starting new work; duplicate execution is possible.",
    quota: "Check the runtime account quota or wait for its limit to reset; do not retry automatically or switch accounts silently.",
    transient: "The provider was temporarily unavailable. A read-only task without children is retried once automatically; otherwise retry explicitly later.",
    protocol: "Stop using this runtime version until compatibility is checked. Preserve private evidence; do not relax validation.",
    cleanup: "Cleanup is unconfirmed. Do not acknowledge cancellation or reuse this session; inspect owned live controls manually.",
    unknown: "Inspect private evidence and current task state before any explicit retry; no automatic recovery is safe.",
  }[category];
  return { category, recovery, automaticRetry: category === "transient" || category === "network" };
}
