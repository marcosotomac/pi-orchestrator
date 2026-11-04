import type { Engine } from "./types.ts";

/** FIFO within each engine; round-robin across nonempty engines. Not multi-tenant fairness. */
export class FairQueue {
  private readonly engines: Engine[] = ["codex", "claude", "antigravity"];
  private lanes = new Map<Engine, string[]>();
  private cursor = 0;
  get size(): number {
    return [...this.lanes.values()].reduce((sum, lane) => sum + lane.length, 0);
  }
  push(engine: Engine, id: string): void {
    const lane = this.lanes.get(engine) ?? [];
    lane.push(id);
    this.lanes.set(engine, lane);
  }
  remove(id: string): void {
    for (const [engine, lane] of this.lanes)
      this.lanes.set(
        engine,
        lane.filter((value) => value !== id),
      );
  }
  shift(): string | undefined {
    for (let offset = 0; offset < this.engines.length; offset++) {
      const index = (this.cursor + offset) % this.engines.length;
      const id = this.lanes.get(this.engines[index]!)?.shift();
      if (id) {
        this.cursor = (index + 1) % this.engines.length;
        return id;
      }
    }
    return undefined;
  }
}
