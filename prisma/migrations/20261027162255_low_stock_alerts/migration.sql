-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "lowStockThreshold" INTEGER;

-- AlterTable
ALTER TABLE "SellerProfile" ADD COLUMN     "lowStockThreshold" INTEGER NOT NULL DEFAULT 3;
