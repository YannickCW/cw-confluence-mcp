# cw-confluence-mcp

Local MCP server for **Confluence Cloud** — gives Claude Code structured access to browse spaces, read and author pages, search content, manage page conversations (footer + inline comments), and read labels and attachment metadata.

## Tools (22, across 7 domains)

- **Spaces** — `space_list`, `space_get`, `space_search`
- **Pages — read** — `page_list`, `page_get`, `page_get_children`, `page_get_ancestors`, `page_search`
- **Pages — write** — `page_create`, `page_update`
- **Page versions** — `page_versions_list`, `page_version_get`
- **Comments** — `comments_list`, `comment_get`, `comment_create`, `comment_update`, `comment_resolve`, `comment_reopen`
- **Labels** — `labels_list`, `pages_by_label`
- **Attachments** — `attachments_list`, `attachment_get`

The MCP is a **reader, author, and reviewer**. Destructive and admin operations (delete, move, restore, archive, label add/remove, attachment upload) are deliberately out of scope and stay with a human in the Confluence UI.

## Requirements

- Node.js 20 LTS or newer
- Access to the Cloudwise Azure DevOps feed (`heutinkict / MOO / MOO.Shared`) — needed to install the package
- An Atlassian API token for Confluence — see [First-time auth](#first-time-auth) below for how to create one with the right scopes

## Install (from the internal Azure DevOps feed — recommended)

The package is published to `heutinkict / MOO / MOO.Shared` on Azure DevOps Artifacts (you'll need access to that feed).

1. Add the scoped registry to your **user-level** `.npmrc` (at `%USERPROFILE%\.npmrc` on Windows, `~/.npmrc` on macOS/Linux) so `@cloudwise/*` packages resolve to the internal feed (everything else keeps using the public npm registry):

   ```
   @cloudwise:registry=https://pkgs.dev.azure.com/heutinkict/MOO/_packaging/MOO.Shared/npm/registry/
   always-auth=true
   ```

   > ⚠️ **This line is required.** Without it, `npm install -g @cloudwise/cw-confluence-mcp` will fail with a 401 / 403 — npm doesn't know to route `@cloudwise/*` packages to the internal feed and tries the public registry instead.

2. Authenticate. On Windows the easiest path is `vsts-npm-auth` (you probably already did this for other packages):

   ```sh
   npm install -g vsts-npm-auth
   vsts-npm-auth -config %USERPROFILE%\.npmrc
   ```

   Or paste a personal access token (with `Packaging (read)` scope) into your `.npmrc` — see the *Connect to feed* button on the Azure DevOps feed page for a ready-made snippet.

3. Install globally:

   ```sh
   npm install -g @cloudwise/cw-confluence-mcp
   ```

   The `cw-confluence-mcp` binary is now on your PATH.

## Install (from source — for development)

```sh
git clone <repo-url> cw-confluence-mcp
cd cw-confluence-mcp
npm install
npm run build
npm link
```

After `npm link`, `cw-confluence-mcp` is on your PATH.

## First-time auth

The MCP authenticates to Confluence using an **Atlassian API token** — created once per user, stored in your OS keychain. The whole flow takes 2–3 minutes.

### Step 1 — Create an Atlassian API token

1. Open [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) and sign in.
2. Click **Create API token with scopes**.
3. **Name** it something memorable — e.g. `cw-confluence-mcp`.
4. Pick an **expiry** that matches your team's policy (typical: 1 year — Atlassian also lets you set "no expiry", but a renewable token is safer).
5. Select **Confluence** as the app.
6. Grant the following scopes:

   | Scope | Why we need it |
   |---|---|
   | `read:account` | The `auth test` + `auth login` verify steps call `GET /wiki/api/v2/users/current` |
   | `read:space:confluence` | Listing and searching spaces |
   | `read:page:confluence` | Reading pages, children, ancestors, versions, and page search |
   | `write:page:confluence` | `page_create` and `page_update` |
   | `read:comment:confluence` | Reading footer and inline comments |
   | `write:comment:confluence` | Creating, replying, updating, resolving, and reopening comments |
   | `read:attachment:confluence` | Listing attachments and reading attachment metadata |

   > Atlassian's "classic" unscoped API tokens also work and inherit all your Confluence permissions, but the scoped form above is the principle-of-least-privilege option. If a scoped token is rejected for an operation we expect to work, double-check the exact scope name against Atlassian's current docs — they have changed names in the past.

7. Click **Create** and **copy the token immediately** — Atlassian shows it only once.

### Step 2 — Store the token via `auth login`

```sh
cw-confluence-mcp auth login
```

You'll be prompted for:

1. **Site** — e.g. `cloudwise.atlassian.net` (just the hostname; scheme and `/wiki` are stripped automatically).
2. **Email** — your Atlassian account email.
3. **Token** — the API token from Step 1; paste it; input is masked.

The CLI verifies the credentials against `GET /wiki/api/v2/users/current` before saving. On success it prints `Logged in as <name> (<email>) on <site>` and stores the blob in your OS-native keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service) under service `cw-confluence-mcp`, account `default`. On failure, nothing is persisted — fix the issue and try again.

The token is never written to disk in plaintext, never logged, and never returned in any tool response (the logger has a defence-in-depth redactor that masks the token verbatim, the `email:token` base64 credential, and any `Authorization: Basic ...` header).

### Step 3 — Verify

```sh
cw-confluence-mcp auth status   # → "Logged in as you@example.com on cloudwise.atlassian.net" (or "Not logged in")
cw-confluence-mcp auth test     # → re-runs the verify call against the stored credentials
```

If `auth test` prints `Logged in as <your display name>`, you're ready to register the server with your MCP client (next section).

### Clearing credentials

```sh
cw-confluence-mcp auth logout
```

Idempotent — running it when no credentials are stored is a no-op.

## Register the server with Claude Code

Add a `.mcp.json` at the root of your Claude Code project (or `~/.claude.json` for user-wide):

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

If you didn't `npm link`, point at the absolute path of the bin entry instead:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "node",
      "args": ["/absolute/path/to/cw-confluence-mcp/bin/cw-confluence-mcp.js", "serve"]
    }
  }
}
```

Restart Claude Code (or run `/mcp` to refresh). The `confluence` server should show as connected with 22 tools.

## Register the server with GitHub Copilot

MCP is a standard protocol, so any MCP-compliant client works. The config syntax differs per client; the `auth login` flow is identical.

### VS Code Copilot (agent mode)

Add a `.vscode/mcp.json` at the workspace root:

```json
{
  "servers": {
    "confluence": {
      "type": "stdio",
      "command": "cw-confluence-mcp",
      "args": ["serve"]
    }
  }
}
```

If you didn't `npm link`, use the absolute path variant:

```json
{
  "servers": {
    "confluence": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/cw-confluence-mcp/bin/cw-confluence-mcp.js", "serve"]
    }
  }
}
```

Differences from the Claude Code config: the top-level key is `servers` (not `mcpServers`) and each entry needs `"type": "stdio"`. Reload VS Code and open Copilot Chat in agent mode; the server should appear in the tools picker.

### GitHub Copilot CLI

GitHub Copilot CLI also supports MCP. The config file location and exact schema are documented at [GitHub's Copilot docs](https://docs.github.com/copilot) — please refer to those for the authoritative format. The `command` / `args` will be the same as above.

### Note

The Copilot side hasn't been smoke-tested by the author yet — the server itself doesn't care which MCP client connects, so it *should* work, but please flag back if anything misbehaves.

## Quick smoke

Once the server is registered, try:

> "Use the confluence MCP to list spaces."

Claude Code should call `space_list` and return a JSON page of space metadata.

## Environment-variable fallback (advanced)

If the keychain isn't available (CI sandboxes, headless servers), opt in with:

```sh
export CONFLUENCE_MCP_USE_ENV=1
export CONFLUENCE_SITE=cloudwise.atlassian.net
export CONFLUENCE_EMAIL=you@example.com
export CONFLUENCE_TOKEN=ATATT...
```

The server reads env vars **only** when `CONFLUENCE_MCP_USE_ENV=1`. The keychain path is the recommended one — env-var mode is documented for completeness, not promoted.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm install -g @cloudwise/cw-confluence-mcp` fails with **401 / 403 / E401** | The `@cloudwise:registry=…` line is missing from your `.npmrc`, **or** your Azure DevOps feed token expired | Add the scope line shown in [Install (from feed)](#install-from-the-internal-azure-devops-feed--recommended). Then re-run `vsts-npm-auth -config %USERPROFILE%\.npmrc -F` to refresh the feed token. |
| `vsts-npm-auth` exits printing only its version banner | No Azure DevOps registry entry in `.npmrc`, so it has nothing to authenticate | Add the `@cloudwise:registry=…` line first, then re-run `vsts-npm-auth -F`. |
| Server exits with `No credentials found. Run "cw-confluence-mcp auth login" first.` | OS keychain empty | Run `cw-confluence-mcp auth login`. If you're in a CI / sandbox, set the `CONFLUENCE_MCP_USE_ENV=1` trio. |
| Tool returns `{ ok: false, error: { code: "unauthorized", … } }` | Confluence token expired or revoked | Run `cw-confluence-mcp auth login` again with a fresh token. |
| Tool returns `{ ok: false, error: { code: "forbidden", … } }` | The account doesn't have permission for that space/page/comment, **or** the token lacks the required Confluence scopes | Grant access in Confluence, or re-create the token with the scopes listed in [Step 1](#step-1--create-an-atlassian-api-token). |
| Tool returns `{ ok: false, error: { code: "rate_limited", retry_after: N } }` | Hit Confluence's rate limit; server has already retried up to 3 times with `Retry-After` honoured | Wait `N` seconds before retrying. |
| Tool returns `marker_ambiguous` on `comment_create` with `inline.text_marker` | The substring appears more than once in the page body | Supply `inline.occurrence` (1-indexed) to pick which match to anchor to. |
| Tool returns `marker_not_found` on `comment_create` | The substring isn't in the page's rendered text | Check the marker against the page in a browser; remember that the resolver collapses whitespace and strips XHTML tags. |
| Tool returns `version_conflict` on `page_update` | Someone else updated the page between your fetch and your update; the client already retried once | Re-read the page and try again. |
| Server boots but lists `Logged in as … on …` for the wrong site | Stored credentials point at a different Atlassian site | Run `cw-confluence-mcp auth logout` then `cw-confluence-mcp auth login` with the correct site. |
| Claude Code shows "Confluence MCP failed to start" | Server exited 1 — usually missing creds | Check Claude Code's MCP logs for the exact stderr line. |
| `/mcp` in Claude Code shows nothing | `.mcp.json` not found in the directory Claude Code was launched from, **or** Claude Code wasn't fully restarted after editing the config | Verify with `Test-Path .mcp.json` in that directory. Fully quit Claude Code (close the process) and relaunch. |

## Scripts

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Run the server via `tsx` (no build step) |
| `npm test` | Run unit tests (vitest) |
| `npm run test:integration` | Run live Confluence tests — skipped without `CONFLUENCE_TEST_*` env |
| `npm run lint` | ESLint |
| `npm run format` | Prettier write |
| `npm run sync-version` | Sync `src/index.ts`'s `SERVER_VERSION` from `package.json` |

Integration tests need:

```sh
export CONFLUENCE_TEST_SITE=cloudwise.atlassian.net
export CONFLUENCE_TEST_SPACE=DEV
export CONFLUENCE_TEST_PAGE_ID=12345
export CONFLUENCE_EMAIL=you@example.com
export CONFLUENCE_TOKEN=ATATT...
```

## Publishing (maintainers)

The package is published to the Azure DevOps feed configured in `package.json`'s `publishConfig.registry`. Steps for a new release:

1. **Bump the version.** The fastest way (also updates `package-lock.json`):

   ```sh
   npm version patch --no-git-tag-version    # 0.1.0 → 0.1.1 (fixes)
   npm version minor --no-git-tag-version    # 0.1.0 → 0.2.0 (new tools / features)
   npm version major --no-git-tag-version    # 0.1.0 → 1.0.0 (breaking changes)
   ```

   `--no-git-tag-version` skips npm's auto-commit, so you stay in control of git.

   `package.json` is the **single source of truth** for the version. Source files that hard-code the version (currently `src/index.ts`'s `SERVER_VERSION` constant) are kept in sync automatically — see `scripts/sync-version.mjs`. The sync runs on every `npm run build` via the `prebuild` hook, and you can also run it manually:

   ```sh
   npm run sync-version
   ```

2. **Verify locally:**

   ```sh
   npm run lint
   npm test
   npm run build
   ```

3. **Inspect the tarball** before pushing — `npm pack` writes `cloudwise-cw-confluence-mcp-X.Y.Z.tgz` next to `package.json`. Check the file list with `tar -tzf <file>.tgz` and confirm only `dist/`, `bin/`, `README.md`, and `package.json` are inside.
4. **Authenticate to the feed** (once per machine, or when the PAT expires):

   ```sh
   vsts-npm-auth -config %USERPROFILE%\.npmrc -F
   ```

5. **Publish:**

   ```sh
   npm publish
   ```

   `prepack` runs `npm run build` automatically (which in turn runs `prebuild` → `sync-version`), so the tarball always contains a fresh `dist/` with the right version baked in. `prepublishOnly` re-runs lint + tests as a final guard.

6. **Commit and tag** after a successful publish:

   ```sh
   git add package.json package-lock.json src/index.ts
   git commit -m "Release vX.Y.Z"
   git tag vX.Y.Z
   ```

## Design spec

Full design — including non-goals, error shape, pagination convention, and sub-agent decomposition: [`docs/superpowers/specs/2026-05-18-cw-confluence-mcp-design.md`](docs/superpowers/specs/2026-05-18-cw-confluence-mcp-design.md).
