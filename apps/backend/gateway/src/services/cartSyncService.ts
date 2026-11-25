/**
 * Cart synchronisation service (Issue #574).
 *
 * Buyers manage one cart from several devices (mobile browser, desktop app).
 * Every device keeps its own copy and pushes it to the gateway together with
 * the cart version it last saw (`clientVersion`). The gateway compares that
 * version with the version it holds and, instead of letting the newest request
 * overwrite the stored cart, merges the two states line by line.
 *
 * ─── Merge strategy ──────────────────────────────────────────────────────────
 *
 * The merge combines a per-line last-write-wins rule with a per-line version
 * stamp, which together behave like a small version vector:
 *
 *  • `carts.version` is the cart-wide revision counter. It is bumped on every
 *    successful sync and is what a client echoes back as `clientVersion`.
 *
 *  • `cart_items.revision` is the cart version at which *that line* was last
 *    changed. It is what lets the merge tell two very different omissions
 *    apart:
 *      – the client never saw the line  → keep it (the line was added by
 *        another device after the client's last sync), and
 *      – the client saw the line and dropped it → remove it.
 *
 *  • `cart_items.client_updated_at` is the timestamp of the last change to the
 *    line. It is the tie-breaker between two devices that changed the same
 *    line: the newer timestamp wins.
 *
 * A line with `quantity = 0` is a tombstone. Removals are kept as tombstones
 * so a device that is out of date cannot resurrect a line the buyer already
 * deleted.
 */
import { createLogger } from "@delegolabs/utils";
import type { CartLineItemDTO, CartSyncRequest, CartSyncResponse } from "@delegolabs/types";

const log = createLogger("gateway:cart-sync", process.env.LOG_LEVEL ?? "info");

/** A cart line as it is stored by the gateway. */
export interface StoredCartLine {
  merchantId: string;
  productId: string;
  /** `null` when the product has no variant. */
  skuId: string | null;
  /** Absolute quantity — `0` marks a tombstone (the line was removed). */
  quantity: number;
  /** Last-write-wins timestamp of the line. */
  updatedAt: Date;
  /** Cart version at which the line was last changed. */
  revision: number;
}

/** A cart header as it is stored by the gateway. */
export interface CartRecord {
  id: string;
  userId: string;
  /** The cart-wide revision counter. */
  version: number;
}

/**
 * The unit of work handed to the service. Implementations are expected to run
 * the whole callback inside a single database transaction that locks the cart
 * row, so that two devices syncing at the same time cannot both read the same
 * version and write the same next version.
 */
export interface CartTransaction {
  /** Loads the cart, creating it for `userId` when it does not exist yet. */
  loadOrCreateCart(cartId: string, userId: string): Promise<CartRecord>;
  /** Loads every line of the cart, tombstones included. */
  listLines(cartId: string): Promise<StoredCartLine[]>;
  /** Persists the given lines (inserts and updates). */
  saveLines(cartId: string, lines: StoredCartLine[]): Promise<void>;
  /** Stores the new cart-wide version. */
  setVersion(cartId: string, version: number): Promise<void>;
}

/** Storage abstraction — the gateway uses the Sequelize-backed implementation. */
export interface CartRepository {
  runInTransaction<T>(fn: (tx: CartTransaction) => Promise<T>): Promise<T>;
}

/** Raised when a cart exists but belongs to a different user. */
export class CartOwnershipError extends Error {
  constructor(public readonly cartId: string) {
    super("Cart does not belong to the authenticated user");
    this.name = "CartOwnershipError";
  }
}

/** Identity of a cart line within a cart. */
export function cartLineKey(merchantId: string, productId: string, skuId: string | null): string {
  // NUL separator — merchant/product/sku ids may contain any other character.
  return `${merchantId}\u0000${productId}\u0000${skuId ?? ""}`;
}

/** Parses a client timestamp, falling back to the epoch for unusable values. */
function parseTimestamp(value: string): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/** `true` when two lines hold the same value (ignoring the revision stamp). */
function sameLineValue(a: StoredCartLine, b: StoredCartLine): boolean {
  return a.quantity === b.quantity && a.updatedAt.getTime() === b.updatedAt.getTime();
}

export interface MergeInput {
  /** The lines currently stored for the cart, tombstones included. */
  serverLines: StoredCartLine[];
  /** The client's view of the cart. */
  clientLines: CartLineItemDTO[];
  /** The cart version the client last saw. */
  clientVersion: number;
  /** The cart version currently stored by the gateway. */
  serverVersion: number;
  /** Server clock — used when the merge has to infer a removal. */
  now: Date;
}

export interface MergeResult {
  /** The merged state of the cart (live lines and tombstones). */
  lines: StoredCartLine[];
  /** The subset of `lines` whose stored value actually changed. */
  changedLines: StoredCartLine[];
  /** The cart version after the merge. */
  serverVersion: number;
  /** `true` when the client was out of date and both states had to be reconciled. */
  conflictsResolved: boolean;
}

interface ResolveContext {
  /**
   * `true` when the client is at least as up to date as the server, i.e. the
   * server has not changed since the client's last sync. The client is then
   * the only writer and its state wins.
   */
  clientIsCurrent: boolean;
  clientVersion: number;
  nextVersion: number;
}

/**
 * Decides the outcome of a line that exists on both sides.
 *
 * The matrix (server state × client state):
 *
 * | server  | client | outcome                                              |
 * |---------|--------|------------------------------------------------------|
 * | live    | live   | current client → client wins, stale → newer timestamp wins |
 * | live    | remove | removal accepted when the client is current, when its timestamp is newer, or when the client had already seen the line |
 * | removed | live   | restore when the client is current or its timestamp is newer |
 * | removed | remove | the tombstone is kept                                  |
 */
function resolveLine(
  serverLine: StoredCartLine,
  clientLine: CartLineItemDTO,
  ctx: ResolveContext,
): StoredCartLine {
  const clientUpdatedAt = parseTimestamp(clientLine.updatedAt);
  const clientQuantity = clientLine.quantity;
  const serverIsLive = serverLine.quantity > 0;
  const clientIsLive = clientQuantity > 0;

  // ── The client wants the line gone ───────────────────────────────────────
  if (!clientIsLive) {
    if (!serverIsLive) {
      // Already a tombstone — only a newer removal moves its timestamp.
      if (clientUpdatedAt.getTime() > serverLine.updatedAt.getTime()) {
        return { ...serverLine, updatedAt: clientUpdatedAt, revision: ctx.nextVersion };
      }
      return serverLine;
    }
    const removalAccepted =
      ctx.clientIsCurrent ||
      clientUpdatedAt.getTime() > serverLine.updatedAt.getTime() ||
      // The client had already seen the line and now drops it explicitly, so
      // the removal stands even when the device clock lags behind.
      ctx.clientVersion >= serverLine.revision;
    if (!removalAccepted) return serverLine;
    return {
      ...serverLine,
      quantity: 0,
      updatedAt: clientUpdatedAt,
      revision: ctx.nextVersion,
    };
  }

  // ── The client wants the line present ────────────────────────────────────
  if (serverIsLive) {
    const clientWins = ctx.clientIsCurrent || clientUpdatedAt.getTime() > serverLine.updatedAt.getTime();
    if (!clientWins) return serverLine;
    const candidate: StoredCartLine = {
      ...serverLine,
      quantity: clientQuantity,
      updatedAt: clientUpdatedAt,
    };
    if (sameLineValue(serverLine, candidate)) return serverLine;
    return { ...candidate, revision: ctx.nextVersion };
  }

  // The server holds a tombstone and the client has the line again.
  const restoreAccepted = ctx.clientIsCurrent || clientUpdatedAt.getTime() > serverLine.updatedAt.getTime();
  if (!restoreAccepted) return serverLine;
  return {
    ...serverLine,
    quantity: clientQuantity,
    updatedAt: clientUpdatedAt,
    revision: ctx.nextVersion,
  };
}

/**
 * Merges the client's view of a cart into the state the gateway holds.
 *
 * Pure function — no I/O — so the strategy can be unit tested on its own.
 */
export function mergeCartLines(input: MergeInput): MergeResult {
  const { serverLines, clientLines, clientVersion, serverVersion, now } = input;
  const nextVersion = serverVersion + 1;
  const ctx: ResolveContext = {
    clientIsCurrent: clientVersion >= serverVersion,
    clientVersion,
    nextVersion,
  };

  const serverByKey = new Map<string, StoredCartLine>();
  for (const line of serverLines) {
    serverByKey.set(cartLineKey(line.merchantId, line.productId, line.skuId), line);
  }

  const clientByKey = new Map<string, CartLineItemDTO>();
  for (const line of clientLines) {
    clientByKey.set(cartLineKey(line.merchantId, line.productId, line.skuId ?? null), line);
  }

  const lines: StoredCartLine[] = [];
  const changedLines: StoredCartLine[] = [];

  const record = (line: StoredCartLine, previous?: StoredCartLine): void => {
    lines.push(line);
    if (!previous || !sameLineValue(previous, line) || previous.revision !== line.revision) {
      changedLines.push(line);
    }
  };

  for (const [key, serverLine] of serverByKey) {
    const clientLine = clientByKey.get(key);

    if (!clientLine) {
      // The client did not mention the line at all.
      if (serverLine.quantity > 0 && serverLine.revision <= clientVersion) {
        // The client's snapshot contained the line and it is gone now → the
        // buyer removed it on this device.
        record(
          { ...serverLine, quantity: 0, updatedAt: now, revision: nextVersion },
          serverLine,
        );
      } else {
        // The line was added or changed after the client's last sync, so the
        // client simply does not know about it yet — keep it.
        record(serverLine, serverLine);
      }
      continue;
    }

    record(resolveLine(serverLine, clientLine, ctx), serverLine);
  }

  // Lines the client knows about that the gateway has never seen.
  for (const [key, clientLine] of clientByKey) {
    if (serverByKey.has(key)) continue;
    record({
      merchantId: clientLine.merchantId,
      productId: clientLine.productId,
      skuId: clientLine.skuId ?? null,
      quantity: clientLine.quantity,
      updatedAt: parseTimestamp(clientLine.updatedAt),
      revision: nextVersion,
    });
  }

  return {
    lines,
    changedLines,
    serverVersion: nextVersion,
    conflictsResolved: clientVersion !== serverVersion,
  };
}

/** Projects the stored lines onto the wire format, dropping tombstones. */
export function toCartLineItemDTOs(lines: StoredCartLine[]): CartLineItemDTO[] {
  return lines
    .filter((line) => line.quantity > 0)
    .map((line) => ({
      merchantId: line.merchantId,
      productId: line.productId,
      ...(line.skuId ? { skuId: line.skuId } : {}),
      quantity: line.quantity,
      updatedAt: line.updatedAt.toISOString(),
    }))
    .sort((a, b) => {
      const keyA = cartLineKey(a.merchantId, a.productId, a.skuId ?? null);
      const keyB = cartLineKey(b.merchantId, b.productId, b.skuId ?? null);
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });
}

/**
 * Synchronises a client's cart with the state the gateway holds.
 *
 * The whole read-merge-write cycle runs inside one transaction that holds a
 * lock on the cart row, so concurrent syncs from two devices are serialised
 * instead of overwriting each other.
 */
export async function syncCart(
  repository: CartRepository,
  request: CartSyncRequest,
  userId: string,
): Promise<CartSyncResponse> {
  const { cartId, clientVersion, items } = request;

  const response = await repository.runInTransaction(async (tx) => {
    const cart = await tx.loadOrCreateCart(cartId, userId);
    if (cart.userId !== userId) {
      throw new CartOwnershipError(cartId);
    }

    const serverLines = await tx.listLines(cartId);
    const merge = mergeCartLines({
      serverLines,
      clientLines: items,
      clientVersion,
      serverVersion: cart.version,
      now: new Date(),
    });

    if (merge.changedLines.length > 0) {
      await tx.saveLines(cartId, merge.changedLines);
    }
    await tx.setVersion(cartId, merge.serverVersion);

    return {
      cartId,
      serverVersion: merge.serverVersion,
      items: toCartLineItemDTOs(merge.lines),
      conflictsResolved: merge.conflictsResolved,
    } satisfies CartSyncResponse;
  });

  log.info("Cart synced", {
    cartId: response.cartId,
    serverVersion: response.serverVersion,
    clientVersion,
    itemCount: response.items.length,
    conflictsResolved: response.conflictsResolved,
  });

  return response;
}
