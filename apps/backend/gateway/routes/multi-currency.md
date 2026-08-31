# Multi-Currency Support

Multi-currency payments with automatic conversion and settlement.

## Overview

The Multi-Currency system supports:

- **Multiple Assets**: XLM, USDC, EURC, custom assets
- **Path Payments**: Automatic route finding for currency conversions
- **FX Rate Oracle**: Real-time FX rates with configurable providers
- **Multi-Currency Escrow**: Support for escrow in any supported currency
- **Settlement**: Settlement in preferred currency
- **Risk Management**: Currency exposure tracking and VaR calculations
- **Compliance**: Per-jurisdiction regulatory compliance

## API Endpoints

### FX Rates

#### GET `/api/v1/fx/rate`

Get FX rate between two currencies.

**Query Parameters:**
- `baseCurrency` (required): Base currency code
- `quoteCurrency` (required): Quote currency code

**Response:**
```json
{
  "data": {
    "baseCurrency": "XLM",
    "quoteCurrency": "USDC",
    "rate": "0.1234",
    "source": "stellar_lumen",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "validUntil": "2024-01-01T00:01:00.000Z",
    "spread": "0.005"
  },
  "error": null
}
```

#### GET `/api/v1/fx/path`

Find conversion path between two currencies.

**Query Parameters:**
- `fromCurrency` (required): Source currency
- `toCurrency` (required): Destination currency

**Response:**
```json
{
  "data": {
    "path": [
      {
        "from": "XLM",
        "to": "USDC",
        "rate": "0.1234"
      }
    ],
    "totalRate": "0.1234"
  },
  "error": null
}
```

#### POST `/api/v1/fx/refresh`

Refresh all FX rates (admin only).

### Multi-Currency Payments

#### POST `/api/v1/payments/multi-currency`

Create a multi-currency payment.

**Request Body:**
```json
{
  "sourceCurrency": "XLM",
  "sourceAmount": "100",
  "destinationCurrency": "USDC",
  "destinationAddress": "GB...",
  "settlementCurrency": "USDC",
  "metadata": {
    "sourceAddress": "GB..."
  }
}
```

**Response:**
```json
{
  "data": {
    "paymentId": "payment-123",
    "sourceCurrency": "XLM",
    "sourceAmount": "100",
    "destinationCurrency": "USDC",
    "destinationAmount": "12.34",
    "fxRate": {...},
    "conversionPath": [...],
    "estimatedSettlementTime": "50000ms"
  },
  "error": null
}
```

#### POST `/api/v1/payments/multi-currency/:id/execute`

Execute path payment on Stellar network.

**Request Body:**
```json
{
  "transactionHash": "abc123..."
}
```

#### POST `/api/v1/payments/multi-currency/:id/complete`

Complete payment after Stellar confirmation.

**Request Body:**
```json
{
  "ledgerSequence": 123456
}
```

#### POST `/api/v1/payments/multi-currency/:id/fail`

Mark payment as failed.

**Request Body:**
```json
{
  "reason": "Insufficient funds"
}
```

#### GET `/api/v1/payments/multi-currency/:id`

Get payment details.

#### GET `/api/v1/payments/multi-currency`

List payments.

**Query Parameters:**
- `sourceCurrency`: Filter by source
- `destinationCurrency`: Filter by destination
- `status`: Filter by status
- `page`: Page number
- `limit`: Items per page

### Route and Exposure

#### GET `/api/v1/payments/multi-currency/route`

Get automatic route for currency conversion.

**Query Parameters:**
- `sourceCurrency` (required)
- `sourceAmount` (required)
- `destinationCurrency` (required)

**Response:**
```json
{
  "data": {
    "route": [
      {
        "from": "XLM",
        "to": "USDC",
        "rate": "0.1234",
        "amountOut": "12.34"
      }
    ],
    "estimatedRate": "0.1234",
    "minimumRate": "0.1221"
  },
  "error": null
}
```

#### GET `/api/v1/exposure/:accountId`

Calculate account exposure.

## Supported Currencies

| Currency | Code | Issuer | Asset Type | FX Provider |
|----------|------|--------|------------|-------------|
| Native XLM | XLM | N/A | native | stellar_lumen |
| USDC | USDC | GA... | issued | chainlink |
| EURC | EURC | GB... | issued | chainlink |
| ACH | ACH | GB... | issued | polygon_oracle |

## FX Rate Providers

- **stellar_lumen**: Real-time XLM rates from Stellar oracle
- **chainlink**: Chainlink price feeds for major assets
- **polygon_oracle**: Polygon oracle for USD pegged assets

## Data Models

### MultiCurrencyPayment

```typescript
interface MultiCurrencyPayment {
  id: string;
  sourceCurrency: string;
  sourceAmount: string;
  destinationCurrency: string;
  destinationAmount: string;
  fxRate: FXRate;
  conversionPath: ConversionPath[];
  settlementCurrency: string;
  status: "pending" | "converting" | "settled" | "failed" | "cancelled";
  stellarTransactionHash?: string;
  pathPaymentId?: string;
  sourceAddress: string;
  destinationAddress: string;
  destinationMin?: string; // Slippage protection
  createdAt: string;
  completedAt?: string;
  failedAt?: string;
  metadata: Record<string, unknown>;
}
```

### FXRate

```typescript
interface FXRate {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  source: string;
  timestamp: string;
  validUntil: string;
  spread: string;
  midRate: string;
  bid: string;
  ask: string;
}
```

### CurrencyExposure

```typescript
interface CurrencyExposure {
  currency: string;
  grossAmount: string;
  netAmount: string;
  unrealizedPnL: string;
  hedgeRatio: number;
  var95: string; // Value at Risk 95%
  var99: string; // Value at Risk 99%
  marginRequirement: string;
  collateralRequired: string;
  hedgeStatus: "unhedged" | "partially_hedged" | "fully_hedged";
}
```

## Payment Flow

```
1. User creates multi-currency payment
   └─> POST /api/v1/payments/multi-currency
   
2. System calculates FX rate and path
   ├─> Fetches FX rate from oracle
   ├─> Finds optimal conversion path
   └─> Calculates destination amount
   
3. Payment record created
   ├─> Status: "pending"
   └─> FX rate locked for 1 minute
   
4. User initiates Stellar path payment
   └─> POST /api/v1/payments/multi-currency/:id/execute
   
5. Payment executes on Stellar
   ├─> Submits path payment operation
   └─> Status: "converting"
   
6. Payment confirmed
   └─> POST /api/v1/payments/multi-currency/:id/complete
   ├─> Status: "settled"
   └─> Updates settlement record
   
7. Currency exposures updated
   ├─> Source currency exposure updated
   └─> Destination currency exposure updated
```

## FX Rate Locking

- Rates are cached for 60 seconds
- Payment uses locked rate even if market moves
- Rate refresh triggers new calculation

## Slippage Protection

- `destinationMin` field ensures minimum output
- Default: 1% below estimated amount
- Can be configured per payment

## Risk Management

### Exposure Tracking

- Gross exposure: Total position size
- Net exposure: Offset positions
- VaR: Value at Risk calculations
- Hedge ratio: Hedging coverage

### Daily Reports

```json
{
  "date": "2024-01-01",
  "totalGrossExposure": "1000000",
  "totalNetExposure": "500000",
  "currencies": [...],
  "hedgeSummary": {
    "totalHedged": "400000",
    "totalUnhedged": "100000",
    "hedgeCoverage": 0.8
  }
}
```

## Settlement

Settlement occurs in the specified currency:
- Daily settlement in each currency
- Netting of inflows/outflows
- Ledger sequence tracking

## Compliance

Each currency has compliance flags:
- `KYC`: Know Your Customer
- `AML`: Anti-Money Laundering
- `SANCTIONS`: Sanctions screening
- `REPORTING`: Reportable activity

## Migration

```bash
pnpm db:migrate
```

Rollback:
```bash
pnpm db:migrate -- --direction down --target 23
```

## Testing

```typescript
// 1. Get FX rate
const rate = await getFXRate({ baseCurrency: "XLM", quoteCurrency: "USDC" });

// 2. Find conversion path
const path = await findConversionPath("XLM", "EURC");

// 3. Create payment
const payment = await createMultiCurrencyPayment({
  sourceCurrency: "XLM",
  sourceAmount: "100",
  destinationCurrency: "EURC",
  destinationAddress: "GB...",
});

// 4. Execute payment
await executePathPayment(payment.id, "tx-hash");

// 5. Complete payment
await completeMultiCurrencyPayment(payment.id, 123456);
```

## Environment Variables

```bash
# FX Rate Providers
FX_PROVIDER_STELLAR_LUMEN=https://stellar-oracle.example.com
FX_PROVIDER_CHAINLINK=https://chainlink-oracle.example.com
FX_PROVIDER_POLYGON=https://polygon-oracle.example.com

# Rate Cache TTL (seconds)
FX_RATE_CACHE_TTL=60

# Slippage Protection (%)
PAYMENT_SLIPPAGE_PERCENT=1

# Settlement Configuration
SETTLEMENT_CURRENCY=XLM
```

## Limitations

- FX rates cached for 60 seconds
- Max 10 hops in conversion path
- Minimum payment: 1 stroop
- Maximum payment: 10 billion XLM equivalent

## License

MIT
