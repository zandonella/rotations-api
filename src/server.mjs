import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readConfig } from './config.mjs';
import { createSnapshotStore } from './refresh.mjs';
import { clientIp, createRateLimiter } from './rate-limit.mjs';
import { RARITIES, SECTIONS, UUID } from './validate.mjs';
import { log, logFailure } from './log.mjs';

const CACHE_CONTROL = 'public, max-age=300, s-maxage=300, stale-while-revalidate=60';
const OPENAPI_DOCUMENT = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const DOCS_HTML = readFileSync(new URL('../public/docs/index.html', import.meta.url));
const DOCS_ASSETS = new Map([
  ['swagger-ui.css', 'text/css; charset=utf-8'],
  ['swagger-ui-bundle.js', 'text/javascript; charset=utf-8'],
  ['docs.css', 'text/css; charset=utf-8'],
  ['docs-init.js', 'text/javascript; charset=utf-8'],
].map(([name, contentType]) => {
  const body = readFileSync(new URL(`../public/docs/${name}`, import.meta.url));
  const etag = `"docs-${createHash('sha256').update(body).digest('hex')}"`;
  return [`/docs/${name}`, { body, contentType, etag }];
}));
const ROTATION_ROUTES = new Map([
  ['/v1/rotations/your-shop', 'yourShop'],
]);
const SALE_SECTIONS = new Set(['weekly', 'limited', 'chromas', 'blue-essence', 'other-items']);
const ERRORS = {
  400: ['invalid_request', 'The request parameters are invalid.'],
  401: ['unauthorized', 'The refresh request is not authorized.'],
  404: ['not_found', 'The requested resource was not found.'],
  429: ['rate_limited', 'Too many requests. Please try again later.'],
  500: ['internal_error', 'The API could not complete the request.'],
  503: ['snapshot_unavailable', 'The API is temporarily unavailable. Please try again shortly.'],
};

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
function errorResponse(response, status) {
  response.setHeader('Cache-Control', 'no-store');
  const [code, message] = ERRORS[status];
  json(response, status, { error: { code, message } });
}

function matchesEtag(request, etag) {
  return request.headers['if-none-match']?.split(',').some(value => {
    const tag = value.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}

export function makeEtag(snapshotId, variant) {
  const suffix = createHash('sha256').update(variant).digest('hex');
  return `"v1-${snapshotId}-${suffix}"`;
}

function cachedResponse(request, response, snapshotId, variant, body) {
  const etag = makeEtag(snapshotId, variant);
  response.setHeader('Cache-Control', CACHE_CONTROL);
  response.setHeader('ETag', etag);
  if (matchesEtag(request, etag)) {
    response.writeHead(304);
    response.end();
  } else {
    json(response, 200, body);
  }
}

function docsAssetResponse(request, response, asset) {
  response.setHeader('Cache-Control', 'public, max-age=86400');
  response.setHeader('ETag', asset.etag);
  if (matchesEtag(request, asset.etag)) {
    response.writeHead(304);
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': asset.contentType, 'Content-Length': asset.body.length });
  response.end(asset.body);
}

function validKeys(params, allowed) {
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) return false;
  }
  return true;
}

function number(params, key, fallback, minimum) {
  const raw = params.get(key);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum) return NaN;
  return Number(raw);
}

function pageQuery(params) {
  return { page: number(params, 'page', 1, 1), pageSize: Math.min(number(params, 'pageSize', 100, 1), 200) };
}

function parseItemsQuery(params) {
  if (!validKeys(params, ['page', 'pageSize', 'typeId', 'championId', 'skinlineId'])) return null;
  const query = {
    ...pageQuery(params),
    typeId: number(params, 'typeId', null, 0), championId: number(params, 'championId', null, 0),
    skinlineId: number(params, 'skinlineId', null, 0),
  };
  return Object.values(query).some(Number.isNaN) ? null : query;
}

function parseRotationQuery(params, kind) {
  const filters = kind === 'sales' ? ['currency', 'typeId', 'championId', 'skinlineId', 'limited']
    : kind === 'mythic' ? ['section'] : ['rarity'];
  if (!validKeys(params, ['page', 'pageSize', ...filters])) return null;
  const query = { ...pageQuery(params) };
  if (kind === 'sales') {
    const currency = params.get('currency');
    const limited = params.get('limited');
    if (currency !== null && !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(currency)) return null;
    if (limited !== null && limited !== 'true' && limited !== 'false') return null;
    Object.assign(query, {
      currency: currency?.toUpperCase() ?? null,
      typeId: number(params, 'typeId', null, 0), championId: number(params, 'championId', null, 0),
      skinlineId: number(params, 'skinlineId', null, 0), limited: limited === null ? null : limited === 'true',
    });
  } else if (kind === 'mythic') {
    const section = params.get('section');
    if (section !== null && !SECTIONS.includes(section.toUpperCase())) return null;
    query.section = section?.toUpperCase() ?? null;
  } else {
    const rarity = params.get('rarity');
    if (rarity !== null && !RARITIES.includes(rarity.toUpperCase())) return null;
    query.rarity = rarity?.toUpperCase() ?? null;
  }
  return Object.values(query).some(Number.isNaN) ? null : query;
}

function saleInSection(sale, section) {
  if (section === null) return true;
  if (section === 'blue-essence') return sale.salePrice.currency === 'IP';
  if (sale.salePrice.currency === 'IP') return false;
  if (section === 'weekly') return sale.item.type.id === 1 && !sale.limited;
  if (section === 'limited') return sale.item.type.id === 1 && sale.limited;
  if (section === 'chromas') return sale.item.type.id === 2;
  return sale.item.type.id > 2;
}

function paginatedRotations(snapshot, field, query, matches) {
  const rotations = snapshot.rotations[field].filter(matches);
  const totalPages = Math.ceil(rotations.length / query.pageSize);
  const start = (query.page - 1) * query.pageSize;
  return {
    meta: snapshot.rotations.meta, page: query.page, pageSize: query.pageSize,
    total: rotations.length, totalPages,
    [field]: query.page > totalPages ? [] : rotations.slice(start, start + query.pageSize),
  };
}

function authorized(request, secret) {
  if (!secret) return false;
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
  const supplied = createHash('sha256').update(request.headers.authorization || '').digest();
  return timingSafeEqual(expected, supplied);
}

async function hasEmptyBody(request) {
  if (request.headers['content-length'] && request.headers['content-length'] !== '0') return false;
  if (request.readableEnded) return true;
  return new Promise(resolve => {
    request.once('data', () => resolve(false));
    request.once('end', () => resolve(true));
    request.once('error', () => resolve(false));
  });
}

export function createApiServer(config, store) {
  const publicLimiter = createRateLimiter(config.publicRateLimit);
  const internalLimiter = createRateLimiter(2);
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 }, (request, response) => {
    handle(request, response).catch(error => {
      logFailure('unexpected_server_failure', error);
      if (!response.headersSent) errorResponse(response, 500);
      else response.destroy();
    });
  });
  server.keepAliveTimeout = 5000;
  server.on('close', () => { publicLimiter.close(); internalLimiter.close(); });

  function limited(limiter, request, response) {
    const result = limiter.check(clientIp(request, config.trustedProxyIps));
    if (result.allowed) return false;
    response.setHeader('Retry-After', result.retryAfter);
    errorResponse(response, 429);
    return true;
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(request.url, 'http://api.local');
    const path = url.pathname;
    const isPublic = path.startsWith('/v1/') || path === '/openapi.json' || path === '/docs' || path.startsWith('/docs/');
    if (isPublic) {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Expose-Headers', 'ETag');
      if (limited(publicLimiter, request, response)) return;
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'If-None-Match');
        response.writeHead(204);
        response.end();
        return;
      }
    }

    if (request.method === 'GET' && path === '/health') {
      const snapshot = store.current?.snapshot;
      const ageMs = snapshot ? Math.max(0, Date.now() - Date.parse(snapshot.generatedAt)) : null;
      const ok = ageMs !== null && ageMs <= 90 * 60_000;
      json(response, ok ? 200 : 503, {
        ok, apiVersion: 'v1', snapshot: {
          loaded: Boolean(snapshot), generatedAt: snapshot?.generatedAt ?? null,
          ageSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
        },
      });
      return;
    }

    if (request.method === 'GET' && path === '/openapi.json') {
      if (url.search) return errorResponse(response, 400);
      return json(response, 200, OPENAPI_DOCUMENT);
    }

    if (request.method === 'GET' && (path === '/docs' || path === '/docs/')) {
      if (url.search) return errorResponse(response, 400);
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      response.setHeader('X-Frame-Options', 'DENY');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': DOCS_HTML.length });
      response.end(DOCS_HTML);
      return;
    }

    if (request.method === 'GET' && DOCS_ASSETS.has(path)) {
      if (url.search) return errorResponse(response, 400);
      return docsAssetResponse(request, response, DOCS_ASSETS.get(path));
    }

    if (request.method === 'POST' && path === '/internal/refresh') {
      if (!authorized(request, config.refreshSecret)) {
        response.setHeader('Connection', 'close');
        errorResponse(response, 401);
        return;
      }
      if (url.search || !await hasEmptyBody(request)) {
        response.setHeader('Connection', 'close');
        errorResponse(response, 400);
        return;
      }
      if (limited(internalLimiter, request, response)) return;
      store.requestRefresh('internal');
      json(response, 202, { accepted: true });
      return;
    }

    if (request.method !== 'GET' || !isPublic) return errorResponse(response, 404);
    let query;
    let itemId;
    let rotationKind;
    let saleSection = null;
    if (path === '/v1/items') {
      query = parseItemsQuery(url.searchParams);
      if (!query) return errorResponse(response, 400);
    } else if (path === '/v1/rotations/sales' || path.startsWith('/v1/rotations/sales/')) {
      if (path !== '/v1/rotations/sales') {
        saleSection = path.slice('/v1/rotations/sales/'.length);
        if (!SALE_SECTIONS.has(saleSection)) return errorResponse(response, 404);
      }
      rotationKind = 'sales';
      query = parseRotationQuery(url.searchParams, rotationKind);
      if (!query) return errorResponse(response, 400);
    } else if (path === '/v1/rotations/mythic-sales' || path === '/v1/rotations/sanctum') {
      rotationKind = path === '/v1/rotations/mythic-sales' ? 'mythic' : 'sanctum';
      query = parseRotationQuery(url.searchParams, rotationKind);
      if (!query) return errorResponse(response, 400);
    } else if (path === '/v1/rotations' || ROTATION_ROUTES.has(path)) {
      if (url.search) return errorResponse(response, 400);
    } else if (/^\/v1\/items\/[^/]+$/.test(path)) {
      try { itemId = decodeURIComponent(path.slice('/v1/items/'.length)).toLowerCase(); }
      catch { return errorResponse(response, 400); }
      if (!UUID.test(itemId) || url.search) return errorResponse(response, 400);
    } else {
      return errorResponse(response, 404);
    }

    // Capture one reference for the entire request, even if a refresh swaps it.
    const current = store.current;
    if (!current) {
      response.setHeader('Retry-After', '60');
      return errorResponse(response, 503);
    }
    const { snapshot, itemById } = current;
    if (path === '/v1/rotations') {
      return cachedResponse(request, response, snapshot.snapshotId, path, snapshot.rotations);
    }
    const meta = snapshot.rotations.meta;
    if (rotationKind) {
      const field = rotationKind === 'sales' ? 'catalogSales' : rotationKind === 'mythic' ? 'mythicShop' : 'sanctum';
      const matches = rotationKind === 'sales' ? sale =>
        saleInSection(sale, saleSection) &&
        (query.currency === null || sale.salePrice.currency === query.currency) &&
        (query.typeId === null || sale.item.type.id === query.typeId) &&
        (query.championId === null || sale.item.champion?.id === query.championId) &&
        (query.skinlineId === null || sale.item.skinline?.id === query.skinlineId) &&
        (query.limited === null || sale.limited === query.limited)
        : rotationKind === 'mythic' ? offer => query.section === null || offer.section === query.section
          : banner => query.rarity === null || banner.rarity === query.rarity;
      return cachedResponse(request, response, snapshot.snapshotId, `${path}?${JSON.stringify(query)}`,
        paginatedRotations(snapshot, field, query, matches));
    }
    const rotationField = ROTATION_ROUTES.get(path);
    if (rotationField) {
      return cachedResponse(request, response, snapshot.snapshotId, path, {
        meta, [rotationField]: snapshot.rotations[rotationField],
      });
    }
    if (itemId) {
      const item = itemById.get(itemId);
      if (!item) return errorResponse(response, 404);
      return cachedResponse(request, response, snapshot.snapshotId, `/v1/items/${itemId}`, { meta, item });
    }
    const items = snapshot.items.filter(item =>
      (query.typeId === null || item.type.id === query.typeId) &&
      (query.championId === null || item.champion?.id === query.championId) &&
      (query.skinlineId === null || item.skinline?.id === query.skinlineId));
    const totalPages = Math.ceil(items.length / query.pageSize);
    const start = (query.page - 1) * query.pageSize;
    return cachedResponse(request, response, snapshot.snapshotId, `/v1/items?${JSON.stringify(query)}`, {
      meta, page: query.page, pageSize: query.pageSize, total: items.length, totalPages,
      items: query.page > totalPages ? [] : items.slice(start, start + query.pageSize),
    });
  }
  return server;
}

export async function start(config = readConfig()) {
  const store = await createSnapshotStore(config);
  const server = createApiServer(config, store);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });
  log('service_start', { apiVersion: 'v1', port: server.address().port, snapshotLoaded: Boolean(store.current) });
  store.start();
  return { server, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { server, store } = await start();
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      server.close();
      await store.close();
    };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  } catch (error) {
    logFailure('startup_failure', error);
    process.exitCode = 1;
  }
}
