import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { Scope } from "@instantbuild-sitepilot/contracts";
import type { AuthStrategy, FetchLike } from "./strategy.js";
import { redactValues } from "./strategy.js";

export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
}

export interface OAuthCredentials {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  scopes: Scope[];
  metadata: OAuthMetadata;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  scope?: string;
}

async function readJson<T>(fetchImpl: FetchLike, url: string | URL, init: RequestInit = {}): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: { accept: "application/json", ...Object.fromEntries(new Headers(init.headers).entries()) },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON from ${url.toString()} (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
    throw new Error(String(payload.error_description ?? payload.message ?? payload.error ?? `HTTP ${response.status}`));
  }
  return body as T;
}

export async function discoverOAuthMetadata(siteUrl: URL, fetchImpl: FetchLike = fetch): Promise<OAuthMetadata> {
  const url = new URL(".well-known/oauth-authorization-server/wp-json/sitepilot-mcp/v1", siteUrl);
  const metadata = await readJson<Partial<OAuthMetadata>>(fetchImpl, url);
  for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"] as const) {
    if (typeof metadata[field] !== "string") throw new Error(`OAuth metadata is missing ${field}.`);
  }
  return metadata as OAuthMetadata;
}

export class OAuthStrategy implements AuthStrategy {
  readonly kind = "oauth" as const;

  constructor(
    private credentials: OAuthCredentials,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly persist?: (credentials: OAuthCredentials) => Promise<void>,
  ) {}

  async headers(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${this.credentials.accessToken}` };
  }

  async refresh(): Promise<boolean> {
    if (!this.credentials.refreshToken) return false;
    const token = await readJson<OAuthTokenResponse>(this.fetchImpl, this.credentials.metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.credentials.refreshToken,
        client_id: this.credentials.clientId,
      }),
    });
    const next = {
      ...this.credentials,
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      scopes: parseScopes(token.scope) ?? this.credentials.scopes,
    };
    await this.persist?.(next);
    this.credentials = next;
    return true;
  }

  async grantedScopes(): Promise<Scope[]> {
    return [...this.credentials.scopes];
  }

  snapshot(): OAuthCredentials {
    return structuredClone(this.credentials);
  }

  async revoke(): Promise<void> {
    const token = this.credentials.refreshToken ?? this.credentials.accessToken;
    const response = await this.fetchImpl(this.credentials.metadata.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: this.credentials.clientId }),
    });
    if (!response.ok) throw new Error(`OAuth revocation failed with HTTP ${response.status}.`);
  }

  redact(text: string): string {
    return redactValues(text, [this.credentials.accessToken, this.credentials.refreshToken, this.credentials.clientId]);
  }
}

function parseScopes(value?: string): Scope[] | undefined {
  return value ? value.split(/\s+/u).filter(Boolean) as Scope[] : undefined;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

export function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export async function authorizeOAuth(
  siteUrl: URL,
  scopes: Scope[],
  label: string,
  options: { fetch?: FetchLike; launch?: (url: string) => void; timeoutMs?: number } = {},
): Promise<OAuthCredentials> {
  const fetchImpl = options.fetch ?? fetch;
  const metadata = await discoverOAuthMetadata(siteUrl, fetchImpl);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not bind the OAuth callback listener.");
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const registration = await readJson<{ client_id: string }>(fetchImpl, metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: `SitePilot MCP · ${label}`,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: scopes.join(" "),
      }),
    });
    const verifier = base64Url(randomBytes(48));
    const state = randomUUID();
    const resource = new URL("wp-json/sitepilot-mcp/v2/mcp", siteUrl).toString();
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      scope: scopes.join(" "),
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource,
    };
    for (const [name, value] of Object.entries(params)) authorizationUrl.searchParams.set(name, value);
    const callback = new Promise<URL>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("OAuth callback timed out.")), options.timeoutMs ?? 300_000);
      server.once("request", (request, response) => {
        clearTimeout(timeout);
        const received = new URL(request.url ?? "/", redirectUri);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>SitePilot authorized</title><p>Authorization complete. This tab can be closed.</p>");
        resolve(received);
      });
    });
    (options.launch ?? openBrowser)(authorizationUrl.toString());
    const callbackUrl = await callback;
    if (callbackUrl.searchParams.get("state") !== state) throw new Error("OAuth state mismatch.");
    const code = callbackUrl.searchParams.get("code");
    if (!code) throw new Error("OAuth authorization did not return a code.");
    const token = await readJson<OAuthTokenResponse>(fetchImpl, metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: registration.client_id,
        code_verifier: verifier,
        resource,
      }),
    });
    return {
      clientId: registration.client_id,
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      scopes: parseScopes(token.scope) ?? scopes,
      metadata,
    };
  } finally {
    server.close();
  }
}
