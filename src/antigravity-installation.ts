import { accessSync, constants, statSync } from "node:fs";
import { managedAntigravityDirectory } from "./antigravity-profile.ts";
import { delimiter, isAbsolute, join } from "node:path";

/** Filesystem-only discovery. Never invokes agy, authenticates, downloads or creates state. */
export function detectAntigravity(
  env: NodeJS.ProcessEnv = process.env,
  managedDirectory = managedAntigravityDirectory,
): { executable?: string; enabled: boolean; status: string } {
  const configured = env.PI_ORCHESTRATOR_ANTIGRAVITY_ACP;
  const names =
    process.platform === "win32"
      ? ["agy_acp_server.exe"]
      : ["agy_acp_server.par"];
  const paths = configured
    ? [configured]
    : [
        join(managedDirectory, "1.4.5", names[0]!),
        ...(env.PATH ?? "")
          .split(delimiter)
          .filter(isAbsolute)
          .flatMap((directory) => names.map((name) => join(directory, name))),
      ];
  const executable = paths.find((path) => {
    if (!isAbsolute(path)) return false;
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
  // Operator-authorized default: available without a launcher flag. An explicit
  // disable (or an unrecognized value) still fails closed.
  const enabled =
    env.PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL === undefined ||
    env.PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL === "1";
  return {
    executable,
    enabled,
    status: !executable
      ? "ACP runtime not found; agy CLI/IDE cannot substitute for it"
      : !enabled
        ? "ACP executable found; experimental execution disabled"
        : "Experimental ACP configured; authentication, helper, HTTP MCP and approval mode still require runtime validation",
  };
}
