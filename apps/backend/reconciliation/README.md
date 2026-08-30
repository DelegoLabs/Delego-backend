# @delegolabs/reconciliation

Automated payment reconciliation system for settlement verification and discrepancy resolution.

## Features

- **Daily Reconciliation Jobs**: Automated daily reconciliation with configurable schedules
- **Multi-Currency Support**: Handle multiple currencies with real-time exchange rates
- **Discrepancy Detection**: Identify and categorize discrepancies automatically
- **Auto-Resolution**: Smart resolution for known patterns (80%+ coverage)
- **Manual Investigation**: Workflow for manual discrepancy resolution
- **Reconciliation Reports**: Detailed reporting for auditors
- **Full Audit Trail**: Complete compliance history

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Reconciliation Engine                      │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────┐ │
│  │  Reconciler     │  │  Matcher         │  │  Resolver   │ │
│  └─────────────────┘  └──────────────────┘  └─────────────┘ │
│         │                   │                       │         │
│         ▼                   ▼                       ▼         │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────┐ │
│  │ Internal Records│  │ External Records │  │ Discrepancy │ │
│  └─────────────────┘  └──────────────────┘  └─────────────┘ │
│                            │                                 │
│                            ▼                                 │
│                   ┌──────────────────┐                      │
│                   │  Reporting &     │                      │
│                   │  Audit Trail     │                      │
│                   └──────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

## Installation

```bash
cd apps/backend/reconciliation
npm install
```

## Usage

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Run daily reconciliation
npm run reconcile:daily

# Run tests
npm test
```

## API Endpoints

### Reconciliation Jobs
- `GET /api/v1/reconciliation/jobs` - List reconciliation jobs
- `POST /api/v1/reconciliation/jobs` - Create manual reconciliation job
- `GET /api/v1/reconciliation/jobs/:id` - Get job details
- `PATCH /api/v1/reconciliation/jobs/:id/cancel` - Cancel job

### Reconciliation Records
- `GET /api/v1/reconciliation/records` - List reconciliation records
- `GET /api/v1/reconciliation/records/:id` - Get record details
- `PATCH /api/v1/reconciliation/records/:id/resolve` - Resolve discrepancy

### Reports
- `GET /api/v1/reconciliation/reports/:jobId` - Get reconciliation report
- `GET /api/v1/reconciliation/reports/summary` - Get summary report
- `GET /api/v1/reconciliation/discrepancies` - Get unresolved discrepancies

## Configuration

```env
# Database
DATABASE_URL=postgresql://delego:delego@localhost:5432/delego

# External Systems
BANK_API_URL=https://api.bank.com/v1
PROCESSOR_API_URL=https://api.processor.com/v1

# Exchange Rates
EXCHANGE_RATE_API=https://api.exchangerate.com/v1

# Scheduling
DAILY_RECONCILIATION_TIME=02:00
RECONCILIATION_TIMEZONE=UTC

# Resolution Thresholds
AUTO_RESOLUTION_THRESHOLD=80

# Service
NODE_ENV=development
LOG_LEVEL=info
RECONCILIATION_SERVICE_PORT=3014
```
