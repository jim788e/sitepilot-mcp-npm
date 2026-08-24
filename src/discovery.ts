import type { FetchLike } from "./auth/strategy.js";

export type ApiVersion = "v2" | "v1";

export interface DiscoveryResult {
  baseUrl: URL;
  apiVersion: ApiVersion;
  mcpUrl: URL;
  namespaces: string[];
}

export class DiscoveryError extends Error {
  constructor(readonly code: "insecure_http" | "unreachable" | "plugin_missing", message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

export function normalizeSiteUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/?$/u, "/");
  url.search = "";
  url.hash = "";
  return url;
}

export function assertSecureSiteUrl(url: URL, environmentType = process.env.WP_ENVIRONMENT_TYPE): void {
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback && environmentType !== "local") {
    throw new DiscoveryError("insecure_http", `Refusing ${url.toString()}: Application Passwords and tokens require HTTPS outside local WordPress environments.`);
  }
}

export async function discoverSite(value: string, fetchImpl: FetchLike = fetch): Promise<DiscoveryResult> {
  const baseUrl = normalizeSiteUrl(value);
  assertSecureSiteUrl(baseUrl);
  const indexUrl = new URL("wp-json/", baseUrl);
  let response: Response;
  try {
    response = await fetchImpl(indexUrl, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new DiscoveryError("unreachable", `WordPress REST API is unreachable at ${indexUrl.toString()}: ${String(error)}`);
  }
  if (!response.ok) throw new DiscoveryError("unreachable", `WordPress REST API returned HTTP ${response.status} at ${indexUrl.toString()}.`);
  const body = await response.json() as { namespaces?: unknown };
  const namespaces = Array.isArray(body.namespaces) ? body.namespaces.filter((item): item is string => typeof item === "string") : [];
  const apiVersion = namespaces.includes("sitepilot-mcp/v2") ? "v2" : namespaces.includes("sitepilot-mcp/v1") ? "v1" : null;
  if (!apiVersion) throw new DiscoveryError("plugin_missing", `SitePilot MCP plugin not detected or not activated at ${baseUrl.toString()}`);
  return {
    baseUrl,
    apiVersion,
    namespaces,
    mcpUrl: new URL(`wp-json/sitepilot-mcp/${apiVersion}/mcp`, baseUrl),
  };
}
