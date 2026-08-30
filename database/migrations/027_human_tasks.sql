-- Migration: 027_human_tasks
-- Description: Human task management for workflows requiring manual approval or intervention.
--   - human_tasks: the task record itself (routing, SLA, form, status lifecycle)
--   - task_routing_rules: routing strategies per workflow+task type
--   - task_comments: free-form comments on a task
--   - task_attachments: file metadata attached to a task
--   - task_delegations: audit trail of delegation events

CREATE TABLE IF NOT EXISTS human_tasks (
  id UUID PRIMARY KEY,
  workflow_id VARCHAR(128) NOT NULL,
  workflow_type VARCHAR(64) NOT NULL,
  task_type VARCHAR(32) NOT NULL
    CHECK (task_type IN ('approval', 'review', 'data_entry', 'verification', 'exception')),
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority VARCHAR(16) NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee VARCHAR(128),
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'assigned', 'claimed', 'in_progress', 'completed', 'rejected', 'escalated', 'expired')),
  form_schema JSONB,
  form_data JSONB,
  sla_hours NUMERIC(10, 2) NOT NULL DEFAULT 24,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_human_tasks_assignee_status
  ON human_tasks(assignee, status);
CREATE INDEX IF NOT EXISTS idx_human_tasks_candidates
  ON human_tasks USING GIN (candidates);
CREATE INDEX IF NOT EXISTS idx_human_tasks_workflow
  ON human_tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_human_tasks_workflow_type
  ON human_tasks(workflow_type, task_type);
CREATE INDEX IF NOT EXISTS idx_human_tasks_due_at
  ON human_tasks(due_at, status);
CREATE INDEX IF NOT EXISTS idx_human_tasks_created_at
  ON human_tasks(created_at);

CREATE TABLE IF NOT EXISTS task_routing_rules (
  id UUID PRIMARY KEY,
  workflow_type VARCHAR(64) NOT NULL,
  task_type VARCHAR(32) NOT NULL,
  strategy VARCHAR(32) NOT NULL
    CHECK (strategy IN ('round_robin', 'least_loaded', 'skill_based', 'priority', 'specific_user')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  fallback_assignee VARCHAR(128) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workflow_type, task_type)
);

CREATE INDEX IF NOT EXISTS idx_task_routing_rules_strategy
  ON task_routing_rules(strategy);

CREATE TABLE IF NOT EXISTS task_comments (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES human_tasks(id) ON DELETE CASCADE,
  author_id VARCHAR(128) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task
  ON task_comments(task_id, created_at);

CREATE TABLE IF NOT EXISTS task_attachments (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES human_tasks(id) ON DELETE CASCADE,
  file_name VARCHAR(512) NOT NULL,
  mime_type VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  storage_key VARCHAR(1024) NOT NULL,
  uploaded_by VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_attachments_task
  ON task_attachments(task_id);

CREATE TABLE IF NOT EXISTS task_delegations (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES human_tasks(id) ON DELETE CASCADE,
  from_assignee VARCHAR(128) NOT NULL,
  to_assignee VARCHAR(128) NOT NULL,
  reason TEXT,
  delegated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_delegations_task
  ON task_delegations(task_id);

-- Down migration (manual rollback)
-- DROP TABLE IF EXISTS task_delegations;
-- DROP TABLE IF EXISTS task_attachments;
-- DROP TABLE IF EXISTS task_comments;
-- DROP TABLE IF EXISTS task_routing_rules;
-- DROP TABLE IF EXISTS human_tasks;
