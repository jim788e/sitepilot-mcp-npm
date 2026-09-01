import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import type { Scope } from "@instantbuild-sitepilot/contracts";
import { PACKAGE_VERSION } from "./version.js";

export type ClientName = "claude-code" | "codex" | "cursor" | "antigravity-cli" | "antigravity-ide" | "claude-desktop" | "windsurf";
export type ClientSelection = ClientName | "major" | "all";

export const MAJOR_CLIENTS: readonly ClientName[] = ["claude-code", "codex", "cursor", "antigravity-cli", "windsurf"];
export const ALL_CLIENTS: readonly ClientName[] = [...MAJOR_CLIENTS, "antigravity-ide", "claude-desktop"];

interface ClientConfigOptions {
  cwd?: string;
  home?: string;
  appData?: string;
  remote?: boolean;
  scopes?: readonly Scope[];
  installedVersion?: string;
  availableCommands?: readonly string[];
  localAppData?: string;
}

export interface ClientInitResult {
  client: ClientName;
  status: "written" | "skipped";
  path: string;
  backup?: string;
  rulesPath?: string;
  rulesBackup?: string;
  restart: string;
  reason?: string;
}

const RULES_MARKER = "<!-- sitepilot-operating-rules -->";
export const OPERATING_RULES = `${RULES_MARKER}
# SitePilot — WordPress operating rules

This project can edit a live WordPress site through the \`sitepilot\` MCP server.
The site enforces its own policy. You cannot bypass it; do not try.

## Always
1. Call \`sitepilot/inspect-site\` first. Use the reported builder. Never assume Elementor.
2. Call \`sitepilot/describe-operations\` before composing an action you have not used here before.
3. Compose changes as structured builder edits (\`design.edit_elements\`), not HTML strings. HTML enters only through \`design.compile_*_html\`, and only when the user supplied that HTML.
4. Call \`sitepilot/plan-change\` first. Read the returned diff and risk tier before executing.
5. Carry \`idempotency_key\` and the \`expected_version\` from the latest inspection on every mutation.

## Never
- Never invent a shortcode, widget type, or element id. Look it up.
- Never retry a rejected change set unchanged. Re-inspect and re-plan.
- Never ask the user to paste an application password into a file or chat.
- Never treat \`awaiting_approval\` as a failure. It is the product working.

## When approval is required
Tier 2 and Tier 3 changes stop at \`awaiting_approval\`. Give the user the approval URL, say what will change in one sentence, and wait. Approval expires in 30 minutes.

## When something fails
- \`sitepilot_scope_denied\`: name the missing scope.
- version conflict: re-inspect and re-plan; do not force.
- \`unavailable\`: continue without the cloud-only capability.
`;

function configPath(client: ClientName, options: ClientConfigOptions): string {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  if (client === "cursor") return resolve(cwd, ".cursor", "mcp.json");
  if (client === "claude-code") return resolve(cwd, ".mcp.json");
  if (client === "codex") return resolve(cwd, ".codex", "config.toml");
  if (client === "antigravity-cli") return resolve(cwd, ".agents", "mcp_config.json");
  if (client === "antigravity-ide") return resolve(home, ".gemini", "config", "mcp_config.json");
  if (client === "windsurf") return resolve(home, ".codeium", "windsurf", "mcp_config.json");
  if (process.platform === "darwin") return resolve(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return resolve(options.appData ?? process.env.APPDATA ?? resolve(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
}

function rulesPath(client: ClientName, options: ClientConfigOptions): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  if (client === "cursor") return resolve(cwd, ".cursorrules");
  if (client === "claude-code") return resolve(cwd, "CLAUDE.md");
  if (client === "codex" || client === "windsurf") return resolve(cwd, "AGENTS.md");
  if (client === "antigravity-cli") return resolve(cwd, "AGENTS.md");
  if (client === "antigravity-ide") return resolve(cwd, ".agents", "rules", "sitepilot.md");
  return undefined;
}

export function restartInstruction(client: ClientName): string {
  if (client === "cursor") return "Restart Cursor with Developer: Reload Window.";
  if (client === "claude-desktop") return "Quit and reopen Claude Desktop.";
  if (client === "claude-code") return "Restart the Claude Code session.";
  if (client === "codex") return "Trust this project in Codex so .codex/config.toml loads. Restart the Codex session, then use /mcp to verify SitePilot.";
  if (client === "antigravity-cli") return "Restart agy, then use /mcp to verify SitePilot.";
  if (client === "antigravity-ide") return "Refresh MCP servers in Antigravity Settings → Customizations, then start a new Agent session.";
  return "Restart Windsurf with Reload Window.";
}

export function normalizeClientSelection(value: string): ClientSelection | undefined {
  const aliases: Record<string, ClientName> = {
    agy: "antigravity-cli",
    gemini: "antigravity-cli",
    "gemini-cli": "antigravity-cli",
  };
  const normalized = aliases[value] ?? value;
  return [...ALL_CLIENTS, "major", "all"].includes(normalized as ClientSelection) ? normalized as ClientSelection : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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

async function backupExisting(path: string): Promise<string | undefined> {
  if (!await exists(path)) return undefined;
  const backup = `${path}.bak`;
  try {
    await copyFile(path, backup, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return backup;
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

async function writeOperatingRules(client: ClientName, options: ClientConfigOptions): Promise<{ path?: string; backup?: string }> {
  const path = rulesPath(client, options);
  if (!path) return {};
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current.includes(RULES_MARKER)) return { path };
  const backup = await backupExisting(path);
  const next = `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${OPERATING_RULES.trim()}\n`;
  await writeAtomic(path, next);
  return { path, ...(backup ? { backup } : {}) };
}

function mcpEndpoint(url: string): string {
  return new URL("wp-json/sitepilot-mcp/v2/mcp", url).toString();
}

function jsonServer(client: Exclude<ClientName, "codex">, profile: string, url: string, options: ClientConfigOptions): Record<string, unknown> {
  if (options.remote) {
    const endpoint = mcpEndpoint(url);
    if (client === "claude-code") {
      return {
        type: "http",
        url: endpoint,
        ...(options.scopes?.length ? { oauth: { scopes: options.scopes.join(" ") } } : {}),
      };
    }
    if (client === "claude-desktop") return { type: "http", url: endpoint };
    if (client === "antigravity-cli" || client === "antigravity-ide") return { serverUrl: endpoint };
    if (client === "windsurf") return { url: endpoint, transport: "http" };
    return { url: endpoint };
  }
  const server: Record<string, unknown> = {
    command: "npx",
    args: ["-y", `sitepilot-mcp@${options.installedVersion ?? PACKAGE_VERSION}`, "--profile", profile],
    env: { SITEPILOT_URL: url },
  };
  if (client === "cursor" || client === "claude-code" || client === "claude-desktop") server.type = "stdio";
  return server;
}

const CODEX_MARKER_START = "# sitepilot-mcp:start";
const CODEX_MARKER_END = "# sitepilot-mcp:end";

function codexBlock(profile: string, url: string, options: ClientConfigOptions): string {
  const lines = [CODEX_MARKER_START, "[mcp_servers.sitepilot]"];
  if (options.remote) {
    lines.push(`url = ${JSON.stringify(mcpEndpoint(url))}`);
  } else {
    lines.push('command = "npx"');
    lines.push(`args = ${JSON.stringify(["-y", `sitepilot-mcp@${options.installedVersion ?? PACKAGE_VERSION}`, "--profile", profile])}`);
    lines.push("", "[mcp_servers.sitepilot.env]", `SITEPILOT_URL = ${JSON.stringify(url)}`);
  }
  lines.push(CODEX_MARKER_END);
  return lines.join("\n");
}

function mergeCodexConfig(current: string, block: string): string {
  const marked = new RegExp(`${CODEX_MARKER_START.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[\\s\\S]*?${CODEX_MARKER_END.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u");
  if (marked.test(current)) return `${current.replace(marked, block).trimEnd()}\n`;

  const lines = current.split(/\r?\n/gu);
  const start = lines.findIndex(line => /^\s*\[mcp_servers\.sitepilot\]\s*(?:#.*)?$/u.test(line));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length) {
      const table = /^\s*\[([^\]]+)\]/u.exec(lines[end] ?? "");
      if (table && !(table[1] ?? "").startsWith("mcp_servers.sitepilot.")) break;
      end += 1;
    }
    lines.splice(start, end - start, block);
    return `${lines.join("\n").trimEnd()}\n`;
  }
  return `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
}

async function writeCodexConfig(profile: string, url: string, options: ClientConfigOptions): Promise<{ path: string; backup?: string }> {
  const path = configPath("codex", options);
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const backup = await backupExisting(path);
  await writeAtomic(path, mergeCodexConfig(current, codexBlock(profile, url, options)));
  return { path, ...(backup ? { backup } : {}) };
}

export async function writeClientConfig(client: ClientName, profile: string, url: string, options: ClientConfigOptions = {}): Promise<Omit<ClientInitResult, "client" | "status" | "restart">> {
  const path = configPath(client, options);
  let written: { path: string; backup?: string };
  if (client === "codex") {
    written = await writeCodexConfig(profile, url, options);
  } else {
    const current = await readObject(path);
    const mcpServers = current.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers)
      ? current.mcpServers as Record<string, unknown>
      : {};
    const next = { ...current, mcpServers: { ...mcpServers, sitepilot: jsonServer(client, profile, url, options) } };
    const backup = await backupExisting(path);
    await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    written = { path, ...(backup ? { backup } : {}) };
  }
  const rules = await writeOperatingRules(client, options);
  return {
    ...written,
    ...(rules.path ? { rulesPath: rules.path } : {}),
    ...(rules.backup ? { rulesBackup: rules.backup } : {}),
  };
}

async function clientIsAvailable(client: ClientName, options: ClientConfigOptions): Promise<boolean> {
  if (client === "antigravity-cli") {
    if (options.availableCommands !== undefined) return options.availableCommands.includes("agy");
    const home = options.home ?? homedir();
    if (process.platform === "win32") {
      const localAppData = options.localAppData ?? process.env.LOCALAPPDATA ?? resolve(home, "AppData", "Local");
      if (await exists(resolve(localAppData, "agy", "bin", "agy.exe"))) return true;
    }
    const executableNames = process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy.bat"] : ["agy"];
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      for (const executable of executableNames) {
        if (await exists(resolve(directory, executable))) return true;
      }
    }
    return false;
  }
  if (["cursor", "claude-code", "codex"].includes(client)) return true;
  return exists(dirname(configPath(client, options)));
}

export async function initializeClients(client: ClientSelection, profile: string, url: string, options: ClientConfigOptions = {}): Promise<ClientInitResult[]> {
  const clients: readonly ClientName[] = client === "major" ? MAJOR_CLIENTS : client === "all" ? ALL_CLIENTS : [client];
  const results: ClientInitResult[] = [];
  for (const name of clients) {
    if ((client === "major" || client === "all") && !await clientIsAvailable(name, options)) {
      results.push({
        client: name,
        status: "skipped",
        path: configPath(name, options),
        restart: restartInstruction(name),
        reason: name === "antigravity-cli" ? "agy executable not found" : "client installation not found",
      });
      continue;
    }
    results.push({ client: name, status: "written", ...await writeClientConfig(name, profile, url, options), restart: restartInstruction(name) });
  }
  return results;
}
