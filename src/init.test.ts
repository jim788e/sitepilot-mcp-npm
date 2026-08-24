import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveProfile } from "./config.js";
import { writeClientConfig } from "./init.js";

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
    expect(text).toContain("sitepilot-mcp@latest");
    expect(text).toContain("example-prod");
    expect(text).toContain("existing");
    expect(text).toContain('"keep": true');
    expect(text).not.toContain("private-app-password");
    expect(await readFile(profileFile, "utf8")).toContain("private-app-password");
    expect(result.backup).toBe(`${configPath}.bak`);
  });
});
