import { eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Shipment } from '../../shared/types';
import { lineChanges, shipments, suppliers } from '../db/schema';

/** Value the UI sends for lines whose report had no branch. */
export const NO_BRANCH = '(none)';

/** Filter for the `branch` query parameter; undefined = all branches. */
export function branchFilter(branch: string | undefined): SQL | undefined {
  if (!branch) return undefined;
  return branch === NO_BRANCH ? isNull(shipments.branch) : eq(shipments.branch, branch);
}

/** Column selection that yields the shared `Shipment` shape (join suppliers on supplierId). */
export const shipmentColumns = {
  id: shipments.id,
  supplier: suppliers.name,
  poNumber: shipments.poNumber,
  lineRef: shipments.lineRef,
  asn: shipments.asn,
  poStatus: shipments.poStatus,
  customerPo: shipments.customerPo,
  partNumber: shipments.partNumber,
  itemDescription: shipments.itemDescription,
  commodity: shipments.commodity,
  branch: shipments.branch,
  warehouse: shipments.warehouse,
  quantity: shipments.quantity,
  carrier: shipments.carrier,
  mode: shipments.mode,
  trackingNumber: shipments.trackingNumber,
  trackingRef: shipments.trackingRef,
  requestDate: shipments.requestDate,
  shipDate: shipments.shipDate,
  promisedArrivalDate: shipments.promisedArrivalDate,
  estimatedArrivalDate: shipments.estimatedArrivalDate,
  actualArrivalDate: shipments.actualArrivalDate,
  arrivalSource: shipments.arrivalSource,
  arrivalWindowStart: shipments.arrivalWindowStart,
  arrivalWindowEnd: shipments.arrivalWindowEnd,
  status: shipments.status,
  lastTrackedAt: shipments.lastTrackedAt,
  trackingProvider: shipments.trackingProvider,
  trackingFound: shipments.trackingFound,
  trackedCarrier: shipments.trackedCarrier,
  trackingChangedAt: shipments.trackingChangedAt,
  trackingRunId: shipments.trackingRunId,
  lastEventAt: shipments.lastEventAt,
  arrivalSetBy: shipments.arrivalSetBy,
  arrivalSetAt: shipments.arrivalSetAt,
  courierOverride: shipments.courierOverride,
  trackingRegistrationId: shipments.trackingRegistrationId,
  /** Changes from the latest upload that changed this line (uses line_changes_shipment_idx). */
  latestChange: sql<Shipment['latestChange']>`(
    select json_build_object(
      'importId', lc.import_id,
      'reportDate', lc.report_date,
      'changes', json_agg(json_build_object('kind', lc.kind, 'from', lc.from_value, 'to', lc.to_value) order by lc.id)
    )
    from ${lineChanges} lc
    where lc.shipment_id = ${shipments.id}
      and lc.report_date = (select max(l2.report_date) from ${lineChanges} l2 where l2.shipment_id = ${shipments.id})
    group by lc.import_id, lc.report_date
    limit 1
  )`,
};

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
