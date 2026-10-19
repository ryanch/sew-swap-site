-- Phase 7: the manager publishes who makes for whom, and each maker confirms. Plus the in-app log of emails.

-- NULL until the manager publishes makers. "Partners announced" is only a guide; nothing publishes on its own.
ALTER TABLE Swaps ADD COLUMN MakersPublishedAt TIMESTAMP OPTIONS (allow_commit_timestamp = true);
ALTER TABLE Swaps ADD COLUMN MakersPublishedBy STRING(36);

-- Set when the maker ticks all three boxes for this recipient. NULL = still to confirm.
ALTER TABLE Assignments ADD COLUMN ConfirmedAt TIMESTAMP OPTIONS (allow_commit_timestamp = true);

-- Every notification email, so people can read them again in the app. Sign-in emails are not kept: they hold live codes.
CREATE TABLE EmailLog (
  UserId STRING(36) NOT NULL,
  EmailId STRING(36) NOT NULL,
  SentAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  Kind STRING(32) NOT NULL,            -- 'makers_published' | 'new_pairing' | 'confirm_reminder'
  SwapId STRING(36),
  Subject STRING(300) NOT NULL,
  Body STRING(MAX) NOT NULL,           -- the plain-text part
  Status STRING(16) NOT NULL,          -- 'sending' until the mail server answers, then 'sent' or 'failed'
) PRIMARY KEY (UserId, EmailId),
  INTERLEAVE IN PARENT Users ON DELETE CASCADE;

-- When each maker was last reminded, for the manager's pending list.
CREATE INDEX EmailLogBySwap ON EmailLog (SwapId, Kind, UserId);

-- A maker's pairings across every swap, for their "who am I making for" page.
CREATE INDEX AssignmentsByMaker ON Assignments (MakerId);
