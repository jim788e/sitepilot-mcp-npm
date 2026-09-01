import { describe, expect, it } from "vitest";
import { ApplicationPasswordStrategy, parseApplicationPassword } from "./app-password.js";
import { BearerStrategy } from "./bearer.js";
import { authorizeOAuth, OAuthStrategy } from "./oauth.js";
import { authenticatedFetch, type AuthStrategy } from "./strategy.js";

describe("authentication strategies", () => {
  it("creates Basic auth and redacts every representation of the Application Password", async () => {
    const auth = new ApplicationPasswordStrategy("alice", "abcd efgh ijkl");
    const header = (await auth.headers()).authorization;
    expect(header).toBe(`Basic ${Buffer.from("alice:abcd efgh ijkl").toString("base64")}`);
    expect(auth.redact(`abcd efgh ijkl alice:abcd efgh ijkl ${header}`)).not.toContain("abcd efgh ijkl");
    expect(parseApplicationPassword("alice:secret")).toEqual({ username: "alice", password: "secret" });
    expect(() => parseApplicationPassword("secret")).toThrow(/--user/u);
  });

  it("uses a terminal bearer token and redacts it", async () => {
    const auth = new BearerStrategy("opaque-token", ["site:read"]);
    expect(await auth.headers()).toEqual({ authorization: "Bearer opaque-token" });
    expect(await auth.refresh()).toBe(false);
    expect(auth.redact("Bearer opaque-token")).toBe("Bearer [REDACTED]");
  });

  it("retries exactly once after a successful refresh", async () => {
    let requests = 0;
    let refreshes = 0;
    const auth: AuthStrategy = {
      kind: "oauth",
      headers: async () => ({ authorization: `Bearer token-${refreshes}` }),
      refresh: async () => { refreshes += 1; return true; },
      grantedScopes: async () => ["site:read"],
      redact: text => text,
    };
    const response = await authenticatedFetch(auth, async (_input, init) => {
      requests += 1;
      return new Response(null, { status: new Headers(init?.headers).get("authorization") === "Bearer token-1" ? 200 : 401 });
    })("https://example.com");
    expect(response.status).toBe(200);
    expect({ requests, refreshes }).toEqual({ requests: 2, refreshes: 1 });
  });

  it("refreshes and revokes OAuth tokens without exposing them", async () => {
    const calls: string[] = [];
    const persisted: string[] = [];
    const auth = new OAuthStrategy({
      clientId: "client-secret-id",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      scopes: ["site:read"],
      metadata: {
        issuer: "https://example.com/wp-json/sitepilot-mcp/v1",
        authorization_endpoint: "https://example.com/authorize",
        token_endpoint: "https://example.com/token",
        registration_endpoint: "https://example.com/register",
        revocation_endpoint: "https://example.com/revoke",
      },
    }, async input => {
      calls.push(input.toString());
      if (input.toString().endsWith("/token")) return Response.json({ access_token: "new-access", refresh_token: "new-refresh", scope: "site:read design:write" });
      return new Response(null, { status: 200 });
    }, async credentials => { persisted.push(credentials.refreshToken ?? ""); });
    expect(await auth.refresh()).toBe(true);
    expect(await auth.headers()).toEqual({ authorization: "Bearer new-access" });
    expect(await auth.grantedScopes()).toEqual(["site:read", "design:write"]);
    expect(auth.redact("new-access new-refresh client-secret-id")).toBe("[REDACTED] [REDACTED] [REDACTED]");
    expect(persisted).toEqual(["new-refresh"]);
    await auth.revoke();
    expect(calls).toEqual(["https://example.com/token", "https://example.com/revoke"]);
  });

  it("preserves DCR, PKCE, loopback state validation, token exchange, and scopes", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.includes(".well-known")) return Response.json({
        issuer: "https://example.com/wp-json/sitepilot-mcp/v1",
        authorization_endpoint: "https://example.com/authorize",
        token_endpoint: "https://example.com/token",
        registration_endpoint: "https://example.com/register",
        revocation_endpoint: "https://example.com/revoke",
      });
      if (url.endsWith("/register")) return Response.json({ client_id: "registered-client" }, { status: 201 });
      if (url.endsWith("/token")) return Response.json({ access_token: "access", refresh_token: "refresh", scope: "site:read design:write" });
      throw new Error(`Unexpected fetch ${url}`);
    };
    const credentials = await authorizeOAuth(new URL("https://example.com/"), ["site:read", "design:write"], "test", {
      fetch: fetchImpl,
      launch: url => {
        const authorization = new URL(url);
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "authorization-code");
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        setTimeout(() => void fetch(callback), 0);
      },
      timeoutMs: 2_000,
    });
    expect(credentials).toMatchObject({ clientId: "registered-client", accessToken: "access", refreshToken: "refresh", scopes: ["site:read", "design:write"] });
    const registration = JSON.parse(String(requests.find(request => request.url.endsWith("/register"))?.init?.body)) as Record<string, unknown>;
    expect(registration).toMatchObject({
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      scope: "site:read design:write",
    });
    const tokenBody = new URLSearchParams(String(requests.find(request => request.url.endsWith("/token"))?.init?.body));
    expect(tokenBody.get("code_verifier")).toHaveLength(64);
    expect(tokenBody.get("resource")).toBe("https://example.com/wp-json/sitepilot-mcp/v2/mcp");
  });
});
