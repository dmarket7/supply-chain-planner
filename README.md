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

1. A date **entered by hand** (shown with an orange dot, with who entered it), or carrier tracking once carrier APIs are connected. These are confirmed and never overwritten by a report.
2. **Between reports:** the line was Open in one report and Closed in the next, so it arrived in that window. The estimate is the supplier's ETA moved into the window: ETA before it → the window's first day (late); ETA after it → the report date (early).
3. **Assumed on ETA:** the line was already Closed the first time it was imported. This says nothing about punctuality, so these lines are left out of the supplier scorecard unless "Include ETA-assumed arrivals" is ticked.

On-time performance is measured against the **first ETA** the supplier gave. Later ETA changes are logged as slips.

## Branches

Every line carries the report's **Branch** (ERP warehouse ID, e.g. `JIT-MSUS-META`). The branch selector in the header filters every page and is remembered in the browser. With "All branches" selected, the Inbound page shows a per-branch summary (due today, next 7 days, past due, awaiting shipment, arrived in the last 30 days); click a row to switch to that branch. Lines imported without a branch appear as `(none)`.

## Progress across uploads

Each upload is compared with what the previous ones said, and every change is logged per line (`line_changes`):

- **Listed** for the first time (not shipped / shipped / already closed)
- **Shipped**: a line is listed under an ASN where the previous report had that PO line awaiting shipment. The awaiting line's history moves onto the shipped line, so its timeline starts at the order.
- **ETA moved** / **ship date moved** (from → to), **tracking added or changed**
- **Closed** (= received; the arrival estimate is shown) and **reopened**

The Shipments page shows a summary of the latest upload ("Since the Oct 18 report: 43 shipped, 41 arrived, …"); click a number to list those lines. Lines changed by the latest upload are tinted violet, the **Latest change** column says what changed, and the detail panel shows the line's full timeline across uploads. After an import, **See what changed** opens the same view.

Lines in uploads made before this log existed get a reconstructed history: when they were first listed, when they closed, and supplier ETA changes.

## Carrier tracking

Two kinds of tracking providers sit behind the `TrackingProvider` interface (`server/tracking/`), each enabled by its own secrets in `registry.ts`:

- **Direct carrier APIs** (FedEx): look up any number of their carrier, no registration.
- **TrackingMore** (multi-carrier aggregator): tracks a number only after it is **registered** with TrackingMore, and each registration uses one credit. Retrieving registered numbers is free.

When a provider is configured, the Shipments page shows **Refresh tracking**, **Confirm estimated arrivals**, a tracking filter, a tracking badge per line and the refresh history, and a line's detail panel gets its carrier tracking details and actions. The **Carrier tracking** page manages TrackingMore. Values from tracking get a cyan dot.

How refreshing works for every provider:

- Refresh works on **tracking identities**: a TrackingMore registration, or tracking number + carrier for direct APIs. Several PO lines sharing a number are one identity; the same number under another courier, or reused by a carrier for a later shipment, is a different one. Each identity goes to exactly one provider, at most every 6 hours, in batches of 20.
- Only lines whose carrier has a direct API, or that are linked to a registration still being tracked, are looked up. Unregistered, unresolved and unsupported carriers are skipped.
- Each scan is stored once (`tracking_events.event_key`), so repeated syncs add nothing and don't count as changes; late, older scans are kept without moving "latest scan" backwards.
- A delivery from tracking replaces report-based estimates but never a date entered by hand, and never the supplier's promise. A delivery dated before the line's ship date is ignored (carriers reuse numbers). "Delivered" without a delivery time is recorded as a warning, not turned into an arrival date. A failed lookup never erases an ETA, scans or a delivery date.
- Scheduled refresh: Pages Functions can't run on cron, so add a small Worker with a Cron Trigger that calls `refreshTracking()` in a loop.

### TrackingMore

API V4 (`https://api.trackingmore.com/v4`, header `Tracking-Api-Key`), implemented in `server/tracking/trackingmore/` with `fetch`. Response formats follow TrackingMore's official SDKs (`github.com/TrackingMore-API`): a `{ meta: { code, message }, data }` envelope; `4101` = already registered, `4102` = never registered, `4110`/`4120` = invalid number/courier, `4190` = quota used up, `401`/`403` = bad key, `429` = rate limited.

**Configure**

1. Create a TrackingMore account and API key.
2. Locally, add to `.env`: `TRACKINGMORE_API_KEY=…` and `TRACKINGMORE_ENABLED=true`. In production:
   ```sh
   pnpm wrangler pages secret put TRACKINGMORE_API_KEY
   pnpm wrangler pages secret put TRACKINGMORE_ENABLED   # true
   ```
   `/api/health` shows `"TRACKINGMORE": "ok"`. The key only lives on the server; neither the health check nor `/api/tracking/status` returns it. Setting `TRACKINGMORE_ENABLED` to anything else switches TrackingMore off without removing the key.
3. Check courier coverage with the real courier list (read-only, no credits):
   ```sh
   pnpm trackingmore:couriers                       # candidates for DSV, Expeditors, DHL, …
   pnpm trackingmore:couriers --detect CWF12345678901 PNS12345678
   ```

**Use**

1. **Carrier tracking → Sync from TrackingMore** stores the courier list (free).
2. In **Carrier coverage**, confirm the courier for each carrier. Generic values (Forwarder, Truck, Air cargo) are never mapped as a whole: forwarder references are split by prefix (`Forwarder · CWF…`) so each prefix can be mapped to its forwarder, or marked **Not supported**. Courier codes are only ever picked from TrackingMore's own list; matches are suggested, and ambiguous ones (e.g. DHL Express vs DHL eCommerce, FedEx vs FedEx Freight) must be chosen. A single shipment can also get its own courier from its detail panel (with TrackingMore's **Detect**); that choice applies to every line with the same number and carrier.

   Use the standard courier codes (`fedex`, `ups`, `dhl`). The "API" variants (`fedex-unified-api`, `ups-unified-api`, `dhl-unified-api`, …) only return scans once your own carrier account is connected in TrackingMore, so they are listed last and flagged. **Change courier** on a coverage row shows TrackingMore's **Detect** for one of its numbers and what switching costs: lines registered under the old courier are unlinked, and registering them under the new one uses a credit per number. Registrations with no scans more than 6 hours after registering are flagged as a possibly wrong courier.
3. **Register with TrackingMore**: pick shipments not arrived yet, or arrivals estimated from reports in the last 7–90 days. The preview shows how many new tracking numbers would be registered (= credits), lines that will only be linked to existing registrations (free), and what can't be tracked. Registering needs an explicit confirmation. Single shipments can be registered from their detail panel.
4. **Shipments → Refresh tracking** then fetches updates for registered numbers (free).

**Registration states** (`provider_trackings.state`) and how they show:

| State | Shown as | Meaning |
|---|---|---|
| (no registration) | Not registered | Courier known, not sent to TrackingMore yet |
| `registering` | Registered · awaiting data | Being sent right now |
| `awaiting_data` | Registered · awaiting data | Registered; no carrier scan yet (normal for the first hours) |
| `active` | Tracking active | TrackingMore returns tracking data |
| `unavailable` | Tracking unavailable | Still nothing 14 days after registering, or rejected as invalid |
| `expired` | Tracking expired | TrackingMore stopped tracking it |
| `register_failed`, `missing`, `conflict` | Tracking API error | Failed registration (retryable), deleted at TrackingMore (register again), or a reused number TrackingMore already tracks for an earlier shipment |

A recent sync error also shows as **Tracking API error**, so a failed call is never mistaken for "no data".

**Idempotency.** An identity is unique per provider + courier + number + episode (ship dates more than 120 days apart are separate episodes). Registration claims rows atomically, so double clicks, retries and two users at once never register an identity twice. If a request dies after TrackingMore accepted it, the stale claim is retried after 10 minutes and TrackingMore answers "already exists", which costs no credit.

**Status mapping**: `inforeceived` → Pending; `pending` → Pending once there are scans, otherwise no change; `transit` → In transit; `pickup` → Out for delivery; `delivered` → Delivered; `undelivered`/`exception` → Exception; `notfound` and `expired` leave the line's status alone. The raw status and substatus are kept on the registration.

### FedEx

Uses the FedEx Track API (`server/tracking/fedex.ts`): an OAuth token (cached for its hour), then up to 30 numbers per call, each with a ship-date window of ±30 days around the line's ETD so reused numbers resolve to the right shipment.

1. At [developer.fedex.com](https://developer.fedex.com), create a project with the **Track API** and copy its sandbox API key (client ID) and secret key.
2. Locally, add them to `.env` and check them without touching the database:
   ```sh
   pnpm fedex:check <tracking number> [ship date YYYY-MM-DD] …
   ```
   The sandbox only knows FedEx's test tracking numbers (listed in the Track API docs), not real shipments.
3. For real shipments, request production keys for the project (FedEx asks for a FedEx account number), then set them on Cloudflare:
   ```sh
   pnpm wrangler pages secret put FEDEX_CLIENT_ID
   pnpm wrangler pages secret put FEDEX_CLIENT_SECRET
   pnpm wrangler pages secret put FEDEX_ENV      # production
   ```
   `/api/health` shows `"FEDEX": "ok (production)"`. Without `FEDEX_ENV` the app uses the sandbox.

FedEx keeps tracking history for about 90 days after delivery, so older closed lines may come back "not found" and keep their report-based estimates.

## Scripts

| | |
|---|---|
| `pnpm test` | Vitest: parsing, mapping, dates, carrier detection, import planning, reports |
| `pnpm typecheck` | TypeScript |
| `pnpm db:generate` | New migration after editing `server/db/schema.ts` |
| `pnpm db:studio` | Browse the DB |
| `pnpm trackingmore:couriers [names] [--detect numbers]` | TrackingMore courier coverage with the key in `.env` (read-only, no credits) |
| `pnpm fedex:check <number> [ship date]` | Look up FedEx numbers with the keys in `.env`, without touching the DB |
