-- Migration: 017_subscriptions
-- Description: Recurring payment subscription plans, subscriptions, and the
-- per-billing-period escrow charge ledger (Issue #47).
--
-- Subscription charges are tracked in their own table rather than
-- payment_records: payment_records.order_id is a hard FK into the
-- marketplace `orders` table, but a recurring billing cycle has no
-- corresponding order — it's billed directly between the parties on the
-- plan's cadence.

CREATE TABLE IF NOT EXISTS subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id VARCHAR(56) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount_stroops BIGINT NOT NULL,
  currency VARCHAR(56) NOT NULL,
  interval VARCHAR(10) NOT NULL CHECK (interval IN ('day', 'week', 'month', 'year')),
  interval_count INT NOT NULL DEFAULT 1 CHECK (interval_count > 0),
  trial_days INT,
  usage_based BOOLEAN NOT NULL DEFAULT false,
  max_amount_stroops BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_merchant_id ON subscription_plans(merchant_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES subscription_plans(id),
  buyer_address VARCHAR(56) NOT NULL,
  seller_address VARCHAR(56) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('active', 'paused', 'cancelled', 'past_due', 'trialing')),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  trial_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  payment_method_type VARCHAR(10) NOT NULL CHECK (payment_method_type IN ('escrow', 'wallet')),
  escrow_contract_id VARCHAR(56),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_id ON subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_buyer_address ON subscriptions(buyer_address);
-- Drives the billing scheduler's "what's due" scan.
CREATE INDEX IF NOT EXISTS idx_subscriptions_current_period_end
  ON subscriptions(current_period_end)
  WHERE status IN ('active', 'past_due', 'trialing');

CREATE TABLE IF NOT EXISTS subscription_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  amount_stroops BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  escrow_id VARCHAR(64),
  fund_tx_hash VARCHAR(64),
  release_tx_hash VARCHAR(64),
  failure_reason TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One charge attempt record per billing period — retries update the same
-- row instead of creating duplicates, so a scheduler re-run can't double-bill.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_charges_period
  ON subscription_charges(subscription_id, period_start);

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_subscription_charges_period;
-- DROP TABLE IF EXISTS subscription_charges;
-- DROP INDEX IF EXISTS idx_subscriptions_current_period_end;
-- DROP INDEX IF EXISTS idx_subscriptions_buyer_address;
-- DROP INDEX IF EXISTS idx_subscriptions_status;
-- DROP INDEX IF EXISTS idx_subscriptions_plan_id;
-- DROP TABLE IF EXISTS subscriptions;
-- DROP INDEX IF EXISTS idx_subscription_plans_merchant_id;
-- DROP TABLE IF EXISTS subscription_plans;
