-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryAutoClosedAt" TIMESTAMP(3),
ADD COLUMN     "deliveryReminderSentAt" TIMESTAMP(3);
