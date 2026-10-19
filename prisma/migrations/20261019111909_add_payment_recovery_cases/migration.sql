-- CreateEnum
CREATE TYPE "PaymentRecoveryStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "PaymentRecoveryCase" (
    "id" SERIAL NOT NULL,
    "paymentAttemptId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "PaymentRecoveryStatus" NOT NULL DEFAULT 'OPEN',
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentRecoveryCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecoveryCase_paymentAttemptId_key" ON "PaymentRecoveryCase"("paymentAttemptId");

-- AddForeignKey
ALTER TABLE "PaymentRecoveryCase" ADD CONSTRAINT "PaymentRecoveryCase_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
