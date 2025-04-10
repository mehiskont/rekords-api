const express = require('express');
const discogsController = require('../controllers/discogsController');
// Potentially add authentication middleware here if needed for specific routes
// const { requireLogin } = require('../middleware/authMiddleware'); // Example

const router = express.Router();

// Define the route for getting release details
// Example: GET /api/discogs/releases/12345
router.get('/releases/:releaseId', discogsController.getReleaseDetails);

// Add other Discogs-related routes here

module.exports = router; 