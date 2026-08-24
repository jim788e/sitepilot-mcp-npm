import { createServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import type { NodeIncomingMessageLike, NodeServerResponseLike } from "@modelcontextprotocol/node";
import type { RuntimeConfig } from "../config.js";
import { createProxyServer } from "../server.js";
import { renderError } from "../render.js";

export async function serveSitePilotHttp(config: RuntimeConfig, port: number): Promise<void> {
  const handler = createMcpHandler(async () => (await createProxyServer(config)).server, {
    onerror: error => process.stderr.write(`${renderError(error, config.auth)}\n`),
  });
  const nodeHandler = toNodeHandler(handler, { onerror: error => process.stderr.write(`${renderError(error, config.auth)}\n`) });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const httpServer = createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    void nodeHandler(request as unknown as NodeIncomingMessageLike, response as unknown as NodeServerResponseLike);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", resolve);
  });
  process.stderr.write(`SitePilot MCP listening at http://127.0.0.1:${port}/mcp\n`);
  const close = async (): Promise<void> => {
    await handler.close();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  };
  process.on("SIGINT", () => void close().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
}
