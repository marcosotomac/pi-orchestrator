import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { TaskDashboard } from "../src/dashboard.ts";
import {
  resolveTask,
  safeText,
  summary,
  taskRows,
} from "../src/presentation.ts";
import type { TaskView } from "../src/types.ts";

const task = (id: string, parentId: string | null = null): TaskView => ({
  id,
  parentId,
  attemptId: `attempt-${id}`,
  engine: parentId ? "claude" : "codex",
  depth: parentId ? 2 : 1,
  title: "Revisión 界 👩‍💻",
  state: "running",
  cwd: "/tmp",
  createdAt: new Date().toISOString(),
});
function setup(
  cancel: (id: string) => Promise<TaskView> = async (id) => ({
    ...task(id),
    state: "cancelled",
    endedAt: new Date().toISOString(),
  }),
) {
  let tasks = [task("parent-123"), task("child-1234", "parent-123")];
  let rows = 30;
  let done = 0,
    renders = 0;
  const listeners = new Set<() => void>();
  const panel = new TaskDashboard({
    tasks: () => tasks,
    rows: () => rows,
    cancel,
    keybindings: getKeybindings(),
    theme: { fg: (_color, text) => text, bold: (text) => text },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestRender: () => {
      renders++;
    },
    done: () => {
      done++;
    },
  });
  return {
    panel,
    listeners,
    get done() {
      return done;
    },
    get renders() {
      return renders;
    },
    setTasks(next: TaskView[]) {
      tasks = next;
      for (const listener of listeners) listener();
    },
    resize(next: number) {
      rows = next;
    },
  };
}

test("preorder follows parent identities, prefix resolution rejects ambiguous/short IDs, terminal escapes stripped", () => {
  const parent = task("abcdefgh-parent"),
    child = task("child-1234", parent.id),
    sibling = task("abcdefgh-other");
  assert.deepEqual(
    taskRows([child, parent, sibling]).map((row) => row.task.id),
    [parent.id, child.id, sibling.id],
  );
  assert.equal(resolveTask([parent, child], "child-12").id, child.id);
  assert.throws(() => resolveTask([parent, sibling], "abcdefgh"), /ambiguo/);
  assert.throws(() => resolveTask([parent], "abc"), /desconocida/);
  assert.equal(
    safeText("\x1b[31mred\x1b[0m\x1b]52;c;secret\x07\x00\r\n界"),
    "red\n界",
  );
  assert.equal(
    summary([
      { ...parent, state: "cancelling" },
      { ...child, state: "cancelled" },
    ]),
    "1 cancelando · 1 cancelada",
    "only non-zero counts are shown",
  );
});

test("panel fits narrow/wide widths and short heights, even with provider control sequences", () => {
  const state = setup();
  try {
    state.setTasks([
      {
        ...task("parent-123"),
        runtimeSessionId: "\x1b]52;c;secret\x07x",
        result: "界".repeat(200),
      },
    ]);
    for (const height of [8, 12, 22, 40])
      for (const width of [1, 12, 30, 100]) {
        state.resize(height);
        const lines = state.panel.render(width);
        assert.ok(lines.length <= height);
        for (const line of lines)
          assert.ok(visibleWidth(line) <= width, `width=${width}: ${line}`);
        assert.ok(
          !lines.join("").includes("\x1b]52"),
          "provider OSC must not reach the terminal (Pi's own ANSI styling is allowed)",
        );
        assert.ok(!lines.join("").includes("secret"));
      }
  } finally {
    state.panel.dispose();
  }
});

test("cancel requires explicit confirmation, Esc first rejects confirmation then closes without cancelling", () => {
  const calls: string[] = [];
  const state = setup(async (id) => {
    calls.push(id);
    return {
      ...task(id),
      state: "cancelled",
      endedAt: new Date().toISOString(),
    };
  });
  state.panel.handleInput("c");
  assert.match(
    state.panel.render(100).join("\n"),
    /esta tarea y su subtarea\? y sí/,
    'plain wording: the task and its subtasks, no "tree"',
  );
  assert.deepEqual(calls, []);
  state.panel.handleInput("\x1b");
  assert.equal(state.done, 0);
  state.panel.handleInput("\x1b");
  assert.equal(state.done, 1);
  assert.equal(state.listeners.size, 0);
  assert.deepEqual(calls, []);
});

test("selection survives updates, child cancellation is scoped, only one stop is sent until cleanup finishes", async () => {
  let release!: () => void;
  const calls: string[] = [];
  const state = setup(async (id) => {
    calls.push(id);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      ...task(id, "parent-123"),
      state: "cancelled",
      endedAt: new Date().toISOString(),
    };
  });
  try {
    state.panel.handleInput("\x1b[B");
    state.setTasks([
      task("parent-123"),
      { ...task("child-1234", "parent-123"), lastActivity: "Read" },
    ]);
    state.panel.handleInput("c");
    state.panel.handleInput("y");
    assert.deepEqual(calls, ["child-1234"]);
    assert.match(
      state.panel.render(100).join("\n"),
      /esperando a que se cierren sus procesos/,
    );
    state.panel.handleInput("c");
    state.panel.handleInput("y");
    assert.equal(calls.length, 1);
    release();
    await tick();
    assert.match(state.panel.render(100).join("\n"), /Cancelación finalizada/);
  } finally {
    state.panel.dispose();
  }
});

test("a task that settles during confirmation is not cancelled; async errors are visible; disposal stops updates", async () => {
  let calls = 0;
  const state = setup(async () => {
    calls++;
    throw new Error("stop failed");
  });
  try {
    state.panel.handleInput("c");
    state.setTasks([{ ...task("parent-123"), state: "completed" }]);
    state.panel.handleInput("y");
    assert.equal(calls, 0);
    state.setTasks([task("parent-123")]);
    state.panel.handleInput("c");
    state.panel.handleInput("y");
    await tick();
    assert.match(state.panel.render(100).join("\n"), /stop failed/);
    state.panel.dispose();
    const before = state.renders;
    state.setTasks([]);
    assert.equal(state.renders, before);
    assert.equal(state.listeners.size, 0);
  } finally {
    state.panel.dispose();
  }
});

for (const returnedState of [
  "failed",
  "completed",
  "running",
  "cancelling",
] as const) {
  test(`a fulfilled cancellation with state ${returnedState} is not displayed as confirmed cleanup`, async () => {
    const state = setup(async (id) => ({ ...task(id), state: returnedState }));
    try {
      state.panel.handleInput("c");
      state.panel.handleInput("y");
      await tick();
      const screen = state.panel.render(100).join("\n");
      assert.match(screen, /Cancelación no confirmada/);
      assert.ok(!screen.includes("runtimes cerrados"));
    } finally {
      state.panel.dispose();
    }
  });
}

test("details and filters are opt-in, preserve selection when possible and do not cancel tasks", () => {
  let cancellations = 0;
  const state = setup(async (id) => {
    cancellations++;
    return { ...task(id), state: "cancelled" };
  });
  try {
    state.setTasks([
      { ...task("ended-123"), state: "completed" },
      task("active-123"),
      { ...task("failed-123"), state: "failed", error: "fixture failure" },
    ]);
    let screen = state.panel.render(160).join("\n");
    // Live work first; finished work (failures included) below it, without IDs.
    const [failedAt, activeAt, endedAt] = ["! codex", "● codex", "✓ codex"].map(
      (marker) => screen.indexOf(marker),
    ) as [number, number, number];
    assert.ok(
      activeAt >= 0 && activeAt < failedAt && activeAt < endedAt,
      "live work is listed before finished work",
    );
    assert.ok(
      !screen
        .split("\n")
        .slice(3, 6)
        .some((line) => line.includes("active-1")),
      "human rows carry no technical IDs",
    );
    assert.ok(!screen.includes("Intento:"));
    state.panel.handleInput("d");
    assert.match(state.panel.render(160).join("\n"), /Intento:/);
    state.panel.handleInput("f");
    screen = state.panel.render(160).join("\n");
    assert.match(screen, /mostrando activas/);
    assert.ok(!screen.includes("failed-1"));
    state.panel.handleInput("f");
    screen = state.panel.render(160).join("\n");
    assert.match(screen, /mostrando fallidas/);
    assert.match(screen, /fixture failure/);
    state.setTasks([task("active-123")]);
    assert.match(
      state.panel.render(160).join("\n"),
      /No hay tareas con este filtro/,
    );
    assert.equal(cancellations, 0);
  } finally {
    state.panel.dispose();
  }
});

test("long results are paginated rather than clipped permanently", () => {
  const state = setup();
  try {
    state.setTasks([
      {
        ...task("parent-123"),
        state: "completed",
        result: Array.from({ length: 70 }, (_, i) => `line-${i}`).join("\n"),
      },
    ]);
    assert.match(state.panel.render(90).join("\n"), /line-0/);
    state.panel.handleInput("\x1b[6~");
    assert.ok(!state.panel.render(90).some((line) => line === "line-0"));
    state.panel.handleInput("\x1b[5~");
    assert.match(state.panel.render(90).join("\n"), /line-0/);
  } finally {
    state.panel.dispose();
  }
});
