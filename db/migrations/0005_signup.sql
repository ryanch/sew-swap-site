-- Phase 5: what a participant must give to join a swap. Saved per user and prefilled next time.

CREATE TABLE UserProfiles (
  UserId STRING(36) NOT NULL,
  RecipientName STRING(200),
  Country STRING(2),                   -- ISO 3166-1 alpha-2
  AddressLine1 STRING(200),
  AddressLine2 STRING(200),
  City STRING(100),
  Region STRING(100),                  -- state/province code for US and CA, free text elsewhere
  PostalCode STRING(20),
  InstagramHandle STRING(30),
  InstagramStatus STRING(16),          -- 'public' | 'exists' | 'unknown'; failed checks clear it
  InstagramCheckedAt TIMESTAMP OPTIONS (allow_commit_timestamp = true),
  InstagramStrategy STRING(32),        -- the strategy that decided, to spot one that breaks
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (UserId),
  INTERLEAVE IN PARENT Users ON DELETE CASCADE;

-- One row per "Check my Instagram" press: rate limiting, and a record of which strategies still work.
CREATE TABLE InstagramChecks (
  UserId STRING(36) NOT NULL,
  CheckId STRING(36) NOT NULL,
  CheckedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  Input STRING(300) NOT NULL,
  Handle STRING(30),
  Result STRING(16) NOT NULL,          -- 'pending' until the strategies finish
  Strategy STRING(32),
) PRIMARY KEY (UserId, CheckId),
  ROW DELETION POLICY (OLDER_THAN(CheckedAt, INTERVAL 30 DAY));

-- True when the check was inconclusive and the participant confirmed their account is public.
ALTER TABLE SwapMembers ADD COLUMN InstagramPublicConfirmed BOOL;
