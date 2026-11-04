import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeProcess } from "../src/adapters/process.ts";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeProcessInfo } from "../src/types.ts";
import { getEventListeners } from "node:events";
import type { ProcessCensus } from "../src/reconciliation.ts";
import { RuntimeCleanupError } from "../src/types.ts";

for (const [name, source, expected] of [
  ["null", "console.log('null')", /protocol object/],
  ["array", "console.log('[]')", /protocol object/],
  ["scalar", "console.log('42')", /protocol object/],
  [
    "truncated final record",
    "process.stdout.end('{\"private-fixture\":')",
    /JSONL/,
  ],
  [
    "malformed UTF-8",
    "process.stdout.end(Buffer.from([0x7b,0xff,0x7d]))",
    /encoded data|UTF-8/i,
  ],
  [
    "oversized multibyte line",
    "process.stdout.write(JSON.stringify({text:'é'.repeat(530000)})+'\\n')",
    /too large/,
  ],
] as const) {
  test(`JSONL rejects ${name} without reflecting its contents`, async () => {
    const runtime = new RuntimeProcess(
      process.execPath,
      ["-e", source],
      process.cwd(),
      new AbortController().signal,
    );
    try {
      const error = await new Promise<Error>((resolve) => {
        runtime.onFailure = resolve;
      });
      assert.match(error.message, expected);
      assert.ok(!error.message.includes("private-fixture"));
      await runtime.stop();
      assert.equal(runtime.failure, error);
    } finally {
      await runtime.stop();
    }
  });
}

test("JSONL handles split multibyte text, blank lines, and a final record without LF", async () => {
  const source = `const b=Buffer.from('  \\n'+JSON.stringify({text:'🧪á漢'})+'\\n{}');
    const cut=b.indexOf(Buffer.from('🧪'))+1;process.stdout.write(b.subarray(0,cut));
    setTimeout(()=>process.stdout.end(b.subarray(cut)),10);`;
  const controller = new AbortController();
  const runtime = new RuntimeProcess(
    process.execPath,
    ["-e", source],
    process.cwd(),
    controller.signal,
  );
  const messages: Record<string, any>[] = [];
  runtime.onMessage = (message) => {
    messages.push(message);
  };
  try {
    await runtime.closed;
    assert.equal(runtime.failure, undefined);
    assert.deepEqual(messages, [{ text: "🧪á漢" }, {}]);
    assert.equal(
      getEventListeners(controller.signal, "abort").length,
      0,
      "Natural exit releases the abort listener",
    );
  } finally {
    await runtime.stop();
  }
});

test("process observers may throw or mutate their snapshot without losing ownership or corrupting exit identity", async () => {
  const runtime = new RuntimeProcess(
    process.execPath,
    ["-e", "console.log('{}');setInterval(()=>{},1000)"],
    process.cwd(),
    new AbortController().signal,
  );
  const observations: RuntimeProcessInfo[] = [];
  runtime.observe((info) => {
    observations.push({ ...info });
    info.pid = 1;
    throw new Error("observer failure");
  });
  try {
    await new Promise<void>((resolve) => {
      runtime.onMessage = () => resolve();
    });
    const stopping = runtime.stop();
    assert.equal(runtime.stop(), stopping);
    await stopping;
    assert.equal(observations.length, 2);
    assert.ok(observations.every((info) => info.pid === runtime.child.pid));
    assert.ok(observations[1]!.exitedAt);
  } finally {
    await runtime.stop();
  }
});

test("early abort is replayed to late failure handlers and throwing failure observers cannot prevent cleanup", async () => {
  const controller = new AbortController();
  const runtime = new RuntimeProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    process.cwd(),
    controller.signal,
  );
  try {
    const reason = new Error("early fixture abort");
    controller.abort(reason);
    let failure: Error | undefined;
    runtime.onFailure = (error) => {
      failure = error;
      throw new Error("failure observer broke");
    };
    assert.equal(failure, reason);
    await runtime.stop();
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    await runtime.stop();
  }
});

test("spawn failure is retained and pre-aborted signals never spawn", async () => {
  const runtime = new RuntimeProcess(
    "/nonexistent/pi-orchestrator-fixture",
    [],
    process.cwd(),
    new AbortController().signal,
  );
  try {
    await runtime.closed;
    let observed: Error | undefined;
    runtime.onFailure = (error) => {
      observed = error;
    };
    assert.match(observed!.message, /ENOENT/);
    await runtime.stop();
  } finally {
    await runtime.stop();
  }
  const controller = new AbortController();
  controller.abort(new Error("already stopped"));
  assert.throws(
    () =>
      new RuntimeProcess(
        process.execPath,
        [],
        process.cwd(),
        controller.signal,
      ),
    /already stopped/,
  );
});

test("outbound protocol rejects undefined and oversized records before writing them", async () => {
  const runtime = new RuntimeProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    process.cwd(),
    new AbortController().signal,
  );
  try {
    assert.throws(() => runtime.send(undefined), /Invalid runtime request/);
    assert.throws(
      () => runtime.send({ text: "é".repeat(530_000) }),
      /request too large/,
    );
    assert.equal(runtime.failure, undefined);
  } finally {
    await runtime.stop();
  }
});

for (const scenario of [
  "zombie-only",
  "empty-after-exit",
  "live-member",
  "unknown",
  "live-leader",
] as const) {
  test(
    `EPERM is not cleanup evidence: ${scenario}`,
    { skip: process.platform === "win32" },
    async (t) => {
      let pid = 0;
      const census = (): ProcessCensus =>
        scenario === "unknown"
          ? undefined
          : scenario === "empty-after-exit"
            ? []
            : [
                {
                  pid,
                  groupId: pid,
                  state: scenario === "live-leader" ? "S" : "Z",
                },
                ...(scenario === "live-member"
                  ? [{ pid: pid + 1, groupId: pid, state: "S" }]
                  : []),
              ];
      const active = scenario === "live-leader";
      const runtime = new RuntimeProcess(
        process.execPath,
        ["-e", `console.log('{}');${active ? "setInterval(()=>{},1000)" : ""}`],
        process.cwd(),
        new AbortController().signal,
        census,
      );
      pid = runtime.child.pid!;
      let mock: ReturnType<typeof t.mock.method> | undefined;
      let calls = 0;
      try {
        if (active)
          await new Promise<void>((resolve) => {
            runtime.onMessage = () => resolve();
          });
        else await runtime.closed;
        const original = process.kill;
        mock = t.mock.method(
          process,
          "kill",
          (target: number, signal?: string | number) => {
            if (target !== -pid) return original.call(process, target, signal);
            calls++;
            throw Object.assign(new Error("fixture EPERM"), { code: "EPERM" });
          },
        );
        if (scenario === "zombie-only" || scenario === "empty-after-exit") {
          await runtime.stop();
          assert.equal(
            calls,
            1,
            "A quiescent group is retired; it must not receive another numeric signal",
          );
        } else
          await assert.rejects(
            runtime.stop(),
            (error: unknown) =>
              error instanceof RuntimeCleanupError &&
              error.cause instanceof Error &&
              "code" in error.cause &&
              error.cause.code === "EPERM",
          );
      } finally {
        mock?.mock.restore();
        // A denied signal is not success. Clean the still-live fixture only by its owned handle.
        if (
          active &&
          runtime.child.exitCode === null &&
          runtime.child.signalCode === null
        )
          runtime.child.kill("SIGKILL");
        await runtime.closed;
      }
    },
  );
}

test("runtime process parses JSONL and stops the owned process group", async () => {
  const runtime = new RuntimeProcess(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify({ready:true})); setInterval(()=>{},1000)",
    ],
    process.cwd(),
    new AbortController().signal,
  );
  try {
    const message = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        runtime.onMessage = resolve;
        runtime.onFailure = reject;
      },
    );
    assert.equal(message.ready, true);
    await runtime.stop();
    assert.equal((await runtime.closed).signal, "SIGTERM");
    await runtime.stop();
  } finally {
    await runtime.stop();
  }
});

test("abort kills a runtime that ignores SIGTERM and waits for actual close", async () => {
  const controller = new AbortController();
  const runtime = new RuntimeProcess(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{}); console.log('{}'); setInterval(()=>{},1000)",
    ],
    process.cwd(),
    controller.signal,
  );
  try {
    await new Promise<void>((resolve) => {
      runtime.onMessage = () => resolve();
    });
    controller.abort(new Error("cancel"));
    await runtime.stop();
    assert.equal((await runtime.closed).signal, "SIGKILL");
  } finally {
    await runtime.stop();
  }
});

test("observed process identity and actual exit can be correlated without argv", async () => {
  const observations: RuntimeProcessInfo[] = [];
  const runtime = new RuntimeProcess(
    process.execPath,
    ["-e", "console.log('{}'); setInterval(()=>{},1000)"],
    process.cwd(),
    new AbortController().signal,
  );
  runtime.observe((info) => {
    observations.push(info);
  });
  try {
    await new Promise<void>((resolve) => {
      runtime.onMessage = () => resolve();
    });
    await runtime.stop();
    assert.equal(observations.length, 2);
    assert.equal(observations[0]!.pid, runtime.child.pid);
    assert.equal(observations[1]!.signal, "SIGTERM");
    assert.ok(observations[1]!.exitedAt);
    assert.ok(!JSON.stringify(observations).includes("argv"));
  } finally {
    await runtime.stop();
  }
});

test(
  "a grandchild ignoring SIGTERM is killed even when its leader exits first",
  { skip: process.platform === "win32" },
  async () => {
    const grandchildCode =
      "process.on('SIGTERM',()=>{}); console.log(JSON.stringify({grandchild:process.pid})); setInterval(()=>{},1000)";
    const leaderCode = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:['ignore','pipe','ignore']}); child.stdout.pipe(process.stdout); setInterval(()=>{},1000);`;
    const runtime = new RuntimeProcess(
      process.execPath,
      ["-e", leaderCode],
      process.cwd(),
      new AbortController().signal,
    );
    let grandchild = 0;
    try {
      const event = await new Promise<Record<string, any>>(
        (resolve, reject) => {
          runtime.onMessage = resolve;
          runtime.onFailure = reject;
        },
      );
      grandchild = event.grandchild;
      await runtime.stop();
      let live = true;
      for (let i = 0; i < 40; i++) {
        const rows = execFileSync("ps", ["-axo", "pid=,stat="], {
          encoding: "utf8",
        });
        live = rows.split("\n").some((row) => {
          const [pid, status] = row.trim().split(/\s+/);
          return Number(pid) === grandchild && !status?.startsWith("Z");
        });
        if (!live) break;
        await delay(25);
      }
      assert.equal(
        live,
        false,
        "owned grandchild must not be executing after stop resolves",
      );
    } finally {
      await runtime.stop();
    }
  },
);

test("invalid protocol output is rejected and the process is cleaned up", async () => {
  const runtime = new RuntimeProcess(
    process.execPath,
    ["-e", "console.log('not-json'); setInterval(()=>{},1000)"],
    process.cwd(),
    new AbortController().signal,
  );
  try {
    const error = await new Promise<Error>((resolve) => {
      runtime.onFailure = resolve;
    });
    assert.match(error.message, /JSON|Unexpected/);
    await runtime.stop();
  } finally {
    await runtime.stop();
  }
});
