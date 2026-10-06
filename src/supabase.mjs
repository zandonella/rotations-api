import { UUID, validateItem } from './validate.mjs';

const PUBLIC_TABLES = new Set([
  'CatalogItem', 'Champion', 'ItemType', 'Skinline', 'Universe',
  'CatalogSale', 'MythicSale', 'SanctumSale', 'YourShopSale', 'public_api_state',
]);

function failure(message) {
  return Object.assign(new Error(message), { code: 'public_data_error' });
}

export async function readFingerprint(config) {
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    throw failure('Public Supabase configuration is missing.');
  }
  let response;
  try {
    response = await fetch(new URL('/rest/v1/rpc/get_public_api_fingerprint', config.supabaseUrl), {
      method: 'GET',
      headers: {
        apikey: config.supabasePublishableKey,
        Authorization: `Bearer ${config.supabasePublishableKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch {
    throw failure('Public data fingerprint read failed.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw failure(`Public data fingerprint read failed with HTTP ${response.status}.`);
  }
  let fingerprint;
  try { fingerprint = await response.json(); } catch { throw failure('Invalid public data fingerprint.'); }
  if (!validFingerprints(fingerprint)) {
    throw failure('Invalid public data fingerprint.');
  }
  return fingerprint;
}

export function validFingerprints(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 5 && ['catalog', 'sales', 'mythic', 'sanctum', 'yourShop'].every(key =>
      typeof value[key] === 'string' && /^[a-f0-9]{32}$/.test(value[key]));
}

export async function readPublicState(config) {
  const rows = await readTable(config, 'public_api_state',
    'id,fingerprints,checked_at,changed_at,changed_sections,catalog_revision', 'id.asc', { id: 'eq.1' });
  const state = rows[0];
  if (rows.length !== 1 || state.id !== 1 || !validFingerprints(state.fingerprints) ||
      typeof state.checked_at !== 'string' || !Number.isFinite(Date.parse(state.checked_at)) ||
      !Number.isSafeInteger(state.catalog_revision) || state.catalog_revision < 1) {
    throw failure('Confirmed public API state is missing or invalid.');
  }
  return state;
}

export async function readCatalogChanges(config, afterRevision, expectedRevision) {
  if (!Number.isSafeInteger(afterRevision) || afterRevision < 1 ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < afterRevision) {
    throw failure('Invalid catalog revision range.');
  }
  if (!config.supabaseUrl || !config.supabasePublishableKey) throw failure('Public Supabase configuration is missing.');
  const url = new URL('/rest/v1/rpc/get_public_api_catalog_changes', config.supabaseUrl);
  url.search = new URLSearchParams({ after_revision: afterRevision, expected_revision: expectedRevision,
    select: 'item_id,item_data,changed_revision', order: 'item_id.asc' }).toString();
  const changes = await readRows(config, url, 'catalog changes');
  let previousId = '';
  for (const change of changes) {
    if (change === null || typeof change !== 'object' || Object.keys(change).length !== 3 ||
        typeof change.item_id !== 'string' || !UUID.test(change.item_id) || change.item_id !== change.item_id.toLowerCase() || change.item_id <= previousId ||
        !Number.isSafeInteger(change.changed_revision) || change.changed_revision <= afterRevision ||
        change.changed_revision > expectedRevision) throw failure('Invalid catalog change.');
    if (change.item_data !== null) {
      validateItem(change.item_data);
      if (change.item_data.itemId !== change.item_id) throw failure('Invalid catalog change identity.');
    }
    previousId = change.item_id;
  }
  return changes;
}

// Callers supply explicit columns and a unique deterministic ordering. Count and
// Content-Range checks prevent an upstream row cap from silently truncating data.
export async function readTable(config, table, columns, order, filters = {}) {
  if (!PUBLIC_TABLES.has(table)) throw failure('Table is not a public API data source.');
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    throw failure('Public Supabase configuration is missing.');
  }
  const url = new URL(`/rest/v1/${table}`, config.supabaseUrl);
  url.search = new URLSearchParams({ select: columns, order, ...filters }).toString();
  return readRows(config, url, table);
}

async function readRows(config, url, table) {
  const rows = [];
  let total;

  do {
    let response;
    try {
      response = await fetch(url, {
        headers: {
          apikey: config.supabasePublishableKey,
          Authorization: `Bearer ${config.supabasePublishableKey}`,
          Range: `${rows.length}-${rows.length + 499}`,
          'Range-Unit': 'items',
          Prefer: 'count=exact',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw failure(`Public data read failed for ${table}.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw failure(`Public data read failed for ${table} with HTTP ${response.status}.`);
    }

    const range = /^(?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    let page;
    try { page = await response.json(); } catch { throw failure(`Invalid JSON for ${table}.`); }
    if (!range || !Array.isArray(page)) throw failure(`Invalid page for ${table}.`);
    const pageTotal = Number(range[3]);
    if (!Number.isSafeInteger(pageTotal) || (total !== undefined && total !== pageTotal)) {
      throw failure(`Row count changed while reading ${table}.`);
    }
    total = pageTotal;
    if (total === 0 && rows.length === 0 && page.length === 0) return [];
    if (
      page.length === 0 || page.length > 500 ||
      Number(range[1]) !== rows.length ||
      Number(range[2]) !== rows.length + page.length - 1 ||
      rows.length + page.length > total
    ) {
      throw failure(`Invalid page range for ${table}.`);
    }
    rows.push(...page);
  } while (rows.length < total);

  return rows;
}
