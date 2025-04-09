const prisma = require('../lib/prisma');
const { getDiscogsClient } = require('../controllers/authController');
// @ts-ignore - Import disconnect client specifically for inventory fetch
const { Client } = require('disconnect'); 

// Basic delay function to help with rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const appDiscogsUsername = process.env.DISCOGS_USERNAME;
// Get consumer keys for the simple client
const consumerKey = process.env.DISCOGS_CONSUMER_KEY;
const consumerSecret = process.env.DISCOGS_CONSUMER_SECRET;

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

  // Instantiate a simple disconnect client for public inventory fetching
  if (!consumerKey || !consumerSecret) {
    console.error('Inventory Sync Error: DISCOGS_CONSUMER_KEY or DISCOGS_CONSUMER_SECRET is not set in .env for simple client.');
    return { success: false, message: 'Consumer key/secret missing for inventory fetch.' };
  }
  const simpleDiscogsClient = new Client({
      consumerKey: consumerKey,
      consumerSecret: consumerSecret,
      // No user token needed for public inventory
  });

  let currentPage = 1;
  let totalPages = 1; // Initialize totalPages to 1 to ensure the loop runs at least once
  const allListings = [];

  // REMOVED: Initial unfiltered call block
  // // --- Fetch all "For Sale" listings from Discogs (handling pagination) ---
  // try {
  //   console.log(`Fetching initial page to get pagination for ALL inventory items...`);
  //   ...
  // } catch (error) { ... }

  // REMOVED: Reset currentPage for the main loop (already 1)
  // currentPage = 1;

  // --- Fetch all "For Sale" listings from Discogs (handling pagination) ---
  console.log('Starting fetch loop for "For Sale" inventory...');
  try { // Added try-catch around the loop
    do {
      console.log(`Fetching inventory page ${currentPage}${totalPages > 1 ? '/'+totalPages : ''} for ${appDiscogsUsername}`);
      // Use the simple disconnect client and its marketplace method
      const response = await simpleDiscogsClient.marketplace().getInventory(appDiscogsUsername, {
          status: 'For Sale', 
          page: currentPage,
          per_page: 100, // Changed to 100 to match successful project
          sort: 'artist',
          sort_order: 'asc',
      });
      
      // Note: 'disconnect' library returns the parsed JSON directly, not nested under 'data' like axios
      if (response && response.listings) {
        const listingsFromPage = response.listings;

        // Log the number of items received from this page
        console.log(`Received ${listingsFromPage.length} listings from page ${currentPage}.`);

        // If it's the first page, extract the correct totalPages count from the filtered response
        if (currentPage === 1 && response.pagination) {
          totalPages = response.pagination.pages;
          console.log(`Determined total pages for 'For Sale' items: ${totalPages} (based on first page response)`);
        }

        allListings.push(...listingsFromPage); // Add all listings from the page
        console.log(`[DEBUG] Fetched page ${currentPage}/${totalPages}. allListings.length is now: ${allListings.length}`);
      } else {
        console.warn('Unexpected response structure from Discogs inventory endpoint:', response);
        break;
      }

      currentPage++;

      if (currentPage <= totalPages) {
          await delay(1100);
      }

    } while (currentPage <= totalPages);

  } catch (error) { // Catch block for the loop
    console.error(`Error during inventory fetch loop:`, error.message || error);
    if (error.statusCode === 404) { // Example: Handle user not found
         console.error(`Discogs user ${appDiscogsUsername} not found.`);
    } else if (error.statusCode === 429) { // Example: Rate limit
         console.error('Discogs Rate Limit Hit during inventory fetch.');
    }
    return { success: false, message: `Sync failed during fetch loop: ${error.message || 'Unknown error'}` };
  }

  console.log(`Fetched a total of ${allListings.length} listings for Discogs user ${appDiscogsUsername}.`);

  // --- DEBUG: Analyze received data (Optional, can be removed if sync is stable) ---\n    if (allListings.length > 0) {\n      // Log the entire first listing object\n      console.log(\'[DEBUG] First listing object received:\', JSON.stringify(allListings[0], null, 2));\n\n      // Count all unique statuses found in the data\n      const statusCounts = {};\n      allListings.forEach(listing => {\n        const status = listing.status || \'_undefined_\'; // Handle missing status\n        statusCounts[status] = (statusCounts[status] || 0) + 1;\n      });\n      console.log(\'[DEBUG] Status counts in received data (should ideally be only \'For Sale\'):\', statusCounts);\n\n    } else {\n      console.log(\'[DEBUG] allListings array is empty before analysis.\');\n    }\n    // --- END DEBUG ---\n\n    // REMOVED: Local filter for 'Draft' status is no longer needed as API provides filtered data.\n    // const forSaleListings = allListings.filter(listing => listing.status === \'Draft\');\n    // console.log(`Filtered down to ${forSaleListings.length} actual \\\"Draft\\\" (For Sale) listings.`);\n\n    // Use allListings directly as it should now contain only "For Sale" items.\n    const forSaleListings = allListings;\n    console.log(`Using ${forSaleListings.length} \"For Sale\" listings fetched directly from API.`);\n\n    // --- Start Refactored Delta Sync Logic ---\n

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
        // We fetch all records, including those without discogsListingId
        status: 'FOR_SALE', // Only fetch records marked as for sale
      },
      // Select fields needed for comparison
      select: {
        id: true,
        discogsListingId: true,
        discogsReleaseId: true, // Include releaseId for additional matching
        price: true,
        condition: true,
        sleeveCondition: true,
        status: true, 
        notes: true,
        location: true,
        coverImage: true,
      }
    });
    
    // Create maps for different ways of identifying records
    const existingRecordMap = new Map(); // By listingId
    const existingRecordsByReleaseId = new Map(); // By releaseId (fallback for records without listingId)
    
    existingRecords.forEach(record => {
      // Map by discogsListingId if available
      if (record.discogsListingId !== null) {
        existingRecordMap.set(record.discogsListingId, record);
      }
      
      // Also map by discogsReleaseId for fallback matching
      if (!existingRecordsByReleaseId.has(record.discogsReleaseId)) {
        existingRecordsByReleaseId.set(record.discogsReleaseId, []);
      }
      existingRecordsByReleaseId.get(record.discogsReleaseId).push(record);
    });
    
    console.log(`Found ${existingRecords.length} total FOR_SALE records.`);
    console.log(`- ${existingRecordMap.size} have Discogs Listing IDs`);
    console.log(`- ${existingRecords.length - existingRecordMap.size} lack Discogs Listing IDs`);

    // 2. Map fetched Discogs listings to Prisma data format
    console.log(`[DEBUG] Starting mapping loop. Number of "For Sale" listings to map: ${allListings.length}`);
    console.log('Mapping fetched Discogs listings...');
    const currentDataMap = new Map();
    let mappingLoopCounter = 0; // Add counter for debugging
    for (const listing of allListings) { // Map the filtered list
        mappingLoopCounter++;
        // Add initial log for each iteration
        // console.log(`[DEBUG] Mapping loop iteration ${mappingLoopCounter}/${forSaleListings.length}, Processing Listing ID: ${listing.id}`);
        try {
            const release = listing.release;
            const price = listing.price?.value;

            if (!release || !release.id || price === undefined || price === null) {
                // Log skipped items
                console.warn(`[DEBUG] Skipping item ${mappingLoopCounter}/${allListings.length}, Listing ID: ${listing.id}. Reason: Missing release (${!!release}), release.id (${release?.id}), or price (${price})`);
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
            // Uncomment and use this detailed log for successful mapping
            console.log(`[DEBUG] Mapped item ${mappingLoopCounter}/${allListings.length}, Listing ID: ${listing.id}. currentDataMap size: ${currentDataMap.size}`);
        } catch (mapError) {
             console.error(`[DEBUG] Error mapping item ${mappingLoopCounter}/${allListings.length}, Listing ID: ${listing.id}:`, mapError.message);
             erroredMappingCount++;
        }
    }
    // Log the counter after the loop
    console.log(`[DEBUG] Mapping loop finished after ${mappingLoopCounter} iterations.`);
    console.log(`Successfully mapped ${currentDataMap.size} listings. ${erroredMappingCount} errors during mapping.`);


    // 3. Calculate differences: creates, updates, deletes
    const recordsToCreate = [];
    const recordsToUpdate = [];
    const idsToDelete = new Set();

    // Find records with discogsListingId to delete (exist locally but not in fetched "For Sale" list)
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
    
    // Handle records without discogsListingId by matching on releaseId
    // First, gather all discogsReleaseIds that are currently for sale
    const currentReleaseIds = new Set();
    currentDataMap.forEach(recordData => {
      currentReleaseIds.add(recordData.discogsReleaseId);
    });
    
    // Identify records to clean up or update with listing IDs
    const recordsWithoutListingId = existingRecords.filter(r => r.discogsListingId === null);
    console.log(`Checking ${recordsWithoutListingId.length} records without listing IDs...`);
    
    for (const localRecord of recordsWithoutListingId) {
      // If the release isn't for sale anymore, mark for deletion
      if (!currentReleaseIds.has(localRecord.discogsReleaseId)) {
        const orderItems = await prisma.orderItem.findMany({
          where: { recordId: localRecord.id },
          select: { id: true },
          take: 1,
        });
        if (orderItems.length === 0) {
          idsToDelete.add(localRecord.id);
        }
      } else {
        // This release is still for sale - check if we should attempt to match it
        // with one of the current listings and update its discogsListingId
        const matchingListing = Array.from(currentDataMap.values()).find(
          record => 
            record.discogsReleaseId === localRecord.discogsReleaseId &&
            !existingRecordMap.has(record.discogsListingId)
        );
        
        if (matchingListing) {
          console.log(`Found potential match for record ${localRecord.id}: ${matchingListing.discogsListingId}`);
          // Update this record with the listing ID instead of creating a new record
          recordsToUpdate.push({
            where: { id: localRecord.id },
            data: {
              discogsListingId: matchingListing.discogsListingId,
              price: matchingListing.price,
              condition: matchingListing.condition,
              sleeveCondition: matchingListing.sleeveCondition,
              notes: matchingListing.notes,
              location: matchingListing.location,
              coverImage: matchingListing.coverImage,
              lastSyncedAt: new Date()
            }
          });
          
          // Remove this listing from currentDataMap so it won't be created as a new record
          currentDataMap.delete(matchingListing.discogsListingId);
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
    const discogsClient = await getDiscogsClient();
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
  getInventoryStats,
};
