-- CreateEnum
CREATE TYPE "FoodOrderType" AS ENUM ('NOW', 'PRE_ORDER', 'BOTH');

-- CreateEnum
CREATE TYPE "FulfilmentType" AS ENUM ('NOW', 'PRE_ORDER');

-- CreateEnum
CREATE TYPE "PreOrderStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'USED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "fulfilmentType" "FulfilmentType" NOT NULL DEFAULT 'NOW',
ADD COLUMN     "preOrderRequestId" INTEGER,
ADD COLUMN     "readyAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SellerProfile" ADD COLUMN     "foodOrderType" "FoodOrderType" NOT NULL DEFAULT 'NOW';

-- CreateTable
CREATE TABLE "PreOrderRequest" (
    "id" SERIAL NOT NULL,
    "buyerId" INTEGER NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "readyAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "status" "PreOrderStatus" NOT NULL DEFAULT 'REQUESTED',
    "items" JSONB NOT NULL,
    "sellerNote" TEXT,
    "respondBy" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "payBy" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreOrderRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PreOrderRequest_buyerId_status_idx" ON "PreOrderRequest"("buyerId", "status");

-- CreateIndex
CREATE INDEX "PreOrderRequest_sellerId_status_idx" ON "PreOrderRequest"("sellerId", "status");

-- CreateIndex
CREATE INDEX "PreOrderRequest_status_respondBy_idx" ON "PreOrderRequest"("status", "respondBy");

-- CreateIndex
CREATE INDEX "Order_preOrderRequestId_idx" ON "Order"("preOrderRequestId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_preOrderRequestId_fkey" FOREIGN KEY ("preOrderRequestId") REFERENCES "PreOrderRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreOrderRequest" ADD CONSTRAINT "PreOrderRequest_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreOrderRequest" ADD CONSTRAINT "PreOrderRequest_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
