import assert from "node:assert/strict";
import { test } from "node:test";
import { makeConfig } from "../src/config.js";
import { CallSession } from "../src/session.js";
import { FakeLlm, FakeStt, FakeTransport, FakeTts, waitFor, type ScriptedReply } from "./fakes.js";

function setup(replies: ScriptedReply[] = [], options: { firstMessage?: string; ttsMs?: number } = {}) {
  const config = makeConfig({
    firstMessage: options.firstMessage ?? "",
    startSpeakingPlan: { onPunctuationSeconds: 0.02, onNoPunctuationSeconds: 0.1, onNumberSeconds: 0.05, waitSeconds: 0 },
    stopSpeakingPlan: { backoffSeconds: 0 } as never,
  });
  const stt = new FakeStt();
  const llm = new FakeLlm(replies);
  const tts = new FakeTts(options.ttsMs ?? 30);
  const transport = new FakeTransport();
  const session = new CallSession(config, { stt, llm, tts }, transport);
  session.start();
  return { session, stt, conversation: llm.conversation, tts, transport };
}

test("greets the caller, then reports the assistant stopped speaking", async () => {
  const { session, transport, conversation, tts } = setup([], { firstMessage: "Hi there!" });
  assert.equal(transport.messages[0]?.type, "listening");
  await waitFor(() => transport.ofType("speech-update").some((m) => m.status === "stopped"));
  assert.deepEqual(tts.spoken, ["Hi there!"]);
  assert.deepEqual(conversation.history, [
    { role: "user", text: "[The call has connected.]" },
    { role: "assistant", text: "Hi there!" },
  ]);
  session.end("test");
});

test("answers after the user finishes a sentence, sentence by sentence", async () => {
  const { session, stt, transport, tts, conversation } = setup([
    { pieces: [{ text: "It is " }, { text: "noon. Anything " }, { text: "else?" }] },
  ]);
  stt.say("What time", false);
  stt.say("What time is it?");
  await waitFor(() => transport.ofType("speech-update").some((m) => m.status === "stopped"));

  assert.deepEqual(tts.spoken, ["It is noon.", "Anything else?"]);
  assert.equal(transport.ofType("model-output").map((m) => m.output).join(""), "It is noon. Anything else?");
  assert.ok(transport.audioBytes > 0);
  assert.deepEqual(conversation.history.at(0), { role: "user", text: "What time is it?" });
  session.end("test");
});

test("waits longer when the user trails off without punctuation", async () => {
  const { session, stt, transport } = setup();
  stt.say("I was thinking");
  await new Promise((r) => setTimeout(r, 50)); // under onNoPunctuationSeconds (100 ms)
  assert.equal(transport.ofType("model-output").length, 0);
  stt.say("about the weather.");
  await waitFor(() => transport.ofType("model-output").length > 0);
  session.end("test");
});

test("barge-in stops the assistant and keeps what the user said", async () => {
  const { session, stt, transport, conversation } = setup(
    [
      { pieces: [{ text: "Here is a long answer. " }, { text: "Second part.", delayMs: 500 }] },
      { pieces: [{ text: "Sure, stopping." }] },
    ],
    { ttsMs: 400 },
  );
  stt.say("Tell me a story.");
  await waitFor(() => transport.ofType("speech-update").some((m) => m.status === "started"));

  stt.say("yeah"); // acknowledgement: keeps talking
  assert.equal(transport.ofType("user-interrupted").length, 0);

  stt.say("no wait", false);
  assert.equal(transport.ofType("user-interrupted").length, 1);
  assert.equal(conversation.aborted, 0); // abort lands when the LLM next checks
  await waitFor(() => conversation.aborted === 1);
  assert.deepEqual(conversation.interruptedWith, ["Here is a long answer."]);

  stt.say("No wait, stop.");
  await waitFor(() => transport.ofType("model-output").some((m) => m.output === "Sure, stopping."));
  assert.equal(conversation.history.filter((m) => m.role === "user").at(-1)?.text, "No wait, stop.");
  session.end("test");
});

test("end_call tool hangs up after the goodbye has played", async () => {
  const { stt, transport } = setup([
    { tools: [{ name: "end_call", input: { reason: "caller is done" } }], pieces: [{ text: "Goodbye!" }] },
  ]);
  stt.say("That's all, thanks.");
  await waitFor(() => transport.closed);
  const ended = transport.ofType("status-update").at(-1);
  assert.equal(ended?.endedReason, "assistant-ended-call: caller is done");
  assert.deepEqual(transport.ofType("tool-call")[0]?.name, "end_call");
});

test("say and add-message from the client", async () => {
  const { session, transport, conversation, tts } = setup([{ pieces: [{ text: "Got it." }] }]);
  session.handleMessage({ type: "say", message: "Please hold." });
  await waitFor(() => tts.spoken.includes("Please hold."));
  session.handleMessage({ type: "add-message", role: "user", content: "Order #42 shipped.", triggerResponse: true });
  await waitFor(() => transport.ofType("model-output").length > 0);
  assert.ok(conversation.history.some((m) => m.text === "Order #42 shipped."));
  session.end("test");
});
