-- AlterTable
ALTER TABLE "SellerProfile" ADD COLUMN     "about" TEXT,
ADD COLUMN     "bannerUrl" TEXT,
ADD COLUMN     "brandColor" TEXT NOT NULL DEFAULT 'forest',
ADD COLUMN     "facebookHandle" TEXT,
ADD COLUMN     "instagramHandle" TEXT,
ADD COLUMN     "tiktokHandle" TEXT,
ADD COLUMN     "whatsappNumber" TEXT,
ADD COLUMN     "xHandle" TEXT;
