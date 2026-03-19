# Editor MCP Example

Focused app-land example for editor onboarding.

This example demonstrates the intended split:

- `cms/` is the real `agent-cms` Worker.
- `app/` is the app-land Worker that owns users, login, and editor onboarding.
- the app Worker talks to the CMS Worker over a Cloudflare service binding

The two MCP URLs are intentionally different:

- CMS direct admin MCP: `https://<cms>/mcp`
- CMS editor-token MCP: `https://<cms>/mcp/editor`
- App-land editor OAuth gateway: `https://<app>/editor-access/mcp`

That distinction is the point:

- developers use the CMS directly with `writeKey`
- app-land can mint browser-safe editor tokens that work against `https://<cms>/mcp/editor`
- editors using Claude Code or Codex authenticate against app-land and use the gateway

## What the app-land Worker does

- exposes a fake login flow for local/demo use
- returns short-lived visual-edit editor tokens from `/api/editor-token`
- exposes OAuth metadata + authorization/token endpoints for MCP clients
- proxies authenticated editor MCP traffic to the CMS `/mcp/editor` endpoint
- uses a Worker-to-Worker service binding for server-side calls while still exposing the public CMS URL to browsers and MCP clients

## What the developer tells the editor

Use the editor MCP, not the developer/admin one.

For Claude Code or Codex:

- Before starting Claude Code, add this MCP server with the CLI so Claude picks it up on launch:

```bash
claude mcp add --transport http editor-mcp https://<app>/editor-access/mcp
```

- If you add it after Claude Code is already running, restart Claude Code.
- When the MCP client asks you to sign in, complete the login flow in the browser.
- After that, work normally through the MCP server.

What the editor MCP can do:

- browse the CMS schema
- create and edit content
- upload and manage assets
- see drafts
- publish and unpublish
- browse and restore versions

What the editor should not need:

- the CMS admin MCP URL
- a `writeKey`
- direct access to the CMS project or repo

For browser visual editing:

- sign into the app
- the app mints a short-lived editor token for the session
- the visual editor uses that token against the CMS `/mcp/editor` and GraphQL draft surfaces behind the scenes

## Local shape

1. Start the CMS Worker.
2. Run setup against the CMS Worker.
3. Start the app-land Worker with `CMS_BASE_URL`, `CMS_WRITE_KEY`, and `OAUTH_SECRET`.
4. Log in via the app Worker.
5. Use:
   - `/api/editor-token` for browser visual editing
   - `/editor-access/mcp` for Claude Code / Codex editor MCP

## Suggested Cloudflare resource prefix

Use a distinct personal prefix so you do not collide with other examples:

- Worker names: `jokull-editor-mcp-example-cms`, `jokull-editor-mcp-example-app`
- D1 name: `jokull-editor-mcp-example-cms-db`
- R2 bucket: `jokull-editor-mcp-example-assets`

Adjust the `wrangler.jsonc` files before deploy.

The example uses a Cloudflare service binding from the app Worker to the CMS Worker. That keeps the server-side proxy private and avoids the `workers.dev` same-account fetch restriction.
