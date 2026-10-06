# Rotations.lol public API

The Rotations.lol V1 API provides the public League of Legends cosmetic catalog, Catalog Sales, Mythic Shop offers, Sanctum banners, and Your Shop windows. The intended base URL is `https://api.rotations.lol`. Public use is free and anonymous, with no API key or account required.

This independent Node service has no runtime dependencies. Public requests read one immutable in-memory snapshot. Only refreshes read public Supabase tables. Personalized Your Shop discounts, accounts, wishlists, operational data, and history endpoints are outside V1.

## Endpoints and parameters

| Method | Path | Response |
|---|---|---|
| GET | `/v1/rotations` | All active Catalog Sales, Mythic offers, Sanctum banners, and current plus recent Your Shop windows. |
| GET | `/v1/rotations/sales` | A filtered page of active Catalog Sales, including Blue Essence Emporium offers. |
| GET | `/v1/rotations/sales/:section` | A filtered page from one of the site's five sale sections. |
| GET | `/v1/rotations/mythic-sales` | A filtered page of active Mythic Shop offers. |
| GET | `/v1/rotations/your-shop` | The current Your Shop window and four recent windows. |
| GET | `/v1/rotations/sanctum` | A filtered page of active Sanctum banners. |
| GET | `/v1/items` | A filtered page of the cosmetic catalog. |
| GET | `/v1/items/:itemId` | One item by its canonical catalog UUID. |
| GET | `/openapi.json` | The OpenAPI 3.1 description of the routes and response shapes. |
| GET | `/docs` | Interactive Swagger UI documentation with a request tester. |
| GET | `/health` | Safe snapshot readiness and freshness information. |
| POST | `/internal/refresh` | An authenticated maintainer refresh hint. |

The combined rotation route, Your Shop, and single-item lookup accept no query parameters. The sale, Mythic, and Sanctum routes return `meta`, page metadata, and their corresponding field from the combined response. `/openapi.json` accepts no query parameters. UUID lookup is case insensitive, and returned UUIDs are lowercase. Malformed UUIDs return 400. Well-formed UUIDs absent from the catalog return 404. Unknown paths and unsupported methods return 404.

The following parameters apply to `/v1/items` and the paginated rotation routes.

| Parameter | Default | Accepted values |
|---|---|---|
| `page` | `1` | A positive safe integer. |
| `pageSize` | `100` | A positive safe integer, capped at `200`. |
| `typeId` | No filter. | A nonnegative safe integer matching an item's type. Available on items and sales. |
| `championId` | No filter. | A nonnegative safe integer matching an item's champion. Available on items and sales. |
| `skinlineId` | No filter. | A nonnegative safe integer matching an item's skinline. Available on items and sales. |
| `currency` | No filter. | A letter followed by up to 31 letters, digits, or underscores. Matching is case insensitive. Available on sales. |
| `limited` | No filter. | `true` or `false`. Available on sales. |
| `section` | No filter. | `FEATURED`, `BIWEEKLY`, `WEEKLY`, or `DAILY`. Matching is case insensitive. Available on Mythic sales. |
| `rarity` | No filter. | `EXALTED` or `MYTHIC_VARIANT`. Matching is case insensitive. Available on Sanctum. |

Numeric parameters use decimal digits only. Leading zeros are normalized. Empty, signed, fractional, nonnumeric, duplicate, unknown, and unsafe integer parameters return 400. Filters intersect and match exactly. Unknown numeric filter values produce no matches. Null relationships do not match any numeric filter, including zero. The `pageSize` maximum is applied after parsing, so larger valid integers are accepted and normalized to 200.

The sale section names are `weekly`, `limited`, `chromas`, `blue-essence`, and `other-items`. Blue Essence contains every Catalog Sale with currency `IP`. Other sections exclude `IP`. Weekly contains nonlimited skins, limited contains limited skins, chromas contains type 2 items, and other items contains types above 2. Every sale belongs to exactly one section. The section routes accept the same sales filters, and a filter with no matching sales returns an empty page.

Items sort by name and then UUID using deterministic JavaScript string comparison. Rotation pages keep the order of their arrays in the combined response. `total` counts results after all filters and any sale section are applied. `totalPages` is `ceil(total / pageSize)`, including zero when nothing matches. Any valid page beyond the results returns 200 with an empty collection. Each request reads the latest snapshot, so an intervening refresh can change results across pages.

## Exact response contracts

Every successful V1 response begins with `meta`. `generatedAt` is when the complete candidate was constructed from public reads, not an upstream change timestamp. Timestamps are UTC ISO-8601 with millisecond precision. Every listed property is present, including nullable properties. These TypeScript-style definitions describe JSON only and introduce no dependency.

```ts
type Meta = { apiVersion: "v1"; generatedAt: string };
type Item = {
  itemId: string;                  // CatalogItem.ItemID UUID.
  riotItemId: number;              // Integer, unique only with type.id.
  type: { id: number; name: string };
  name: string;
  imageUrl: string | null;
  parentItemId: string | null;     // Catalog UUID, sometimes its own UUID.
  champion: {
    id: number; slug: string; name: string; imageUrl: string;
  } | null;
  skinline: {
    id: number; name: string | null;
    universe: { id: number; name: string } | null;
  } | null;
};
type Price = { amount: number; currency: string }; // Integer amounts.
type ShopWindow = { shopName: string; startsAt: string; endsAt: string };
type RotationsResponse = {
  meta: Meta;
  catalogSales: Array<{
    saleId: string; startsAt: string; endsAt: string;
    regularPrice: Price; salePrice: Price;
    percentOff: number; limited: boolean; item: Item;
  }>;
  mythicShop: Array<{
    offerId: string; startsAt: string; endsAt: string;
    section: "FEATURED" | "BIWEEKLY" | "WEEKLY" | "DAILY";
    price: Price; isBundle: boolean; bundleType: string | null;
    primaryItem: Item; includedContentIds: string[];
  }>;
  sanctum: Array<{
    bannerId: string; startsAt: string; endsAt: string;
    rarity: "EXALTED" | "MYTHIC_VARIANT";
    chasePityThreshold: number; bannerImageUrl: string | null; item: Item;
  }>;
  yourShop: { currentWindow: ShopWindow | null; recentWindows: ShopWindow[] };
};
type Page = { page: number; pageSize: number; total: number; totalPages: number };
type SalesResponse = Page & Pick<RotationsResponse, "meta" | "catalogSales">;
type MythicSalesResponse = Page & Pick<RotationsResponse, "meta" | "mythicShop">;
type YourShopResponse = Pick<RotationsResponse, "meta" | "yourShop">;
type SanctumResponse = Page & Pick<RotationsResponse, "meta" | "sanctum">;
type ItemsResponse = {
  meta: Meta; page: number; pageSize: number;
  total: number; totalPages: number; items: Item[];
};
type ItemResponse = { meta: Meta; item: Item };
```

The known item types are 1 Skin, 2 Chroma, 3 Emote, 4 Icon, 5 Finisher, 6 Ward, and 7 Title. Lookup metadata, champion slugs, currencies, and image URLs retain source values. Image URLs can be protocol relative, such as `//wsrv.nl/...`. Cosmetic rarity, tiers, and currency conversion are not invented.

Legacy emote rows with blank names are excluded from snapshots. Static ingestion now skips unnamed emotes, but older rows can remain in Supabase. Other unnamed catalog items still fail validation so source data issues remain visible.

The first three rotation arrays come from `IsActive = true` rows at refresh time. The combined route retains the complete arrays, including large Blue Essence rotations. Collection subroutes page those arrays without additional Supabase reads. Catalog Sales sort by end time and `saleId`. Mythic offers sort by FEATURED, BIWEEKLY, WEEKLY, DAILY, then end time and `offerId`. Sanctum sorts by EXALTED before MYTHIC_VARIANT, then end time and `bannerId`.

`saleId` is `CatalogSale.SaleID`. `offerId` is `MythicSale.OfferID`, and `bannerId` is `SanctumSale.SaleID`. Mythic `SaleID` stays internal. Your Shop uses `ShopName`. Its current window requires both `IsActive` and `HubEnabled`, an inclusive start, and an exclusive end at snapshot-build time. Recent windows are the four newest by start time excluding the current window, with `shopName` breaking ties. Empty current rotations are valid.

Repository verification found that the current frontend checks `IsActive` and timestamps without checking `HubEnabled`. This API follows the plan's explicit requirement to check both flags. The frontend was not changed.

## Mythic included item verification

The plan's `includedItemIds` is named `includedContentIds` in the implemented contract. Values are ordered, lowercase League fulfillment content UUIDs. They are not guaranteed catalog IDs. The primary item always resolves to the shared `Item` contract.

`MythicSale.IncludedItems` is a PostgreSQL `text[]`. Ingestion's `getAllIncludedItems` copies `purchaseUnits[].fulfillment.itemId` directly. Static ingestion assigns CommunityDragon `contentId` to `CatalogItem.ItemID`, and the wishlist RPC matches those UUIDs. However, only `PrimaryItemID` has a foreign key. The array has none, and ingestion does not resolve every included entry.

A read-only comparison of saved local sources found 34 purchase units, 33 distinct fulfillment UUIDs, and one unresolved UUID among 16,594 static source content IDs. The unresolved fulfillment is `Together as 1`, with UUID `8d3b35fd-0a34-4355-99e5-66dc8923f250`. Static processing also filters source items. Live ingestion skips offers with absent primary catalog items, so this sample does not prove the unresolved primary was persisted. No production database was queried. V1 preserves the complete ordered content identifiers without dropping unresolved values or labeling them as catalog items.

## Examples

```sh
curl -i https://api.rotations.lol/v1/rotations
curl -i https://api.rotations.lol/v1/rotations/sales
curl -i 'https://api.rotations.lol/v1/rotations/sales/blue-essence?page=1&pageSize=50&typeId=2'
curl -i 'https://api.rotations.lol/v1/rotations/sales/weekly?currency=RP&championId=22'
curl -i https://api.rotations.lol/v1/rotations/mythic-sales
curl -i 'https://api.rotations.lol/v1/rotations/mythic-sales?section=DAILY'
curl -i https://api.rotations.lol/v1/rotations/your-shop
curl -i https://api.rotations.lol/v1/rotations/sanctum
curl -i 'https://api.rotations.lol/v1/rotations/sanctum?rarity=EXALTED'
curl -i https://api.rotations.lol/openapi.json
curl 'https://api.rotations.lol/v1/items?page=1&pageSize=50&typeId=1&championId=22'
curl https://api.rotations.lol/v1/items/c151d9cb-5f90-46d8-bf46-4042de8b7c14
curl -i https://api.rotations.lol/health
```

A representative catalog response follows. Values are illustrative.

```json
{
  "meta": { "apiVersion": "v1", "generatedAt": "2026-09-22T14:30:02.183Z" },
  "page": 1,
  "pageSize": 100,
  "total": 1,
  "totalPages": 1,
  "items": [{
    "itemId": "c151d9cb-5f90-46d8-bf46-4042de8b7c14",
    "riotItemId": 123456,
    "type": { "id": 1, "name": "Skin" },
    "name": "Example Skin",
    "imageUrl": "https://example.invalid/image.png",
    "parentItemId": null,
    "champion": {
      "id": 22, "slug": "Ashe", "name": "Ashe",
      "imageUrl": "https://example.invalid/ashe.png"
    },
    "skinline": {
      "id": 42, "name": "Example",
      "universe": { "id": 7, "name": "Example Universe" }
    }
  }]
}
```

A valid rotation response can contain no current offers.

```json
{
  "meta": { "apiVersion": "v1", "generatedAt": "2026-09-22T14:30:02.183Z" },
  "catalogSales": [],
  "mythicShop": [],
  "sanctum": [],
  "yourShop": { "currentWindow": null, "recentWindows": [] }
}
```

A sale section response uses the same `catalogSales` items as the combined response and adds page metadata.

```json
{
  "meta": { "apiVersion": "v1", "generatedAt": "2026-09-22T14:30:02.183Z" },
  "page": 1,
  "pageSize": 100,
  "total": 0,
  "totalPages": 0,
  "catalogSales": []
}
```

The machine-readable OpenAPI 3.1.2 description is available from `/openapi.json`, including when the snapshot is unavailable. Its response uses `Cache-Control: no-store` and requires no account or API key.

Visit `/docs` to browse the operations, enter filters, and send test requests from Swagger UI. The page always sends requests to the same API host that served it, so a local docs page uses the local API. Swagger UI 5.33.0 JavaScript and CSS are bundled under `public/docs/` with their license files. The page loads no third-party scripts and does not retain authorization across reloads. `/docs` and its assets are available even when the snapshot is unavailable. The page uses the API's public rate limit. `/openapi.json` remains the downloadable machine-readable contract.

## Rate limits, caching, and CORS

The default public limit is 60 requests per minute per client IP in fixed epoch-minute buckets. V1 requests, including OPTIONS and conditional requests, count toward the limit. A 429 includes `Retry-After` with seconds until reset. For unusually high-volume use, contact [contact@rotations.lol](mailto:contact@rotations.lol) first. Cache responses and use conditional requests when appropriate.

Successful V1 responses include these headers.

```http
Cache-Control: public, max-age=300, s-maxage=300, stale-while-revalidate=60
ETag: "v1-<snapshotId>-<normalized-route-variant-hash>"
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: ETag
```

Send the returned ETag in `If-None-Match`. Matching strong or weak tags, a matching tag in a comma-separated list, or `*` return bodyless 304 with the same caching headers. Normalized defaults, parameter ordering, leading zeros, case insensitive enum filters, and capped sizes share a route variant. Each sale section and filtered page has its own ETag. Different resources and filters have different ETags.

```sh
curl -i https://api.rotations.lol/v1/rotations
# Replace the placeholder with the exact returned ETag.
curl -i https://api.rotations.lol/v1/rotations -H 'If-None-Match: "YOUR_RETURNED_ETAG"'
```

Public V1 OPTIONS requests return 204 and allow GET, OPTIONS, and `If-None-Match`. Internal refresh has no CORS headers. Errors, health, preflight, and internal responses use `Cache-Control: no-store`. The reverse proxy must honor `no-store` and never cache internal refresh.

## Errors and health

Application errors use this envelope with the exact code and message from the table.

```json
{
  "error": {
    "code": "snapshot_unavailable",
    "message": "The API is temporarily unavailable. Please try again shortly."
  }
}
```

| Status | Code | Message |
|---|---|---|
| 400 | `invalid_request` | The request parameters are invalid. |
| 401 | `unauthorized` | The refresh request is not authorized. |
| 404 | `not_found` | The requested resource was not found. |
| 429 | `rate_limited` | Too many requests. Please try again later. |
| 500 | `internal_error` | The API could not complete the request. |
| 503 | `snapshot_unavailable` | The API is temporarily unavailable. Please try again shortly. |

Startup data-route 503 responses include `Retry-After: 60`. Health uses its own safe shape.

```json
{
  "ok": true,
  "apiVersion": "v1",
  "snapshot": {
    "loaded": true,
    "generatedAt": "2026-09-22T14:30:02.183Z",
    "ageSeconds": 412
  }
}
```

Health returns 200 with a loaded snapshot whose last confirmed ingestion check is no older than 90 minutes, including the exact threshold, and 503 otherwise. `generatedAt` and `ageSeconds` describe the cached content. `checkedAt` and `checkAgeSeconds` describe its last confirmed ingestion check. Unchanged content can remain healthy for weeks while successful pulls keep confirming it. With no snapshot, `ok` and `loaded` are false and all timestamp and age fields are null. Displayed age rounds down to seconds, while freshness uses milliseconds. One failed refresh does not independently affect health. Stale known-good data remains available on V1 routes even while health returns 503.

## Snapshot and refresh behavior

Startup validates and loads `/app/data/snapshot-v1.json`, reconstructs the item lookup map, begins serving, and starts an asynchronous refresh. Without valid persisted data, public data routes return 503 until a build succeeds. By default, fallback checks start at 5 and 35 minutes past each UTC hour, regardless of when the service started. Each check reads only the singleton `public_api_state` row. Unchanged fingerprints cause no catalog or rotation queries. Scheduling never reads ingestion heartbeat.

A changed section is read independently. After the initial catalog synchronization, `get_public_api_catalog_changes()` returns only added or updated public items and removal IDs since the API's saved catalog revision. Lookup changes include only affected items. The API merges these changes into its saved catalog and rebinds embedded rotation items without downloading unchanged catalog rows or lookup tables. Sales, Mythic Shop, Sanctum, and Your Shop updates each read only their corresponding table. A tiny live fingerprint check after downloading rejects data that changed during the reads. A valid candidate is saved atomically before memory swaps. Any failure preserves the previous live snapshot. Only one rebuild executes at a time, with one pending boolean coalescing intervening requests into a follow-up run.

The persisted shape is `{schemaVersion: 1, generatedAt, rotations, items, snapshotId}`. Maps are never persisted. SHA-256 covers the deterministic JSON candidate without `snapshotId`, including `generatedAt`. The digest is added afterward and verified on load. Arrays have stable sorting and the builder constructs fields in a fixed order. Snapshot objects are recursively frozen in memory. `snapshot-source-v1.json` stores the five confirmed fingerprints, catalog revision, and ingestion check time, bound to the saved snapshot digest. A missing, corrupt, or mismatched source-state file requires one complete synchronization. An older valid sidecar without a catalog revision requires one catalog synchronization while reusing unchanged rotations. A database restore that rolls the catalog revision backward also requires a catalog synchronization. Normal restarts read just the manifest and retain the catalog. If public response content is identical, generation time, snapshot ID, and ETags remain unchanged.

Native fetch uses explicit columns, deterministic ordering, 500 row ranges, and a 15 second timeout. The helper checks exact `Content-Range` totals rather than relying only on short pages. This avoids silent truncation under smaller server row caps and avoids requesting a range past an exactly full last page. A changing total rejects the rebuild. Both `apikey` and the matching bearer header are sent as specified. Only public or legacy anon credentials are used.

Validation rejects malformed shapes, unexpected persisted fields, invalid IDs or timestamps, duplicate identities, invalid item types or enums, unresolved required relationships, multiple current Your Shop windows, and an empty catalog replacing a nonempty catalog. Empty rotations remain valid. Separate REST reads do not form a database transaction. The post-download fingerprint must match the published manifest before the API acknowledges an update. A mismatch preserves known-good data and retries on a later hint or scheduled check.

## Local development and environment

Use Node 24. No dependency installation is needed.

1. Start local Supabase from `rotations-ingestion` using `npx supabase start`. Apply the migrations, including `20261005000000_add_public_api_state.sql` and `20261005010000_add_public_api_catalog_deltas.sql`, and populate local public data through the local workflow. A successful static or client processing run publishes the initial manifest and catalog revision through `record_public_api_state()`.
2. In `rotations-api`, copy `.env.example` to `.env`. Supply the local publishable or legacy anon key and set `DATA_DIR=./data` for native development. Use a local-only secret for hint testing.
3. Run `npm start`, then `curl -i http://127.0.0.1:3000/health`.
4. Run `npm test`. Tests mock Supabase HTTP and need no live database or production credentials.

The native server listens on `0.0.0.0`. Missing database credentials allow safe startup but prevent successful refreshes. Missing refresh secret disables hints. Do not point development at production Supabase.

| Variable | Default | Purpose |
|---|---|---|
| `SUPABASE_URL` | Empty. | REST origin, required for snapshot builds. |
| `SUPABASE_PUBLISHABLE_KEY` | Empty. | Public key or local legacy anon JWT. Privileged keys are rejected. |
| `API_REFRESH_SECRET` | Empty. | Shared refresh bearer secret. Empty disables hints. |
| `PORT` | `3000` | Native HTTP port. Compose fixes container port 3000. |
| `DATA_DIR` | `/app/data` | Snapshot directory. Compose fixes the writable volume path. |
| `REFRESH_INTERVAL_MINUTES` | `30` | Positive integer, at most 35791 minutes to fit Node timers. The default runs at `:05` and `:35` UTC. Other intervals repeat from the same fixed UTC anchor, independent of service startup time. |
| `PUBLIC_RATE_LIMIT_PER_MINUTE` | `60` | Positive safe integer public request limit. |
| `TRUSTED_PROXY_IPS` | Empty. | Comma-separated exact TCP peer IPs. No CIDR ranges. |

Never pass service-role, direct database, ingestion, monitoring, or Discord credentials. Environment examples contain no credentials. Git and the Docker build context exclude `.env` files and local snapshots.

## Maintainer refresh hints

`POST /internal/refresh` requires `Authorization: Bearer <API_REFRESH_SECRET>`, with no body or query parameters. Authentication uses timing-safe comparison. Nonempty bodies, including whitespace and chunked bodies, return 400. Invalid authorization returns 401. Two accepted attempts per minute per source IP are allowed separately from the public limit.

A 202 response with `{"accepted":true}` means a manifest check was accepted or coalesced. It downloads sections only when their confirmed fingerprints differ. It does not wait for success. The operation grants only a public manifest check and any required public section reads. Logs record reasons, durations, row counts, generation times, and outcomes without credentials or authentication headers.

```sh
curl -i -X POST "$ROTATIONS_API_REFRESH_URL" \
  -H "Authorization: Bearer $ROTATIONS_API_REFRESH_SECRET"
```

In ingestion, configure `ROTATIONS_API_REFRESH_URL` and `ROTATIONS_API_REFRESH_SECRET` only when the API is reachable. The shared helper uses native fetch, a five second timeout, and no redirects. Failures are sanitized warnings. Live ingestion hints once after explicit successful public-data work, before Pi scheduling and heartbeat. Partial processing suppresses the hint. Static ingestion hints once after every lookup and catalog upsert succeeds. No shell scripts or monitoring code were changed.

## Container and deployment

```sh
docker compose --env-file .env.example config --quiet
docker build -t rotations-api:local .
# Run on the intended deployment host after configuring its environment.
docker compose up -d --build
```

The image uses Node 24 Alpine and the non-root `node` user. Compose applies a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, 0.50 CPU, 256 MiB memory, and 64 PIDs. Only the named `api-data` volume at `/app/data` is writable. No tmpfs is required. There are no host directories, project mounts, Docker socket, or other service volumes. Only this API's environment variables are passed.

Compose maps `127.0.0.1:3003:3000`. Verify port 3003 on the VPS first. Configure `api.rotations.lol` DNS and TLS through the existing reverse proxy targeting `http://127.0.0.1:3003`. No host proxy files were found in the repositories, and no host configuration has been changed.

The proxy must overwrite `X-Real-IP` with the client connection address it observed. Configure only the API's exact immediate TCP peers in `TRUSTED_PROXY_IPS`. Docker may present a bridge address, and dual-stack sockets may use IPv4-mapped IPv6. Verify the actual peer on the host rather than guessing. The API ignores forwarded identities from other peers and always ignores `X-Forwarded-For`.

Expose `/v1/`, `/health`, `/openapi.json`, and `/docs` publicly. Serve the `/docs/` asset paths through the same proxy. Prefer a separate private or Tailscale ingress for `/internal/refresh` and exclude it from the public virtual host. Verify the ingestion PC's route to the VPS. If private routing is unavailable, configure a public HTTPS refresh path protected by the shared secret and an ingress IP restriction where feasible. Host firewall changes are outside this implementation.

## Verification status

Tests cover HTTP contracts for the combined and individual rotation routes, sale section partitioning, pagination, filters, the OpenAPI and interactive documentation routes, bundled assets, errors, persisted loading and rejection, candidate failures, atomic swaps, coalescing, ETags, 304s, both rate limiters, proxy trust, authentication, body rejection, and health freshness. Ingestion tests mock source files, Supabase, logging, and HTTP. Ingestion has no configured typecheck command, so syntax checks supplement its tests.

Compose configuration validates. Image build and container runtime verification are blocked by this workstation's Docker Desktop startup failure involving its `dockerInference` socket. This is not a successful image build. This content revision change has not been deployed to production.

## Riot Games and League of Legends disclaimer

This service operates independently and is not affiliated with or endorsed by Riot Games. All game-related content, names, and assets are the property of their respective owners.

Rotations.lol isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc. This includes League of Legends.

## Refresh after Linux ingestion

Linux ingestion can request a snapshot refresh after successfully writing to Supabase. Keep the API's scheduled manifest checks enabled as a fallback. A failed refresh request does not undo ingestion; the API continues serving its last valid snapshot.

On the API host, add the settings from `.env.refresh.example` to the private `.env`. Set `API_REFRESH_BIND_IP` to that host's Tailscale IPv4 and generate a random `API_REFRESH_SECRET`. Deploy with both Compose files, including on future deployments:

```sh
docker compose -f docker-compose.yml -f docker-compose.refresh.yml up -d --build api
```

The override retains the existing loopback ingress and adds port 3005 bound only to the configured Tailscale address. Tailnet peers can reach the existing API routes there; `/internal/refresh` requires the shared bearer secret. Tailscale encrypts this private connection. Never bind this port to a public address or `0.0.0.0`.

In the ingestion host's private `.env.linux.prod`, set `ROTATIONS_API_REFRESH_URL` to `http://<api-tailscale-ip>:3005/internal/refresh` and `ROTATIONS_API_REFRESH_SECRET` to the same secret. Keep real addresses and secrets out of Git. Successful rotation and static ingestion use the existing callback. HTTP 202 means the refresh was queued; check `/health` and API logs to verify completion. Requests are limited to two per minute per source IP and overlapping refreshes are coalesced.

## Content revision rollout

Both database migrations and the ingestion publisher must be installed before this API version is deployed. Production steps require explicit owner approval. The migrations create `public_api_state`, the confirmed `public_api_catalog_item` cache, and three functions. Only the service role can call `record_public_api_state()` to publish after all public writes succeed. The API uses public read permissions for the manifest, `get_public_api_catalog_changes()` incremental reads, and `get_public_api_fingerprint()` consistency check. No Edge Function or privileged API credential is required.

`changed_sections` records the last update for inspection. Refresh decisions compare all five hashes, so missed checks and updates to several sections remain recoverable. The fingerprint comparison runs in Postgres and does not transfer the catalog to ingestion. A failed or missing manifest never falls back to repeated full downloads. API public requests continue reading memory.

The catalog cache stores one latest confirmed public JSON representation per item and retains a null representation for deleted items. Its storage grows with unique item IDs rather than ingestion runs. Every changed catalog publication increments `catalog_revision`, and only items whose public representation differs receive that revision. The publisher briefly locks catalog source tables against writes while calculating the hash and representations. The delta function verifies the expected published revision on every page. A superseded revision or failed delta preserves the existing snapshot and retries on the next check without a full catalog fallback. Keep the SQL item projection aligned with the public Item contract when changing its fields.
