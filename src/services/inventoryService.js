const prisma = require('../lib/prisma');
const { getDiscogsClient } = require('../controllers/authController');

// Basic delay function to help with rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const appDiscogsUsername = process.env.DISCOGS_USERNAME;

/**
 * Fetches "For Sale" inventory from the application's configured Discogs account
 * and syncs it to the local Record table using a transactional delta update.
 */
async function syncDiscogsInventory() {
  console.log(`Starting Discogs inventory sync for app user ${appDiscogsUsername}`);
  let discogsClient;

  if (!appDiscogsUsername) {
      console.error('Inventory Sync Error: DISCOGS_USERNAME not set in .env');
      return { success: false, message: 'Application Discogs username not configured.' };
  }

  try {
    discogsClient = await getDiscogsClient();
  } catch (error) {
    console.error(`Error preparing for inventory sync:`, error.message);
    return { success: false, message: `Sync setup failed: ${error.message}` };
  }

  let currentPage = 1;
  let totalPages = 1;
  const allListings = [];

  // --- Fetch all "For Sale" listings from Discogs (handling pagination) ---
  try {
    do {
      console.log(`Fetching inventory page ${currentPage}/${totalPages || '?'} for ${appDiscogsUsername}`);
      const response = await discogsClient.get(`/users/${appDiscogsUsername}/inventory`, {
        params: {
          page: currentPage,
          per_page: 50,
          status: 'For Sale', // Explicitly fetching only "For Sale"
          sort: 'artist',
          sort_order: 'asc',
        },
      });

      if (response.data && response.data.listings) {
        allListings.push(...response.data.listings);
        totalPages = response.data.pagination?.pages ?? totalPages;
        console.log(`Fetched ${response.data.listings.length} listings. Total pages: ${totalPages}`);
      } else {
        console.warn('Unexpected response structure from Discogs inventory endpoint:', response.data);
        break;
      }

      currentPage++;

      if (currentPage <= totalPages) {
          await delay(1100);
      }

    } while (currentPage <= totalPages);

    console.log(`Fetched a total of ${allListings.length} "For Sale" listings for Discogs user ${appDiscogsUsername}.`);

  } catch (error) {
    console.error(
        `Error fetching Discogs inventory page ${currentPage} for user ${appDiscogsUsername}:`,
        error.response?.data || error.message
    );
    return { success: false, message: `Failed during inventory fetch: ${error.message}` };
  }

  // --- Start Refactored Delta Sync Logic ---

  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;
  let erroredMappingCount = 0;

  try {
    // 1. Fetch existing "For Sale" records from DB (using discogsListingId as key)
    console.log('Fetching existing local records...');
    const existingRecords = await prisma.record.findMany({
      where: {
        // We fetch all potentially synced records, not just FOR_SALE,
        // to handle cases where a record was manually changed locally.
        // The comparison logic will decide the outcome.
        discogsListingId: {
          not: null,
        }
      },
      // Select fields needed for comparison
      select: {
        id: true,
        discogsListingId: true,
        price: true,
        condition: true,
        sleeveCondition: true,
        status: true, // Important to check if it was manually changed locally
        notes: true,
        location: true,
        coverImage: true,
        // Select other fields if they might change on Discogs side and need syncing
      }
    });
    const existingRecordMap = new Map(existingRecords.map(r => [r.discogsListingId, r]));
    console.log(`Found ${existingRecordMap.size} existing records with Discogs Listing IDs.`);

    // 2. Map fetched Discogs listings to Prisma data format
    console.log('Mapping fetched Discogs listings...');
    const currentDataMap = new Map();
    for (const listing of allListings) {
        try {
            const release = listing.release;
            const price = listing.price?.value;

            if (!release || !release.id || price === undefined || price === null) {
                console.warn(`Skipping listing ${listing.id} due to missing release/price data.`);
                erroredMappingCount++;
                continue;
            }

            // Use the existing mapping logic
            const recordData = {
                discogsReleaseId: release.id,
                discogsListingId: listing.id,
                title: release.title,
                artist: release.artist,
                label: release.label?.[0],
                catalogNumber: release.catalog_number,
                year: release.year,
                format: release.format,
                genre: release.genres ?? [],
                style: release.styles ?? [],
                coverImage: (() => {
                    const primaryImage = release.images?.find(img => img.type === 'primary');
                    return primaryImage?.resource_url || primaryImage?.uri || release.cover_image || release.thumbnail || null;
                })(),
                price: parseFloat(price),
                condition: listing.condition,
                sleeveCondition: listing.sleeve_condition,
                status: 'FOR_SALE', // Set status based on fetched listing
                notes: listing.comments,
                location: listing.location,
                lastSyncedAt: new Date(),
            };
            currentDataMap.set(listing.id, recordData);
        } catch (mapError) {
             console.error(`Error mapping listing ${listing.id}:`, mapError.message);
             erroredMappingCount++;
        }
    }
    console.log(`Successfully mapped ${currentDataMap.size} listings. ${erroredMappingCount} errors during mapping.`);


    // 3. Calculate differences: creates, updates, deletes
    const recordsToCreate = [];
    const recordsToUpdate = [];
    const idsToDelete = new Set();

    // Find records to delete (exist locally but not in fetched "For Sale" list)
    for (const [listingId, localRecord] of existingRecordMap.entries()) {
      if (!currentDataMap.has(listingId)) {
        // Check if the record is part of an order before deleting
         const orderItems = await prisma.orderItem.findMany({
            where: { recordId: localRecord.id },
            select: { id: true },
            take: 1,
         });
         if (orderItems.length === 0) {
            idsToDelete.add(listingId);
         } else {
             console.warn(`Skipping deletion of Record ID ${localRecord.id} (Discogs Listing ${listingId}) as it is part of an order. Consider changing its status manually if needed.`);
             // Optionally update status to 'SOLD' or 'DRAFT' here?
             // recordsToUpdate.push({ where: { discogsListingId: listingId }, data: { status: 'SOLD' } });
         }
      }
    }

    // Find records to create or update
    currentDataMap.forEach((fetchedData, listingId) => {
      const existingRecord = existingRecordMap.get(listingId);

      if (!existingRecord) {
        // New record found in Discogs "For Sale" list
        recordsToCreate.push(fetchedData);
      } else {
        // Record exists locally, check if update needed
        let needsUpdate = false;
        // Compare relevant fields that might change
        if (existingRecord.price !== fetchedData.price ||
            existingRecord.condition !== fetchedData.condition ||
            existingRecord.sleeveCondition !== fetchedData.sleeveCondition ||
            existingRecord.notes !== fetchedData.notes ||
            existingRecord.location !== fetchedData.location ||
            existingRecord.status !== 'FOR_SALE' || // Update if status was changed locally
            existingRecord.coverImage !== fetchedData.coverImage // Check if derived image changed
           ) {
           needsUpdate = true;
        }

        if (needsUpdate) {
          // Don't try to update the unique identifier
          const updateData = { ...fetchedData };
          delete updateData.discogsListingId; // Cannot update the 'where' field

          recordsToUpdate.push({
             where: { discogsListingId: listingId },
             data: updateData
          });
        }
      }
    });

    console.log(`Calculated Deltas: Create: ${recordsToCreate.length}, Update: ${recordsToUpdate.length}, Delete: ${idsToDelete.size}`);

    // 4. Perform DB operations within a transaction
    if (recordsToCreate.length > 0 || recordsToUpdate.length > 0 || idsToDelete.size > 0) {
      console.log('Starting database transaction...');
      await prisma.$transaction(async (tx) => {
        // Delete records
        if (idsToDelete.size > 0) {
          const deleteResult = await tx.record.deleteMany({
            where: { discogsListingId: { in: Array.from(idsToDelete) } },
          });
          deletedCount = deleteResult.count;
          console.log(`Deleted ${deletedCount} records.`);
        }

        // Create new records
        if (recordsToCreate.length > 0) {
          const createResult = await tx.record.createMany({
            data: recordsToCreate,
            skipDuplicates: true, // Safety net
          });
          createdCount = createResult.count;
          console.log(`Created ${createdCount} records.`);
        }

        // Update existing records
        if (recordsToUpdate.length > 0) {
          console.log(`Attempting to update ${recordsToUpdate.length} records...`);
          let updateSuccessCount = 0;
          for (const update of recordsToUpdate) {
             try {
                  await tx.record.update(update);
                  updateSuccessCount++;
             } catch(updateError) {
                  // Log individual update errors but continue transaction
                  console.error(`Failed to update record with Listing ID ${update.where.discogsListingId}:`, updateError.message);
             }
          }
          updatedCount = updateSuccessCount; // Only count successful updates
          console.log(`Successfully updated ${updatedCount} records.`);
        }
      });
      console.log('Database transaction completed.');
    } else {
      console.log('No database changes needed.');
    }

    console.log(`Inventory sync finished. Created: ${createdCount}, Updated: ${updatedCount}, Deleted: ${deletedCount}, Mapping Errors: ${erroredMappingCount}`);
    return {
        success: true,
        created: createdCount,
        updated: updatedCount,
        deleted: deletedCount,
        mappingErrors: erroredMappingCount
    };

  } catch (error) {
      console.error('Error during delta sync processing:', error);
      return { success: false, message: `Sync failed during delta processing: ${error.message}` };
  }
}

// TODO: Implement function to process and store tracklists if needed
// async function processTracklist(userId, recordId, tracklistData) { ... }

module.exports = {
  syncDiscogsInventory,
};
