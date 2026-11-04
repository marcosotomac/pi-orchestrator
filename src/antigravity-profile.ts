import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const managedAntigravityDirectory = fileURLToPath(
  new URL("../.runtimes/antigravity/", import.meta.url),
);

/** Read only the non-secret profile settings. Never import IDE/CLI account credentials. */
export function antigravityEnvironment(
  executable: string,
  profile = process.env.PI_ORCHESTRATOR_ANTIGRAVITY_PROFILE ??
    join(managedAntigravityDirectory, "profile"),
): NodeJS.ProcessEnv {
  if (!isAbsolute(profile) || process.platform === "win32")
    throw new Error("Antigravity requires an absolute private POSIX profile");
  const settings = join(profile, "antigravity-acp", "settings.json");
  try {
    for (const path of [profile, join(profile, "antigravity-acp"), settings]) {
      const stat = lstatSync(path);
      if (
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        (path === settings
          ? !stat.isFile() || stat.size > 8192
          : !stat.isDirectory())
      )
        throw new Error();
    }
    if (
      JSON.parse(readFileSync(settings, "utf8")).auth?.type !== "oauth-personal"
    )
      throw new Error();
  } catch {
    throw new Error(
      "Prepare a private Antigravity ACP oauth-personal profile before execution; no credentials were imported",
    );
  }
  const helper = join(dirname(executable), "localharness_external");
  try {
    accessSync(helper, constants.X_OK);
  } catch {
    throw new Error("Matching Antigravity ACP helper is missing");
  }
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:GOOGLE_|GCLOUD_|CLOUDSDK_|GEMINI_|AGY_ACP_)/.test(key) &&
        !["BROWSER", "ANTIGRAVITY_HARNESS_PATH"].includes(key),
    ),
  );
  return {
    ...environment,
    GEMINI_HOME: profile,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    ANTIGRAVITY_HARNESS_PATH: helper,
    BROWSER: "/usr/bin/false",
    PYTHONUNBUFFERED: "1",
  };
}
