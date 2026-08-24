import type { CallToolResult } from "@modelcontextprotocol/client";
import type { AuthStrategy } from "./auth/strategy.js";

const GUIDANCE: Record<string, string> = {
  sitepilot_scope_denied: "Widen the grant in WP Admin → SitePilot → Credentials, or run sitepilot-mcp login again with the required scopes.",
  sitepilot_not_found: "The plugin may predate the v2 endpoint. Upgrade to SitePilot MCP 0.4.0 or later, or pass --api-version v1.",
  sitepilot_version_conflict: "The site changed since planning. Run sitepilot/inspect-site and re-plan; do not retry the stale change set.",
};

function structured(result: CallToolResult): Record<string, unknown> | undefined {
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) {
    return result.structuredContent as Record<string, unknown>;
  }
  for (const item of result.content ?? []) {
    if (item.type !== "text") continue;
    try {
      const parsed = JSON.parse(item.text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Continue to the next bounded text block.
    }
  }
  return undefined;
}

export function structuredResult(result: CallToolResult): Record<string, unknown> | undefined {
  return structured(result);
}

export function renderToolResult(result: CallToolResult, siteUrl: URL, auth: AuthStrategy): CallToolResult {
  if (!result.isError) return redactResult(result, auth);
  const parsed = structured(result);
  const error = parsed?.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : parsed;
  const code = typeof error?.code === "string" ? error.code : "";
  let guidance = GUIDANCE[code];
  const status = typeof parsed?.status === "string" ? parsed.status : typeof error?.status === "string" ? error.status : "";
  if (status === "awaiting_approval") {
    guidance = `A human must approve this change in ${new URL("wp-admin/admin.php?page=sitepilot-mcp&tab=approvals", siteUrl).toString()}.`;
  }
  if (!guidance) return redactResult(result, auth);
  const content = [...(result.content ?? [])];
  content.push({ type: "text", text: auth.redact(guidance) });
  return redactResult({ ...result, content }, auth);
}

export function redactResult(result: CallToolResult, auth: AuthStrategy): CallToolResult {
  return {
    ...result,
    content: (result.content ?? []).map(item => item.type === "text" ? { ...item, text: auth.redact(item.text) } : item),
    structuredContent: deepRedact(result.structuredContent, auth),
  };
}

function deepRedact(value: unknown, auth: AuthStrategy): unknown {
  if (typeof value === "string") return auth.redact(value);
  if (Array.isArray(value)) return value.map(item => deepRedact(item, auth));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepRedact(item, auth)]),
    );
  }
  return value;
}

export function renderError(error: unknown, auth: AuthStrategy): string {
  return auth.redact(error instanceof Error ? error.message : String(error));
}
