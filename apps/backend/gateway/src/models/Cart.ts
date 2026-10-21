import { Model, DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * A buyer's cart (Issue #574).
 *
 * `version` is the server-side revision counter used for optimistic
 * concurrency control: it is bumped on every successful cart sync and is the
 * value a client echoes back as `clientVersion`.
 */
export class Cart extends Model {
  public id!: string;
  public userId!: string;
  public version!: number;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Cart.init(
  {
    id: {
      type: DataTypes.STRING(64),
      allowNull: false,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "user_id",
      references: {
        model: "users",
        key: "id",
      },
    },
    version: {
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
    modelName: "Cart",
    tableName: "carts",
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ["user_id"],
      },
    ],
  },
);
