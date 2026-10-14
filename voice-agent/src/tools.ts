// Tools the assistant can call mid-conversation. Each tool validates its own
// input, because streamed tool inputs are model output and may be malformed.

import { z } from "zod";

export interface ToolContext {
  /** Hang up once the assistant finishes speaking its current reply. */
  endCall(reason: string): void;
}

export interface ToolDefinition<Input = unknown> {
  name: string;
  description: string;
  /** JSON Schema for the input (sent to the model). */
  inputSchema: Record<string, unknown>;
  /** Runtime validator for the same schema. */
  parse: z.ZodType<Input>;
  run(input: Input, context: ToolContext): Promise<string>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any>>();

  constructor(
    definitions: ToolDefinition<any>[],
    readonly context: ToolContext,
    /** Called before each tool runs, e.g. to report it to the client. */
    private readonly onCall?: (name: string, input: unknown) => void,
  ) {
    for (const definition of definitions) this.tools.set(definition.name, definition);
  }

  list(): ToolDefinition<any>[] {
    return [...this.tools.values()];
  }

  /** Run a tool; errors come back as `{ isError: true }` for the model to see. */
  async run(name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
    this.onCall?.(name, input);
    const tool = this.tools.get(name);
    if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
    const parsed = tool.parse.safeParse(input);
    if (!parsed.success) {
      return { content: `Invalid input: ${parsed.error.message}`, isError: true };
    }
    try {
      return { content: await tool.run(parsed.data, this.context), isError: false };
    } catch (error) {
      return { content: `Tool failed: ${(error as Error).message}`, isError: true };
    }
  }
}

const endCall: ToolDefinition<{ reason: string }> = {
  name: "end_call",
  description:
    "Hang up the call after your current sentence. Use only when the caller is done " +
    "or asks to end the call. Say goodbye before calling this.",
  inputSchema: {
    type: "object",
    properties: { reason: { type: "string", description: "Why the call is ending." } },
    required: ["reason"],
    additionalProperties: false,
  },
  parse: z.object({ reason: z.string() }),
  async run({ reason }, context) {
    context.endCall(reason);
    return "Call will end after you finish speaking.";
  },
};

const getCurrentTime: ToolDefinition<{ timeZone: string }> = {
  name: "get_current_time",
  description: "Get the current date and time in an IANA time zone, e.g. America/New_York.",
  inputSchema: {
    type: "object",
    properties: { timeZone: { type: "string", description: "IANA time zone name." } },
    required: ["timeZone"],
    additionalProperties: false,
  },
  parse: z.object({ timeZone: z.string() }),
  async run({ timeZone }) {
    return new Date().toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "short" });
  },
};

export const builtinTools: ToolDefinition<any>[] = [endCall, getCurrentTime];
