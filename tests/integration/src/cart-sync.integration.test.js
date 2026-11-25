/**
 * Integration coverage (Issue #574): the cart sync merge strategy against a
 * real, migrated Postgres database.
 *
 * The unit suites exercise the merge strategy with the storage mocked; this
 * one drives the real service layer through the real Sequelize repository, so
 * it also catches what a mock structurally cannot: the carts/cart_items
 * schema, the unique line index, the revision bookkeeping, the row lock that
 * serialises two concurrent syncs, and the behaviour of two devices syncing
 * the same cart at the same time.
 *
 * Requires the compiled gateway build (dist/) and a reachable Postgres;
 * skips itself otherwise.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { isPostgresReachable, isServiceBuilt, uniqueId } from "./helpers/infra.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATE_SCRIPT = path.join(REPO_ROOT, "scripts", "setup", "migrate.js");
const ADMIN_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

const dbAvailable = await isPostgresReachable();
if (!dbAvailable) {
  console.log(
    "[tests] Skipping cart-sync integration tests — no PostgreSQL reachable (start it with 'docker compose up -d postgres')",
  );
}

const gatewayBuilt = isServiceBuilt("gateway");
if (dbAvailable && !gatewayBuilt) {
  console.log(
    "[tests] Skipping cart-sync integration tests — apps/backend/gateway/dist not found (run 'pnpm --filter @delegolabs/gateway build' first)",
  );
}

const suite = dbAvailable && gatewayBuilt ? describe : describe.skip;

suite("cart sync merge strategy against real Postgres (#574)", () => {
  let databaseUrl;
  let checkCartSync;
  let sequelizeCartRepository;
  let syncCart;
  let CartOwnershipError;
  let User;
  let Cart;
  let CartItem;
  let sequelize;

  const MERCHANT = "11111111-1111-4111-8111-111111111111";
  const PRODUCT = "22222222-2222-4222-8222-222222222222";
  const T0 = "2026-10-01T10:00:00.000Z";
  const T1 = "2026-10-01T10:05:00.000Z";
  const T2 = "2026-10-01T10:10:00.000Z";

  before(async () => {
    const dbName = uniqueId("delego_cart_sync_test").replace(/-/g, "_");
    const adminUrl = new URL(ADMIN_DATABASE_URL);
    adminUrl.pathname = "/postgres";

    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }

    const dbUrl = new URL(ADMIN_DATABASE_URL);
    dbUrl.pathname = `/${dbName}`;
    databaseUrl = dbUrl.toString();

    const migrate = spawnSync(process.execPath, [MIGRATE_SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    assert.equal(migrate.status, 0, `migration run failed:\n${migrate.stderr}`);

    process.env.DATABASE_URL = databaseUrl;
    ({ syncCart, CartOwnershipError } = await import(
      "../../../apps/backend/gateway/dist/src/services/cartSyncService.js"
    ));
    ({ sequelizeCartRepository } = await import(
      "../../../apps/backend/gateway/dist/src/services/cartRepository.js"
    ));
    ({ User, Cart, CartItem } = await import(
      "../../../apps/backend/gateway/dist/src/models/index.js"
    ));
    ({ sequelize } = await import("../../../apps/backend/gateway/dist/src/db.js"));

    checkCartSync = (request, userId) => syncCart(sequelizeCartRepository, request, userId);
  });

  after(async () => {
    await sequelize?.close();

    const adminUrl = new URL(ADMIN_DATABASE_URL);
    adminUrl.pathname = "/postgres";
    const dbName = new URL(databaseUrl).pathname.slice(1);
    const cleanup = new pg.Client({ connectionString: adminUrl.toString() });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  });

  async function createUser() {
    return User.create({
      email: `${uniqueId("buyer")}@example.com`,
      passwordHash: "x",
      displayName: "Buyer",
    });
  }

  it("stores the cart, its version and the merged lines", async () => {
    const user = await createUser();

    const response = await checkCartSync(
      {
        cartId: "cart-1",
        clientVersion: 0,
        items: [{ merchantId: MERCHANT, productId: PRODUCT, quantity: 2, updatedAt: T0 }],
      },
      user.id,
    );

    assert.equal(response.cartId, "cart-1");
    assert.equal(response.serverVersion, 1);
    assert.equal(response.conflictsResolved, false);
    assert.equal(response.items.length, 1);
    assert.equal(response.items[0].quantity, 2);

    const cart = await Cart.findByPk("cart-1");
    assert.ok(cart, "the cart row must exist");
    assert.equal(cart.userId, user.id);
    assert.equal(cart.version, 1);

    const stored = await CartItem.findAll({ where: { cartId: "cart-1" } });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].quantity, 2);
    assert.equal(stored[0].revision, 1);
  });

  it("merges two devices instead of letting the stale one overwrite the cart", async () => {
    const user = await createUser();

    const initial = await checkCartSync(
      {
        cartId: "cart-2",
        clientVersion: 0,
        items: [{ merchantId: MERCHANT, productId: PRODUCT, quantity: 1, updatedAt: T0 }],
      },
      user.id,
    );
    const baseVersion = initial.serverVersion;

    // The phone adds a product and syncs.
    const phone = await checkCartSync(
      {
        cartId: "cart-2",
        clientVersion: baseVersion,
        items: [
          { merchantId: MERCHANT, productId: PRODUCT, quantity: 1, updatedAt: T0 },
          { merchantId: MERCHANT, productId: "33333333-3333-4333-8333-333333333333", quantity: 3, updatedAt: T1 },
        ],
      },
      user.id,
    );
    assert.equal(phone.items.length, 2);

    // The laptop is one version behind and changes the quantity of the first product.
    const laptop = await checkCartSync(
      {
        cartId: "cart-2",
        clientVersion: baseVersion,
        items: [{ merchantId: MERCHANT, productId: PRODUCT, quantity: 5, updatedAt: T2 }],
      },
      user.id,
    );

    assert.equal(laptop.conflictsResolved, true);
    assert.equal(laptop.serverVersion, phone.serverVersion + 1);
    assert.equal(laptop.items.length, 2, "the line added by the phone must survive");

    const byProduct = Object.fromEntries(laptop.items.map((item) => [item.productId, item.quantity]));
    assert.equal(byProduct[PRODUCT], 5, "the newer change of the laptop wins");
    assert.equal(byProduct["33333333-3333-4333-8333-333333333333"], 3);

    const cart = await Cart.findByPk("cart-2");
    assert.equal(cart.version, laptop.serverVersion);
  });

  it("keeps both lines when two devices sync concurrently", async () => {
    const user = await createUser();

    const initial = await checkCartSync(
      { cartId: "cart-3", clientVersion: 0, items: [] },
      user.id,
    );

    const [phone, laptop] = await Promise.all([
      checkCartSync(
        {
          cartId: "cart-3",
          clientVersion: initial.serverVersion,
          items: [{ merchantId: MERCHANT, productId: "44444444-4444-4444-8444-444444444444", quantity: 1, updatedAt: T1 }],
        },
        user.id,
      ),
      checkCartSync(
        {
          cartId: "cart-3",
          clientVersion: initial.serverVersion,
          items: [{ merchantId: MERCHANT, productId: "55555555-5555-4555-8555-555555555555", quantity: 2, updatedAt: T2 }],
        },
        user.id,
      ),
    ]);

    assert.equal(phone.items.length >= 1, true);
    assert.equal(laptop.items.length >= 1, true);

    const stored = await CartItem.findAll({ where: { cartId: "cart-3" } });
    const live = stored.filter((item) => item.quantity > 0);
    assert.equal(live.length, 2, "both devices' lines must be stored");

    const cart = await Cart.findByPk("cart-3");
    assert.equal(cart.version, initial.serverVersion + 2);
  });

  it("keeps a removal when an outdated device pushes the removed line again", async () => {
    const user = await createUser();

    const initial = await checkCartSync(
      {
        cartId: "cart-4",
        clientVersion: 0,
        items: [{ merchantId: MERCHANT, productId: PRODUCT, quantity: 1, updatedAt: T0 }],
      },
      user.id,
    );

    const removed = await checkCartSync(
      {
        cartId: "cart-4",
        clientVersion: initial.serverVersion,
        items: [{ merchantId: MERCHANT, productId: PRODUCT, quantity: 0, updatedAt: T1 }],
      },
      user.id,
    );
    assert.equal(removed.items.length, 0);

    const stale = await checkCartSync(
      {
        cartId: "cart-4",
        clientVersion: initial.serverVersion,
        items: [{ merchantId: MERCHANT, productId: PRODUCT, quantity: 1, updatedAt: T0 }],
      },
      user.id,
    );
    assert.equal(stale.items.length, 0, "the removed line must not come back");

    const stored = await CartItem.findOne({ where: { cartId: "cart-4" } });
    assert.equal(stored.quantity, 0, "the tombstone must be kept");
  });

  it("rejects a cart that belongs to another user", async () => {
    const owner = await createUser();
    const other = await createUser();

    await checkCartSync({ cartId: "cart-5", clientVersion: 0, items: [] }, owner.id);

    await assert.rejects(
      () => checkCartSync({ cartId: "cart-5", clientVersion: 1, items: [] }, other.id),
      (err) => err instanceof CartOwnershipError,
    );
  });
});
