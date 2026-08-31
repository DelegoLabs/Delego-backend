-- Migration: 028_workflow_templates
-- Description: Workflow template registry, versions, instantiation, and ratings

-- Template definitions (immutable versions stored as JSONB rows).
CREATE TABLE IF NOT EXISTS workflow_templates (
  id VARCHAR(255) NOT NULL,
  version VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category VARCHAR(100) NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]',
  definition JSONB NOT NULL,
  parameters JSONB NOT NULL DEFAULT '[]',
  parent_template_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(255) NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_templates_id
  ON workflow_templates(id);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_category
  ON workflow_templates(category);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_parent
  ON workflow_templates(parent_template_id);

-- Instantiation audit trail.
CREATE TABLE IF NOT EXISTS template_instantiations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id VARCHAR(255) NOT NULL,
  template_version VARCHAR(100) NOT NULL,
  workflow_id VARCHAR(255) NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}',
  instantiated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  instantiated_by VARCHAR(255) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_template_instantiations_template_id
  ON template_instantiations(template_id);
CREATE INDEX IF NOT EXISTS idx_template_instantiations_workflow_id
  ON template_instantiations(workflow_id);

-- Marketplace ratings (one per user per template).
CREATE TABLE IF NOT EXISTS template_ratings (
  template_id VARCHAR(255) NOT NULL,
  rated_by VARCHAR(255) NOT NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (template_id, rated_by)
);

CREATE INDEX IF NOT EXISTS idx_template_ratings_template_id
  ON template_ratings(template_id);

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_template_ratings_template_id;
-- DROP TABLE IF EXISTS template_ratings;
-- DROP INDEX IF EXISTS idx_template_instantiations_workflow_id;
-- DROP INDEX IF EXISTS idx_template_instantiations_template_id;
-- DROP TABLE IF EXISTS template_instantiations;
-- DROP INDEX IF EXISTS idx_workflow_templates_parent;
-- DROP INDEX IF EXISTS idx_workflow_templates_category;
-- DROP INDEX IF EXISTS idx_workflow_templates_id;
-- DROP TABLE IF EXISTS workflow_templates;
