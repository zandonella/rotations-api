import { createHash } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SECTIONS = ['FEATURED', 'BIWEEKLY', 'WEEKLY', 'DAILY'];
export const RARITIES = ['EXALTED', 'MYTHIC_VARIANT'];
const TYPES = ['Skin', 'Chroma', 'Emote', 'Icon', 'Finisher', 'Ward', 'Title'];

export function requireValid(condition, path) {
  if (!condition) throw Object.assign(new Error(`Invalid snapshot at ${path}.`), { code: 'invalid_snapshot' });
}

export function normalizeTimestamp(value) {
  requireValid(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'timestamp');
  const date = new Date(value);
  requireValid(Number.isFinite(date.getTime()), 'timestamp');
  // Date.parse accepts impossible dates such as February 30. Reject those too.
  const day = value.slice(0, 10);
  requireValid(new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day, 'timestamp');
  return date.toISOString();
}

export function snapshotDigest(snapshot) {
  const { snapshotId, ...candidate } = snapshot;
  return createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
}

function shape(value, keys, path) {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value), path);
  requireValid(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), path);
}
function text(value, path) { requireValid(typeof value === 'string' && value.trim().length > 0, path); }
function integer(value, path) { requireValid(Number.isSafeInteger(value), path); }
function uuid(value, path) { requireValid(typeof value === 'string' && UUID.test(value) && value === value.toLowerCase(), path); }
function nullableText(value, path) { if (value !== null) requireValid(typeof value === 'string', path); }
function timestamp(value, path) { requireValid(normalizeTimestamp(value) === value, path); }
function windowDates(value, path) {
  timestamp(value.startsAt, `${path}.startsAt`);
  timestamp(value.endsAt, `${path}.endsAt`);
  requireValid(value.endsAt > value.startsAt, `${path}.dates`);
}
function unique(values, key, path) {
  const seen = new Set();
  for (const value of values) {
    requireValid(!seen.has(value[key]), `${path}.duplicate`);
    seen.add(value[key]);
  }
}
function price(value, path) {
  shape(value, ['amount', 'currency'], path);
  integer(value.amount, `${path}.amount`);
  text(value.currency, `${path}.currency`);
}

function validateItem(item) {
  shape(item, ['itemId', 'riotItemId', 'type', 'name', 'imageUrl', 'parentItemId', 'champion', 'skinline'], 'item');
  uuid(item.itemId, 'item.itemId');
  integer(item.riotItemId, 'item.riotItemId');
  text(item.name, 'item.name');
  nullableText(item.imageUrl, 'item.imageUrl');
  if (item.parentItemId !== null) uuid(item.parentItemId, 'item.parentItemId');
  shape(item.type, ['id', 'name'], 'item.type');
  integer(item.type.id, 'item.type.id');
  requireValid(item.type.id >= 1 && item.type.id <= 7 && item.type.name === TYPES[item.type.id - 1], 'item.type');
  if (item.champion !== null) {
    shape(item.champion, ['id', 'slug', 'name', 'imageUrl'], 'item.champion');
    integer(item.champion.id, 'item.champion.id');
    for (const key of ['slug', 'name', 'imageUrl']) text(item.champion[key], `item.champion.${key}`);
  }
  if (item.skinline !== null) {
    shape(item.skinline, ['id', 'name', 'universe'], 'item.skinline');
    integer(item.skinline.id, 'item.skinline.id');
    nullableText(item.skinline.name, 'item.skinline.name');
    if (item.skinline.universe !== null) {
      shape(item.skinline.universe, ['id', 'name'], 'item.skinline.universe');
      integer(item.skinline.universe.id, 'item.skinline.universe.id');
      text(item.skinline.universe.name, 'item.skinline.universe.name');
    }
  }
}

export function compareItems(a, b) {
  return compareText(a.name, b.name) || compareText(a.itemId, b.itemId);
}
export function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export function validateSnapshot(snapshot, previous = null) {
  shape(snapshot, ['schemaVersion', 'snapshotId', 'generatedAt', 'rotations', 'items'], 'snapshot');
  requireValid(snapshot.schemaVersion === 1, 'schemaVersion');
  timestamp(snapshot.generatedAt, 'generatedAt');
  requireValid(Date.parse(snapshot.generatedAt) <= Date.now(), 'generatedAt.future');
  requireValid(Array.isArray(snapshot.items), 'items');
  requireValid(!previous?.items.length || snapshot.items.length > 0, 'items.emptyReplacement');
  const itemById = new Map();
  const inventory = new Set();
  for (const item of snapshot.items) {
    validateItem(item);
    requireValid(!itemById.has(item.itemId), 'items.duplicate');
    const inventoryKey = `${item.type.id}:${item.riotItemId}`;
    requireValid(!inventory.has(inventoryKey), 'items.inventoryDuplicate');
    itemById.set(item.itemId, item);
    inventory.add(inventoryKey);
  }
  for (let i = 0; i < snapshot.items.length; i++) {
    const item = snapshot.items[i];
    requireValid(item.parentItemId === null || itemById.has(item.parentItemId), 'item.parentItemId.unresolved');
    if (i) requireValid(compareItems(snapshot.items[i - 1], item) <= 0, 'items.order');
  }
  function embedded(item, path) {
    const catalogItem = itemById.get(item?.itemId);
    requireValid(catalogItem && (catalogItem === item || JSON.stringify(catalogItem) === JSON.stringify(item)), path);
  }

  const rotations = snapshot.rotations;
  shape(rotations, ['meta', 'catalogSales', 'mythicShop', 'sanctum', 'yourShop'], 'rotations');
  shape(rotations.meta, ['apiVersion', 'generatedAt'], 'meta');
  requireValid(rotations.meta.apiVersion === 'v1' && rotations.meta.generatedAt === snapshot.generatedAt, 'meta');
  for (const key of ['catalogSales', 'mythicShop', 'sanctum']) requireValid(Array.isArray(rotations[key]), key);
  for (const sale of rotations.catalogSales) {
    shape(sale, ['saleId', 'startsAt', 'endsAt', 'regularPrice', 'salePrice', 'percentOff', 'limited', 'item'], 'catalogSale');
    uuid(sale.saleId, 'catalogSale.saleId');
    windowDates(sale, 'catalogSale');
    price(sale.regularPrice, 'catalogSale.regularPrice');
    price(sale.salePrice, 'catalogSale.salePrice');
    integer(sale.percentOff, 'catalogSale.percentOff');
    requireValid(sale.percentOff >= 0 && sale.percentOff <= 100, 'catalogSale.percentOff');
    requireValid(sale.regularPrice.currency === sale.salePrice.currency, 'catalogSale.currency');
    requireValid(typeof sale.limited === 'boolean', 'catalogSale.limited');
    embedded(sale.item, 'catalogSale.item');
  }
  unique(rotations.catalogSales, 'saleId', 'catalogSales');
  for (const offer of rotations.mythicShop) {
    shape(offer, ['offerId', 'startsAt', 'endsAt', 'section', 'price', 'isBundle', 'bundleType', 'primaryItem', 'includedContentIds'], 'mythicOffer');
    uuid(offer.offerId, 'mythicOffer.offerId');
    windowDates(offer, 'mythicOffer');
    requireValid(SECTIONS.includes(offer.section), 'mythicOffer.section');
    price(offer.price, 'mythicOffer.price');
    requireValid(typeof offer.isBundle === 'boolean', 'mythicOffer.isBundle');
    nullableText(offer.bundleType, 'mythicOffer.bundleType');
    embedded(offer.primaryItem, 'mythicOffer.primaryItem');
    requireValid(Array.isArray(offer.includedContentIds), 'mythicOffer.includedContentIds');
    for (const id of offer.includedContentIds) uuid(id, 'mythicOffer.includedContentIds');
  }
  unique(rotations.mythicShop, 'offerId', 'mythicShop');
  for (const banner of rotations.sanctum) {
    shape(banner, ['bannerId', 'startsAt', 'endsAt', 'rarity', 'chasePityThreshold', 'bannerImageUrl', 'item'], 'sanctumBanner');
    uuid(banner.bannerId, 'sanctumBanner.bannerId');
    windowDates(banner, 'sanctumBanner');
    requireValid(RARITIES.includes(banner.rarity), 'sanctumBanner.rarity');
    integer(banner.chasePityThreshold, 'sanctumBanner.chasePityThreshold');
    nullableText(banner.bannerImageUrl, 'sanctumBanner.bannerImageUrl');
    embedded(banner.item, 'sanctumBanner.item');
  }
  unique(rotations.sanctum, 'bannerId', 'sanctum');
  shape(rotations.yourShop, ['currentWindow', 'recentWindows'], 'yourShop');
  const { currentWindow, recentWindows } = rotations.yourShop;
  requireValid(Array.isArray(recentWindows) && recentWindows.length <= 4, 'yourShop.recentWindows');
  const windows = currentWindow === null ? recentWindows : [currentWindow, ...recentWindows];
  for (const window of windows) {
    shape(window, ['shopName', 'startsAt', 'endsAt'], 'yourShop.window');
    text(window.shopName, 'yourShop.shopName');
    windowDates(window, 'yourShop.window');
  }
  unique(windows, 'shopName', 'yourShop');
  if (currentWindow) requireValid(currentWindow.startsAt <= snapshot.generatedAt && snapshot.generatedAt < currentWindow.endsAt, 'yourShop.currentWindow');
  requireValid(typeof snapshot.snapshotId === 'string' && /^[a-f0-9]{64}$/.test(snapshot.snapshotId) && snapshot.snapshotId === snapshotDigest(snapshot), 'snapshotId');
  return itemById;
}
