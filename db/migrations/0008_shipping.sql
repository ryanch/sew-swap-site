-- Phase 8: makers mark each pairing shipped, with a tracking number. The recipient is emailed it.
-- New EmailLog kinds: 'ship_reminder' (the manager asks makers to ship) and 'package_shipped' (to the recipient).

-- Set when the maker says they shipped. Only allowed once the pairing is confirmed. NULL = not shipped yet.
ALTER TABLE Assignments ADD COLUMN ShippedAt TIMESTAMP OPTIONS (allow_commit_timestamp = true);
ALTER TABLE Assignments ADD COLUMN Carrier STRING(16);         -- 'usps' | 'ups' | 'fedex' | 'dhl' | 'canadapost' | 'purolator' | 'canpar' | 'other'
ALTER TABLE Assignments ADD COLUMN TrackingNumber STRING(40);  -- uppercase letters and digits, no spaces
