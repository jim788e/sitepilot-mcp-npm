import { describe, expect, it } from "vitest";
import type { StoredProfile } from "./config.js";
import { assertInitScopeClient, assertProfileMatchesRemote, initScopeSelection, parseArgs } from "./cli.js";

describe("CLI initialization scope selection", () => {
  it("parses an explicit init scope list without inventing a default", () => {
    const args = parseArgs(["init", "--remote", "--url", "https://example.com", "--scopes", "site:read,content:write"]);
    expect(args.scopes).toBe("site:read,content:write");
    expect(initScopeSelection(args.scopes, undefined)).toEqual(["site:read", "content:write"]);
    expect(initScopeSelection(undefined, undefined)).toBeUndefined();
  });

  it("defaults remote configuration to the selected profile's granted scopes", () => {
    const profile: StoredProfile = {
      url: "https://example.com/",
      auth: {
        kind: "app-password",
        username: "alice",
        password: "secret",
        scopes: ["site:read", "content:write"],
      },
    };
    expect(initScopeSelection(undefined, profile)).toEqual(["site:read", "content:write"]);
    expect(initScopeSelection("site:read", profile)).toEqual(["site:read"]);
  });

  it("rejects explicit scope ceilings for clients that cannot encode them", () => {
    expect(() => assertInitScopeClient("claude-code", "site:read")).not.toThrow();
    expect(() => assertInitScopeClient("antigravity-cli", "site:read")).not.toThrow();
    expect(() => assertInitScopeClient("antigravity-ide", "site:read")).not.toThrow();
    expect(() => assertInitScopeClient("codex", undefined)).not.toThrow();
    expect(() => assertInitScopeClient("codex", "site:read")).toThrow("--scopes is supported only with --client claude-code, antigravity-cli, or antigravity-ide");
    expect(() => assertInitScopeClient("major", "site:read")).toThrow("--scopes is supported only with --client claude-code, antigravity-cli, or antigravity-ide");
  });

  it("reuses profile scopes only for the same normalized remote URL", () => {
    const profile: StoredProfile = {
      url: "https://site-a.example",
      auth: { kind: "bearer", token: "fixture", scopes: ["site:read"] },
    };
    expect(() => assertProfileMatchesRemote("saved", profile, "https://site-a.example/")).not.toThrow();
    expect(() => assertProfileMatchesRemote("saved", undefined, "https://site-b.example/")).not.toThrow();
    expect(() => assertProfileMatchesRemote("saved", profile, "https://site-b.example/")).toThrow("Profile saved belongs to https://site-a.example/, not https://site-b.example/");
  });
});
