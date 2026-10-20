-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "providerFee" DECIMAL(12,2),
ADD COLUMN     "sellerReceives" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "sellerShares" JSONB;
