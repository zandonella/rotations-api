import test from 'node:test';import assert from 'node:assert/strict';
import { emailDataFromSnapshot } from '../src/email-data.mjs';
import { createApiServer } from '../src/server.mjs';
import { fixtureSnapshot, request, testConfig, uuid } from './fixtures.mjs';
function store(){const snapshot=fixtureSnapshot();return {checkedAt:new Date().toISOString(),current:{snapshot,itemById:new Map(snapshot.items.map(i=>[i.itemId,i]))}};}
const records=[{ItemID:uuid(1),SaleID:uuid(100),SaleType:'Catalog'},{ItemID:uuid(1),SaleID:uuid(999),OfferID:uuid(200),SaleType:'Mythic'},{ItemID:uuid(1),SaleID:uuid(300),SaleType:'Sanctum'}];
test('cache supplies only requested public render fields and handles missing identities',()=>{
 const s=store();const result=emailDataFromSnapshot(s,{minCheckedAt:s.checkedAt,records:[...records,{...records[0],SaleID:uuid(404)}]});
 assert.equal(result.records.length,3);assert.equal(result.records[0].CatalogSale.SalePrice,810);assert.equal(result.records[1].MythicSale.Price,100);assert.equal(result.records[2].SanctumSale.ChasePityThreshold,80);
 assert.deepEqual(Object.keys(result.records[0].CatalogItem),['Name','ImageURL']);
 assert.throws(()=>emailDataFromSnapshot(s,{minCheckedAt:new Date(Date.now()+10000).toISOString(),records}),{status:409});
 for(const body of [{records,minCheckedAt:'bad'},{records:Array(501).fill(records[0]),minCheckedAt:s.checkedAt},{records:[{...records[0],ItemID:'bad'}],minCheckedAt:s.checkedAt}])assert.throws(()=>emailDataFromSnapshot(s,body),{status:400});
});
test('internal email endpoint authenticates, stays out of public caching, and reads no upstream data',async t=>{
 const s=store();const config=await testConfig(t);const server=createApiServer(config,s);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 t.mock.method(globalThis,'fetch',()=>assert.fail('Cache requests must not query Supabase'));
 const body=JSON.stringify({minCheckedAt:s.checkedAt,records});
 assert.equal((await request(server,'/internal/email-data',{method:'POST',body})).status,401);
 const response=await request(server,'/internal/email-data',{method:'POST',headers:{Authorization:`Bearer ${config.refreshSecret}`},body});
 assert.equal(response.status,200);assert.equal(response.json.records.length,3);assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['access-control-allow-origin'],undefined);
 assert.equal((await request(server,'/internal/email-data',{method:'POST',headers:{Authorization:`Bearer ${config.refreshSecret}`},body:'invalid'})).status,400);
});
