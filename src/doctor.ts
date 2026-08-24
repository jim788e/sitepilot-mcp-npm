import type { Scope } from "@instantbuild-sitepilot/contracts";
import type { RuntimeConfig } from "./config.js";
import { authenticatedFetch, type FetchLike } from "./auth/strategy.js";
import { DiscoveryError, discoverSite, normalizeSiteUrl, assertSecureSiteUrl } from "./discovery.js";

export type DoctorCode = "ok" | "insecure_http" | "unreachable" | "plugin_missing" | "plugin_inactive" | "authorization_stripped" | "wrong_user" | "revoked_grant" | "insufficient_scopes";

export interface DoctorResult {
  ok: boolean;
  code: DoctorCode;
  message: string;
  details?: Record<string, unknown>;
}

async function json(fetchImpl: FetchLike, url: URL, init: RequestInit = {}): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetchImpl(url, { ...init, headers: { accept: "application/json", ...Object.fromEntries(new Headers(init.headers).entries()) } });
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json() as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // The status still carries the diagnosis.
  }
  return { response, body };
}

export async function diagnose(config: RuntimeConfig, requiredScopes: Scope[] = ["site:read"], fetchImpl: FetchLike = fetch): Promise<DoctorResult> {
  let baseUrl: URL;
  try {
    baseUrl = normalizeSiteUrl(config.url);
    assertSecureSiteUrl(baseUrl);
  } catch (error) {
    return { ok: false, code: "insecure_http", message: error instanceof Error ? error.message : String(error) };
  }
  const authFetch = authenticatedFetch(config.auth, fetchImpl);
  let discovery;
  try {
    discovery = await discoverSite(config.url, authFetch);
  } catch (error) {
    if (error instanceof DiscoveryError && error.code === "plugin_missing") {
      const plugin = await json(authFetch, new URL("wp-json/wp/v2/plugins/sitepilot-mcp/sitepilot-mcp", baseUrl));
      if (plugin.response.ok && plugin.body.status !== "active") return { ok: false, code: "plugin_inactive", message: "SitePilot MCP is installed but inactive." };
      return { ok: false, code: "plugin_missing", message: error.message };
    }
    return { ok: false, code: "unreachable", message: error instanceof Error ? error.message : String(error) };
  }

  const probe = await json(authFetch, new URL("wp-json/sitepilot-mcp/v2/credentials/probe", baseUrl));
  if (probe.response.ok && probe.body.authorization_header_seen === false) {
    return { ok: false, code: "authorization_stripped", message: "The web server stripped the Authorization header before WordPress received it." };
  }
  const me = await json(authFetch, new URL("wp-json/wp/v2/users/me", baseUrl));
  if (!me.response.ok) return { ok: false, code: "wrong_user", message: "WordPress rejected the supplied username or credential." };
  const status = await json(authFetch, new URL("wp-json/sitepilot-mcp/v2/credentials/status", baseUrl));
  if (!status.response.ok) return { ok: false, code: "wrong_user", message: "The authenticated WordPress user does not have sitepilot_connect." };
  if (["revoked", "invalid", "storage_error"].includes(String(status.body.state ?? ""))) {
    return { ok: false, code: "revoked_grant", message: `The SitePilot credential grant is ${String(status.body.state)}.` };
  }
  const scopes = Array.isArray(status.body.scopes) ? status.body.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const missing = requiredScopes.filter(scope => !scopes.includes(scope));
  if (missing.length) {
    return { ok: false, code: "insufficient_scopes", message: `Credential lacks required scopes: ${missing.join(", ")}.`, details: { granted: scopes, required: requiredScopes } };
  }
  return { ok: true, code: "ok", message: `SitePilot MCP ${discovery.apiVersion} is reachable and authenticated.`, details: { scopes } };
}
