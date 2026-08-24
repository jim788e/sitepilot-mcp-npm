import type { Scope } from "@instantbuild-sitepilot/contracts";
import type { AuthStrategy } from "./strategy.js";
import { redactValues } from "./strategy.js";

export class ApplicationPasswordStrategy implements AuthStrategy {
  readonly kind = "app-password" as const;
  private scopes: Scope[] | "unknown" = "unknown";

  constructor(
    readonly username: string,
    private readonly password: string,
  ) {
    if (!username || !password) throw new Error("Application Password authentication requires both a WordPress username and password.");
  }

  async headers(): Promise<Record<string, string>> {
    return { authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}` };
  }

  async refresh(): Promise<boolean> {
    return false;
  }

  async grantedScopes(): Promise<Scope[] | "unknown"> {
    return this.scopes;
  }

  setGrantedScopes(scopes: Scope[]): void {
    this.scopes = [...scopes];
  }

  redact(text: string): string {
    const encoded = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    return redactValues(text, [this.password, `${this.username}:${this.password}`, encoded]);
  }
}

export function parseApplicationPassword(value: string, fallbackUsername?: string): { username: string; password: string } {
  const separator = value.indexOf(":");
  if (separator > 0) {
    return { username: value.slice(0, separator), password: value.slice(separator + 1) };
  }
  if (!fallbackUsername) {
    throw new Error("Pass --user with --app-pass, or use --app-pass user:application-password.");
  }
  return { username: fallbackUsername, password: value };
}
