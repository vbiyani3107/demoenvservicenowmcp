/**
 * Deploys the slim DemoOrchestratorAPI Script Include AND the companion
 * "Demo Orchestrator" Scripted REST API that exposes its two server-side
 * verbs (applyBranding, revertByPrefix) over HTTP for the Demo Env ServiceNow MCP server.
 *
 * Idempotent: re-running updates existing records in place.
 *
 * Scope handling:
 *   ServiceNow stamps new records with whatever application the caller's
 *   session has selected. If an admin is currently in a custom scoped app
 *   when they run this script, the Script Include + Scripted REST API land
 *   in that scope — and the resulting URL becomes /api/<numeric>/...
 *   instead of /api/global/...
 *
 *   To make this script reliable for any admin, regardless of which app
 *   they have selected in the UI:
 *
 *     1. We pin the admin's `apps.current_app` user preference to 'global'
 *        before doing anything else. (User preferences are read on every
 *        REST transaction, so subsequent calls in the same run land in
 *        global immediately.)
 *
 *     2. We pass `sys_scope: 'global'` explicitly in every record payload
 *        (belt-and-suspenders).
 *
 *     3. If we find an existing record sitting in the WRONG scope (typically
 *        from a previous run that pre-dates this fix), we delete it first
 *        and recreate it in global. This guarantees the URL stabilises on
 *        /api/global/demo_orchestrator/... after one re-run.
 *
 * Endpoints created:
 *   POST  /api/global/demo_orchestrator/branding   -> applyBranding(payload)
 *   POST  /api/global/demo_orchestrator/revert     -> revertByPrefix({clientPrefix})
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

// Connection details come from the environment ONLY — never check credentials
// into source. See .env.example at the repo root for the expected variables.
const instanceUrl = process.env.SN_INSTANCE;
const username = process.env.SN_USERNAME;
const password = process.env.SN_PASSWORD;
const missingEnv = [];
if (!instanceUrl) missingEnv.push('SN_INSTANCE');
if (!username) missingEnv.push('SN_USERNAME');
if (!password) missingEnv.push('SN_PASSWORD');
if (missingEnv.length > 0) {
    console.error(`\n❌ Missing required environment variable(s): ${missingEnv.join(', ')}\n`);
    console.error('   Set them in your shell or a .env file before running, e.g.:\n');
    console.error("     SN_INSTANCE=your-instance.service-now.com \\");
    console.error('     SN_USERNAME=admin \\');
    console.error("     SN_PASSWORD='********' \\");
    console.error('     node scripts/deploy_script_include.cjs\n');
    process.exit(1);
}
const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

const SCRIPT_INCLUDE_NAME = 'DemoOrchestratorAPI';
const REST_API_NAME = 'Demo Orchestrator';
const REST_API_SERVICE_ID = 'demo_orchestrator';
const GLOBAL_SCOPE_SYS_ID = 'global'; // ServiceNow uses the literal string 'global' as the global scope's sys_id.

// Resolve the canonical Script Include source relative to THIS file so the
// script works regardless of which directory the user runs it from. The SI
// lives in <repo>/servicenow/DemoOrchestratorAPI.js, this file lives in
// <repo>/scripts/deploy_script_include.js, hence ../servicenow.
const SI_SOURCE_PATH = path.join(__dirname, '..', 'servicenow', 'DemoOrchestratorAPI.js');
if (!fs.existsSync(SI_SOURCE_PATH)) {
    console.error(`\n❌ Cannot find Script Include source at ${SI_SOURCE_PATH}\n`);
    process.exit(1);
}
const scriptCode = fs.readFileSync(SI_SOURCE_PATH, 'utf8');

function makeRequest(method, path, data) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: instanceUrl,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': authHeader
            }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
                catch { resolve({ status: res.statusCode, data: body }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

/**
 * Returns the sys_scope.value (i.e. scope sys_id) on a record, or null
 * if the field is absent. Handles both the {link,value} form returned by
 * the Table API and the flat-string form some endpoints use.
 */
function readScope(record) {
    if (!record || !record.sys_scope) return null;
    if (typeof record.sys_scope === 'string') return record.sys_scope;
    if (typeof record.sys_scope === 'object' && record.sys_scope.value) return record.sys_scope.value;
    return null;
}

/**
 * Pin the calling user's `apps.current_app` preference to 'global' so that
 * every record we create in this run lands in the global scope, regardless
 * of which application the admin had selected in the UI.
 */
async function pinSessionToGlobalScope() {
    const userResp = await makeRequest(
        'GET',
        `/api/now/table/sys_user?sysparm_query=user_name=${encodeURIComponent(username)}&sysparm_limit=1&sysparm_fields=sys_id,user_name`
    );
    const userSysId = userResp.data && userResp.data.result && userResp.data.result[0] && userResp.data.result[0].sys_id;
    if (!userSysId) {
        console.log(`   ⚠️  Could not look up sys_user.sys_id for "${username}" — scope-pinning skipped.`);
        console.log('       (This is non-fatal; sys_scope=global on each payload still applies.)');
        return;
    }
    const q = encodeURIComponent(`user=${userSysId}^name=apps.current_app`);
    const existing = await makeRequest('GET', `/api/now/table/sys_user_preference?sysparm_query=${q}&sysparm_limit=1&sysparm_fields=sys_id,value`);
    if (existing.data && existing.data.result && existing.data.result.length > 0) {
        const pref = existing.data.result[0];
        if (pref.value === GLOBAL_SCOPE_SYS_ID) {
            console.log(`   Session scope already pinned to 'global' for ${username}.`);
            return;
        }
        await makeRequest('PUT', `/api/now/table/sys_user_preference/${pref.sys_id}`, { value: GLOBAL_SCOPE_SYS_ID });
        console.log(`   Repinned ${username}'s session scope: '${pref.value}' → 'global'.`);
    } else {
        await makeRequest('POST', '/api/now/table/sys_user_preference', {
            user: userSysId,
            name: 'apps.current_app',
            value: GLOBAL_SCOPE_SYS_ID,
            type: 'string'
        });
        console.log(`   Pinned ${username}'s session scope to 'global' (new preference).`);
    }
}

/**
 * Idempotent upsert that pins records to the global scope.
 *
 * Behaviour:
 *   - If no record matches the query, POSTs a new one with sys_scope=global.
 *   - If a matching record exists in global scope, PUTs the payload onto it.
 *   - If a matching record exists in any OTHER scope (mis-scoped from a
 *     prior run), DELETEs the misscoped record first, then POSTs fresh in
 *     global. We never silently update a misscoped record because the
 *     resulting URL prefix would stay non-global.
 *
 * @param opts.preDelete      optional async callback invoked with the sys_id
 *   of a record about to be deleted. Used by the WS definition path to clear
 *   child operations first so the cascade is clean.
 * @param opts.recreateIf     optional predicate (record) => boolean. If it
 *   returns true even on a global-scoped match, the record is treated like
 *   a misscoped one — deleted and recreated. Used for sys_ws_definition,
 *   whose `namespace` field is read-only on update; the only way to refresh
 *   a stale namespace is to recreate the row.
 * @param opts.extraFields    additional sysparm_fields to include in the
 *   lookup so recreateIf has the data it needs to decide.
 */
async function upsertInGlobal(table, queryField, queryValue, recordPayload, label, opts) {
    opts = opts || {};
    const preDelete = opts.preDelete;
    const recreateIf = opts.recreateIf;
    const extraFields = opts.extraFields || '';

    recordPayload.sys_scope = GLOBAL_SCOPE_SYS_ID;
    const q = `${queryField}=${encodeURIComponent(queryValue)}`;
    const fields = ['sys_id', 'sys_scope', extraFields].filter(Boolean).join(',');
    const found = await makeRequest(
        'GET',
        `/api/now/table/${table}?sysparm_query=${q}&sysparm_limit=10&sysparm_fields=${fields}`
    );
    const matches = (found.data && found.data.result) || [];

    let globalMatch = null;
    const toDelete = [];
    for (const rec of matches) {
        const scope = readScope(rec);
        if (scope !== GLOBAL_SCOPE_SYS_ID) {
            toDelete.push({ sys_id: rec.sys_id, scope, reason: `scope=${scope || 'unknown'}` });
            continue;
        }
        if (recreateIf && recreateIf(rec)) {
            toDelete.push({ sys_id: rec.sys_id, scope, reason: 'stale immutable field — recreate' });
            continue;
        }
        globalMatch = rec;
    }

    for (const m of toDelete) {
        if (typeof preDelete === 'function') {
            try { await preDelete(m.sys_id); } catch (e) { console.log(`   ⚠️  preDelete for ${label} ${m.sys_id} threw: ${e.message}`); }
        }
        const del = await makeRequest('DELETE', `/api/now/table/${table}/${m.sys_id}`);
        const ok = del.status === 200 || del.status === 204;
        console.log(`   ${ok ? '🧹 Deleted' : '❌ Failed to delete'} ${label} (${m.sys_id}, ${m.reason})`);
    }

    if (globalMatch) {
        const updated = await makeRequest('PUT', `/api/now/table/${table}/${globalMatch.sys_id}`, recordPayload);
        if (updated.status === 200) {
            console.log(`✅ Updated ${label} in global scope (${globalMatch.sys_id})`);
            return globalMatch.sys_id;
        }
        console.log(`❌ Failed to update ${label}:`, JSON.stringify(updated.data).substring(0, 500));
        return null;
    }

    const created = await makeRequest('POST', `/api/now/table/${table}`, recordPayload);
    if (created.status === 200 || created.status === 201) {
        const sysId = created.data && created.data.result && created.data.result.sys_id;
        console.log(`✅ Created ${label} in global scope (${sysId})`);
        return sysId;
    }
    console.log(`❌ Failed to create ${label}:`, JSON.stringify(created.data).substring(0, 500));
    return null;
}

/**
 * Delete every sys_ws_operation child of a sys_ws_definition. Called before
 * we delete a misscoped sys_ws_definition so its children don't strand.
 */
async function deleteWsOperationsForDefinition(wsSysId) {
    const q = `web_service_definition=${wsSysId}`;
    const found = await makeRequest(
        'GET',
        `/api/now/table/sys_ws_operation?sysparm_query=${q}&sysparm_limit=100&sysparm_fields=sys_id`
    );
    const ops = (found.data && found.data.result) || [];
    for (const op of ops) {
        await makeRequest('DELETE', `/api/now/table/sys_ws_operation/${op.sys_id}`);
    }
    if (ops.length > 0) console.log(`      cleared ${ops.length} child sys_ws_operation row(s) before parent delete`);
}

const brandingOpScript = `(function process(request, response) {
    try {
        var body = request.body && request.body.data ? request.body.data : {};
        var api = new DemoOrchestratorAPI();
        var result = api.applyBranding(body);
        response.setStatus(result && result.ok === false ? 207 : 200);
        response.setContentType('application/json');
        response.setBody(result);
    } catch (e) {
        response.setStatus(500);
        response.setContentType('application/json');
        response.setBody({ ok: false, error: String(e) });
    }
})(request, response);`;

const revertOpScript = `(function process(request, response) {
    try {
        var body = request.body && request.body.data ? request.body.data : {};
        var prefix = body.clientPrefix || body.prefix || '';
        var api = new DemoOrchestratorAPI();
        var result = api.revertByPrefix(prefix);
        response.setStatus(result && result.ok === false ? 207 : 200);
        response.setContentType('application/json');
        response.setBody(result);
    } catch (e) {
        response.setStatus(500);
        response.setContentType('application/json');
        response.setBody({ ok: false, error: String(e) });
    }
})(request, response);`;

async function deploy() {
    console.log(`\n🚀 Deploying to ${instanceUrl} as ${username}\n`);

    // 0) Pin session scope so any new record we create lands in global,
    //    regardless of which app the admin had selected in the UI.
    console.log('0) Session scope');
    await pinSessionToGlobalScope();

    // 1) Script Include
    console.log('\n1) Script Include — DemoOrchestratorAPI');
    const siSysId = await upsertInGlobal(
        'sys_script_include',
        'name',
        SCRIPT_INCLUDE_NAME,
        {
            name: SCRIPT_INCLUDE_NAME,
            api_name: 'global.' + SCRIPT_INCLUDE_NAME,
            script: scriptCode,
            active: 'true',
            client_callable: 'false',
            access: 'public',
            description: 'Server-side companion for the Demo Env ServiceNow MCP demo orchestrator. Owns CSS theme injection (sp_theme), base64 logo upload (GlideSysAttachment), bulk revert (deleteMultiple), and hero container reset.'
        },
        'sys_script_include'
    );
    if (!siSysId) {
        console.log('Aborting: Script Include deploy failed.');
        return;
    }

    // 2) Scripted REST API definition. Pass deleteWsOperationsForDefinition
    //    as the preDelete hook so cascade is clean if a misscoped definition
    //    is being purged.
    // sys_ws_definition.namespace is a SEPARATE field from sys_scope. It
    // determines the URL prefix (base_uri = /api/<namespace>/<service_id>).
    // ServiceNow seeds it from the creating session's app at insert time and
    // does NOT auto-rewrite it when sys_scope is reassigned. So we pin it
    // explicitly here — without this, a definition originally created in a
    // custom-app scope keeps its numeric namespace forever (e.g. /api/415314/)
    // even after the record is moved to global.
    console.log('\n2) Scripted REST API — Demo Orchestrator');
    const wsSysId = await upsertInGlobal(
        'sys_ws_definition',
        'service_id',
        REST_API_SERVICE_ID,
        {
            name: REST_API_NAME,
            service_id: REST_API_SERVICE_ID,
            namespace: 'global',
            active: 'true',
            consumes: 'application/json',
            produces: 'application/json',
            short_description: 'Exposes DemoOrchestratorAPI verbs (branding + revert) to the Demo Env ServiceNow MCP server.'
        },
        'sys_ws_definition',
        {
            preDelete: deleteWsOperationsForDefinition,
            // namespace is read-only on update; if we find one with a stale
            // numeric namespace (from a prior run made under a custom-app
            // scope), the only way to refresh it is to recreate the record.
            extraFields: 'namespace',
            recreateIf: (rec) => rec.namespace && rec.namespace !== 'global'
        }
    );
    if (!wsSysId) {
        console.log('Aborting: Scripted REST definition deploy failed.');
        return;
    }

    // 3) Operations
    console.log('\n3) REST operations');
    const ops = [
        {
            label: 'POST /branding',
            queryField: 'name',
            queryValue: 'applyBranding',
            payload: {
                web_service_definition: wsSysId,
                name: 'applyBranding',
                http_method: 'POST',
                relative_path: '/branding',
                operation_script: brandingOpScript,
                requires_authentication: 'true',
                requires_acl_authorization: 'false',
                active: 'true',
                short_description: 'Inject branded CSS into all sp_theme records and optionally store a base64 logo as sys_attachment.'
            }
        },
        {
            label: 'POST /revert',
            queryField: 'name',
            queryValue: 'revertByPrefix',
            payload: {
                web_service_definition: wsSysId,
                name: 'revertByPrefix',
                http_method: 'POST',
                relative_path: '/revert',
                operation_script: revertOpScript,
                requires_authentication: 'true',
                requires_acl_authorization: 'false',
                active: 'true',
                short_description: 'Bulk delete prefixed demo records (catalog items, categories, users, incidents, HR cases, purchase orders, reports, sp_instance bindings) and strip the master CSS override.'
            }
        }
    ];

    for (const op of ops) {
        // Scope the upsert to this ws_definition so we never touch operations
        // belonging to other Scripted REST APIs.
        const q = `web_service_definition=${wsSysId}^${op.queryField}=${encodeURIComponent(op.queryValue)}`;
        const found = await makeRequest(
            'GET',
            `/api/now/table/sys_ws_operation?sysparm_query=${q}&sysparm_limit=10&sysparm_fields=sys_id,sys_scope`
        );
        const matches = (found.data && found.data.result) || [];
        const payload = { ...op.payload, sys_scope: GLOBAL_SCOPE_SYS_ID };

        let globalMatch = null;
        const misscoped = [];
        for (const rec of matches) {
            const scope = readScope(rec);
            if (scope === GLOBAL_SCOPE_SYS_ID) globalMatch = rec;
            else misscoped.push({ sys_id: rec.sys_id, scope });
        }

        for (const m of misscoped) {
            const del = await makeRequest('DELETE', `/api/now/table/sys_ws_operation/${m.sys_id}`);
            const ok = del.status === 200 || del.status === 204;
            console.log(`   ${ok ? '🧹 Deleted' : '❌ Failed to delete'} misscoped ${op.label} (${m.sys_id}, scope=${m.scope || 'unknown'})`);
        }

        if (globalMatch) {
            const updated = await makeRequest('PUT', `/api/now/table/sys_ws_operation/${globalMatch.sys_id}`, payload);
            console.log(`   ${updated.status === 200 ? '✅ Updated' : '❌ Failed to update'} ${op.label} in global scope (${globalMatch.sys_id})`);
        } else {
            const created = await makeRequest('POST', '/api/now/table/sys_ws_operation', payload);
            const sysId = created.data && created.data.result && created.data.result.sys_id;
            console.log(`   ${(created.status === 200 || created.status === 201) ? '✅ Created' : '❌ Failed to create'} ${op.label} in global scope (${sysId || 'no sys_id'})`);
        }
    }

    // 4) Read back the resolved namespace from the live record so the
    //    printed URLs are guaranteed to match what the instance is actually
    //    serving. (If something went wrong with scope-pinning this surfaces
    //    immediately rather than silently misleading the operator.)
    const verify = await makeRequest(
        'GET',
        `/api/now/table/sys_ws_definition/${wsSysId}?sysparm_fields=service_id,namespace,sys_scope`
    );
    const liveNamespace = (verify.data && verify.data.result && verify.data.result.namespace) || 'global';
    const liveServiceId = (verify.data && verify.data.result && verify.data.result.service_id) || REST_API_SERVICE_ID;

    console.log(`\n✨ Deployment complete.\n`);
    console.log(`   Branding:  POST https://${instanceUrl}/api/${liveNamespace}/${liveServiceId}/branding`);
    console.log(`   Revert:    POST https://${instanceUrl}/api/${liveNamespace}/${liveServiceId}/revert`);
    if (liveNamespace !== 'global') {
        console.log(`\n   ⚠️  Namespace landed as '${liveNamespace}' instead of 'global'.`);
        console.log('       The MCP expects /api/global/demo_orchestrator/... — re-run this script,');
        console.log('       confirm the running admin has app-edit rights, or move the records');
        console.log("       manually to global scope. (Most likely cause: previous run created");
        console.log('       records the API can no longer reassign across scopes via REST.)');
    }
    console.log('');
}

deploy().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
