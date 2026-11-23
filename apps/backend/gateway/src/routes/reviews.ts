import { Router, Request, Response } from 'express';
const { keypair } = require('stellar-sdk');
import crypto from 'crypto';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';

export interface ReviewSubmissionDTO {
  orderId: string;
  productId: string;
  rating: number;
  title: string;
  content: string;
  stellarAccount: string;
  signature: string;
}

export interface ReviewVerificationResult {
  verified: boolean;
  escrowContractId?: string;
  settledLedgerSequence?: number;
  errorMessage?: string;
}

interface OrderRow {
  id: string;
  buyer_stellar_account: string;
  merchant_stellar_account: string;
  product_id: string;
  status: string;
  escrow_contract_id: string | null;
}

const SOROBAN_ESCROW_STATUS_DELIVERED = 'delivered';
const SOROBAN_ESCROW_STATUS_RELEASED = 'escrow_released';
const SOROBAN_ESCROW_STATUS_SETTLED = 'settled';

function decodeSignature(signature: string): Buffer {
  const normalized = signature.trim();
  if (/^[0-9A-Fa-f]{128}$/.test(normalized)) {
    return Buffer.from(normalized, 'hex');
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length !== 64) {
    throw new Error('signature must be a 64-byte Ed25519 signature');
  }
  return decoded;
}

function buildReviewHash(t: ReviewSubmissionDTO): Buffer {
  const payload = [
    'stellar-review-v1',
    t.orderId,
    t.productId,
    String(t.rating),
    t.title,
    t.content,
    t.stellarAccount,
  ].join('|');
  return crypto.createHash('sha256').update(payload, 'utf8').digest();
}

function verifyEd25519Signature(publicKey: string, message: Buffer, signature: Buffer): boolean {
  try {
    const keypa = keypair.fromPublicKey(publicKey);
    return keypa.verify(message, signature);
  } catch {
    return false;
  }
}

async function querySorobanEscrow(
  escrowContractId: string,
  orderId: string,
): Promise<{ status: string; settledLedgerSequence?: number }> {
  const indexerUrl = process.env.SOROBAN_INDEXER_URL;
  if (!indexerUrl) {
    throw new Error('SOROBAN_INDEXER_URL is not configured');
  }

  const url = new URL(`/escrows/${encodeURIComponent(escrowContractId)}/orders/${encodeURIComponent(orderId)}`, indexerUrl);
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Soroban indexer responded with ${response.status}`);
  }

  const body = (await response.json()) as {
    status?: string;
    settled_ledger_sequence?: number;
  };

  if (!body || typeof body.status !== 'string') {
    throw new Error('Soroban indexer returned an invalid escrow payload');
  }

  return {
    status: body.status,
    settledLedgerSequence: body.settled_ledger_sequence,
  };
}

async function verifyBuyer(h: ReviewSubmissionDTO, authenticatedAccount: string): Promise<ReviewVerificationResult> {
  if (h.stellarAccount !== authenticatedAccount) {
    return { verified: false, errorMessage: 'stellarAccount does not match authenticated account' };
  }

  const orderResult = await pool.query<OrderRow>(
    `SELECT id, buyer_stellar_account, merchant_stellar_account, product_id, status, escrow_contract_id
       FROM orders
      WHERE id = $1 LIMIT 1`,
    [h.orderId],
  );

  if (orderResult.rowCount === 0) {
    return { verified: false, errorMessage: 'order not found' };
  }

  const order = orderResult.rows[0];

  if (order.buyer_stellar_account !== authenticatedAccount) {
    return { verified: false, errorMessage: 'order does not belong to authenticated account' };
  }

  if (order.product_id !== h.productId) {
    return { verified: false, errorMessage: 'order product does not match review product' };
  }

  const orderStatusOk =
    order.status === SOROBAN_ESCROW_STATUS_DELIVERED ||
    order.status === SOROBAN_ESCROW_STATUS_RELEASED;

  if (!orderStatusOk) {
    return { verified: false, errorMessage: 'order is not in a fulfilled state' };
  }

  if (!order.escrow_contract_id) {
    return { verified: false, errorMessage: 'order has no escrow contract' };
  }

  const escrow = await querySorobanEscrow(order.escrow_contract_id, order.id);

  const escrowStatusOk =
    escrow.status === SOROBAN_ESCROW_STATUS_DELIVERED ||
    escrow.status === SOROBAN_ESCROW_STATUS_RELEASED ||
    escrow.status === SOROBAN_ESCROW_STATUS_SETTLED;

  if (!escrowStatusOk) {
    return {
      verified: false,
      escrowContractId: order.escrow_contract_id,
      errorMessage: 'escrow has not been settled',
    };
  }

  return {
    verified: true,
    escrowContractId: order.escrow_contract_id,
    settledLedgerSequence: escrow.settledLedgerSequence,
  };
}

function validatePayload(body: unknown): ReviewSubmissionDTO {
  if (!body || typeof body !== 'object') {
    throw new Error('request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  const requiredStrings: Array<keyof ReviewSubmissionDTO> = [
    'orderId',
    'productId',
    'title',
    'content',
    'stellarAccount',
    'signature',
  ];
  for (const field of requiredStrings) {
    if (typeof b[field] !== 'string' || (b[field] as string).length === 0) {
      throw new Error(`${field} is required`);
    }
  }
  const rating = b.rating;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error('rating must be an integer between 1 and 5');
  }
  return {
    orderId: b.orderId as string,
    productId: b.productId as string,
    rating,
    title: b.title as string,
    content: b.content as string,
    stellarAccount: b.stellarAccount as string,
    signature: b.signature as string,
  };
}

export const reviewsRouter = Router();

export async function verifyBuyerHandler(req: Request, res: Response): Promise<void> {
  try {
    const payload = validatePayload(req.body);
    const authenticatedAccount = (req as Request & { user?: { stellarAccount?: string } }).user
      ?.stellarAccount;

    if (!authenticatedAccount) {
      res.status(403).json({ verified: false, errorMessage: 'unauthenticated account' });
      return;
    }

    const message = buildReviewHash(payload);
    const signature = decodeSignature(payload.signature);

    if (!verifyEd25519Signature(payload.stellarAccount, message, signature)) {
      res.status(403).json({ verified: false, errorMessage: 'invalid signature' });
      return;
    }

    const verification = await verifyBuyer(payload, authenticatedAccount);

    if (!verification.verified) {
      res.status(403).json({
        verified: false,
        escrowContractId: verification.escrowContractId,
        settledLedgerSequence: verification.settledLedgerSequence,
        errorMessage: verification.errorMessage ?? 'buyer verification failed',
      });
      return;
    }

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO reviews
         (order_id, product_id, rating, title, content, stellar_account,
          signature, is_verified_buyer, escrow_contract_id, settled_ledger_sequence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9)
       RETURNING id`,
      [
        payload.orderId,
        payload.productId,
        payload.rating,
        payload.title,
        payload.content,
        payload.stellarAccount,
        payload.signature,
        verification.escrowContractId,
        verification.settledLedgerSequence ?? null,
      ],
    );

    res.status(201).json({
      verified: true,
      reviewId: inserted.rows[0].id,
      escrowContractId: verification.escrowContractId,
      settledLedgerSequence: verification.settledLedgerSequence,
      isVerifiedBuyer: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unexpected error';
    const status = /required$|must be|invalid/.test(message) ? 400 : 500;
    res.status(status).json({ verified: false, errorMessage: message });
  }
}

reviewsRouter.post('/verify-buyer', requireAuth, verifyBuyerHandler);
