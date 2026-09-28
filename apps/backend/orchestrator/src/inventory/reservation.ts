import { Pool } from "pg";
import { Redis } from "ioredis";
import Redlock from "redlock";

export interface InventoryReservationItem {
  merchantId: string;
  productId: string;
  quantity: number;
}

export class InsufficientStockError extends Error {
  constructor(public readonly productId: string) {
    super(`Insufficient stock for product ${productId}`);
    this.name = "InsufficientStockError";
  }
}

interface ReservationLock {
  acquire(resources: string[], duration: number): Promise<{ release(): Promise<unknown> }>;
}

export class InventoryReservationService {
  constructor(
    private readonly pool: Pick<Pool, "connect">,
    private readonly redlock: ReservationLock,
  ) {}

  async reserve(items: InventoryReservationItem[]): Promise<void> {
    await this.updateReservation(items, "reserve");
  }

  async release(items: InventoryReservationItem[]): Promise<void> {
    await this.updateReservation(items, "release");
  }

  private async updateReservation(
    items: InventoryReservationItem[],
    operation: "reserve" | "release",
  ): Promise<void> {
    if (items.length === 0) return;
    for (const item of items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new Error("Inventory reservation quantities must be positive integers");
      }
    }

    const orderedItems = [...items].sort((left, right) =>
      `${left.merchantId}:${left.productId}`.localeCompare(`${right.merchantId}:${right.productId}`),
    );
    const resources = [...new Set(orderedItems.map(
      (item) => `inventory:${item.merchantId}:${item.productId}`,
    ))];
    const lock = await this.redlock.acquire(resources, 10_000);
    let client: Awaited<ReturnType<Pool["connect"]>> | undefined;

    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      for (const item of orderedItems) {
        const { rows } = await client.query<{ id: string; available_stock: number; reserved_stock: number }>(
          "SELECT id, available_stock, reserved_stock FROM merchant_inventory WHERE merchant_id = $1 AND product_id = $2 FOR UPDATE",
          [item.merchantId, item.productId],
        );
        const inventory = rows[0];
        if (!inventory || (operation === "reserve" && inventory.available_stock < item.quantity)) {
          throw new InsufficientStockError(item.productId);
        }
        if (operation === "release" && inventory.reserved_stock < item.quantity) {
          throw new Error(`Cannot release more than the reserved stock for product ${item.productId}`);
        }
        const stockChange = operation === "reserve"
          ? "available_stock = available_stock - $2, reserved_stock = reserved_stock + $2"
          : "available_stock = available_stock + $2, reserved_stock = reserved_stock - $2";
        const stockGuard = operation === "reserve" ? "available_stock >= $2" : "reserved_stock >= $2";
        await client.query(
          `UPDATE merchant_inventory SET ${stockChange}, updated_at = NOW() WHERE id = $1 AND ${stockGuard}`,
          [inventory.id, item.quantity],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client?.release();
      await lock.release();
    }
  }
}

let reservationService: InventoryReservationService | undefined;

export function getInventoryReservationService(): InventoryReservationService {
  if (!reservationService) {
    const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true });
    reservationService = new InventoryReservationService(
      new Pool({ connectionString: process.env.DATABASE_URL }),
      new Redlock([redis as never]) as unknown as ReservationLock,
    );
  }
  return reservationService;
}