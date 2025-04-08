const express = require('express');
const checkoutController = require('../controllers/checkoutController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

// Apply requireAuth middleware - only logged-in users can create checkout sessions
router.use(requireAuth);

// POST /api/checkout/session - Create Stripe Checkout Session
router.post('/session', checkoutController.createCheckoutSessionController);

module.exports = router; 