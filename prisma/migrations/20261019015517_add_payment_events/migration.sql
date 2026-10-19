-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" SERIAL NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "reference" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentEvent_reference_idx" ON "PaymentEvent"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_provider_eventKey_key" ON "PaymentEvent"("provider", "eventKey");
