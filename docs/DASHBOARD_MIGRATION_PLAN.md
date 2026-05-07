# Migration Plan — Dashboards, Reports & Extra Demo Data

**Status:** ✅ Implemented (May 7, 2026)
**Owner:** Vinay
**Architecture:** Continuation of the C2 hybrid (MCP-first, slim Script Include for what genuinely needs Glide)

> **Note for new readers:** This document is the historical planning artifact.
> The migration is complete; smoke-tested live against a developer PDI.
> File paths in §2 reflect the planning-era layout (everything was at the
> repo root). Current canonical locations:
>
> | Old path                          | New path                                       |
> |-----------------------------------|------------------------------------------------|
> | `DemoOrchestratorAPI.js`          | `servicenow/DemoOrchestratorAPI.js`            |
> | `deploy_script_include.js`        | `scripts/deploy_script_include.js`             |
> | `handoff_guide.html`              | `docs/handoff_guide.html`                      |
> | `DASHBOARD_MIGRATION_PLAN.md`     | `docs/DASHBOARD_MIGRATION_PLAN.md` (this file) |
> | `Dashboard_Guide.html`            | (deleted — superseded by `docs/handoff_guide.html`) |
> | `DemoOrchestratorAPI_newone.js`   | (deleted — non-canonical)                      |
>
> Credentials for the deploy script come from environment variables only;
> see `.env.example` at the repo root.

---

## 0. Context for a fresh session

> If you're picking this up with no prior chat history, read this section first.

The repo at `/Users/vinaykumar.biyani/developer/Demo07May` already runs the **C2 hybrid demo orchestrator**:

- **MCP (Node)** at `demoenvservicenowmcp/` owns idempotent record orchestration via REST.
  - `src/demo-orchestrator.js` — exports `applyBranding`, `applyPersonas`, `applyData`, `applyCatalog`, `applyWidgetOverrides`, `revertDemo`, `deployDemo`, `ensureUpdateSet`.
  - `src/mcp-server-consolidated.js` — registers 7 demo tools: `SN-Demo-Apply-Branding`, `-Apply-Personas`, `-Apply-Data`, `-Apply-Catalog`, `-Apply-Widget-Overrides`, `-Revert`, plus the umbrella `SN-Deploy-Demo`.
- **Script Include** at `DemoOrchestratorAPI.js` (deployed by `deploy_script_include.js`) keeps **only** server-side-only operations:
  - `applyBranding(demoConfig)` — `sp_theme.css_variables` regex injection + base64 logo → `sys_attachment`.
  - `revertByPrefix(clientPrefix)` — `deleteMultiple()` bulk teardown across `sc_cat_item`, `sc_category`, `sys_user`, `incident` + CSS strip.
  - Exposed at `POST /api/global/demo_orchestrator/{branding,revert}` via Scripted REST API.
- The handoff doc `handoff_guide.html` documents this for users.

A second, parallel artifact exists: **`DemoOrchestratorAPI_newone.js`** (686 lines) — a richer Script Include the supervisor wrote that adds dashboard/widget/report/HR/PO logic. **It's not the canonical version.** Its useful new bits need to be ported into the C2 architecture; we are not deploying it as-is.

`Dashboard_Guide.html` documents the dashboard-injection idea but contains an outdated note about `execution_method: "ui"` (irrelevant under C2 — we use sync Scripted REST, not `sys_trigger`).

---

## 1. Scope

### In scope (this migration)
1. **Hero container background** as part of branding (`sp_container.background_image`, `background_color` for index page's first container).
2. **Dashboard widget injection** — bind existing `sp_widget` records to the index page's first column via `sp_instance`.
3. **Backend reports** — create `sys_report` records (e.g. donut by category) idempotent on title.
4. **HR cases** (`sn_hr_core_case`) and **purchase orders** (`proc_po`) — add to existing data verb.
5. **Revert symmetry** for the four new tables + hero background.
6. **Plugin guards** — graceful "plugin not active" handling for HRSD / Procurement.
7. **`SN-Deploy-Demo` umbrella** wired to the new verbs.
8. **`handoff_guide.html`** updated.
9. **`Dashboard_Guide.html`** — delete the outdated `execution_method: "ui"` note; either fold its content into `handoff_guide.html` or delete the file.

### Out of scope (explicit)
- **Authoring `sp_widget` records** themselves (HTML/CSS/server-script). These remain a deployment prerequisite, shipped via Update Set or scoped app.
- **Now Experience UI Builder pages** (`sys_ux_*`) — different table family, different semantics.
- **Performance Analytics dashboards** (`pa_dashboards`).
- **`syslog` tracking** (`trackExecution`) — nice-to-have, not in this batch.

### Decided (do NOT re-debate)
- **Hybrid principle holds.** Keep what we did before. Add carefully. No architectural change.
- **Hero bg goes through MCP-side REST**, not the Script Include. (Single-record patch; no Glide benefit.)
- **Dashboard widget injection goes through MCP-side REST.** Dot-walked queries work as `sysparm_query`. No Glide benefit.
- **Revert extension goes into the Script Include** — `deleteMultiple()` is the whole reason the SI exists.
- **Plugin guards live in MCP.** Use `SN-Get-Table-Schema`-style probe before write attempts.
- **No new generic "Apply-Records" tool.** Each new domain gets a typed verb so Claude can't typo a table name on a live demo.

---

## 2. File-by-file change list

### 2.1 `DemoOrchestratorAPI.js` (Script Include, slim)
Extend `revertByPrefix` to also delete prefixed records from:
- `sn_hr_core_case` — `correlation_id STARTSWITH <prefix>_hrc_`
- `proc_po` — `correlation_id STARTSWITH <prefix>_po_`
- `sys_report` — `title STARTSWITH <prefix> -`

After CSS strip, restore the hero container background:
- For `sp_page.id=index`'s first container, set `background_image=''`, `background_color=''`.
- *Do NOT* hard-code a stock sys_id like `02b15be943671210ca4c1f425db8f242` (instance-specific). Empty is the safe default.

Wrap each new delete in try/catch so missing-plugin tables don't abort the entire revert. Surface in `result.errors` and `result.deleted`.

### 2.2 `deploy_script_include.js`
**No change.** Same Script Include + same two REST operations; the SI internals just got richer.

### 2.3 `demoenvservicenowmcp/src/demo-orchestrator.js`

Extend the existing module. New / changed exports:

```text
extend  applyBranding(client, brandingSpec)
        // already calls Scripted REST /branding
        // ADD: if brandingSpec.heroBackgroundColor (or .heroBackgroundImage), patch
        //      the index page's first sp_container in pure REST after the SI call.

extend  applyData(client, payload, options)
        // payload now { incidents: [], hr_cases: [], purchase_orders: [] }
        // each array idempotent on correlation_id
        // each array gracefully no-ops if its target table is missing (plugin off)

new     applyDashboard(client, dashboardSpec)
        // dashboardSpec: { pageId='index', widgets: [{ id, order?, title?, instanceFields? }] }
        // 1) lookup sp_page.id=pageId -> page sys_id
        // 2) query sp_column with sysparm_query=
        //      sp_row.sp_container.sp_page=<page_sysid>^ORDERBYorder
        //    take limit 1 -> column sys_id
        //    (if zero columns: error: "page has no row/container/column structure")
        // 3) for each widget:
        //    a) lookup sp_widget.id=widget.id -> widget sys_id (skip if missing, surface as error)
        //    b) idempotency check: sp_instance with sp_column=col^sp_widget=widget
        //    c) if missing, create sp_instance with order, optional title, optional instanceFields

new     applyReports(client, reports[])
        // each report { title, table, type, field, filter, group_by? }
        // idempotent on title
        // pure REST on sys_report

new     probeTable(client, tableName)
        // helper: GET /api/now/table/<tableName>?sysparm_limit=1
        // returns true if 200, false if 404 (plugin not active or table missing)
        // used by applyData to skip hr_cases / purchase_orders gracefully

extend  revertDemo(client, clientPrefix)
        // unchanged — Script Include now does more, MCP just calls /revert

extend  deployDemo(client, spec)
        // additions to the composition pipeline:
        // - branding step now passes spec.heroBackgroundColor through
        // - data step now passes { incidents, hr_cases, purchase_orders }
        // - new step: applyReports(spec.reports || [])
        // - new step: applyDashboard(spec.dashboard) when present
        // receipt.summary gets new keys: hr_cases_*, purchase_orders_*, reports_*, dashboard_widgets_*
```

### 2.4 `demoenvservicenowmcp/src/mcp-server-consolidated.js`

Register **2 new tools** + **extend 1 existing schema**:

```text
NEW    SN-Demo-Apply-Dashboard
NEW    SN-Demo-Apply-Reports
EXTEND SN-Demo-Apply-Branding
       (add heroBackgroundColor, heroBackgroundImage to inputSchema)
EXTEND SN-Demo-Apply-Data
       (inputSchema gains hr_cases[], purchase_orders[]; incidents[] stays optional)
EXTEND SN-Deploy-Demo
       (description mentions new payload keys; handler unchanged — still delegates to deployDemo)
```

Each new handler delegates to the corresponding `demo-orchestrator.js` export, mirroring the existing pattern (success/error formatting, `isError` semantics).

### 2.5 `handoff_guide.html`
- Architecture cards (section 4): no change to the cards themselves; add a one-liner "Also covers: dashboard widget injection, reports, HR cases, purchase orders."
- Tool list (section 6 collapsible): add `SN-Demo-Apply-Dashboard`, `SN-Demo-Apply-Reports`.
- Master template (Option B): extend the JSON schema string with `dashboard`, `reports`, `hr_cases`, `purchase_orders` keys.
- Add a small example: "Add KPI dashboard to the demo" showing how to call `SN-Demo-Apply-Dashboard` directly.

### 2.6 `Dashboard_Guide.html`
**Decision:** delete this file. Migrate any non-redundant content into `handoff_guide.html` (mainly: the "first column traversal" diagram is worth preserving as a one-paragraph aside in the architecture section).

The `execution_method: "ui"` note is obsolete under C2 — Scripted REST is sync, no `sys_trigger` involved.

---

## 3. Tool schemas (full)

### 3.1 `SN-Demo-Apply-Dashboard`

```json
{
  "name": "SN-Demo-Apply-Dashboard",
  "description": "Bind one or more pre-existing Service Portal widgets (sp_widget) to a portal page's first column as sp_instance records. Resolves the column via dot-walked query (sp_row.sp_container.sp_page=<page>^ORDERBYorder). Idempotent on (sp_column, sp_widget). Does NOT create sp_widget records — they must already exist on the instance (Update Set / scoped app). Pure REST.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "pageId": { "type": "string", "description": "sp_page.id; defaults to 'index'." },
      "widgets": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id":     { "type": "string", "description": "sp_widget.id (e.g. 'demo_kpi_dashboard')." },
            "order":  { "type": ["string","number"], "description": "sp_instance.order; defaults to 100." },
            "title":  { "type": "string", "description": "Optional sp_instance.title override." },
            "instanceFields": {
              "type": "object",
              "description": "Optional extra columns to set on sp_instance (e.g. bootstrap_alt, css)."
            }
          },
          "required": ["id"]
        }
      },
      "instance": { "type": "string" }
    },
    "required": ["widgets"]
  }
}
```

### 3.2 `SN-Demo-Apply-Reports`

```json
{
  "name": "SN-Demo-Apply-Reports",
  "description": "Create or update sys_report records used in demo dashboards. Idempotent on title (typically prefixed with clientPrefix). Pure REST.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "reports": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "title":      { "type": "string" },
            "table":      { "type": "string", "description": "Target table (e.g. sc_req_item, incident)." },
            "type":       { "type": "string", "description": "Chart type (donut, bar, pie, list, etc.)." },
            "field":      { "type": "string", "description": "Group/aggregation field." },
            "filter":     { "type": "string", "description": "Encoded query filter." },
            "group_by":   { "type": "string" }
          },
          "required": ["title","table","type"]
        }
      },
      "instance": { "type": "string" }
    },
    "required": ["reports"]
  }
}
```

### 3.3 `SN-Demo-Apply-Branding` (extension)

Add to `inputSchema.properties`:

```json
{
  "heroBackgroundColor": { "type": "string", "description": "Optional hex; if set, MCP also patches sp_container.background_color for the index page's first container after Script Include returns." },
  "heroBackgroundImage": { "type": "string", "description": "Optional sys_attachment URL or sys_id; defaults to '' (clear)." }
}
```

### 3.4 `SN-Demo-Apply-Data` (extension)

Add to `inputSchema.properties`:

```json
{
  "hr_cases": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "short_description": { "type": "string" },
        "description":       { "type": "string" },
        "correlation_id":    { "type": "string" }
      },
      "required": ["short_description"]
    },
    "description": "Skipped silently if HRSD plugin is not active (table sn_hr_core_case missing)."
  },
  "purchase_orders": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "short_description": { "type": "string" },
        "total_cost":        { "type": ["string","number"] },
        "correlation_id":    { "type": "string" }
      },
      "required": ["short_description"]
    },
    "description": "Skipped silently if Procurement plugin is not active (table proc_po missing)."
  }
}
```

### 3.5 `SN-Deploy-Demo` payload schema (extension)

Add to the payload JSON shape (no inputSchema change — `payload` is still a stringified JSON):

```text
{
  // existing fields unchanged
  "heroBackgroundColor": "#003366",
  "hr_cases":        [ { short_description, description, correlation_id }, ... ],
  "purchase_orders": [ { short_description, total_cost, correlation_id }, ... ],
  "reports":         [ { title, table, type, field, filter }, ... ],
  "dashboard":       { "pageId": "index", "widgets": [{ id, order?, title? }, ...] }
}
```

---

## 4. Implementation order (with dependencies)

1. **Script Include extension** (`DemoOrchestratorAPI.js`)
   → Run `node deploy_script_include.js` against dev to verify revert covers new tables.
   → Smoke: insert a `sn_hr_core_case` with `correlation_id=TEST_hrc_1`, call `/revert` with `clientPrefix=TEST`, verify deletion. Repeat without HRSD plugin to verify graceful degradation.

2. **`probeTable` helper** in `demo-orchestrator.js`
   → Standalone, used by step 4 and 5.

3. **`applyReports`** + tool registration
   → Simplest new verb. Validates the pattern. Ship and test.

4. **`applyData` extension** (hr_cases, purchase_orders)
   → Uses `probeTable` to skip gracefully.
   → Test on instance with neither plugin → should warn cleanly, not error.

5. **`applyDashboard`** + tool registration
   → Most logic. Test cases:
      - Happy path with two existing widgets → both bound.
      - Widget id doesn't exist on instance → reported as error, others still succeed.
      - Page id doesn't exist → tool returns clean error, doesn't write anything.
      - Re-run → idempotent, zero new `sp_instance` rows.

6. **`applyBranding` extension** (hero bg)
   → Pure REST patch after the SI call returns. Single update path.

7. **`deployDemo` composition update**
   → Wire all the above into the umbrella. New `summary` keys.

8. **`SN-Deploy-Demo` description & payload docs** updated.

9. **`handoff_guide.html`** updated.

10. **Delete `Dashboard_Guide.html`** (migrate the one useful diagram to handoff guide).

11. **Run full test suite.** Existing 216 must still pass; add at least 1 unit test per new verb (mock `serviceNowClient` like `tests/update-set-management.test.js` already does).

---

## 5. Test checklist (before declaring done)

- [ ] `node --check` clean on all changed JS files
- [ ] `npm test` passes (216 baseline + new tests)
- [ ] On a real PDI:
  - [ ] `SN-Deploy-Demo` with full payload (incidents + hr_cases + POs + reports + dashboard) creates expected records
  - [ ] Re-run is idempotent (zero duplicate creation in receipt)
  - [ ] `SN-Demo-Revert` deletes everything cleanly, no orphans
  - [ ] Hero container background returns to default after revert
  - [ ] Dashboard widget instances disappear after revert (handled by `sp_instance` having no orphan widget? — actually NO, sp_instance is not auto-deleted by widget deletion. **Confirm with a query and add to revert if needed.**)
- [ ] On a PDI with neither HRSD nor Procurement: deploy succeeds, hr_cases/purchase_orders sections show "skipped: plugin not active"
- [ ] On a PDI without the `demo_kpi_dashboard` widget: dashboard tool reports the missing widget id, doesn't no-op silently

> ⚠️ **Open follow-up uncovered during planning:** `sp_instance` records are not currently in `revertByPrefix`. Today they're orphaned on revert (the widget still exists, but the instance binding stays). For a clean revert we likely need to also delete `sp_instance` records that were created by the demo. Idea: stamp `sp_instance.css_class` or `sp_instance.short_description` with the clientPrefix at create time, then delete by that field on revert. **Decide during step 5.**

---

## 6. Risks & mitigations (short list)

| # | Risk | Mitigation |
|---|------|------------|
| 1 | HRSD/Procurement plugins not active → table missing | `probeTable` before write; report skip in receipt |
| 2 | `sp_widget` records don't exist on instance | Tool reports missing widget id explicitly; doesn't silently no-op |
| 3 | Hard-coded stock sys_id in old revert | We're using empty string instead — safer everywhere |
| 4 | `sp_instance` orphans on revert | See test checklist follow-up — decide during step 5 |
| 5 | `sys_trigger` workaround doc lingers | Explicit step 10: delete `Dashboard_Guide.html` |
| 6 | Index page has no row/container/column structure (fresh portal) | Tool surfaces structural error; do not auto-create rows/containers |
| 7 | Multiple portals — which `index` do we mean? | Default to ServiceNow's `sp` portal's `index`; `pageId` is a sys_id of an `sp_page` if explicit binding is needed (extend later if asked) |

---

## 7. Estimated effort

- Script Include extension: **~30 min** (additive)
- `demo-orchestrator.js` additions: **~90 min** (4 functions, mostly mirroring existing patterns)
- Tool registration + handlers: **~30 min**
- HTML updates: **~20 min**
- Tests: **~45 min**
- PDI smoke: **~30 min**

**Total: ~3.5 hours of focused work.**

---

## 8. Quick-start for the next session

Open this file. Then tell the agent:

> *"Implement DASHBOARD_MIGRATION_PLAN.md sections 2 and 3, then 9. Stop before deleting Dashboard_Guide.html and confirm. Run npm test after each numbered step in section 4. Use the same C2 patterns already in src/demo-orchestrator.js and DemoOrchestratorAPI.js — do not re-architect."*

That's enough context to resume cold. All design decisions are locked above.
