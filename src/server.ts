import { Server } from "@modelcontextprotocol/server";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/server";
import type { RuntimeConfig } from "./config.js";
import { runPreflight, observeSiteVersion, preflightSummary, type PreflightState } from "./preflight.js";
import { RemoteMcpClient, toolBySuffix, type RemoteClient } from "./proxy.js";
import { renderToolResult, structuredResult } from "./render.js";
import { PACKAGE_VERSION } from "./version.js";

export interface ProxyServerHandle {
  server: Server;
  remote: RemoteClient;
  preflight: PreflightState;
}

function localError(message: string, code: string): CallToolResult {
  const structuredContent = { ok: false, error: { code, message } };
  return {
    isError: true,
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  };
}

function isMutationTool(name: string): boolean {
  const normalized = name.replaceAll("_", "-");
  return ["plan-change", "execute-change", "rollback-change", "manage-artifact", "import-media-artifact", "plan-site-build", "execute-site-build", "publish-site-build"]
    .some(suffix => normalized.endsWith(suffix));
}

async function riskTierForExecution(remote: RemoteClient, state: PreflightState, request: CallToolRequest): Promise<number | undefined> {
  const normalized = request.params.name.replaceAll("_", "-");
  if (!normalized.endsWith("execute-change") && !normalized.endsWith("rollback-change")) return undefined;
  const changeSetId = request.params.arguments?.change_set_id;
  if (typeof changeSetId !== "string") return undefined;
  const statusName = toolBySuffix(state.originalTools.tools, "get-change-status");
  const status = structuredResult(await remote.callTool({ name: statusName, arguments: { change_set_id: changeSetId } }));
  return typeof status?.risk_tier === "number" ? status.risk_tier : undefined;
}

export async function createProxyServer(
  config: RuntimeConfig,
  remoteFactory: () => RemoteClient = () => new RemoteMcpClient(config.url, config.auth, {
    ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
    timeoutMs: config.timeoutMs,
  }),
): Promise<ProxyServerHandle> {
  const remote = remoteFactory();
  const preflight = await runPreflight(remote, config.auth);
  const server = new Server(
    { name: "sitepilot-mcp", version: PACKAGE_VERSION },
    { capabilities: { tools: {} }, instructions: preflightSummary(preflight) },
  );
  server.setRequestHandler("tools/list", async () => preflight.tools);
  server.setRequestHandler("tools/call", async request => {
    if (config.readOnly && isMutationTool(request.params.name)) {
      return localError("This client is running with --read-only; the operation was not sent to WordPress.", "sitepilot_client_read_only");
    }
    const tier = await riskTierForExecution(remote, preflight, request);
    if (tier !== undefined && tier > config.allowTier) {
      return localError(`Change set risk tier ${tier} exceeds client limit ${config.allowTier}; the operation was not sent to WordPress.`, "sitepilot_client_tier_denied");
    }
    const result = await remote.callTool(request.params);
    observeSiteVersion(preflight.site, result);
    return server.projectCallToolResult(
      renderToolResult(result, preflight.discovery.baseUrl, config.auth),
      preflight.originalTools.tools.find(tool => tool.name === request.params.name)?.outputSchema,
    );
  });
  server.oninitialized = () => {
    void server.sendLoggingMessage({ level: "info", logger: "sitepilot-mcp", data: preflightSummary(preflight) }).catch(() => undefined);
  };
  server.onclose = () => {
    void remote.close();
  };
  return { server, remote, preflight };
}
