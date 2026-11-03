/**
 * Answer format for Codex and Claude workers (system/developer instructions).
 * Not used for Antigravity: see its adapter. The coordinating model reads each
 * result once and synthesizes from it, so results should be short, lead with
 * the answer and carry checkable evidence. Measured in the fan-out benchmark
 * (scripts/bench-live.ts): see README "Rendimiento medido". Never ask for
 * commands here: that pushed Antigravity into approval-gated command tools
 * (measured: restricted read-only tasks failed waiting for a permission).
 */
export const WORKER_CONTRACT = "Answer format: start with the direct answer. Back every finding with evidence: path:line, or the exact output it comes from. If something could not be verified, end with one line starting 'Not verified:'. Be concise: do not restate the task, add generic advice, or include long code listings unless asked.";
