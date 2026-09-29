/*
  Warnings:

  - Added the required column `lga` to the `SellerProfile` table without a default value. This is not possible if the table is not empty.
  - Added the required column `state` to the `SellerProfile` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "SellerProfile" ADD COLUMN     "lga" TEXT NOT NULL,
ADD COLUMN     "state" TEXT NOT NULL;
