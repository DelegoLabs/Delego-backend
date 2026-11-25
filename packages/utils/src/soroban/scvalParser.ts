/**
 * Strongly typed TypeScript parser for Soroban ScVal XDR data — Issue #607.
 *
 * Raw Soroban events/contract return values are complex, nested XDR `ScVal`
 * union structures. This module recursively translates them into plain
 * JavaScript values, preserving 64/128/256-bit integer precision with
 * `bigint` (never passing through `Number`, which loses precision above
 * 2^53).
 */

import { Address, xdr } from "@stellar/stellar-sdk";

export type ParsedScVal =
  | string
  | number
  | bigint
  | boolean
  | null
  | ParsedScVal[]
  | { [key: string]: ParsedScVal };

export interface ScValParser {
  parse: (scValXdrBase64: string) => ParsedScVal;
  toBigInt: (scVal: unknown) => bigint;
  toAddress: (scVal: unknown) => string;
}

/** Thrown for malformed XDR or ScVal variants this parser doesn't support. */
export class ScValParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ScValParseError";
  }
}

function combineHiLo(hi: bigint, lo: bigint): bigint {
  // `lo` is always the low 64 unsigned bits regardless of overall sign.
  return (hi << 64n) | BigInt.asUintN(64, lo);
}

function hyperToBigInt(value: { toBigInt?: () => bigint; toString: () => string }): bigint {
  if (typeof value.toBigInt === "function") {
    return value.toBigInt();
  }
  return BigInt(value.toString());
}

function parseI128(scVal: xdr.ScVal): bigint {
  const parts = scVal.i128();
  const hi = hyperToBigInt(parts.hi());
  const lo = hyperToBigInt(parts.lo());
  return combineHiLo(hi, lo);
}

function parseU128(scVal: xdr.ScVal): bigint {
  const parts = scVal.u128();
  const hi = hyperToBigInt(parts.hi());
  const lo = hyperToBigInt(parts.lo());
  return combineHiLo(hi, lo);
}

function parseI256(scVal: xdr.ScVal): bigint {
  const parts = scVal.i256();
  const hiHi = hyperToBigInt(parts.hiHi());
  const hiLo = hyperToBigInt(parts.hiLo());
  const loHi = hyperToBigInt(parts.loHi());
  const loLo = hyperToBigInt(parts.loLo());
  const hi = (hiHi << 64n) | BigInt.asUintN(64, hiLo);
  const lo = (BigInt.asUintN(64, loHi) << 64n) | BigInt.asUintN(64, loLo);
  return (hi << 128n) | BigInt.asUintN(128, lo);
}

function parseU256(scVal: xdr.ScVal): bigint {
  const parts = scVal.u256();
  const hiHi = hyperToBigInt(parts.hiHi());
  const hiLo = hyperToBigInt(parts.hiLo());
  const loHi = hyperToBigInt(parts.loHi());
  const loLo = hyperToBigInt(parts.loLo());
  const hi = (BigInt.asUintN(64, hiHi) << 64n) | BigInt.asUintN(64, hiLo);
  const lo = (BigInt.asUintN(64, loHi) << 64n) | BigInt.asUintN(64, loLo);
  return (hi << 128n) | lo;
}

/** Recursively converts a decoded `xdr.ScVal` into a plain JS value. */
function parseScValNode(scVal: xdr.ScVal): ParsedScVal {
  const kind = scVal.switch().name;

  switch (kind) {
    case "scvVoid":
      return null;
    case "scvBool":
      return scVal.b();
    case "scvU32":
      return scVal.u32();
    case "scvI32":
      return scVal.i32();
    case "scvU64":
      return hyperToBigInt(scVal.u64());
    case "scvI64":
      return hyperToBigInt(scVal.i64());
    case "scvTimepoint":
      return hyperToBigInt(scVal.timepoint());
    case "scvDuration":
      return hyperToBigInt(scVal.duration());
    case "scvU128":
      return parseU128(scVal);
    case "scvI128":
      return parseI128(scVal);
    case "scvU256":
      return parseU256(scVal);
    case "scvI256":
      return parseI256(scVal);
    case "scvBytes":
      return scVal.bytes().toString("hex");
    case "scvString":
      return scVal.str().toString();
    case "scvSymbol":
      return scVal.sym().toString();
    case "scvAddress":
      return Address.fromScAddress(scVal.address()).toString();
    case "scvVec": {
      const vec = scVal.vec();
      if (!vec) return [];
      return vec.map((entry) => parseScValNode(entry));
    }
    case "scvMap": {
      const map = scVal.map();
      if (!map) return {};
      const result: { [key: string]: ParsedScVal } = {};
      for (const entry of map) {
        const parsedKey = parseScValNode(entry.key());
        const keyStr =
          typeof parsedKey === "string"
            ? parsedKey
            : typeof parsedKey === "bigint"
              ? parsedKey.toString()
              : JSON.stringify(parsedKey);
        result[keyStr] = parseScValNode(entry.val());
      }
      return result;
    }
    default:
      throw new ScValParseError(`Unsupported ScVal type: ${kind}`);
  }
}

function decodeScVal(scValXdrBase64: string): xdr.ScVal {
  if (typeof scValXdrBase64 !== "string" || scValXdrBase64.trim() === "") {
    throw new ScValParseError("ScVal input must be a non-empty base64 string");
  }
  try {
    return xdr.ScVal.fromXDR(scValXdrBase64, "base64");
  } catch (err) {
    throw new ScValParseError(
      `Malformed ScVal XDR: failed to decode base64 payload as a ScVal union (${
        err instanceof Error ? err.message : String(err)
      })`,
      err,
    );
  }
}

/** Parses a base64-encoded ScVal XDR string into a plain JS value, preserving 64/128/256-bit precision as `bigint`. */
export function parseScVal(scValXdrBase64: string): ParsedScVal {
  const scVal = decodeScVal(scValXdrBase64);
  return parseScValNode(scVal);
}

function coerceToScVal(value: unknown): xdr.ScVal {
  if (typeof value === "string") {
    return decodeScVal(value);
  }
  if (value instanceof xdr.ScVal) {
    return value;
  }
  throw new ScValParseError(
    "Expected a base64-encoded ScVal XDR string or an xdr.ScVal instance",
  );
}

/** Extracts a `bigint` from any numeric ScVal variant (u32/i32/u64/i64/u128/i128/u256/i256). */
export function scValToBigInt(scVal: unknown): bigint {
  const node = coerceToScVal(scVal);
  const parsed = parseScValNode(node);
  if (typeof parsed === "bigint") return parsed;
  if (typeof parsed === "number" && Number.isInteger(parsed)) return BigInt(parsed);
  throw new ScValParseError(`ScVal does not represent an integer (got ${typeof parsed})`);
}

/** Extracts a Stellar account/contract address (G.../C...) from an `scvAddress` ScVal. */
export function scValToAddress(scVal: unknown): string {
  const node = coerceToScVal(scVal);
  if (node.switch().name !== "scvAddress") {
    throw new ScValParseError(`ScVal is not an address (got ${node.switch().name})`);
  }
  return Address.fromScAddress(node.address()).toString();
}

export const scValParser: ScValParser = {
  parse: parseScVal,
  toBigInt: scValToBigInt,
  toAddress: scValToAddress,
};
