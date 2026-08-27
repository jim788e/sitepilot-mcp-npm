import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { login } from "./login.js";

describe("Application Password login", () => {
  it("uses the WordPress authorization screen, claims scopes, and stores the secret only in the profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "sitepilot-login-"));
    const profileFile = join(root, "profiles.json");
    const requested: string[] = [];
    const result = await login({
      url: "https://example.com",
      scopes: "site:read",
      label: "unit test",
      profile: "example",
    }, {
      profileFile,
      timeoutMs: 2_000,
      launch: url => {
        const authorize = new URL(url);
        requested.push(authorize.pathname);
        const callback = new URL(authorize.searchParams.get("success_url")!);
        callback.searchParams.set("user_login", "alice");
        callback.searchParams.set("password", "private-app-password");
        setTimeout(() => void fetch(callback), 0);
      },
      fetch: async (input, init) => {
        const pathname = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        requested.push(pathname);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${Buffer.from("alice:private-app-password").toString("base64")}`);
        if (pathname.endsWith("/inspect-site")) return Response.json({ builders: { gutenberg: true, elementor: "4.2.3", enfold: { active: false } }, woocommerce: { active: true, version: "11.0.1" } });
        return Response.json({ scopes: ["site:read"] }, { status: 201 });
      },
    });

    expect(result).toEqual({ profile: "example", scopes: ["site:read"], authKind: "app-password", summary: "Elementor 4.2.3 detected · WooCommerce 11.0.1" });
    expect(requested).toEqual(["/wp-admin/authorize-application.php", "/wp-json/sitepilot-mcp/v2/credentials/claim", "/wp-json/sitepilot-mcp/v1/ops/inspect-site"]);
    const profile = await readFile(profileFile, "utf8");
    expect(profile).toContain("private-app-password");
    expect(profile).not.toContain("Basic ");
  });

  it("preserves the issued credential when optional site inspection fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sitepilot-login-inspection-failure-"));
    const profileFile = join(root, "profiles.json");

    await expect(login({
      url: "https://example.com",
      scopes: "site:read",
      label: "inspection failure test",
      profile: "example",
    }, {
      profileFile,
      timeoutMs: 2_000,
      launch: url => {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get("success_url")!);
        callback.searchParams.set("user_login", "alice");
        callback.searchParams.set("password", "preserved-app-password");
        setTimeout(() => void fetch(callback), 0);
      },
      fetch: async input => {
        const pathname = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (pathname.endsWith("/inspect-site")) {
          return Response.json({ code: "inspection_unavailable" }, { status: 503 });
        }
        return Response.json({ scopes: ["site:read"] }, { status: 201 });
      },
    })).rejects.toThrow('Profile "example" was saved, but optional site inspection failed: inspection_unavailable');

    const stored = JSON.parse(await readFile(profileFile, "utf8")) as {
      profiles: Record<string, { auth: { kind: string; username: string; password: string; scopes: string[] } }>;
    };
    expect(stored.profiles.example?.auth).toEqual({
      kind: "app-password",
      username: "alice",
      password: "preserved-app-password",
      scopes: ["site:read"],
    });
  });
});
