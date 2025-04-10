const { getDiscogsClient } = require('./authController'); // Import the client setup

/**
 * Fetches release details from the Discogs API.
 * @param {object} req - Express request object, expects 'releaseId' in params.
 * @param {object} res - Express response object.
 * @param {function} next - Express next middleware function.
 */
exports.getReleaseDetails = async (req, res, next) => {
  const { releaseId } = req.params;

  if (!releaseId || isNaN(parseInt(releaseId, 10))) {
      return res.status(400).json({ message: 'Valid Discogs Release ID is required in the URL path.' });
  }

  try {
    const discogsApi = await getDiscogsClient(); // Get the pre-configured axios instance
    console.log(`Fetching details for Discogs release ID: ${releaseId}`);

    // Make the GET request to the Discogs API releases endpoint
    const response = await discogsApi.get(`/releases/${releaseId}`);

    console.log(`Successfully fetched details for Discogs release ID: ${releaseId}`);
    res.status(200).json(response.data); // Send the Discogs data back to the client

  } catch (error) {
    console.error(`Error fetching Discogs release ${releaseId}:`, error.response?.data || error.message);
    // Check if it's an Axios error and provide more detail
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      res.status(error.response.status).json({
          message: `Error fetching data from Discogs for release ${releaseId}. Status: ${error.response.status}`,
          details: error.response.data, // Forward Discogs error message if available
        });
    } else if (error.request) {
      // The request was made but no response was received
      res.status(504).json({ message: `No response received from Discogs API for release ${releaseId}.` });
    } else {
      // Something happened in setting up the request that triggered an Error
      res.status(500).json({ message: `Error setting up request to Discogs for release ${releaseId}: ${error.message}` });
    }
    // Optionally, use next(error) if you have more specific error handling middleware
    // next(error);
  }
};

// Potentially add other Discogs-related controller functions here in the future 