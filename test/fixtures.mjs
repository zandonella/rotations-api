import assert from 'node:assert/strict';
import http from 'node:http';
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

export function mockSupabase(t, tableRows = rows()) {
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'http://127.0.0.1:54321', 'Only mocked local Supabase reads are allowed.');
    const table = url.pathname.split('/').at(-1);
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
