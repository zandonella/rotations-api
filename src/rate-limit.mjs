import { isIP } from 'node:net';

export function clientIp(request, trustedProxyIps) {
  const peer = request.socket.remoteAddress;
  const forwarded = request.headers['x-real-ip'];
  if (trustedProxyIps.includes(peer) && typeof forwarded === 'string' && isIP(forwarded)) {
    return forwarded;
  }
  return peer;
}

export function createRateLimiter(limit) {
  const buckets = new Map();

  function prune(now = Date.now()) {
    const minute = Math.floor(now / 60_000);
    for (const [ip, bucket] of buckets) {
      if (bucket.minute < minute) buckets.delete(ip);
    }
  }

  const timer = setInterval(prune, 60_000);
  timer.unref();

  return {
    check(ip, now = Date.now()) {
      const minute = Math.floor(now / 60_000);
      let bucket = buckets.get(ip);
      if (!bucket || bucket.minute !== minute) {
        bucket = { minute, count: 0 };
        buckets.set(ip, bucket);
      }
      const allowed = bucket.count < limit;
      if (allowed) bucket.count += 1;
      return { allowed, retryAfter: Math.ceil(((minute + 1) * 60_000 - now) / 1000) };
    },
    close() { clearInterval(timer); buckets.clear(); },
  };
}
