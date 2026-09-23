import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readConfig } from '../src/config.mjs';
import { buildSnapshot, createSnapshot } from '../src/snapshot.mjs';
import { normalizeTimestamp, snapshotDigest, validateSnapshot } from '../src/validate.mjs';
import { fixtureSnapshot, mockSupabase, rows, testConfig, uuid } from './fixtures.mjs';

test('builds normalized items and all rotation contracts from public HTTP reads', async t => {
  const config = await testConfig(t);
  const mock = mockSupabase(t);
  const { snapshot, rowCounts } = await buildSnapshot(config);
  const map = validateSnapshot(snapshot);
  assert.equal(mock.mock.callCount(), 9);
  assert.equal(rowCounts.CatalogItem, 3);
  assert.equal(map.size, 3);
  assert.deepEqual(snapshot.items.map(item => item.itemId), [uuid(2), uuid(3), uuid(1)]);
  assert.deepEqual(snapshot.rotations.catalogSales[0].regularPrice, { amount: 1350, currency: 'RP' });
  assert.equal(snapshot.rotations.catalogSales[0].item.type.id, 1);
  assert.equal(snapshot.rotations.sanctum[0].bannerId, uuid(300));
  assert.deepEqual(snapshot.rotations.mythicShop[0].includedContentIds, [uuid(1), uuid(900)]);
  assert.equal(snapshot.rotations.yourShop.currentWindow.shopName, 'current');
  assert.deepEqual(snapshot.rotations.yourShop.recentWindows.map(window => window.shopName), ['past-0', 'past-1', 'past-2', 'past-3']);
  assert.equal(snapshot.items[2].skinline.universe.name, 'Example Universe');
  assert.doesNotMatch(JSON.stringify(snapshot), /IsActive|HubEnabled|CreatedAt|SortSection|PrimaryItemID|IncludedItems|SaleID/);
});

test('omits legacy unnamed emotes while retaining named emotes', () => {
  const tables = rows();
  tables.CatalogItem.push(
    { ItemID: uuid(4), RiotItemID: 4004, ItemType: 3, Name: '  ', ImageURL: null, ParentItemID: uuid(4), ChampionID: null, SkinlineID: null },
    { ItemID: uuid(5), RiotItemID: 4005, ItemType: 3, Name: 'Named Emote', ImageURL: null, ParentItemID: uuid(5), ChampionID: null, SkinlineID: null },
  );
  const snapshot = createSnapshot(tables);
  validateSnapshot(snapshot);
  assert.equal(snapshot.items.some(item => item.itemId === uuid(4)), false);
  assert.equal(snapshot.items.some(item => item.itemId === uuid(5)), true);

  tables.CatalogItem[0].Name = '  ';
  assert.throws(() => validateSnapshot(createSnapshot(tables)), /item.name/);
});

test('snapshot hash excludes its own digest and includes generatedAt', () => {
  const snapshot = fixtureSnapshot();
  const { snapshotId, ...candidate } = snapshot;
  assert.equal(snapshotId, createHash('sha256').update(JSON.stringify(candidate)).digest('hex'));
  assert.equal(snapshotDigest({ ...snapshot, snapshotId: 'ignored' }), snapshotId);
  candidate.generatedAt = '2020-01-01T00:00:00.000Z';
  assert.notEqual(snapshotDigest(candidate), snapshotId);
});

test('normalizes timestamps and rejects impossible dates', () => {
  assert.equal(normalizeTimestamp('2026-09-22T10:00:00.123456-04:00'), '2026-09-22T14:00:00.123Z');
  for (const value of ['2026-02-30T00:00:00Z', 'yesterday', '2026-09-22', null]) assert.throws(() => normalizeTimestamp(value));
});

test('empty rotations and no current Your Shop are valid', () => {
  const tables = rows();
  for (const table of ['CatalogSale', 'MythicSale', 'SanctumSale', 'YourShopSale']) tables[table] = [];
  const snapshot = createSnapshot(tables);
  validateSnapshot(snapshot);
  assert.deepEqual(snapshot.rotations.yourShop, { currentWindow: null, recentWindows: [] });
});

test('current Your Shop requires both flags and exclusive end time', () => {
  for (const flag of ['HubEnabled', 'IsActive']) {
    const tables = rows();
    tables.YourShopSale[0][flag] = false;
    const snapshot = createSnapshot(tables);
    validateSnapshot(snapshot);
    assert.equal(snapshot.rotations.yourShop.currentWindow, null);
  }
  const tables = rows();
  tables.YourShopSale[0].SaleEndAt = new Date().toISOString();
  assert.equal(createSnapshot(tables).rotations.yourShop.currentWindow, null);
});

test('sorts Mythic sections, Sanctum rarity, and same-name catalog ties deterministically', () => {
  const tables = rows();
  tables.CatalogItem[0].Name = tables.CatalogItem[1].Name;
  tables.MythicSale = ['DAILY', 'WEEKLY', 'FEATURED', 'BIWEEKLY'].map((Section, i) => ({ ...tables.MythicSale[0], Section, OfferID: uuid(200 + i) }));
  tables.SanctumSale = ['MYTHIC_VARIANT', 'EXALTED'].map((Rarity, i) => ({ ...tables.SanctumSale[0], Rarity, SaleID: uuid(300 + i) }));
  const snapshot = createSnapshot(tables);
  validateSnapshot(snapshot);
  assert.deepEqual(snapshot.rotations.mythicShop.map(offer => offer.section), ['FEATURED', 'BIWEEKLY', 'WEEKLY', 'DAILY']);
  assert.deepEqual(snapshot.rotations.sanctum.map(banner => banner.rarity), ['EXALTED', 'MYTHIC_VARIANT']);
  assert.deepEqual(snapshot.items.slice(0, 2).map(item => item.itemId), [uuid(1), uuid(2)]);
});

test('rejects duplicate canonical IDs and unresolved required relationships', () => {
  for (const table of ['CatalogItem', 'CatalogSale', 'MythicSale', 'SanctumSale', 'YourShopSale']) {
    const tables = rows();
    tables[table].push(structuredClone(tables[table][0]));
    assert.throws(() => validateSnapshot(createSnapshot(tables)), /Invalid snapshot/, table);
  }
  for (const [table, column, value] of [
    ['CatalogSale', 'RiotItemID', 900], ['SanctumSale', 'ItemType', 7],
    ['MythicSale', 'PrimaryItemID', uuid(999)], ['CatalogItem', 'ChampionID', 999],
    ['CatalogItem', 'SkinlineID', 999], ['Skinline', 'UniverseID', 999],
    ['CatalogItem', 'ParentItemID', uuid(999)],
  ]) {
    const tables = rows();
    tables[table][0][column] = value;
    assert.throws(() => validateSnapshot(createSnapshot(tables)), /Invalid snapshot/, `${table}.${column}`);
  }
});

test('rejects malformed shapes, IDs, enums, prices, embedded items, hashes and windows', () => {
  const changes = [
    s => { s.items[0].name = ''; },
    s => { s.items[0].type.id = 8; },
    s => { s.items[0].riotItemId = Infinity; },
    s => { s.items[0].extra = 'forbidden'; },
    s => { s.rotations.catalogSales[0].saleId = 'not-a-uuid'; },
    s => { s.rotations.catalogSales[0].salePrice.amount = 1.5; },
    s => { s.rotations.catalogSales[0].endsAt = s.rotations.catalogSales[0].startsAt; },
    s => { s.rotations.catalogSales[0].item = { ...s.items[2], name: 'wrong' }; },
    s => { s.rotations.mythicShop[0].section = 'MONTHLY'; },
    s => { s.rotations.sanctum[0].rarity = 'LEGENDARY'; },
    s => { s.rotations.yourShop.currentWindow = []; },
    s => { s.generatedAt = new Date(Date.now() + 86400_000).toISOString(); },
  ];
  for (const change of changes) {
    const snapshot = structuredClone(fixtureSnapshot());
    change(snapshot);
    snapshot.snapshotId = snapshotDigest(snapshot);
    assert.throws(() => validateSnapshot(snapshot), /Invalid snapshot/);
  }
  const snapshot = fixtureSnapshot();
  snapshot.snapshotId = '0'.repeat(64);
  assert.throws(() => validateSnapshot(snapshot), /snapshotId/);
  const tables = rows();
  tables.YourShopSale.push({ ...tables.YourShopSale[0], ShopName: 'second-current' });
  assert.throws(() => createSnapshot(tables), /multipleCurrent/);
});

test('never replaces a nonempty catalog with an empty catalog', () => {
  const tables = rows();
  for (const table of ['CatalogItem', 'CatalogSale', 'MythicSale', 'SanctumSale']) tables[table] = [];
  const empty = createSnapshot(tables);
  validateSnapshot(empty);
  assert.throws(() => validateSnapshot(empty, fixtureSnapshot()), /emptyReplacement/);
});

test('config uses safe defaults and rejects invalid values and privileged keys', () => {
  const defaults = readConfig({});
  assert.equal(defaults.refreshIntervalMs, 30 * 60_000);
  assert.equal(defaults.publicRateLimit, 60);
  assert.deepEqual(defaults.trustedProxyIps, []);
  for (const env of [
    { PORT: '0' }, { PORT: '65536' }, { REFRESH_INTERVAL_MINUTES: '-1' },
    { PUBLIC_RATE_LIMIT_PER_MINUTE: 'NaN' }, { TRUSTED_PROXY_IPS: '127.0.0.0/8' },
    { SUPABASE_URL: 'https://user:password@example.invalid' },
    { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_forbidden' },
    { SUPABASE_PUBLISHABLE_KEY: `e30.${Buffer.from('{"role":"service_role"}').toString('base64url')}.test` },
  ]) assert.throws(() => readConfig(env), /Invalid/);
  const anon = `e30.${Buffer.from('{"role":"anon"}').toString('base64url')}.test`;
  assert.equal(readConfig({ SUPABASE_PUBLISHABLE_KEY: anon }).supabasePublishableKey, anon);
});
