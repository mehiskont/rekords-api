/*
  Warnings:

  - You are about to drop the column `userId` on the `Record` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Record" DROP CONSTRAINT "Record_userId_fkey";

-- AlterTable
ALTER TABLE "Record" DROP COLUMN "userId";
