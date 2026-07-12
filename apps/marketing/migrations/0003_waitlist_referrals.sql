ALTER TABLE waitlist_signups ADD COLUMN referral_code TEXT;
ALTER TABLE waitlist_signups ADD COLUMN referred_by TEXT;
ALTER TABLE waitlist_signups ADD COLUMN referral_count INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_referral_code ON waitlist_signups(referral_code);
CREATE INDEX IF NOT EXISTS idx_waitlist_referred_by ON waitlist_signups(referred_by);
