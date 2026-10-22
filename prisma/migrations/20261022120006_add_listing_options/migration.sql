-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "optionLabel" TEXT,
ADD COLUMN     "parentId" INTEGER,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sizeLabel" TEXT;

-- CreateIndex
CREATE INDEX "Listing_parentId_idx" ON "Listing"("parentId");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
