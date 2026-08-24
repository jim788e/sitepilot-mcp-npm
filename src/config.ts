import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Scope } from "@instantbuild-sitepilot/contracts";
import { ApplicationPasswordStrategy, parseApplicationPassword } from "./auth/app-password.js";
import { BearerStrategy } from "./auth/bearer.js";
import { OAuthStrategy, type OAuthCredentials } from "./auth/oauth.js";
import type { AuthStrategy } from "./auth/strategy.js";

export interface StoredProfile {
  url: string;
  auth:
    | { kind: "app-password"; username: string; password: string; scopes?: Scope[] }
    | { kind: "bearer"; token: string; scopes?: Scope[] }
    | ({ kind: "oauth" } & OAuthCredentials);
}

interface ProfileFile {
  profiles: Record<string, StoredProfile>;
}

export interface RuntimeConfig {
  url: string;
  auth: AuthStrategy;
  profile?: string;
  apiVersion?: "v1" | "v2";
  timeoutMs: number;
  logLevel: string;
  readOnly: boolean;
  allowTier: 0 | 1 | 2 | 3;
}

export interface ConfigInput {
  url?: string;
  profile?: string;
  appPass?: string;
  user?: string;
  token?: string;
  oauth?: boolean;
  apiVersion?: "v1" | "v2";
  timeout?: string;
  logLevel?: string;
  readOnly?: boolean;
  allowTier?: string;
}

export function profilePath(): string {
  return resolve(homedir(), ".config", "sitepilot", "profiles.json");
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readProfiles(path = profilePath()): Promise<ProfileFile> {
  return await readJsonFile<ProfileFile>(path) ?? { profiles: {} };
}

export async function saveProfile(name: string, profile: StoredProfile, path = profilePath()): Promise<void> {
  const current = await readProfiles(path);
  current.profiles[name] = profile;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function deleteProfile(name: string, path = profilePath()): Promise<boolean> {
  const current = await readProfiles(path);
  if (!current.profiles[name]) return false;
  delete current.profiles[name];
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return true;
}

function strategyFromProfile(profile: StoredProfile, profileName?: string): AuthStrategy {
  if (profile.auth.kind === "app-password") {
    const strategy = new ApplicationPasswordStrategy(profile.auth.username, profile.auth.password);
    if (profile.auth.scopes) strategy.setGrantedScopes(profile.auth.scopes);
    return strategy;
  }
  if (profile.auth.kind === "bearer") return new BearerStrategy(profile.auth.token, profile.auth.scopes ?? "unknown");
  const { kind, ...credentials } = profile.auth;
  void kind;
  return new OAuthStrategy(credentials, fetch, profileName ? async next => {
    await saveProfile(profileName, { url: profile.url, auth: { kind: "oauth", ...next } });
  } : undefined);
}

function parseTier(value?: string): 0 | 1 | 2 | 3 {
  const number = Number(value ?? 3);
  if (![0, 1, 2, 3].includes(number)) throw new Error("--allow-tier must be 0, 1, 2, or 3.");
  return number as 0 | 1 | 2 | 3;
}

export async function resolveConfig(input: ConfigInput, env: NodeJS.ProcessEnv = process.env): Promise<RuntimeConfig> {
  const project = await readJsonFile<Record<string, unknown>>(resolve(process.cwd(), ".sitepilot.json")) ?? {};
  const selectedProfile = input.profile ?? env.SITEPILOT_PROFILE ?? (typeof project.profile === "string" ? project.profile : undefined);
  const stored = selectedProfile ? (await readProfiles()).profiles[selectedProfile] : undefined;
  const url = input.url ?? env.SITEPILOT_URL ?? (typeof project.url === "string" ? project.url : undefined) ?? stored?.url;
  if (!url) throw new Error("A WordPress URL is required. Pass --url, set SITEPILOT_URL, or select a saved profile.");

  let auth: AuthStrategy;
  const appPass = input.appPass ?? env.SITEPILOT_APP_PASSWORD;
  const token = input.token ?? env.SITEPILOT_TOKEN;
  if (appPass) {
    const parsed = parseApplicationPassword(appPass, input.user ?? env.SITEPILOT_USER);
    auth = new ApplicationPasswordStrategy(parsed.username, parsed.password);
  } else if (token) {
    auth = new BearerStrategy(token);
  } else if (stored) {
    auth = strategyFromProfile(stored, selectedProfile);
  } else {
    throw new Error("No credential found. Run sitepilot-mcp login or pass --app-pass/--token.");
  }

  return {
    url,
    auth,
    ...(selectedProfile ? { profile: selectedProfile } : {}),
    ...(input.apiVersion ? { apiVersion: input.apiVersion } : {}),
    timeoutMs: Number(input.timeout ?? 30_000),
    logLevel: input.logLevel ?? "info",
    readOnly: input.readOnly ?? false,
    allowTier: parseTier(input.allowTier),
  };
}
