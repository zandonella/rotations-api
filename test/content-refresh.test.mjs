import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSnapshotStore } from '../src/refresh.mjs';
import { createApiServer } from '../src/server.mjs';
import { persistSnapshot, readSnapshot } from '../src/persistence.mjs';
import { readFingerprint } from '../src/supabase.mjs';
import { createSnapshot } from '../src/snapshot.mjs';
import { confirmedFingerprints, fingerprintsFor, mockSupabase, request, rows, testConfig } from './fixtures.mjs';

async function check(store, reason = 'internal') {
  store.requestRefresh(reason);
  await store.whenIdle();
}

test('unchanged hints and 48 fallback checks read only one small manifest row and preserve disk and ETags', async t => {
  const config = await testConfig(t);
  const tables = rows();
  const mock = mockSupabase(t, tables, () => fingerprintsFor(tables));
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  await check(store, 'startup');
  const current = store.current;
  const disk = await readFile(join(config.dataDir, 'snapshot-v1.json'), 'utf8');
  const calls = mock.mock.callCount();
  for (let i = 0; i < 48; i++) {
    await check(store, 'periodic');
    assert.equal(store.current, current);
  }
  assert.equal(mock.mock.callCount() - calls, 48);
  for (const call of mock.mock.calls.slice(calls)) assert.equal(call.arguments[0].pathname, '/rest/v1/public_api_state');
  assert.equal(await readFile(join(config.dataDir, 'snapshot-v1.json'), 'utf8'), disk);
});

test('each rotation update fetches only that section and catalog changes update all embedded items without rereading rotations', async t => {
  const config = await testConfig(t);
  const tables = rows();
  const mock = mockSupabase(t, tables, () => fingerprintsFor(tables));
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  await check(store, 'startup');
  for (const [change, expectedTables] of [
    [() => { tables.CatalogSale[0].SalePrice = 675; tables.CatalogSale[0].PercentOff = 50; }, ['CatalogSale']],
    [() => { tables.MythicSale[0].SaleEndAt = new Date(Date.now() + 2 * 86400_000).toISOString(); }, ['MythicSale']],
    [() => { tables.SanctumSale = []; }, ['SanctumSale']],
    [() => { tables.YourShopSale[0].HubEnabled = false; }, ['YourShopSale']],
    [() => { tables.CatalogItem[0].ImageURL = '//example.invalid/new.png'; }, ['get_public_api_catalog_changes']],
  ]) {
    const previous = store.current;
    const before = mock.mock.callCount();
    change();
    await check(store);
    assert.notEqual(store.current.snapshot.snapshotId, previous.snapshot.snapshotId);
    assert.deepEqual(await readSnapshot(config.dataDir), store.current.snapshot);
    const downloaded = mock.mock.calls.slice(before).map(call => call.arguments[0].pathname.split('/').at(-1))
      .filter(table => !['public_api_state', 'get_public_api_fingerprint'].includes(table));
    assert.deepEqual(downloaded.sort(), expectedTables.sort());
  }
  assert.equal(store.current.snapshot.rotations.catalogSales[0].item.imageUrl, '//example.invalid/new.png');
  assert.equal(store.current.snapshot.rotations.mythicShop[0].primaryItem.imageUrl, '//example.invalid/new.png');
  tables.MythicSale = [];
  await check(store);
  assert.deepEqual(store.current.snapshot.rotations.mythicShop, []);
});

test('restart uses persisted fingerprints and catalog; mismatched or corrupt sidecars safely cause one full sync', async t => {
  const config = await testConfig(t);
  const tables = rows();
  const mock = mockSupabase(t, tables, () => fingerprintsFor(tables));
  const initial = await createSnapshotStore(config);
  await check(initial, 'startup');
  const snapshot = initial.current.snapshot;
  await initial.close();
  const resumed = await createSnapshotStore(config);
  const before = mock.mock.callCount();
  await check(resumed, 'startup');
  assert.equal(mock.mock.callCount() - before, 1);
  assert.equal(resumed.current.snapshot.snapshotId, snapshot.snapshotId);
  tables.CatalogSale[0].SalePrice = 600;
  await check(resumed);
  assert.equal(mock.mock.callCount() - before, 4);
  await resumed.close();
  for (const content of ['{broken', JSON.stringify({ snapshotId: '0'.repeat(64), fingerprints: fingerprintsFor(tables) })]) {
    await writeFile(join(config.dataDir, 'snapshot-source-v1.json'), content);
    const recovered = await createSnapshotStore(config);
    const calls = mock.mock.callCount();
    await check(recovered, 'startup');
    assert.equal(mock.mock.callCount() - calls, 11);
    await recovered.close();
  }
});

test('missed pulls compare every section revision and recover all changes together', async t => {
  const config = await testConfig(t);
  const tables = rows();
  const mock = mockSupabase(t, tables, () => fingerprintsFor(tables));
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  await check(store, 'startup');
  const calls = mock.mock.callCount();
  tables.CatalogSale[0].SalePrice = 675;
  tables.MythicSale[0].Price = 125;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await originalFetch(url, options);
    if (url.pathname.endsWith('public_api_state')) {
      const [manifest] = await response.json();
      manifest.changed_sections = ['mythic'];
      return Response.json([manifest], { headers: { 'content-range': '0-0/1' } });
    }
    return response;
  });
  await check(store, 'periodic');
  const downloaded = mock.mock.calls.slice(calls).map(call => call.arguments[0].pathname.split('/').at(-1));
  assert.deepEqual(downloaded.sort(), ['CatalogSale', 'MythicSale', 'get_public_api_fingerprint', 'public_api_state'].sort());
  assert.equal(store.current.snapshot.rotations.catalogSales[0].salePrice.amount, 675);
  assert.equal(store.current.snapshot.rotations.mythicShop[0].price.amount, 125);
});

test('a source change during download preserves previous state and retries the confirmed update', async t => {
  const config = await testConfig(t);
  const tables = rows();
  let duringDownload = false;
  let published = fingerprintsFor(tables);
  mockSupabase(t, async table => {
    if (duringDownload && table === 'CatalogItem') tables.CatalogItem[0].ImageURL = '//example.invalid/new.png';
    return tables[table];
  }, () => published);
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  await check(store, 'startup');
  const previous = store.current;
  tables.CatalogItem[0].Name = 'Changed Skin';
  published = fingerprintsFor(tables);
  // The manifest stays at the confirmed version while live rows change mid-read.
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.pathname.endsWith('get_public_api_fingerprint')) return Response.json(fingerprintsFor(tables));
    return originalFetch(url, options);
  });
  duringDownload = true;
  await check(store);
  assert.equal(store.current, previous);
  assert.deepEqual(await readSnapshot(config.dataDir), previous.snapshot);
  duringDownload = false;
  published = fingerprintsFor(tables);
  await check(store, 'periodic');
  assert.notEqual(store.current, previous);
});

test('old unchanged snapshots stay healthy after a confirmed pull, preserve ETags, and stale confirmation becomes unhealthy', async t => {
  const config = await testConfig(t);
  const tables = rows();
  const previous = createSnapshot(tables, new Date(Date.now() - 2 * 3600_000).toISOString());
  await persistSnapshot(config.dataDir, previous);
  const store = await createSnapshotStore(config);
  const server = createApiServer(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await store.close();
  });
  const before = await request(server, '/v1/rotations');
  assert.equal((await request(server, '/health')).status, 503);
  const mock = mockSupabase(t, tables, () => fingerprintsFor(tables));
  await check(store, 'startup');
  const health = await request(server, '/health');
  assert.equal(health.status, 200);
  assert.ok(health.json.snapshot.ageSeconds >= 7200);
  assert.equal(health.json.snapshot.generatedAt, previous.generatedAt);
  assert.equal((await request(server, '/v1/rotations', { headers: { 'If-None-Match': before.headers.etag } })).status, 304);
  const checkedMs = Date.parse(store.checkedAt);
  t.mock.method(Date, 'now', () => checkedMs + 90 * 60_000);
  assert.equal((await request(server, '/health')).status, 200);
  t.mock.method(Date, 'now', () => checkedMs + 90 * 60_000 + 1);
  mock.mock.mockImplementation(async () => { throw new Error('Unavailable.'); });
  await check(store, 'periodic');
  assert.equal((await request(server, '/health')).status, 503);
  assert.equal((await request(server, '/v1/rotations')).status, 200);
});

test('failed manifest reads never fall back to downloading the catalog', async t => {
  const config = await testConfig(t);
  const tables = rows();
  const mock = mockSupabase(t, tables, () => fingerprintsFor(tables));
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  await check(store, 'startup');
  const previous = store.current;
  const checkedAt = store.checkedAt;
  const before = mock.mock.callCount();
  mock.mock.mockImplementation(async url => {
    assert.equal(url.pathname, '/rest/v1/public_api_state');
    return new Response('missing migration', { status: 404 });
  });
  await check(store, 'periodic');
  assert.equal(mock.mock.callCount() - before, 1);
  assert.equal(store.current, previous);
  assert.equal(store.checkedAt, checkedAt);
});

test('fingerprint helper rejects malformed values and sanitizes upstream failures', async t => {
  const config = await testConfig(t);
  for (const value of [null, [], {}, 'a'.repeat(32), { catalog: 'a'.repeat(32) },
    { ...confirmedFingerprints, mythic: 'x'.repeat(32) }, { ...confirmedFingerprints, private: 'extra' }]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(value));
    await assert.rejects(readFingerprint(config), /Invalid public data fingerprint/);
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('sensitive content', { status: 401 }));
  await assert.rejects(readFingerprint(config), error => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});
