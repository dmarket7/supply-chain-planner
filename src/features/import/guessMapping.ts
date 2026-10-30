import type { ColumnMapping, TargetField } from '../../../shared/types';

export const FIELD_LABELS: Record<TargetField, string> = {
  supplier: 'Supplier',
  poNumber: 'PO number',
  lineRef: 'PO line',
  asn: 'ASN / delivery number',
  poStatus: 'PO status (open / closed)',
  trackingNumber: 'Tracking number',
  carrier: 'Carrier',
  promisedArrivalDate: 'ETA (supplier promised arrival)',
  shipDate: 'Ship date (ETD)',
  requestDate: 'Customer request date (CRD)',
  actualArrivalDate: 'Actual arrival date',
  customerPo: 'Customer PO',
  partNumber: 'Part number',
  itemDescription: 'Item description',
  commodity: 'Commodity',
  branch: 'Branch',
  warehouse: 'Warehouse',
  quantity: 'Quantity',
};

export const REQUIRED_FIELDS: TargetField[] = ['supplier'];

/** A mapping can be imported once it has the required fields, a way to identify lines and a date or status. */
export const mappingComplete = (m: ColumnMapping) => REQUIRED_FIELDS.every((f) => m[f]) && !!(m.trackingNumber || m.poNumber) && !!(m.promisedArrivalDate || m.poStatus);

/** Columns that matter most for the report; shown first in the mapper. */
export const PRIMARY_FIELDS: TargetField[] = ['branch', 'supplier', 'poNumber', 'lineRef', 'asn', 'poStatus', 'trackingNumber', 'carrier', 'promisedArrivalDate', 'shipDate'];

/**
 * Normalized header synonyms, most specific first. Includes the Meerkat "Supplier POs" headers
 * (WintecPO, WintecPOLine, ETADate, ETDDate, CRD, Tracking Num, …).
 */
const SYNONYMS: Record<TargetField, string[]> = {
  supplier: ['suppliername', 'supplier', 'vendorname', 'vendor', 'shipper', 'manufacturer'],
  poNumber: ['wintecpo', 'ponumber', 'po', 'pono', 'purchaseorder', 'purchaseordernumber', 'ordernumber'],
  lineRef: ['wintecpoline', 'poline', 'line', 'lineno', 'linenumber'],
  asn: ['asn', 'asnnumber', 'deliverynumber', 'delivery', 'packslipid', 'packingslip'],
  poStatus: ['postatus', 'status', 'linestatus', 'orderstatus'],
  trackingNumber: ['trackingnum', 'trackingnumber', 'tracking', 'trackingno', 'trackingid', 'pro', 'pronumber', 'prono', 'bol', 'waybill', 'awb'],
  carrier: ['carrier', 'carriername', 'shipvia', 'via', 'freightcarrier', 'forwarder', 'scac'],
  promisedArrivalDate: ['etadate', 'eta', 'promisedarrivaldate', 'promiseddate', 'promised', 'estimatedarrival', 'expecteddate', 'expectedarrival', 'duedate', 'deliverydate', 'arrivaldate', 'needby'],
  shipDate: ['etddate', 'etd', 'shipdate', 'shipped', 'dateshipped', 'shippeddate', 'pickupdate'],
  requestDate: ['crd', 'requestdate', 'customerrequestdate', 'requestedshipdate'],
  actualArrivalDate: ['actualarrivaldate', 'actualarrival', 'receiveddate', 'datereceived', 'received', 'delivereddate', 'receiptdate'],
  customerPo: ['metapo', 'customerpo', 'custpo'],
  partNumber: ['wintecpn', 'partnumber', 'pn', 'sku', 'itemnumber'],
  itemDescription: ['description', 'itemdescription', 'item', 'material'],
  commodity: ['commodity', 'category'],
  branch: ['branch', 'branchcode', 'site', 'plant', 'warehouseid'],
  warehouse: ['warehouselocation', 'warehouse', 'shipto', 'location'],
  quantity: ['poorderqty', 'quantity', 'qty', 'orderqty', 'qtyshipped', 'units'],
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
