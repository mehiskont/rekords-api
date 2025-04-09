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
    // Fetch initial page WITHOUT status filter to get pagination for ALL items,
    // as the API doesn't report correct pagination for filtered results.
    console.log(`Fetching initial page to get pagination for ALL inventory items...`);
    const initialResponse = await discogsClient.get(`/users/${appDiscogsUsername}/inventory`, {
      params: {
        page: 1,
        per_page: 1, // Fetch just one item to get pagination
        // status: 'For Sale', // REMOVED: Get total pagination across all statuses
      },
    });

    if (initialResponse.data && initialResponse.data.pagination) {
      // This reflects the count and pages for ALL items
      totalPages = initialResponse.data.pagination.pages;
      console.log(`Discogs reports ${initialResponse.data.pagination.items} total items (all statuses) in ${totalPages} pages.`);
    } else {
       console.warn('Could not get initial pagination from Discogs.');
       // Fallback or error handling if needed
    }
    // We will iterate through all pages, but the loop call below uses 'status=For Sale'
    // to ensure we only process relevant listings per page.

  } catch (error) {
    console.error(`Error during initial pagination fetch:`, error.response?.data || error.message);
    return { success: false, message: `Failed during initial fetch: ${error.message}` }; // Exit if initial fetch fails
  }

  // Reset currentPage for the main loop
  currentPage = 1;

  do {
    // Fetch page using the totalPages determined by the initial *unfiltered* call.
    // REMOVED status filter from the API call parameters.
    console.log(`Fetching inventory page ${currentPage}/${totalPages} (all statuses) for ${appDiscogsUsername}`);
    const response = await discogsClient.get(`/users/${appDiscogsUsername}/inventory`, {
      params: {
        page: currentPage,
        per_page: 50,
        // status: 'For Sale', // REMOVED: Fetch all statuses and filter locally later
        sort: 'artist',
        sort_order: 'asc',
      },
    });

    if (response.data && response.data.listings) {
      // Directly use the listings returned by the API since we filtered via API parameter
      const listingsFromPage = response.data.listings;

      // Remove the local filter for 'Draft' status
      // const forSaleListings = response.data.listings.filter(
      //   listing => listing.status === 'Draft'
      // );

      // Log the number of items received from this page
      console.log(`Received ${listingsFromPage.length} listings from page ${currentPage}.`);

      // Removed status distribution logging as it's less relevant now
      // if (currentPage === 1) { ... }

      // Removed log comparing filtered length vs total length
      // if (forSaleListings.length < response.data.listings.length) { ... }

      allListings.push(...listingsFromPage); // Add all listings from the page
      // totalPages is already set from the initial call
      console.log(`[DEBUG] Fetched page ${currentPage}/${totalPages}. allListings.length is now: ${allListings.length}`);
    } else {
      console.warn('Unexpected response structure from Discogs inventory endpoint:', response.data);
      break;
    }

    currentPage++;

    if (currentPage <= totalPages) {
        await delay(1100);
    }

  } while (currentPage <= totalPages);

  console.log(`Fetched a total of ${allListings.length} listings (all statuses) for Discogs user ${appDiscogsUsername}.`);

  // --- DEBUG: Analyze received data ---
  if (allListings.length > 0) {
    // Log the entire first listing object
    console.log('[DEBUG] First listing object received:', JSON.stringify(allListings[0], null, 2));

    // Count all unique statuses found in the data
    const statusCounts = {};
    allListings.forEach(listing => {
      const status = listing.status || '_undefined_'; // Handle missing status
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });
    console.log('[DEBUG] Status counts in received data:', statusCounts);

  } else {
    console.log('[DEBUG] allListings array is empty before analysis.');
  }
  // --- END DEBUG ---

  // Filter locally for items with status "Draft" as this indicates "For Sale" in the received data
  const forSaleListings = allListings.filter(listing => listing.status === 'Draft');
  console.log(`Filtered down to ${forSaleListings.length} actual \"Draft\" (For Sale) listings.`);

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
    console.log(`[DEBUG] Starting mapping loop. Number of "For Sale" listings to map: ${forSaleListings.length}`);
    console.log('Mapping fetched Discogs listings...');
    const currentDataMap = new Map();
    let mappingLoopCounter = 0; // Add counter for debugging
    for (const listing of forSaleListings) { // Map the filtered list
        mappingLoopCounter++;
        // Add initial log for each iteration
        // console.log(`[DEBUG] Mapping loop iteration ${mappingLoopCounter}/${forSaleListings.length}, Processing Listing ID: ${listing.id}`);
        try {
            const release = listing.release;
            const price = listing.price?.value;

            if (!release || !release.id || price === undefined || price === null) {
                // Log skipped items
                console.warn(`[DEBUG] Skipping item ${mappingLoopCounter}/${forSaleListings.length}, Listing ID: ${listing.id}. Reason: Missing release (${!!release}), release.id (${release?.id}), or price (${price})`);
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
            console.log(`[DEBUG] Mapped item ${mappingLoopCounter}/${forSaleListings.length}, Listing ID: ${listing.id}. currentDataMap size: ${currentDataMap.size}`);
        } catch (mapError) {
             console.error(`[DEBUG] Error mapping item ${mappingLoopCounter}/${forSaleListings.length}, Listing ID: ${listing.id}:`, mapError.message);
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
        totalForSale: forSaleListings.length,
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
