import { performance } from "node:perf_hooks";

/** Sum of occupied runtime-slot milliseconds, not provider billing or CPU time. */
export class RuntimeBudget {
  private used = 0;
  private active = 0;
  private sampledAt = performance.now();
  private timer?: NodeJS.Timeout;
  private exhausted = false;
  constructor(readonly maxRuntimeMs: number | undefined, private readonly onExhausted: () => void) {
    if (maxRuntimeMs !== undefined && (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 1 || maxRuntimeMs > 2_147_483_647)) throw new Error("Invalid aggregate runtime budget");
  }
  view() {
    const runtimeMs = this.used + (performance.now() - this.sampledAt) * this.active;
    return { runtimeMs, maxRuntimeMs: this.maxRuntimeMs, exhausted: this.exhausted || (this.maxRuntimeMs !== undefined && runtimeMs >= this.maxRuntimeMs), activeSlots: this.active, monetaryCost: "unavailable" as const };
  }
  assertAvailable(): void {
    if (this.view().exhausted) { this.expire(); throw new Error("Aggregate runtime budget exhausted"); }
  }
  setActive(active: number): void {
    if (!Number.isSafeInteger(active) || active < 0) throw new Error("Invalid active slot count");
    const now = performance.now();
    this.used += (now - this.sampledAt) * this.active;
    this.sampledAt = now; this.active = active;
    clearTimeout(this.timer); this.timer = undefined;
    if (this.maxRuntimeMs === undefined || this.exhausted || active === 0) return;
    const remaining = this.maxRuntimeMs - this.used;
    if (remaining <= 0) { this.expire(); return; }
    this.timer = setTimeout(() => { this.timer = undefined; if (this.view().exhausted) this.expire(); else this.setActive(this.active); },  Math.max(1, Math.ceil(remaining / active)));
  }
  private expire(): void {
    if (this.exhausted) return;
    this.exhausted = true; clearTimeout(this.timer); this.timer = undefined;
    this.onExhausted();
  }
}
