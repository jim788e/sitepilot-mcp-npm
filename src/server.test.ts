import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolRequest, CallToolResult, ListToolsResult, Tool } from "@modelcontextprotocol/client";
import { TOOL_NAMES } from "@instantbuild-sitepilot/contracts";
import { describe, expect, it } from "vitest";
import { BearerStrategy } from "./auth/bearer.js";
import type { RuntimeConfig } from "./config.js";
import type { DiscoveryResult } from "./discovery.js";
import { enrichTools, type SiteContext } from "./preflight.js";
import type { RemoteClient } from "./proxy.js";
import { createProxyServer } from "./server.js";

const remoteTools: Tool[] = TOOL_NAMES.map(name => ({
  name,
  description: `Remote description for ${name}`,
  inputSchema: { type: "object", properties: {} },
}));

class FakeRemote implements RemoteClient {
  calls: CallToolRequest["params"][] = [];

  async connect(): Promise<DiscoveryResult> {
    return {
      baseUrl: new URL("https://example.com"),
      apiVersion: "v2",
      mcpUrl: new URL("https://example.com/wp-json/sitepilot-mcp/v2/mcp"),
      namespaces: ["sitepilot-mcp/v2"],
    };
  }

  async listTools(): Promise<ListToolsResult> {
    return { tools: structuredClone(remoteTools) };
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    this.calls.push(structuredClone(params));
    if (params.name.endsWith("inspect_site")) {
      const structuredContent = {
        site_version: "version-0000000000000001",
        builders: { gutenberg: true, elementor: false, enfold: { active: false } },
        woocommerce: { active: false },
        credential: { type: "bearer", state: "active", scopes: ["site:read"] },
      };
      return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
    }
    return { structuredContent: { ok: true, echoed: params.arguments }, content: [{ type: "text", text: "ok" }] };
  }

  async close(): Promise<void> {}
}

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    url: "https://example.com",
    auth: new BearerStrategy("synthetic-token", ["site:read"]),
    timeoutMs: 30_000,
    logLevel: "info",
    readOnly: false,
    allowTier: 3,
    ...overrides,
  };
}

describe("passthrough server", () => {
  it("keeps every remote tool and changes only descriptions additively", () => {
    const site: SiteContext = { builders: ["gutenberg"], woocommerce: false, scopes: ["site:read"], raw: {} };
    const original = { tools: structuredClone(remoteTools) };
    const enriched = enrichTools(original, site);
    expect(enriched.tools.map(tool => tool.name)).toEqual(remoteTools.map(tool => tool.name));
    enriched.tools.forEach((tool, index) => {
      const source = remoteTools[index]!;
      expect({ ...tool, description: source.description }).toEqual(source);
      expect(tool.description).toContain(source.description!);
      expect(tool.description).toContain("scopes=site:read");
    });
  });

  it("exposes the remote surface through a real MCP client and forwards calls verbatim", async () => {
    const remote = new FakeRemote();
    const handle = await createProxyServer(config(), () => remote);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(remoteTools.map(tool => tool.name));
    const input = { arbitrary: { nested: true } };
    const result = await client.callTool({ name: TOOL_NAMES[1], arguments: input });
    expect(result.structuredContent).toEqual({ ok: true, echoed: input });
    expect(remote.calls.at(-1)).toEqual({ name: TOOL_NAMES[1], arguments: input });
    await client.close();
  });

  it("blocks mutations locally in read-only mode", async () => {
    const remote = new FakeRemote();
    const handle = await createProxyServer(config({ readOnly: true }), () => remote);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    const before = remote.calls.length;
    const result = await client.callTool({ name: "sitepilot.plan_change", arguments: {} });
    expect(result.isError).toBe(true);
    expect(remote.calls).toHaveLength(before);
    await client.close();
  });
});
