-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AlterTable (add userId as optional first)
ALTER TABLE "Listing" ADD COLUMN     "userId" INTEGER;

-- Insert a placeholder user to own existing listings
INSERT INTO "User" ("name", "email", "passwordHash")
VALUES ('Placeholder Owner', 'placeholder@vendly.com', 'placeholder');

-- Assign all existing listings to that placeholder user
UPDATE "Listing" SET "userId" = (SELECT "id" FROM "User" WHERE "email" = 'placeholder@vendly.com');

-- Now make userId required, since every row has a value
ALTER TABLE "Listing" ALTER COLUMN "userId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;