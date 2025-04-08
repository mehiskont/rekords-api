const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const webhookService = require('../services/webhookService');

const handleStripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!endpointSecret) {
        console.error('Webhook Error: Stripe webhook secret is not configured.');
        return res.status(500).send('Webhook secret not configured.');
    }

    let event;

    try {
        // IMPORTANT: req.rawBody needs to be populated by a middleware BEFORE this controller.
        // We will configure this in index.js
        if (!req.rawBody) {
             console.error('Webhook Error: Raw body not available for signature verification.');
             return res.status(400).send('Webhook error: Raw body missing.');
        }
        
        event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
        console.log('Stripe Event Received:', event.type, event.id);
    } catch (err) {
        console.error(`Webhook signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Log the received event (optional, but helpful for debugging)
    // Consider logging to your DB WebhookLog model
     try {
         await prisma.webhookLog.create({
             data: {
                 source: 'stripe',
                 eventType: event.type,
                 payload: event, // Store the whole event
                 processingStatus: 'received',
             },
         });
     } catch (logError) {
         console.error('Failed to log webhook event to database:', logError);
     }

    // Handle the event
    try {
        await webhookService.handleStripeEvent(event);
        // Return a 200 response to acknowledge receipt of the event
        res.status(200).json({ received: true });
    } catch (err) {
        // If the service throws an error (e.g., transaction failed),
        // log it and return an error status so Stripe retries.
        console.error(`Error handling Stripe event ${event.id} (${event.type}):`, err);
        // Update webhook log status
        // await prisma.webhookLog.updateMany({ where: { id_from_previous_create }, data: { processingStatus: 'error', errorMessage: err.message } });
        res.status(500).json({ error: 'Failed to process webhook event.', message: err.message });
    }
};

// Need prisma instance if logging directly here (better to pass eventId to service)
const prisma = require('../lib/prisma');

module.exports = {
    handleStripeWebhook,
}; 