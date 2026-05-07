/**
 * DemoOrchestratorAPI — slim, server-side companion for the Demo Env ServiceNow MCP server.
 *
 * Architecture (Option C2 hybrid):
 *   - The MCP (Node) owns orchestration: users, incidents, categories, catalog
 *     items, widget overrides, idempotency, validation, update-set wiring.
 *   - This Script Include keeps ONLY the operations that genuinely require
 *     server-side Glide APIs and would be slow / fragile / impossible over REST:
 *
 *       1. applyBranding(demoConfig)   — base64 logo -> sys_attachment via
 *                                        GlideSysAttachment, then regex-injects
 *                                        a master CSS override block into every
 *                                        sp_theme bound to an active sp_portal.
 *
 *       2. revertByPrefix(clientPrefix)— deleteMultiple() bulk teardown of all
 *                                        prefixed sc_cat_item, sc_category,
 *                                        sys_user, incident records, plus
 *                                        strip the master CSS block from all
 *                                        themes. One transaction, fast.
 *
 * Both methods are exposed to the MCP via the "Demo Orchestrator" Scripted
 * REST API (api/global/demo_orchestrator/branding and /revert) deployed
 * alongside this Script Include by deploy_script_include.js.
 */
var DemoOrchestratorAPI = Class.create();
DemoOrchestratorAPI.prototype = {
    initialize: function() {},

    /**
     * Apply visual branding to all Service Portals.
     *
     * @param {Object} demoConfig
     *   {
     *     clientName:        String  (used for logo file name)
     *     primaryColor:      String  hex, default '#00A3A1'
     *     secondaryColor:    String  hex, default '#003366'
     *     navbarBgColor:     String? hex, defaults to secondaryColor
     *     navbarTextColor:   String? hex, default '#ffffff'
     *     logoUrl:           String? a pre-existing URL (skips upload)
     *     logoBase64:        String? raw base64 payload (no data: prefix)
     *     logoMimeType:      String? e.g. 'image/png' (default)
     *   }
     * @returns {Object} { ok, themesUpdated, logoSysId?, logoUrl?, errors[] }
     */
    applyBranding: function(demoConfig) {
        var result = { ok: true, themesUpdated: 0, errors: [] };
        if (!demoConfig) {
            result.ok = false;
            result.errors.push('demoConfig is required');
            return result;
        }

        var primaryColor = demoConfig.primaryColor || '#00A3A1';
        var secondaryColor = demoConfig.secondaryColor || '#003366';
        var navBg = demoConfig.navbarBgColor || secondaryColor || primaryColor;
        var navText = demoConfig.navbarTextColor || '#ffffff';
        var finalLogoUrl = demoConfig.logoUrl || '';

        // Tolerate the older widget contract where the whole data: URI is sent
        // through logoUrl. Split it back into mime + base64 and route into the
        // upload branch below.
        if (finalLogoUrl.indexOf('data:image') === 0 && finalLogoUrl.indexOf('base64,') > -1) {
            var parts = finalLogoUrl.split('base64,');
            demoConfig.logoMimeType = parts[0].replace('data:', '').replace(/;\s*$/, '');
            demoConfig.logoBase64 = parts[1];
            finalLogoUrl = '';
        }

        if (!finalLogoUrl && demoConfig.logoBase64) {
            try {
                var mimeType = demoConfig.logoMimeType || 'image/png';
                var extension = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
                var safeClient = (demoConfig.clientName || 'demo').replace(/\s+/g, '_').toLowerCase();
                var fileName = 'demo_logo_' + safeClient + '.' + extension;
                var dummyPortal = new GlideRecord('sp_portal');
                dummyPortal.query();
                if (dummyPortal.next()) {
                    var sa = new GlideSysAttachment();
                    var attachSysId = sa.writeBase64(dummyPortal, fileName, mimeType, demoConfig.logoBase64);
                    if (attachSysId) {
                        finalLogoUrl = '/sys_attachment.do?sys_id=' + attachSysId;
                        result.logoSysId = attachSysId;
                        gs.info('[BRANDING] Stored Base64 upload as sys_attachment: ' + attachSysId);
                    } else {
                        result.errors.push('GlideSysAttachment.writeBase64 returned no sys_id');
                    }
                } else {
                    result.errors.push('No sp_portal record found to host the logo attachment');
                }
            } catch (ex) {
                result.errors.push('Base64 logo upload failed: ' + ex);
            }
        }
        if (finalLogoUrl) result.logoUrl = finalLogoUrl;

        var css = this._buildBrandingCss(finalLogoUrl, primaryColor, secondaryColor, navBg, navText);

        var portalGR = new GlideRecord('sp_portal');
        portalGR.query();
        while (portalGR.next()) {
            var themeSysId = portalGR.getValue('theme');
            if (!themeSysId) continue;
            var themeGR = new GlideRecord('sp_theme');
            if (themeGR.get(themeSysId)) {
                try {
                    var current = themeGR.getValue('css_variables') || '';
                    current = current.replace(
                        /\/\* -- DEMO MASTER OVERRIDE -- \*\/[\s\S]*?\/\* -- END DEMO MASTER OVERRIDE -- \*\//g,
                        ''
                    );
                    themeGR.setValue('css_variables', current + css);
                    themeGR.update();
                    result.themesUpdated++;
                } catch (e) {
                    result.errors.push('Theme update failed for ' + themeGR.getValue('name') + ': ' + e);
                }
            }
        }

        if (result.errors.length > 0) result.ok = false;
        gs.info('[BRANDING] Branding applied. Themes updated: ' + result.themesUpdated);
        return result;
    },

    _buildBrandingCss: function(finalLogoUrl, primaryColor, secondaryColor, navBg, navText) {
        var logoBlock = '';
        if (finalLogoUrl) {
            logoBlock =
                '.navbar-brand img, .sp-navbar-logo img, .navbar-logo img { display: none !important; }\n' +
                '.navbar-brand, .sp-navbar-logo, .navbar-logo {\n' +
                "    background-image: url('" + finalLogoUrl + "') !important;\n" +
                '    background-size: contain !important;\n' +
                '    background-repeat: no-repeat !important;\n' +
                '    background-position: center left !important;\n' +
                '    height: 50px !important;\n' +
                '    width: 200px !important;\n' +
                '    min-width: 200px !important;\n' +
                '    display: block !important;\n' +
                '}\n';
        }

        return (
            '\n/* -- DEMO MASTER OVERRIDE -- */\n' +
            logoBlock +
            'a, .text-primary, .color-primary, .text-info, .panel-title a, .accordion-toggle, .sp-icon-link .fa, .announcement-title, .btn-link, button.btn-link {\n' +
            '    color: ' + primaryColor + ' !important;\n' +
            '}\n' +
            '.bg-primary, .btn-primary, .icon-link-background-primary, .sn-va-widget-icon, .sn-connect-icon, .sp-chat-button, .sn-vabr_chat-btn {\n' +
            '    background-color: ' + primaryColor + ' !important;\n' +
            '    border-color: ' + primaryColor + ' !important;\n' +
            '}\n' +
            '.icon-link-background-primary { color: #fff !important; }\n' +
            '.navbar, .navbar-inverse, .sp-navbar { background-color: ' + navBg + ' !important; }\n' +
            '.navbar-inverse .navbar-nav > li > a, .navbar-inverse .navbar-brand { color: ' + navText + ' !important; transition: all 0.2s ease !important; }\n' +
            '.navbar-inverse .navbar-nav > li > a:hover, .navbar-inverse .navbar-nav > li > a:focus, .navbar-inverse .navbar-brand:hover, .sp-navbar .navbar-nav > li > a:hover, .header-menu-item > a:hover { color: ' + primaryColor + ' !important; background-color: rgba(0,0,0,0.03) !important; }\n' +
            '$brand-primary: ' + primaryColor + ';\n' +
            '$brand-info: ' + primaryColor + ';\n' +
            '$navbar-inverse-bg: ' + navBg + ';\n' +
            '$navbar-inverse-link-color: ' + navText + ';\n' +
            '$navbar-inverse-link-hover-color: ' + primaryColor + ';\n' +
            '$link-color: ' + primaryColor + ';\n' +
            '$sp-logo-margin-x: 15px;\n' +
            ':root {\n' +
            '    --now-color_brand--primary: ' + primaryColor + ';\n' +
            '    --now-color_brand--secondary: ' + secondaryColor + ';\n' +
            '    --now-color_chrome--brand: ' + primaryColor + ';\n' +
            '    --now-color_chrome--divider: ' + primaryColor + ';\n' +
            '}\n' +
            '/* -- END DEMO MASTER OVERRIDE -- */\n'
        );
    },

    /**
     * Bulk teardown of all prefixed demo records and strip CSS overrides.
     * Uses deleteMultiple() so the round-trip cost is one transaction per
     * table instead of N REST DELETEs.
     *
     * @param {String} clientPrefix e.g. 'CompanyA'
     * @returns {Object} {
     *   ok,
     *   deleted: { catalogItems, categories, users, incidents,
     *              hrCases, purchaseOrders, reports, spInstances },
     *   themesCleaned, heroContainersReset, errors[]
     * }
     */
    revertByPrefix: function(clientPrefix) {
        var result = {
            ok: true,
            deleted: {
                catalogItems: 0,
                categories: 0,
                users: 0,
                incidents: 0,
                hrCases: 0,
                purchaseOrders: 0,
                reports: 0,
                spInstances: 0
            },
            themesCleaned: 0,
            heroContainersReset: 0,
            errors: []
        };
        if (!clientPrefix) {
            result.ok = false;
            result.errors.push('clientPrefix is required');
            return result;
        }

        gs.info('[TEARDOWN] Reverting demo data for: ' + clientPrefix);

        try {
            var itemGR = new GlideRecord('sc_cat_item');
            itemGR.addQuery('name', 'STARTSWITH', clientPrefix + ' -');
            itemGR.query();
            result.deleted.catalogItems = itemGR.getRowCount();
            itemGR.deleteMultiple();
        } catch (e) { result.errors.push('Catalog items: ' + e); }

        try {
            var catGR = new GlideRecord('sc_category');
            catGR.addQuery('title', 'STARTSWITH', clientPrefix + ' -');
            catGR.query();
            result.deleted.categories = catGR.getRowCount();
            catGR.deleteMultiple();
        } catch (e) { result.errors.push('Categories: ' + e); }

        try {
            var userPrefix = clientPrefix.split('-')[0].toLowerCase() + '_';
            var userGR = new GlideRecord('sys_user');
            userGR.addQuery('user_name', 'STARTSWITH', userPrefix);
            userGR.query();
            result.deleted.users = userGR.getRowCount();
            userGR.deleteMultiple();
        } catch (e) { result.errors.push('Users: ' + e); }

        try {
            var incGR = new GlideRecord('incident');
            incGR.addQuery('correlation_id', 'STARTSWITH', clientPrefix + '_');
            incGR.query();
            result.deleted.incidents = incGR.getRowCount();
            incGR.deleteMultiple();
        } catch (e) { result.errors.push('Incidents: ' + e); }

        // HR cases — table only exists when HRSD plugin is active. Wrap so a
        // missing table reports a soft error instead of aborting the whole revert.
        try {
            var hrcGR = new GlideRecord('sn_hr_core_case');
            if (hrcGR.isValid()) {
                hrcGR.addQuery('correlation_id', 'STARTSWITH', clientPrefix + '_hrc_');
                hrcGR.query();
                result.deleted.hrCases = hrcGR.getRowCount();
                hrcGR.deleteMultiple();
            }
        } catch (e) { result.errors.push('HR cases: ' + e); }

        // Purchase orders — Procurement plugin gated, same pattern as HR cases.
        try {
            var poGR = new GlideRecord('proc_po');
            if (poGR.isValid()) {
                poGR.addQuery('correlation_id', 'STARTSWITH', clientPrefix + '_po_');
                poGR.query();
                result.deleted.purchaseOrders = poGR.getRowCount();
                poGR.deleteMultiple();
            }
        } catch (e) { result.errors.push('Purchase orders: ' + e); }

        try {
            var rptGR = new GlideRecord('sys_report');
            rptGR.addQuery('title', 'STARTSWITH', clientPrefix + ' -');
            rptGR.query();
            result.deleted.reports = rptGR.getRowCount();
            rptGR.deleteMultiple();
        } catch (e) { result.errors.push('Reports: ' + e); }

        // Service Portal widget instances created by SN-Demo-Apply-Dashboard
        // are stamped with class_name='demo-<clientPrefix>' (the real
        // Bootstrap-class hook on sp_instance — sp_instance has NO css_class
        // field; addQuery on a missing field silently no-ops and would delete
        // the entire table). We sweep by exact prefix on class_name.
        try {
            var spiGR = new GlideRecord('sp_instance');
            spiGR.addQuery('class_name', 'STARTSWITH', 'demo-' + clientPrefix);
            spiGR.query();
            result.deleted.spInstances = spiGR.getRowCount();
            spiGR.deleteMultiple();
        } catch (e) { result.errors.push('Widget instances: ' + e); }

        try {
            var portalGR = new GlideRecord('sp_portal');
            portalGR.query();
            while (portalGR.next()) {
                var themeSysId = portalGR.getValue('theme');
                if (!themeSysId) continue;
                var themeGR = new GlideRecord('sp_theme');
                if (themeGR.get(themeSysId)) {
                    var currentCss = themeGR.getValue('css_variables') || '';
                    var cleanedCss = currentCss.replace(
                        /\/\* -- DEMO MASTER OVERRIDE -- \*\/[\s\S]*?\/\* -- END DEMO MASTER OVERRIDE -- \*\//g,
                        ''
                    );
                    if (cleanedCss !== currentCss) {
                        themeGR.setValue('css_variables', cleanedCss);
                        themeGR.update();
                        result.themesCleaned++;
                    }
                }
            }
        } catch (e) { result.errors.push('Theme cleanup: ' + e); }

        // Hero container background — restore to empty for the index page's first
        // container. We deliberately do NOT hard-code an instance-specific stock
        // sys_id; '' is the safe, portable default.
        try {
            var pageGR = new GlideRecord('sp_page');
            pageGR.addQuery('id', 'index');
            pageGR.query();
            while (pageGR.next()) {
                var contGR = new GlideRecord('sp_container');
                contGR.addQuery('sp_row.sp_page', pageGR.getUniqueValue());
                contGR.orderBy('order');
                contGR.setLimit(1);
                contGR.query();
                if (contGR.next()) {
                    var bgImg = contGR.getValue('background_image') || '';
                    var bgColor = contGR.getValue('background_color') || '';
                    if (bgImg || bgColor) {
                        contGR.setValue('background_image', '');
                        contGR.setValue('background_color', '');
                        contGR.update();
                        result.heroContainersReset++;
                    }
                }
            }
        } catch (e) { result.errors.push('Hero container reset: ' + e); }

        if (result.errors.length > 0) result.ok = false;
        gs.info('[TEARDOWN] Complete for ' + clientPrefix + '. Deleted: ' + JSON.stringify(result.deleted));
        return result;
    },

    type: 'DemoOrchestratorAPI'
};
