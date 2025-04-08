const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');

// Middleware to ensure user is logged in
const ensureAuthenticated = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    }
    res.status(401).json({ message: 'Unauthorized' });
};

// POST /api/inventory/refresh - Trigger inventory sync
router.post('/refresh', ensureAuthenticated, inventoryController.refreshInventory);

module.exports = router;
