/**
 * Unit tests for the new C2 demo-orchestrator verbs introduced by the
 * dashboards/reports/extra-data migration:
 *
 *   - probeTable      (plugin-availability probe)
 *   - applyReports    (sys_report idempotent on title)
 *   - applyData       (now: incidents + hr_cases + purchase_orders)
 *   - applyDashboard  (sp_instance binding to portal first column)
 *
 * Mocks the ServiceNow REST client; no network calls.
 */

import { jest } from '@jest/globals';
import { createMockServiceNowClient } from './helpers/mocks.js';
import {
  probeTable,
  applyReports,
  applyData,
  applyDashboard
} from '../src/demo-orchestrator.js';

describe('probeTable', () => {
  let client;

  beforeEach(() => {
    client = createMockServiceNowClient();
  });

  it('returns true when the table responds successfully', async () => {
    client.getRecords.mockResolvedValueOnce([{ sys_id: 'x' }]);
    const ok = await probeTable(client, 'incident');
    expect(ok).toBe(true);
    expect(client.getRecords).toHaveBeenCalledWith('incident', expect.objectContaining({
      sysparm_limit: 1,
      sysparm_fields: 'sys_id'
    }));
  });

  it('returns true even when the table is empty (no rows ≠ no table)', async () => {
    client.getRecords.mockResolvedValueOnce([]);
    expect(await probeTable(client, 'sys_report')).toBe(true);
  });

  it('returns false when the table errors out (e.g. plugin not active)', async () => {
    client.getRecords.mockRejectedValueOnce(new Error('Resource not found'));
    expect(await probeTable(client, 'sn_hr_core_case')).toBe(false);
  });

  it('returns false on an empty/missing tableName', async () => {
    expect(await probeTable(client, '')).toBe(false);
    expect(await probeTable(client, null)).toBe(false);
    expect(client.getRecords).not.toHaveBeenCalled();
  });
});

describe('applyReports', () => {
  let client;

  beforeEach(() => {
    client = createMockServiceNowClient();
  });

  it('creates a new sys_report when no record with that title exists', async () => {
    client.getRecords.mockResolvedValueOnce([]);
    client.createRecord.mockResolvedValueOnce({ sys_id: 'rpt1' });

    const out = await applyReports(client, [{
      title: 'CompanyA - Open Incidents',
      table: 'incident',
      type: 'donut',
      field: 'category'
    }]);

    expect(out.created).toHaveLength(1);
    expect(out.created[0]).toMatchObject({ title: 'CompanyA - Open Incidents', sys_id: 'rpt1', table: 'incident', type: 'donut' });
    expect(out.skipped).toHaveLength(0);
    expect(out.errors).toHaveLength(0);
    expect(client.createRecord).toHaveBeenCalledWith('sys_report', expect.objectContaining({
      title: 'CompanyA - Open Incidents',
      table: 'incident',
      type: 'donut',
      field: 'category'
    }));
  });

  it('skips when the title already exists (idempotent)', async () => {
    client.getRecords.mockResolvedValueOnce([{ sys_id: 'existing-rpt', title: 'CompanyA - Open Incidents' }]);

    const out = await applyReports(client, [{
      title: 'CompanyA - Open Incidents',
      table: 'incident',
      type: 'donut'
    }]);

    expect(out.created).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({ title: 'CompanyA - Open Incidents', sys_id: 'existing-rpt' });
    expect(client.createRecord).not.toHaveBeenCalled();
  });

  it('reports a soft error on missing required fields and continues', async () => {
    client.getRecords.mockResolvedValueOnce([]);
    client.createRecord.mockResolvedValueOnce({ sys_id: 'rpt2' });

    const out = await applyReports(client, [
      { title: 'incomplete' }, // missing table + type
      { title: 'CompanyA - Bar', table: 'incident', type: 'bar' }
    ]);

    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/missing required fields/);
    expect(out.created).toHaveLength(1);
    expect(out.created[0].title).toBe('CompanyA - Bar');
  });

  it('returns an empty result for an empty / missing reports array', async () => {
    expect(await applyReports(client, [])).toEqual({ created: [], skipped: [], errors: [] });
    expect(await applyReports(client, null)).toEqual({ created: [], skipped: [], errors: [] });
    expect(client.getRecords).not.toHaveBeenCalled();
  });
});

describe('applyData (incidents + hr_cases + purchase_orders)', () => {
  let client;

  beforeEach(() => {
    client = createMockServiceNowClient();
  });

  it('creates incidents and skips HR / PO batches when their tables are missing', async () => {
    // 1. Incident idempotency lookup → no existing
    // 2. Incident create
    // 3. probeTable for sn_hr_core_case → reject
    // 4. probeTable for proc_po → reject
    client.getRecords
      .mockResolvedValueOnce([])             // incident lookup
      .mockRejectedValueOnce(new Error('404')) // probe sn_hr_core_case
      .mockRejectedValueOnce(new Error('404')); // probe proc_po
    client.createRecord.mockResolvedValueOnce({ sys_id: 'inc1', number: 'INC0001' });

    const out = await applyData(client, {
      incidents: [{ short_description: 'Email down', correlation_id: 'CompanyA_inc_1' }],
      hr_cases: [{ short_description: 'PTO request', correlation_id: 'CompanyA_hrc_1' }],
      purchase_orders: [{ short_description: 'New laptop', correlation_id: 'CompanyA_po_1' }]
    });

    expect(out.incidents.created).toHaveLength(1);
    expect(out.incidents.created[0]).toMatchObject({ sys_id: 'inc1', number: 'INC0001', correlation_id: 'CompanyA_inc_1' });
    expect(out.hr_cases.available).toBe(false);
    expect(out.hr_cases.created).toHaveLength(0);
    expect(out.hr_cases.skipped[0].reason).toMatch(/HRSD plugin not active/);
    expect(out.purchase_orders.available).toBe(false);
    expect(out.purchase_orders.created).toHaveLength(0);
    expect(out.purchase_orders.skipped[0].reason).toMatch(/Procurement plugin not active/);

    // Only the incident write happened — neither hr_case nor po was attempted.
    expect(client.createRecord).toHaveBeenCalledTimes(1);
  });

  it('writes HR cases and POs when their tables are available', async () => {
    client.getRecords
      .mockResolvedValueOnce([])                            // incident lookup
      .mockResolvedValueOnce([{ sys_id: 'hrc-table' }])     // probe sn_hr_core_case → ok
      .mockResolvedValueOnce([])                            // hr_case correlation lookup
      .mockResolvedValueOnce([{ sys_id: 'po-table' }])      // probe proc_po → ok
      .mockResolvedValueOnce([]);                           // po correlation lookup
    client.createRecord
      .mockResolvedValueOnce({ sys_id: 'inc1', number: 'INC0001' })
      .mockResolvedValueOnce({ sys_id: 'hrc1', number: 'HRC0001' })
      .mockResolvedValueOnce({ sys_id: 'po1', number: 'PO0001' });

    const out = await applyData(client, {
      incidents: [{ short_description: 'Email down', correlation_id: 'X_inc_1' }],
      hr_cases: [{ short_description: 'PTO request', correlation_id: 'X_hrc_1' }],
      purchase_orders: [{ short_description: 'New laptop', total_cost: 1200, correlation_id: 'X_po_1' }]
    });

    expect(out.incidents.created).toHaveLength(1);
    expect(out.hr_cases.available).toBe(true);
    expect(out.hr_cases.created).toHaveLength(1);
    expect(out.purchase_orders.available).toBe(true);
    expect(out.purchase_orders.created).toHaveLength(1);

    // PO total_cost gets stringified per the existing module convention.
    const poCall = client.createRecord.mock.calls.find(([table]) => table === 'proc_po');
    expect(poCall[1]).toMatchObject({ total_cost: '1200', correlation_id: 'X_po_1' });
  });

  it('accepts the legacy array shape (back-compat) and exposes flat aliases', async () => {
    client.getRecords.mockResolvedValueOnce([]);
    client.createRecord.mockResolvedValueOnce({ sys_id: 'inc1', number: 'INC0001' });

    const out = await applyData(client, [
      { short_description: 'Legacy incident', correlation_id: 'L_inc_1' }
    ]);

    expect(out.incidents.created).toHaveLength(1);
    expect(out.created).toBe(out.incidents.created); // flat alias
    expect(out.skipped).toBe(out.incidents.skipped);
    expect(out.hr_cases.created).toHaveLength(0);
    expect(out.purchase_orders.created).toHaveLength(0);
  });
});

describe('applyDashboard', () => {
  let client;

  beforeEach(() => {
    client = createMockServiceNowClient();
  });

  it('binds two existing widgets to the index page first column (happy path)', async () => {
    client.getRecords
      .mockResolvedValueOnce([{ sys_id: 'pageX', id: 'index' }])              // sp_page lookup
      .mockResolvedValueOnce([{ sys_id: 'colX', order: '100' }])              // sp_column lookup
      .mockResolvedValueOnce([{ sys_id: 'wA', id: 'demo_kpi_dashboard' }])    // widget A lookup
      .mockResolvedValueOnce([])                                               // sp_instance idempotency for A
      .mockResolvedValueOnce([{ sys_id: 'wB', id: 'demo_announcements' }])    // widget B lookup
      .mockResolvedValueOnce([]);                                              // sp_instance idempotency for B
    client.createRecord
      .mockResolvedValueOnce({ sys_id: 'inst-A' })
      .mockResolvedValueOnce({ sys_id: 'inst-B' });

    const out = await applyDashboard(client, {
      pageId: 'index',
      clientPrefix: 'CompanyA',
      widgets: [
        { id: 'demo_kpi_dashboard', order: 100, title: 'KPIs' },
        { id: 'demo_announcements', order: 200 }
      ]
    });

    expect(out.errors).toHaveLength(0);
    expect(out.widgets.created).toHaveLength(2);
    expect(out.widgets.skipped).toHaveLength(0);
    expect(out.widgets.missing).toHaveLength(0);
    expect(out.column.sys_id).toBe('colX');
    expect(out.page.sys_id).toBe('pageX');

    // class_name stamp must be applied for clean revert by SN-Demo-Revert.
    // (sp_instance has no css_class field — class_name is the actual
    // Bootstrap-class hook on the table.)
    const firstInstance = client.createRecord.mock.calls.find(([table]) => table === 'sp_instance');
    expect(firstInstance[1]).toMatchObject({
      sp_column: 'colX',
      sp_widget: 'wA',
      order: '100',
      title: 'KPIs',
      class_name: 'demo-CompanyA'
    });
    expect(firstInstance[1]).not.toHaveProperty('css_class');
  });

  it('reports missing widget ids without erroring out the rest of the run', async () => {
    client.getRecords
      .mockResolvedValueOnce([{ sys_id: 'pageX', id: 'index' }])           // page
      .mockResolvedValueOnce([{ sys_id: 'colX' }])                          // column
      .mockResolvedValueOnce([])                                             // widget "missing_widget" lookup → not found
      .mockResolvedValueOnce([{ sys_id: 'wB', id: 'real_widget' }])         // widget "real_widget" → found
      .mockResolvedValueOnce([]);                                            // sp_instance idempotency
    client.createRecord.mockResolvedValueOnce({ sys_id: 'inst-B' });

    const out = await applyDashboard(client, {
      widgets: [{ id: 'missing_widget' }, { id: 'real_widget' }]
    });

    expect(out.widgets.missing).toHaveLength(1);
    expect(out.widgets.missing[0].id).toBe('missing_widget');
    expect(out.widgets.created).toHaveLength(1);
    expect(out.widgets.created[0].id).toBe('real_widget');
  });

  it('is idempotent on (sp_column, sp_widget) — second run creates zero rows', async () => {
    client.getRecords
      .mockResolvedValueOnce([{ sys_id: 'pageX' }])                         // page
      .mockResolvedValueOnce([{ sys_id: 'colX' }])                          // column
      .mockResolvedValueOnce([{ sys_id: 'wA', id: 'demo_kpi_dashboard' }])  // widget
      .mockResolvedValueOnce([{ sys_id: 'existing-instance', title: 'old' }]); // sp_instance already exists

    const out = await applyDashboard(client, {
      widgets: [{ id: 'demo_kpi_dashboard' }]
    });

    expect(out.widgets.created).toHaveLength(0);
    expect(out.widgets.skipped).toHaveLength(1);
    expect(out.widgets.skipped[0].sys_id).toBe('existing-instance');
    expect(client.createRecord).not.toHaveBeenCalled();
  });

  it('returns a structural error when the page has no row/container/column (does not write)', async () => {
    client.getRecords
      .mockResolvedValueOnce([{ sys_id: 'pageX' }])  // page exists
      .mockResolvedValueOnce([]);                     // but no columns

    const out = await applyDashboard(client, {
      widgets: [{ id: 'demo_kpi_dashboard' }]
    });

    expect(out.errors[0]).toMatch(/no row\/container\/column structure/);
    expect(out.widgets.created).toHaveLength(0);
    expect(client.createRecord).not.toHaveBeenCalled();
  });

  it('returns a clean error when the pageId does not exist (does not write)', async () => {
    client.getRecords.mockResolvedValueOnce([]); // page lookup empty

    const out = await applyDashboard(client, {
      pageId: 'nonexistent_page',
      widgets: [{ id: 'demo_kpi_dashboard' }]
    });

    expect(out.errors[0]).toMatch(/sp_page.id="nonexistent_page" not found/);
    expect(client.createRecord).not.toHaveBeenCalled();
  });

  it('rejects a missing/empty widgets array with a helpful error', async () => {
    const out = await applyDashboard(client, { widgets: [] });
    expect(out.errors[0]).toMatch(/widgets\[\] is required/);
    expect(client.getRecords).not.toHaveBeenCalled();
  });
});
