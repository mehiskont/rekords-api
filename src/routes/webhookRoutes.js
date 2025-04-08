const express = require('express');
const webhookController = require('../controllers/webhookController');

const router = express.Router();

// POST /api/webhooks/stripe - Stripe webhook endpoint
// Note: No auth middleware here - Stripe needs to be able to hit this directly.
// Security is handled by signature verification in the controller.
router.post('/stripe', webhookController.handleStripeWebhook);

module.exports = router; 