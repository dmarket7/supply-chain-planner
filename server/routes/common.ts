import { shipments, suppliers } from '../db/schema';

/** Column selection that yields the shared `Shipment` shape (join suppliers on supplierId). */
export const shipmentColumns = {
  id: shipments.id,
  supplier: suppliers.name,
  poNumber: shipments.poNumber,
  lineRef: shipments.lineRef,
  itemDescription: shipments.itemDescription,
  quantity: shipments.quantity,
  carrier: shipments.carrier,
  mode: shipments.mode,
  trackingNumber: shipments.trackingNumber,
  shipDate: shipments.shipDate,
  promisedArrivalDate: shipments.promisedArrivalDate,
  estimatedArrivalDate: shipments.estimatedArrivalDate,
  actualArrivalDate: shipments.actualArrivalDate,
  arrivalSource: shipments.arrivalSource,
  status: shipments.status,
  lastTrackedAt: shipments.lastTrackedAt,
};

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
