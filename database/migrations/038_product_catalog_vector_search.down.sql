-- Migration 038 down: remove product catalog and agent audit log tables
DROP TABLE IF EXISTS agent_tool_audit_log;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS merchants;
