const PUBLIC_TABLES = new Set([
  'CatalogItem', 'Champion', 'ItemType', 'Skinline', 'Universe',
  'CatalogSale', 'MythicSale', 'SanctumSale', 'YourShopSale',
]);

function failure(message) {
  return Object.assign(new Error(message), { code: 'public_data_error' });
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
