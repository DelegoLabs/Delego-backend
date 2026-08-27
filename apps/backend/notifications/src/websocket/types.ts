/**
 * WebSocket Transaction Status Updates — shared types
 * Issue #41
 */

export type TxEventType = "submitted" | "confirmed" | "failed";
export type TxStatus = "pending" | "success" | "failed";

export interface TransactionStatusEvent {
  type: TxEventType;
  transactionHash: string;
  ledger: number | null;
  status: TxStatus;
  /** ISO 8601 */
  timestamp: string;
  errorMessage: string | null;
}

export type WSAction = "subscribe" | "unsubscribe";

export interface WSSubscriptionMessage {
  action: WSAction;
  address: string;
  /** JWT bearer token */
  token: string;
}

export interface WSError {
  code: string;
  message: string;
}

export interface WSMessage {
  type: "event" | "error" | "ack" | "pong";
  data: TransactionStatusEvent | WSError | { message: string } | null;
}
