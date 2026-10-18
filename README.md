# Supply Chain Planner

Upload the inbound shipments Excel report, extract shipments and tracking numbers, and see:

- **Inbound by day**: expected arrivals per day (carrier ETA when known, otherwise the supplier's promised date), split Parcel vs LTL.
- **Shipments**: every shipment grouped by tracking status, with a detail drawer and "Mark arrived".
- **Arrival log**: actual arrival vs. the supplier's *original* promised date, with variance and a supplier on-time scorecard. If a later report moves the promised date, the change is logged and shown, but scoring still uses the first date.

## Architecture

| Piece | Tech |
|---|---|
| Frontend | Vite + React + TypeScript, Tailwind, TanStack Query, Recharts |
| Excel parsing | SheetJS, **in the browser**. Only normalized rows are sent to the API |
| API | Cloudflare **Pages Functions** (`functions/api/[[route]].ts` → Hono app in `server/`) |
| Database | Neon Postgres via `@neondatabase/serverless` + Drizzle ORM |
| Auth | Neon Auth. The browser gets a JWT; Functions verify it against Neon Auth's JWKS |
| Tracking | Pluggable `TrackingProvider` interface (`server/tracking/`). No provider is wired yet |

The Functions exist only so the DB connection string (and later the carrier API keys) never reach the browser. They deploy together with the site on Cloudflare Pages; there's no separate server.

```
src/features/import     upload → sheet/header detection → column mapping → preview → import
src/features/inbound    Inbound by day page + chart
src/features/shipments  Shipments page + shipment drawer
src/features/arrivals   Arrival log + supplier scorecard
shared/                 types, zod schemas and date math shared by browser and API
server/                 Hono routes, Drizzle schema, auth middleware, tracking providers
drizzle/                SQL migrations
```

## Setup

Requires Node.js 20+ and [pnpm](https://pnpm.io/installation) 10 (`corepack enable` picks up the version pinned in `package.json`).

1. **Neon**: create a project, then a `dev` branch for local work. In the console, enable **Auth** for the project and copy the Auth URL.
2. **Env files**:
   - `cp .env.example .env`: set `VITE_NEON_AUTH_URL` and `DATABASE_URL` (used by drizzle-kit).
   - `cp .dev.vars.example .dev.vars`: set `DATABASE_URL` (pooled) and `NEON_AUTH_URL` (used by Functions).
3. `pnpm install`
4. `pnpm db:migrate` creates the tables.
5. Run locally in two terminals:
   - `pnpm dev:api`: Pages Functions on http://localhost:8788
   - `pnpm dev`: the app on http://localhost:5173 (proxies `/api` to 8788)
6. Optional: `pnpm sample:xlsx` writes a fake report to `samples/inbound-sample.xlsx` that you can upload.

## Deploy (Cloudflare Pages)

```sh
pnpm wrangler login
pnpm wrangler pages project create supply-chain-planner
pnpm wrangler pages secret put DATABASE_URL     # Neon main branch, pooled
pnpm wrangler pages secret put NEON_AUTH_URL
VITE_NEON_AUTH_URL=... pnpm run deploy   # not `pnpm deploy`, which is a built-in pnpm command
```

Or connect the GitHub repo in the Cloudflare dashboard with build command `pnpm build` (Cloudflare detects pnpm from `pnpm-lock.yaml`), output dir `dist`, and the same variables. Add your Pages domain to Neon Auth's trusted origins.

## Importing reports

- The header row is auto-detected, so title rows above it are fine.
- Columns are auto-matched by name. Adjust any of them in the mapper. **Save the mapping** and it is reused automatically next time the same layout is uploaded.
- Required: supplier, promised arrival date, and a tracking number or PO number.
- A cell with several tracking numbers (comma, semicolon or newline separated) becomes one shipment per number.
- UPS/FedEx/USPS/DHL are detected from the tracking number format when the carrier column is empty. Any other carrier name is treated as LTL/freight.
- Re-importing updates existing shipments, matched by tracking number, or by supplier + PO + line when there is no tracking number. An arrival recorded manually or from tracking is never overwritten by a report.
- Excel tip: format long tracking-number columns as **Text**. Excel stores 16+ digit numbers with lost precision, and the preview warns when this happens.

## Adding carrier tracking

Implement `TrackingProvider` (`server/tracking/provider.ts`) for an aggregator (Ship24, AfterShip, 17TRACK…) or a carrier API. Register it in `server/tracking/registry.ts` and add its key as a Pages secret. "Refresh tracking" on the Shipments page and `POST /api/tracking/refresh` will then update status, ETA, events, and arrival dates. For scheduled refreshes, add a small Worker with a Cron Trigger that calls `refreshTracking()`, since Pages Functions can't run on cron.

## Scripts

| | |
|---|---|
| `pnpm test` | Vitest: parsing, mapping, dates, carrier detection, import planning, reports |
| `pnpm typecheck` | TypeScript |
| `pnpm db:generate` | New migration after editing `server/db/schema.ts` |
| `pnpm db:studio` | Browse the DB |
