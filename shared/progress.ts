import type { LineChange } from './types';

/** How upload changes are grouped for summaries and filters. */
export const PROGRESS_BUCKETS = ['shipped', 'arrived', 'eta_moved', 'tracking', 'new_order', 'reopened'] as const;
export type ProgressBucket = (typeof PROGRESS_BUCKETS)[number];

export const PROGRESS_BUCKET_LABELS: Record<ProgressBucket, string> = {
  shipped: 'Shipped',
  arrived: 'Arrived (closed)',
  eta_moved: 'ETA moved',
  tracking: 'Tracking added',
  new_order: 'New, not shipped',
  reopened: 'Reopened',
};

/** Buckets one line falls in for one upload's changes. Mirrored in SQL by `bucketCountsSql`. */
export function bucketsOf(changes: LineChange[]): ProgressBucket[] {
  const out = new Set<ProgressBucket>();
  for (const c of changes) {
    if (c.kind === 'shipped' || (c.kind === 'new' && c.to === 'in_transit')) out.add('shipped');
    if (c.kind === 'closed' || (c.kind === 'new' && c.to === 'delivered')) out.add('arrived');
    if (c.kind === 'eta_changed') out.add('eta_moved');
    if (c.kind === 'tracking_added' || c.kind === 'tracking_changed') out.add('tracking');
    if (c.kind === 'new' && (c.to === 'awaiting_shipment' || c.to === 'pending')) out.add('new_order');
    if (c.kind === 'reopened') out.add('reopened');
  }
  return [...out];
}

export type ProgressCounts = Record<ProgressBucket, number>;
