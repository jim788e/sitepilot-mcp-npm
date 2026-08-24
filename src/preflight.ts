import type { Scope } from "@instantbuild-sitepilot/contracts";
import type { CallToolResult, ListToolsResult, Tool } from "@modelcontextprotocol/client";
import { ApplicationPasswordStrategy } from "./auth/app-password.js";
import type { AuthStrategy } from "./auth/strategy.js";
import type { DiscoveryResult } from "./discovery.js";
import type { RemoteClient } from "./proxy.js";
import { structuredResult } from "./render.js";
import { toolBySuffix } from "./proxy.js";

export interface SiteContext {
  siteVersion?: string;
  pluginVersion?: string;
  builders: string[];
  woocommerce: boolean;
  scopes: Scope[] | "unknown";
  raw: Record<string, unknown>;
}

export interface PreflightState {
  discovery: DiscoveryResult;
  originalTools: ListToolsResult;
  tools: ListToolsResult;
  site: SiteContext;
}

function builderNames(raw: Record<string, unknown>): string[] {
  const builders = raw.builders;
  if (!builders || typeof builders !== "object" || Array.isArray(builders)) return [];
  return Object.entries(builders as Record<string, unknown>)
    .filter(([name, value]) => name !== "elementor_details" && value !== false && value !== null)
    .map(([name]) => name);
}

function credentialScopes(raw: Record<string, unknown>): Scope[] | undefined {
  const credential = raw.credential;
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) return undefined;
  const scopes = (credential as Record<string, unknown>).scopes;
  return Array.isArray(scopes) && scopes.every(scope => typeof scope === "string") ? scopes as Scope[] : undefined;
}

export function parseSiteContext(result: CallToolResult, knownScopes: Scope[] | "unknown"): SiteContext {
  const raw = structuredResult(result) ?? {};
  const environment = raw.environment && typeof raw.environment === "object" ? raw.environment as Record<string, unknown> : {};
  const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  const plugin = plugins.find(item => item && typeof item === "object" && String((item as Record<string, unknown>).file ?? "").includes("sitepilot-mcp")) as Record<string, unknown> | undefined;
  const woo = raw.woocommerce && typeof raw.woocommerce === "object" ? raw.woocommerce as Record<string, unknown> : {};
  return {
    ...(typeof raw.site_version === "string" ? { siteVersion: raw.site_version } : {}),
    ...(typeof plugin?.version === "string" ? { pluginVersion: plugin.version } : {}),
    builders: builderNames(raw),
    woocommerce: woo.active === true,
    scopes: credentialScopes(raw) ?? knownScopes,
    raw: { ...raw, environment },
  };
}

function contextSuffix(site: SiteContext): string {
  const parts = [
    site.builders.length ? `builders=${site.builders.join(",")}` : "builders=unknown",
    `woocommerce=${site.woocommerce ? "active" : "inactive"}`,
    `scopes=${site.scopes === "unknown" ? "unknown" : site.scopes.join(",")}`,
    ...(site.siteVersion ? [`site_version=${site.siteVersion}`] : []),
  ];
  return `SitePilot live context: ${parts.join("; ")}.`;
}

export function enrichTools(original: ListToolsResult, site: SiteContext): ListToolsResult {
  const suffix = contextSuffix(site);
  return {
    ...original,
    tools: original.tools.map((tool): Tool => ({
      ...tool,
      description: `${tool.description ?? ""}${tool.description ? "\n\n" : ""}${suffix}`,
    })),
  };
}

export async function runPreflight(remote: RemoteClient, auth: AuthStrategy): Promise<PreflightState> {
  const discovery = await remote.connect();
  const originalTools = await remote.listTools();
  const inspectName = toolBySuffix(originalTools.tools, "inspect-site");
  const inspect = await remote.callTool({ name: inspectName, arguments: {} });
  const site = parseSiteContext(inspect, await auth.grantedScopes());
  if (auth instanceof ApplicationPasswordStrategy && site.scopes !== "unknown") auth.setGrantedScopes(site.scopes);
  return { discovery, originalTools, tools: enrichTools(originalTools, site), site };
}

export function observeSiteVersion(site: SiteContext, result: CallToolResult): void {
  const raw = structuredResult(result);
  if (typeof raw?.site_version === "string") site.siteVersion = raw.site_version;
}

export function preflightSummary(state: PreflightState): string {
  const scopes = state.site.scopes === "unknown" ? "unknown scopes" : state.site.scopes.join(", ");
  const builders = state.site.builders.length ? state.site.builders.join(", ") : "no builder detected";
  return `Connected to ${state.discovery.baseUrl.toString()} · ${builders} · ${scopes}`;
}
