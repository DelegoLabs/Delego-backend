# @delegolabs/analytics

Notification analytics platform with delivery tracking, engagement metrics, and A/B testing.

## Features

- **Delivery Funnel Tracking**: Track notifications from sent → delivered → opened → clicked → converted
- **Engagement Metrics**: Per-template/channel analytics with time-to-open, time-to-click, repeat behavior
- **A/B Testing**: Statistical significance testing with confidence intervals
- **Cohort Analysis**: Weekly cohort retention and engagement tracking
- **Real-time Dashboard**: Low-latency analytics queries
- **Revenue Attribution**: Link notification clicks to revenue events
- **Custom Events**: Track custom engagement events
- **Data Export**: Export to data warehouse for advanced analysis

## Installation

```bash
cd apps/backend/analytics
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

### Funnel Metrics
- `GET /api/v1/analytics/funnel` - Get delivery funnel metrics
- `GET /api/v1/analytics/engagement` - Get engagement metrics

### A/B Tests
- `GET /api/v1/analytics/ab-tests` - List A/B tests
- `POST /api/v1/analytics/ab-tests` - Create A/B test
- `GET /api/v1/analytics/ab-tests/:id` - Get A/B test details
- `PATCH /api/v1/analytics/ab-tests/:id` - Update A/B test
- `POST /api/v1/analytics/ab-tests/:id/start` - Start A/B test
- `POST /api/v1/analytics/ab-tests/:id/end` - End A/B test

### Cohort Analysis
- `GET /api/v1/analytics/cohorts` - Get cohort analysis

### Custom Events
- `POST /api/v1/analytics/events` - Track custom events

### Revenue Attribution
- `GET /api/v1/analytics/revenue` - Get revenue metrics

### Data Export
- `POST /api/v1/analytics/export` - Export data to warehouse

## Database Schema

### notification_events
- Tracks all notification events (sent, delivered, opened, clicked, converted, etc.)
- Indexed by notification_id, user_id, template_id, channel, event_type, timestamp

### ab_tests
- Stores A/B test configurations
- Status: draft, running, completed, archived

### ab_test_variants
- Stores variant configurations for A/B tests
- Links to templates and traffic split percentages

### cohort_analyses
- Weekly cohort retention and engagement tracking
- Tracks retention, engagement rate, and revenue per user

### revenue_attributions
- Links revenue events to notification events
- Tracks order_id, amount, currency, and category

### custom_events
- Tracks custom engagement events
- Supports user_id, session_id, event_name, properties, metadata

### data_export_logs
- Logs data export requests
- Tracks status, destination, and file location

## Development

### Running Migrations

```bash
# Using sequelize-cli
npx sequelize-cli db:migrate
```

### Running Tests

```bash
npm test
```

### Type Checking

```bash
npm run typecheck
```

## Configuration

```env
# Database
DATABASE_URL=postgresql://delego:delego@localhost:5432/delego

# Service
NODE_ENV=development
LOG_LEVEL=info
ANALYTICS_PORT=3012
```
