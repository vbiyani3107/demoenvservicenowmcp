/**
 * Demo Orchestrator — MCP-side composition layer.
 *
 * Architecture (Option C2 hybrid):
 *   - This module owns everything that REST does well: idempotent upserts of
 *     sys_user / sys_user_has_role / sc_category / sc_cat_item / item_option_new /
 *     question_choice / sp_instance / incident, plus update-set handling.
 *
 *   - For the two operations that genuinely benefit from running inside
 *     ServiceNow (CSS theme injection + base64 logo upload + bulk delete),
 *     it calls the slim DemoOrchestratorAPI Script Include via the
 *     "Demo Orchestrator" Scripted REST API:
 *       POST /api/global/demo_orchestrator/branding
 *       POST /api/global/demo_orchestrator/revert
 *
 *   - Each top-level verb (applyBranding, applyPersonas, applyData,
 *     applyCatalog, applyWidgetOverrides, revertDemo) is independently
 *     callable AND composed by `deployDemo()`.
 */

const ORCHESTRATOR_REST_BASE = '/api/global/demo_orchestrator';

const ESC_QV = (v) => String(v).replace(/\^/g, ' ').replace(/=/g, ' ');

function emptyReceipt(clientName, clientPrefix) {
  return {
    client_name: clientName,
    client_prefix: clientPrefix,
    update_set: null,
    branding: null,
    categories: { created: [], skipped: [] },
    catalogItems: { created: [], skipped: [] },
    users: { created: [], skipped: [] },
    incidents: { created: [], skipped: [] },
    hr_cases: { created: [], skipped: [], available: null },
    purchase_orders: { created: [], skipped: [], available: null },
    reports: { created: [], skipped: [] },
    dashboard: null,
    widgetOverrides: { applied: [], skipped: [] },
    errors: []
  };
}

/**
 * POST through to the Scripted REST endpoint exposed by the slim Script Include.
 * The Script Include returns { ok, ... }; we surface that verbatim.
 */
async function callOrchestratorEndpoint(serviceNowClient, relativePath, body) {
  const url = `${ORCHESTRATOR_REST_BASE}${relativePath}`;
  const response = await serviceNowClient.client.post(url, body || {});
  return response.data;
}

/**
 * probeTable — best-effort liveness check for an instance table. Issues a
 * single 1-row REST GET. Used by applyData to skip optional plugin-gated
 * tables (sn_hr_core_case, proc_po) gracefully.
 *
 * Always returns a boolean so callers can short-circuit without try/catch.
 * Non-404 failures (auth, transport, 5xx) are still treated as "unavailable"
 * to keep deploys resilient, but are logged to stderr so a flaky instance
 * doesn't silently masquerade as "plugin not active".
 */
export async function probeTable(serviceNowClient, tableName) {
  if (!tableName) return false;
  try {
    await serviceNowClient.getRecords(tableName, {
      sysparm_limit: 1,
      sysparm_fields: 'sys_id'
    });
    return true;
  } catch (e) {
    const status = e && e.response && e.response.status;
    if (status && status !== 404) {
      console.error(`[probeTable] ${tableName}: unexpected ${status} — ${e.message}`);
    } else if (!status) {
      console.error(`[probeTable] ${tableName}: ${e.message}`);
    }
    return false;
  }
}

/**
 * applyBranding — delegates the CSS injection + optional logo upload to the
 * Script Include via /branding. The MCP doesn't try to mutate sp_theme over
 * REST: that path is racy (theme is shared, regex needs server-side semantics)
 * and slow (3 round-trips per portal).
 *
 * After the Script Include returns, optionally patches the index page's first
 * sp_container with heroBackgroundColor / heroBackgroundImage in pure REST.
 * Single-record patch — no Glide benefit, no need to round-trip through SI.
 */
export async function applyBranding(serviceNowClient, brandingSpec) {
  if (!brandingSpec || typeof brandingSpec !== 'object') {
    throw new Error('applyBranding: brandingSpec object is required');
  }
  const result = await callOrchestratorEndpoint(serviceNowClient, '/branding', brandingSpec);

  // Hero container background — pure REST patch on the index page's first
  // sp_container. Only runs when the caller asked for it; missing structure
  // is reported in result.heroBackground but does NOT flip result.ok to false
  // (the SI's CSS work already succeeded).
  if (brandingSpec.heroBackgroundColor || brandingSpec.heroBackgroundImage) {
    const hero = { applied: false };
    try {
      const pageId = brandingSpec.heroPageId || 'index';
      hero.pageId = pageId;
      const pages = await serviceNowClient.getRecords('sp_page', {
        sysparm_query: `id=${ESC_QV(pageId)}`,
        sysparm_limit: 1,
        sysparm_fields: 'sys_id,id'
      });
      if (!pages[0]) {
        hero.error = `sp_page.id="${pageId}" not found`;
      } else {
        const containers = await serviceNowClient.getRecords('sp_container', {
          sysparm_query: `sp_row.sp_page=${pages[0].sys_id}^ORDERBYorder`,
          sysparm_limit: 1,
          sysparm_fields: 'sys_id,order'
        });
        if (!containers[0]) {
          hero.error = `page "${pageId}" has no row/container structure`;
        } else {
          const data = {};
          if (brandingSpec.heroBackgroundColor != null) data.background_color = brandingSpec.heroBackgroundColor;
          if (brandingSpec.heroBackgroundImage != null) data.background_image = brandingSpec.heroBackgroundImage;
          await serviceNowClient.updateRecord('sp_container', containers[0].sys_id, data);
          hero.applied = true;
          hero.containerSysId = containers[0].sys_id;
          hero.fields = data;
        }
      }
    } catch (e) {
      hero.error = e.message;
    }
    result.heroBackground = hero;
  }

  return result;
}

/**
 * applyPersonas — sys_user upserts (idempotent on user_name) plus role
 * assignment via sys_user_has_role. Manager refs are resolved on a 2nd pass
 * after every persona has a sys_id.
 */
export async function applyPersonas(serviceNowClient, personas) {
  const out = { created: [], skipped: [], roles_assigned: 0, errors: [] };
  if (!Array.isArray(personas) || personas.length === 0) return out;

  const userSysIds = {};

  // Pass 1: upsert users without manager refs
  for (const p of personas) {
    if (!p || !p.user_name) {
      out.errors.push(`Persona missing user_name: ${JSON.stringify(p)}`);
      continue;
    }
    try {
      const existing = await serviceNowClient.getRecords('sys_user', {
        sysparm_query: `user_name=${ESC_QV(p.user_name)}`,
        sysparm_limit: 1,
        sysparm_fields: 'sys_id,user_name'
      });
      const data = {
        first_name: p.first_name || '',
        last_name: p.last_name || '',
        user_name: p.user_name,
        email: p.email || '',
        title: p.title || '',
        department: p.department || '',
        active: 'true'
      };
      let sysId;
      if (existing[0]) {
        sysId = existing[0].sys_id;
        await serviceNowClient.updateRecord('sys_user', sysId, data);
        out.skipped.push({ user_name: p.user_name, sys_id: sysId, reason: 'already exists (updated in place)' });
      } else {
        const created = await serviceNowClient.createRecord('sys_user', data);
        sysId = created.sys_id;
        out.created.push({ user_name: p.user_name, sys_id: sysId });
      }
      userSysIds[p.user_name] = sysId;
    } catch (e) {
      out.errors.push(`Persona "${p.user_name}": ${e.message}`);
    }
  }

  // Pass 2: link managers + assign roles
  for (const p of personas) {
    if (!p || !p.user_name || !userSysIds[p.user_name]) continue;
    const sysId = userSysIds[p.user_name];

    if (p.manager_username && userSysIds[p.manager_username]) {
      try {
        await serviceNowClient.updateRecord('sys_user', sysId, {
          manager: userSysIds[p.manager_username]
        });
      } catch (e) {
        out.errors.push(`Manager link for ${p.user_name}: ${e.message}`);
      }
    }

    if (Array.isArray(p.roles)) {
      for (const roleName of p.roles) {
        if (!roleName) continue;
        try {
          const roles = await serviceNowClient.getRecords('sys_user_role', {
            sysparm_query: `name=${ESC_QV(roleName)}`,
            sysparm_limit: 1,
            sysparm_fields: 'sys_id,name'
          });
          if (!roles[0]) {
            out.errors.push(`Role not found for ${p.user_name}: "${roleName}"`);
            continue;
          }
          const existing = await serviceNowClient.getRecords('sys_user_has_role', {
            sysparm_query: `user=${sysId}^role=${roles[0].sys_id}`,
            sysparm_limit: 1,
            sysparm_fields: 'sys_id'
          });
          if (existing[0]) continue;
          await serviceNowClient.createRecord('sys_user_has_role', {
            user: sysId,
            role: roles[0].sys_id
          });
          out.roles_assigned++;
        } catch (e) {
          out.errors.push(`Role "${roleName}" for ${p.user_name}: ${e.message}`);
        }
      }
    }
  }

  return out;
}

async function upsertIncidents(serviceNowClient, incidents, userMap, out) {
  if (!Array.isArray(incidents) || incidents.length === 0) return;
  for (const inc of incidents) {
    if (!inc || !inc.short_description) {
      out.errors.push(`Incident missing short_description: ${JSON.stringify(inc)}`);
      continue;
    }
    try {
      let existing = [];
      if (inc.correlation_id) {
        existing = await serviceNowClient.getRecords('incident', {
          sysparm_query: `correlation_id=${ESC_QV(inc.correlation_id)}`,
          sysparm_limit: 1,
          sysparm_fields: 'sys_id,number,correlation_id'
        });
      }
      if (existing[0]) {
        out.incidents.skipped.push({
          correlation_id: inc.correlation_id,
          number: existing[0].number,
          sys_id: existing[0].sys_id,
          reason: 'already exists'
        });
        continue;
      }
      const data = {
        short_description: inc.short_description,
        description: inc.description || '',
        category: inc.category || 'inquiry'
      };
      if (inc.urgency != null) data.urgency = String(inc.urgency);
      if (inc.impact != null) data.impact = String(inc.impact);
      if (inc.correlation_id) data.correlation_id = inc.correlation_id;
      if (inc.caller_username && userMap[inc.caller_username]) {
        data.caller_id = userMap[inc.caller_username];
      }
      const created = await serviceNowClient.createRecord('incident', data);
      out.incidents.created.push({
        number: created.number,
        sys_id: created.sys_id,
        correlation_id: inc.correlation_id || null
      });
    } catch (e) {
      out.errors.push(`Incident "${inc.correlation_id || inc.short_description}": ${e.message}`);
    }
  }
}

async function upsertHrCases(serviceNowClient, hrCases, out) {
  if (!Array.isArray(hrCases) || hrCases.length === 0) return;
  // Plugin probe first — sn_hr_core_case is gated by HRSD. If it's missing we
  // skip the whole batch with a friendly note rather than 404'ing per record.
  const available = await probeTable(serviceNowClient, 'sn_hr_core_case');
  out.hr_cases.available = available;
  if (!available) {
    out.hr_cases.skipped.push({
      reason: 'sn_hr_core_case table not available (HRSD plugin not active); skipped',
      count: hrCases.length
    });
    return;
  }
  for (const c of hrCases) {
    if (!c || !c.short_description) {
      out.errors.push(`HR case missing short_description: ${JSON.stringify(c)}`);
      continue;
    }
    try {
      let existing = [];
      if (c.correlation_id) {
        existing = await serviceNowClient.getRecords('sn_hr_core_case', {
          sysparm_query: `correlation_id=${ESC_QV(c.correlation_id)}`,
          sysparm_limit: 1,
          sysparm_fields: 'sys_id,number,correlation_id'
        });
      }
      if (existing[0]) {
        out.hr_cases.skipped.push({
          correlation_id: c.correlation_id,
          number: existing[0].number,
          sys_id: existing[0].sys_id,
          reason: 'already exists'
        });
        continue;
      }
      const data = {
        short_description: c.short_description,
        description: c.description || ''
      };
      if (c.correlation_id) data.correlation_id = c.correlation_id;
      const created = await serviceNowClient.createRecord('sn_hr_core_case', data);
      out.hr_cases.created.push({
        number: created.number,
        sys_id: created.sys_id,
        correlation_id: c.correlation_id || null
      });
    } catch (e) {
      out.errors.push(`HR case "${c.correlation_id || c.short_description}": ${e.message}`);
    }
  }
}

async function upsertPurchaseOrders(serviceNowClient, pos, out) {
  if (!Array.isArray(pos) || pos.length === 0) return;
  const available = await probeTable(serviceNowClient, 'proc_po');
  out.purchase_orders.available = available;
  if (!available) {
    out.purchase_orders.skipped.push({
      reason: 'proc_po table not available (Procurement plugin not active); skipped',
      count: pos.length
    });
    return;
  }
  for (const p of pos) {
    if (!p || !p.short_description) {
      out.errors.push(`Purchase order missing short_description: ${JSON.stringify(p)}`);
      continue;
    }
    try {
      let existing = [];
      if (p.correlation_id) {
        existing = await serviceNowClient.getRecords('proc_po', {
          sysparm_query: `correlation_id=${ESC_QV(p.correlation_id)}`,
          sysparm_limit: 1,
          sysparm_fields: 'sys_id,number,correlation_id'
        });
      }
      if (existing[0]) {
        out.purchase_orders.skipped.push({
          correlation_id: p.correlation_id,
          number: existing[0].number,
          sys_id: existing[0].sys_id,
          reason: 'already exists'
        });
        continue;
      }
      const data = { short_description: p.short_description };
      if (p.total_cost != null) data.total_cost = String(p.total_cost);
      if (p.correlation_id) data.correlation_id = p.correlation_id;
      const created = await serviceNowClient.createRecord('proc_po', data);
      out.purchase_orders.created.push({
        number: created.number,
        sys_id: created.sys_id,
        correlation_id: p.correlation_id || null
      });
    } catch (e) {
      out.errors.push(`Purchase order "${p.correlation_id || p.short_description}": ${e.message}`);
    }
  }
}

/**
 * applyData — idempotent upserts for demo data tables. Accepts either:
 *   - Array of incidents (legacy shape, kept for back-compat)
 *   - Object { incidents, hr_cases, purchase_orders } (current shape)
 *
 * Each sub-array is keyed on correlation_id when supplied. HR cases and
 * purchase orders are gated by their respective plugins (HRSD / Procurement);
 * if the table isn't on the instance we skip the batch cleanly via probeTable
 * rather than emitting per-record errors.
 */
export async function applyData(serviceNowClient, payload, options = {}) {
  const out = {
    incidents: { created: [], skipped: [] },
    hr_cases: { created: [], skipped: [], available: null },
    purchase_orders: { created: [], skipped: [], available: null },
    errors: []
  };
  const userMap = options.userSysIds || {};

  let incidents = [];
  let hrCases = [];
  let pos = [];
  if (Array.isArray(payload)) {
    incidents = payload;
  } else if (payload && typeof payload === 'object') {
    incidents = Array.isArray(payload.incidents) ? payload.incidents : [];
    hrCases = Array.isArray(payload.hr_cases) ? payload.hr_cases : [];
    pos = Array.isArray(payload.purchase_orders) ? payload.purchase_orders : [];
  }

  await upsertIncidents(serviceNowClient, incidents, userMap, out);
  await upsertHrCases(serviceNowClient, hrCases, out);
  await upsertPurchaseOrders(serviceNowClient, pos, out);

  // Flat aliases preserved for back-compat with any caller still treating
  // applyData's result like the old "incidents only" shape.
  out.created = out.incidents.created;
  out.skipped = out.incidents.skipped;
  return out;
}

async function resolveDefaultCatalog(serviceNowClient) {
  try {
    const catalogs = await serviceNowClient.getRecords('sc_catalog', {
      sysparm_query: 'active=true',
      sysparm_limit: 1,
      sysparm_fields: 'sys_id,title'
    });
    return catalogs[0] ? catalogs[0].sys_id : null;
  } catch {
    return null;
  }
}

async function upsertVariable(serviceNowClient, itemSysId, variable) {
  const existing = await serviceNowClient.getRecords('item_option_new', {
    sysparm_query: `cat_item=${itemSysId}^name=${ESC_QV(variable.name)}`,
    sysparm_limit: 1,
    sysparm_fields: 'sys_id'
  });
  if (existing[0]) return existing[0].sys_id;
  const created = await serviceNowClient.createRecord('item_option_new', {
    cat_item: itemSysId,
    name: variable.name,
    question_text: variable.question || variable.name,
    type: variable.type != null ? String(variable.type) : '6',
    order: variable.order != null ? String(variable.order) : '100',
    active: 'true'
  });
  return created.sys_id;
}

async function upsertChoice(serviceNowClient, varSysId, choice) {
  const existing = await serviceNowClient.getRecords('question_choice', {
    sysparm_query: `question=${varSysId}^value=${ESC_QV(choice.value)}`,
    sysparm_limit: 1,
    sysparm_fields: 'sys_id'
  });
  if (existing[0]) return existing[0].sys_id;
  const created = await serviceNowClient.createRecord('question_choice', {
    question: varSysId,
    text: choice.label,
    value: choice.value,
    order: choice.order != null ? String(choice.order) : '100'
  });
  return created.sys_id;
}

/**
 * applyCatalog — idempotent upserts for sc_category and sc_cat_item, plus
 * any item.variables (with optional .choices).
 */
export async function applyCatalog(serviceNowClient, categories, catalogItems) {
  const out = {
    categories: { created: [], skipped: [] },
    catalogItems: { created: [], skipped: [] },
    variables_created: 0,
    choices_created: 0,
    errors: []
  };

  const defaultCatalogId = await resolveDefaultCatalog(serviceNowClient);
  if (!defaultCatalogId) {
    out.errors.push('No active sc_catalog found; categories/items will be created without sc_catalog binding.');
  }

  const categoryMap = new Map();
  for (const cat of categories || []) {
    if (!cat || !cat.name) {
      out.errors.push(`Category missing name: ${JSON.stringify(cat)}`);
      continue;
    }
    try {
      const existing = await serviceNowClient.getRecords('sc_category', {
        sysparm_query: `title=${ESC_QV(cat.name)}`,
        sysparm_limit: 1,
        sysparm_fields: 'sys_id,title'
      });
      if (existing[0]) {
        categoryMap.set(cat.name, existing[0].sys_id);
        out.categories.skipped.push({ name: cat.name, sys_id: existing[0].sys_id, reason: 'already exists' });
      } else {
        const data = { title: cat.name, description: cat.description || '', active: 'true' };
        if (defaultCatalogId) data.sc_catalog = defaultCatalogId;
        const created = await serviceNowClient.createRecord('sc_category', data);
        categoryMap.set(cat.name, created.sys_id);
        out.categories.created.push({ name: cat.name, sys_id: created.sys_id });
      }
    } catch (e) {
      out.errors.push(`Category "${cat.name}": ${e.message}`);
    }
  }

  for (const item of catalogItems || []) {
    if (!item || !item.name) {
      out.errors.push(`Catalog item missing name: ${JSON.stringify(item)}`);
      continue;
    }
    try {
      const existing = await serviceNowClient.getRecords('sc_cat_item', {
        sysparm_query: `name=${ESC_QV(item.name)}`,
        sysparm_limit: 1,
        sysparm_fields: 'sys_id,name'
      });
      let itemSysId;
      if (existing[0]) {
        itemSysId = existing[0].sys_id;
        out.catalogItems.skipped.push({ name: item.name, sys_id: itemSysId, reason: 'already exists' });
      } else {
        const data = {
          name: item.name,
          short_description: item.short_description || '',
          description: item.description || '',
          price: item.price != null ? String(item.price) : '0',
          active: 'true'
        };
        if (item.category && categoryMap.has(item.category)) {
          data.category = categoryMap.get(item.category);
        } else if (item.category) {
          out.errors.push(`Catalog item "${item.name}" references unknown category "${item.category}"`);
        }
        if (defaultCatalogId) data.sc_catalogs = defaultCatalogId;
        const created = await serviceNowClient.createRecord('sc_cat_item', data);
        itemSysId = created.sys_id;
        out.catalogItems.created.push({ name: item.name, sys_id: itemSysId, category: item.category || null });
      }

      if (Array.isArray(item.variables) && itemSysId) {
        for (const v of item.variables) {
          if (!v || !v.name) continue;
          try {
            const varSysId = await upsertVariable(serviceNowClient, itemSysId, v);
            if (varSysId) out.variables_created++;
            if (Array.isArray(v.choices)) {
              for (const c of v.choices) {
                if (!c || c.value == null) continue;
                const chId = await upsertChoice(serviceNowClient, varSysId, c);
                if (chId) out.choices_created++;
              }
            }
          } catch (e) {
            out.errors.push(`Variable "${v.name}" on "${item.name}": ${e.message}`);
          }
        }
      }
    } catch (e) {
      out.errors.push(`Catalog item "${item.name}": ${e.message}`);
    }
  }

  return out;
}

/**
 * applyWidgetOverrides — relabel sp_instance widget titles in place.
 */
export async function applyWidgetOverrides(serviceNowClient, overrides) {
  const out = { applied: [], skipped: [], errors: [] };
  if (!Array.isArray(overrides) || overrides.length === 0) return out;

  for (const ov of overrides) {
    if (!ov || !ov.originalTitle || !ov.newTitle) {
      out.errors.push(`Widget override missing originalTitle/newTitle: ${JSON.stringify(ov)}`);
      continue;
    }
    try {
      const matches = await serviceNowClient.getRecords('sp_instance', {
        sysparm_query: `title=${ESC_QV(ov.originalTitle)}`,
        sysparm_limit: 100,
        sysparm_fields: 'sys_id,title'
      });
      if (matches.length === 0) {
        out.skipped.push({ originalTitle: ov.originalTitle, reason: 'no sp_instance with that title' });
        continue;
      }
      for (const m of matches) {
        await serviceNowClient.updateRecord('sp_instance', m.sys_id, { title: ov.newTitle });
        out.applied.push({ sys_id: m.sys_id, was: ov.originalTitle, now: ov.newTitle });
      }
    } catch (e) {
      out.errors.push(`Widget override "${ov.originalTitle}" → "${ov.newTitle}": ${e.message}`);
    }
  }
  return out;
}

/**
 * applyDashboard — bind one or more pre-existing sp_widget records to the
 * first column of a Service Portal page (default: 'index') as sp_instance
 * rows. Pure REST.
 *
 * Column resolution: dot-walked sysparm_query
 *   `sp_row.sp_container.sp_page=<pageId>^ORDERBYorder` LIMIT 1
 *
 * Idempotency key: composite (sp_column, sp_widget). Re-running the tool
 * with the same (page, widget) pair is a no-op.
 *
 * Cleanup: when clientPrefix is supplied, every new sp_instance is stamped
 * with class_name = `demo-<clientPrefix>` so revertByPrefix can sweep them.
 * (Note: sp_instance has no css_class field; class_name is the real
 * Bootstrap-class hook — string, max 40 chars.)
 *
 * @param dashboardSpec {
 *   pageId?: string         // sp_page.id; defaults to 'index'
 *   clientPrefix?: string   // recommended; enables clean revert
 *   widgets: [{
 *     id: string             // sp_widget.id
 *     order?: string|number  // sp_instance.order, default '100'
 *     title?: string
 *     instanceFields?: object
 *   }]
 * }
 */
export async function applyDashboard(serviceNowClient, dashboardSpec) {
  const out = {
    page: { id: null, sys_id: null },
    column: { sys_id: null },
    widgets: { created: [], skipped: [], missing: [] },
    errors: []
  };
  if (!dashboardSpec || typeof dashboardSpec !== 'object') {
    out.errors.push('applyDashboard: dashboardSpec object is required');
    return out;
  }
  const pageId = dashboardSpec.pageId || 'index';
  const clientPrefix = dashboardSpec.clientPrefix || '';
  const widgets = Array.isArray(dashboardSpec.widgets) ? dashboardSpec.widgets : [];
  out.page.id = pageId;

  if (widgets.length === 0) {
    out.errors.push('applyDashboard: widgets[] is required and must be non-empty');
    return out;
  }

  let pageSysId;
  try {
    const pages = await serviceNowClient.getRecords('sp_page', {
      sysparm_query: `id=${ESC_QV(pageId)}`,
      sysparm_limit: 1,
      sysparm_fields: 'sys_id,id,title'
    });
    if (!pages[0]) {
      out.errors.push(`applyDashboard: sp_page.id="${pageId}" not found`);
      return out;
    }
    pageSysId = pages[0].sys_id;
    out.page.sys_id = pageSysId;
  } catch (e) {
    out.errors.push(`applyDashboard: page lookup failed: ${e.message}`);
    return out;
  }

  let columnSysId;
  try {
    const columns = await serviceNowClient.getRecords('sp_column', {
      sysparm_query: `sp_row.sp_container.sp_page=${pageSysId}^ORDERBYorder`,
      sysparm_limit: 1,
      sysparm_fields: 'sys_id,order'
    });
    if (!columns[0]) {
      out.errors.push(`applyDashboard: page "${pageId}" has no row/container/column structure; cannot bind widgets`);
      return out;
    }
    columnSysId = columns[0].sys_id;
    out.column.sys_id = columnSysId;
  } catch (e) {
    out.errors.push(`applyDashboard: column lookup failed: ${e.message}`);
    return out;
  }

  for (const w of widgets) {
    if (!w || !w.id) {
      out.errors.push(`applyDashboard: widget missing id: ${JSON.stringify(w)}`);
      continue;
    }
    let widgetSysId;
    try {
      const matches = await serviceNowClient.getRecords('sp_widget', {
        sysparm_query: `id=${ESC_QV(w.id)}`,
        sysparm_limit: 1,
        sysparm_fields: 'sys_id,id,name'
      });
      if (!matches[0]) {
        out.widgets.missing.push({ id: w.id, reason: 'sp_widget not found on instance (deploy via Update Set / scoped app first)' });
        continue;
      }
      widgetSysId = matches[0].sys_id;
    } catch (e) {
      out.errors.push(`Widget lookup "${w.id}": ${e.message}`);
      continue;
    }

    try {
      const existing = await serviceNowClient.getRecords('sp_instance', {
        sysparm_query: `sp_column=${columnSysId}^sp_widget=${widgetSysId}`,
        sysparm_limit: 1,
        sysparm_fields: 'sys_id,title,order'
      });
      if (existing[0]) {
        out.widgets.skipped.push({
          id: w.id,
          sys_id: existing[0].sys_id,
          reason: 'sp_instance already exists for (column, widget)'
        });
        continue;
      }
      const data = {
        sp_column: columnSysId,
        sp_widget: widgetSysId,
        order: w.order != null ? String(w.order) : '100'
      };
      if (w.title) data.title = w.title;
      if (clientPrefix) data.class_name = `demo-${clientPrefix}`;
      if (w.instanceFields && typeof w.instanceFields === 'object') {
        for (const [k, v] of Object.entries(w.instanceFields)) {
          if (v != null) data[k] = typeof v === 'string' ? v : String(v);
        }
      }
      const created = await serviceNowClient.createRecord('sp_instance', data);
      out.widgets.created.push({ id: w.id, sys_id: created.sys_id, order: data.order });
    } catch (e) {
      out.errors.push(`Widget instance "${w.id}": ${e.message}`);
    }
  }

  return out;
}

/**
 * applyReports — idempotent upserts of sys_report rows used by demo
 * dashboards. Keyed on title (callers should prefix titles with the
 * clientPrefix so revertByPrefix can clean them up). Pure REST — sys_report
 * is a vanilla table with no Glide-only side effects worth running server-side.
 *
 * Each report: { title, table, type, field?, filter?, group_by? }
 *   - title: required, unique key for idempotency
 *   - table: required, target Glide table the report runs against
 *   - type:  required, chart type (donut, bar, pie, list, ...)
 *   - field, filter, group_by: optional pass-through
 */
export async function applyReports(serviceNowClient, reports) {
  const out = { created: [], skipped: [], errors: [] };
  if (!Array.isArray(reports) || reports.length === 0) return out;

  for (const r of reports) {
    if (!r || !r.title || !r.table || !r.type) {
      out.errors.push(`Report missing required fields (title/table/type): ${JSON.stringify(r)}`);
      continue;
    }
    try {
      const existing = await serviceNowClient.getRecords('sys_report', {
        sysparm_query: `title=${ESC_QV(r.title)}`,
        sysparm_limit: 1,
        sysparm_fields: 'sys_id,title'
      });
      if (existing[0]) {
        out.skipped.push({ title: r.title, sys_id: existing[0].sys_id, reason: 'already exists' });
        continue;
      }
      const data = {
        title: r.title,
        table: r.table,
        type: r.type
      };
      if (r.field) data.field = r.field;
      if (r.filter) data.filter = r.filter;
      if (r.group_by) data.group_by = r.group_by;
      const created = await serviceNowClient.createRecord('sys_report', data);
      out.created.push({ title: r.title, sys_id: created.sys_id, table: r.table, type: r.type });
    } catch (e) {
      out.errors.push(`Report "${r.title}": ${e.message}`);
    }
  }
  return out;
}

/**
 * revertDemo — server-side bulk delete via the Script Include. Single
 * transaction, dramatically faster than N REST DELETEs.
 */
export async function revertDemo(serviceNowClient, clientPrefix) {
  if (!clientPrefix) throw new Error('revertDemo: clientPrefix is required');
  return callOrchestratorEndpoint(serviceNowClient, '/revert', { clientPrefix });
}

/**
 * ensureUpdateSet — create or reuse "<prefix> Demo Deploy" and make it current.
 */
export async function ensureUpdateSet(serviceNowClient, clientName, clientPrefix) {
  const usName = `${clientPrefix} Demo Deploy`;
  const existing = await serviceNowClient.getRecords('sys_update_set', {
    sysparm_query: `name=${ESC_QV(usName)}^state=in progress`,
    sysparm_limit: 1
  });
  let us = existing[0];
  let reused = !!us;
  if (!us) {
    us = await serviceNowClient.createRecord('sys_update_set', {
      name: usName,
      description: `Auto-generated demo deployment for ${clientName} via SN-Deploy-Demo`
    });
  }
  try {
    await serviceNowClient.setCurrentUpdateSet(us.sys_id);
  } catch (e) {
    return { name: us.name, sys_id: us.sys_id, reused, current_set_warning: e.message };
  }
  return { name: us.name, sys_id: us.sys_id, reused };
}

/**
 * deployDemo — top-level composition that mirrors the old SN-Deploy-Demo
 * behaviour but composed of the verbs above. Each verb runs independently;
 * one verb's errors don't abort the rest.
 */
export async function deployDemo(serviceNowClient, spec) {
  if (!spec || typeof spec !== 'object') throw new Error('deployDemo: spec is required');
  const clientName = spec.clientName;
  const clientPrefix = spec.clientPrefix;
  if (!clientName) throw new Error('deployDemo: clientName is required');
  if (!clientPrefix) throw new Error('deployDemo: clientPrefix is required');
  if (!/^[A-Za-z0-9_]+$/.test(clientPrefix)) {
    throw new Error(`deployDemo: clientPrefix must be alphanumeric/underscore (got: ${clientPrefix})`);
  }

  const receipt = emptyReceipt(clientName, clientPrefix);

  try {
    receipt.update_set = await ensureUpdateSet(serviceNowClient, clientName, clientPrefix);
  } catch (e) {
    receipt.errors.push(`Update set provisioning failed: ${e.message}`);
  }

  // Branding (Script Include + optional hero container REST patch).
  const wantsBranding = spec.primaryColor || spec.secondaryColor ||
    spec.logoBase64 || spec.logoUrl ||
    spec.heroBackgroundColor || spec.heroBackgroundImage;
  if (wantsBranding) {
    try {
      receipt.branding = await applyBranding(serviceNowClient, {
        clientName,
        primaryColor: spec.primaryColor,
        secondaryColor: spec.secondaryColor,
        navbarBgColor: spec.navbarBgColor,
        navbarTextColor: spec.navbarTextColor,
        logoUrl: spec.logoUrl,
        logoBase64: spec.logoBase64,
        logoMimeType: spec.logoMimeType,
        heroBackgroundColor: spec.heroBackgroundColor,
        heroBackgroundImage: spec.heroBackgroundImage,
        heroPageId: spec.heroPageId
      });
    } catch (e) {
      receipt.errors.push(`Branding (Script Include): ${e.message}`);
    }
  }

  // Catalog (categories + items + their variables/choices)
  try {
    const catalogResult = await applyCatalog(
      serviceNowClient,
      spec.categories || [],
      spec.catalogItems || []
    );
    receipt.categories = catalogResult.categories;
    receipt.catalogItems = catalogResult.catalogItems;
    if (catalogResult.errors.length) receipt.errors.push(...catalogResult.errors);
  } catch (e) {
    receipt.errors.push(`Catalog: ${e.message}`);
  }

  // Personas (users + roles)
  let userSysIds = {};
  try {
    const personas = spec.personas || spec.users || [];
    const personaResult = await applyPersonas(serviceNowClient, personas);
    receipt.users = { created: personaResult.created, skipped: personaResult.skipped };
    receipt.roles_assigned = personaResult.roles_assigned;
    if (personaResult.errors.length) receipt.errors.push(...personaResult.errors);
    for (const u of [...personaResult.created, ...personaResult.skipped]) {
      if (u.user_name && u.sys_id) userSysIds[u.user_name] = u.sys_id;
    }
  } catch (e) {
    receipt.errors.push(`Personas: ${e.message}`);
  }

  // Data (incidents + hr_cases + purchase_orders)
  try {
    const dataResult = await applyData(
      serviceNowClient,
      {
        incidents: spec.incidents || [],
        hr_cases: spec.hr_cases || [],
        purchase_orders: spec.purchase_orders || []
      },
      { userSysIds }
    );
    receipt.incidents = { created: dataResult.incidents.created, skipped: dataResult.incidents.skipped };
    receipt.hr_cases = {
      created: dataResult.hr_cases.created,
      skipped: dataResult.hr_cases.skipped,
      available: dataResult.hr_cases.available
    };
    receipt.purchase_orders = {
      created: dataResult.purchase_orders.created,
      skipped: dataResult.purchase_orders.skipped,
      available: dataResult.purchase_orders.available
    };
    if (dataResult.errors.length) receipt.errors.push(...dataResult.errors);
  } catch (e) {
    receipt.errors.push(`Data: ${e.message}`);
  }

  // Widget overrides
  if (Array.isArray(spec.widgetOverrides) && spec.widgetOverrides.length > 0) {
    try {
      const woResult = await applyWidgetOverrides(serviceNowClient, spec.widgetOverrides);
      receipt.widgetOverrides = { applied: woResult.applied, skipped: woResult.skipped };
      if (woResult.errors.length) receipt.errors.push(...woResult.errors);
    } catch (e) {
      receipt.errors.push(`Widget overrides: ${e.message}`);
    }
  }

  // Reports (sys_report) — keyed on title
  if (Array.isArray(spec.reports) && spec.reports.length > 0) {
    try {
      const reportResult = await applyReports(serviceNowClient, spec.reports);
      receipt.reports = { created: reportResult.created, skipped: reportResult.skipped };
      if (reportResult.errors.length) receipt.errors.push(...reportResult.errors);
    } catch (e) {
      receipt.errors.push(`Reports: ${e.message}`);
    }
  }

  // Dashboard widget bindings (sp_instance) — clientPrefix flows through so
  // revertByPrefix can sweep the bindings via css_class.
  if (spec.dashboard && typeof spec.dashboard === 'object') {
    try {
      const dashResult = await applyDashboard(serviceNowClient, {
        pageId: spec.dashboard.pageId,
        widgets: spec.dashboard.widgets || [],
        clientPrefix
      });
      receipt.dashboard = dashResult;
      if (dashResult.errors.length) receipt.errors.push(...dashResult.errors);
    } catch (e) {
      receipt.errors.push(`Dashboard: ${e.message}`);
    }
  }

  receipt.summary = {
    branding_themes_updated: receipt.branding ? receipt.branding.themesUpdated || 0 : 0,
    branding_logo_uploaded: !!(receipt.branding && receipt.branding.logoSysId),
    branding_hero_applied: !!(receipt.branding && receipt.branding.heroBackground && receipt.branding.heroBackground.applied),
    categories_created: receipt.categories.created.length,
    categories_skipped: receipt.categories.skipped.length,
    catalog_items_created: receipt.catalogItems.created.length,
    catalog_items_skipped: receipt.catalogItems.skipped.length,
    users_created: receipt.users.created.length,
    users_skipped: receipt.users.skipped.length,
    incidents_created: receipt.incidents.created.length,
    incidents_skipped: receipt.incidents.skipped.length,
    hr_cases_created: receipt.hr_cases.created.length,
    hr_cases_skipped: receipt.hr_cases.skipped.length,
    hr_cases_available: receipt.hr_cases.available,
    purchase_orders_created: receipt.purchase_orders.created.length,
    purchase_orders_skipped: receipt.purchase_orders.skipped.length,
    purchase_orders_available: receipt.purchase_orders.available,
    reports_created: receipt.reports.created.length,
    reports_skipped: receipt.reports.skipped.length,
    dashboard_widgets_bound: receipt.dashboard ? receipt.dashboard.widgets.created.length : 0,
    dashboard_widgets_skipped: receipt.dashboard ? receipt.dashboard.widgets.skipped.length : 0,
    dashboard_widgets_missing: receipt.dashboard ? receipt.dashboard.widgets.missing.length : 0,
    widget_overrides_applied: receipt.widgetOverrides.applied.length,
    errors: receipt.errors.length
  };

  return receipt;
}
