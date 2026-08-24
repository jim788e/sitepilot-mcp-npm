import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { RuntimeConfig } from "../config.js";
import { createProxyServer } from "../server.js";
import { renderError } from "../render.js";

export function serveSitePilotStdio(config: RuntimeConfig): void {
  const handle = serveStdio(async () => (await createProxyServer(config)).server, {
    onerror: error => process.stderr.write(`${renderError(error, config.auth)}\n`),
  });
  process.on("SIGINT", () => {
    void handle.close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void handle.close().finally(() => process.exit(0));
  });
}
