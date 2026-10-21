import { z } from 'zod';
import { TrackingRateLimitError } from '../provider';

/**
 * TrackingMore API V4 client (https://www.trackingmore.com/docs/trackingmore). Formats are taken from
 * TrackingMore's official SDKs (github.com/TrackingMore-API, Go SDK `couriers.go` / `trackings.go`):
 *
 * - Every response is an envelope `{ meta: { code, message }, data }`; `meta.code` 200 means success.
 * - Auth: header `Tracking-Api-Key`.
 * - GET  /couriers/all                   -> data: Courier[]
 * - POST /couriers/detect {tracking_number} -> data: Courier[] (meta 4121 = cannot detect)
 * - POST /trackings/create {tracking_number, courier_code, ...} -> data: Tracking (1 credit; meta 4101 = already exists)
 * - POST /trackings/batch [≤40 x create params] -> data: { success: Item[], error: Item[] } (per-item errorCode)
 * - GET  /trackings/get?tracking_numbers=a,b&courier_code=… (≤40) -> data: Tracking[] (free; meta 4102 = never created)
 *
 * Error codes (SDK READMEs): 4101 exists, 4102 not created, 4103 >40 per call, 4110 invalid number,
 * 4111 number required, 4120 invalid courier, 4121 cannot detect, 4122 courier needs extra fields,
 * 4190 quota exhausted, 401 bad key, 403 forbidden, 429 rate limited, 511–513 server errors.
 */
export const TRACKINGMORE_BASE_URL = 'https://api.trackingmore.com/v4';
/** Max numbers per batch create / get call. */
export const TRACKINGMORE_MAX_PER_CALL = 40;

export const TM_CODES = {
  ok: 200,
  alreadyExists: 4101,
  notCreated: 4102,
  tooMany: 4103,
  invalidNumber: 4110,
  numberRequired: 4111,
  invalidCourier: 4120,
  cannotDetect: 4121,
  extraFieldsRequired: 4122,
  quotaExhausted: 4190,
} as const;

// ─── Errors ───────────────────────────────────────────────────────────────────────────────────────

/** Any TrackingMore failure; `code` is the meta code (or HTTP status when there was no envelope). */
export class TrackingMoreError extends Error {
  constructor(
    message: string,
    public code: number,
    public httpStatus: number,
  ) {
    super(message);
    this.name = 'TrackingMoreError';
  }
  /** Worth retrying later (server errors, network trouble). */
  get transient() {
    return this.httpStatus === 0 || this.httpStatus >= 500 || (this.code >= 500 && this.code < 600);
  }
}
/** 401/403: the key is wrong or lacks permission. Never retried automatically. */
export class TrackingMoreAuthError extends TrackingMoreError {}
/** 4190: the plan's tracking quota is used up; registrations stop until the plan is upgraded. */
export class TrackingMoreQuotaError extends TrackingMoreError {}

// ─── Response validation (lenient: a malformed field becomes null, it never fails the whole item) ─

const str = z.string().nullish().catch(null);
const looseStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .nullish()
  .catch(null);

export const courierSchema = z.object({
  courier_name: str,
  courier_code: z.string().min(1),
  courier_country_iso2: looseStr,
  courier_url: str,
  courier_type: str,
  tracking_required_fields: z.unknown().optional(),
});
export type TrackingMoreCourier = z.infer<typeof courierSchema>;

export const checkpointSchema = z.object({
  checkpoint_date: str,
  checkpoint_delivery_status: str,
  checkpoint_delivery_substatus: str,
  tracking_detail: str,
  location: str,
  country_iso2: str,
  state: str,
  city: str,
  zip: str,
  raw_status: str,
});
export type TrackingMoreCheckpoint = z.infer<typeof checkpointSchema>;

const milestoneSchema = z
  .object({
    inforeceived_date: str,
    pickup_date: str,
    outfordelivery_date: str,
    delivery_date: str,
    returning_date: str,
    returned_date: str,
  })
  .partial()
  .nullish()
  .catch(null);

/** Keeps the checkpoints that parse; a broken one is dropped rather than failing the whole tracking. */
const checkpointList = z
  .array(z.unknown())
  .nullish()
  .catch(null)
  .transform((items) =>
    (items ?? []).flatMap((c) => {
      const parsed = checkpointSchema.safeParse(c);
      return parsed.success ? [parsed.data] : [];
    }),
  );

const legInfoSchema = z
  .object({
    courier_code: str,
    weblink: str,
    reference_number: str,
    milestone_date: milestoneSchema,
    trackinfo: checkpointList,
  })
  .partial()
  .nullish()
  .catch(null);

export const trackingSchema = z.object({
  id: looseStr,
  tracking_number: z.string().min(1),
  courier_code: str,
  created_at: str,
  update_at: str,
  delivery_status: str,
  substatus: str,
  status_info: str,
  latest_event: str,
  latest_checkpoint_time: str,
  scheduled_delivery_date: str,
  archived: looseStr,
  updating: z.boolean().nullish().catch(null),
  origin_info: legInfoSchema,
  destination_info: legInfoSchema,
});
export type TrackingMoreTracking = z.infer<typeof trackingSchema>;

const batchItemSchema = z.object({
  id: looseStr,
  tracking_number: str,
  courier_code: str,
  errorCode: z.number().nullish().catch(null),
  errorMessage: str,
});
export type TrackingMoreBatchItem = z.infer<typeof batchItemSchema>;

const envelopeSchema = z.object({
  meta: z.object({ code: z.number(), message: z.string().nullish() }),
  data: z.unknown().optional(),
});

/** Parses each array element on its own, dropping (and counting) invalid ones. */
function parseList<T>(schema: z.ZodType<T>, data: unknown): { items: T[]; invalid: number } {
  const list = Array.isArray(data) ? data : [];
  const items: T[] = [];
  let invalid = 0;
  for (const raw of list) {
    const parsed = schema.safeParse(raw);
    if (parsed.success) items.push(parsed.data);
    else invalid++;
  }
  return { items, invalid };
}

// ─── Client ───────────────────────────────────────────────────────────────────────────────────────

export interface CreateTrackingParams {
  tracking_number: string;
  courier_code: string;
}

export type CreateOutcome =
  | { outcome: 'created'; tracking: TrackingMoreTracking | null; id: string | null }
  | { outcome: 'exists' };

export interface BatchCreateResult {
  success: TrackingMoreBatchItem[];
  /** Per-number failures; `errorCode` 4101 (already exists) is not really a failure. */
  error: TrackingMoreBatchItem[];
}

export interface TrackingMoreClient {
  listCouriers(): Promise<TrackingMoreCourier[]>;
  detectCouriers(trackingNumber: string): Promise<TrackingMoreCourier[]>;
  createTracking(params: CreateTrackingParams): Promise<CreateOutcome>;
  batchCreate(params: CreateTrackingParams[]): Promise<BatchCreateResult>;
  getTrackings(query: { trackingNumbers: string[]; courierCode?: string }): Promise<TrackingMoreTracking[]>;
}

export function trackingMoreClient(apiKey: string, fetchImpl: typeof fetch = fetch, baseUrl = TRACKINGMORE_BASE_URL): TrackingMoreClient {
  async function call(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string>; body?: unknown } = {}) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers: { 'Tracking-Api-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      throw new TrackingMoreError(`TrackingMore unreachable: ${err instanceof Error ? err.message : String(err)}`, 0, 0);
    }
    // A proxy in front of the API can answer 401/403/429/5xx without a JSON body, so check the status first.
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const envelope = envelopeSchema.safeParse(json);
    const code = envelope.success ? envelope.data.meta.code : res.status;
    const message = (envelope.success && envelope.data.meta.message) || res.statusText || `HTTP ${res.status}`;

    if (res.status === 429 || code === 429) {
      const retry = Number(res.headers.get('retry-after'));
      throw new TrackingRateLimitError(Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    if (res.status === 401 || res.status === 403 || code === 401 || code === 403) {
      throw new TrackingMoreAuthError(`TrackingMore rejected the API key (${code})`, code, res.status);
    }
    if (code === TM_CODES.quotaExhausted) {
      throw new TrackingMoreQuotaError('TrackingMore tracking quota is used up; upgrade the plan to register more', code, res.status);
    }
    if (!envelope.success) {
      throw new TrackingMoreError(`TrackingMore returned an unreadable response (HTTP ${res.status})`, res.status, res.status);
    }
    return { code, message, data: envelope.data.data, httpStatus: res.status };
  }

  const fail = (r: { code: number; message: string; httpStatus: number }, what: string) =>
    new TrackingMoreError(`TrackingMore ${what} failed: ${r.message} (${r.code})`, r.code, r.httpStatus);

  return {
    async listCouriers() {
      const r = await call('GET', '/couriers/all');
      if (r.code !== TM_CODES.ok) throw fail(r, 'courier list');
      return parseList(courierSchema, r.data).items;
    },

    async detectCouriers(trackingNumber) {
      const r = await call('POST', '/couriers/detect', { body: { tracking_number: trackingNumber } });
      if (r.code === TM_CODES.cannotDetect || r.code === TM_CODES.invalidNumber) return [];
      if (r.code !== TM_CODES.ok) throw fail(r, 'courier detection');
      return parseList(courierSchema, r.data).items;
    },

    async createTracking(params) {
      const r = await call('POST', '/trackings/create', { body: params });
      if (r.code === TM_CODES.alreadyExists) return { outcome: 'exists' };
      if (r.code !== TM_CODES.ok) throw fail(r, 'registration');
      const parsed = trackingSchema.safeParse(r.data);
      const id = (r.data as { id?: unknown } | null)?.id;
      return {
        outcome: 'created',
        tracking: parsed.success ? parsed.data : null,
        id: parsed.success ? parsed.data.id ?? null : typeof id === 'string' ? id : null,
      };
    },

    async batchCreate(params) {
      if (params.length > TRACKINGMORE_MAX_PER_CALL) throw new Error(`At most ${TRACKINGMORE_MAX_PER_CALL} numbers per TrackingMore batch`);
      if (!params.length) return { success: [], error: [] };
      const r = await call('POST', '/trackings/batch', { body: params });
      if (r.code !== TM_CODES.ok) throw fail(r, 'batch registration');
      const data = (r.data ?? {}) as { success?: unknown; error?: unknown };
      return { success: parseList(batchItemSchema, data.success).items, error: parseList(batchItemSchema, data.error).items };
    },

    async getTrackings({ trackingNumbers, courierCode }) {
      if (trackingNumbers.length > TRACKINGMORE_MAX_PER_CALL) throw new Error(`At most ${TRACKINGMORE_MAX_PER_CALL} numbers per TrackingMore get`);
      if (!trackingNumbers.length) return [];
      const r = await call('GET', '/trackings/get', {
        query: { tracking_numbers: trackingNumbers.join(','), ...(courierCode ? { courier_code: courierCode } : {}) },
      });
      if (r.code === TM_CODES.notCreated) return [];
      if (r.code !== TM_CODES.ok) throw fail(r, 'tracking retrieval');
      const { items, invalid } = parseList(trackingSchema, r.data);
      if (invalid) console.warn(`TrackingMore: ignored ${invalid} malformed tracking item(s)`);
      return items;
    },
  };
}
