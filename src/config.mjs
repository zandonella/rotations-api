import { isIP } from 'node:net';
import { resolve } from 'node:path';

export function readConfig(env = process.env) {
  function invalid(name) {
    throw Object.assign(new Error(`Invalid ${name} configuration.`), { code: 'invalid_config' });
  }
  function integer(name, fallback, max = Number.MAX_SAFE_INTEGER) {
    const value = env[name] || String(fallback);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) invalid(name);
    return Number(value);
  }
  const supabaseUrl = env.SUPABASE_URL || '';
  if (supabaseUrl) {
    let url;
    try { url = new URL(supabaseUrl); } catch { invalid('SUPABASE_URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') invalid('SUPABASE_URL');
  }
  const supabasePublishableKey = env.SUPABASE_PUBLISHABLE_KEY || '';
  if (supabasePublishableKey && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(supabasePublishableKey)) {
    // Local Supabase also supplies legacy anon JWTs. Never accept a privileged key.
    let role;
    try { role = JSON.parse(Buffer.from(supabasePublishableKey.split('.')[1], 'base64url')).role; } catch { /* Invalid key. */ }
    if (supabasePublishableKey.split('.').length !== 3 || role !== 'anon') invalid('SUPABASE_PUBLISHABLE_KEY');
  }
  const trustedProxyIps = (env.TRUSTED_PROXY_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean);
  if (trustedProxyIps.some(ip => !isIP(ip))) invalid('TRUSTED_PROXY_IPS');
  return Object.freeze({
    supabaseUrl,
    supabasePublishableKey,
    refreshSecret: env.API_REFRESH_SECRET || '',
    port: integer('PORT', 3000, 65535),
    dataDir: resolve(env.DATA_DIR || '/app/data'),
    refreshIntervalMs: integer('REFRESH_INTERVAL_MINUTES', 30, 35791) * 60_000,
    publicRateLimit: integer('PUBLIC_RATE_LIMIT_PER_MINUTE', 60),
    trustedProxyIps: Object.freeze(trustedProxyIps),
  });
}
