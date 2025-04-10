-- AlterTable
ALTER TABLE "Record" ADD COLUMN     "weight" INTEGER,
ALTER COLUMN "discogsReleaseId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Record_discogsListingId_idx" ON "Record"("discogsListingId");

-- CreateIndex
CREATE INDEX "Record_discogsReleaseId_idx" ON "Record"("discogsReleaseId");

-- CreateIndex
CREATE INDEX "Record_artist_idx" ON "Record"("artist");

-- CreateIndex
CREATE INDEX "Record_title_idx" ON "Record"("title");

-- CreateIndex
CREATE INDEX "Record_label_idx" ON "Record"("label");
