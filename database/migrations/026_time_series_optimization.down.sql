-- Migration: 026_time_series_optimization (rollback)
-- Description: Tear down the native time-series optimization subsystem:
-- drops partitions, partitioned tables, materialized views, helper functions
-- and configuration tables created by 026_time_series_optimization.sql.

-- Drop all partitions physically (they are not dropped implicitly with the
-- parent partitioned table unless CASCADE).
DO $$
DECLARE
  r RECORD;
  parents regclass[];
BEGIN
  parents := ARRAY[
    to_regclass('public.ts_metrics'),
    to_regclass('public.ts_events'),
    to_regclass('public.ts_audit_events')
  ];
  FOR r IN
    SELECT inhrelid::regclass::text AS part, inhparent::regclass::text AS parent
    FROM pg_inherits
    WHERE inhparent = ANY (parents)
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I', r.part);
  END LOOP;
END
$$;

-- Continuous aggregate materialized views (depend on partitioned tables).
DROP MATERIALIZED VIEW IF EXISTS ts_events_daily;
DROP MATERIALIZED VIEW IF EXISTS ts_metrics_hourly;

-- Partitioned parent tables.
DROP TABLE IF EXISTS ts_audit_events;
DROP TABLE IF EXISTS ts_events;
DROP TABLE IF EXISTS ts_metrics;

-- Helper / automation / benchmark functions.
DROP FUNCTION IF EXISTS ts_benchmark_time_range(TEXT, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS ts_list_partitions(TEXT);
DROP FUNCTION IF EXISTS ts_apply_tiering();
DROP FUNCTION IF EXISTS ts_refresh_continuous_aggregates();
DROP FUNCTION IF EXISTS ts_apply_retention();
DROP FUNCTION IF EXISTS ts_maintain(INT);
DROP FUNCTION IF EXISTS ts_drop_expired_partitions_for_table(TEXT);
DROP FUNCTION IF EXISTS ts_create_partitions_for_table(TEXT, INT);
DROP FUNCTION IF EXISTS ts_backfill_partition(TEXT, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS ts_partition_suffix(TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS ts_parse_duration(TEXT);
DROP FUNCTION IF EXISTS ts_partition_interval(TEXT);

-- Configuration + bookkeeping tables.
DROP TABLE IF EXISTS ts_parts;
DROP TABLE IF EXISTS data_tiering_policy;
DROP TABLE IF EXISTS continuous_aggregate_config;
DROP TABLE IF EXISTS time_series_table_config;
