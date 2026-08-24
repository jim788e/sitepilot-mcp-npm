import type { AuthStrategy } from "./auth/strategy.js";

export type LogLevel = "debug" | "info" | "warning" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warning: 30, error: 40 };

export class Logger {
  constructor(
    private readonly auth: AuthStrategy,
    private readonly minimum: LogLevel = "info",
    private readonly write: (text: string) => void = text => process.stderr.write(text),
  ) {}

  log(level: LogLevel, message: string): void {
    if (ORDER[level] < ORDER[this.minimum]) return;
    this.write(`[${level}] ${this.auth.redact(message)}\n`);
  }

  debug(message: string): void { this.log("debug", message); }
  info(message: string): void { this.log("info", message); }
  warning(message: string): void { this.log("warning", message); }
  error(message: string): void { this.log("error", message); }
}
