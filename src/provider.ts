/** Provider adapters for pi's before_provider_request hook (pi-ai 0.85.1).
 * These replace declarations, not merely filter the current tool snapshot: pi may
 * have captured that snapshot before forced mode began. Callers must also reject
 * non-collapse tool executions and abort on errors from this function.
 */
export interface CollapseToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

type RecordValue = Record<string, unknown>;
export const SUPPORTED_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
] as const;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`collapse: invalid ${label}; expected an object`);
  }
  return value as RecordValue;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`collapse: invalid ${label}; expected an array`);
  return value;
}

function without(source: RecordValue, keys: string[]): RecordValue {
  const result = { ...source };
  for (const key of keys) delete result[key];
  return result;
}

/** Remove historical deferred declarations too: otherwise they can re-enable tools. */
function responsesInput(input: unknown[]): unknown[] {
  return input.filter((item) => {
    const entry = record(item, "Responses input item");
    return !["additional_tools", "tool_search_call", "tool_search_output"].includes(String(entry.type));
  });
}

function anthropicContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  const blocks = array(content, "Anthropic content").flatMap((block) => {
    const value = record(block, "Anthropic content block");
    // Named tool choice is incompatible with extended thinking. Historical
    // tool references are only valid when the referenced declarations exist.
    if (["thinking", "redacted_thinking", "tool_reference"].includes(String(value.type))) return [];
    if (value.type === "tool_result" && value.content !== undefined) {
      return [{ ...value, content: anthropicContent(value.content) }];
    }
    return [value];
  });
  return blocks.length ? blocks : [{ type: "text", text: "[No retained content]" }];
}

/** Pure: never mutates payload, schema, or tool definition. Throws on unsupported APIs/shapes. */
export function restrictPayload(
  api: string,
  payload: unknown,
  collapseTool: CollapseToolDefinition,
): unknown {
  if (!(SUPPORTED_APIS as readonly string[]).includes(api)) {
    throw new Error(`collapse: forced mode does not support provider API ${JSON.stringify(api)}`);
  }
  if (collapseTool.name !== "collapse" || typeof collapseTool.description !== "string") {
    throw new Error("collapse: expected the collapse tool definition");
  }
  const schema = record(collapseTool.parameters, "collapse parameters");
  if (schema.type !== "object") throw new Error("collapse: parameters must be an object schema");
  const original = record(payload, "provider payload");
  if (typeof original.model !== "string" || !original.model) {
    throw new Error("collapse: provider payload has no model");
  }
  const functionDefinition = {
    name: "collapse",
    description: collapseTool.description,
    parameters: schema,
    strict: false,
  };

  if (api === "openai-completions") {
    array(original.messages, "OpenAI messages");
    return {
      ...without(original, ["functions", "function_call", "response_format"]),
      tools: [{ type: "function", function: functionDefinition }],
      tool_choice: { type: "function", function: { name: "collapse" } },
      parallel_tool_calls: false,
    };
  }

  if (api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses") {
    // A server-managed prior response/conversation could carry unseen tool
    // declarations. pi normally uses complete local history and store:false.
    if (original.previous_response_id || original.conversation) {
      throw new Error("collapse: cannot restrict server-managed Responses history");
    }
    const result = without(original, ["functions", "function_call", "response_format"]);
    if (result.text !== undefined) result.text = without(record(result.text, "Responses text"), ["format"]);
    return {
      ...result,
      input: responsesInput(array(original.input, "Responses input")),
      tools: [{ type: "function", ...functionDefinition }],
      tool_choice: { type: "function", name: "collapse" },
      parallel_tool_calls: false,
    };
  }

  if (api === "anthropic-messages") {
    const result = without(original, ["mcp_servers", "context_management"]);
    if (result.thinking !== undefined) result.thinking = { type: "disabled" };
    if (result.output_config !== undefined) {
      result.output_config = without(record(result.output_config, "Anthropic output_config"), ["effort", "format"]);
      if (!Object.keys(result.output_config as RecordValue).length) delete result.output_config;
    }
    return {
      ...result,
      messages: array(original.messages, "Anthropic messages").map((message) => {
        const value = record(message, "Anthropic message");
        return { ...value, content: anthropicContent(value.content) };
      }),
      tools: [{ name: "collapse", description: collapseTool.description, input_schema: schema }],
      tool_choice: { type: "tool", name: "collapse", disable_parallel_tool_use: true },
    };
  }

  // Both Google APIs pass GenerateContentParameters to onPayload, not the
  // wire JSON body: tools and toolConfig belong under config.
  array(original.contents, "Google contents");
  const config = record(original.config, "Google config");
  if (config.cachedContent) throw new Error("collapse: cannot restrict cached Google content");
  return {
    ...without(original, ["tools", "toolConfig"]),
    config: {
      ...without(config, ["responseMimeType", "responseSchema", "responseJsonSchema", "automaticFunctionCalling"]),
      tools: [{ functionDeclarations: [{
        name: "collapse",
        description: collapseTool.description,
        parametersJsonSchema: schema,
      }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["collapse"] } },
    },
  };
}
