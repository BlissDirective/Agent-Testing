// LLM provider: Claude via the Anthropic SDK, streamed, with tool use.

import Anthropic from "@anthropic-ai/sdk";
import type { ToolRegistry } from "../tools.js";
import type { LlmConversation, LlmProvider } from "./types.js";

type Message = Anthropic.Beta.BetaMessageParam;

const REFUSAL_REPLY = "Sorry, I can't help with that.";
const MAX_TOOL_ROUNDS = 5;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ClaudeOptions {
  model?: string;
  /** Lower effort = faster first words. "low" suits most voice turns. */
  effort?: Effort;
  client?: Anthropic;
}

export class ClaudeProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: Effort;

  constructor(options: ClaudeOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? "claude-opus-5-5";
    this.effort = options.effort ?? "low";
  }

  startConversation(systemPrompt: string): LlmConversation {
    return new ClaudeConversation(this.client, this.model, this.effort, systemPrompt);
  }
}

class ClaudeConversation implements LlmConversation {
  /** Committed history. Only ever appended to. */
  private messages: Message[] = [];
  /** Tool rounds completed during the reply in progress. */
  private inProgress: Message[] = [];

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly effort: Effort,
    private readonly systemPrompt: string,
  ) {}

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  addAssistantMessage(text: string): void {
    this.messages.push({ role: "assistant", content: text });
  }

  commitInterrupted(spokenText: string): void {
    this.messages.push(...this.inProgress);
    this.inProgress = [];
    if (spokenText) this.addAssistantMessage(`${spokenText} —`);
  }

  async *respond({ signal, tools }: { signal: AbortSignal; tools: ToolRegistry }): AsyncIterable<string> {
    this.inProgress = [];
    const toolParams: Anthropic.Beta.BetaTool[] = tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
      eager_input_streaming: true,
    }));

    for (let round = 0; ; round++) {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: 16000,
          output_config: { effort: this.effort },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          cache_control: { type: "ephemeral" },
          system: this.systemPrompt,
          tools: toolParams,
          messages: [...this.messages, ...this.inProgress],
        },
        { signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield event.delta.text;
        }
      }
      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        // Every model in the fallback chain declined. Don't keep the partial turn.
        yield REFUSAL_REPLY;
        this.commit({ role: "assistant", content: REFUSAL_REPLY });
        return;
      }

      const toolUses = message.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
      );
      if (toolUses.length === 0) {
        this.commit({ role: "assistant", content: message.content });
        return;
      }
      // A tool input cut off at max_tokens can still look valid; never run it.
      // Keep only the text, since a tool_use must always get a tool_result.
      if (message.stop_reason === "max_tokens" || round + 1 >= MAX_TOOL_ROUNDS) {
        const spoken = message.content
          .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");
        this.commit({ role: "assistant", content: spoken || "…" });
        return;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const { content, isError } = await tools.run(toolUse.name, toolUse.input);
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content, is_error: isError });
      }
      this.inProgress.push(
        { role: "assistant", content: message.content },
        { role: "user", content: results },
      );
    }
  }

  private commit(final: Message): void {
    this.messages.push(...this.inProgress, final);
    this.inProgress = [];
  }
}
