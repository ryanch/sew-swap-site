-- Phase 2: users, sessions, and passwordless login tokens.

CREATE TABLE Users (
  UserId STRING(36) NOT NULL,
  Email STRING(320) NOT NULL,          -- always lowercased
  DisplayName STRING(200),
  GoogleSub STRING(255),               -- Google account id, set on first Google sign-in
  EmailVerifiedAt TIMESTAMP OPTIONS (allow_commit_timestamp = true),
  LastLoginAt TIMESTAMP OPTIONS (allow_commit_timestamp = true),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  UpdatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (UserId);

CREATE UNIQUE INDEX UsersByEmail ON Users(Email);

CREATE UNIQUE NULL_FILTERED INDEX UsersByGoogleSub ON Users(GoogleSub);

-- SessionIdHash = HMAC(cookie value); the raw token is never stored.
CREATE TABLE Sessions (
  SessionIdHash STRING(64) NOT NULL,
  UserId STRING(36) NOT NULL,
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  ExpiresAt TIMESTAMP NOT NULL,
  UserAgent STRING(512),
  IpAddress STRING(64),
  CONSTRAINT FK_SessionsUser FOREIGN KEY (UserId) REFERENCES Users(UserId),
) PRIMARY KEY (SessionIdHash),
  ROW DELETION POLICY (OLDER_THAN(ExpiresAt, INTERVAL 1 DAY));

CREATE INDEX SessionsByUser ON Sessions(UserId);

-- One row per "email me a sign-in link" request. The link and the code are
-- two ways to redeem the same token; using either consumes it.
CREATE TABLE LoginTokens (
  TokenId STRING(36) NOT NULL,
  Email STRING(320) NOT NULL,
  LinkTokenHash STRING(64) NOT NULL,
  CodeHash STRING(64) NOT NULL,
  Attempts INT64 NOT NULL,
  ExpiresAt TIMESTAMP NOT NULL,
  ConsumedAt TIMESTAMP OPTIONS (allow_commit_timestamp = true),
  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  RequestIp STRING(64),
) PRIMARY KEY (TokenId),
  ROW DELETION POLICY (OLDER_THAN(ExpiresAt, INTERVAL 1 DAY));

CREATE UNIQUE INDEX LoginTokensByLinkHash ON LoginTokens(LinkTokenHash);

CREATE INDEX LoginTokensByEmail ON LoginTokens(Email, CreatedAt DESC);
