const checkoutService = require('../services/checkoutService');

// POST /api/checkout/session - Create a Stripe Checkout session for the user's cart
const createCheckoutSessionController = async (req, res) => {
    try {
        const userId = req.session.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Authentication required to proceed to checkout.' });
        }

        // Call the service to create the Stripe session
        const session = await checkoutService.createCheckoutSession(userId);

        // Respond with the session ID (or the full session URL)
        // The frontend will use this ID to redirect the user to Stripe
        res.status(200).json({ sessionId: session.id, url: session.url });

    } catch (error) {
        console.error('Error creating checkout session:', error);
        // Provide specific feedback if possible (e.g., cart empty, item unavailable)
        if (error.message.includes('Cart is empty') || error.message.includes('not available') || error.message.includes('Insufficient stock')) {
            res.status(400).json({ message: error.message });
        } else if (error.message.includes('not configured')) {
             res.status(500).json({ message: 'Server configuration error. Please contact support.' });
        } else {
            res.status(500).json({ message: 'Failed to initiate checkout process.', error: error.message });
        }
    }
};

module.exports = {
    createCheckoutSessionController,
}; 