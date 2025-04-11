const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Middleware to ensure user is logged in (placeholder)
// Kept here as mock login/logout still use session
const ensureAuthenticated = (req, res, next) => {
    // Replace this with your actual authentication check
    if (req.session && req.session.userId) {
        return next();
    }
    res.status(401).json({ message: 'Unauthorized' });
};

// Discogs Authentication Routes (REMOVED)
// router.get('/discogs/connect', ensureAuthenticated, authController.connectDiscogs);
// router.get('/discogs/callback', authController.discogsCallback); 
// router.delete('/discogs/disconnect', ensureAuthenticated, authController.disconnectDiscogs);
// router.get('/discogs/status', ensureAuthenticated, authController.getDiscogsStatus);

// User Registration
router.post('/register', authController.registerUser);

// Mock Authentication Routes (for Development/Testing)
router.post('/mock-login', authController.mockLogin);
router.post('/logout', authController.logout);

module.exports = router;
