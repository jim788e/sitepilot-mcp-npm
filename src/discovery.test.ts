import { describe, expect, it } from "vitest";
import { assertSecureSiteUrl, discoverSite, DiscoveryError } from "./discovery.js";

describe("site discovery", () => {
  it("prefers v2 and falls back to v1", async () => {
    const v2 = await discoverSite("https://example.com", async () => Response.json({ namespaces: ["sitepilot-mcp/v1", "sitepilot-mcp/v2"] }));
    expect(v2.apiVersion).toBe("v2");
    expect(v2.mcpUrl.toString()).toBe("https://example.com/wp-json/sitepilot-mcp/v2/mcp");
    const v1 = await discoverSite("https://example.com", async () => Response.json({ namespaces: ["sitepilot-mcp/v1"] }));
    expect(v1.apiVersion).toBe("v1");
  });

  it("fails clearly when the plugin is absent or REST is unreachable", async () => {
    await expect(discoverSite("https://example.com", async () => Response.json({ namespaces: [] }))).rejects.toMatchObject({ code: "plugin_missing" });
    await expect(discoverSite("https://example.com", async () => { throw new Error("offline"); })).rejects.toMatchObject({ code: "unreachable" });
  });

  it("refuses non-loopback HTTP unless WordPress declares a local environment", () => {
    expect(() => assertSecureSiteUrl(new URL("http://example.com"))).toThrow(DiscoveryError);
    expect(() => assertSecureSiteUrl(new URL("http://127.0.0.1:8888"))).not.toThrow();
    expect(() => assertSecureSiteUrl(new URL("http://example.com"), "local")).not.toThrow();
  });
});
