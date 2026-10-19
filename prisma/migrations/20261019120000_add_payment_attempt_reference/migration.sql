-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "authorizationUrl" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "providerTransactionId" TEXT,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- Existing attempts (none are created by application code yet) get a unique legacy reference.
UPDATE "PaymentAttempt" SET "reference" = 'LEGACY-' || "id" WHERE "reference" IS NULL;

ALTER TABLE "PaymentAttempt" ALTER COLUMN "reference" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_reference_key" ON "PaymentAttempt"("reference");
