import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTable } from '../src/supabase.mjs';
import { persistSnapshot, readSnapshot } from '../src/persistence.mjs';
import { clientIp, createRateLimiter } from '../src/rate-limit.mjs';

const config = { supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'test-publishable-key' };

test('reads the entire 16,001 row catalog in deterministic 500 row ranges', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.pathname, '/rest/v1/CatalogItem');
    assert.equal(url.searchParams.get('select'), 'ItemID,Name');
    assert.equal(url.searchParams.get('order'), 'ItemID.asc');
    assert.equal(options.headers.apikey, config.supabasePublishableKey);
    assert.equal(options.headers.Prefer, 'count=exact');
    assert.equal(options.redirect, 'error');
    const start = calls++ * 500;
    assert.equal(options.headers.Range, `${start}-${start + 499}`);
    const end = Math.min(start + 499, 16000);
    return Response.json(Array.from({ length: end - start + 1 }, (_, i) => ({ ItemID: start + i })), {
      status: 206, headers: { 'content-range': `${start}-${end}/16001` },
    });
  });
  const rows = await readTable(config, 'CatalogItem', 'ItemID,Name', 'ItemID.asc');
  assert.equal(calls, 33);
  assert.equal(rows.length, 16001);
  assert.deepEqual(rows.at(-1), { ItemID: 16000 });
});

test('continues after a short page instead of silently truncating the catalog', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const start = calls++ * 100;
    assert.equal(options.headers.Range, `${start}-${start + 499}`);
    return Response.json(Array.from({ length: 100 }, (_, i) => ({ ItemID: start + i })), {
      headers: { 'content-range': `${start}-${start + 99}/200` },
    });
  });
  assert.equal((await readTable(config, 'CatalogItem', 'ItemID', 'ItemID.asc')).length, 200);
  assert.equal(calls, 2);
});

test('accepts an empty rotation table', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([], { headers: { 'content-range': '*/0' } }));
  assert.deepEqual(await readTable(config, 'MythicSale', 'SaleID', 'SaleID.asc'), []);
});

test('rejects malformed pages and never reads private tables', async t => {
  for (const [body, range] of [[{}, '0-0/1'], [[], '*/2'], [[{}], '1-1/2'], [[{}], '0-0/*']]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(body, { headers: { 'content-range': range } }));
    await assert.rejects(readTable(config, 'CatalogItem', 'ItemID', 'ItemID.asc'));
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', () => assert.fail('Private data must never be requested.'));
  for (const table of ['Profile', 'WishlistItem', 'ingestion_heartbeat']) {
    await assert.rejects(readTable(config, table, '*', 'id.asc'), /not a public/);
  }
});

test('rejects a changing count and upstream errors without returning raw responses', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json([{}], {
    headers: { 'content-range': calls++ === 0 ? '0-0/2' : '1-1/3' },
  }));
  await assert.rejects(readTable(config, 'CatalogItem', 'ItemID', 'ItemID.asc'), /Row count changed/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('sensitive upstream response', { status: 401 }));
  await assert.rejects(readTable(config, 'CatalogItem', 'ItemID', 'ItemID.asc'), error => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});

test('persists complete JSON, replaces it, and leaves no temporary files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rotations-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await persistSnapshot(directory, { generatedAt: 'first', items: [] });
  await persistSnapshot(directory, { generatedAt: 'second', items: [1] });
  assert.deepEqual(await readSnapshot(directory), { generatedAt: 'second', items: [1] });
  assert.deepEqual(await readdir(directory), ['snapshot-v1.json']);
});

test('a serialization failure preserves the prior file and a rename failure cleans up', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rotations-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await persistSnapshot(directory, { items: ['known-good'] });
  await assert.rejects(persistSnapshot(directory, { unsupported: 1n }));
  assert.deepEqual(await readSnapshot(directory), { items: ['known-good'] });
  const blocked = join(directory, 'blocked');
  await mkdir(join(blocked, 'snapshot-v1.json'), { recursive: true });
  await assert.rejects(persistSnapshot(blocked, { items: [] }));
  assert.deepEqual(await readdir(blocked), ['snapshot-v1.json']);
});

test('corrupt persisted JSON is rejected', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rotations-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'snapshot-v1.json'), '{broken');
  await assert.rejects(readSnapshot(directory), SyntaxError);
  assert.equal(await readFile(join(directory, 'snapshot-v1.json'), 'utf8'), '{broken');
});

test('public and internal fixed minute buckets are separate and reset at the boundary', t => {
  const publicLimit = createRateLimiter(60);
  const internalLimit = createRateLimiter(2);
  t.after(() => { publicLimit.close(); internalLimit.close(); });
  for (let i = 0; i < 60; i++) assert.equal(publicLimit.check('client', 1000).allowed, true);
  assert.deepEqual(publicLimit.check('client', 1000), { allowed: false, retryAfter: 59 });
  assert.equal(publicLimit.check('other', 1000).allowed, true);
  assert.equal(internalLimit.check('client', 1000).allowed, true);
  assert.equal(internalLimit.check('client', 1000).allowed, true);
  assert.equal(internalLimit.check('client', 1000).allowed, false);
  assert.equal(publicLimit.check('client', 60_000).allowed, true);
  assert.equal(internalLimit.check('client', 60_000).allowed, true);
});

test('trusts one valid X-Real-IP only from an exact trusted TCP peer', () => {
  const request = {
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'x-real-ip': '192.0.2.7', 'x-forwarded-for': '203.0.113.8' },
  };
  assert.equal(clientIp(request, []), '::ffff:127.0.0.1');
  assert.equal(clientIp(request, ['127.0.0.1']), '::ffff:127.0.0.1');
  assert.equal(clientIp(request, ['::ffff:127.0.0.1']), '192.0.2.7');
  for (const invalid of ['192.0.2.7, 192.0.2.8', ['192.0.2.7'], 'spoofed', undefined]) {
    request.headers['x-real-ip'] = invalid;
    assert.equal(clientIp(request, ['::ffff:127.0.0.1']), '::ffff:127.0.0.1');
  }
});
