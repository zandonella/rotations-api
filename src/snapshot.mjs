import { readTable } from './supabase.mjs';
import { compareItems, compareText, normalizeTimestamp, RARITIES, requireValid, SECTIONS, snapshotDigest, UUID } from './validate.mjs';

const QUERIES = [
  ['CatalogItem', 'ItemID,ItemType,RiotItemID,Name,ImageURL,ChampionID,SkinlineID,ParentItemID', 'ItemID.asc'],
  ['ItemType', 'id,Type', 'id.asc'],
  ['Champion', 'id,Slug,Name,ImageURL', 'id.asc'],
  ['Skinline', 'id,Name,UniverseID', 'id.asc'],
  ['Universe', 'id,Name', 'id.asc'],
  ['CatalogSale', 'SaleID,RiotItemID,ItemType,SaleStartAt,SaleEndAt,NormalPrice,SalePrice,PercentOff,Currency,Limited,IsActive', 'SaleEndAt.asc,SaleID.asc', { IsActive: 'eq.true' }],
  ['MythicSale', 'OfferID,PrimaryItemID,SaleStartAt,SaleEndAt,Price,Currency,Section,IsBundle,IncludedItems,BundleType,IsActive', 'Section.asc,SaleEndAt.asc,OfferID.asc', { IsActive: 'eq.true' }],
  ['SanctumSale', 'SaleID,RiotItemID,ItemType,SaleStartAt,SaleEndAt,Rarity,ChasePityThreshold,BannerImageURL,IsActive', 'SaleEndAt.asc,SaleID.asc', { IsActive: 'eq.true' }],
  ['YourShopSale', 'ShopName,SaleStartAt,SaleEndAt,HubEnabled,IsActive', 'SaleStartAt.desc,ShopName.asc'],
];

export async function buildSnapshot(config) {
  const results = await Promise.allSettled(QUERIES.map(query => readTable(config, ...query)));
  const tables = {};
  const rowCounts = {};
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      tables[QUERIES[i][0]] = result.value;
      rowCounts[QUERIES[i][0]] = result.value.length;
    }
  }
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw Object.assign(failure.reason, { rowCounts });
  try {
    return { snapshot: createSnapshot(tables), rowCounts };
  } catch (error) {
    throw Object.assign(error, { rowCounts });
  }
}

function id(value) {
  requireValid(typeof value === 'string' && UUID.test(value), 'source.uuid');
  return value.toLowerCase();
}

function lookup(rows, name) {
  const map = new Map();
  for (const row of rows) {
    requireValid(Number.isSafeInteger(row.id) && !map.has(row.id), `${name}.id`);
    map.set(row.id, row);
  }
  return map;
}

function resolve(map, key, path) {
  requireValid(map.has(key), `${path}.unresolved`);
  return map.get(key);
}

function dates(row) {
  const startsAt = normalizeTimestamp(row.SaleStartAt);
  const endsAt = normalizeTimestamp(row.SaleEndAt);
  requireValid(endsAt > startsAt, 'source.window');
  return { startsAt, endsAt };
}

export function createSnapshot(tables, generatedAt = new Date().toISOString()) {
  for (const [table] of QUERIES) requireValid(Array.isArray(tables[table]), `source.${table}`);
  const types = lookup(tables.ItemType, 'ItemType');
  const champions = lookup(tables.Champion, 'Champion');
  const skinlines = lookup(tables.Skinline, 'Skinline');
  const universes = lookup(tables.Universe, 'Universe');
  const itemById = new Map();
  const itemByInventory = new Map();
  const items = tables.CatalogItem.map(row => {
    const type = resolve(types, row.ItemType, 'item.type');
    const champion = row.ChampionID === null ? null : resolve(champions, row.ChampionID, 'item.champion');
    const skinline = row.SkinlineID === null ? null : resolve(skinlines, row.SkinlineID, 'item.skinline');
    // Ingestion uses UniverseID 0 as the sentinel for skinlines without a universe.
    const universe = skinline === null || skinline.UniverseID === null || skinline.UniverseID === 0
      ? null
      : resolve(universes, skinline.UniverseID, 'item.universe');
    const item = {
      itemId: id(row.ItemID), riotItemId: row.RiotItemID,
      type: { id: type.id, name: type.Type }, name: row.Name, imageUrl: row.ImageURL,
      parentItemId: row.ParentItemID === null ? null : id(row.ParentItemID),
      champion: champion === null ? null : { id: champion.id, slug: champion.Slug, name: champion.Name, imageUrl: champion.ImageURL },
      skinline: skinline === null ? null : {
        id: skinline.id, name: skinline.Name,
        universe: universe === null ? null : { id: universe.id, name: universe.Name },
      },
    };
    requireValid(!itemById.has(item.itemId), 'source.CatalogItem.duplicate');
    const inventoryKey = `${row.ItemType}:${row.RiotItemID}`;
    requireValid(!itemByInventory.has(inventoryKey), 'source.CatalogItem.inventoryDuplicate');
    itemById.set(item.itemId, item);
    itemByInventory.set(inventoryKey, item);
    return item;
  }).sort(compareItems);

  function active(row) { requireValid(row.IsActive === true, 'source.sale.IsActive'); }
  function inventoryItem(row) {
    requireValid(Number.isSafeInteger(row.ItemType) && Number.isSafeInteger(row.RiotItemID), 'source.sale.inventoryId');
    return resolve(itemByInventory, `${row.ItemType}:${row.RiotItemID}`, 'sale.item');
  }
  const catalogSales = tables.CatalogSale.map(row => {
    active(row);
    return {
      saleId: id(row.SaleID), ...dates(row),
      regularPrice: { amount: row.NormalPrice, currency: row.Currency },
      salePrice: { amount: row.SalePrice, currency: row.Currency },
      percentOff: row.PercentOff, limited: row.Limited, item: inventoryItem(row),
    };
  }).sort((a, b) => compareText(a.endsAt, b.endsAt) || compareText(a.saleId, b.saleId));
  const mythicShop = tables.MythicSale.map(row => {
    active(row);
    requireValid(Array.isArray(row.IncludedItems), 'source.MythicSale.IncludedItems');
    return {
      offerId: id(row.OfferID), ...dates(row), section: row.Section,
      price: { amount: row.Price, currency: row.Currency },
      isBundle: row.IsBundle, bundleType: row.BundleType,
      primaryItem: resolve(itemById, id(row.PrimaryItemID), 'mythicOffer.primaryItem'),
      // These are fulfillment content UUIDs, including possible non-catalog content.
      includedContentIds: row.IncludedItems.map(id),
    };
  }).sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || compareText(a.endsAt, b.endsAt) || compareText(a.offerId, b.offerId));
  const sanctum = tables.SanctumSale.map(row => {
    active(row);
    return {
      bannerId: id(row.SaleID), ...dates(row), rarity: row.Rarity,
      chasePityThreshold: row.ChasePityThreshold, bannerImageUrl: row.BannerImageURL,
      item: inventoryItem(row),
    };
  }).sort((a, b) => RARITIES.indexOf(a.rarity) - RARITIES.indexOf(b.rarity) || compareText(a.endsAt, b.endsAt) || compareText(a.bannerId, b.bannerId));

  const shopNames = new Set();
  const windows = tables.YourShopSale.map(row => {
    requireValid(typeof row.ShopName === 'string' && row.ShopName.trim() && !shopNames.has(row.ShopName), 'source.YourShopSale.ShopName');
    requireValid(typeof row.IsActive === 'boolean' && typeof row.HubEnabled === 'boolean', 'source.YourShopSale.flags');
    shopNames.add(row.ShopName);
    const window = { shopName: row.ShopName, ...dates(row) };
    return { window, current: row.IsActive && row.HubEnabled && window.startsAt <= generatedAt && generatedAt < window.endsAt };
  }).sort((a, b) => compareText(b.window.startsAt, a.window.startsAt) || compareText(a.window.shopName, b.window.shopName));
  const current = windows.filter(entry => entry.current);
  requireValid(current.length <= 1, 'source.YourShopSale.multipleCurrent');
  const yourShop = {
    currentWindow: current[0]?.window ?? null,
    recentWindows: windows.filter(entry => !entry.current).slice(0, 4).map(entry => entry.window),
  };
  const candidate = {
    schemaVersion: 1, generatedAt,
    rotations: { meta: { apiVersion: 'v1', generatedAt }, catalogSales, mythicShop, sanctum, yourShop },
    items,
  };
  return { ...candidate, snapshotId: snapshotDigest(candidate) };
}

export function freezeSnapshot(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
