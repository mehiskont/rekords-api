const prisma = require('../lib/prisma');
// const { getDiscogsClient } = require('../controllers/authController'); // Keep if used elsewhere (e.g., stats)
// @ts-ignore - Import disconnect client
const { Client } = require('disconnect');
// const axios = require('axios'); // Remove axios

// Basic delay function to help with rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const appDiscogsUsername = process.env.DISCOGS_USERNAME;
const consumerKey = process.env.DISCOGS_CONSUMER_KEY;
const consumerSecret = process.env.DISCOGS_CONSUMER_SECRET;
const accessToken = process.env.DISCOGS_ACCESS_TOKEN; // Added: Assume owner's access token is in env
const accessSecret = process.env.DISCOGS_ACCESS_SECRET; // Added: Assume owner's access secret is in env
const appUserAgent = process.env.DISCOGS_USER_AGENT || 'PlastikApiSync/1.0';

/**
 * Fetches "For Sale" inventory from the application's configured Discogs account
 * and syncs it to the local Record table using a transactional delta update.
 */
async function syncDiscogsInventory() {
  console.log(`Starting Discogs inventory sync for app user ${appDiscogsUsername}`);

  if (!appDiscogsUsername) {
      console.error('Inventory Sync Error: DISCOGS_USERNAME not set in .env');
      return { success: false, message: 'Application Discogs username not configured.' };
  }
  if (!consumerKey || !consumerSecret) {
    console.error('Inventory Sync Error: DISCOGS_CONSUMER_KEY or DISCOGS_CONSUMER_SECRET is not set.');
    return { success: false, message: 'Consumer key/secret missing.' };
  }
  // *** Added: Check for OAuth tokens needed for authenticated inventory access ***
  if (!accessToken || !accessSecret) {
    console.error('Inventory Sync Error: DISCOGS_ACCESS_TOKEN or DISCOGS_ACCESS_SECRET not set. These are required for authenticated inventory access to get fields like weight.');
    return { success: false, message: 'Owner OAuth token/secret missing.' };
  }

  // *** Instantiate an AUTHENTICATED disconnect client ***
  const discogsClient = new Client(appUserAgent, {
      consumerKey: consumerKey,
      consumerSecret: consumerSecret,
      accessToken: accessToken, // Use owner's token
      accessSecret: accessSecret, // Use owner's secret
  });

  let currentPage = 1;
  let totalPages = 1;
  const allListings = [];

  // --- Fetch all "For Sale" listings from Discogs (handling pagination) ---
  console.log('Starting fetch loop for "For Sale" inventory...');
  try {
    do {
      console.log(`Fetching inventory page ${currentPage}${totalPages > 1 ? '/'+totalPages : ''} for ${appDiscogsUsername}`);

      // *** Use the client's generic .get() method for the inventory endpoint ***
      const apiUrl = `/users/${appDiscogsUsername}/inventory`; // Use relative path for client.get()
      const params = {
          status: 'For Sale',
          page: currentPage,
          per_page: 100,
          sort: 'artist',
          sort_order: 'asc',
      };
      // The client handles authentication headers automatically
      const response = await discogsClient.marketplace().getInventory(appDiscogsUsername, params);
      // *** End change: Use generic get() ***

      // Note: Check response structure from generic .get() - might differ slightly
      // Assuming it still returns an object with 'listings' and 'pagination' keys
      if (response && response.listings) {
        const listingsFromPage = response.listings;
        const pagination = response.pagination;

        console.log(`Received ${listingsFromPage.length} listings from page ${currentPage}.`);

        if (currentPage === 1 && pagination) {
          totalPages = pagination.pages;
          console.log(`Determined total pages for 'For Sale' items: ${totalPages} (based on first page response)`);
        }

        allListings.push(...listingsFromPage);
      } else {
        console.warn('Unexpected response structure from Discogs inventory endpoint:', response);
        break;
      }

      currentPage++;

      if (currentPage <= totalPages) {
          await delay(1100); // Keep rate limiting delay
      }

    } while (currentPage <= totalPages);

  } catch (error) {
    console.error(`Error during inventory fetch loop:`, error.message || error);
    if (error.statusCode === 404) { // Example: Handle user not found
         console.error(`Discogs user ${appDiscogsUsername} not found.`);
    } else if (error.statusCode === 429) { // Example: Rate limit
         console.error('Discogs Rate Limit Hit during inventory fetch.');
    }
    return { success: false, message: `Sync failed during fetch loop: ${error.message || 'Unknown error'}` };
  }

  console.log(`Fetched a total of ${allListings.length} listings for Discogs user ${appDiscogsUsername}.`);

  // --- Start Refactored Delta Sync Logic ---

  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;
  let erroredMappingCount = 0;

  try {
    // 1. Fetch ALL records from DB (both with and without discogsListingId)
    console.log('Fetching existing local records...');
    const existingRecords = await prisma.record.findMany({
      where: {
        status: 'FOR_SALE',
      },
      select: { // Ensure all needed fields, including weight, are selected
        id: true,
        discogsListingId: true,
        discogsReleaseId: true,
        price: true,
        condition: true,
        sleeveCondition: true,
        status: true,
        notes: true,
        location: true,
        coverImage: true,
        weight: true, // Ensure weight is selected for comparison
      }
    });

    // Create maps for different ways of identifying records
    const existingRecordMap = new Map();
    existingRecords.forEach(record => {
      if (record.discogsListingId !== null) {
        existingRecordMap.set(record.discogsListingId, record);
      }
    });

    console.log(`Found ${existingRecords.length} total FOR_SALE records.`);

    // 2. Map fetched Discogs listings to Prisma data format
    console.log('Mapping fetched Discogs listings...');
    const currentDataMap = new Map();
    let mappingLoopCounter = 0;
    for (const listing of allListings) {
        mappingLoopCounter++;
        try {
            const release = listing.release;
            const price = listing.price?.value;

            // *** Log structure just before skip check ***
            if (mappingLoopCounter <= 5) { // Log first 5 iterations for inspection
              console.log(`[DEBUG Iteration ${mappingLoopCounter}] Checking Listing ID ${listing.id}: `,
                `Release valid: ${!!release}, Release ID valid: ${!!release?.id}, Price valid: ${price !== undefined && price !== null}, Price object:`, listing.price);
            }

            if (!release || !release.id || price === undefined || price === null) {
                // *** Log the reason for skipping ***
                console.warn(`[DEBUG Iteration ${mappingLoopCounter}] Skipping Listing ID ${listing.id}. Reason: `,
                  `Release missing: ${!release}, Release ID missing: ${!release?.id}, Price invalid: ${price === undefined || price === null}`);
                erroredMappingCount++; // Ensure this is incremented correctly
                continue;
            }

            const recordData = {
                discogsReleaseId: release.id,
                discogsListingId: listing.id,
                title: release.title,
                artist: release.artist,
                label: release.label || 'Unknown Label',
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
                status: 'FOR_SALE',
                notes: listing.comments,
                location: listing.location,
                weight: listing.estimated_weight ?? null,
                lastSyncedAt: new Date(),
            };

            currentDataMap.set(listing.id, recordData);
        } catch (mapError) { 
             console.error(`[DEBUG] Error mapping item ${mappingLoopCounter}/${allListings.length}, Listing ID: ${listing.id}:`, mapError.message);
             erroredMappingCount++;
        }
    }

    // 3. Calculate differences: creates, updates, deletes
    const recordsToCreate = [];
    const recordsToUpdate = []; // Changed to store full update operations
    const idsToDelete = new Set();

    // Find records with discogsListingId to delete
    for (const [listingId, localRecord] of existingRecordMap.entries()) {
      if (!currentDataMap.has(listingId)) {
        // Check if the record is part of an order before deleting
         const orderItems = await prisma.orderItem.findMany({
            where: { recordId: localRecord.id },
            select: { id: true },
            take: 1,
         });
         if (orderItems.length === 0) {
            idsToDelete.add(localRecord.id); // Store record ID, not listing ID
         } else {
             console.warn(`Skipping deletion of Record ID ${localRecord.id} (Discogs Listing ${listingId}) as it is part of an order. Consider changing its status manually if needed.`);
             // Optionally update status to 'SOLD' or 'DRAFT' here?
             // recordsToUpdate.push({ where: { discogsListingId: listingId }, data: { status: 'SOLD' } });
         }
      }
    }

    // Handle records without discogsListingId (basic cleanup)
    const currentReleaseIds = new Set(Array.from(currentDataMap.values()).map(r => r.discogsReleaseId));
    const recordsWithoutListingId = existingRecords.filter(r => r.discogsListingId === null);
    for (const localRecord of recordsWithoutListingId) {
      if (!currentReleaseIds.has(localRecord.discogsReleaseId)) {
         // Check if the record is part of an order before deleting
         const orderItems = await prisma.orderItem.findMany({
            where: { recordId: localRecord.id },
            select: { id: true },
            take: 1,
         });
         if (orderItems.length === 0) {
            idsToDelete.add(localRecord.id);
         }
      }
      // Note: Removed complex matching logic for records w/o listingId for clarity.
      // It might try to create duplicates if not handled carefully. Consider refining later if needed.
    }

    // Find records to create or update
    currentDataMap.forEach((fetchedData, listingId) => {
      const existingRecord = existingRecordMap.get(listingId);

      if (!existingRecord) {
        recordsToCreate.push(fetchedData);
      } else {
        // Record exists locally, check if update needed
        let needsUpdate = false;
        // Compare relevant fields (add weight and location)
        if (existingRecord.price !== fetchedData.price ||
            existingRecord.condition !== fetchedData.condition ||
            existingRecord.sleeveCondition !== fetchedData.sleeveCondition ||
            existingRecord.notes !== fetchedData.notes ||
            existingRecord.location !== fetchedData.location || // Check location
            existingRecord.status !== 'FOR_SALE' ||
            existingRecord.coverImage !== fetchedData.coverImage ||
            existingRecord.weight !== fetchedData.weight // Check weight
           ) {
           needsUpdate = true;
           // Removed debug log for weight change
        }

        if (needsUpdate) {
          const updateData = { ...fetchedData };
          // Ensure we don't try to update potentially unique identifiers in the data payload itself
          delete updateData.discogsListingId;
          delete updateData.discogsReleaseId;

          // Store the whole update operation structure
          recordsToUpdate.push({
             where: { discogsListingId: listingId },
             data: updateData
          });
        }
      }
    });

    console.log(`Calculated Deltas: Create: ${recordsToCreate.length}, Update: ${recordsToUpdate.length}, Delete: ${idsToDelete.size}`);

    // Removed log of recordsToCreate payload

    // 4. Perform DB operations within a transaction
    if (recordsToCreate.length > 0 || recordsToUpdate.length > 0 || idsToDelete.size > 0) {
      console.log('Starting database transaction...');
      await prisma.$transaction(async (tx) => {
        // Delete records by ID
        if (idsToDelete.size > 0) {
          const deleteResult = await tx.record.deleteMany({
            where: { id: { in: Array.from(idsToDelete) } },
          });
          deletedCount = deleteResult.count;
          console.log(`Deleted ${deletedCount} records.`);
        }

        // Create new records
        if (recordsToCreate.length > 0) {
          const createResult = await tx.record.createMany({
            data: recordsToCreate,
            skipDuplicates: true,
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
                  // Removed log before individual update
                  await tx.record.update(update);
                  updateSuccessCount++;
             } catch(updateError) {
                  console.error(`Failed to update record with Listing ID ${update.where.discogsListingId || update.where.id}:`, updateError.message); // Adjusted log for clarity
             }
          }
          updatedCount = updateSuccessCount;
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
        mappingErrors: erroredMappingCount,
        totalForSale: allListings.length,
        totalRecordsProcessed: existingRecords.length
    };

  } catch (error) {
      console.error('Error during delta sync processing:', error);
      return { success: false, message: `Sync failed during delta processing: ${error.message}` };
  }
}

// TODO: Implement function to process and store tracklists if needed
// async function processTracklist(userId, recordId, tracklistData) { ... }

/**
 * Get a count of inventory items from both Discogs and the local database
 * Useful for troubleshooting sync issues
 */
async function getInventoryStats() {
  try {
    // Get local inventory counts from database
    const localCountPromises = [
      prisma.record.count({ where: { status: 'FOR_SALE' } }),
      prisma.record.count({ where: { status: 'FOR_SALE', discogsListingId: null } }),
      prisma.record.count({ where: { status: 'FOR_SALE', discogsListingId: { not: null } } }),
    ];
    
    const [totalLocal, withoutListingId, withListingId] = await Promise.all(localCountPromises);
    
    // Get a sample from Discogs to estimate total Draft (for-sale) items
    // const discogsClient = await getDiscogsClient();
    const username = process.env.DISCOGS_USERNAME;
    
    const response = await discogsClient.get(`/users/${username}/inventory`, {
      params: {
        page: 1,
        per_page: 50,
        status: 'For Sale',
      },
    });
    
    const totalItems = response.data.pagination?.items || 0;
    const totalPages = response.data.pagination?.pages || 0;
    
    // Count statuses in the sample
    const statusCount = {};
    response.data.listings.forEach(listing => {
      statusCount[listing.status] = (statusCount[listing.status] || 0) + 1;
    });
    
    // Calculate percentage of Draft items
    const draftCount = statusCount.Draft || 0;
    const draftPercentage = draftCount / response.data.listings.length;
    
    // Estimate total Draft items across all pages
    const estimatedDraftItems = Math.round(draftPercentage * totalItems);
    
    return {
      local: {
        total: totalLocal,
        withoutListingId,
        withListingId,
      },
      discogs: {
        reported: totalItems,
        pages: totalPages,
        sampleSize: response.data.listings.length,
        statusDistribution: statusCount,
        draftPercentage: draftPercentage * 100,
        estimatedForSale: estimatedDraftItems,
      }
    };
  } catch (error) {
    console.error('Error getting inventory stats:', error);
    return { error: error.message };
  }
}

module.exports = {
  syncDiscogsInventory,
  // getInventoryStats, // Keep if needed
};
