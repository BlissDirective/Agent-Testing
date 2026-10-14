// Translates TwiML voice responses into gateway verbs, so apps written for
// Twilio can be pointed at this gateway. Unsupported verbs are reported, not
// silently dropped.

import { XMLParser } from "fast-xml-parser";
import { parseVerbs, type Verb } from "./verbs.js";

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  preserveOrder: true,
  parseAttributeValue: false,
  parseTagValue: false, // keep "+15551234" a string, not a number
  trimValues: true,
});

/** Twilio verbs this gateway cannot run (yet). */
export class UnsupportedTwimlError extends Error {}

function tagOf(node: Node): string {
  return Object.keys(node).find((k) => k !== ":@" && k !== "#text") ?? "#text";
}

function attrs(node: Node): Record<string, string> {
  return (node[":@"] as Record<string, string>) ?? {};
}

function children(node: Node): Node[] {
  return (node[tagOf(node)] as Node[]) ?? [];
}

function text(node: Node): string {
  return children(node)
    .map((child) => (typeof child["#text"] === "string" || typeof child["#text"] === "number" ? String(child["#text"]) : ""))
    .join("")
    .trim();
}

const num = (value: string | undefined) => (value === undefined ? undefined : Number(value));
const bool = (value: string | undefined) => (value === undefined ? undefined : value === "true");

function media(url: string): string {
  // Twilio plays URLs; bare names are treated as Asterisk sounds.
  return /^https?:\/\//.test(url) ? url : `sound:${url}`;
}

function translate(node: Node, out: unknown[]): void {
  const tag = tagOf(node);
  const a = attrs(node);
  switch (tag) {
    case "Play":
      out.push({ play: { media: media(text(node)), loop: num(a.loop) || 1 } });
      return;
    case "Pause":
      out.push({ pause: { length: num(a.length) ?? 1 } });
      return;
    case "Hangup":
      out.push({ hangup: {} });
      return;
    case "Reject":
      out.push({ reject: { reason: a.reason === "busy" ? "busy" : "rejected" } });
      return;
    case "Redirect":
      out.push({ redirect: { url: text(node) } });
      return;
    case "Gather": {
      if (a.input && !a.input.split(" ").includes("dtmf")) {
        throw new UnsupportedTwimlError("<Gather input=\"speech\"> is not supported; use DTMF");
      }
      const prompt = children(node).find((c) => tagOf(c) === "Play");
      out.push({
        gather: {
          numDigits: num(a.numDigits),
          finishOnKey: a.finishOnKey ?? "#",
          timeout: num(a.timeout) ?? 5,
          play: prompt ? media(text(prompt)) : undefined,
          actionHook: a.action,
        },
      });
      return;
    }
    case "Dial": {
      const nouns = children(node).filter((c) => tagOf(c) !== "#text");
      const target = nouns.length
        ? (() => {
            const noun = nouns[0]!;
            const kind = tagOf(noun);
            if (kind === "Number") return text(noun);
            if (kind === "Sip") return text(noun);
            throw new UnsupportedTwimlError(`<Dial><${kind}> is not supported`);
          })()
        : text(node);
      out.push({
        dial: {
          target,
          callerId: a.callerId,
          timeout: num(a.timeout) ?? 30,
          record: a.record ? a.record !== "do-not-record" : false,
          actionHook: a.action,
        },
      });
      return;
    }
    case "Record":
      out.push({
        record: {
          maxLength: num(a.maxLength) ?? 3600,
          finishOnKey: a.finishOnKey ?? "#",
          beep: bool(a.playBeep) ?? true,
          actionHook: a.action,
        },
      });
      return;
    case "Connect": {
      const stream = children(node).find((c) => tagOf(c) === "Stream");
      if (!stream) throw new UnsupportedTwimlError("<Connect> is only supported with <Stream>");
      const parameters: Record<string, string> = {};
      for (const p of children(stream).filter((c) => tagOf(c) === "Parameter")) {
        const pa = attrs(p);
        if (pa.name) parameters[pa.name] = pa.value ?? "";
      }
      out.push({ connect: { url: attrs(stream).url, protocol: "twilio", parameters, actionHook: a.action } });
      return;
    }
    case "Say":
      throw new UnsupportedTwimlError("<Say> needs text-to-speech, which this gateway doesn't have; use <Play> or <Connect><Stream>");
    case "#text":
      return;
    default:
      throw new UnsupportedTwimlError(`<${tag}> is not supported`);
  }
}

export function twimlToVerbs(xml: string): Verb[] {
  const doc = parser.parse(xml) as Node[];
  const response = doc.find((n) => tagOf(n) === "Response");
  if (!response) throw new Error("TwiML must have a <Response> root");
  const out: unknown[] = [];
  for (const child of children(response)) translate(child, out);
  return parseVerbs(out);
}
