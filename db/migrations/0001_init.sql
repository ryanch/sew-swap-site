-- Phase 1: smoke-test table used by GET /api/health.
CREATE TABLE HelloMessages (
  Id STRING(36) NOT NULL,
  Message STRING(MAX),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (Id);
