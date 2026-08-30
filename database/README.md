# Database

This directory contains the PostgreSQL database schema, migrations, and seed data for the Delego platform.

## 📋 Table of Contents

- [Overview](#overview)
- [Directory Structure](#directory-structure)
- [Schema](#schema)
- [Migrations](#migrations)
- [Seed Data](#seed-data)
- [Development](#development)
- [Database Management](#database-management)
- [Best Practices](#best-practices)

## Overview

Delego uses PostgreSQL as its primary relational database for storing user data, delegations, orders, transactions, and audit logs. The database is designed with performance, scalability, and data integrity in mind.

### Database Design Principles

- **Normalization**: Proper normalization to reduce redundancy
- **Indexing**: Strategic indexing for query performance
- **Constraints**: Foreign keys and constraints for data integrity
- **Audit Trail**: Complete audit logging for transparency
- **Time-Series**: Proper timestamp management for temporal data

## Directory Structure

```
database/
├── schema/              # Initial schema definitions
│   ├── 001_initial.sql  # Initial database schema
│   ├── 002_orchestrator_sagas.sql
│   └── 003_purchase_workflows.sql
├── migrations/          # Versioned database migrations
│   └── README.md        # Migration guidelines
├── seed/                # Development seed data
│   └── dev.sql          # Development seed data
└── README.md            # This file
```

## Schema

### Core Tables

#### users

Stores user account information and authentication data.

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    stellar_address VARCHAR(56) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

#### wallets

Stores Stellar wallet information and metadata.

```sql
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    stellar_address VARCHAR(56) UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    encrypted_private_key TEXT,
    network VARCHAR(20) DEFAULT 'testnet',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

#### delegations

Stores AI agent delegation configurations.

```sql
CREATE TABLE delegations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    agent_type VARCHAR(50) NOT NULL,
    spending_limit BIGINT NOT NULL,
    approval_threshold BIGINT DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

#### orders

Stores purchase order information and status.

```sql
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    delegation_id UUID REFERENCES delegations(id),
    status VARCHAR(50) DEFAULT 'initiated',
    total_amount BIGINT,
    currency VARCHAR(10) DEFAULT 'XLM',
    escrow_contract_id VARCHAR(56),
    merchant_address VARCHAR(56),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

#### transactions

Stores on-chain transaction records.

```sql
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    transaction_hash VARCHAR(64) UNIQUE NOT NULL,
    type VARCHAR(50) NOT NULL,
    amount BIGINT,
    from_address VARCHAR(56),
    to_address VARCHAR(56),
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

#### audit_logs

Stores system audit trail for transparency and debugging.

```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id UUID,
    metadata JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

#### notifications

Stores notification history and delivery status.

```sql
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    channel VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    content JSONB NOT NULL,
    sent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

#### sessions

Stores user session information.

```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Indexes

Strategic indexes are created for query optimization:

```sql
-- User indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_stellar_address ON users(stellar_address);

-- Wallet indexes
CREATE INDEX idx_wallets_user_id ON wallets(user_id);
CREATE INDEX idx_wallets_stellar_address ON wallets(stellar_address);

-- Delegation indexes
CREATE INDEX idx_delegations_user_id ON delegations(user_id);
CREATE INDEX idx_delegations_status ON delegations(status);

-- Order indexes
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);

-- Transaction indexes
CREATE INDEX idx_transactions_order_id ON transactions(order_id);
CREATE INDEX idx_transactions_hash ON transactions(transaction_hash);

-- Audit log indexes
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);

-- Notification indexes
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_status ON notifications(status);

-- Session indexes
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
```

## Migrations

### Migration System

Delego uses a versioned migration system to manage database schema changes. Migrations are applied in order and tracked to ensure consistency.

### Creating a Migration

1. Create a new migration file in `database/migrations/`
2. Name it with a sequential number: `002_add_user_preferences.sql`
3. Write the migration SQL
4. Include both up and down migrations

### Migration Template

```sql
-- Migration: 002_add_user_preferences.sql
-- Description: Add user preferences table

-- Up migration
CREATE TABLE user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    notification_email BOOLEAN DEFAULT true,
    notification_push BOOLEAN DEFAULT true,
    language VARCHAR(10) DEFAULT 'en',
    timezone VARCHAR(50) DEFAULT 'UTC',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_user_preferences_user_id ON user_preferences(user_id);

-- Down migration
DROP INDEX IF EXISTS idx_user_preferences_user_id;
DROP TABLE IF EXISTS user_preferences;
```

### Running Migrations

```bash
# Apply all pending migrations
pnpm db:migrate
```

Migrations are tracked by the runner at `scripts/setup/migrate.js`. Rollback and reset are not supported; write new migrations to correct schema issues.

## Seed Data

### Development Seed Data

Seed data provides realistic test data for development and testing environments.

### Seed Data Structure

```sql
-- Seed users
INSERT INTO users (email, stellar_address) VALUES
('test@example.com', 'GABCD...'),
('merchant@example.com', 'GEFHI...');

-- Seed wallets
INSERT INTO wallets (user_id, stellar_address, public_key) VALUES
((SELECT id FROM users WHERE email = 'test@example.com'), 'GABCD...', 'public_key_1');

-- Seed delegations
INSERT INTO delegations (user_id, agent_type, spending_limit) VALUES
((SELECT id FROM users WHERE email = 'test@example.com'), 'buyer', 10000000);
```

### Running Seed Data

```bash
# Seed development data
pnpm db:seed
```

## Development

### Local Database Setup

```bash
# Start PostgreSQL container
pnpm docker:up

# Apply migrations
pnpm db:migrate

# Seed development data
pnpm db:seed
```

### Database Connection

The database is accessible via Docker Compose:

- **Host**: localhost
- **Port**: 5432
- **Database**: delego
- **User**: delego
- **Password**: delego (development)

Connection string:
```
postgresql://delego:delego@localhost:5432/delego
```

### Database Tools

Recommended tools for database management:

- **pgAdmin**: GUI for PostgreSQL management
- **psql**: Command-line PostgreSQL client
- **DBeaver**: Universal database tool
- **TablePlus**: Modern database GUI

### Connecting with psql

```bash
# Connect to database
docker exec -it delego-postgres psql -U delego -d delego

# View all tables
\dt

# View table structure
\d users

# Run SQL file
\i /path/to/file.sql

# Exit
\q
```

## Database Management

### Backup

```bash
# Create backup
docker exec delego-postgres pg_dump -U delego delego > backup.sql

# Restore backup
docker exec -i delego-postgres psql -U delego delego < backup.sql
```

### Monitoring

Monitor database performance:

```sql
-- Check active connections
SELECT count(*) FROM pg_stat_activity;

-- Check table sizes
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Check slow queries
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

### Maintenance

Regular maintenance tasks:

```sql
-- Analyze tables for query optimization
ANALYZE users;
ANALYZE orders;
ANALYZE transactions;

-- Reindex tables
REINDEX TABLE users;
REINDEX TABLE orders;

-- Vacuum to reclaim space
VACUUM ANALYZE;
```

### Time-Series Optimization

Native PostgreSQL 16 time-series tuning (migration `026_time_series_optimization.sql`)
provides declarative range partitioning, BRIN acceleration, TOAST compression,
retention enforcement, continuous aggregates (materialized views), and
hot/warm/cold data tiering for the canonical `ts_metrics`, `ts_events`, and
`ts_audit_events` tables, all driven by config tables:

- `time_series_table_config` — mirrors `TimeSeriesTableConfig`
- `continuous_aggregate_config` — mirrors `ContinuousAggregate`
- `data_tiering_policy` — mirrors `DataTieringPolicy`

```bash
# Run one maintenance cycle (create look-ahead + drop expired partitions,
# refresh continuous aggregates, apply data tiering) immediately
pnpm db:ts-maintain:once

# Run maintenance every 60 minutes (wire this into cron/systemd instead)
pnpm db:ts-maintain

# Seed sample rows and measure time-range query latency (< 50 ms target)
pnpm db:ts-benchmark
```

SQL entry points (callable directly or via the scripts):

```sql
SELECT * FROM ts_maintain(2);                      -- create + drop partitions
SELECT * FROM ts_apply_retention();                -- enforce retention policies
SELECT * FROM ts_refresh_continuous_aggregates();  -- refresh continuous aggregates
SELECT * FROM ts_apply_tiering();                  -- hot/warm/cold classification
SELECT * FROM ts_benchmark_time_range('ts_events', NOW() - INTERVAL '1 hour', NOW());
SELECT * FROM ts_list_partitions('ts_events');
```

Compression ratio can be measured with the physical vs. logical size comparison:

```sql
SELECT pg_size_pretty(pg_total_relation_size('ts_events'))       AS physical,
       pg_size_pretty(pg_database_size(current_database()))      AS db_size;
```

## Best Practices

### Schema Design

- Use UUIDs for primary keys
- Include created_at and updated_at timestamps
- Use appropriate data types (BIGINT for amounts, TIMESTAMP WITH TIME ZONE for dates)
- Add foreign key constraints for relationships
- Create indexes for frequently queried columns
- Use JSONB for flexible metadata storage

### Query Optimization

- Use EXPLAIN ANALYZE to analyze query performance
- Avoid SELECT * in production queries
- Use parameterized queries to prevent SQL injection
- Implement connection pooling
- Cache frequently accessed data in Redis

### Data Integrity

- Use database constraints for validation
- Implement proper foreign key relationships
- Use transactions for multi-step operations
- Add unique constraints where appropriate
- Implement proper error handling

### Security

- Never commit database credentials
- Use environment variables for configuration
- Implement proper user permissions
- Use prepared statements
- Regular security audits
- Monitor for suspicious activity

### Migration Best Practices

- Write reversible migrations
- Test migrations in development first
- Use descriptive migration names
- Document breaking changes
- Keep migrations small and focused
- Never modify existing migrations

## Troubleshooting

### Common Issues

**Migration Failures**
```bash
# Check migration runner logs
node scripts/setup/migrate.js --help
```

**Connection Issues**
```bash
# Check if PostgreSQL is running
docker ps | grep postgres

# Check logs
docker logs delego-postgres

# Restart container
docker restart delego-postgres
```

**Performance Issues**
```sql
-- Check for long-running queries
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE (now() - pg_stat_activity.query_start) > interval '5 minutes';
```

## Documentation

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Docker PostgreSQL](https://hub.docker.com/_/postgres)
- [Database Design Best Practices](https://use-the-index-luke.com/)

---

**Last Updated**: August 2026
