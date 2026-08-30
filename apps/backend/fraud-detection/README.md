# @delegolabs/fraud-detection

Fraud detection service with ML-based scoring, rule engine, and manual review queue.

## Features

- **ML Transaction Scoring**: XGBoost-based fraud prediction with <50ms latency
- **Velocity Rules**: Frequency, amount, and geography-based rules
- **Device Fingerprinting**: Track and analyze device patterns
- **Fraud Data Providers**: Integration with external fraud databases
- **Manual Review Queue**: Analyst-friendly case management
- **Fraud Analytics**: Dashboard for monitoring and insights
- **Model Retraining**: Automated monthly retraining pipeline

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  API Gateway    │────>│ Fraud Detection  │────>│ Payment Service │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                             │      ▲
                             ▼      │
                     ┌──────────────────┐
                     │  Rule Engine     │
                     │  ML Scorer       │
                     │  Feature Store   │
                     └──────────────────┘
                             │
                     ┌──────────────────┐
                     │  Case Management │
                     │  Analytics       │
                     └──────────────────┘
```

## Installation

```bash
cd apps/backend/fraud-detection
npm install
```

## Usage

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## API Endpoints

### Fraud Check
- `POST /api/v1/fraud/check` - Check transaction for fraud

### Rules Management
- `GET /api/v1/rules` - List all rules
- `POST /api/v1/rules` - Create a rule
- `GET /api/v1/rules/:id` - Get rule details
- `PATCH /api/v1/rules/:id` - Update rule
- `DELETE /api/v1/rules/:id` - Delete rule
- `POST /api/v1/rules/evaluate` - Evaluate rules against transaction

### ML Model
- `GET /api/v1/model/version` - Get current model version
- `POST /api/v1/model/retrain` - Trigger model retraining
- `GET /api/v1/model/performance` - Get model performance metrics

### Cases
- `GET /api/v1/cases` - List cases
- `POST /api/v1/cases` - Create a case
- `GET /api/v1/cases/:id` - Get case details
- `PATCH /api/v1/cases/:id` - Update case status
- `POST /api/v1/cases/:id/evidence` - Add evidence to case

### Analytics
- `GET /api/v1/analytics/fraud-rate` - Get fraud rate metrics
- `GET /api/v1/analytics/trends` - Get fraud trends
- `GET /api/v1/analytics/top-fraud-rules` - Get top fraud-triggering rules

## Configuration

```env
# Database
DATABASE_URL=postgresql://delego:delego@localhost:5432/delego

# Redis (for feature store)
REDIS_URL=redis://localhost:6379

# External Services
FRAUD_DATA_API_URL=https://api.fraudprovider.com/v1
FRAUD_DATA_API_KEY=your-api-key

# ML Model
MODEL_PATH=/models/fraud_xgboost.json
MODEL_VERSION=v1.0.0

# Service
NODE_ENV=development
LOG_LEVEL=info
FRAUD_SERVICE_PORT=3013
```
