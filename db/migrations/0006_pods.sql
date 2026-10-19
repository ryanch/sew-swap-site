-- Phase 6: the manager's private tools for pairing makers. None of this is shown to participants.

-- A group of makers who will make for each other. A participant with no PodId is in the "Default" pod.
CREATE TABLE Pods (
  SwapId STRING(36) NOT NULL,
  PodId STRING(36) NOT NULL,
  Name STRING(100) NOT NULL,
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (SwapId, PodId),
  INTERLEAVE IN PARENT Swaps ON DELETE CASCADE;

-- Only used on 'participant' rows, so leaving the swap clears them.
ALTER TABLE SwapMembers ADD COLUMN SkillLevel INT64;      -- 1 Beginner … 5 Expert; NULL = not rated
ALTER TABLE SwapMembers ADD COLUMN PodId STRING(36);      -- NULL = the Default pod
ALTER TABLE SwapMembers ADD CONSTRAINT CK_SwapMembersSkill CHECK (SkillLevel BETWEEN 1 AND 5);

-- MakerId makes for RecipientId. Belongs to people, not pods: anyone can make for anyone in the swap.
CREATE TABLE Assignments (
  SwapId STRING(36) NOT NULL,
  MakerId STRING(36) NOT NULL,
  RecipientId STRING(36) NOT NULL,
  CreatedBy STRING(36) NOT NULL,
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (SwapId, MakerId, RecipientId),
  INTERLEAVE IN PARENT Swaps ON DELETE CASCADE;

CREATE INDEX AssignmentsByRecipient ON Assignments (SwapId, RecipientId);
