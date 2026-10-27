-- AlterTable
ALTER TABLE "Cart" ADD COLUMN     "itemsChangedAt" TIMESTAMP(3),
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "cartRemindersOff" BOOLEAN NOT NULL DEFAULT false;
