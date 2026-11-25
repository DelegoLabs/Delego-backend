/**
 * Batch Merkle tree calculation for the audit-log anchor publisher
 * (Issue #613).
 *
 * Audit log entries (`packages/utils/src/audit/auditLogStore.ts`'s
 * `AuditLogEntry.entryHash`) are batched — default 1,000 per batch, per the
 * issue's "batches of 1,000 audit log hashes" — and the resulting Merkle
 * root is anchored to the Stellar ledger as a transaction memo by
 * `apps/backend/src/workers/auditAnchorWorker.ts`.
 *
 * This module is intentionally separate from `auditChain.ts`'s
 * `computeMerkleRoot` (which operates on the distinct `AuditLogChainEntry`
 * / Issue #358 data model and only computes a root, not proofs): this one
 * is leaf-hash-generic and additionally supports per-leaf inclusion proofs,
 * which is what lets "Merkle proofs be generated for any individual audit
 * log entry" (this issue's acceptance criteria) without needing the whole
 * batch.
 */
import { createHash } from "node:crypto";

/** Default batch size — "batches of 1,000 audit log hashes" per Issue #613. */
export const DEFAULT_BATCH_SIZE = 1000;

export interface MerkleProofStep {
  hash: string;
  /** Which side of the computed node this sibling sits on. */
  position: "left" | "right";
}

export interface MerkleTree {
  /** Leaf hashes in original (left-to-right) order. */
  leaves: string[];
  /** `layers[0]` is the leaves; `layers[layers.length - 1]` is `[root]`. */
  layers: string[][];
  root: string;
  leafCount: number;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Hash a pair of nodes into their parent. Order matters (left then right) —
 * sorting the pair before hashing would let an attacker swap sibling order
 * in a proof undetected.
 */
function hashPair(left: string, right: string): string {
  return sha256Hex(left + right);
}

/**
 * Build a full Merkle tree from an ordered list of leaf hashes (hex
 * digests, typically `AuditLogEntry.entryHash`). Returns every layer so
 * proofs can be generated without recomputing the tree. Odd layers
 * duplicate their last node, the standard Bitcoin-style approach.
 *
 * Throws if `leaves` is empty — an anchor batch with zero entries has
 * nothing to anchor.
 */
export function buildMerkleTree(leaves: string[]): MerkleTree {
  if (leaves.length === 0) {
    throw new Error("buildMerkleTree: at least one leaf hash is required");
  }

  const layers: string[][] = [leaves.slice()];
  let current = layers[0];

  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : left;
      next.push(hashPair(left, right));
    }
    layers.push(next);
    current = next;
  }

  return { leaves: leaves.slice(), layers, root: current[0], leafCount: leaves.length };
}

/**
 * Generate an inclusion proof for the leaf at `leafIndex`: the sibling hash
 * and its position (left/right relative to the path node) at each layer,
 * from the leaf up to (but excluding) the root.
 */
export function generateMerkleProof(tree: MerkleTree, leafIndex: number): MerkleProofStep[] {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= tree.leafCount) {
    throw new Error(`generateMerkleProof: leafIndex ${leafIndex} out of range [0, ${tree.leafCount})`);
  }

  const proof: MerkleProofStep[] = [];
  let index = leafIndex;

  for (let layer = 0; layer < tree.layers.length - 1; layer++) {
    const nodes = tree.layers[layer];
    const isRightNode = index % 2 === 1;
    const siblingIndex = isRightNode ? index - 1 : index + 1;
    // The last, duplicated node in an odd-length layer has itself as sibling.
    const sibling = siblingIndex < nodes.length ? nodes[siblingIndex] : nodes[index];

    proof.push({ hash: sibling, position: isRightNode ? "left" : "right" });
    index = Math.floor(index / 2);
  }

  return proof;
}

/**
 * Verify that `leafHash` is included in a tree with root `root`, given its
 * inclusion proof. Does not need the full tree — only the leaf, its proof,
 * and the root — which is what makes Merkle proofs useful for light
 * verification (e.g. checking a single audit entry against the root
 * anchored on Stellar without re-fetching the other 999 entries in its
 * batch).
 */
export function verifyMerkleProof(leafHash: string, proof: MerkleProofStep[], root: string): boolean {
  let computed = leafHash;

  for (const step of proof) {
    computed = step.position === "left" ? hashPair(step.hash, computed) : hashPair(computed, step.hash);
  }

  return computed === root;
}

/**
 * Split an ordered array into batches of at most `batchSize` (default
 * 1,000). The caller supplies items already ordered by `sequence_num` so
 * batch boundaries align with contiguous sequence ranges.
 */
export function batchItems<T>(items: T[], batchSize: number = DEFAULT_BATCH_SIZE): T[][] {
  if (batchSize <= 0) throw new Error("batchItems: batchSize must be positive");
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}
