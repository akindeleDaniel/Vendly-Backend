-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSING', 'NEEDS_ATTENTION', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "LiabilityStatus" AS ENUM ('OPEN', 'CLEARED', 'WRITTEN_OFF', 'VOID');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "liabilityDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "vendlyShareKobo" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Refund" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER,
    "paymentAttemptId" INTEGER NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "customerNote" TEXT,
    "restock" BOOLEAN NOT NULL DEFAULT false,
    "chargeSeller" BOOLEAN NOT NULL DEFAULT true,
    "providerRefundId" TEXT,
    "providerStatus" TEXT,
    "awaitingFunds" BOOLEAN NOT NULL DEFAULT false,
    "expectedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "requestedById" INTEGER NOT NULL,
    "restockedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerLiability" (
    "id" SERIAL NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "refundId" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "recovered" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "LiabilityStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SellerLiability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiabilityRecovery" (
    "id" SERIAL NOT NULL,
    "liabilityId" INTEGER NOT NULL,
    "orderId" INTEGER,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiabilityRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Refund_reference_key" ON "Refund"("reference");

-- CreateIndex
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");

-- CreateIndex
CREATE INDEX "Refund_paymentAttemptId_idx" ON "Refund"("paymentAttemptId");

-- CreateIndex
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_provider_providerRefundId_key" ON "Refund"("provider", "providerRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerLiability_refundId_key" ON "SellerLiability"("refundId");

-- CreateIndex
CREATE INDEX "SellerLiability_sellerId_status_idx" ON "SellerLiability"("sellerId", "status");

-- CreateIndex
CREATE INDEX "LiabilityRecovery_orderId_idx" ON "LiabilityRecovery"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "LiabilityRecovery_liabilityId_orderId_key" ON "LiabilityRecovery"("liabilityId", "orderId");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerLiability" ADD CONSTRAINT "SellerLiability_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerLiability" ADD CONSTRAINT "SellerLiability_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityRecovery" ADD CONSTRAINT "LiabilityRecovery_liabilityId_fkey" FOREIGN KEY ("liabilityId") REFERENCES "SellerLiability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityRecovery" ADD CONSTRAINT "LiabilityRecovery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
