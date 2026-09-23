import assert from 'node:assert/strict';
import test from 'node:test';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSnapshotStore } from '../src/refresh.mjs';
import { persistSnapshot, readSnapshot } from '../src/persistence.mjs';
import { snapshotDigest } from '../src/validate.mjs';
import { deferred, fixtureSnapshot, mockSupabase, rows, testConfig, uuid } from './fixtures.mjs';

test('loads and freezes valid persisted data and reconstructs the item map', async t => {
  const config = await testConfig(t);
  const snapshot = fixtureSnapshot();
  await persistSnapshot(config.dataDir, snapshot);
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  assert.deepEqual(store.current.snapshot, snapshot);
  assert.equal(store.current.itemById.get(uuid(1)), store.current.snapshot.items[2]);
  assert.throws(() => { store.current.snapshot.items[0].name = 'changed'; }, TypeError);
  assert.equal(Object.hasOwn(await readSnapshot(config.dataDir), 'itemById'), false);
});

test('rejects corrupt JSON, malformed persisted snapshots, and invalid digests', async t => {
  const config = await testConfig(t);
  const malformed = fixtureSnapshot();
  malformed.items[0].name = '';
  malformed.snapshotId = snapshotDigest(malformed);
  const tampered = fixtureSnapshot();
  tampered.snapshotId = '0'.repeat(64);
  for (const content of ['{broken', JSON.stringify(malformed), JSON.stringify(tampered)]) {
    await writeFile(join(config.dataDir, 'snapshot-v1.json'), content);
    const store = await createSnapshotStore(config);
    assert.equal(store.current, null);
    await store.close();
    assert.equal(await readFile(join(config.dataDir, 'snapshot-v1.json'), 'utf8'), content);
  }
});

test('validation failure and upstream failure preserve known-good memory and disk', async t => {
  const config = await testConfig(t);
  const previous = fixtureSnapshot();
  await persistSnapshot(config.dataDir, previous);
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  const reference = store.current;
  const malformed = rows();
  malformed.CatalogSale[0].RiotItemID = 999;
  const fetchMock = mockSupabase(t, malformed);
  store.requestRefresh('internal');
  await store.whenIdle();
  assert.equal(store.current, reference);
  assert.deepEqual(await readSnapshot(config.dataDir), previous);
  fetchMock.mock.mockImplementation(async () => { throw new Error('Mock upstream failure.'); });
  store.requestRefresh('periodic');
  await store.whenIdle();
  assert.equal(store.current, reference);
  assert.deepEqual(await readSnapshot(config.dataDir), previous);
});

test('persistence failure never swaps the candidate into memory', async t => {
  const config = await testConfig(t);
  const originalDirectory = config.dataDir;
  const previous = fixtureSnapshot();
  await persistSnapshot(originalDirectory, previous);
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  const reference = store.current;
  mockSupabase(t);
  const blocked = join(originalDirectory, 'not-a-directory');
  await writeFile(blocked, 'occupied');
  config.dataDir = blocked;
  store.requestRefresh('internal');
  await store.whenIdle();
  assert.equal(store.current, reference);
  assert.deepEqual(await readSnapshot(originalDirectory), previous);
});

test('atomic swap happens only after the complete candidate is synced and renamed', async t => {
  const config = await testConfig(t);
  const previous = fixtureSnapshot();
  await persistSnapshot(config.dataDir, previous);
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  const reference = store.current;
  const tables = rows();
  tables.CatalogItem[0].Name = 'Updated Skin';
  mockSupabase(t, tables);
  const handle = await open(join(config.dataDir, 'prototype-probe'), 'w');
  const prototype = Object.getPrototypeOf(handle);
  const sync = prototype.sync;
  await handle.close();
  const syncing = deferred();
  const release = deferred();
  t.mock.method(prototype, 'sync', async function () {
    syncing.resolve();
    await release.promise;
    return sync.call(this);
  });
  store.requestRefresh('internal');
  await syncing.promise;
  assert.equal(store.current, reference);
  assert.deepEqual(await readSnapshot(config.dataDir), previous);
  release.resolve();
  await store.whenIdle();
  assert.notEqual(store.current, reference);
  assert.equal(store.current.itemById.get(uuid(1)).name, 'Updated Skin');
  assert.deepEqual(await readSnapshot(config.dataDir), store.current.snapshot);
});

test('any number of intervening hints coalesce into one serialized follow-up rebuild', async t => {
  const config = await testConfig(t);
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  const tables = rows();
  const started = deferred();
  const release = deferred();
  let builds = 0;
  mockSupabase(t, async table => {
    if (table === 'CatalogItem') {
      builds += 1;
      if (builds === 1) { started.resolve(); await release.promise; }
    }
    return tables[table];
  });
  store.requestRefresh('startup');
  await started.promise;
  for (let i = 0; i < 100; i++) store.requestRefresh('internal');
  assert.equal(builds, 1);
  assert.equal(store.current, null);
  release.resolve();
  await store.whenIdle();
  assert.equal(builds, 2);
  assert.ok(store.current);
});

test('a failed rebuild still runs its pending follow-up and can recover', async t => {
  const config = await testConfig(t);
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  const tables = rows();
  const started = deferred();
  const release = deferred();
  let builds = 0;
  mockSupabase(t, async table => {
    if (table === 'CatalogItem' && ++builds === 1) {
      started.resolve();
      await release.promise;
      throw new Error('Mock read failure.');
    }
    return tables[table];
  });
  store.requestRefresh('startup');
  await started.promise;
  store.requestRefresh('internal');
  release.resolve();
  await store.whenIdle();
  assert.equal(builds, 2);
  assert.ok(store.current);
});

test('startup serves persisted state during its asynchronous refresh and timer triggers fallback', async t => {
  const config = await testConfig(t);
  const previous = fixtureSnapshot();
  await persistSnapshot(config.dataDir, previous);
  const store = await createSnapshotStore(config);
  t.after(() => store.close());
  const tables = rows();
  const started = deferred();
  const release = deferred();
  let builds = 0;
  mockSupabase(t, async table => {
    if (table === 'CatalogItem') {
      builds += 1;
      if (builds === 1) { started.resolve(); await release.promise; }
    }
    return tables[table];
  });
  let periodic;
  t.mock.method(globalThis, 'setInterval', (callback, interval) => {
    assert.equal(interval, 30 * 60_000);
    periodic = callback;
    return { unref() {} };
  });
  store.start();
  await started.promise;
  assert.equal(store.current.snapshot.snapshotId, previous.snapshotId);
  release.resolve();
  await store.whenIdle();
  assert.equal(builds, 1);
  periodic();
  await store.whenIdle();
  assert.equal(builds, 2);
});
