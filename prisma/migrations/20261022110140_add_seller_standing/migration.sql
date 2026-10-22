-- AlterTable
ALTER TABLE "Dispute" ADD COLUMN     "sellerAgreedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SellerProfile" ADD COLUMN     "blockReason" TEXT,
ADD COLUMN     "blockedAt" TIMESTAMP(3),
ADD COLUMN     "strikeWarnedAt" TIMESTAMP(3),
ADD COLUMN     "strikesResetAt" TIMESTAMP(3);
