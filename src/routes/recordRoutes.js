const express = require('express');
const router = express.Router();
const recordController = require('../controllers/recordController');

// Re-use or import authentication middleware
// TODO: Decide which routes *really* need authentication
const ensureAuthenticated = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    }
    res.status(401).json({ message: 'Unauthorized' });
};

// GET /api/records - List records with filtering, sorting, pagination
router.get('/', recordController.listRecords);

// GET /api/records/:id - Get a specific record by internal ID
router.get('/:id', recordController.getRecordById);

// GET /api/records/:id/details - Get a specific record merged with Discogs details
router.get('/:id/details', recordController.getRecordWithDiscogsDetails);

// POST /api/inventory/refresh - (Protected/Internal) Trigger inventory sync
// We'll add this route later, likely under a different path like /api/inventory
// router.post('/inventory/refresh', ensureAuthenticated, recordController.refreshInventory);

module.exports = router;
