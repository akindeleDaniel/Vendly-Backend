-- Accounts that exist when email verification is introduced were created without it. They are treated as verified
-- so their owners can still log in; only accounts created afterwards must prove their email.
UPDATE "User" SET "emailVerifiedAt" = now() WHERE "emailVerifiedAt" IS NULL;
