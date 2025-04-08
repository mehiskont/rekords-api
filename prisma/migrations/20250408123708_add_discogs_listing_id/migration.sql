/*
  Warnings:

  - A unique constraint covering the columns `[discogsListingId]` on the table `Record` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Record" ADD COLUMN     "discogsListingId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Record_discogsListingId_key" ON "Record"("discogsListingId");
