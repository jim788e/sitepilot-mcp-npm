import { describe, expect, it } from "vitest";
import { BearerStrategy } from "./auth/bearer.js";
import type { RuntimeConfig } from "./config.js";
import { diagnose, type DoctorCode } from "./doctor.js";
import type { FetchLike } from "./auth/strategy.js";

function config(url = "https://example.com"): RuntimeConfig {
  return { url, auth: new BearerStrategy("token"), timeoutMs: 1_000, logLevel: "info", readOnly: false, allowTier: 3 };
}

function routes(kind: DoctorCode): FetchLike {
  return async input => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (kind === "unreachable") throw new Error("offline");
    if (path === "/wp-json/") {
      return Response.json({ namespaces: ["plugin_missing", "plugin_inactive"].includes(kind) ? [] : ["sitepilot-mcp/v2"] });
    }
    if (path.includes("/wp/v2/plugins/")) {
      return kind === "plugin_inactive" ? Response.json({ status: "inactive" }) : Response.json({ code: "rest_no_route" }, { status: 404 });
    }
    if (path.endsWith("/credentials/probe")) return Response.json({ authorization_header_seen: kind !== "authorization_stripped" });
    if (path.endsWith("/users/me")) return kind === "wrong_user" ? Response.json({ code: "rest_not_logged_in" }, { status: 401 }) : Response.json({ id: 1 });
    if (path.endsWith("/credentials/status")) {
      if (kind === "revoked_grant") return Response.json({ state: "revoked", scopes: [] });
      return Response.json({ state: "active", scopes: kind === "insufficient_scopes" ? ["site:read"] : ["site:read", "design:write"] });
    }
    return Response.json({});
  };
}

describe("doctor", () => {
  it.each([
    ["unreachable", "unreachable"],
    ["plugin_missing", "plugin_missing"],
    ["plugin_inactive", "plugin_inactive"],
    ["authorization_stripped", "authorization_stripped"],
    ["wrong_user", "wrong_user"],
    ["revoked_grant", "revoked_grant"],
    ["insufficient_scopes", "insufficient_scopes"],
  ] as const)("diagnoses %s", async (fixture, expected) => {
    const result = await diagnose(config(), ["site:read", "design:write"], routes(fixture));
    expect(result.code).toBe(expected);
    expect(result.ok).toBe(false);
  });

  it("diagnoses insecure HTTP and a healthy credential", async () => {
    expect((await diagnose(config("http://example.com"), ["site:read"], routes("ok"))).code).toBe("insecure_http");
    expect(await diagnose(config(), ["site:read", "design:write"], routes("ok"))).toMatchObject({ code: "ok", ok: true });
  });
});
