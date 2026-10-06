import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSnapshotStore } from '../src/refresh.mjs';
import { readSourceState } from '../src/persistence.mjs';
import { readCatalogChanges } from '../src/supabase.mjs';
import { createSnapshot } from '../src/snapshot.mjs';
import { fingerprintsFor, mockSupabase, rows, testConfig, uuid } from './fixtures.mjs';

async function check(store) {
  store.requestRefresh('internal');
  await store.whenIdle();
}

function icon(number) {
  return { ItemID: uuid(number), RiotItemID: number + 10000, ItemType: 4, Name: `Icon ${number}`,
    ImageURL: '//example.invalid/icon.png', ParentItemID: null, ChampionID: null, SkinlineID: null };
}

function captureFeed(t) {
  const original = globalThis.fetch;
  const feeds = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await original(url, options);
    if (url.pathname.endsWith('get_public_api_catalog_changes')) {
      const body = await response.clone().text();
      feeds.push({ rows: JSON.parse(body), bytes: Buffer.byteLength(body), url });
    }
    return response;
  });
  return feeds;
}

test('a 16,000 item catalog transfers only additions, changed items, and removal IDs after bootstrap', async t => {
  const config = await testConfig(t);
  const tables = rows();
  tables.CatalogItem.push(...Array.from({ length: 15997 }, (_, i) => icon(i + 4)));
  const mock = mockSupabase(t, tables, () => fingerprintsFor(tables));
  const feeds = captureFeed(t);
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  await check(store);
  assert.equal(store.current.snapshot.items.length, 16000);
  const calls = mock.mock.callCount();
  tables.CatalogItem[0].ImageURL = '//example.invalid/updated.png';
  tables.CatalogItem = tables.CatalogItem.filter(item => item.ItemID !== uuid(3));
  tables.CatalogItem.push(...Array.from({ length: 15 }, (_, i) => icon(i + 16001)));
  await check(store);
  assert.deepEqual(mock.mock.calls.slice(calls).map(call => call.arguments[0].pathname.split('/').at(-1)),
    ['public_api_state', 'get_public_api_catalog_changes', 'get_public_api_fingerprint']);
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].rows.length, 17);
  assert.ok(feeds[0].bytes < 20000, `Delta was ${feeds[0].bytes} bytes.`);
  assert.deepEqual(feeds[0].rows.find(row => row.item_id === uuid(3)).item_data, null);
  const expected = createSnapshot(tables, store.current.snapshot.generatedAt);
  assert.deepEqual(store.current.snapshot, expected);
  assert.equal((await readSourceState(config.dataDir)).catalogRevision, 2);
});

test('lookup changes transfer affected items; unused lookups transfer no items or change ETags', async t => {
  const config = await testConfig(t);
  const tables = rows();
  mockSupabase(t, tables, () => fingerprintsFor(tables));
  const feeds = captureFeed(t);
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  await check(store);
  for (const change of [
    () => { tables.Champion[0].Name = 'Updated Ashe'; },
    () => { tables.Skinline[0].Name = 'Updated Skinline'; },
    () => { tables.Universe[0].Name = 'Updated Universe'; },
  ]) {
    change();
    await check(store);
    assert.equal(feeds.at(-1).rows.length, 2);
    assert.deepEqual(store.current.snapshot, createSnapshot(tables, store.current.snapshot.generatedAt));
  }
  const previous = store.current;
  tables.Skinline.push({ id: 99, Name: 'Unused', UniverseID: null });
  await check(store);
  assert.deepEqual(feeds.at(-1).rows, []);
  assert.equal(store.current, previous);
  // A reverted item is also equivalent despite JSONB object key ordering.
  tables.CatalogItem[0].Name = 'Intermediate';
  await globalThis.fetch(new URL('/rest/v1/public_api_state', config.supabaseUrl), {});
  tables.CatalogItem[0].Name = 'Zeta Skin';
  await check(store);
  assert.equal(store.current, previous);
});

test('missed catalog publications and a restart recover the latest changes and tombstones from the saved revision', async t => {
  const config = await testConfig(t);
  const tables = rows();
  const mock = mockSupabase(t, tables, () => fingerprintsFor(tables));
  const feeds = captureFeed(t);
  const initial = await createSnapshotStore(config);
  await check(initial);
  await initial.close();
  tables.CatalogItem[0].Name = 'Intermediate';
  await globalThis.fetch(new URL('/rest/v1/public_api_state', config.supabaseUrl), {});
  tables.CatalogItem[0].Name = 'Latest';
  tables.CatalogItem = tables.CatalogItem.filter(item => item.ItemID !== uuid(3));
  await globalThis.fetch(new URL('/rest/v1/public_api_state', config.supabaseUrl), {});
  tables.CatalogItem.push(icon(4));
  const resumed = await createSnapshotStore(config);
  t.after(() => resumed.close());
  const before = mock.mock.callCount();
  await check(resumed);
  assert.equal(mock.mock.callCount() - before, 3);
  assert.equal(feeds[0].url.searchParams.get('after_revision'), '1');
  assert.equal(feeds[0].url.searchParams.get('expected_revision'), '4');
  assert.equal(feeds[0].rows.length, 3);
  assert.equal(resumed.current.itemById.get(uuid(1)).name, 'Latest');
  assert.equal(resumed.current.itemById.has(uuid(3)), false);
  assert.deepEqual(resumed.current.snapshot, createSnapshot(tables, resumed.current.snapshot.generatedAt));
  const saved = await readSourceState(config.dataDir);
  assert.equal(saved.catalogRevision, 4);
  const calls = mock.mock.callCount();
  await check(resumed);
  assert.equal(mock.mock.callCount() - calls, 1);
});

test('a failed delta preserves the snapshot and cursor and retries without a full catalog fallback', async t => {
  const config = await testConfig(t);
  const tables = rows();
  const mock = mockSupabase(t, tables, () => fingerprintsFor(tables));
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  await check(store);
  const previous = store.current;
  const saved = await readSourceState(config.dataDir);
  tables.CatalogItem[0].Name = 'Updated';
  const original = globalThis.fetch;
  let failing = true;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url.pathname.split('/').at(-1));
    if (failing && url.pathname.endsWith('get_public_api_catalog_changes')) return new Response('private diagnostic', { status: 500 });
    return original(url, options);
  });
  await check(store);
  assert.equal(store.current, previous);
  assert.deepEqual(await readSourceState(config.dataDir), saved);
  assert.deepEqual(calls, ['public_api_state', 'get_public_api_catalog_changes']);
  failing = false;
  await check(store);
  assert.equal(store.current.itemById.get(uuid(1)).name, 'Updated');
  assert.equal(mock.mock.calls.some(call => call.arguments[0].searchParams.get('after_revision') === '1'), true);
});

test('an older valid sidecar without a catalog cursor downloads the catalog once and reuses rotations', async t => {
  const config = await testConfig(t);
  const tables = rows();
  const mock = mockSupabase(t, tables, () => fingerprintsFor(tables));
  const initial = await createSnapshotStore(config);
  await check(initial);
  await initial.close();
  const saved = await readSourceState(config.dataDir);
  delete saved.catalogRevision;
  await writeFile(join(config.dataDir, 'snapshot-source-v1.json'), JSON.stringify(saved));
  const resumed = await createSnapshotStore(config);
  t.after(() => resumed.close());
  const before = mock.mock.callCount();
  await check(resumed);
  assert.deepEqual(mock.mock.calls.slice(before).map(call => call.arguments[0].pathname.split('/').at(-1)).sort(),
    ['public_api_state', 'CatalogItem', 'ItemType', 'Champion', 'Skinline', 'Universe', 'get_public_api_fingerprint'].sort());
  assert.equal((await readSourceState(config.dataDir)).catalogRevision, 1);
  const calls = mock.mock.callCount();
  await check(resumed);
  assert.equal(mock.mock.callCount() - calls, 1);
});

test('catalog changes paginate safely and reject malformed identities, revisions, duplicates, and partial feeds', async t => {
  const config = await testConfig(t);
  const template = createSnapshot(rows()).items[0];
  const changes = Array.from({ length: 501 }, (_, i) => ({ item_id: uuid(i + 1),
    item_data: { ...template, itemId: uuid(i + 1), riotItemId: i }, changed_revision: 2 }));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(options.headers.Range);
    const [start, end] = options.headers.Range.split('-').map(Number);
    const page = changes.slice(start, end + 1);
    return Response.json(page, { headers: { 'content-range': `${start}-${start + page.length - 1}/501` } });
  });
  assert.equal((await readCatalogChanges(config, 1, 2)).length, 501);
  assert.deepEqual(calls, ['0-499', '500-999']);
  for (const malformed of [
    { ...changes[0], item_id: 'bad' },
    { ...changes[0], item_data: { ...template, itemId: uuid(999) } },
    { ...changes[0], changed_revision: 1 },
    { ...changes[0], changed_revision: 3 },
    { ...changes[0], private: 'extra' },
  ]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json([malformed], { headers: { 'content-range': '0-0/1' } }));
    await assert.rejects(readCatalogChanges(config, 1, 2));
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json([changes[0], changes[0]], { headers: { 'content-range': '0-1/2' } }));
  await assert.rejects(readCatalogChanges(config, 1, 2));
  t.mock.method(globalThis, 'fetch', async (url, options) => options.headers.Range.startsWith('500-')
    ? new Response('revision changed', { status: 400 })
    : Response.json(changes.slice(0, 500), { headers: { 'content-range': '0-499/501' } }));
  await assert.rejects(readCatalogChanges(config, 1, 2), /HTTP 400/);
});

test('a database restore that rolls the catalog revision back synchronizes once and retains unchanged rotations', async t => {
  const config = await testConfig(t);
  const tables = rows();
  const mock = mockSupabase(t, tables, () => fingerprintsFor(tables));
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  await check(store);
  tables.CatalogItem[0].Name = 'Updated';
  await check(store);
  assert.equal((await readSourceState(config.dataDir)).catalogRevision, 2);
  const original = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await original(url, options);
    if (!url.pathname.endsWith('public_api_state')) return response;
    const [state] = await response.json();
    state.catalog_revision = 1;
    return Response.json([state], { headers: { 'content-range': '0-0/1' } });
  });
  const before = mock.mock.callCount();
  const previous = store.current;
  await check(store);
  assert.equal(store.current, previous);
  assert.equal((await readSourceState(config.dataDir)).catalogRevision, 1);
  assert.deepEqual(mock.mock.calls.slice(before).map(call => call.arguments[0].pathname.split('/').at(-1)).sort(),
    ['public_api_state', 'CatalogItem', 'ItemType', 'Champion', 'Skinline', 'Universe', 'get_public_api_fingerprint'].sort());
  const calls = mock.mock.callCount();
  await check(store);
  assert.equal(mock.mock.callCount() - calls, 1);
});
