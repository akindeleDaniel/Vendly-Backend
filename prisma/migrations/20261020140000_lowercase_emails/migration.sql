-- Emails are now stored trimmed and in lowercase, so one address cannot be registered twice with different capital letters.
-- If two existing accounts differ only by case this fails on the unique index; resolve them by hand first.
UPDATE "User" SET "email" = lower(trim("email")) WHERE "email" <> lower(trim("email"));
