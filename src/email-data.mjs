import { UUID } from './validate.mjs';

// Public rendering fields only. Private queue/profile data never enter this cache.
export function emailDataFromSnapshot(store, request) {
  if (!request || !Array.isArray(request.records) || request.records.length > 500 ||
      typeof request.minCheckedAt !== 'string' || !Number.isFinite(Date.parse(request.minCheckedAt))) {
    throw Object.assign(new Error('Invalid email data request.'), { status: 400 });
  }
  for (const row of request.records) {
    if (!row || !UUID.test(row.ItemID ?? '') || !UUID.test(row.SaleID ?? '') ||
        !['Catalog', 'Mythic', 'Sanctum'].includes(row.SaleType) ||
        (row.SaleType === 'Mythic' && !UUID.test(row.OfferID ?? ''))) {
      throw Object.assign(new Error('Invalid email data identity.'), { status: 400 });
    }
  }
  if (!store.current || !store.checkedAt || Date.parse(store.checkedAt) < Date.parse(request.minCheckedAt)) {
    throw Object.assign(new Error('Cache has not confirmed this ingestion cycle.'), { status: 409 });
  }
  const { snapshot, itemById } = store.current;
  const sales = new Map(snapshot.rotations.catalogSales.map(s => [s.saleId, s]));
  const mythic = new Map(snapshot.rotations.mythicShop.map(s => [s.offerId, s]));
  const sanctum = new Map(snapshot.rotations.sanctum.map(s => [s.bannerId, s]));
  return { checkedAt: store.checkedAt, records: request.records.map(row => {
    const item = itemById.get(row.ItemID);
    if (!item) return null;
    const result = { ItemID: row.ItemID, SaleID: row.SaleID, SaleType: row.SaleType,
      CatalogItem: { Name: item.name, ImageURL: item.imageUrl } };
    if (row.SaleType === 'Catalog') {
      const sale = sales.get(row.SaleID);
      if (!sale || sale.item.itemId !== row.ItemID) return null;
      result.CatalogSale = { NormalPrice: sale.regularPrice.amount, SalePrice: sale.salePrice.amount,
        Currency: sale.salePrice.currency, PercentOff: sale.percentOff, SaleEndAt: sale.endsAt };
    } else if (row.SaleType === 'Mythic') {
      const sale = mythic.get(row.OfferID);
      if (!sale || !sale.includedContentIds.includes(row.ItemID)) return null;
      result.MythicSale = { Price: sale.price.amount, Currency: sale.price.currency, SaleEndAt: sale.endsAt };
    } else {
      const sale = sanctum.get(row.SaleID);
      if (!sale || sale.item.itemId !== row.ItemID) return null;
      result.SanctumSale = { Rarity: sale.rarity, ChasePityThreshold: sale.chasePityThreshold, SaleEndAt: sale.endsAt };
    }
    return result;
  }).filter(Boolean) };
}
