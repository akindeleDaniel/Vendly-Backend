-- DropForeignKey
ALTER TABLE "Listing" DROP CONSTRAINT "Listing_parentId_fkey";

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Listing"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
