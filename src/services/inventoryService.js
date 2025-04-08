const prisma = require('../lib/prisma');
const { getDiscogsClient } = require('../controllers/authController');

// Basic delay function to help with rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const appDiscogsUsername = process.env.DISCOGS_USERNAME;

/**
 * Fetches inventory from the application's configured Discogs account 
 * and syncs it to the local Record table.
 * No longer requires userId.
 */
async function syncDiscogsInventory() {
  console.log(`Starting Discogs inventory sync for app user ${appDiscogsUsername}`);
  let discogsClient;

  if (!appDiscogsUsername) {
      console.error('Inventory Sync Error: DISCOGS_USERNAME not set in .env');
      return { success: false, message: 'Application Discogs username not configured.' };
  }

  try {
    // Get the Discogs client using application credentials
    discogsClient = await getDiscogsClient(); 

  } catch (error) {
    console.error(`Error preparing for inventory sync:`, error.message);
    return { success: false, message: `Sync setup failed: ${error.message}` };
  }

  let currentPage = 1;
  let totalPages = 1; // Assume at least one page initially
  let syncedCount = 0;
  let erroredCount = 0;
  const allListings = [];

  // --- Fetch all listings from Discogs (handling pagination) ---
  try {
    do {
      console.log(`Fetching inventory page ${currentPage}/${totalPages || '?'} for ${appDiscogsUsername}`);
      // Use the application's username
      const response = await discogsClient.get(`/users/${appDiscogsUsername}/inventory`, {
        params: {
          page: currentPage,
          per_page: 50, 
          status: 'For Sale',
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
        break; // Stop if response format is wrong
      }

      currentPage++;

      // Basic rate limiting 
      if (currentPage <= totalPages) {
          await delay(1100); // Slightly more than 1 second delay
      }

    } while (currentPage <= totalPages);

    console.log(`Fetched a total of ${allListings.length} listings for Discogs user ${appDiscogsUsername}.`);

  } catch (error) {
    console.error(
        `Error fetching Discogs inventory page ${currentPage} for user ${appDiscogsUsername}:`,
        error.response?.data || error.message
    );
    return { success: false, message: `Failed during inventory fetch: ${error.message}` };
  }

  // ---> ADD THIS LOG <--- 
  console.log(`[Sync Process] Total listings fetched directly from Discogs API: ${allListings.length}`);

  // --- Identify and Remove Stale Listings from Local DB ---
  let deletedCount = 0;
  let skippedDeleteCount = 0;
  try {
    console.log('Checking for stale local records to remove...');
    const fetchedListingIds = new Set(allListings.map(l => l.id)); // Get Discogs listing IDs from fetched data

    // Find local records marked FOR_SALE that have a discogsListingId
    const localForSaleRecords = await prisma.record.findMany({
      where: {
        status: 'FOR_SALE',
        discogsListingId: {
          not: null, // Only consider records that have been synced previously
        },
      },
      select: {
        id: true,
        discogsListingId: true,
        orderItems: { select: { id: true }, take: 1 }, // Check if linked to any OrderItem
      },
    });

    const recordsToDelete = [];
    for (const localRecord of localForSaleRecords) {
      if (!fetchedListingIds.has(localRecord.discogsListingId)) {
        // This local record is no longer listed "For Sale" on Discogs
        if (localRecord.orderItems.length > 0) {
          // Record is linked to an order, cannot delete due to Restrict constraint
          console.warn(`Skipping deletion of Record ID ${localRecord.id} (Discogs Listing ${localRecord.discogsListingId}) as it is part of an order.`);
          skippedDeleteCount++;
          // Optionally: Update status to SOLD or DRAFT here if needed?
          // await prisma.record.update({ where: { id: localRecord.id }, data: { status: 'SOLD' } });
        } else {
          // Safe to delete
          recordsToDelete.push(localRecord.id);
        }
      }
    }

    if (recordsToDelete.length > 0) {
      console.log(`Attempting to delete ${recordsToDelete.length} stale local records...`);
      const deleteResult = await prisma.record.deleteMany({
        where: {
          id: { in: recordsToDelete },
        },
      });
      deletedCount = deleteResult.count;
      console.log(`Successfully deleted ${deletedCount} stale records.`);
    } else {
      console.log('No stale local records found for deletion.');
    }

  } catch (error) {
    console.error('Error during stale record cleanup:', error);
    // Decide if this error should stop the whole sync. For now, we log and continue.
    // return { success: false, message: `Failed during stale record cleanup: ${error.message}` };
  }

  // --- Process and Upsert fetched listings into local DB ---
  syncedCount = 0; // Reset synced count for the upsert phase
  erroredCount = 0;

  if (allListings.length === 0) {
      console.log(`No active listings found for Discogs user ${appDiscogsUsername}. Sync complete. Deleted: ${deletedCount}, Skipped Deletion: ${skippedDeleteCount}`);
      // Note: We already handled deletion above. If allListings is empty, any remaining FOR_SALE were handled there.
      return { success: true, synced: 0, errors: 0, deleted: deletedCount, skippedDelete: skippedDeleteCount };
  }

  for (const listing of allListings) {
    try {
      // Extract data (adjust based on actual Discogs listing structure)
      const release = listing.release;
      const price = listing.price?.value; // Price is an object { value: ..., currency: ... }

      if (!release || !release.id) {
          console.warn('Skipping listing with missing release data:', listing.id);
          erroredCount++;
          continue;
      }
      if (price === undefined || price === null) {
          console.warn('Skipping listing with missing price data:', listing.id);
          erroredCount++;
          continue;
      }

      // Prepare data for Prisma upsert (without userId)
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
        status: 'FOR_SALE',
        notes: listing.comments,
        location: listing.location,
        lastSyncedAt: new Date(),
      };

      // Upsert using Discogs Listing ID as the primary identifier for sync
      // Use discogsReleaseId as a fallback unique identifier if listing ID isn't stable or available initially
      const upsertedRecord = await prisma.record.upsert({
        where: { discogsListingId: listing.id }, // Primarily use listing ID
        update: { ...recordData, discogsReleaseId: release.id /* Ensure release ID is updated too */ },
        create: recordData, // Create needs listing ID and release ID
      });

      syncedCount++;
      // console.log(`Upserted listing: ${recordData.artist} - ${recordData.title} (Discogs Listing ID: ${listing.id}, Local ID: ${upsertedRecord.id})`); // Less verbose log

    } catch (upsertError) {
      erroredCount++;
      console.error(
        `Error upserting listing (Listing ID: ${listing.id}, Release ID: ${listing.release?.id}):`,
        upsertError.message,
        // upsertError.stack // Stack trace can be very verbose
      );
    }
  }

  console.log(`Inventory sync finished for Discogs user ${appDiscogsUsername}. Synced/Updated: ${syncedCount}, Errors: ${erroredCount}, Deleted Stale: ${deletedCount}, Skipped Deletion (In Order): ${skippedDeleteCount}`);
  return { success: true, synced: syncedCount, errors: erroredCount, deleted: deletedCount, skippedDelete: skippedDeleteCount };
}

// TODO: Implement function to process and store tracklists if needed
// async function processTracklist(userId, recordId, tracklistData) { ... }

module.exports = {
  syncDiscogsInventory,
};
