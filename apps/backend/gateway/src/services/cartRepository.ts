/**
 * Sequelize-backed storage for carts (Issue #574).
 *
 * The whole sync runs inside one transaction that holds a `FOR UPDATE` lock on
 * the cart row. Without that lock two devices syncing at the same time could
 * both read the same cart version and both write the same next version, which
 * is exactly the overwrite this endpoint is meant to prevent.
 */
import { Transaction } from "sequelize";
import { sequelize } from "../db.js";
import { Cart } from "../models/Cart.js";
import { CartItem } from "../models/CartItem.js";
import type { CartRecord, CartRepository, CartTransaction, StoredCartLine } from "./cartSyncService.js";
import { cartLineKey } from "./cartSyncService.js";

function toStoredLine(row: CartItem): StoredCartLine {
  return {
    merchantId: row.merchantId,
    productId: row.productId,
    skuId: row.skuId ? row.skuId : null,
    quantity: row.quantity,
    updatedAt: new Date(row.clientUpdatedAt),
    revision: row.revision,
  };
}

function createCartTransaction(transaction: Transaction): CartTransaction {
  return {
    async loadOrCreateCart(cartId: string, userId: string): Promise<CartRecord> {
      await Cart.findOrCreate({
        where: { id: cartId },
        defaults: { userId, version: 0 },
        transaction,
      });

      // Lock the row for the remainder of the transaction so a concurrent sync
      // from another device waits instead of racing us.
      const locked = await Cart.findOne({
        where: { id: cartId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      if (!locked) {
        // The row disappeared between the create and the lock.
        throw new Error(`Cart '${cartId}' could not be loaded`);
      }

      return { id: locked.id, userId: locked.userId, version: locked.version };
    },

    async listLines(cartId: string): Promise<StoredCartLine[]> {
      const rows = await CartItem.findAll({
        where: { cartId },
        transaction,
        order: [
          ["merchantId", "ASC"],
          ["productId", "ASC"],
          ["skuId", "ASC"],
        ],
      });
      return rows.map(toStoredLine);
    },

    async saveLines(cartId: string, lines: StoredCartLine[]): Promise<void> {
      if (lines.length === 0) return;

      const existing = await CartItem.findAll({ where: { cartId }, transaction });
      const existingByKey = new Map(
        existing.map((row) => [cartLineKey(row.merchantId, row.productId, row.skuId || null), row]),
      );

      for (const line of lines) {
        const skuId = line.skuId ?? "";
        const row = existingByKey.get(cartLineKey(line.merchantId, line.productId, skuId || null));
        if (row) {
          row.quantity = line.quantity;
          row.clientUpdatedAt = line.updatedAt;
          row.revision = line.revision;
          await row.save({ transaction });
          continue;
        }
        await CartItem.create(
          {
            cartId,
            merchantId: line.merchantId,
            productId: line.productId,
            skuId,
            quantity: line.quantity,
            clientUpdatedAt: line.updatedAt,
            revision: line.revision,
          },
          { transaction },
        );
      }
    },

    async setVersion(cartId: string, version: number): Promise<void> {
      await Cart.update({ version }, { where: { id: cartId }, transaction });
    },
  };
}

export const sequelizeCartRepository: CartRepository = {
  async runInTransaction<T>(fn: (tx: CartTransaction) => Promise<T>): Promise<T> {
    return sequelize.transaction(async (transaction) => fn(createCartTransaction(transaction)));
  },
};
