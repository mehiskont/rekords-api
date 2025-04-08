const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cartService = require('./cartService');
const prisma = require('../lib/prisma'); // Needed for deeper item validation if required

const FRONTEND_CHECKOUT_SUCCESS_URL = `${process.env.FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
const FRONTEND_CHECKOUT_CANCEL_URL = `${process.env.FRONTEND_URL}/cart`;

/**
 * Creates a Stripe Checkout Session for the user's current cart.
 * @param {string} userId - The ID of the user initiating checkout.
 * @returns {Promise<Stripe.Checkout.Session>} The created Stripe Checkout Session object.
 * @throws {Error} If cart is empty, items are invalid, or Stripe API call fails.
 */
async function createCheckoutSession(userId) {
    if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error('Stripe secret key is not configured.');
    }

    // 1. Get the user's cart with items and record details
    const cart = await cartService.getCart(userId);

    if (!cart || !cart.items || cart.items.length === 0) {
        throw new Error('Cannot create checkout session: Cart is empty.');
    }

    // 2. Validate cart items and format for Stripe
    const line_items = [];
    let totalCartQuantity = 0;

    // Use Prisma transaction for consistent read of record data
    await prisma.$transaction(async (tx) => {
        for (const item of cart.items) {
            if (!item.record) {
                 // This should ideally not happen due to foreign keys
                throw new Error(`Cart item ${item.id} is missing record data. Please refresh your cart.`);
            }

            // Re-validate record status and quantity at checkout time
            const record = await tx.record.findUnique({
                where: { id: item.recordId },
                select: { title: true, quantity: true, status: true, price: true, coverImage: true, artist: true }
            });

            if (!record || record.status !== 'FOR_SALE') {
                throw new Error(`Item '${item.record.title}' is no longer available for sale. Please remove it from your cart.`);
            }
            if (record.quantity < item.quantity) {
                throw new Error(`Insufficient stock for '${item.record.title}'. Only ${record.quantity} available. Please update your cart.`);
            }

             // Stripe requires price in the smallest currency unit (e.g., cents)
             // Assuming item.record.price is stored as a float representing the main unit (e.g., dollars)
            const unitAmount = Math.round(record.price * 100); // Convert to cents
            if (unitAmount <= 0) {
                 // Stripe requires positive amount
                 console.warn(`Record ${record.title} has zero or negative price. Skipping.`);
                 continue; // Or throw error? Decide based on business logic
            }

            line_items.push({
                price_data: {
                    currency: 'usd', // Or use a configurable currency
                    product_data: {
                        name: `${record.artist} - ${record.title}`,
                        // description: `Format: ${record.format}, Condition: ${item.record.condition}`, // Add more details if needed
                        images: record.coverImage ? [record.coverImage] : [],
                        // Pass local record ID for potential use in webhook, though metadata is better
                        // metadata: { localRecordId: item.recordId }, 
                        metadata: { 
                            dbRecordId: item.recordId // Store the actual database record ID
                        }
                    },
                    unit_amount: unitAmount,
                },
                quantity: item.quantity,
            });
            totalCartQuantity += item.quantity;
        }
    });

    if (line_items.length === 0) {
        throw new Error('No valid items found in the cart for checkout.');
    }

    // 3. Create Stripe Checkout Session
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: line_items,
            mode: 'payment',
            success_url: FRONTEND_CHECKOUT_SUCCESS_URL,
            cancel_url: FRONTEND_CHECKOUT_CANCEL_URL,
            // Metadata is crucial for linking the session back to your system in the webhook
            metadata: {
                userId: userId,
                cartId: cart.id, // Store cart ID
                itemCount: cart.items.length,
                totalQuantity: totalCartQuantity,
                // Avoid storing sensitive or overly large data here.
                // Consider storing IDs and re-fetching details in the webhook if needed.
            },
            // Optionally collect customer email or prefill if known
            // customer_email: userEmail, // Fetch user email if available
            // Optionally collect shipping address
            // shipping_address_collection: {
            //   allowed_countries: ['US', 'CA'], // Specify allowed countries
            // },
        });
        console.log(`Stripe Checkout Session created for user ${userId}, cart ${cart.id}. Session ID: ${session.id}`);
        return session;
    } catch (error) {
        console.error('Stripe Checkout Session creation failed:', error);
        throw new Error(`Failed to create Stripe session: ${error.message}`);
    }
}

module.exports = {
    createCheckoutSession,
}; 