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

The app is built around the Meerkat inventory report's **Supplier POs** tab, and still accepts other layouts through the column mapper.

- **Upload weekly reports oldest first.** Each report is a snapshot. Arrival dates are inferred by comparing it with the previous one, so the API refuses a report older than the latest import.
- The **report date** comes from the file name (`… 20261010.xlsx`). It can be changed before importing.
- The Supplier POs tab is picked automatically and its columns are auto-matched (WintecPO, WintecPOLine, ASN, POStatus, Tracking Num, ETADate, ETDDate, CRD, …). You can adjust the mapping and save it for next time.
- **One shipment = PO + line + ASN.** A PO line can ship in several deliveries, and one tracking number can cover several lines. If the same key appears twice in one file (e.g. a delivery split by country of origin), the rows are numbered `#2`, `#3`.
- **What gets imported:** every Open line, plus Closed lines whose ETA is within the last 60 days (the window can be changed). Older or undated Closed lines are skipped.
- **Statuses from the report:** Open with no ASN/tracking/ETA → *Awaiting shipment*; Open with an ETA → *Pending*; Open with ASN or tracking → *In transit*; Closed → *Delivered*. Awaiting lines that drop out of a later report (shipped under an ASN, or cancelled) are removed.
- **Tracking cells:** `HKG…/IS…` pairs are split into a tracking number + reference. "Truck" becomes the carrier. Carriers are detected because the report's Carrier column is empty: UPS `1Z…`, FedEx 12 digits, DHL 10 digits, air waybills `297-12345678` (airline from the prefix), forwarder house bills `HKG…`/`LAX…`. Other formats show as Unknown.
- The whole original row is stored with each line (`source_row`), so unmapped columns can be used later.

### Arrival dates

There is no receipt-date column, so the actual arrival date comes from the best evidence available:

1. **Tracking** (once a provider is connected) or a date **entered by hand**. These are confirmed and never overwritten by a report.
2. **Between reports:** the line was Open in one report and Closed in the next, so it arrived in that window. The estimate is the supplier's ETA moved into the window: ETA before it → the window's first day (late); ETA after it → the report date (early).
3. **Assumed on ETA:** the line was already Closed the first time it was imported. This says nothing about punctuality, so these lines are left out of the supplier scorecard unless "Include ETA-assumed arrivals" is ticked.

On-time performance is measured against the **first ETA** the supplier gave. Later ETA changes are logged as slips.

## Branches

Every line carries the report's **Branch** (ERP warehouse ID, e.g. `JIT-MSUS-META`). The branch selector in the header filters every page and is remembered in the browser. With "All branches" selected, the Inbound page shows a per-branch summary (due today, next 7 days, past due, awaiting shipment, arrived in the last 30 days); click a row to switch to that branch. Lines imported without a branch appear as `(none)`.

## Carrier tracking (Ship24)

Tracking uses [Ship24](https://www.ship24.com/), an aggregator covering FedEx, DHL, UPS, air waybills and forwarders, behind the `TrackingProvider` interface (`server/tracking/`).

1. Create a Ship24 account and an API key (the PRO plan covers 1,000 new tracking numbers a month; refreshing a number already tracked doesn't count again).
2. `pnpm wrangler pages secret put SHIP24_API_KEY` (locally: add it to `.dev.vars`).
3. `/api/health` shows `"SHIP24_API_KEY":"ok"`, and the Shipments page enables its buttons:
   - **Refresh tracking:** looks up lines that haven't arrived.
   - **Confirm estimated arrivals:** looks up arrived lines whose date is only a report estimate, to replace it with the carrier's delivery date. This uses quota for each new number, so run it per branch if quota is tight.

How it works:

- Each distinct tracking number is looked up once and applied to every PO line that shares it. Only recognized formats are looked up (unrecognized references would just use quota), and a number is re-checked at most every 6 hours.
- Refresh runs in batches of 20 numbers, because Workers' free plan allows 50 outbound requests per invocation; the app keeps calling until nothing is left (or Ship24 rate-limits, which pauses it).
- A delivery from tracking replaces report-based estimates but never a date entered by hand. A delivery dated before the line's ship date is ignored (carriers reuse numbers, especially 10-digit DHL ones).
- **DSV** house bills (`HKG…`, DBS-TW branch) go through Ship24 too; if coverage turns out poor, add a DSV provider using Wintec's DSV Track & Trace API access next to `ship24.ts` and list it first in `registry.ts`.
- Scheduled refresh: Pages Functions can't run on cron, so add a small Worker with a Cron Trigger that calls `refreshTracking()` in a loop.

## Scripts

| | |
|---|---|
| `pnpm test` | Vitest: parsing, mapping, dates, carrier detection, import planning, reports |
| `pnpm typecheck` | TypeScript |
| `pnpm db:generate` | New migration after editing `server/db/schema.ts` |
| `pnpm db:studio` | Browse the DB |
