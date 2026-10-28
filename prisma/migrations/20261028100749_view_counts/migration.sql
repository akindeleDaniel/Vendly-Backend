-- CreateEnum
CREATE TYPE "ViewKind" AS ENUM ('PRODUCT', 'SHOP');

-- CreateTable
CREATE TABLE "ViewDay" (
    "id" SERIAL NOT NULL,
    "kind" "ViewKind" NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ViewDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ViewSeen" (
    "visitor" TEXT NOT NULL,
    "kind" "ViewKind" NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ViewSeen_pkey" PRIMARY KEY ("visitor","kind","subjectId")
);

-- CreateIndex
CREATE INDEX "ViewDay_sellerId_day_idx" ON "ViewDay"("sellerId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "ViewDay_kind_subjectId_day_key" ON "ViewDay"("kind", "subjectId", "day");

-- CreateIndex
CREATE INDEX "ViewSeen_createdAt_idx" ON "ViewSeen"("createdAt");
