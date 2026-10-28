import { and, eq, getTableColumns, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { orderLineKey } from '../shared/orderChanges';
import { checkSupply, siteOf, type SupplyCheck } from '../shared/supply';
import type { OrderChangeRow, OutboundOrderInput, Shipment } from '../shared/types';
import type { Db } from './db/client';
import { inventoryPositions, outboundChanges, outboundOrders, palletRatios, shipments, suppliers } from './db/schema';
import { currentInventory } from './inventory';
import { currentSnapshot } from './outbound';
import { expectedArrival } from './reports';
import { NO_BRANCH, shipmentColumns } from './routes/common';

export type LoadedOrder = OutboundOrderInput & { id: number; itemName: string | null };

/**
 * Everything the supply check needs, for one branch or all: the current outbound orders and
 * inventory, and open PO lines (not arrived, not closed). Stock and inbound are matched by site, so
 * a branch filter keeps its quarantine branches.
 */
export async function loadSupply(db: Db, branch: string | undefined) {
  const [outbound, inventory] = await Promise.all([currentSnapshot(db), currentInventory(db)]);
  const { snapshotId: _s, ...orderColumns } = getTableColumns(outboundOrders);
  const site = branch && branch !== NO_BRANCH ? siteOf(branch) : null;
  const [orderRows, positions, inboundRows, changeRows] = await Promise.all([
    outbound
      ? db
          .select({ ...orderColumns, itemName: palletRatios.itemName })
          .from(outboundOrders)
          .leftJoin(palletRatios, eq(palletRatios.partNumber, outboundOrders.cpn))
          .where(
            and(
              eq(outboundOrders.snapshotId, outbound.id),
              !branch ? undefined : branch === NO_BRANCH ? isNull(outboundOrders.warehouse) : eq(outboundOrders.warehouse, branch),
            ),
          )
      : [],
    inventory ? db.select().from(inventoryPositions).where(eq(inventoryPositions.snapshotId, inventory.id)) : [],
    db
      .select(shipmentColumns)
      .from(shipments)
      .innerJoin(suppliers, eq(suppliers.id, shipments.supplierId))
      .where(and(isNull(shipments.actualArrivalDate), or(isNull(shipments.poStatus), ne(shipments.poStatus, 'closed')), isNotNull(shipments.partNumber))),
    outbound ? db.select().from(outboundChanges).where(eq(outboundChanges.snapshotId, outbound.id)) : [],
  ]);
  // What changed on each SO# + CPN since the previous report.
  const changes = new Map<string, OrderChangeRow[]>();
  for (const ch of changeRows) {
    const key = orderLineKey(ch.soNumber, ch.cpn);
    const list = changes.get(key) ?? [];
    list.push({ kind: ch.kind, from: ch.fromValue, to: ch.toValue, causes: ch.causes });
    changes.set(key, list);
  }
  const orders = orderRows as LoadedOrder[];
  const inSite = (b: string | null) => !branch || (site ? siteOf(b) === site : !b);
  const stock = positions.filter((p) => inSite(p.branch));
  const inbound = (inboundRows as Shipment[]).filter((s) => inSite(s.branch));
  const check: SupplyCheck | null = inventory
    ? checkSupply(stock, orders, inbound.map((s) => ({ id: s.id, partNumber: s.partNumber, branch: s.branch, quantity: s.quantity, eta: expectedArrival(s), shipDate: s.shipDate })))
    : null;
  return { outbound, inventory, orders, inbound, positions: stock, check, changes };
}
