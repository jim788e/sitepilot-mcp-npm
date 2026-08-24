import packageManifest from "../package.json" with { type: "json" };
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BearerStrategy } from "./auth/bearer.js";
import type { FetchLike } from "./auth/strategy.js";
import { RemoteMcpClient } from "./proxy.js";

describe("package version identity", () => {
  it("reports the manifest version through the built CLI", () => {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const build = spawnSync(process.execPath, [compiler, "-p", packageRoot], { cwd: packageRoot, encoding: "utf8" });
    expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);

    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "--version"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    expect(cli.status, `${cli.stdout}${cli.stderr}`).toBe(0);
    expect(cli.stdout.trim()).toBe(packageManifest.version);
  });

  it("advertises the manifest version to the remote MCP server", async () => {
    let advertisedVersion: string | undefined;
    const fakeFetch: FetchLike = async (input, init = {}) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      if (url.pathname === "/wp-json/") {
        return Response.json({ namespaces: ["sitepilot-mcp/v2"] });
      }

      if (typeof init.body === "string") {
        const message = JSON.parse(init.body) as {
          id?: string | number;
          method?: string;
          params?: { protocolVersion?: string; clientInfo?: { version?: string } };
        };
        if (message.method === "initialize") {
          advertisedVersion = message.params?.clientInfo?.version;
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion,
              capabilities: {},
              serverInfo: { name: "fake-wordpress", version: "0.4.6" },
            },
          });
        }
      }

      return new Response(null, { status: 202 });
    };

    const remote = new RemoteMcpClient(
      "https://example.com",
      new BearerStrategy("synthetic-token", ["site:read"]),
      { fetch: fakeFetch },
    );
    await remote.connect();
    expect(advertisedVersion).toBe(packageManifest.version);
    await remote.close();
  });
});
