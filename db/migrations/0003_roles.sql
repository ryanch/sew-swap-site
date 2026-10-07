-- Phase 3: site-wide roles. Every signed-in person is a regular user, so that has no row.
-- Per-swap roles (manager, helper, participant) will live in a SwapMembers table keyed by SwapId.
CREATE TABLE UserRoles (
  UserId STRING(36) NOT NULL,
  Role STRING(32) NOT NULL,            -- 'admin' | 'swap_manager'
  GrantedBy STRING(36),                -- UserId of the admin; null when granted by ADMIN_EMAILS
  GrantedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  CONSTRAINT CK_UserRolesRole CHECK (Role IN ('admin', 'swap_manager')),
) PRIMARY KEY (UserId, Role),
  INTERLEAVE IN PARENT Users ON DELETE CASCADE;
