#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import type { Scope } from "@instantbuild-sitepilot/contracts";
import { OAuthStrategy } from "./auth/oauth.js";
import { deleteProfile, readProfiles, resolveConfig, type ConfigInput } from "./config.js";
import { diagnose } from "./doctor.js";
import { initializeClients, type ClientName } from "./init.js";
import { login, parseScopeList } from "./login.js";
import { runPreflight } from "./preflight.js";
import { RemoteMcpClient } from "./proxy.js";
import { structuredResult } from "./render.js";
import { serveSitePilotHttp } from "./transport/http.js";
import { serveSitePilotStdio } from "./transport/stdio.js";

const VERSION = "0.1.0";
const COMMANDS = new Set(["login", "logout", "init", "doctor", "tools", "call"]);

interface ParsedArgs extends ConfigInput {
  command?: string;
  positionals: string[];
  transport?: string;
  port?: string;
  client?: string;
  scopes?: string;
  label?: string;
  input?: string;
  json?: boolean;
  dryRun?: boolean;
  version?: boolean;
  noColor?: boolean;
}

function camel(name: string): string {
  return name.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: Record<string, unknown> = { positionals: [] };
  const args = [...argv];
  if (args[0] && COMMANDS.has(args[0])) result.command = args.shift();
  while (args.length) {
    const value = args.shift()!;
    if (!value.startsWith("--")) {
      (result.positionals as string[]).push(value);
      continue;
    }
    const [rawName, inline] = value.slice(2).split(/=(.*)/su, 2);
    if (!rawName) continue;
    const name = camel(rawName);
    if (["oauth", "readOnly", "json", "dryRun", "version", "noColor"].includes(name)) result[name] = inline === undefined ? true : inline !== "false";
    else result[name] = inline ?? args.shift();
  }
  return result as unknown as ParsedArgs;
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

async function inputJson(value?: string): Promise<Record<string, unknown>> {
  if (!value) return {};
  const text = value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--input must be a JSON object or @path to one.");
  return parsed as Record<string, unknown>;
}

async function runRemoteCommand(args: ParsedArgs): Promise<void> {
  const config = await resolveConfig(args);
  const remote = new RemoteMcpClient(config.url, config.auth, {
    ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
    timeoutMs: config.timeoutMs,
  });
  try {
    const state = await runPreflight(remote, config.auth);
    if (args.command === "tools") {
      print(args.json ? state.tools : state.tools.tools.map(tool => tool.name).join("\n"));
      return;
    }
    const tool = args.positionals[0];
    if (!tool) throw new Error("sitepilot-mcp call requires a tool name.");
    const call = { name: tool, arguments: await inputJson(args.input) };
    if (args.dryRun) {
      print({ sent: false, call });
      return;
    }
    const result = await remote.callTool(call);
    print(args.json ? result : structuredResult(result) ?? result);
  } finally {
    await remote.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    print(VERSION);
    return;
  }
  if (args.command === "login") {
    if (!args.url) throw new Error("sitepilot-mcp login requires --url.");
    const result = await login({
      url: args.url,
      ...(args.scopes ? { scopes: args.scopes } : {}),
      ...(args.label ? { label: args.label } : {}),
      ...(args.profile ? { profile: args.profile } : {}),
      oauth: args.oauth ?? false,
    });
    print(`Saved profile ${result.profile}. Granted ${result.scopes.join(", ")} via ${result.authKind}.`);
    return;
  }
  if (args.command === "logout") {
    const name = args.profile;
    if (!name) throw new Error("sitepilot-mcp logout requires --profile.");
    const profile = (await readProfiles()).profiles[name];
    if (profile?.auth.kind === "oauth") await new OAuthStrategy(profile.auth).revoke();
    print(await deleteProfile(name) ? `Removed profile ${name}.` : `Profile ${name} did not exist.`);
    return;
  }
  if (args.command === "init") {
    const name = args.profile ?? process.env.SITEPILOT_PROFILE;
    if (!name) throw new Error("sitepilot-mcp init requires --profile or SITEPILOT_PROFILE.");
    const profile = (await readProfiles()).profiles[name];
    if (!profile) throw new Error(`Profile ${name} does not exist. Run sitepilot-mcp login first.`);
    const client = (args.client ?? "all") as ClientName | "all";
    if (!["cursor", "claude-desktop", "claude-code", "windsurf", "all"].includes(client)) throw new Error("--client must be cursor, claude-desktop, claude-code, windsurf, or all.");
    const results = await initializeClients(client, name, profile.url);
    for (const result of results) print(`${result.client}: ${result.path}${result.backup ? ` (backup ${result.backup})` : ""}`);
    print("Restart the configured client to load SitePilot MCP.");
    return;
  }
  if (args.command === "doctor") {
    const config = await resolveConfig(args);
    const scopes: Scope[] = args.scopes ? parseScopeList(args.scopes) : ["site:read"];
    const result = await diagnose(config, scopes);
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (args.command === "tools" || args.command === "call") {
    await runRemoteCommand(args);
    return;
  }
  const config = await resolveConfig(args);
  if ((args.transport ?? "stdio") === "http") {
    await serveSitePilotHttp(config, Number(args.port ?? 8770));
  } else {
    serveSitePilotStdio(config);
  }
}

main().catch(error => {
  const text = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${text}\n`);
  process.exitCode = 1;
});
