import { z } from "zod";

const option = z.object({
  optionId: z.string().min(1).max(128),
  kind: z.string(),
  name: z.string().optional(),
});
const toolCall = z
  .object({
    toolCallId: z.string().optional(),
    title: z.string().optional(),
    kind: z.string().optional(),
    rawInput: z
      .object({ CommandLine: z.unknown().optional() })
      .passthrough()
      .optional(),
    _meta: z
      .object({
        prompt: z.unknown().optional(),
        is_mcp_tool_call: z.boolean().optional(),
        mcp: z
          .object({
            tool: z.string().optional(),
            server: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const permissionSchema = z.object({
  sessionId: z.string(),
  toolCall,
  options: z.array(option).min(1).max(128),
});
export const updateSchema = z.object({
  sessionId: z.string(),
  update: z
    .object({
      sessionUpdate: z.string(),
      content: z
        .object({ type: z.string(), text: z.string().optional() })
        .passthrough()
        .optional(),
      kind: z.string().optional(),
      title: z.string().optional(),
      locations: z.array(z.object({ path: z.string().optional() })).optional(),
      rawInput: z
        .object({ CommandLine: z.unknown().optional() })
        .passthrough()
        .optional(),
      used: z.number().optional(),
      size: z.number().optional(),
    })
    .passthrough(),
});
export const initializedSchema = z.object({
  protocolVersion: z.number(),
  agentInfo: z.object({ name: z.string(), version: z.string().optional() }),
  agentCapabilities: z
    .object({
      mcpCapabilities: z.object({ http: z.boolean().optional() }).optional(),
      sessionCapabilities: z
        .object({ resume: z.unknown().optional() })
        .optional(),
    })
    .passthrough()
    .optional(),
});
export const sessionSchema = z
  .object({
    sessionId: z.string().optional(),
    modes: z
      .object({ availableModes: z.array(z.object({ id: z.string() })) })
      .optional(),
  })
  .passthrough();
export const promptResultSchema = z.object({ stopReason: z.string() });

export const configOptionSchema = z
  .object({
    type: z.string().optional(),
    category: z.string().optional(),
    id: z.string().optional(),
    currentValue: z.unknown().optional(),
    options: z.array(z.unknown()).optional(),
  })
  .passthrough();
export const modelSessionSchema = z
  .object({
    configOptions: z.array(configOptionSchema).optional(),
    models: z
      .object({
        currentModelId: z.unknown().optional(),
        availableModels: z
          .array(
            z.object({
              modelId: z.unknown().optional(),
              name: z.unknown().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  })
  .passthrough();
