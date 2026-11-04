import { configOptionSchema, modelSessionSchema } from "./acp-schema.ts";

export interface ModelSelection {
  model?: string;
  thinking?: string;
}
export interface ModelState {
  model?: string;
  thinking?: string;
  availableModels: { id: string; name: string }[];
  availableThinking: string[];
}

export function validateSelection(
  selection: ModelSelection = {},
): ModelSelection {
  for (const [key, value] of Object.entries(selection)) {
    if (
      !["model", "thinking"].includes(key) ||
      typeof value !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value)
    )
      throw new Error("Invalid model selection");
  }
  return { ...selection };
}

function values(input: unknown, depth = 0): { id: string; name: string }[] {
  if (depth > 16) throw new Error("ACP option nesting limit exceeded");
  const parsed = configOptionSchema.safeParse(input);
  if (!parsed.success || !parsed.data.options) return [];
  return parsed.data.options
    .slice(0, 128)
    .flatMap((input) => {
      const parsed = configOptionSchema.safeParse(input);
      if (!parsed.success) return [];
      const item = parsed.data;
      if (item.options) return values(item, depth + 1);
      return typeof item.value === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(item.value)
        ? [
            {
              id: item.value,
              name:
                typeof item.name === "string"
                  ? item.name.slice(0, 160)
                  : item.value,
            },
          ]
        : [];
    })
    .slice(0, 128);
}

/** ACP 1.4 separates model and thought_level; no guessed legacy suffixes or fallback. */
export async function selectAcpModel(
  input: unknown,
  selection: ModelSelection,
  request: (method: string, params: unknown) => Promise<unknown>,
  sessionId: string,
): Promise<ModelState> {
  const session = modelSessionSchema.parse(input);
  let config = session.configOptions ?? [];
  const option = (category: string) =>
    config.find(
      (item) =>
        item.type === "select" &&
        (item.category === category || item.id === category),
    );
  const models = values(option("model"));
  if (!models.length && Array.isArray(session?.models?.availableModels)) {
    for (const item of session.models.availableModels.slice(0, 128)) {
      if (
        typeof item.modelId === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(item.modelId)
      )
        models.push({
          id: item.modelId,
          name: String(item.name ?? item.modelId).slice(0, 160),
        });
    }
  }
  let model = option("model")?.currentValue ?? session?.models?.currentModelId;
  if (selection.model) {
    if (!models.some((item) => item.id === selection.model))
      throw new Error(
        "Requested Antigravity model is unavailable; no fallback was used",
      );
    const modelOption = option("model");
    const response = modelSessionSchema.parse(
      modelOption
        ? await request("session/set_config_option", {
            sessionId,
            configId: modelOption.id,
            value: selection.model,
          })
        : await request("session/set_model", {
            sessionId,
            modelId: selection.model,
          }),
    );
    if (Array.isArray(response?.configOptions)) config = response.configOptions;
    if (modelOption && option("model")?.currentValue !== selection.model)
      throw new Error("Antigravity did not confirm the requested model");
    model = selection.model;
  }
  let thinking = option("thought_level")?.currentValue;
  let availableThinking = values(option("thought_level")).map(
    (item) => item.id,
  );
  if (selection.thinking) {
    const setting = option("thought_level");
    if (
      !availableThinking.includes(selection.thinking) ||
      typeof setting?.id !== "string"
    )
      throw new Error(
        "Requested Antigravity thinking level is unavailable; no fallback was used",
      );
    const response = modelSessionSchema.parse(
      await request("session/set_config_option", {
        sessionId,
        configId: setting.id,
        value: selection.thinking,
      }),
    );
    if (!Array.isArray(response?.configOptions))
      throw new Error("Antigravity did not confirm thinking configuration");
    config = response.configOptions;
    const confirmed = option("thought_level");
    if (confirmed?.currentValue !== selection.thinking)
      throw new Error("Antigravity confirmed a different thinking level");
    thinking = confirmed.currentValue;
    availableThinking = values(confirmed).map((item) => item.id);
  }
  return {
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof thinking === "string" ? { thinking } : {}),
    availableModels: models,
    availableThinking,
  };
}
