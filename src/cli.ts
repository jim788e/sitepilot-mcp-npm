#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Scope } from "@instantbuild-sitepilot/contracts";
import { OAuthStrategy } from "./auth/oauth.js";
import { deleteProfile, readProfiles, resolveConfig, type ConfigInput, type StoredProfile } from "./config.js";
import { diagnose } from "./doctor.js";
import { assertSecureSiteUrl, normalizeSiteUrl } from "./discovery.js";
import { initializeClients, normalizeClientSelection, type ClientSelection } from "./init.js";
import { login, parseScopeList } from "./login.js";
import { runPreflight } from "./preflight.js";
import { RemoteMcpClient } from "./proxy.js";
import { structuredResult } from "./render.js";
import { serveSitePilotHttp } from "./transport/http.js";
import { serveSitePilotStdio } from "./transport/stdio.js";
import { PACKAGE_VERSION } from "./version.js";

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
  remote?: boolean;
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
    if (["oauth", "readOnly", "json", "dryRun", "remote", "version", "noColor"].includes(name)) result[name] = inline === undefined ? true : inline !== "false";
    else result[name] = inline ?? args.shift();
  }
  return result as unknown as ParsedArgs;
}

export function initScopeSelection(value: string | undefined, profile: StoredProfile | undefined): Scope[] | undefined {
  if (value !== undefined) return parseScopeList(value);
  const granted = profile?.auth.scopes;
  return granted?.length ? [...new Set(granted)] : undefined;
}

export function assertInitScopeClient(client: ClientSelection, value: string | undefined): void {
  if (value !== undefined && client !== "claude-code") {
    throw new Error("sitepilot-mcp init --scopes is supported only with --client claude-code.");
  }
}

export function assertProfileMatchesRemote(name: string, profile: StoredProfile | undefined, remoteUrl: string): void {
  const profileUrl = profile ? normalizeSiteUrl(profile.url).toString() : undefined;
  if (profileUrl && profileUrl !== remoteUrl) throw new Error(`Profile ${name} belongs to ${profileUrl}, not ${remoteUrl}.`);
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
    print(PACKAGE_VERSION);
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
    print(`Saved profile ${result.profile}. Granted ${result.scopes.join(", ")} via ${result.authKind}. ${result.summary}.`);
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
    if (args.scopes !== undefined && !args.remote) throw new Error("sitepilot-mcp init --scopes requires --remote.");
    const client = normalizeClientSelection(args.client ?? "all");
    if (!client) throw new Error("--client must be claude-code, claude-desktop, codex, cursor, agy, antigravity-cli, antigravity-ide, windsurf, major, or all.");
    assertInitScopeClient(client, args.scopes);
    let name = args.profile ?? process.env.SITEPILOT_PROFILE;
    let url: string;
    let storedProfile: StoredProfile | undefined;
    if (args.remote && args.url) {
      const remoteUrl = normalizeSiteUrl(args.url);
      assertSecureSiteUrl(remoteUrl);
      url = remoteUrl.toString();
      name ??= `remote-${remoteUrl.hostname.replace(/[^a-z0-9-]+/giu, "-").toLowerCase()}`;
      storedProfile = (await readProfiles()).profiles[name];
      assertProfileMatchesRemote(name, storedProfile, url);
    } else {
      if (!name) throw new Error("sitepilot-mcp init requires --profile, or --remote with --url.");
      storedProfile = (await readProfiles()).profiles[name];
      if (!storedProfile) throw new Error(`Profile ${name} does not exist. Run sitepilot-mcp login first.`);
      url = storedProfile.url;
    }
    const scopes = initScopeSelection(args.scopes, storedProfile);
    const results = await initializeClients(client, name, url, {
      remote: args.remote ?? false,
      ...(scopes ? { scopes } : {}),
    });
    for (const result of results) {
      if (result.status === "skipped") print(`${result.client}: skipped (${result.reason})`);
      else print(`${result.client}: ${result.path}${result.rulesPath ? ` + ${result.rulesPath}` : ""}${result.backup ? ` (backup ${result.backup})` : ""}`);
    }
    for (const instruction of [...new Set(results.filter(result => result.status === "written").map(result => result.restart))]) print(instruction);
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const text = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${text}\n`);
    process.exitCode = 1;
  });
}
