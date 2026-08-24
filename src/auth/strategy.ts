import type { Scope } from "@instantbuild-sitepilot/contracts";

export interface AuthStrategy {
  readonly kind: "app-password" | "oauth" | "bearer";
  headers(): Promise<Record<string, string>>;
  refresh(): Promise<boolean>;
  grantedScopes(): Promise<Scope[] | "unknown">;
  redact(text: string): string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function authenticatedFetch(strategy: AuthStrategy, fetchImpl: FetchLike = fetch): FetchLike {
  return async (input, init = {}) => {
    const send = async (): Promise<Response> => {
      const headers = new Headers(init.headers);
      for (const [name, value] of Object.entries(await strategy.headers())) headers.set(name, value);
      return fetchImpl(input, { ...init, headers });
    };
    let response = await send();
    if (response.status === 401 && await strategy.refresh()) response = await send();
    return response;
  };
}

export function redactValues(text: string, values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, value) => redacted.replaceAll(value, "[REDACTED]"), text);
}
