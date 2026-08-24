import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Scope } from "@instantbuild-sitepilot/contracts";
import { ApplicationPasswordStrategy } from "./auth/app-password.js";
import { authorizeOAuth, openBrowser } from "./auth/oauth.js";
import { authenticatedFetch, type FetchLike } from "./auth/strategy.js";
import { normalizeSiteUrl, assertSecureSiteUrl } from "./discovery.js";
import { saveProfile, type StoredProfile } from "./config.js";

export const DEFAULT_SCOPES: Scope[] = ["site:read"];

export function parseScopeList(value?: string): Scope[] {
  const scopes = (value ? value.split(",") : DEFAULT_SCOPES).map(scope => scope.trim()).filter(Boolean) as Scope[];
  if (!scopes.length) throw new Error("At least one scope is required.");
  return [...new Set(scopes)];
}

async function createApplicationPassword(
  siteUrl: URL,
  label: string,
  options: { launch?: (url: string) => void; timeoutMs?: number } = {},
): Promise<{ username: string; password: string }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not bind the Application Password callback listener.");
    const callbackPath = `/callback/${randomUUID()}`;
    const callbackUrl = `http://127.0.0.1:${address.port}${callbackPath}`;
    const authorize = new URL("wp-admin/authorize-application.php", siteUrl);
    authorize.searchParams.set("app_name", `SitePilot MCP · ${label}`);
    authorize.searchParams.set("app_id", randomUUID());
    authorize.searchParams.set("success_url", callbackUrl);
    authorize.searchParams.set("reject_url", callbackUrl);
    const callback = new Promise<URL>((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.off("request", receive);
        reject(new Error("Application Password authorization timed out."));
      }, options.timeoutMs ?? 300_000);
      const receive = (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): void => {
        const received = new URL(request.url ?? "/", callbackUrl);
        if (received.pathname !== callbackPath) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("Not found");
          return;
        }
        server.off("request", receive);
        clearTimeout(timeout);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>SitePilot connected</title><p>Credential received. This tab can be closed.</p>");
        resolve(received);
      };
      server.on("request", receive);
    });
    (options.launch ?? openBrowser)(authorize.toString());
    const received = await callback;
    const username = received.searchParams.get("user_login");
    const password = received.searchParams.get("password");
    if (!username || !password) throw new Error("WordPress did not return an Application Password. Authorization may have been rejected.");
    return { username, password };
  } finally {
    server.close();
  }
}

async function claimCredential(siteUrl: URL, auth: ApplicationPasswordStrategy, scopes: Scope[], label: string, fetchImpl: FetchLike): Promise<Scope[]> {
  const response = await authenticatedFetch(auth, fetchImpl)(
    new URL("wp-json/sitepilot-mcp/v2/credentials/claim", siteUrl),
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ scopes, label }),
    },
  );
  const body = await response.json() as { scopes?: unknown; code?: string; message?: string };
  if (!response.ok) throw new Error(body.message ?? body.code ?? `Credential claim failed with HTTP ${response.status}.`);
  if (!Array.isArray(body.scopes) || !body.scopes.every(scope => typeof scope === "string")) throw new Error("Credential claim returned an invalid scope list.");
  return body.scopes as Scope[];
}

export async function login(
  input: { url: string; scopes?: string; label?: string; profile?: string; oauth?: boolean },
  options: { fetch?: FetchLike; launch?: (url: string) => void; profileFile?: string; timeoutMs?: number } = {},
): Promise<{ profile: string; scopes: Scope[]; authKind: "app-password" | "oauth" }> {
  const siteUrl = normalizeSiteUrl(input.url);
  assertSecureSiteUrl(siteUrl);
  const scopes = parseScopeList(input.scopes);
  const label = input.label ?? "local client";
  const profileName = input.profile ?? siteUrl.hostname.replace(/[^a-z0-9-]+/giu, "-").toLowerCase();
  const fetchImpl = options.fetch ?? fetch;
  let profile: StoredProfile;
  let authKind: "app-password" | "oauth";
  let grantedScopes: Scope[];
  if (input.oauth) {
    const credentials = await authorizeOAuth(siteUrl, scopes, label, {
      fetch: fetchImpl,
      ...(options.launch ? { launch: options.launch } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    profile = { url: siteUrl.toString(), auth: { kind: "oauth", ...credentials } };
    authKind = "oauth";
    grantedScopes = credentials.scopes;
  } else {
    const credential = await createApplicationPassword(siteUrl, label, {
      ...(options.launch ? { launch: options.launch } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    const auth = new ApplicationPasswordStrategy(credential.username, credential.password);
    const granted = await claimCredential(siteUrl, auth, scopes, label, fetchImpl);
    profile = { url: siteUrl.toString(), auth: { kind: "app-password", ...credential, scopes: granted } };
    authKind = "app-password";
    grantedScopes = granted;
  }
  await saveProfile(profileName, profile, options.profileFile);
  return { profile: profileName, scopes: grantedScopes, authKind };
}
