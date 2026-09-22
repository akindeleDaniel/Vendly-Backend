/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `SellerProfile` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `slug` to the `SellerProfile` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "SellerProfile" ADD COLUMN     "slug" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "SellerProfile_slug_key" ON "SellerProfile"("slug");
