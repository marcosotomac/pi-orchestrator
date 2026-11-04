import { randomUUID } from "node:crypto";

export interface InteractionRequest {
  kind: "permission" | "question";
  title: string;
  detail: string;
  options: { id: string; label: string }[];
}
export type InteractionAnswer = { optionId: string } | undefined;
export interface InteractionView extends InteractionRequest {
  id: string;
  taskId: string;
  engine: string;
}
export type InteractionHandler = (
  request: InteractionView,
  signal: AbortSignal,
) => Promise<InteractionAnswer>;

/** One human dialog at a time, bounded admission and deadlines measured from enqueue. */
export class InteractionBroker {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private tasks = new Map<string, Set<AbortController>>();
  cancelTask(taskId: string): void {
    for (const controller of this.tasks.get(taskId) ?? []) controller.abort();
  }
  constructor(
    private readonly handler?: InteractionHandler,
    private readonly timeoutMs = 60_000,
    private readonly maxPending = 16,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxPending) ||
      maxPending < 1
    )
      throw new Error("Invalid interaction limits");
  }
  async request(
    taskId: string,
    engine: string,
    request: InteractionRequest,
    signal: AbortSignal,
  ): Promise<InteractionAnswer> {
    if (!this.handler || signal.aborted || this.pending >= this.maxPending)
      return undefined;
    if (
      !["permission", "question"].includes(request.kind) ||
      typeof request.title !== "string" ||
      request.title.length > 300 ||
      typeof request.detail !== "string" ||
      request.detail.length > 8000 ||
      !Array.isArray(request.options) ||
      request.options.length < 1 ||
      request.options.length > 16 ||
      request.options.some(
        (option) =>
          typeof option.id !== "string" ||
          !option.id ||
          option.id.length > 256 ||
          typeof option.label !== "string" ||
          option.label.length > 300,
      ) ||
      new Set(request.options.map((option) => option.id)).size !==
        request.options.length
    )
      return undefined;
    this.pending++;
    const controller = new AbortController();
    const controllers = this.tasks.get(taskId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.tasks.set(taskId, controllers);
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let release!: () => void;
    const gate = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish!: (answer: InteractionAnswer) => void;
    const answer = new Promise<InteractionAnswer>((resolve) => {
      finish = resolve;
    });
    const allowed = new Set(request.options.map((option) => option.id));
    void gate
      .then(() => answer)
      .then(() => {
        this.pending--;
        release();
      });
    const stop = () => finish(undefined);
    controller.signal.addEventListener("abort", stop, { once: true });
    const view: InteractionView = {
      ...request,
      options: request.options.map((option) => ({ ...option })),
      id: randomUUID(),
      taskId,
      engine,
    };
    void gate.then(async () => {
      if (controller.signal.aborted) return;
      try {
        const result = await this.handler!(view, controller.signal);
        if (!controller.signal.aborted)
          finish(
            result && allowed.has(result.optionId)
              ? { optionId: result.optionId }
              : undefined,
          );
      } catch {
        finish(undefined);
      }
    });
    try {
      return await answer;
    } finally {
      clearTimeout(timer);
      controller.abort();
      controllers.delete(controller);
      if (controllers.size === 0) this.tasks.delete(taskId);
      signal.removeEventListener("abort", onAbort);
      controller.signal.removeEventListener("abort", stop);
    }
  }
}
