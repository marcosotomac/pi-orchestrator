import { compactFileLinks } from "./result-links.ts";

/** Journal/schema bound for a published result. */
export const MAX_RESULT = 20_000;
export const PARTIAL_NOTE =
  "\n\n[Resultado parcial: la tarea no terminó; este es el último texto que el runtime produjo antes de cortarse.]";
export const TRUNCATION_NOTE = `\n\n[Resultado truncado por el orquestador: superaba ${MAX_RESULT} caracteres; se publican los primeros. Pide al runtime un resumen o que escriba el detalle en un archivo.]`;

/**
 * Published result from an already-redacted runtime answer. Links are compacted
 * before truncation: dead worktree links would otherwise consume the result budget.
 * Discarding a long answer throws away every token spent on it, so the full text
 * goes to `save` and the published result points to it.
 */
export function publishedResult(
  redacted: string,
  cwds: (string | undefined)[],
  save: (text: string) => string | undefined,
): string {
  const output = compactFileLinks(redacted, cwds);
  if (output.length <= MAX_RESULT) return output;
  const path = save(output);
  const note = path
    ? `\n\n[Resultado truncado por el orquestador: superaba ${MAX_RESULT} caracteres. Texto completo (${output.length} caracteres) en ${path}]`
    : TRUNCATION_NOTE;
  return output.slice(0, MAX_RESULT - note.length) + note;
}

/** Last streamed text of an attempt that did not complete, marked as partial. */
export function partialResult(
  redacted: string,
  cwds: (string | undefined)[],
): string {
  let partial = compactFileLinks(redacted, cwds);
  if (partial.length > MAX_RESULT - PARTIAL_NOTE.length)
    partial =
      partial.slice(
        0,
        MAX_RESULT - PARTIAL_NOTE.length - TRUNCATION_NOTE.length,
      ) + TRUNCATION_NOTE;
  return partial + PARTIAL_NOTE;
}
