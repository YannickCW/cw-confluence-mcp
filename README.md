# cw-confluence-mcp

A local **MCP server** that gives Claude Code structured, authenticated access to **Confluence Cloud**. Browse spaces, read and author pages, search content, and manage page conversations (footer + inline comments) — all from inside an MCP client like Claude Code.

Full design: [`docs/superpowers/specs/2026-05-18-cw-confluence-mcp-design.md`](docs/superpowers/specs/2026-05-18-cw-confluence-mcp-design.md).

## What it does (22 tools)

| Domain | Tools |
|---|---|
| Spaces | `space_list`, `space_get`, `space_search` |
| Pages — read | `page_list`, `page_get`, `page_get_children`, `page_get_ancestors`, `page_search` |
| Pages — write | `page_create`, `page_update` |
| Page versions | `page_versions_list`, `page_version_get` |
| Comments | `comments_list`, `comment_get`, `comment_create`, `comment_update`, `comment_resolve`, `comment_reopen` |
| Labels | `labels_list`, `pages_by_label` |
| Attachments | `attachments_list`, `attachment_get` |

The MCP is a **reader, author, and reviewer**. Destructive and admin operations (delete, move, restore, archive, label-add/remove, attachment upload) are deliberately out of scope and live with a human in the Confluence UI.

## Install

```bash
git clone <repo-url> cw-confluence-mcp
cd cw-confluence-mcp
npm install
npm run build
npm link            # makes `cw-confluence-mcp` available on your PATH
```

Requires **Node.js 20 LTS or newer**.

## First-time setup — `auth login`

You need an Atlassian API token (not your account password). Create one at <https://id.atlassian.com> → Security → API tokens.

```bash
cw-confluence-mcp auth login
```

You'll be prompted for three things:

1. **Site** — e.g. `cloudwise.atlassian.net` (just the hostname; scheme and `/wiki` are stripped automatically).
2. **Email** — your Atlassian account email.
3. **Token** — the API token you just created. Entered with a masked prompt.

The CLI verifies the credentials against `GET /wiki/api/v2/users/current` before saving. On success it prints `Logged in as <name> (<email>) on <site>` and stores the blob in your OS keychain (Windows Credential Manager / macOS Keychain / Linux libsecret). On failure, nothing is persisted — fix the issue and try again.

Other auth commands:

| Command | Behaviour |
|---|---|
| `cw-confluence-mcp auth status` | Prints `Logged in as <email> on <site>` if credentials exist, else `Not logged in`. **Never prints the token.** |
| `cw-confluence-mcp auth test` | Re-runs the verify call against the stored credentials. Use to diagnose 401s. |
| `cw-confluence-mcp auth logout` | Deletes the keychain entry. Idempotent. |

### Optional escape hatch — environment variables

For CI or sandbox use, set:

```bash
export CONFLUENCE_MCP_USE_ENV=1
export CONFLUENCE_SITE=cloudwise.atlassian.net
export CONFLUENCE_EMAIL=you@example.com
export CONFLUENCE_TOKEN=ATATT...
```

The server reads env vars **only** when `CONFLUENCE_MCP_USE_ENV=1`. The keychain is still preferred — env is a fallback.

## Register with Claude Code

Add an entry to your `.mcp.json` (project-local) or Claude Code's global MCP config:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "cw-confluence-mcp",
      "args": ["serve"]
    }
  }
}
```

If you didn't `npm link`, point at the absolute path of the dispatcher instead:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "node",
      "args": ["C:\\path\\to\\cw-confluence-mcp\\bin\\cw-confluence-mcp.js", "serve"]
    }
  }
}
```

Restart Claude Code. The 22 tools become available with the `mcp__confluence__` prefix.

## Run manually

```bash
cw-confluence-mcp serve     # default — start the stdio MCP server
cw-confluence-mcp --help    # subcommand list
```

The server logs operational info to **stderr**; **stdout** is reserved for MCP JSON-RPC traffic. Tokens are auto-redacted from all log output and error payloads.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `No credentials found. Run "cw-confluence-mcp auth login" first.` | The server can't find a keychain entry. Run the login command. If you're in a CI / sandbox, set the `CONFLUENCE_MCP_USE_ENV=1` trio. |
| Tool returns `unauthorized` (401) | Token is expired or revoked. Run `cw-confluence-mcp auth login` again with a fresh token from id.atlassian.com. |
| Tool returns `forbidden` (403) | The account doesn't have permission for that space/page/comment. Either grant access in Confluence or work with a different resource. |
| Tool returns `rate_limited` (429) with `retry_after` | The server has already retried up to 3 times — Confluence is throttling. Wait `retry_after` seconds before retrying. |
| Tool returns `marker_ambiguous` on `comment_create` with `inline.text_marker` | The substring appears more than once in the page body. Supply `inline.occurrence` (1-indexed) to pick which match to anchor to. |
| Tool returns `marker_not_found` on `comment_create` | The substring isn't in the page's rendered text. Check the marker against the page in a browser; remember that the resolver collapses whitespace and strips XHTML tags. |
| Tool returns `version_conflict` | Someone else updated the page between your fetch and your update. The client already retried once; the second attempt also conflicted. Re-read the page and try again. |
| Server boots but lists `Logged in as … on …` for the wrong site | Run `cw-confluence-mcp auth logout` then `cw-confluence-mcp auth login` with the correct site. |

## Develop

```bash
npm run dev              # run via tsx (no build step)
npm run test             # unit tests (vitest) — 335 currently
npm run test:integration # live tests against Confluence (skipped by default; needs CONFLUENCE_TEST_* env)
npm run lint             # eslint
npm run build            # tsc → ./dist
```

Integration tests need:

```bash
export CONFLUENCE_TEST_SITE=cloudwise.atlassian.net
export CONFLUENCE_TEST_SPACE=DEV
export CONFLUENCE_TEST_PAGE_ID=12345
export CONFLUENCE_EMAIL=you@example.com
export CONFLUENCE_TOKEN=ATATT...
```

## License

Internal — Cloudwise.
