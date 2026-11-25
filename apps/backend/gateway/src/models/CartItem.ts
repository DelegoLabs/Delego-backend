import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * A single line of a buyer's cart (Issue #574).
 *
 * `revision` is the cart version at which the line was last changed — it is
 * the per-line half of the version vector the merge uses to decide whether a
 * client that omitted the line simply has not seen it yet, or has removed it.
 *
 * A line with `quantity = 0` is a tombstone: the buyer removed the line, but
 * the row is kept so a stale device cannot resurrect it.
 */
export class CartItem extends Model {
  public id!: string;
  public cartId!: string;
  public merchantId!: string;
  public productId!: string;
  public skuId!: string;
  public quantity!: number;
  public clientUpdatedAt!: Date;
  public revision!: number;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

CartItem.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    cartId: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: "cart_id",
      references: {
        model: "carts",
        key: "id",
      },
    },
    merchantId: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: "merchant_id",
    },
    productId: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: "product_id",
    },
    skuId: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: "",
      field: "sku_id",
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "quantity",
      validate: {
        min: 0,
      },
    },
    clientUpdatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "client_updated_at",
    },
    revision: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      validate: {
        min: 0,
      },
    },
  },
  {
    sequelize,
    modelName: "CartItem",
    tableName: "cart_items",
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ["cart_id", "merchant_id", "product_id", "sku_id"],
      },
      {
        fields: ["cart_id"],
      },
    ],
  },
);
