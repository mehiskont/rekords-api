// src/services/syncService.ts
import { PrismaClient, Prisma, Record } from '@prisma/client'; // Import Prisma types
import discogsClient from '../lib/discogsClient';
// Use the specific Discogs API types we created
import { DiscogsListing, DiscogsInventoryResponse } from '../types/discogsApiTypes';
import path from 'path';

const prisma = new PrismaClient();
const sellerUsername = process.env.DISCOGS_USERNAME;

if (!sellerUsername) {
    // Throw error during initialization if username is missing
    throw new Error('DISCOGS_USERNAME is not set in environment variables.');
}

// Define the type for the data structure needed to create a Prisma Record
// This helps ensure mapListingToRecord returns the correct shape.
// Exclude fields automatically handled by Prisma (id, createdAt, updatedAt)
type RecordCreateData = Omit<Record, 'id' | 'createdAt' | 'updatedAt' | 'lastSyncedAt'> & {
    // Ensure specific fields match Prisma schema expectations if needed
    discogsId: bigint;
    releaseId: bigint;
};

// Rate limiting delay for inventory pages
const INVENTORY_PAGE_DELAY = 1000; // 1 second between inventory pages

// --- Discogs API Interaction ---

// Helper function to fetch all pages of seller inventory
async function fetchAllInventory(username: string): Promise<DiscogsListing[]> {
    let allListings: DiscogsListing[] = [];
    let page = 1;
    let totalPages = 1;

    console.log(`Starting inventory fetch for ${username}...`);

    try {
        do {
            console.log(`Fetching inventory page ${page} of ${totalPages}...`);
            const response: DiscogsInventoryResponse = await discogsClient.marketplace().getInventory(username, {
                status: 'For Sale',
                page: page,
                per_page: 100, // Max items per page for inventory endpoint
            });

            if (response && response.listings) {
                allListings = allListings.concat(response.listings);
                // Ensure pagination and pages exist before accessing
                totalPages = response.pagination?.pages ?? totalPages;
                page++;

                // Check if we have fetched all pages
                if (page > totalPages) {
                    break;
                }

                // Apply delay AFTER successful fetch, before next page
                console.log(`Waiting ${INVENTORY_PAGE_DELAY}ms before next inventory page...`);
                await new Promise(resolve => setTimeout(resolve, INVENTORY_PAGE_DELAY)); 

            } else {
                console.warn(`No listings found on page ${page} or invalid response structure.`);
                // If the first page fails, break immediately. Otherwise, maybe log and continue?
                if (page === 1) {
                    break;
                } else {
                    // Decide how to handle errors on subsequent pages (e.g., retry, break)
                    console.error(`Failed to fetch page ${page}. Stopping pagination.`);
                    break;
                }
            }
        } while (true); // Loop condition managed internally by break

        console.log(`Fetched a total of ${allListings.length} listings for ${username}.`);
        return allListings;

    } catch (error: any) {
        console.error(`Error fetching inventory from Discogs for ${username}:`, error.message || error);
        // Check for specific Discogs errors like rate limiting (429)
        if (error?.statusCode === 429) {
            console.error("Discogs Rate Limit Exceeded. Try again later or implement backoff.");
        }
        // Re-throw or handle as appropriate for your application
        throw new Error(`Failed to fetch inventory from Discogs: ${error.message}`);
    }
}

// --- Database Synchronization Logic ---

// Modify mapping function to be ASYNCHRONOUS
async function mapListingToRecord(listing: DiscogsListing): Promise<RecordCreateData> {
    let finalImageUrl: string | null = null; // Always null

    return {
        discogsId: BigInt(listing.id),
        releaseId: BigInt(listing.release.id),
        artist: listing.release.artist ?? 'Unknown Artist',
        title: listing.release.title ?? listing.release.description ?? 'Unknown Title',
        label: listing.release.label ?? null,
        year: listing.release.year ?? null,
        format: listing.release.format ?? null,
        condition: listing.condition ?? null,
        sleeve: listing.sleeve_condition ?? null,
        price: listing.price?.value ?? 0,
        currency: listing.price?.currency ?? 'USD',
        imageUrl: finalImageUrl, // Will always be null
        listingUrl: `https://www.discogs.com/sell/item/${listing.id}`,
        weight: listing.weight ?? 180,
        comments: listing.comments ?? null,
        location: listing.location ?? listing.ships_from ?? null,
        status: listing.status ?? 'Unknown',
    };
}

// --- Public Service Methods (Reverted to Sync Mapping) ---

export const syncService = {
    /**
     * Performs a full sync: Deletes all existing records and replaces them with current Discogs inventory.
     */
    performInitialSync: async (): Promise<{ count: number }> => {
        console.log(`Starting initial sync for user: ${sellerUsername}...`);
        const listings = await fetchAllInventory(sellerUsername);
        
        console.log(`Mapping ${listings.length} listings...`);
        // Map ASYNCHRONOUSLY and wait for all promises
        const recordsToCreate = await Promise.all(listings.map(mapListingToRecord));

        try {
            const result = await prisma.$transaction(async (tx) => {
                console.log('Deleting existing records...');
                // Ensure deletion targets the correct table if mapping differs
                await tx.record.deleteMany({});

                console.log(`Creating ${recordsToCreate.length} new records...`);
                if (recordsToCreate.length === 0) {
                    console.log("No records to create.");
                    return { count: 0 };
                }
                const creationResult = await tx.record.createMany({
                    data: recordsToCreate,
                    skipDuplicates: true, // Safety net
                });
                console.log('Initial sync completed successfully.');
                return creationResult;
            });
            return { count: result.count };
        } catch (error: any) {
             console.error('Error during initial sync transaction:', error.message || error);
             throw new Error(`Initial sync failed: ${error.message}`);
        }
    },

    /**
     * Performs a delta sync: Fetches current Discogs inventory and updates the database.
     * Adds new listings, updates existing ones, and removes sold/deleted ones.
     */
    performDeltaSync: async (): Promise<{ created: number; updated: number; deleted: number }> => {
        console.log(`Starting delta sync for user: ${sellerUsername}...`);
        const currentListings = await fetchAllInventory(sellerUsername);
        const existingRecords = await prisma.record.findMany();

        // Map new listings asynchronously first
        console.log(`Mapping ${currentListings.length} current listings...`);
        const mappedCurrentDataPromises = currentListings.map(mapListingToRecord);
        const mappedCurrentData = await Promise.all(mappedCurrentDataPromises);

        // Create maps from the resolved data
        const currentDataMap = new Map<bigint, RecordCreateData>();
        mappedCurrentData.forEach(data => currentDataMap.set(data.discogsId, data));

        const existingRecordMap = new Map<bigint, Record>();
        existingRecords.forEach(r => existingRecordMap.set(r.discogsId, r));

        const idsToDelete = new Set<bigint>();
        existingRecordMap.forEach((record, discogsId) => {
            if (!currentDataMap.has(discogsId)) {
                idsToDelete.add(discogsId);
            }
        });

        const recordsToCreate: Prisma.RecordCreateManyInput[] = [];
        const recordsToUpdate: { where: Prisma.RecordWhereUniqueInput; data: Prisma.RecordUpdateInput }[] = [];

        // Process updates and creates using the resolved mapped data
        currentDataMap.forEach((mappedData, discogsId) => {
            const existingRecord = existingRecordMap.get(discogsId);

            if (existingRecord) {
                let needsUpdate = false;
                // Compare relevant fields (excluding id, createdAt, updatedAt, lastSyncedAt, discogsId, releaseId)
                if (
                    existingRecord.price !== mappedData.price ||
                    existingRecord.condition !== mappedData.condition ||
                    existingRecord.sleeve !== mappedData.sleeve ||
                    existingRecord.status !== mappedData.status ||
                    existingRecord.comments !== mappedData.comments ||
                    existingRecord.imageUrl !== mappedData.imageUrl // Keep comparison in case schema still has it, though it will always be null now
                ) {
                    needsUpdate = true;
                }

                if (needsUpdate) {
                    const updateData: Prisma.RecordUpdateInput = { ...mappedData };
                    // Prevent updating unique IDs
                    delete (updateData as any).discogsId;
                    delete (updateData as any).releaseId;
                    recordsToUpdate.push({ where: { discogsId: discogsId }, data: updateData });
                }
            } else {
                // This is a new record
                recordsToCreate.push(mappedData as Prisma.RecordCreateManyInput);
            }
        });
        
        let createdCount = 0;
        let updatedCount = 0;
        let deletedCount = 0;

        try {
            await prisma.$transaction(async (tx) => {
                // Delete records
                if (idsToDelete.size > 0) {
                    console.log(`Deleting ${idsToDelete.size} records...`);
                    const deleteResult = await tx.record.deleteMany({
                        where: { discogsId: { in: Array.from(idsToDelete) } },
                    });
                    deletedCount = deleteResult.count;
                }

                // Create new records
                if (recordsToCreate.length > 0) {
                    console.log(`Creating ${recordsToCreate.length} new records...`);
                    const createResult = await tx.record.createMany({
                        data: recordsToCreate,
                        skipDuplicates: true, // In case a concurrent sync ran
                    });
                    createdCount = createResult.count;
                }

                // Update existing records
                if (recordsToUpdate.length > 0) {
                    console.log(`Updating ${recordsToUpdate.length} records...`);
                    // Loop for updates as Prisma lacks true bulk update
                    for (const update of recordsToUpdate) {
                       try {
                            await tx.record.update(update);
                            updatedCount++;
                       } catch(updateError: any) {
                            // Log individual update errors but continue transaction if possible
                            console.error(`Failed to update record ${update.where.discogsId}:`, updateError.message);
                       }
                    }
                }
            });

            console.log(`Delta sync completed: ${createdCount} created, ${updatedCount} updated, ${deletedCount} deleted.`);
            return { created: createdCount, updated: updatedCount, deleted: deletedCount };
        } catch (error: any) {
            console.error('Error during delta sync transaction:', error.message || error);
            throw new Error(`Delta sync failed: ${error.message}`);
        }
    },
}; 