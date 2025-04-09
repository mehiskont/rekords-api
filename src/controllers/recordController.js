const prisma = require('../lib/prisma');
const { getDiscogsClient } = require('./authController'); // To potentially fetch more data

// GET /api/records
exports.listRecords = async (req, res, next) => {
  const { q, genre, sort, page = 1, perPage = 18 } = req.query;

  const pageNum = parseInt(page, 10);
  const perPageNum = parseInt(perPage, 10);
  const skip = (pageNum - 1) * perPageNum;

  // --- Build Prisma Query Conditions ---
  const where = {
    status: 'FOR_SALE', // Default to only showing items for sale
    // Add other conditions based on query params
  };

  // Search query (simple text search across title, artist, label)
  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { artist: { contains: q, mode: 'insensitive' } },
      { label: { contains: q, mode: 'insensitive' } },
      // Add catalogNumber, etc. if desired
    ];
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
