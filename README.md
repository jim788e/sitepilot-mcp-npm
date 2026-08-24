# sitepilot-mcp

`sitepilot-mcp` is the local transport and credential adapter for a WordPress site running the SitePilot MCP plugin. WordPress remains the policy-enforcement point: this package forwards the site's live `tools/list` and `tools/call` surface and does not register independent tools or safety policy.

## Quick start

Requires Node.js 22 or later and an HTTPS WordPress site with SitePilot MCP 0.4.6 or later.

```sh
npx sitepilot-mcp login --url https://wordpress.example --scopes site:read
npx sitepilot-mcp init --client cursor --profile wordpress-example
```

Restart the client after `init`. Application Password login is the default; add `--oauth` for OAuth 2.1 with PKCE. Saved secrets live in `~/.config/sitepilot/profiles.json`, are written with mode `0600` where the OS supports it, and are referenced—not copied—by generated client configuration.

Run directly without a saved profile:

```sh
npx sitepilot-mcp --url https://wordpress.example --user alice --app-pass xxxx-xxxx-xxxx-xxxx
npx sitepilot-mcp --url https://wordpress.example --token opaque-token
npx sitepilot-mcp --profile wordpress-example --transport http --port 8770
```

The HTTP transport binds to loopback and serves `/mcp`. Clients that support remote MCP and OAuth discovery can instead connect directly to `https://wordpress.example/wp-json/sitepilot-mcp/v2/mcp` without this package.

## Commands

```text
sitepilot-mcp login --url <url> [--oauth] [--scopes a,b] [--label text]
sitepilot-mcp logout --profile <name>
sitepilot-mcp init --client cursor|claude-desktop|claude-code|windsurf|all --profile <name>
sitepilot-mcp doctor --url <url>
sitepilot-mcp tools --url <url> [--json]
sitepilot-mcp call <tool> --input @plan.json [--dry-run]
```

Common flags: `--profile`, `--api-version v1|v2`, `--timeout`, `--read-only`, `--allow-tier 0|1|2|3`, and `--version`.

`--read-only` and `--allow-tier` are local ergonomics that avoid unwanted attempts. They are not a security boundary. WordPress capabilities, bounded credential scopes, risk classification, approvals, optimistic concurrency, auditing, and rollback remain authoritative in the plugin.

Before forwarding `execute-change` or `rollback-change`, the client performs one additional `get-change-status` call so it can enforce the local `--allow-tier` preference. The requested mutation and its arguments are otherwise forwarded unchanged; WordPress remains authoritative.

Run `sitepilot-mcp doctor` to distinguish insecure HTTP, unreachable REST, missing or inactive plugin, stripped authorization headers, invalid or revoked credentials, and insufficient scopes.

## License

Apache-2.0. The WordPress plugin is licensed separately under AGPL-3.0-or-later.
