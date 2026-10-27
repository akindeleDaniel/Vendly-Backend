-- AlterTable
ALTER TABLE "SellerProfile" ADD COLUMN     "deliversEverywhere" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "SellerShippingRate" (
    "id" SERIAL NOT NULL,
    "sellerProfileId" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "cost" DECIMAL(12,2),

    CONSTRAINT "SellerShippingRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerShippingRate_sellerProfileId_state_key" ON "SellerShippingRate"("sellerProfileId", "state");

-- AddForeignKey
ALTER TABLE "SellerShippingRate" ADD CONSTRAINT "SellerShippingRate_sellerProfileId_fkey" FOREIGN KEY ("sellerProfileId") REFERENCES "SellerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
