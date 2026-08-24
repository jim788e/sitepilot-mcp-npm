import type { Scope } from "@instantbuild-sitepilot/contracts";
import type { AuthStrategy } from "./strategy.js";
import { redactValues } from "./strategy.js";

export class BearerStrategy implements AuthStrategy {
  readonly kind = "bearer" as const;

  constructor(private readonly token: string, private readonly scopes: Scope[] | "unknown" = "unknown") {
    if (!token) throw new Error("Bearer authentication requires a token.");
  }

  async headers(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${this.token}` };
  }

  async refresh(): Promise<boolean> {
    return false;
  }

  async grantedScopes(): Promise<Scope[] | "unknown"> {
    return this.scopes;
  }

  redact(text: string): string {
    return redactValues(text, [this.token]);
  }
}
