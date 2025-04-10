const prisma = require('../lib/prisma');
const { getDiscogsClient } = require('./authController'); // To potentially fetch more data

// GET /api/records
exports.listRecords = async (req, res, next) => {
  const {
    q,
    category = 'everything', // Default to 'everything' if not provided
    genre,
    sort,
    page = 1,
    perPage = 18,
    include_catalog, // No default, check for 'true' string
    include_release, // No default, check for 'true' string
    include_all_fields, // No default, check for 'true' string
    // refresh parameter is extracted but not used yet
    refresh
  } = req.query;

  // Parse boolean flags (query params are strings)
  const includeCatalog = include_catalog === 'true';
  const includeRelease = include_release === 'true'; // Currently overlaps with category='releases'
  const includeAllFields = include_all_fields === 'true';

  const pageNum = parseInt(page, 10);
  const perPageNum = parseInt(perPage, 10);
  const skip = (pageNum - 1) * perPageNum;

  // --- Build Prisma Query Conditions ---
  const where = {
    status: 'FOR_SALE', // Default to only showing items for sale
    // Add other conditions based on query params
  };

  // Search query (dynamic text search based on category and flags)
  if (q) {
    let searchFields = [];

    // Determine which fields to search based on flags and category
    if (includeAllFields) {
      // Search across a wider set of fields (adjust as needed)
      searchFields = ['title', 'artist', 'label', 'catalogNumber', 'format', 'notes'];
    } else if (includeCatalog) {
      // Prioritize catalog number search, but include basics
      searchFields = ['title', 'artist', 'label', 'catalogNumber'];
    } else {
      // Category-specific search (defaulting to 'everything')
      switch (category.toLowerCase()) {
        case 'releases':
          searchFields = ['title']; // Maybe add tracklist if relevant later
          break;
        case 'artists':
          searchFields = ['artist'];
          break;
        case 'labels':
          searchFields = ['label'];
          break;
        case 'everything':
        default:
          searchFields = ['title', 'artist', 'label'];
          break;
      }
    }

    // Build the OR query dynamically
    // Ensure these fields exist in your Prisma schema!
    where.OR = searchFields
      .filter(field => field) // Ensure no undefined fields slip in
      .map(field => ({
        [field]: { contains: q, mode: 'insensitive' }
      }));

    // Handle potential empty OR array if no valid fields are found
    if (where.OR.length === 0) {
        // If no valid search fields are identified, maybe return no results
        // or default to a basic search? For now, let Prisma handle empty OR.
        // An empty OR in Prisma might behave differently depending on version.
        // Let's ensure it doesn't crash - add a default search if empty.
        console.warn(`Search query "${q}" with category "${category}" and flags resulted in no valid search fields.`);
        where.OR = [ // Fallback to basic search
           { title: { contains: q, mode: 'insensitive' } },
           { artist: { contains: q, mode: 'insensitive' } },
           { label: { contains: q, mode: 'insensitive' } },
        ]
    }
  }

  // Genre filter (Prisma needs `has` for array contains)
  if (genre) {
    where.genre = {
      has: genre, // Case-sensitive match in array
      // For case-insensitive, you might need a different approach or db function
    };
  }

  // TODO: Add filtering for style if needed (requires adding style to model or different logic)

  // --- Build Prisma OrderBy ---
  let orderBy = { createdAt: 'desc' }; // Default sort
  if (sort) {
    const [field, direction = 'asc'] = sort.split(':');
    if (['title', 'artist', 'year', 'price', 'createdAt'].includes(field)) {
      orderBy = { [field]: direction.toLowerCase() };
    }
  }

  try {
    // Execute parallel queries for records and total count
    const [records, totalRecords] = await prisma.$transaction([
      prisma.record.findMany({
        where,
        orderBy,
        skip,
        take: perPageNum,
        // Select specific fields if needed for performance
        // select: { id: true, title: true, artist: true, ... }
        include: {
            // Optionally include related data, e.g., track count?
            // _count: { select: { tracks: true } }
        }
      }),
      prisma.record.count({ where }),
    ]);

    const totalPages = Math.ceil(totalRecords / perPageNum);

    res.status(200).json({
      data: records,
      pagination: {
        totalRecords,
        totalPages,
        currentPage: pageNum,
        perPage: perPageNum,
      },
    });
  } catch (error) {
    console.error('Error listing records:', error);
    res.status(500).json({ message: 'Error fetching records' });
    // next(error);
  }
};

// GET /api/records/:id
exports.getRecordById = async (req, res, next) => {
  const { id } = req.params;

  try {
    const record = await prisma.record.findUnique({
      where: { id: id },
      include: {
        tracks: true, // Include associated tracks
        // user: { select: { name: true, id: true } } // <-- REMOVED: User relation no longer exists
      },
    });

    if (!record) {
      return res.status(404).json({ message: 'Record not found' });
    }

    // Removed check involving req.session.userId and record.userId
    // if (record.status !== 'FOR_SALE' && ...) { ... }

    // TODO: Potentially fetch more details from Discogs API if needed
    // Example: If tracks are missing or more detailed info is required
    // try {
    //   const discogsClient = await getDiscogsClient(record.userId);
    //   const releaseDetails = await discogsClient.get(`/releases/${record.discogsReleaseId}`);
    //   // Merge details or update record if necessary
    // } catch (discogsError) {
    //   console.warn(`Could not fetch extra Discogs details for record ${id}:`, discogsError.message);
    // }

    res.status(200).json(record);
  } catch (error) {
    console.error(`Error fetching record ${id}:`, error);
    // Handle potential Prisma errors (e.g., invalid ID format)
    if (error.code === 'P2023') { // Prisma error code for invalid ID format
         return res.status(400).json({ message: 'Invalid record ID format' });
    }
    res.status(500).json({ message: 'Error fetching record details' });
    // next(error);
  }
};

// GET /api/records/:id/details - Fetch record from DB and merge with Discogs data
exports.getRecordWithDiscogsDetails = async (req, res, next) => {
  const { id } = req.params;

  try {
    // 1. Fetch record from local database
    const record = await prisma.record.findUnique({
      where: { id: id },
      include: {
        tracks: true, // Include associated tracks from DB
      },
    });

    if (!record) {
      return res.status(404).json({ message: 'Record not found in local database' });
    }

    let discogsData = null;
    // 2. Check if we have a discogsReleaseId and fetch from Discogs
    if (record.discogsReleaseId) {
      try {
        console.log(`Fetching Discogs details for release ID: ${record.discogsReleaseId}`);
        const discogsClient = await getDiscogsClient(); // Get authenticated client
        const discogsResponse = await discogsClient.get(`/releases/${record.discogsReleaseId}`);
        discogsData = discogsResponse.data;
        console.log(`Successfully fetched Discogs details for release ID: ${record.discogsReleaseId}`);
      } catch (discogsError) {
        console.warn(
          `Could not fetch Discogs details for release ${record.discogsReleaseId} (Record ID: ${id}):`,
          discogsError.response?.data || discogsError.message
        );
        // Decide how to handle Discogs error: continue without Discogs data, or return an error?
        // For now, we'll log a warning and continue, returning the DB data + a note about the error.
        discogsData = {
          error: 'Failed to fetch additional details from Discogs.',
          message: discogsError.response?.data?.message || discogsError.message
        };
      }
    } else {
      console.log(`Record ID ${id} does not have a discogsReleaseId. Skipping Discogs fetch.`);
    }

    // 3. Prepare the final response object based on the local record data
    const responseData = { ...record };

    // 4. Selectively add fields from Discogs data if available
    if (discogsData && !discogsData.error) {
      // Add videos if it's an array
      responseData.videos = Array.isArray(discogsData.videos) ? discogsData.videos : null;
      // Add styles if it's an array
      responseData.styles = Array.isArray(discogsData.styles) ? discogsData.styles : null;
      // Add released_formatted if it exists and is a string
      responseData.released_formatted = typeof discogsData.released_formatted === 'string' ? discogsData.released_formatted : null;
    } else {
      // If Discogs fetch failed or discogsReleaseId was missing, set all to null
      responseData.videos = null;
      responseData.styles = null;
      responseData.released_formatted = null;
    }

    // Optionally add Discogs error message if the fetch failed
    // if (discogsData && discogsData.error) {
    //   responseData.discogsError = discogsData.message;
    // }

    res.status(200).json(responseData);

  } catch (error) {
    console.error(`Error fetching combined record details for ${id}:`, error);
    if (error.code === 'P2023') { // Prisma error code for invalid ID format
      return res.status(400).json({ message: 'Invalid record ID format' });
    }
    res.status(500).json({ message: 'Error fetching combined record details' });
    // next(error);
  }
};
