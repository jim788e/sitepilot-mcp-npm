import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type ClientName = "cursor" | "claude-desktop" | "claude-code" | "windsurf";

interface ClientConfigOptions {
  cwd?: string;
  home?: string;
  appData?: string;
}

function configPath(client: ClientName, options: ClientConfigOptions): string {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  if (client === "cursor") return resolve(cwd, ".cursor", "mcp.json");
  if (client === "claude-code") return resolve(cwd, ".mcp.json");
  if (client === "windsurf") return resolve(home, ".codeium", "windsurf", "mcp_config.json");
  if (process.platform === "darwin") return resolve(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return resolve(options.appData ?? process.env.APPDATA ?? resolve(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
}

async function readObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} does not contain a JSON object.`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function writeClientConfig(client: ClientName, profile: string, url: string, options: ClientConfigOptions = {}): Promise<{ path: string; backup?: string }> {
  const path = configPath(client, options);
  const current = await readObject(path);
  const mcpServers = current.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers)
    ? current.mcpServers as Record<string, unknown>
    : {};
  const next = {
    ...current,
    mcpServers: {
      ...mcpServers,
      sitepilot: {
        command: "npx",
        args: ["-y", "sitepilot-mcp@latest", "--profile", profile],
        env: { SITEPILOT_URL: url },
      },
    },
  };
  await mkdir(dirname(path), { recursive: true });
  let backup: string | undefined;
  try {
    await readFile(path);
    backup = `${path}.bak`;
    await copyFile(path, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return { path, ...(backup ? { backup } : {}) };
}

export async function initializeClients(client: ClientName | "all", profile: string, url: string, options: ClientConfigOptions = {}): Promise<Array<{ client: ClientName; path: string; backup?: string }>> {
  const clients: ClientName[] = client === "all" ? ["cursor", "claude-desktop", "claude-code", "windsurf"] : [client];
  const results = [];
  for (const name of clients) results.push({ client: name, ...await writeClientConfig(name, profile, url, options) });
  return results;
}
