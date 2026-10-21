/**
 * Fetches TrackingMore's supported courier list with the key in .env and shows the candidate
 * courier codes for the carriers we care about. Read-only: it registers nothing and uses no credits.
 * Usage: pnpm trackingmore:couriers [extra carrier names…] [--detect <tracking number>…]
 */
import { courierCandidates } from '../server/tracking/couriers';
import { trackingMoreClient } from '../server/tracking/trackingmore/client';
import { loadEnv } from './env';

const apiKey = loadEnv().TRACKINGMORE_API_KEY;
if (!apiKey) {
  console.error('Add TRACKINGMORE_API_KEY to .env first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const detectAt = args.indexOf('--detect');
const extra = detectAt === -1 ? args : args.slice(0, detectAt);
const toDetect = detectAt === -1 ? [] : args.slice(detectAt + 1);
const carriers = ['DSV', 'Say Cargo', 'JTC Express', 'Expeditors', 'Sinotrans', 'LOTTE Global Logistics', 'FedEx', 'FedEx Freight', 'UPS', 'DHL', ...extra];

const client = trackingMoreClient(apiKey);
try {
  const list = await client.listCouriers();
  console.log(`TrackingMore supports ${list.length} couriers.\n`);
  const options = list.map((c) => ({ courierCode: c.courier_code, name: c.courier_name ?? c.courier_code }));
  for (const carrier of carriers) {
    const r = courierCandidates(carrier, options);
    const status = !r.candidates.length ? 'NOT FOUND' : r.ambiguous ? 'AMBIGUOUS: pick the right service' : `match: ${r.suggested}`;
    console.log(`${carrier}: ${status}`);
    for (const c of r.candidates.slice(0, 8)) console.log(`    ${c.courierCode.padEnd(28)} ${c.name}  (score ${c.score})`);
  }
  for (const n of toDetect) {
    const found = await client.detectCouriers(n);
    console.log(`\ndetect ${n}: ${found.length ? found.map((c) => `${c.courier_code} (${c.courier_name})`).join(', ') : 'no candidates'}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
