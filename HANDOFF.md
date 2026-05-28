# ServiceNow Demo Deployer — Handoff Guide

This MCP server lets a Cursor agent provision a complete ServiceNow demo
(branding, Service Catalog categories + items, users, incidents) for any
client in a **single tool call**, wrapped in a dedicated Update Set so the
deployment is portable.

A receiving operator should be productive within **5 minutes** of cloning
this repository.

---

## Prerequisites

- **Node.js ≥ 18** (`node --version`)
- **A ServiceNow instance** you can write to (PDI / sub-prod / sandbox).
  An `admin`-role account is the simplest; a tailored role with
  `itil`, `catalog_admin`, `user_admin`, `update_set` write access also works.
- **Cursor** with MCP support enabled.

---

## Setup (6 steps, ~5 minutes)

### 1. Clone and install

```bash
git clone <this-repo-url> demoenvservicenowmcp
cd demoenvservicenowmcp
npm install
```

### 2. Configure your ServiceNow instance

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
SERVICENOW_INSTANCE_URL=https://your-instance.service-now.com
SERVICENOW_USERNAME=admin
SERVICENOW_PASSWORD=your-password
SERVICENOW_AUTH_TYPE=basic
```

> The `.env` file is git-ignored. Never commit credentials.

### 3. Register the MCP server with Cursor

Open `~/.cursor/mcp.json` (create it if it doesn't exist) and add the
following entry. **Replace `<ABSOLUTE-PATH-TO-REPO>` with the absolute
path on your machine**, e.g. `/Users/jane/code/demoenvservicenowmcp`.

```json
{
  "mcpServers": {
    "servicenow-demo": {
      "command": "node",
      "args": ["<ABSOLUTE-PATH-TO-REPO>/src/stdio-server.js"]
    }
  }
}
```

> The MCP server reads credentials from the `.env` file in the repo, so
> you don't need to repeat them inside `mcp.json`.

### 4. Reload Cursor

Press `Cmd+Shift+P` → **Developer: Reload Window**. Cursor will spawn the
MCP server on first use.

### 5. Open this folder as your Cursor workspace

`File → Open` → select the `demoenvservicenowmcp` folder. The workspace rule
in `.cursor/rules/servicenow-demo.mdc` will auto-load and steer the agent.

### 6. Try it (Two flexible methods)

You can seed new demo environments using either the conversational AI-driven agent or our high-speed CLI utility.

#### Method A: Conversational Seeding (AI-Driven)
In a fresh Cursor chat window, simply tell the connected agent:
> *Set up a ServiceNow demo for **Delta Airlines** — they are an international aviation carrier. Generate visual branding (deep blue/gold), catalog categories, 2 users, 3 IT incidents for gate printer failures, and a symmetrical platform operations dashboard.*

The MCP agent will automatically:
1. Generate an industry-appropriate, beautiful JSON payload matching the specifications.
2. Call the `SN-Deploy-Demo` MCP tool.
3. Hand back a visually rich execution receipt showing active Update Sets and created components.

#### Method B: The Command Line Seeding Script (High-Speed CLI)
If your supervisor wants to seed without invoking an LLM chat, they can run our universal CLI script by passing any industry JSON payload file path as an argument:

```bash
# Deploys a healthcare demo environment
node deploy.js examples/sample-payload-healthcare.json

# Deploys a custom industry payload
node deploy.js path/to/your-payload.json
```

---

## Verifying the deploy

After a successful run the receipt will look like:

```json
{
  "summary": {
    "branding_applied": 4,
    "categories_created": 5,
    "categories_skipped": 0,
    "catalog_items_created": 8,
    "catalog_items_skipped": 0,
    "users_created": 5,
    "users_skipped": 0,
    "incidents_created": 6,
    "incidents_skipped": 0,
    "errors": 0
  }
}
```

In ServiceNow, check:

- **System Definition → Update Sets** → `<clientPrefix> Demo Deploy` (state: in progress)
- **Service Catalog → Categories** → the new categories you defined
- **Maintain Items** → the new catalog items, linked to the right category
- **User Administration → Users** → the new users
- **Incident → All** → the new incidents (filter by `correlation_id` starts with `<clientPrefix>-`)
- **System Properties** → `<clientPrefix>.demo.*` (4 properties: client_name, client_prefix, primary_color, secondary_color)

---

## Re-running and cleanup

- **Re-run** — Calling `SN-Deploy-Demo` with the same payload is safe; everything is upsert / skip-if-exists.
- **Move to a clean instance** — Export the `<clientPrefix> Demo Deploy` update set as XML and import it on the target instance.
- **Tear down** — There is no automatic teardown tool. Either delete the Update Set + its records, or roll back via Update Set retrieval. We recommend deploying onto throwaway PDIs for clean demos.

---

## Reference payload

A complete known-good payload (Healthcare / Hospital IT Operations) lives
at:

```
examples/sample-payload-healthcare.json
```

Use it for testing, or as a few-shot example when generating payloads for
new industries.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Agent says `SN-Deploy-Demo` not found | MCP server not running, or Cursor cached an old tool list | `Cmd+Shift+P` → **Developer: Reload Window**, then retry |
| `Missing ServiceNow credentials` on startup | `.env` not filled in, or wrong path in `mcp.json` | Verify `.env` exists in the repo and `mcp.json` points at the right `stdio-server.js` |
| `401 Unauthorized` from ServiceNow | Wrong username / password, or instance URL has trailing slash | Re-check `.env`; URL must be `https://<inst>.service-now.com` (no trailing slash) |
| `403 Forbidden` creating `sc_category` / `sc_cat_item` | User lacks `catalog_admin` role | Grant `catalog_admin` (or use `admin`) |
| `Update set` errors but records still created | UI session for setting current update set failed; records went to default set | Records are still valid; just not bundled. Move them with `SN-Move-Records-To-Update-Set` if you need an export |
| Catalog items don't appear in Service Portal | Items need a `sc_catalog` reference and an active publish | The orchestrator already sets `sc_catalogs` to the first active catalog. If the portal still hides them, check ACLs and item `active` flag |

---

## What's inside

- **`src/stdio-server.js`** — MCP entrypoint (stdio transport).
- **`src/mcp-server-consolidated.js`** — All tool definitions and dispatcher. `SN-Deploy-Demo` is registered alongside the other `SN-*` tools.
- **`src/servicenow-client.js`** — Thin wrapper around the ServiceNow Table & UI APIs.
- **`.cursor/rules/servicenow-demo.mdc`** — Workspace rule that steers any Cursor agent to `SN-Deploy-Demo` for demo provisioning.
- **`examples/sample-payload-healthcare.json`** — Reference payload.

---

## Extending the orchestrator

To add a new entity type (e.g. `change_requests`, `cmdb_ci`, `kb_articles`):

1. Add a new top-level array to the input schema in the tool's
   `inputSchema.properties` (in `src/mcp-server-consolidated.js`).
2. Inside the `case 'SN-Deploy-Demo':` handler, add a new section that
   queries by your idempotency key, then `createRecord` if missing.
3. Update the `result.summary` object so the receipt includes the new counts.
4. Add a section to `.cursor/rules/servicenow-demo.mdc` describing the
   new entity so the agent generates it.

The orchestrator is intentionally a simple, linear procedure — easy to
read, easy to extend, easy to debug.
