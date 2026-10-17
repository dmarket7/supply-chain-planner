import type { ColumnMapping, TargetField } from '../../../shared/types';

export const FIELD_LABELS: Record<TargetField, string> = {
  supplier: 'Supplier',
  poNumber: 'PO number',
  lineRef: 'PO line / reference',
  itemDescription: 'Item description',
  quantity: 'Quantity',
  carrier: 'Carrier',
  trackingNumber: 'Tracking / PRO number',
  shipDate: 'Ship date',
  promisedArrivalDate: 'Promised arrival date',
  actualArrivalDate: 'Actual arrival date',
};

export const REQUIRED_FIELDS: TargetField[] = ['supplier', 'promisedArrivalDate'];

/** Normalized header synonyms, most specific first. Tune once the real report is available. */
const SYNONYMS: Record<TargetField, string[]> = {
  supplier: ['supplier', 'suppliername', 'vendor', 'vendorname', 'shipper', 'manufacturer'],
  poNumber: ['ponumber', 'po', 'pono', 'purchaseorder', 'purchaseordernumber', 'order', 'ordernumber'],
  lineRef: ['poline', 'line', 'lineno', 'linenumber', 'reference', 'ref'],
  itemDescription: ['itemdescription', 'description', 'item', 'part', 'partnumber', 'sku', 'material'],
  quantity: ['quantity', 'qty', 'qtyshipped', 'units', 'cartons'],
  carrier: ['carrier', 'carriername', 'shipvia', 'via', 'freightcarrier', 'scac'],
  trackingNumber: ['trackingnumber', 'tracking', 'trackingno', 'trackingid', 'pro', 'pronumber', 'prono', 'bol', 'waybill', 'awb'],
  shipDate: ['shipdate', 'shipped', 'dateshipped', 'shippeddate', 'pickupdate'],
  promisedArrivalDate: ['promisedarrivaldate', 'promiseddate', 'promised', 'eta', 'estimatedarrival', 'expecteddate', 'expectedarrival', 'duedate', 'deliverydate', 'arrivaldate', 'needby'],
  actualArrivalDate: ['actualarrivaldate', 'actualarrival', 'receiveddate', 'datereceived', 'received', 'delivereddate'],
};

const norm = (s: string) => s.toLowerCase().replace(/#/g, 'number').replace(/[^a-z0-9]/g, '');

/**
 * Exact synonym matches first, then "header contains synonym" trying the longest synonyms first
 * (so "Actual Arrival Date" goes to actualArrivalDate, not promised's "arrivaldate").
 * Each header is used at most once.
 */
export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  const normalized = headers.map((h) => [h, norm(h)] as const);
  const assign = (field: TargetField, header: string) => {
    mapping[field] = header;
    used.add(header);
  };

  for (const field of Object.keys(SYNONYMS) as TargetField[]) {
    for (const syn of SYNONYMS[field]) {
      const hit = normalized.find(([h, n]) => !used.has(h) && n === syn);
      if (hit) {
        assign(field, hit[0]);
        break;
      }
    }
  }

  const bySpecificity = (Object.entries(SYNONYMS) as [TargetField, string[]][])
    .flatMap(([field, syns]) => syns.filter((s) => s.length >= 3).map((syn) => ({ field, syn })))
    .sort((a, b) => b.syn.length - a.syn.length);
  for (const { field, syn } of bySpecificity) {
    if (mapping[field]) continue;
    const hit = normalized.find(([h, n]) => !used.has(h) && n.includes(syn));
    if (hit) assign(field, hit[0]);
  }
  return mapping;
}
