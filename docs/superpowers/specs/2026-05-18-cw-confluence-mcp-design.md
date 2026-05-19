# cw-confluence-mcp — Design Spec

**Status:** approved, ready for implementation
**Author:** Yannick Wensink (via collaborative brainstorming)
**Date:** 2026-05-18
**Audience:** the implementing agent (and its sub-agents)

This document is the starting point. An implementing agent should read it end-to-end before touching any code. Sub-agents should each receive the relevant subset plus the **Sub-Agent Contracts** section.

This spec is a sibling of `cw-bitbucket-mcp` (`docs/superpowers/specs/2026-05-13-cw-bitbucket-mcp-design.md`). Where the design is deliberately identical to that project (project layout, error shape, pagination convention, sub-agent process), this spec links rather than restates — but adapts every detail for Confluence Cloud.

---

## 1. Goal & Non-Goals

### Goal

A local MCP server that gives Claude Code structured, authenticated access to **Confluence Cloud** so an agent can:

- **Browse the space tree** — list and inspect spaces; navigate the page hierarchy (children, ancestors).
- **Read pages** — fetch a page's metadata and body in **Confluence storage format** (XHTML). Read prior versions of a page (read-only history).
- **Author and edit pages** — create new pages under a chosen parent; update existing pages with safe version handling.
- **Search content** — find pages with plain-text queries and structured filters (`space`, `label`, `title`, `updated_since`, `creator`); MCP composes the underlying CQL.
- **Manage page conversations** — full CRU on **footer** comments (page-level) and **inline** comments (anchored to a text marker in the page body), including resolve / reopen on inline threads.
- **Read labels and attachments** — list labels on a page, find pages by label, list attachments and their metadata (download URL exposed; binary payload not fetched by the MCP).

### Non-Goals (must not be implemented)

The MCP **must not** delete, destructively mutate, or administratively manage anything. This is enforced at the tool boundary with input validation and asserted in tests.

- ❌ Delete a page, comment, attachment, label, or space (anything)
- ❌ Move / re-parent a page (no `parentId` change on `page_update`)
- ❌ Change page status (publish → archive, archive → restore)
- ❌ Restore a prior version (page versions are read-only)
- ❌ Create / configure / archive a space
- ❌ Upload / overwrite an attachment
- ❌ Add / remove labels (labels are read-only — `labels_list`, `pages_by_label` only)
- ❌ Any field on `page_update` outside the allowlist (validated against the allowlist)
- ❌ Confluence Server / Data Center (different auth, different API)

Also out of scope: Confluence Whiteboards, Databases, Smart Links resolution, OAuth flows, webhook subscriptions, calendars, analytics.

Rationale: the MCP is a reader, author, and reviewer. Destructive and admin operations stay with a human in the Confluence UI.

---

## 2. Runtime, Transport, Target Client

- **Language:** TypeScript, strict mode.
- **Runtime:** Node.js 20 LTS or newer.
- **MCP SDK:** `@modelcontextprotocol/sdk` (TypeScript).
- **Transport:** stdio.
- **Primary client:** Claude Code (other stdio MCP clients should work but aren't tested against).
- **Confluence APIs:**
  - **Primary:** v2 REST at `https://<site>/wiki/api/v2`.
  - **Fallback:** v1 REST at `https://<site>/wiki/rest/api` for endpoints v2 does not yet cover (notably inline-comment lifecycle and some CQL searches).
- **Site URL:** stored in the keychain blob (see §3); inserted into request URLs by the client.

---

## 3. Authentication & Token Storage

### Token type

Atlassian API token (created at `https://id.atlassian.com` → Security → API tokens). Combined with the user's Atlassian email and sent as HTTP Basic auth: `Authorization: Basic base64(email:token)`. Same token type as cw-bitbucket-mcp.

### Storage: OS-native keychain

Use `@napi-rs/keyring` for cross-platform keychain access (Windows Credential Manager / macOS Keychain / Linux libsecret).

- **Service name:** `cw-confluence-mcp`
- **Account name:** `default`
- **Stored value:** JSON-stringified blob (note: `site` is part of the blob — Confluence Cloud is per-tenant, so the site is part of the credential):

```json
{
  "site": "cloudwise.atlassian.net",
  "email": "user@example.com",
  "token": "ATATT3...",
  "savedAt": "2026-05-18T12:34:56.000Z"
}
```

The `site` value is the bare hostname (no scheme, no `/wiki` suffix). The client appends `/wiki/api/v2` or `/wiki/rest/api` itself.

### Setup CLI: `cw-confluence-mcp auth ...`

| Command | Behaviour |
|---|---|
| `cw-confluence-mcp auth login` | Interactive prompts for site, email, and token. Token entered with masked input. Site normalised (strip scheme / trailing slash / `/wiki`). Writes to keychain. Then calls `GET /wiki/api/v2/users/current` (v1 fallback `/wiki/rest/api/user/current` if v2 returns 404) to verify and prints `Logged in as <display name> (<email>) on <site>`. |
| `cw-confluence-mcp auth logout` | Deletes the keychain entry. Idempotent. |
| `cw-confluence-mcp auth status` | Prints `Logged in as <email> on <site>` if creds exist, else `Not logged in`. **Never prints the token.** |
| `cw-confluence-mcp auth test` | Re-runs the verify call and prints the result. Used to diagnose 401s and "wrong site" errors. |

### Server-side credential loading

On startup, the server:

1. Reads creds from the keychain.
2. If absent, returns a clear error to the MCP client *and* exits non-zero with: `No credentials found. Run "cw-confluence-mcp auth login" first.`
3. Optional escape hatch: if `CONFLUENCE_MCP_USE_ENV=1`, read `CONFLUENCE_SITE` + `CONFLUENCE_EMAIL` + `CONFLUENCE_TOKEN` env vars instead. Documented in the README but not the recommended path.
4. Tokens are **never** logged. The logger has a redactor that masks anything matching the stored token. All Confluence error responses pass through the redactor before being returned or logged.

---

## 4. MCP Tool Surface

All tool names are snake_case with a domain prefix. Inputs validated via `zod` schemas. Outputs are structured JSON. List endpoints share the pagination convention from §4.10. The error shape is in §4.11.

Tool counts: **22** in total — 3 spaces + 5 pages-read + 2 pages-write + 2 page versions + 6 comments + 2 labels + 2 attachments.

### 4.1 Space tools (read-only)

| Tool | Behaviour |
|---|---|
| `space_list` | List accessible spaces. Args: optional `type` (`global` \| `personal`), `status` (`current` \| `archived`, default `current`), pagination. Returns: `id`, `key`, `name`, `type`, `status`, `homepage_id`. |
| `space_get` | Fetch one space by `key` or `id`. Returns full metadata + description in storage format. |
| `space_search` | Keyword search over space name + description. Args: `query` (text), optional `type`, pagination. MCP composes a CQL fragment `type = "space" AND text ~ "<query>"`. |

### 4.2 Page tools — read & navigate

| Tool | Behaviour |
|---|---|
| `page_list` | List pages in a space. Args: `space` (key or id), optional `parent_id` (only direct children of this page), `label` (filter by label), `status` (`current` \| `archived` \| `draft`, default `current`), `sort` (`-modified` default), pagination. Returns lightweight metadata (no body). |
| `page_get` | Full page. Args: `page_id`, optional `version` (specific historical version, default = current). Returns: `id`, `title`, `space_key`, `parent_id`, `version` (`{ number, message, created_at, created_by }`), `status`, `labels`, `body_storage` (XHTML string), `_links`. |
| `page_get_children` | Direct children of a page. Args: `page_id`, pagination, optional `sort`. Returns lightweight child metadata. |
| `page_get_ancestors` | Full ancestor chain from the page up to the space root. Args: `page_id`. Returns ordered array (closest ancestor first, root last). Not paginated — bounded by tree depth. |
| `page_search` | Plain-text + structured search across pages. Args: optional `query` (text), `space` (key — defaults to all accessible spaces), `label`, `title` (substring), `updated_since` (ISO date), `creator` (account id or username), `status`, pagination. MCP composes CQL from the supplied args, e.g. `type = "page" AND space = "DEV" AND label = "runbook" AND text ~ "kafka"`. Returns excerpts + page metadata. |

### 4.3 Page tools — write (create + update only)

| Tool | Behaviour |
|---|---|
| `page_create` | Create a new page. Required: `space` (key), `title`, `body_storage` (storage-format XHTML). Optional: `parent_id` (defaults to space homepage), `labels` (array of strings — applied after page creation via the labels endpoint). Returns the created page in the same shape as `page_get`. |
| `page_update` | Update an existing page. Required: `page_id`, `title`, `body_storage`. Allowlisted fields only: `title`, `body_storage`. Forbidden fields (`status`, `parent_id`, `space_key`, `version_message`, anything else) are rejected before any HTTP call. **Version handling:** the client fetches the current version, increments by 1, sends the update. On 409 conflict, it re-fetches and retries **once**; if the second attempt also conflicts, returns a normalised error (§4.11) with `code: "version_conflict"` and `retryable: false`. |

### 4.4 Page versions (read-only)

| Tool | Behaviour |
|---|---|
| `page_versions_list` | List versions of a page. Args: `page_id`, pagination. Returns: `number`, `created_at`, `created_by`, `message`, `minor_edit`. |
| `page_version_get` | Fetch a specific historical version's body. Args: `page_id`, `version` (integer). Returns the same shape as `page_get` but pinned to that version. |

Note: there is no `page_version_restore` — restoring is a write that effectively reverts content, and is therefore out of scope. Agents read history; humans restore via the UI.

### 4.5 Comment tools — footer + inline (CRU + lifecycle)

Confluence Cloud has two comment shapes: **footer** comments (page-level) and **inline** comments (anchored to a text range inside the page body). The same tool set handles both; the discriminator is the optional `inline` argument on `comment_create`.

| Tool | Behaviour |
|---|---|
| `comments_list` | List comments on a page, tree-flattened with `parent_id` so threads are reconstructable. Args: `page_id`, optional `type` (`footer` \| `inline` \| `both`, default `both`), `include_resolved` (default `true`). Pagination. Each item includes the `inline` anchor metadata (path, marker text, range) when applicable. |
| `comment_get` | Fetch one comment by id. |
| `comment_create` | Create a comment. Args: `page_id`, `body_storage` (XHTML), optional `parent_id` (for replies — also valid for replying inside an existing inline thread). Optional `inline: { text_marker, occurrence? }` for **new** inline threads — see §4.6. Cannot supply both `parent_id` and `inline` on the same call. |
| `comment_update` | Edit an existing comment's `body_storage`. Only the author can — surface Confluence's 403 as-is. |
| `comment_resolve` | Mark an inline thread resolved. No-op (and explicit error) if the comment is footer-type. |
| `comment_reopen` | Reopen a resolved inline thread. |

There is **no** `comment_delete` — deletion is in the hard non-goals (§1).

### 4.6 Inline comment anchoring

To create a **new** inline thread, the agent supplies a `text_marker` — a substring of the page's rendered text content — plus an optional 1-based `occurrence` index if the marker appears multiple times.

The MCP performs the anchoring server-side:

1. Fetch the page in storage format.
2. Build a normalised plain-text projection (strip XHTML tags, preserve text order).
3. Locate the marker:
   - If 0 matches → return `code: "marker_not_found"` (validation error, no HTTP call to create).
   - If 1 match → use it.
   - If >1 matches and `occurrence` is absent → return `code: "marker_ambiguous"` with the match count.
   - If >1 matches and `occurrence` is provided → use the Nth match (1-indexed).
4. Compute the storage-format anchor payload required by the Confluence API and POST the comment via the appropriate v1/v2 endpoint.

Anchor disambiguation is intentionally limited to `text_marker` + `occurrence`. XPath / element-based anchors are out of scope for v0.1 — they require schema knowledge the agent shouldn't be forced to learn.

### 4.7 Label tools (read-only)

| Tool | Behaviour |
|---|---|
| `labels_list` | Labels on a page. Args: `page_id`, pagination. Returns: `name`, `prefix` (`global` \| `team` \| `my` \| `system`). |
| `pages_by_label` | Pages tagged with a given label. Args: `label`, optional `space` filter, pagination. Returns lightweight page metadata. |

There is no `label_add` / `label_remove` — labels are read-only.

### 4.8 Attachment tools (read-only metadata)

| Tool | Behaviour |
|---|---|
| `attachments_list` | List attachments on a page. Args: `page_id`, optional `media_type` (mime prefix filter, e.g. `image/`), pagination. Returns: `id`, `filename`, `mime`, `size`, `version`, `download_url` (a full URL the agent can fetch directly — the MCP does not proxy bytes). |
| `attachment_get` | Metadata for one attachment by id. |

The MCP does **not** download attachment binaries. If an agent needs the bytes, it uses the `download_url` with its own HTTP capability. Rationale: keeps the MCP surface JSON-only and avoids streaming megabytes through stdio.

### 4.9 Tool input/output schemas — conventions

- All tools take a single object argument; no positional args.
- All tools return either `{ ok: true, data: ... }` or the structured error shape in §4.11. The MCP `isError` flag is set on error responses.
- Page bodies are exchanged as **storage format** (XHTML) strings under the field name `body_storage`. No rendering, no sanitisation. Confluence renders.
- Comment bodies follow the same rule (`body_storage`).
- IDs are returned as strings (Confluence v2 returns string IDs even when numeric; do not coerce).
- Timestamps are ISO-8601 strings in UTC.

### 4.10 Pagination convention

Same as cw-bitbucket-mcp §4.5. All list tools accept:
- `cursor` (opaque string from a previous response) — prefer cursor when present, or `page` (1-indexed integer) for v1 fallbacks.
- `pagelen` (default 25, max 100).

All list tools return:
- `values` — the page of results.
- `next_cursor` — opaque string, or `null` if last page.
- `total` — included when Confluence includes it; otherwise omitted.

The client normalises v1 (offset/limit) and v2 (cursor) pagination into this single shape so endpoint files never branch on API version.

### 4.11 Error shape

Same as cw-bitbucket-mcp §4.6:

```ts
{
  ok: false,
  error: {
    status: number,           // HTTP status from Confluence, or 0 for client-side validation
    code: string,             // short identifier — see table below
    message: string,          // human-readable
    retryable: boolean,       // true for 429 and 5xx
    retry_after?: number      // seconds, present when Confluence sends Retry-After
  }
}
```

Confluence-specific `code` values:

| `code` | When |
|---|---|
| `unauthorized` | 401 — hint: *"Run `cw-confluence-mcp auth login` if your token is expired."* |
| `forbidden` | 403 — same hint. |
| `not_found` | 404 — page, comment, space, label not found. |
| `validation` | 0 (client-side) — input failed zod or allowlist check. |
| `forbidden_field` | 0 — `page_update` received a non-allowlisted field. |
| `marker_not_found` | 0 — inline anchor `text_marker` matched zero substrings. |
| `marker_ambiguous` | 0 — `text_marker` matched >1 substrings and no `occurrence` given. |
| `version_conflict` | 409 after one retry — concurrent page edit. |
| `rate_limited` | 429 — `retry_after` populated from `Retry-After` header. |
| `server_error` | 5xx. |

Errors are wrapped *before* returning to the MCP client. The raw Confluence payload is dropped if it would leak the token (defence in depth — the redactor should already prevent this, but the client also enforces it).

---

## 5. Project Layout

```
cw-confluence-mcp/
├── README.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .eslintrc.cjs
├── .prettierrc
├── docs/
│   └── superpowers/specs/2026-05-18-cw-confluence-mcp-design.md   # this spec
├── src/
│   ├── index.ts                  # MCP server bootstrap (stdio)
│   ├── cli/
│   │   ├── index.ts              # commander entry: subcommand dispatch
│   │   └── auth.ts               # login / logout / status / test
│   ├── auth/
│   │   ├── keychain.ts           # @napi-rs/keyring read/write/delete
│   │   └── credentials.ts        # load creds (keychain → optional env fallback)
│   ├── confluence/
│   │   ├── client.ts             # fetch wrapper, Basic auth, v1/v2 router, redactor, retry, error mapping
│   │   ├── pagination.ts         # cursor/page/offset helpers — normalise to §4.10
│   │   ├── errors.ts             # normalised error shape (§4.11)
│   │   ├── cql.ts                # build CQL from structured args (page_search, space_search)
│   │   ├── anchor.ts             # inline-comment text_marker resolver (§4.6)
│   │   └── endpoints/
│   │       ├── spaces.ts         # list / get / search
│   │       ├── pages.ts          # list / get / children / ancestors / search / create / update
│   │       ├── versions.ts       # list / get
│   │       ├── comments.ts       # list / get / create / update / resolve / reopen
│   │       ├── labels.ts         # list / pages_by_label
│   │       └── attachments.ts    # list / get
│   ├── tools/
│   │   ├── register.ts           # wires all tools into the MCP server
│   │   ├── spaces.ts             # space_list / space_get / space_search
│   │   ├── pages.ts              # page_list / page_get / page_get_children / page_get_ancestors / page_search / page_create / page_update
│   │   ├── versions.ts           # page_versions_list / page_version_get
│   │   ├── comments.ts           # comments_list / comment_get / comment_create / comment_update / comment_resolve / comment_reopen
│   │   ├── labels.ts             # labels_list / pages_by_label
│   │   └── attachments.ts        # attachments_list / attachment_get
│   └── shared/
│       ├── schemas.ts            # shared zod fragments (PageId, SpaceKey, Pagination, …)
│       └── logger.ts             # token-redacting logger
├── tests/
│   ├── unit/                     # vitest + msw, no network
│   └── integration/              # opt-in, real Confluence; skipped by default
└── bin/
    └── cw-confluence-mcp.js      # shebang dispatcher → serve | auth …
```

### Single binary, two modes

Same pattern as cw-bitbucket-mcp. `package.json` declares one bin:

```json
"bin": { "cw-confluence-mcp": "./bin/cw-confluence-mcp.js" }
```

The dispatcher in `bin/cw-confluence-mcp.js`:
- No args, or `serve` → import compiled `src/index.ts` and start the stdio MCP server.
- `auth <subcommand>` → import `src/cli/index.ts` and run the CLI.
- `--help` → print usage.

### v1 / v2 routing — where it lives

The `client.ts` exposes two methods: `v2(path, init)` and `v1(path, init)`. Endpoint files pick the right one per call. The choice is documented at the top of each endpoint method (one-line comment) so a reader can see why a v1 path was picked without diving into the router. The router itself is dumb — it composes URLs (`https://<site>/wiki/api/v2<path>` or `https://<site>/wiki/rest/api<path>`), attaches Basic auth, runs the response through the redactor and error mapper, and returns parsed JSON.

---

## 6. Dependencies

Identical set to cw-bitbucket-mcp:

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server SDK |
| `zod` | Schema validation, doubles as JSON Schema source for tool defs |
| `@napi-rs/keyring` | OS keychain access, prebuilt binaries |
| `commander` | CLI subcommand parsing |
| `prompts` | Interactive prompts for `auth login` (masked token input) |
| `vitest` | Test runner |
| `msw` | HTTP mocking at fetch boundary |
| `tsx` | Dev runtime |
| `typescript`, `@types/node` | TS toolchain |
| `eslint`, `prettier` | Lint / format |

No runtime dependency on a heavy HTTP client — use the built-in `fetch`. No HTML/XML parsing library: the inline-anchor text projection uses a small regex-based tag stripper (kept self-contained in `src/confluence/anchor.ts`) and is unit-tested against representative storage-format fixtures.

---

## 7. Testing

Unit tests are the primary safety net. **Every tool ships with tests before it counts as done.** Same bar as cw-bitbucket-mcp.

### Required coverage per tool

- Happy-path call: tool input → expected HTTP request → mocked response → expected output shape.
- Confluence error mapping: 401, 403, 404, 409, 429 (with `Retry-After`), 5xx → normalised error shape (§4.11).
- Input validation: malformed args rejected by zod with a useful message, **no HTTP call made**.
- Pagination edges: first page, middle page, last page (`next_cursor: null`). For endpoints with v1 fallback: both pagination styles round-trip through `pagination.ts`.

### Special-case tests

- `page_update`:
  - Forbidden fields (`status`, `parent_id`, `space_key`, anything outside the allowlist) are rejected before any HTTP call.
  - Auto-version flow: client fetches current version, increments, sends. Mock asserts the outgoing version number.
  - 409-then-success: first PUT returns 409, client re-fetches and retries, second PUT succeeds.
  - 409-then-409: both PUTs return 409, returned error is `version_conflict` and `retryable: false`.
- `comment_create` inline path (`anchor.ts`):
  - Marker found exactly once → anchor payload built correctly.
  - Marker not found → `marker_not_found`, no HTTP call.
  - Marker ambiguous, no `occurrence` → `marker_ambiguous` with `count` populated.
  - Marker ambiguous, `occurrence` supplied → correct match used (test occurrences 1, 2, and last).
  - Marker spans element boundaries in storage format → resolved against the text projection, not the raw XHTML.
- Hard non-goals: for each forbidden operation in §1, an explicit test confirming "this isn't a registered tool". Catches accidental tool registration.
- Auth module: tokens never appear in error messages, logs, or returned error payloads (regex-based assertion on stderr capture + returned error JSON).
- Redactor: tests with the literal token string, with the token in URL, with the token in a JSON body — all must come out redacted.
- CQL composer (`cql.ts`): each structured arg in `page_search` produces the expected CQL fragment; combinations compose with `AND`; quoting / escaping of user input is safe (no CQL injection); unsupported combos rejected before HTTP call.

### Integration tests

- Live under `tests/integration/`.
- **Skipped by default** (use `it.skipIf` or `describe.skipIf` keyed on a missing env var).
- Configured via env: `CONFLUENCE_TEST_SITE`, `CONFLUENCE_TEST_SPACE`, `CONFLUENCE_TEST_PAGE_ID`, `CONFLUENCE_EMAIL`, `CONFLUENCE_TOKEN`.
- Run manually with `npm run test:integration`.
- CI runs unit tests only.

---

## 8. Sub-Agent Decomposition

Phases 1, 2, 4 are sequential. Phase 3 is fully parallel — dispatch all sub-agents in one go.

### Phase 1 — Scaffold (sequential, single agent)

Init the project. Output:
- `package.json` (with the `bin` entry, scripts: `build`, `dev`, `test`, `test:integration`, `lint`).
- `tsconfig.json` (strict, `target: ES2022`, `module: NodeNext`).
- `vitest.config.ts`.
- `.eslintrc.cjs`, `.prettierrc`.
- Folder skeleton from §5.
- `src/index.ts` that boots an MCP server registering zero tools and prints a banner to stderr.
- `bin/cw-confluence-mcp.js` dispatcher that recognises `serve` and `auth` (latter prints "not implemented" until phase 3).
- `README.md` stub.

**Done when:** `npm run build` succeeds, `node bin/cw-confluence-mcp.js serve` starts and responds to MCP `initialize`.

### Phase 2 — Foundations (sequential, single agent)

Implement and fully unit-test the shared modules everything else depends on:
- `src/auth/keychain.ts` — read/write/delete via `@napi-rs/keyring`. Stored blob shape per §3.
- `src/auth/credentials.ts` — load order: keychain → optional env fallback. Returns typed creds (including `site`) or a typed error.
- `src/confluence/client.ts` — fetch wrapper with Basic auth, `v1()` and `v2()` helpers, JSON parsing, redactor wired in, retry on 429/5xx (max 3, exponential backoff with jitter), error mapping to §4.11.
- `src/confluence/pagination.ts` — input normalisation + output shape per §4.10, handling both cursor (v2) and offset/limit (v1).
- `src/confluence/errors.ts` — error normalisation + the 401/403 hint.
- `src/confluence/cql.ts` — build CQL fragments from structured args; safe quoting; unit-tested with a corpus of input → expected CQL pairs.
- `src/confluence/anchor.ts` — text-marker → anchor payload resolver (§4.6); pure function over a storage-format string.
- `src/shared/schemas.ts` — `SpaceKey`, `PageId`, `CommentId`, `Pagination`, `BodyStorage`, etc. as reusable zod fragments.
- `src/shared/logger.ts` — token-redacting logger writing to stderr only (stdout is reserved for MCP traffic).

**Done when:** all foundation modules have ≥90 % line coverage in `tests/unit/`, the redactor regex-test passes, the anchor resolver passes its fixture suite, and `npm run lint` is clean.

### Phase 3 — Feature build (parallel sub-agents)

Each sub-agent owns one domain end-to-end: endpoint wrapper + MCP tool file + unit tests + an export from its file that `tools/register.ts` will import. Each sub-agent must:
- Read §3, §4 (subsection for its domain), §4.9, §4.10, §4.11, §6, §7 of this spec.
- Touch **only** the files listed under "owns" below. No edits to shared modules — if a foundation gap is found, surface it instead of patching locally.
- Use `zod` schemas from `src/shared/schemas.ts` for common fragments.
- Use `client.v2(...)` by default; document any drop to `client.v1(...)` with a one-line comment naming the missing v2 capability.

| Sub-agent | Owns (creates/edits only these) | Tools delivered |
|---|---|---|
| **A — Spaces** | `src/confluence/endpoints/spaces.ts`, `src/tools/spaces.ts`, `tests/unit/tools/spaces.test.ts` | `space_list`, `space_get`, `space_search` |
| **B — Pages (read + navigate + versions)** | `src/confluence/endpoints/pages.ts` (read methods only), `src/confluence/endpoints/versions.ts`, `src/tools/pages.ts` (read tools only), `src/tools/versions.ts`, `tests/unit/tools/pages.read.test.ts`, `tests/unit/tools/versions.test.ts` | `page_list`, `page_get`, `page_get_children`, `page_get_ancestors`, `page_search`, `page_versions_list`, `page_version_get` |
| **C — Pages (write)** | `src/confluence/endpoints/pages.ts` (write methods — coordinates with B via export merge), `src/tools/pages.ts` (write tools — same), `tests/unit/tools/pages.write.test.ts` | `page_create`, `page_update` |
| **D — Comments** | `src/confluence/endpoints/comments.ts`, `src/tools/comments.ts`, `tests/unit/tools/comments.test.ts` | `comments_list`, `comment_get`, `comment_create`, `comment_update`, `comment_resolve`, `comment_reopen` |
| **E — Labels** | `src/confluence/endpoints/labels.ts`, `src/tools/labels.ts`, `tests/unit/tools/labels.test.ts` | `labels_list`, `pages_by_label` |
| **F — Attachments** | `src/confluence/endpoints/attachments.ts`, `src/tools/attachments.ts`, `tests/unit/tools/attachments.test.ts` | `attachments_list`, `attachment_get` |
| **G — CLI** | `src/cli/index.ts`, `src/cli/auth.ts`, `bin/cw-confluence-mcp.js`, `tests/unit/cli/auth.test.ts` | `cw-confluence-mcp auth login \| logout \| status \| test` |

**Coordination note for B and C:** both touch `src/confluence/endpoints/pages.ts` and `src/tools/pages.ts`. Resolve by giving B exclusive ownership of the read functions (named `listPages`, `getPage`, `getPageChildren`, `getPageAncestors`, `searchPages`) and tool registrations (`page_list`, `page_get`, `page_get_children`, `page_get_ancestors`, `page_search`); C adds `createPage`, `updatePage`, `page_create`, `page_update` as additional named exports. Each agent appends to the same file in non-overlapping blocks; the integration agent (Phase 4) resolves any merge conflict.

**Done when:** each sub-agent's own tests pass, lint is clean, and the sub-agent reports back which exports `tools/register.ts` should import.

### Phase 4 — Integration & polish (sequential, single agent)

- Wire all tool exports into `src/tools/register.ts`.
- Resolve any text-level merge conflicts in `src/confluence/endpoints/pages.ts` and `src/tools/pages.ts` between sub-agents B and C.
- Write `README.md`: install, `cw-confluence-mcp auth login` walk-through (site + email + token), Claude Code `.mcp.json` snippet, troubleshooting (401 → re-login; 429 → retry hint; "No credentials found" → run login; "wrong site" → re-run login with correct site; `marker_ambiguous` → supply `occurrence`).
- Run the full unit suite, lint, build.
- Manual smoke run: start the server via Claude Code, call `space_list`, `page_get` against a real Confluence instance, post a footer comment to a sandbox page, confirm `auth status` works.
- Tag a commit `v0.1.0` (but **do not** push or publish — Yannick handles git operations).

**Done when:** Claude Code can register the server via `.mcp.json` and successfully call at least one tool against a live Confluence Cloud site.

### Sub-Agent Contracts

Each sub-agent prompt must include:
1. A pointer to this spec file.
2. The "owns" file list — *strict*.
3. The §4 subsection for its domain + §4.9 (conventions) + §4.10 (pagination) + §4.11 (errors) + §7 (testing).
4. The exports the foundations layer (§Phase 2) provides — names + signatures.
5. A reminder of the hard non-goals (§1) — most relevant to sub-agent C (pages write), D (comments — no delete), E (labels — read-only), F (attachments — read-only metadata).

---

## 9. Git & Release

- **Do not commit on the user's behalf.** Yannick handles all git operations himself.
- Each phase's agent reports a clean working tree summary at the end and lets Yannick stage/commit.
- No `npm publish` — installation is via local clone + `npm link` for now.

---

## 10. Open Questions / Future Work

Not part of this build. Listed so they don't quietly creep in:

- **Multi-site token storage** — current spec is one site + one token per keychain entry. A future version could store multiple `site` profiles keyed by alias.
- **Markdown ergonomics layer** — optional `body_markdown` field on `page_create` / `page_update` / `comment_create`, transparently converted to storage format. Excluded from v0.1 because lossy round-trips with macros need careful UX.
- **Attachment binary download** — surface attachment bytes through the MCP (probably as a Resource rather than a Tool result).
- **Page hierarchy moves (`page_move`)** — re-parenting a page. Out of scope for v0.1; reconsider if review workflows demand it.
- **Label writes** — `label_add` / `label_remove`. Read-only suffices for current goals; can be added without changing the v0.1 read surface.
- **Whiteboards / Databases** — Confluence's newer content types. Different API, different model.
- **Caching layer** for read endpoints (space list, page bodies at a version).
- **Confluence Server / Data Center** — explicitly out of scope.
- **Streaming large pages** — current truncation strategy is per-request `max_bytes` (default unbounded for pages; documented limit for `page_get` if it proves to be a problem).
- **Webhook subscriptions / event tail** — out of scope.
