import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { errorText, RuntimeCleanupError, type RuntimeProcessInfo } from "../types.ts";
import { processCensus, type ProcessCensus } from "../reconciliation.ts";

const maxLineBytes = 1_048_576;

/** Owns an isolated process group; never interprets a command through a shell. */
export class RuntimeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<{ code: number | null; signal: string | null }>;
  stderr = "";
  private buffer = "";
  private stopped?: Promise<void>;
  private onAbort: () => void;
  private protocolFailure?: Error;
  private groupRetired = false;
  private failureHandler: (error: Error) => void = () => {};
  onMessage: (message: Record<string, any>) => void = () => {};

  get failure(): Error | undefined { return this.protocolFailure; }
  set onFailure(handler: (error: Error) => void) {
    this.failureHandler = handler;
    // Abort/spawn failures can precede installation of the protocol callbacks.
    if (this.protocolFailure) this.notifyFailure(this.protocolFailure);
  }

  constructor(command: string, args: string[], cwd: string, private signal: AbortSignal, private readonly census: () => ProcessCensus = processCensus, environment?: NodeJS.ProcessEnv) {
    signal.throwIfAborted();
    this.child = spawn(command, args, { cwd, stdio: "pipe", detached: process.platform !== "win32", shell: false, env: environment });
    this.closed = new Promise((resolve) => {
      this.child.once("close", (code, exitSignal) => {
        signal.removeEventListener("abort", this.onAbort);
        resolve({ code, signal: exitSignal });
      });
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-16_000); });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.protocolFailure) return;
      try { this.consume(decoder.decode(chunk, { stream: true })); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(errorText(error))); }
    });
    this.child.stdout.on("end", () => {
      if (this.protocolFailure) return;
      try {
        this.consume(decoder.decode());
        // JSONL producers need not terminate their last complete record with LF.
        const tail = this.buffer;
        this.buffer = "";
        this.deliver(tail);
      } catch (error) { this.fail(error instanceof Error ? error : new Error(errorText(error))); }
    });
    this.onAbort = () => this.fail(signal.reason instanceof Error ? signal.reason : new Error("Runtime aborted"));
    signal.addEventListener("abort", this.onAbort, { once: true });
  }

  private consume(text: string): void {
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.deliver(line);
      if (this.protocolFailure) return;
    }
    if (Buffer.byteLength(this.buffer) > maxLineBytes) throw new Error("Runtime protocol buffer too large");
  }

  private deliver(line: string): void {
    if (Buffer.byteLength(line) > maxLineBytes) throw new Error("Runtime protocol line too large");
    if (!line.trim()) return;
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { throw new Error("Invalid runtime JSONL protocol"); } // Never echo the offending record.
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid protocol object");
    this.onMessage(message as Record<string, any>);
  }

  private notifyFailure(error: Error): void {
    try { this.failureHandler(error); } catch { /* A faulty observer cannot prevent process cleanup. */ }
  }

  private fail(error: Error): void {
    if (this.protocolFailure) return;
    this.protocolFailure = error;
    this.buffer = "";
    this.notifyFailure(error);
    // The adapter also awaits stop(); this handler must never create an unhandled rejection.
    void this.stop().catch(() => {});
  }

  /** Report only owned process identity and exit, never argv or credentials. */
  observe(observer?: (info: RuntimeProcessInfo) => void): void {
    const pid = this.child.pid;
    if (!observer || !pid) return;
    const info = { pid, ...(process.platform !== "win32" ? { groupId: pid } : {}) };
    const notify = (value: RuntimeProcessInfo) => {
      try { observer(value); } catch { /* Observability must not alter runtime ownership. */ }
    };
    notify({ ...info });
    void this.closed.then(({ code, signal }) => notify({ ...info, code, signal, exitedAt: new Date().toISOString() }));
  }

  send(message: unknown): void {
    if (this.protocolFailure) throw this.protocolFailure;
    if (this.child.stdin.destroyed) throw new Error("Runtime stdin is closed");
    const text = JSON.stringify(message);
    if (text === undefined) throw new Error("Invalid runtime request");
    if (Buffer.byteLength(text) > maxLineBytes) throw new Error("Runtime request too large");
    this.child.stdin.write(text + "\n");
  }

  private kill(signal: NodeJS.Signals): void {
    if (this.groupRetired) return;
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const exited = this.child.exitCode !== null || this.child.signalCode !== null;
      if (code === "ESRCH") {
        if (exited) this.groupRetired = true;
        return;
      }
      // Darwin can return EPERM for a zombie-only group. Never treat EPERM alone
      // (or just the leader's exit) as cleanup. The census is diagnostic only;
      // it grants no authority and cannot cause signals to another process.
      if (code === "EPERM" && process.platform !== "win32" && this.child.pid) {
        const rows = this.census();
        const leader = rows?.find((row) => row.pid === this.child.pid);
        if (rows && (exited || (leader?.groupId === this.child.pid && leader.state.startsWith("Z"))) &&
            !rows.some((row) => row.groupId === this.child.pid && !row.state.startsWith("Z"))) {
          this.groupRetired = true; // No later signals to a numerically reused group.
          return;
        }
      }
      throw error;
    }
  }

  stop(): Promise<void> {
    return this.stopped ??= this.stopOnce().catch((error: unknown) => { throw new RuntimeCleanupError(error); });
  }

  private async stopOnce(): Promise<void> {
    this.signal.removeEventListener("abort", this.onAbort);
    this.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); })]);
    } finally { clearTimeout(timer); }
    // Also kill remaining grandchildren when the group leader has already exited.
    this.kill("SIGKILL");
    await this.closed;
  }
}
