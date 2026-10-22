-- Rollback for 20261020_merchant_discount_codes.sql
DROP INDEX IF EXISTS idx_discount_merchant_code;
DROP TABLE IF EXISTS merchant_discount_codes;
