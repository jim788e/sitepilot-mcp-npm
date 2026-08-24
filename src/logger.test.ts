import { describe, expect, it } from "vitest";
import { BearerStrategy } from "./auth/bearer.js";
import { Logger, type LogLevel } from "./logger.js";

describe("logger redaction", () => {
  it("redacts credentials at every log level", () => {
    const output: string[] = [];
    const logger = new Logger(new BearerStrategy("synthetic-secret"), "debug", text => output.push(text));
    for (const level of ["debug", "info", "warning", "error"] as LogLevel[]) logger.log(level, `${level} synthetic-secret`);
    expect(output).toHaveLength(4);
    expect(output.join("")) .not.toContain("synthetic-secret");
  });
});
