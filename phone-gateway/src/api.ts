// REST API: place, inspect, redirect and hang up calls; download recordings.
// All routes need `Authorization: Bearer <api key>`.
//
//   POST /v1/calls              { to, from, url? | verbs? | twiml?, format?, statusCallback?, timeout? }
//   GET  /v1/calls
//   GET  /v1/calls/:sid
//   POST /v1/calls/:sid         { status: "completed" } | { verbs } | { twiml } | { url, format? }
//   GET  /v1/recordings/:name.wav

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CallApp } from "./call.js";
import type { Gateway } from "./gateway.js";
import { twimlToVerbs } from "./twiml.js";
import { parseVerbs, type Verb } from "./verbs.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const appInput = z.object({
  url: z.string().url().optional(),
  format: z.enum(["json", "twiml"]).default("json"),
  verbs: z.array(z.unknown()).optional(),
  twiml: z.string().optional(),
  statusCallback: z.string().url().optional(),
});

const createCallInput = appInput.extend({
  to: z.string().min(1),
  from: z.string().min(1),
  timeout: z.number().int().min(5).max(600).optional(),
});

const updateCallInput = appInput.extend({ status: z.enum(["completed"]).optional() });

function appFromInput(input: z.infer<typeof appInput>): CallApp {
  const given = [input.url, input.verbs, input.twiml].filter((x) => x !== undefined).length;
  if (given !== 1) throw new HttpError(400, "Provide exactly one of url, verbs or twiml");
  if (input.verbs) return { verbs: parseVerbs(input.verbs), format: "json", statusCallback: input.statusCallback };
  if (input.twiml) return { verbs: twimlToVerbs(input.twiml), format: "twiml", statusCallback: input.statusCallback };
  return { url: input.url, format: input.format, statusCallback: input.statusCallback };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startApi(gateway: Gateway, port: number): Server {
  const keys = gateway.config.apiKeys.map((k) => Buffer.from(k));
  const authorized = (req: IncomingMessage) => {
    const token = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    return keys.some((key) => key.length === token.length && timingSafeEqual(key, token));
  };

  const server = createServer(async (req, res) => {
    try {
      if (!authorized(req)) throw new HttpError(401, "Missing or invalid API key");
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // ["v1", "calls", ":sid"]
      if (parts[0] !== "v1") throw new HttpError(404, "Not found");

      if (parts[1] === "calls" && parts.length === 2) {
        if (req.method === "GET") return send(res, 200, [...gateway.calls.values()].map((c) => c.toJSON()));
        if (req.method === "POST") {
          const input = parse(createCallInput, await readJson(req));
          const call = await gateway.createCall({
            to: input.to,
            from: input.from,
            app: appFromInput(input),
            timeout: input.timeout,
          });
          return send(res, 201, call.toJSON());
        }
      }

      if (parts[1] === "calls" && parts.length === 3) {
        const call = gateway.calls.get(parts[2]!);
        if (!call) throw new HttpError(404, "No such call");
        if (req.method === "GET") return send(res, 200, call.toJSON());
        if (req.method === "POST") {
          const input = parse(updateCallInput, await readJson(req));
          if (call.endedAt) throw new HttpError(409, "Call has ended");
          if (input.status === "completed") {
            await call.hangup();
          } else {
            const app = appFromInput(input);
            const verbs: Verb[] = app.verbs ?? (await gateway.webhooks.fetchVerbs(app.url!, app.format, call.info));
            call.redirect(verbs);
          }
          return send(res, 200, call.toJSON());
        }
      }

      if (parts[1] === "recordings" && parts.length === 3 && req.method === "GET") {
        const match = /^(CA[0-9a-f]{32}-\d+)\.wav$/.exec(parts[2]!);
        if (!match) throw new HttpError(404, "No such recording");
        const file = path.join(gateway.config.recordingsDir, `${match[1]}.wav`);
        const info = await stat(file).catch(() => null);
        if (!info) throw new HttpError(404, "No such recording");
        res.writeHead(200, { "content-type": "audio/wav", "content-length": info.size });
        createReadStream(file).pipe(res);
        return;
      }

      throw new HttpError(404, "Not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      send(res, status, { error: (error as Error).message });
    }
  });
  return server.listen(port);
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, result.error.message);
  return result.data;
}
