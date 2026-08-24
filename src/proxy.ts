import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolRequest, CallToolResult, ListToolsRequest, ListToolsResult } from "@modelcontextprotocol/client";
import type { AuthStrategy, FetchLike } from "./auth/strategy.js";
import { authenticatedFetch } from "./auth/strategy.js";
import { discoverSite, type ApiVersion, type DiscoveryResult } from "./discovery.js";

export interface RemoteClient {
  connect(): Promise<DiscoveryResult>;
  listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"]): Promise<CallToolResult>;
  close(): Promise<void>;
}

export class RemoteMcpClient implements RemoteClient {
  private client: Client | undefined;
  private discovery?: DiscoveryResult;
  private transport: StreamableHTTPClientTransport | undefined;

  constructor(
    private readonly siteUrl: string,
    private readonly auth: AuthStrategy,
    private readonly options: { apiVersion?: ApiVersion; timeoutMs?: number; fetch?: FetchLike } = {},
  ) {}

  async connect(): Promise<DiscoveryResult> {
    const authFetch = authenticatedFetch(this.auth, this.options.fetch ?? fetch);
    const discovered = await discoverSite(this.siteUrl, authFetch);
    const discovery = this.options.apiVersion
      ? { ...discovered, apiVersion: this.options.apiVersion, mcpUrl: new URL(`wp-json/sitepilot-mcp/${this.options.apiVersion}/mcp`, discovered.baseUrl) }
      : discovered;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const timedFetch: FetchLike = async (input, init = {}) => authFetch(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    const transport = new StreamableHTTPClientTransport(discovery.mcpUrl, {
      fetch: timedFetch,
      onInsufficientScope: "throw",
    });
    const client = new Client({ name: "sitepilot-mcp-proxy", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    this.discovery = discovery;
    return discovery;
  }

  async listTools(params: ListToolsRequest["params"] = {}): Promise<ListToolsResult> {
    return this.requiredClient().listTools(params);
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    return this.requiredClient().callTool(params);
  }

  getDiscovery(): DiscoveryResult {
    if (!this.discovery) throw new Error("Remote MCP client is not connected.");
    return this.discovery;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
  }

  private requiredClient(): Client {
    if (!this.client) throw new Error("Remote MCP client is not connected.");
    return this.client;
  }
}

export function toolBySuffix(tools: ListToolsResult["tools"], suffix: string): string {
  const wanted = suffix.replaceAll("_", "-");
  const tool = tools.find(item => item.name.replaceAll("_", "-").endsWith(wanted));
  if (!tool) throw new Error(`MCP tool ${suffix} is missing from the WordPress site.`);
  return tool.name;
}
