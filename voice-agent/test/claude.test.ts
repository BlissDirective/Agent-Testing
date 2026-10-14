// Runs ClaudeProvider against a local mock of the Messages API streaming
// endpoint, so the tool loop and request shape are checked without API calls.

import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ClaudeProvider } from "../src/providers/claude.js";
import { builtinTools, ToolRegistry } from "../src/tools.js";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

/** Serialize one assistant message as the SSE events the API streams. */
function sse(blocks: Block[], stopReason: string): string {
  const events: object[] = [
    {
      type: "message_start",
      message: {
        id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const piece of block.text.match(/.{1,6}/gs) ?? []) {
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
      }
    } else {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      events.push({
        type: "content_block_delta", index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  );
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test("streams text, runs tools, and sends the expected request", async () => {
  const requests: { body: any; beta: string | undefined }[] = [];
  const responses = [
    sse([
      { type: "text", text: "Let me check. " },
      { type: "tool_use", id: "toolu_1", name: "get_current_time", input: { timeZone: "UTC" } },
    ], "tool_use"),
    sse([{ type: "text", text: "It's noon in UTC." }], "end_turn"),
  ];
  const server = createServer(async (req, res) => {
    requests.push({ body: await body(req), beta: req.headers["anthropic-beta"] as string | undefined });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(responses.shift());
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;

  try {
    const client = new Anthropic({ apiKey: "test", baseURL: `http://127.0.0.1:${port}` });
    const conversation = new ClaudeProvider({ client }).startConversation("Be brief.");
    conversation.addUserMessage("What time is it?");
    const tools = new ToolRegistry(builtinTools, { endCall: () => {} });

    let text = "";
    for await (const delta of conversation.respond({ signal: new AbortController().signal, tools })) {
      text += delta;
    }
    assert.equal(text, "Let me check. It's noon in UTC.");

    assert.equal(requests.length, 2);
    const first = requests[0]!;
    assert.equal(first.body.model, "claude-opus-5-5");
    assert.equal(first.body.stream, true);
    assert.equal(first.body.fallbacks, "default");
    assert.deepEqual(first.body.output_config, { effort: "low" });
    assert.match(first.beta ?? "", /server-side-fallback-2026-07-01/);
    assert.equal(first.body.tools[0].strict, true);
    assert.equal(first.body.tools[0].eager_input_streaming, true);

    // Second request carries the tool round: assistant tool_use, then the result.
    const messages = requests[1]!.body.messages;
    assert.equal(messages.length, 3);
    assert.equal(messages[1].content[1].type, "tool_use");
    assert.equal(messages[2].content[0].type, "tool_result");
    assert.equal(messages[2].content[0].tool_use_id, "toolu_1");
    assert.equal(messages[2].content[0].is_error, false);

    // The committed history is append-only: a third request includes everything.
    conversation.addUserMessage("Thanks.");
    responses.push(sse([{ type: "text", text: "Anytime." }], "end_turn"));
    for await (const _ of conversation.respond({ signal: new AbortController().signal, tools })) { /* drain */ }
    assert.equal(requests[2]!.body.messages.length, 5);
  } finally {
    server.close();
  }
});

test("an interrupted reply commits only what was heard", async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    requests.push(await body(req));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      res.write(sse([{ type: "text", text: "A very long reply that never finishes" }], "end_turn").split("event: message_delta")[0]);
      return; // leave the stream hanging, as if the model were still talking
    }
    res.end(sse([{ type: "text", text: "Okay." }], "end_turn"));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;

  try {
    const client = new Anthropic({ apiKey: "test", baseURL: `http://127.0.0.1:${port}` });
    const conversation = new ClaudeProvider({ client }).startConversation("Be brief.");
    conversation.addUserMessage("Tell me everything.");
    const tools = new ToolRegistry(builtinTools, { endCall: () => {} });
    const abort = new AbortController();

    await assert.rejects(async () => {
      for await (const delta of conversation.respond({ signal: abort.signal, tools })) {
        if (delta) abort.abort();
      }
    });
    conversation.commitInterrupted("A very long");
    conversation.addUserMessage("Stop.");
    for await (const _ of conversation.respond({ signal: new AbortController().signal, tools })) { /* drain */ }

    const history = requests[1].messages;
    assert.deepEqual(history.map((m: any) => m.role), ["user", "assistant", "user"]);
    assert.equal(history[1].content, "A very long —");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
