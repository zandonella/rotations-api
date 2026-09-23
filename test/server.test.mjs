import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiServer, makeEtag, start } from '../src/server.mjs';
import { createSnapshotStore } from '../src/refresh.mjs';
import { persistSnapshot } from '../src/persistence.mjs';
import { createSnapshot } from '../src/snapshot.mjs';
import { deferred, fixtureSnapshot, mockSupabase, request, rows, testConfig, uuid } from './fixtures.mjs';

async function setup(t, { snapshot = fixtureSnapshot(), config: overrides = {}, store: overrideStore } = {}) {
  const config = { ...await testConfig(t), ...overrides };
  if (snapshot) await persistSnapshot(config.dataDir, snapshot);
  const store = overrideStore || await createSnapshotStore(config);
  const server = createApiServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await store.close?.();
  });
  return { server, store, config, snapshot };
}

test('serves complete rotations from memory without fetching Supabase', async t => {
  const { server, snapshot } = await setup(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('Public requests must not fetch upstream data.'));
  const response = await request(server, '/v1/rotations');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, snapshot.rotations);
  assert.equal(Object.keys(response.json)[0], 'meta');
  assert.equal(response.headers['cache-control'], 'public, max-age=300, s-maxage=300, stale-while-revalidate=60');
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.headers['access-control-expose-headers'], 'ETag');
  assert.match(response.headers.etag, /^"v1-[a-f0-9]{64}-[a-f0-9]{64}"$/);
});

test('serves a resolvable OpenAPI contract without requiring a snapshot', async t => {
  const { server } = await setup(t, { snapshot: null });
  const response = await request(server, '/openapi.json');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], '*');
  const document = response.json;
  assert.equal(document.openapi, '3.1.2');
  assert.deepEqual(Object.keys(document.paths).sort(), [
    '/docs', '/health', '/internal/refresh', '/openapi.json', '/v1/items', '/v1/items/{itemId}',
    '/v1/rotations', '/v1/rotations/mythic-sales', '/v1/rotations/sales',
    '/v1/rotations/sales/{section}', '/v1/rotations/sanctum', '/v1/rotations/your-shop',
  ].sort());
  function checkReferences(value) {
    if (Array.isArray(value)) return value.forEach(checkReferences);
    if (value === null || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$ref') {
        assert.ok(entry.startsWith('#/'));
        assert.ok(entry.slice(2).split('/').reduce((current, part) => current?.[part], document), entry);
      } else checkReferences(entry);
    }
  }
  checkReferences(document);
  assert.deepEqual(document.components.parameters.SaleSection.schema.enum,
    ['weekly', 'limited', 'chromas', 'blue-essence', 'other-items']);
  assert.equal((await request(server, '/openapi.json?extra=1')).status, 400);
});

test('serves self-hosted interactive docs and cacheable assets without a snapshot', async t => {
  const { server } = await setup(t, { snapshot: null });
  for (const path of ['/docs', '/docs/']) {
    const page = await request(server, path);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.match(page.text, /League of Legends Rotation API/);
    assert.match(page.text, /\/docs\/swagger-ui-bundle\.js/);
    assert.match(page.text, /\/openapi\.json/);
    assert.doesNotMatch(page.text, /unpkg|cdn\.jsdelivr/);
  }
  const initializer = await request(server, '/docs/docs-init.js');
  assert.equal(initializer.status, 200);
  assert.match(initializer.headers['content-type'], /^text\/javascript/);
  assert.match(initializer.text, /window\.location\.origin/);
  assert.match(initializer.text, /tryItOutEnabled: true/);
  assert.match(initializer.text, /persistAuthorization: false/);
  const bundle = await request(server, '/docs/swagger-ui-bundle.js');
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers['content-type'], /^text\/javascript/);
  assert.ok(bundle.text.length > 100_000);
  assert.match(bundle.headers.etag, /^"docs-[a-f0-9]{64}"$/);
  const unchanged = await request(server, '/docs/swagger-ui-bundle.js', { headers: { 'If-None-Match': bundle.headers.etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.text, '');
  assert.equal((await request(server, '/docs/swagger-ui.css')).status, 200);
  assert.equal((await request(server, '/docs/docs.css')).status, 200);
  assert.equal((await request(server, '/docs?configUrl=https://example.invalid')).status, 400);
  assert.equal((await request(server, '/docs/missing')).status, 404);
});

test('serves each rotation separately with distinct cache variants', async t => {
  const { server, snapshot } = await setup(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('Public requests must not fetch upstream data.'));
  const combined = await request(server, '/v1/rotations');
  const routes = [
    ['/v1/rotations/sales', 'catalogSales'],
    ['/v1/rotations/mythic-sales', 'mythicShop'],
    ['/v1/rotations/your-shop', 'yourShop'],
    ['/v1/rotations/sanctum', 'sanctum'],
  ];
  const etags = new Set([combined.headers.etag]);
  for (const [path, field] of routes) {
    const response = await request(server, path);
    assert.equal(response.status, 200, path);
    if (field === 'yourShop') {
      assert.deepEqual(response.json, { meta: snapshot.rotations.meta, [field]: snapshot.rotations[field] });
    } else {
      assert.deepEqual(response.json, {
        meta: snapshot.rotations.meta, page: 1, pageSize: 100, total: 1, totalPages: 1,
        [field]: snapshot.rotations[field],
      });
    }
    assert.equal(Object.keys(response.json)[0], 'meta');
    assert.equal(response.headers['cache-control'], combined.headers['cache-control']);
    assert.equal(response.headers['access-control-allow-origin'], '*');
    assert.ok(!etags.has(response.headers.etag), `${path} must have its own ETag.`);
    etags.add(response.headers.etag);
    const unchanged = await request(server, path, { headers: { 'If-None-Match': response.headers.etag } });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.text, '');
    assert.equal((await request(server, path, { headers: { 'If-None-Match': combined.headers.etag } })).status, 200);
  }
});

test('sales sections partition the catalog and filters apply before pagination', async t => {
  const source = rows();
  const base = source.CatalogSale[0];
  source.CatalogSale.push(
    { ...base, SaleID: uuid(101), Limited: true },
    { ...base, SaleID: uuid(102), ItemType: 2 },
    { ...base, SaleID: uuid(103), ItemType: 2, Currency: 'IP' },
    { ...base, SaleID: uuid(104), RiotItemID: 1002, ItemType: 4 },
    { ...base, SaleID: uuid(105), Currency: 'IP' },
    { ...base, SaleID: uuid(106) },
  );
  source.MythicSale.push({ ...source.MythicSale[0], OfferID: uuid(201), Section: 'DAILY' });
  source.SanctumSale.push({ ...source.SanctumSale[0], SaleID: uuid(301), Rarity: 'MYTHIC_VARIANT' });
  const snapshot = createSnapshot(source);
  const { server } = await setup(t, { snapshot });
  const sections = new Map([
    ['weekly', [uuid(100), uuid(106)]], ['limited', [uuid(101)]],
    ['chromas', [uuid(102)]], ['blue-essence', [uuid(103), uuid(105)]],
    ['other-items', [uuid(104)]],
  ]);
  const seen = [];
  for (const [section, ids] of sections) {
    const response = await request(server, `/v1/rotations/sales/${section}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.catalogSales.map(sale => sale.saleId), ids);
    assert.equal(response.json.total, ids.length);
    seen.push(...response.json.catalogSales.map(sale => sale.saleId));
  }
  assert.deepEqual(seen.sort(), snapshot.rotations.catalogSales.map(sale => sale.saleId).sort());
  const filtered = await request(server, '/v1/rotations/sales?currency=rp&typeId=1&limited=false&pageSize=1&page=2');
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.json.catalogSales.map(sale => sale.saleId), [uuid(106)]);
  assert.deepEqual([filtered.json.total, filtered.json.totalPages, filtered.json.pageSize], [2, 2, 1]);
  assert.equal((await request(server, '/v1/rotations/sales?limited=true')).json.total, 1);
  assert.equal((await request(server, '/v1/rotations/sales?championId=22&skinlineId=42')).json.total, 6);
  assert.equal((await request(server, '/v1/rotations/sales?championId=0')).json.total, 0);
  assert.equal((await request(server, '/v1/rotations/sales/blue-essence?typeId=2')).json.total, 1);
  assert.equal((await request(server, '/v1/rotations/sales/weekly?currency=IP')).json.total, 0);
  assert.deepEqual((await request(server, '/v1/rotations/sales?page=999')).json.catalogSales, []);
  assert.equal((await request(server, '/v1/rotations/sales?pageSize=500')).json.pageSize, 200);
  assert.deepEqual((await request(server, '/v1/rotations/mythic-sales?section=daily')).json.mythicShop.map(offer => offer.offerId), [uuid(201)]);
  assert.deepEqual((await request(server, '/v1/rotations/sanctum?rarity=mythic_variant')).json.sanctum.map(banner => banner.bannerId), [uuid(301)]);
  const normalized = await request(server, '/v1/rotations/sales?page=02&pageSize=01&currency=rp');
  const reordered = await request(server, '/v1/rotations/sales?currency=RP&pageSize=1&page=2');
  assert.equal(normalized.headers.etag, reordered.headers.etag);
  assert.notEqual(reordered.headers.etag, (await request(server, '/v1/rotations/sales?currency=IP&pageSize=1&page=2')).headers.etag);
});

test('items paginate, cap page size, intersect exact filters, and allow empty pages', async t => {
  const { server } = await setup(t);
  const first = await request(server, '/v1/items?pageSize=2');
  assert.equal(first.status, 200);
  assert.equal(first.json.page, 1);
  assert.equal(first.json.total, 3);
  assert.equal(first.json.totalPages, 2);
  assert.deepEqual(first.json.items.map(item => item.itemId), [uuid(2), uuid(3)]);
  const second = await request(server, '/v1/items?pageSize=2&page=2');
  assert.deepEqual(second.json.items.map(item => item.itemId), [uuid(1)]);
  const beyond = await request(server, '/v1/items?page=9007199254740991');
  assert.equal(beyond.status, 200);
  assert.deepEqual(beyond.json.items, []);
  const defaults = await request(server, '/v1/items');
  assert.equal(defaults.json.pageSize, 100);
  assert.equal((await request(server, '/v1/items?pageSize=999')).json.pageSize, 200);
  for (const query of ['typeId=2', 'championId=22&typeId=2', 'championId=22&typeId=2&skinlineId=42']) {
    const response = await request(server, `/v1/items?${query}`);
    assert.equal(response.json.total, 1);
    assert.equal(response.json.items[0].itemId, uuid(2));
  }
  const empty = await request(server, '/v1/items?championId=22&typeId=4');
  assert.equal(empty.status, 200);
  assert.equal(empty.json.totalPages, 0);
  assert.deepEqual(empty.json.items, []);
  assert.equal((await request(server, '/v1/items?skinlineId=0')).json.total, 0);
});

test('single-item lookup uses canonical UUID and returns the shared Item', async t => {
  const { server, snapshot } = await setup(t);
  const response = await request(server, `/v1/items/${uuid(1)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { meta: snapshot.rotations.meta, item: snapshot.items[2] });
  for (const path of [`/v1/items/${uuid(999)}`, '/v1/reference', '/missing', '/v1/items/extra/path', '/v1/rotations/unknown', '/v1/rotations/sales/unknown']) {
    const missing = await request(server, path);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: { code: 'not_found', message: 'The requested resource was not found.' } });
    assert.equal(missing.headers['cache-control'], 'no-store');
    assert.equal(missing.headers.etag, undefined);
  }
});

test('invalid, duplicate, and unknown query parameters return nondiagnostic 400s', async t => {
  const { server } = await setup(t);
  for (const path of [
    '/v1/items?page=0', '/v1/items?page=-1', '/v1/items?page=1.5', '/v1/items?page=1e2',
    '/v1/items?page=', '/v1/items?pageSize=0', '/v1/items?typeId=skin',
    '/v1/items?championId=-1', '/v1/items?skinlineId=NaN', '/v1/items?search=ashe',
    '/v1/items?page=1&page=2', '/v1/items?page=9007199254740992', '/v1/rotations?extra=1',
    '/v1/rotations/sales?extra=1', '/v1/rotations/sales/weekly?extra=1',
    '/v1/rotations/sales?page=0', '/v1/rotations/sales?pageSize=0',
    '/v1/rotations/sales?limited=1', '/v1/rotations/sales?currency=',
    '/v1/rotations/sales?typeId=-1', '/v1/rotations/sales?currency=RP&currency=IP',
    '/v1/rotations/mythic-sales?extra=1', '/v1/rotations/mythic-sales?section=unknown',
    '/v1/rotations/your-shop?extra=1', '/v1/rotations/sanctum?extra=1',
    '/v1/rotations/sanctum?rarity=unknown',
    '/v1/items/not-a-uuid', '/v1/items/%ZZ', `/v1/items/${uuid(1)}?page=1`,
  ]) {
    const response = await request(server, path);
    assert.equal(response.status, 400, path);
    assert.deepEqual(response.json, { error: { code: 'invalid_request', message: 'The request parameters are invalid.' } });
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('ETags depend on snapshot and normalized variant and support weak/list matches', async t => {
  const { server, snapshot } = await setup(t);
  assert.notEqual(makeEtag(snapshot.snapshotId, '/v1/items'), makeEtag(snapshot.snapshotId, '/v1/rotations'));
  assert.notEqual(makeEtag('a'.repeat(64), 'same'), makeEtag('b'.repeat(64), 'same'));
  const base = await request(server, '/v1/items');
  const normalized = await request(server, '/v1/items?pageSize=0100&page=01');
  assert.equal(base.headers.etag, normalized.headers.etag);
  const cap = await request(server, '/v1/items?pageSize=200');
  assert.equal(cap.headers.etag, (await request(server, '/v1/items?pageSize=201')).headers.etag);
  assert.equal((await request(server, '/v1/items?championId=22&typeId=1')).headers.etag,
    (await request(server, '/v1/items?typeId=1&championId=022')).headers.etag);
  for (const value of [base.headers.etag, `W/${base.headers.etag}`, `"other", ${base.headers.etag}`, '*']) {
    const response = await request(server, '/v1/items', { headers: { 'If-None-Match': value } });
    assert.equal(response.status, 304);
    assert.equal(response.text, '');
    assert.equal(response.headers.etag, base.headers.etag);
    assert.equal(response.headers['cache-control'], base.headers['cache-control']);
  }
  assert.equal((await request(server, '/v1/rotations', { headers: { 'If-None-Match': base.headers.etag } })).status, 200);
  assert.equal((await request(server, '/v1/items?page=2')).headers.etag === base.headers.etag, false);
});

test('startup without a snapshot returns safe 503 responses while failed refreshes retain unavailability', async t => {
  const config = { ...await testConfig(t), supabaseUrl: '', supabasePublishableKey: '' };
  const { server, store } = await start(config);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await store.close();
  });
  await store.whenIdle();
  for (const path of ['/v1/rotations', '/v1/rotations/sales', '/v1/rotations/sales/weekly', '/v1/rotations/mythic-sales',
    '/v1/rotations/your-shop', '/v1/rotations/sanctum', '/v1/items', `/v1/items/${uuid(1)}`]) {
    const response = await request(server, path);
    assert.equal(response.status, 503);
    assert.equal(response.headers['retry-after'], '60');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json, { error: { code: 'snapshot_unavailable', message: 'The API is temporarily unavailable. Please try again shortly.' } });
  }
  const health = await request(server, '/health');
  assert.equal(health.status, 503);
  assert.deepEqual(health.json, { ok: false, apiVersion: 'v1', snapshot: { loaded: false, generatedAt: null, ageSeconds: null } });
});

test('health fails only beyond the 90 minute threshold and stays safe', async t => {
  const { server, snapshot } = await setup(t);
  const generated = Date.parse(snapshot.generatedAt);
  let now = generated + 90 * 60_000;
  t.mock.method(Date, 'now', () => now);
  assert.equal((await request(server, '/health')).status, 200);
  now += 1;
  const stale = await request(server, '/health');
  assert.equal(stale.status, 503);
  assert.deepEqual(stale.json, { ok: false, apiVersion: 'v1', snapshot: { loaded: true, generatedAt: snapshot.generatedAt, ageSeconds: 5400 } });
  assert.equal(stale.headers['cache-control'], 'no-store');
  assert.equal(stale.headers['access-control-allow-origin'], undefined);
  assert.equal((await request(server, '/v1/rotations')).status, 200, 'Stale known-good data remains available.');
});

test('public rate limiting returns Retry-After and ignores untrusted forwarding headers', async t => {
  const { server } = await setup(t, { config: { publicRateLimit: 2 } });
  assert.equal((await request(server, '/v1/items')).status, 200);
  assert.equal((await request(server, '/v1/items', { headers: { 'X-Real-IP': '192.0.2.1' } })).status, 200);
  const limited = await request(server, '/v1/items', { headers: { 'X-Forwarded-For': '203.0.113.8', 'X-Real-IP': '192.0.2.2' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'rate_limited');
  assert.ok(Number(limited.headers['retry-after']) >= 1 && Number(limited.headers['retry-after']) <= 60);
  assert.equal(limited.headers['cache-control'], 'no-store');
  assert.equal((await request(server, '/health')).status, 200);
});

test('trusted proxy uses X-Real-IP and never multi-hop X-Forwarded-For', async t => {
  const { server } = await setup(t, { config: { publicRateLimit: 1, trustedProxyIps: ['127.0.0.1'] } });
  for (const ip of ['192.0.2.1', '192.0.2.2']) {
    assert.equal((await request(server, '/v1/items', { headers: { 'X-Real-IP': ip } })).status, 200);
    assert.equal((await request(server, '/v1/items', { headers: { 'X-Real-IP': ip } })).status, 429);
  }
  assert.equal((await request(server, '/v1/items', { headers: { 'X-Forwarded-For': '198.51.100.1' } })).status, 200);
  assert.equal((await request(server, '/v1/items', { headers: { 'X-Forwarded-For': '198.51.100.2' } })).status, 429);
});

test('refresh authenticates, rejects bodies, accepts asynchronously, and limits accepted attempts separately', async t => {
  const { server, store } = await setup(t, { config: { publicRateLimit: 1 } });
  const gate = deferred();
  const tables = rows();
  const mock = mockSupabase(t, async table => {
    if (table === 'CatalogItem') await gate.promise;
    return tables[table];
  });
  t.after(() => gate.resolve());
  const headers = { Authorization: 'Bearer test-refresh-secret' };
  for (const Authorization of ['', 'Bearer wrong', 'Basic test-refresh-secret']) {
    const response = await request(server, '/internal/refresh', { method: 'POST', headers: { Authorization } });
    assert.equal(response.status, 401);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  for (const options of [
    { headers: { ...headers, 'Content-Length': '2' }, body: '{}' },
    { headers, chunks: [' '] },
  ]) assert.equal((await request(server, '/internal/refresh', { method: 'POST', ...options })).status, 400);
  assert.equal(mock.mock.callCount(), 0);
  assert.equal((await request(server, '/v1/items')).status, 200);
  assert.equal((await request(server, '/v1/items')).status, 429);
  for (let i = 0; i < 2; i++) {
    const accepted = await request(server, '/internal/refresh', { method: 'POST', headers });
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.json, { accepted: true });
    assert.equal(accepted.headers['cache-control'], 'no-store');
  }
  const limited = await request(server, '/internal/refresh', { method: 'POST', headers });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers['retry-after']);
  gate.resolve();
  await store.whenIdle();
  assert.equal((await request(server, '/health')).status, 200);
});

test('public CORS preflight is bodyless and internal routes have no CORS', async t => {
  const { server } = await setup(t);
  const preflight = await request(server, '/v1/items', { method: 'OPTIONS', headers: { Origin: 'https://example.invalid' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.text, '');
  assert.equal(preflight.headers['access-control-allow-origin'], '*');
  assert.equal(preflight.headers['access-control-allow-headers'], 'If-None-Match');
  const internal = await request(server, '/internal/refresh', { method: 'OPTIONS' });
  assert.equal(internal.status, 404);
  assert.equal(internal.headers['access-control-allow-origin'], undefined);
});

test('unexpected server exceptions return only the defined internal error', async t => {
  const { server } = await setup(t, { store: { get current() { throw new Error('sensitive exception'); } } });
  const response = await request(server, '/v1/items');
  assert.equal(response.status, 500);
  assert.deepEqual(response.json, { error: { code: 'internal_error', message: 'The API could not complete the request.' } });
  assert.doesNotMatch(response.text, /sensitive|stack|Supabase/);
  assert.equal(response.headers['cache-control'], 'no-store');
});
