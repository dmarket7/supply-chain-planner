/**
 * Looks up FedEx tracking numbers with the credentials in .dev.vars and prints what the app would save.
 * Touches no database. Usage: pnpm fedex:check <tracking number> [ship date YYYY-MM-DD] [more numbers…]
 */
import fs from 'node:fs';
import { fedexProvider, type FedExEnvironment } from '../server/tracking/fedex';

const vars = Object.fromEntries(
  (fs.existsSync('.dev.vars') ? fs.readFileSync('.dev.vars', 'utf8') : '')
    .split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);
const clientId = vars.FEDEX_CLIENT_ID;
const clientSecret = vars.FEDEX_CLIENT_SECRET;
const environment = (vars.FEDEX_ENV || 'sandbox').toLowerCase() as FedExEnvironment;
if (!clientId || !clientSecret) {
  console.error('Add FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET (and optionally FEDEX_ENV) to .dev.vars first.');
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: pnpm fedex:check <tracking number> [ship date YYYY-MM-DD] [more numbers…]');
  process.exit(1);
}
const requests: { trackingNumber: string; shipDate: string | null }[] = [];
for (const a of args) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(a) && requests.length) requests[requests.length - 1].shipDate = a;
  else requests.push({ trackingNumber: a.replace(/\s+/g, ''), shipDate: null });
}

console.log(`FedEx ${environment}: looking up ${requests.length} number(s)…`);
const results = await fedexProvider({ clientId, clientSecret, environment })
  .track(requests.map((r) => ({ ...r, carrier: 'FedEx', mode: 'parcel' })))
  .catch((err: unknown) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
for (const r of requests) {
  const found = results.find((x) => x.trackingNumber === r.trackingNumber);
  console.log(`\n${r.trackingNumber}${r.shipDate ? ` (shipped ~${r.shipDate})` : ''}`);
  if (!found) {
    console.log('  not found');
    continue;
  }
  console.log(`  status:    ${found.status ?? '(no information yet)'}`);
  console.log(`  ETA:       ${found.estimatedArrivalDate ?? '—'}`);
  console.log(`  delivered: ${found.deliveredAt ?? '—'}`);
  for (const e of found.events.slice(0, 8)) {
    console.log(`  · ${e.occurredAt.slice(0, 16).replace('T', ' ')}  ${e.description ?? e.status}${e.location ? `  (${e.location})` : ''}`);
  }
  if (found.events.length > 8) console.log(`  … ${found.events.length - 8} more scans`);
}
