import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { BearerStrategy } from "./auth/bearer.js";
import { renderError, renderToolResult } from "./render.js";

describe("result rendering", () => {
  it("adds actionable scope guidance while redacting every text block", () => {
    const auth = new BearerStrategy("synthetic-secret");
    const payload = { ok: false, error: { code: "sitepilot_scope_denied", message: "synthetic-secret denied" } };
    const result: CallToolResult = {
      isError: true,
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
    const rendered = renderToolResult(result, new URL("https://example.com/"), auth);
    const text = rendered.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    expect(text).toContain("WP Admin");
    expect(text).not.toContain("synthetic-secret");
    expect(renderError(new Error("synthetic-secret failed"), auth)).toBe("[REDACTED] failed");
  });

  it("preserves successful result meaning while redacting every model-visible string", () => {
    const auth = new BearerStrategy("synthetic-secret");
    const result: CallToolResult = {
      content: [{ type: "text", text: "Bearer synthetic-secret" }],
      structuredContent: {
        ok: true,
        nested: { message: "password=synthetic-secret" },
        values: ["synthetic-secret", 42],
      },
    };
    expect(renderToolResult(result, new URL("https://example.com/"), auth)).toEqual({
      content: [{ type: "text", text: "Bearer [REDACTED]" }],
      structuredContent: {
        ok: true,
        nested: { message: "password=[REDACTED]" },
        values: ["[REDACTED]", 42],
      },
    });
  });
});
