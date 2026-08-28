import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveProfile } from "./config.js";
import { initializeClients, normalizeClientSelection, OPERATING_RULES, writeClientConfig } from "./init.js";

describe("profile and client initialization", () => {
  it("stores the secret only in the profile and merges client configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "sitepilot-init-"));
    const profileFile = join(root, "profiles.json");
    await saveProfile("example-prod", {
      url: "https://example.com/",
      auth: { kind: "app-password", username: "alice", password: "private-app-password", scopes: ["site:read"] },
    }, profileFile);
    const configPath = join(root, ".cursor", "mcp.json");
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcpServers: { existing: { command: "existing" } }, keep: true }), "utf8");
    const result = await writeClientConfig("cursor", "example-prod", "https://example.com/", { cwd: root, home: root, appData: root });
    const text = await readFile(result.path, "utf8");
    expect(text).toContain("sitepilot-mcp@0.1.4");
    expect(text).toContain("example-prod");
    expect(text).toContain("existing");
    expect(text).toContain('"keep": true');
    expect(text).not.toContain("private-app-password");
    expect(await readFile(profileFile, "utf8")).toContain("private-app-password");
    expect(result.backup).toBe(`${configPath}.bak`);
    expect(await readFile(join(root, ".cursorrules"), "utf8")).toContain(OPERATING_RULES.trim());
  });

  it("uses discovery by default and pins explicitly selected Claude Code OAuth scopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sitepilot-remote-init-"));
    const result = await writeClientConfig("claude-code", "example", "https://example.com/", { cwd: root, home: root, remote: true });
    const config = JSON.parse(await readFile(result.path, "utf8")) as { mcpServers: { sitepilot: Record<string, unknown> } };
    expect(config.mcpServers.sitepilot).toEqual({ type: "http", url: "https://example.com/wp-json/sitepilot-mcp/v2/mcp" });

    await writeClientConfig("claude-code", "example", "https://example.com/", {
      cwd: root,
      home: root,
      remote: true,
      scopes: ["site:read", "content:write"],
    });
    const pinned = JSON.parse(await readFile(result.path, "utf8")) as { mcpServers: { sitepilot: Record<string, unknown> } };
    expect(pinned.mcpServers.sitepilot).toEqual({
      type: "http",
      url: "https://example.com/wp-json/sitepilot-mcp/v2/mcp",
      oauth: { scopes: "site:read content:write" },
    });
    expect(JSON.stringify(pinned)).not.toContain("example\"");
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain("awaiting_approval");
  });

  it("writes each major client's documented remote field and operating rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "sitepilot-major-remote-"));
    await writeClientConfig("cursor", "unused", "https://example.com/", { cwd: root, home: root, remote: true });
    await writeClientConfig("antigravity-cli", "unused", "https://example.com/", { cwd: root, home: root, remote: true });
    await writeClientConfig("antigravity-ide", "unused", "https://example.com/", { cwd: root, home: root, remote: true });
    await writeClientConfig("codex", "unused", "https://example.com/", { cwd: root, home: root, remote: true });

    const cursor = JSON.parse(await readFile(join(root, ".cursor", "mcp.json"), "utf8")) as { mcpServers: { sitepilot: Record<string, unknown> } };
    const antigravityCli = JSON.parse(await readFile(join(root, ".agents", "mcp_config.json"), "utf8")) as { mcpServers: { sitepilot: Record<string, unknown> } };
    const antigravityIde = JSON.parse(await readFile(join(root, ".gemini", "config", "mcp_config.json"), "utf8")) as { mcpServers: { sitepilot: Record<string, unknown> } };
    const codex = await readFile(join(root, ".codex", "config.toml"), "utf8");
    const endpoint = "https://example.com/wp-json/sitepilot-mcp/v2/mcp";

    expect(cursor.mcpServers.sitepilot).toEqual({ url: endpoint });
    expect(antigravityCli.mcpServers.sitepilot).toEqual({ serverUrl: endpoint });
    expect(antigravityIde.mcpServers.sitepilot).toEqual({ serverUrl: endpoint });
    expect(codex).toContain("[mcp_servers.sitepilot]");
    expect(codex).toContain(`url = \"${endpoint}\"`);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(OPERATING_RULES.trim());
    await expect(readFile(join(root, ".gemini", "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".agents", "rules", "sitepilot.md"), "utf8")).toContain(OPERATING_RULES.trim());
  });

  it("merges Codex TOML without overwriting unrelated configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "sitepilot-codex-init-"));
    const configPath = join(root, ".codex", "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[mcp_servers.existing]\ncommand = "existing"\n';
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(configPath, original, "utf8");
    const first = await writeClientConfig("codex", "example-prod", "https://example.com/", { cwd: root, home: root });
    await writeClientConfig("codex", "example-next", "https://example.com/", { cwd: root, home: root });
    const text = await readFile(configPath, "utf8");
    expect(text).toContain('model = "gpt-5.6-sol"');
    expect(text).toContain("[mcp_servers.existing]");
    expect(text).toContain("sitepilot-mcp@0.1.4");
    expect(text).toContain('"example-next"');
    expect(text).not.toContain('"example-prod"');
    expect(text.match(/\[mcp_servers\.sitepilot\]/gu)).toHaveLength(1);
    expect(first.backup).toBe(`${configPath}.bak`);
    expect(await readFile(first.backup!, "utf8")).toBe(original);
  });

  it("writes the complete detected major-client stdio matrix with an exact package pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "sitepilot-major-local-"));
    await mkdir(join(root, ".codeium", "windsurf"), { recursive: true });
    const results = await initializeClients("major", "example", "https://example.com/", { cwd: root, home: root, availableCommands: ["agy"] });
    expect(results.map(result => [result.client, result.status])).toEqual([
      ["claude-code", "written"],
      ["codex", "written"],
      ["cursor", "written"],
      ["antigravity-cli", "written"],
      ["windsurf", "written"],
    ]);
    expect(results.find(result => result.client === "codex")?.restart).toBe(
      "Trust this project in Codex so .codex/config.toml loads. Restart the Codex session, then use /mcp to verify SitePilot.",
    );
    const antigravityCli = JSON.parse(await readFile(join(root, ".agents", "mcp_config.json"), "utf8")) as { mcpServers: { sitepilot: Record<string, unknown> } };
    const windsurf = JSON.parse(await readFile(join(root, ".codeium", "windsurf", "mcp_config.json"), "utf8")) as { mcpServers: { sitepilot: Record<string, unknown> } };
    for (const server of [antigravityCli.mcpServers.sitepilot, windsurf.mcpServers.sitepilot]) {
      expect(server).toMatchObject({ command: "npx", args: ["-y", "sitepilot-mcp@0.1.4", "--profile", "example"], env: { SITEPILOT_URL: "https://example.com/" } });
      expect(JSON.stringify(server)).not.toContain("password");
    }
  });

  it("reports missing global clients as skipped when initializing all", async () => {
    const root = await mkdtemp(join(tmpdir(), "sitepilot-all-init-"));
    await mkdir(join(root, ".agents", "rules"), { recursive: true });
    await writeFile(join(root, ".agents", "rules", "sitepilot.md"), OPERATING_RULES, "utf8");
    const options = { cwd: root, home: root, appData: root, availableCommands: [] };
    const results = await initializeClients("all", "example", "https://example.com/", options);
    expect(results.map(result => [result.client, result.status])).toEqual([
      ["claude-code", "written"],
      ["codex", "written"],
      ["cursor", "written"],
      ["antigravity-cli", "skipped"],
      ["windsurf", "skipped"],
      ["antigravity-ide", "skipped"],
      ["claude-desktop", "skipped"],
    ]);
    const second = await initializeClients("all", "example", "https://example.com/", options);
    expect(second.find(result => result.client === "antigravity-cli")?.status).toBe("skipped");
  });

  it("accepts friendly and migration aliases", () => {
    expect(normalizeClientSelection("agy")).toBe("antigravity-cli");
    expect(normalizeClientSelection("gemini")).toBe("antigravity-cli");
    expect(normalizeClientSelection("gemini-cli")).toBe("antigravity-cli");
    expect(normalizeClientSelection("claude")).toBeUndefined();
    expect(normalizeClientSelection("antigravity")).toBeUndefined();
    expect(normalizeClientSelection("major")).toBe("major");
    expect(normalizeClientSelection("unknown")).toBeUndefined();
  });
});
