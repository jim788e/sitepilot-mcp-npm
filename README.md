# sitepilot-mcp

`sitepilot-mcp` is the local transport and credential adapter for a WordPress site running the SitePilot MCP plugin. WordPress remains the policy-enforcement point: this package forwards the site's live `tools/list` and `tools/call` surface and does not register independent tools or safety policy.

## Quick start

Requires Node.js 22 or later and an HTTPS WordPress site with SitePilot MCP 0.4.8 or later.

```sh
npx sitepilot-mcp login --url https://wordpress.example --scopes site:read
npx sitepilot-mcp init --client cursor --profile wordpress-example
```

Restart the client after `init`. Application Password login is the default; add `--oauth` for OAuth 2.1 with PKCE. Saved secrets live in `~/.config/sitepilot/profiles.json`, are written with mode `0600` where the OS supports it, and are referenced—not copied—by generated client configuration.

The quick start intentionally resolves the current npm release. The generated client configuration does not: `init` writes the exact installed package version (for example, `sitepilot-mcp@0.1.4`) so a client restart cannot silently change the executable.

Run directly without a saved profile:

```sh
npx sitepilot-mcp --profile wordpress-example --transport http --port 8770
```

The HTTP transport binds to loopback and serves `/mcp`. Clients that support remote MCP and OAuth discovery can instead connect directly to `https://wordpress.example/wp-json/sitepilot-mcp/v2/mcp` without this package.

## Client setup

`init` merges the `sitepilot` entry into an existing configuration and creates one pristine `.bak` copy before the first edit. Later runs preserve that original backup. It never writes a credential into a client file.

The primary compatibility matrix covers five independent coding-agent products: Claude Code, Codex, Cursor, Antigravity CLI, and Windsurf. Google replaced Gemini CLI with Antigravity CLI; its executable is `agy`. Antigravity IDE and Claude Desktop remain supported secondary installation targets and are verified separately rather than counted as additional products.

| Client | Configuration | Operating rules | Restart instruction |
|---|---|---|---|
| Claude Code (primary) | `.mcp.json` | `CLAUDE.md` | Restart the Claude Code session |
| Codex (primary) | `.codex/config.toml` | `AGENTS.md` | Trust the project so Codex loads project-scoped configuration; restart the session; verify with `/mcp` |
| Cursor (primary) | `.cursor/mcp.json` | `.cursorrules` | Developer: Reload Window |
| Antigravity CLI (primary; `agy` alias) | `.agents/mcp_config.json` | `AGENTS.md` | Restart `agy`; verify with `/mcp` |
| Antigravity IDE | `~/.gemini/config/mcp_config.json` | `.agents/rules/sitepilot.md` | Refresh MCP servers; start a new Agent session |
| Claude Desktop | platform Claude config | Site playbooks | Quit and reopen Claude Desktop |
| Windsurf (primary) | `~/.codeium/windsurf/mcp_config.json` | `AGENTS.md` | Reload Window |

Use `--client major` for the Owner-approved five-product primary set, or `--client all` to include Antigravity IDE and Claude Desktop. Clients without an independent installation marker are reported as skipped. SitePilot writes each client's documented local and remote field shape rather than treating the formats as interchangeable. Use `--remote` for native Streamable HTTP plus OAuth discovery:

```sh
npx sitepilot-mcp init --client codex --remote --url https://wordpress.example
```

That writes only the HTTPS MCP URL and transport. The npm command and local profile reference are omitted. The WordPress plugin also advertises editable site playbooks through `prompts/list`; bodies are fetched lazily with `prompts/get`, labelled as untrusted site-authored instructions, and never grant scope or approval.

Claude Code uses OAuth discovery when no scopes are supplied. To cap its request deliberately, pass `init --client claude-code --remote --scopes site:read,content:write`; the generated `oauth.scopes` value is a ceiling, not a hint. The flag is rejected for every other client selection, including `major` and `all`, because those generated formats do not encode an equivalent ceiling. When `--profile` names a saved credential and `--scopes` is omitted, `init` reuses that profile's granted scopes only if its normalized site URL matches the requested remote URL; a mismatch stops before any client configuration is written.

Zed, Cline, Warp, Continue, OpenCode, VS Code with Copilot, and other standards-compatible clients can use the same exact-version stdio command or canonical remote URL. They are generic MCP compatibility targets until their own real-install acceptance run is recorded; they are not silently counted as passed by the five-client matrix.

## Commands

```text
sitepilot-mcp login --url <url> [--oauth] [--scopes a,b] [--label text]
sitepilot-mcp logout --profile <name>
sitepilot-mcp init --client claude-code|claude-desktop|codex|cursor|agy|antigravity-cli|antigravity-ide|windsurf|major|all (--profile <name> | --remote --url <url>)
sitepilot-mcp init --client claude-code --remote (--profile <name> | --url <url>) [--scopes a,b]
sitepilot-mcp doctor --url <url>
sitepilot-mcp tools --url <url> [--json]
sitepilot-mcp call <tool> --input @plan.json [--dry-run]
```

Common flags: `--profile`, `--api-version v1|v2`, `--timeout`, `--read-only`, `--allow-tier 0|1|2|3`, and `--version`.

For migration compatibility, the former `gemini` and `gemini-cli` selections map to `antigravity-cli`; new documentation and generated output use `agy`/`antigravity-cli`.

Ambiguous family aliases are rejected: use `claude-code` or `claude-desktop`, and `antigravity-cli`/`agy` or `antigravity-ide`.

`--read-only` and `--allow-tier` are local ergonomics that avoid unwanted attempts. They are not a security boundary. WordPress capabilities, bounded credential scopes, risk classification, approvals, optimistic concurrency, auditing, and rollback remain authoritative in the plugin.

Before forwarding `execute-change` or `rollback-change`, the client performs one additional `get-change-status` call so it can enforce the local `--allow-tier` preference. The requested mutation and its arguments are otherwise forwarded unchanged; WordPress remains authoritative.

Run `sitepilot-mcp doctor` to distinguish insecure HTTP, unreachable REST, missing or inactive plugin, stripped authorization headers, invalid or revoked credentials, and insufficient scopes.

## License

Apache-2.0. The WordPress plugin is licensed separately under AGPL-3.0-or-later.
