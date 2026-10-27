-- AlterTable
ALTER TABLE "ProductReview" ADD COLUMN     "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ShopReview" ADD COLUMN     "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
