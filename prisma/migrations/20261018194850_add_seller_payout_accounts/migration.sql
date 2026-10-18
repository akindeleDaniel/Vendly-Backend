-- CreateEnum
CREATE TYPE "PayoutAccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED');

-- AlterTable
ALTER TABLE "SellerProfile" ADD COLUMN     "businessPhone" TEXT,
ADD COLUMN     "payoutTermsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "payoutTermsVersion" TEXT;

-- CreateTable
CREATE TABLE "SellerPayoutAccount" (
    "id" SERIAL NOT NULL,
    "sellerProfileId" INTEGER NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "status" "PayoutAccountStatus" NOT NULL DEFAULT 'PENDING',
    "subaccountCode" TEXT,
    "bankId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerPayoutAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerPayoutAccount_sellerProfileId_provider_key" ON "SellerPayoutAccount"("sellerProfileId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPayoutAccount_provider_subaccountCode_key" ON "SellerPayoutAccount"("provider", "subaccountCode");

-- AddForeignKey
ALTER TABLE "SellerPayoutAccount" ADD CONSTRAINT "SellerPayoutAccount_sellerProfileId_fkey" FOREIGN KEY ("sellerProfileId") REFERENCES "SellerProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
