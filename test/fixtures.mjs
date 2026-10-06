import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot } from '../src/snapshot.mjs';

export const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

export function rows(now = Date.now()) {
  const start = new Date(now - 86400_000).toISOString();
  const end = new Date(now + 86400_000).toISOString();
  return {
    ItemType: ['Skin', 'Chroma', 'Emote', 'Icon', 'Finisher', 'Ward', 'Title'].map((Type, i) => ({ id: i + 1, Type })),
    Champion: [{ id: 22, Slug: 'Ashe', Name: 'Ashe', ImageURL: 'https://example.invalid/ashe.png' }],
    Universe: [{ id: 7, Name: 'Example Universe' }],
    Skinline: [{ id: 42, Name: 'Example', UniverseID: 7 }],
    CatalogItem: [
      { ItemID: uuid(1), RiotItemID: 1001, ItemType: 1, Name: 'Zeta Skin', ImageURL: '//example.invalid/skin.png', ParentItemID: null, ChampionID: 22, SkinlineID: 42 },
      { ItemID: uuid(2), RiotItemID: 1001, ItemType: 2, Name: 'Alpha Chroma', ImageURL: null, ParentItemID: uuid(1), ChampionID: 22, SkinlineID: 42 },
      { ItemID: uuid(3), RiotItemID: 1002, ItemType: 4, Name: 'Alpha Icon', ImageURL: null, ParentItemID: null, ChampionID: null, SkinlineID: null },
    ],
    CatalogSale: [{ SaleID: uuid(100), RiotItemID: 1001, ItemType: 1, SaleStartAt: start, SaleEndAt: end, NormalPrice: 1350, SalePrice: 810, PercentOff: 40, Currency: 'RP', Limited: false, IsActive: true }],
    MythicSale: [{ OfferID: uuid(200), PrimaryItemID: uuid(1), SaleStartAt: start, SaleEndAt: end, Price: 100, Currency: 'ME', Section: 'FEATURED', IsBundle: true, IncludedItems: [uuid(1), uuid(900)], BundleType: null, IsActive: true }],
    SanctumSale: [{ SaleID: uuid(300), RiotItemID: 1001, ItemType: 1, SaleStartAt: start, SaleEndAt: end, Rarity: 'EXALTED', ChasePityThreshold: 80, BannerImageURL: null, IsActive: true }],
    YourShopSale: [
      { ShopName: 'current', SaleStartAt: start, SaleEndAt: end, IsActive: true, HubEnabled: true },
      ...Array.from({ length: 6 }, (_, i) => ({
        ShopName: `past-${i}`, SaleStartAt: new Date(now - (i + 2) * 86400_000).toISOString(),
        SaleEndAt: start, IsActive: false, HubEnabled: true,
      })),
    ],
  };
}

export function fixtureSnapshot(ageMs = 1000) {
  const now = Date.now() - ageMs;
  return createSnapshot(rows(now), new Date(now).toISOString());
}

export async function testConfig(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rotations-api-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'error', () => {});
  return {
    dataDir, port: 0, supabaseUrl: 'http://127.0.0.1:54321',
    supabasePublishableKey: 'test-publishable-key', refreshSecret: 'test-refresh-secret',
    publicRateLimit: 1000, trustedProxyIps: [], refreshIntervalMs: 30 * 60_000,
  };
}

export function mockSupabase(t, tableRows = rows(), fingerprint) {
  let catalogRevision = 0;
  let catalogHash;
  let publishedItems = new Map();
  const catalogChanges = new Map();
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'http://127.0.0.1:54321', 'Only mocked local Supabase reads are allowed.');
    const table = url.pathname.split('/').at(-1);
    if (table === 'public_api_state') {
      const value = fingerprint ? await fingerprint() : confirmedFingerprints;
      const hashes = typeof value === 'string' ? Object.fromEntries(Object.keys(confirmedFingerprints).map(key => [key, value])) : value;
      if (hashes.catalog !== catalogHash) {
        catalogHash = hashes.catalog;
        catalogRevision++;
        if (typeof tableRows !== 'function') {
          const next = new Map(createSnapshot(tableRows).items.map(item => [item.itemId, item]));
          for (const [item_id, item_data] of next) {
            if (JSON.stringify(item_data) !== JSON.stringify(publishedItems.get(item_id)))
              catalogChanges.set(item_id, { item_id, item_data, changed_revision: catalogRevision });
          }
          for (const item_id of publishedItems.keys()) {
            if (!next.has(item_id)) catalogChanges.set(item_id, { item_id, item_data: null, changed_revision: catalogRevision });
          }
          publishedItems = next;
        }
      }
      return Response.json([{ id: 1, fingerprints: hashes, checked_at: new Date().toISOString(),
        changed_at: new Date().toISOString(), changed_sections: Object.keys(hashes), catalog_revision: catalogRevision }], { headers: { 'content-range': '0-0/1' } });
    }
    if (table === 'get_public_api_catalog_changes') {
      assert.equal(Number(url.searchParams.get('expected_revision')), catalogRevision);
      assert.equal(url.searchParams.get('select'), 'item_id,item_data,changed_revision');
      let changes = [...catalogChanges.values()];
      if (typeof tableRows === 'function') {
        const names = Object.keys(rows());
        const tables = Object.fromEntries(await Promise.all(names.map(async name => [name, await tableRows(name)])));
        changes = createSnapshot(tables).items.map(item_data => ({ item_id: item_data.itemId, item_data, changed_revision: catalogRevision }));
      }
      changes = changes.filter(change => change.changed_revision > Number(url.searchParams.get('after_revision')))
        .sort((a, b) => a.item_id.localeCompare(b.item_id));
      const [start, end] = options.headers.Range.split('-').map(Number);
      const page = changes.slice(start, end + 1);
      return Response.json(page.map(change => ({ ...change, item_data: jsonbOrder(change.item_data) })), { headers: {
        'content-range': page.length ? `${start}-${start + page.length - 1}/${changes.length}` : `*/${changes.length}`,
      } });
    }
    if (table === 'get_public_api_fingerprint') {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.apikey, 'test-publishable-key');
      const value = fingerprint ? await fingerprint()
        : 'a'.repeat(32);
      return Response.json(typeof value === 'string' ? Object.fromEntries(Object.keys(confirmedFingerprints).map(key => [key, value])) : value);
    }
    assert.ok(url.searchParams.get('order'));
    assert.notEqual(url.searchParams.get('select'), '*');
    assert.equal(options.headers.apikey, 'test-publishable-key');
    assert.equal(options.headers.Authorization, 'Bearer test-publishable-key');
    if (['CatalogSale', 'MythicSale', 'SanctumSale'].includes(table)) assert.equal(url.searchParams.get('IsActive'), 'eq.true');
    const all = typeof tableRows === 'function' ? await tableRows(table) : tableRows[table];
    assert.ok(Array.isArray(all), `Unexpected table ${table}.`);
    const [start, end] = options.headers.Range.split('-').map(Number);
    const page = all.slice(start, end + 1);
    return Response.json(page, {
      headers: { 'content-range': page.length ? `${start}-${start + page.length - 1}/${all.length}` : `*/${all.length}` },
    });
  });
}

function jsonbOrder(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(jsonbOrder);
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
    .map(([key, child]) => [key, jsonbOrder(child)]));
}

export const confirmedFingerprints = Object.fromEntries(['catalog', 'sales', 'mythic', 'sanctum', 'yourShop'].map(key => [key, 'a'.repeat(32)]));
export function fingerprintsFor(tableRows) {
  const digest = names => createHash('md5').update(JSON.stringify(names.map(name => tableRows[name]))).digest('hex');
  return { catalog: digest(['CatalogItem', 'ItemType', 'Champion', 'Skinline', 'Universe']),
    sales: digest(['CatalogSale']), mythic: digest(['MythicSale']), sanctum: digest(['SanctumSale']), yourShop: digest(['YourShopSale']) };
}

export function request(server, path, { method = 'GET', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        resolve({ status: res.statusCode, headers: res.headers, text,
          json: text && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (chunks) for (const chunk of chunks) req.write(chunk);
    req.end(body);
  });
}

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
