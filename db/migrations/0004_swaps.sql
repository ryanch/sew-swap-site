-- Phase 4: swaps and who runs them

CREATE TABLE Swaps (
  SwapId STRING(36) NOT NULL,
  Title STRING(200) NOT NULL,
  Description STRING(5000) NOT NULL,
  MakingDeadline DATE NOT NULL,
  PartnersAnnounced DATE NOT NULL,
  ShipBy DATE NOT NULL,
  SignUpOpens DATE NOT NULL,
  SignUpCloses DATE NOT NULL,
  CreatedBy STRING(36) NOT NULL,
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  CONSTRAINT CK_SwapsSignUp CHECK (SignUpOpens <= SignUpCloses),
) PRIMARY KEY (SwapId);

CREATE TABLE SwapMembers (
  SwapId STRING(36) NOT NULL,
  UserId STRING(36) NOT NULL,
  Role STRING(32) NOT NULL,            -- 'manager' | 'helper' | 'participant'
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  CONSTRAINT CK_SwapMembersRole CHECK (Role IN ('manager', 'helper', 'participant')),
) PRIMARY KEY (SwapId, UserId),
  INTERLEAVE IN PARENT Swaps ON DELETE CASCADE;

CREATE INDEX SwapMembersByUser ON SwapMembers (UserId, SwapId);
