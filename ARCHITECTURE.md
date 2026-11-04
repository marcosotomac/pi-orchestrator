# Architecture and checks

## Boundaries

- `extension.ts`: Pi lifecycle, result delivery, widgets, renderers and panel UI.
- `extension-tools.ts`: model-facing tool registration, permission confirmations and tool execution. Dependencies are passed explicitly; mutable delivery state stays with the extension.
- `extension-commands.ts`: operator-facing `/orch` routing. Panel rendering and reset are callbacks, not dependencies on UI implementation details.
- `service.ts`: composition root for the coordinator, adapters, MCP bridge and optional journal.
- `orchestrator.ts`: admission, authority, scheduling and execution lifecycle.
- `task-state.ts`: allowed task transitions. Terminal states cannot reopen. The sole explicit correction is completed → failed when the final checkpoint fails.
- `task-usage.ts`: provider counter validation, continuation deltas and retry accumulation. These are pure functions; the coordinator owns when updates are accepted.
- `adapters/*`: engine-specific protocols and process supervision.
- `acp-schema.ts`: runtime validation of unknown ACP payloads. Schemas permit extension fields but validate fields used for permissions, identity and output.
- `model-selection.ts`: bounded ACP model/effort option parsing and confirmation, without fallback.

Initial task creation chooses queued or running; all later task-state writes go through `transitionTask`. Workspace-change states are a separate concept.

## Offline checks (no provider credentials or quota)

```sh
npm ci
npm run verify:offline
```

This checks TypeScript, Prettier, process-fixture/unit tests and the Python installer tests. GitHub Actions runs it on Linux and macOS with Node 22 and Python 3.12. Installer tests use local archives; they do not install or authenticate Antigravity.

```sh
npm run test:tui
```

Local PTY tests exercise the UI with fixtures, also without provider quota. `npm run verify` includes these tests.

## Live checks (manual, consume quota)

`smoke:live`, `smoke:cancel`, `smoke:cases`, `smoke:antigravity`, `smoke:antigravity-nested`, `bench:live`, `verify:live` and other live scripts contact real providers. They are deliberately excluded from automatic CI. Obtain operator approval for engines, models and budget before running them. Some scripts additionally require their own environment opt-in; that does not replace approval.

No provider secrets are needed or configured for CI. Do not add live jobs to pull-request workflows or use `pull_request_target` to execute untrusted changes.

## Formatting

`npm run format` formats TypeScript source, tests, scripts, workflow YAML and package/config JSON. `npm run format:check` checks the same scope. Runtime data, artifacts, Python and the local untracked comparison benchmark are excluded. Keep Python changes separately reviewed rather than rewriting them with a TypeScript formatter.
