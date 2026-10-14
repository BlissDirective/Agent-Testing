// HTTP + WebSocket server. Serves the browser client from public/ and runs one
// CallSession per WebSocket connection on /call.

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { makeConfig, type AssistantConfig } from "./config.js";
import { parseClientMessage } from "./protocol.js";
import { providersFromEnv } from "./providers/index.js";
import type { Providers } from "./providers/types.js";
import { CallSession } from "./session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export function startServer(config: AssistantConfig, providers: Providers, port: number): Server {
  const server = createServer(async (req, res) => {
    const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
    const file = path.resolve(publicDir, `.${urlPath === "/" ? "/index.html" : urlPath}`);
    if (!file.startsWith(publicDir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": contentTypes[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });

  const wss = new WebSocketServer({ server, path: "/call" });
  wss.on("connection", (socket) => {
    const session = new CallSession(config, providers, {
      sendJson: (message) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(message)),
      sendAudio: (pcm) => socket.readyState === socket.OPEN && socket.send(pcm),
      close: () => socket.close(1000),
    });
    console.log(`[call ${session.id}] connected`);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        session.handleAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      const message = parseClientMessage(data.toString());
      if (message) session.handleMessage(message);
    });
    socket.on("close", () => {
      session.end("customer-disconnected");
      console.log(`[call ${session.id}] ended`);
    });
    session.start();
  });

  return server.listen(port, () => console.log(`Voice agent on http://localhost:${port}`));
}

async function loadConfig(): Promise<AssistantConfig> {
  const file = process.env.ASSISTANT_CONFIG;
  if (!file) return makeConfig();
  return makeConfig(JSON.parse(await readFile(file, "utf8")) as Partial<AssistantConfig>);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer(await loadConfig(), providersFromEnv(), Number(process.env.PORT ?? 8080));
}
