# Rotations.lol public API

A free, anonymous API for the League of Legends cosmetic catalog, skin sales, Mythic Shop offers, Sanctum banners, and Your Shop dates. Public requests need no account or API key.

Base URL: `https://api.rotations.lol`

Browse the [interactive documentation](https://api.rotations.lol/docs) or download the [OpenAPI specification](https://api.rotations.lol/openapi.json).

## Common requests

```sh
curl https://api.rotations.lol/v1/rotations
curl 'https://api.rotations.lol/v1/items?championId=22&pageSize=50'
curl 'https://api.rotations.lol/v1/rotations/sales/weekly?currency=RP'
curl 'https://api.rotations.lol/v1/rotations/mythic-sales?section=DAILY'
```

## Endpoints

| Path | Returns |
|---|---|
| `/v1/rotations` | All active rotations and current plus recent Your Shop windows. |
| `/v1/rotations/sales` | Active catalog sales. |
| `/v1/rotations/sales/:section` | Sales in `weekly`, `limited`, `chromas`, `blue-essence`, or `other-items`. |
| `/v1/rotations/mythic-sales` | Active Mythic Shop offers. |
| `/v1/rotations/sanctum` | Active Sanctum banners. |
| `/v1/rotations/your-shop` | The current Your Shop window and four recent windows. |
| `/v1/items` | The cosmetic catalog. |
| `/v1/items/:itemId` | One cosmetic by catalog UUID. |
| `/health` | Snapshot readiness and freshness. |

All listed endpoints use GET. Collection endpoints support pagination with `page` and `pageSize`, defaulting to 100 items and capped at 200. The combined rotations endpoint returns all rotations together.

Catalog filters include `typeId`, `championId`, and `skinlineId`. Sales also accept `currency` and `limited`. Mythic offers accept `section`, and Sanctum accepts `rarity`. See the [API reference](docs/reference.md) for exact parameters, response types, and examples.

## Limits and freshness

- Public requests default to 60 per minute per client IP. A 429 response includes `Retry-After`.
- Responses support ETags and conditional requests through `If-None-Match`, with five-minute public caching.
- Every successful V1 response includes `meta.apiVersion` and `meta.generatedAt`.
- Requests read a saved in-memory snapshot. Ingestion can request updates, and hourly fallback checks run at `:05 UTC`.
- If a refresh fails, the API keeps serving its last valid snapshot. Health returns 503 when ingestion confirmation is more than 90 minutes old.

The API exposes public cosmetic data. Accounts, wishlists, and personalized Your Shop discounts remain outside its public routes.

## Run locally

Use Node 24. The service has no runtime dependencies.

Start and populate local Supabase using [rotations-ingestion](https://github.com/zandonella/rotations-ingestion), then copy `.env.example` to `.env` in this repository.

```env
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_PUBLISHABLE_KEY=<local publishable or anon key>
DATA_DIR=./data
```

Use port `55421` for the ingestion repository's separate Linux development database.

```sh
npm start
```

Open `http://127.0.0.1:3000/docs` to explore the local API. Run `npm test` for the regression suite.

## Deployment and reference

The service runs independently in Docker and persists its snapshot in a named volume. It uses a public Supabase key. Refresh hints and email rendering use authenticated private routes.

The [API reference](docs/reference.md) covers response contracts, configuration, Docker deployment, private integration routes, and database requirements. The machine-readable contract is also included in [openapi.json](openapi.json).

## Riot Games disclaimer

Rotations.lol is not endorsed by or affiliated with Riot Games. League of Legends and all associated properties are trademarks of Riot Games.
