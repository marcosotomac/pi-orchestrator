import { createService } from "../../src/service.ts";
import { RuntimeProcess } from "../../src/adapters/process.ts";
import { capabilities, type RuntimeAdapter } from "../../src/types.ts";

// No Codex/Claude invocation. The harness retains independent live IPC ownership evidence.
const adapter: RuntimeAdapter = {
  capabilities,
  async run(ctx) {
    const runtime = new RuntimeProcess(
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000)",
      ],
      ctx.task.cwd,
      ctx.signal,
    );
    process.send?.({
      type: "owned-process",
      pid: runtime.child.pid,
      groupId: runtime.child.pid,
    });
    const pending = new Promise<string>((_resolve, reject) => {
      runtime.onFailure = reject;
      runtime.onMessage = () => {
        ctx.session("crash-fixture-native-session");
        ctx.activity("simulated tool active");
        process.send?.({
          type: "ready",
          runId: service.journal!.runId,
          taskId: ctx.task.id,
        });
      };
      void runtime.closed.then(() => reject(new Error("fixture exited")));
    });
    runtime.observe(ctx.process);
    try {
      return await pending;
    } finally {
      await runtime.stop();
    }
  },
};
const service = await createService(
  { cwd: process.cwd(), stateDirectory: process.argv[2] },
  { codex: adapter, claude: adapter },
);
service.core.delegate(
  null,
  "codex",
  "Node-only crash fixture; never launch an agent",
  "crash-test",
);
