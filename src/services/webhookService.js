const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const prisma = require('../lib/prisma');
const { getDiscogsClient } = require('../controllers/authController'); // Assuming Discogs client helper is here
const { sendOrderConfirmationEmail } = require('../services/emailService'); // Import the email service

/**
 * Handles the 'checkout.session.completed' Stripe event.
 * Creates an Order, OrderItems, updates Record quantities/status, updates Discogs listing,
 * and clears the user's cart within a transaction.
 * @param {object} session - The Stripe Checkout Session object from the event.
 */
async function handleCheckoutSessionCompleted(session) {
    console.log(`Handling checkout.session.completed for session ID: ${session.id}`);

    const userId = session.metadata?.userId;
    const cartId = session.metadata?.cartId;
    const checkoutId = session.id;
    const paymentIntentId = session.payment_intent;
    const customerDetails = session.customer_details;
    const amountTotal = session.amount_total; // Amount in smallest currency unit (cents)
    const currency = session.currency;

    if (!userId) {
        console.error(`Webhook Error: Missing userId in metadata for session ${checkoutId}`);
        // Consider logging this to a more persistent error tracking system
        return; // Cannot proceed without userId
    }
    if (!cartId) {
        console.error(`Webhook Error: Missing cartId in metadata for session ${checkoutId}`);
        // We might be able to proceed without cartId if we fetch line items, but it's good for reference
    }

    // --- Idempotency Check: Prevent processing the same event multiple times ---
    const existingOrder = await prisma.order.findUnique({
        where: { stripeCheckoutId: checkoutId },
        select: { id: true }
    });

    if (existingOrder) {
        console.log(`Webhook Info: Order for session ${checkoutId} already processed (Order ID: ${existingOrder.id}). Skipping.`);
        return;
    }

    // --- Retrieve line items associated with the session --- 
    // This is more reliable than relying solely on cartId from metadata, 
    // as cart could theoretically change between session creation and completion.
    let lineItems;
    try {
        // Expand the product data to access metadata
        lineItems = await stripe.checkout.sessions.listLineItems(checkoutId, { 
            limit: 100, // Adjust limit if needed
            expand: ['data.price.product'] // Expand product data within price object
        }); 
        if (!lineItems || !lineItems.data || lineItems.data.length === 0) {
            throw new Error('No line items found for session.');
        }
    } catch (error) {
        console.error(`Webhook Error: Failed to retrieve line items for session ${checkoutId}:`, error);
        return; // Cannot create order without line items
    }

    // --- Main Order Processing Transaction --- 
    let createdOrderId = null; // Variable to store the order ID outside the transaction
    try {
        await prisma.$transaction(async (tx) => {

            // 1. Create the Order
            console.log(`Creating Order for session ${checkoutId}...`);
            const order = await tx.order.create({
                data: {
                    userId: userId,
                    stripeCheckoutId: checkoutId,
                    stripePaymentIntentId: paymentIntentId,
                    status: 'PAID', // Assuming payment is confirmed by this event
                    totalAmount: amountTotal,
                    currency: currency.toUpperCase(),
                    customerName: customerDetails?.name || 'N/A',
                    customerEmail: customerDetails?.email || 'N/A',
                    // TODO: Add shipping/billing address if collected
                    // shippingAddress: session.shipping_details?.address,
                    // billingAddress: customerDetails?.address,
                },
            });
            console.log(`Order ${order.id} created.`);
            createdOrderId = order.id; // Store the ID for use after transaction

            // Prepare for Discogs updates
            let discogsClient;
            try {
                 discogsClient = await getDiscogsClient();
            } catch (discogsError) {
                 console.error(`Webhook Warning: Failed to initialize Discogs client for Order ${order.id}. Discogs updates will be skipped. Error:`, discogsError.message);
                 // Decide if this should fail the transaction or just log a warning
                 // For now, we log and continue creating the local order
                 discogsClient = null;
            }

            // 2. Process each item: Create OrderItem, Update Record, Update Discogs
            for (const item of lineItems.data) {
                const quantitySold = item.quantity;
                // We need to link the Stripe line item back to our Record ID.
                // This relies on having stored it accurately during session creation.
                // Option A: Retrieve from Price/Product metadata (if set during session create)
                // const recordId = item.price.product.metadata?.localRecordId;
                // Option B: Re-query based on product name/description (less reliable)
                // For now, let's assume we need to map based on product name (requires improvement)
                // THIS IS A SIMPLIFICATION - A robust solution needs a better link.
                // We should ideally store `recordId` in the price_data.product_data.metadata
                // when creating the checkout session.
                
                // TEMPORARY: Fetch record based on name - Needs improvement!
                //  const productName = item.description; // Stripe uses description for product_data.name
                //  const [artist, title] = productName.split(' - '); // Basic split
                
                 // --- RELIABLE LINKING --- 
                 const recordId = item.price?.product?.metadata?.dbRecordId;

                 if (!recordId) {
                     // This is critical - metadata missing or structure changed.
                     console.error(`Webhook Critical Error: Missing dbRecordId in metadata for Stripe line item: ${item.id} (Product: ${item.price?.product?.id}) in session ${checkoutId}.`);
                     throw new Error(`Missing dbRecordId metadata for line item ${item.id}`);
                 }

                 const record = await tx.record.findUnique({ // Use findUnique now that we have the ID
                    where: { 
                         id: recordId
                     },
                 });

                if (!record) {
                    // This is serious - we charged for an item we can't identify or is gone.
                    // Should we throw to rollback? Or log and potentially refund manually?
                    console.error(`Webhook Critical Error: Could not find matching Record in DB for Stripe line item: ${item.id} (Record ID from metadata: ${recordId}) (Order ID: ${order.id}). Manual investigation needed.`);
                    // Throwing error to rollback the transaction for safety
                    // throw new Error(`Failed to find matching record for ${productName}`);
                     throw new Error(`Failed to find record with ID ${recordId}`);
                }
                
                 if (record.status !== 'FOR_SALE') {
                    // Record was found but is no longer for sale (e.g., sold via another channel between checkout and webhook?)
                    console.error(`Webhook Critical Error: Record ${record.id} (${record.title}) was not FOR_SALE at time of webhook processing for Order ${order.id}. Status: ${record.status}. Manual investigation needed.`);
                    throw new Error(`Record ${record.id} was not FOR_SALE post-payment.`);
                 }
                 
                 if (record.quantity < quantitySold) {
                    // Quantity changed between checkout and payment confirmation?
                    console.error(`Webhook Critical Error: Insufficient stock for Record ${record.id} (${record.title}) after payment confirmation for Order ${order.id}. Available: ${record.quantity}, Sold: ${quantitySold}. Manual investigation needed.`);
                     // Rollback transaction
                     throw new Error(`Insufficient stock post-payment for record ${record.id}`);
                 }

                console.log(`Processing item for Order ${order.id}: Record ${record.id}, Quantity ${quantitySold}`);

                // Create OrderItem (snapshot of price/details)
                await tx.orderItem.create({
                    data: {
                        orderId: order.id,
                        recordId: record.id,
                        title: record.title, // Snapshot title
                        artist: record.artist, // Snapshot artist
                        price: Math.round(record.price * 100), // Snapshot price in cents
                        quantity: quantitySold,
                    },
                });

                // Update local Record quantity and status
                const newQuantity = record.quantity - quantitySold;
                const newStatus = newQuantity <= 0 ? 'SOLD' : 'FOR_SALE';
                await tx.record.update({
                    where: { id: record.id },
                    data: {
                        quantity: newQuantity,
                        status: newStatus,
                    },
                });
                console.log(`Updated local Record ${record.id}: New Quantity ${newQuantity}, Status ${newStatus}`);

                // Update Discogs Listing - only if client initialized and listing ID exists
                if (discogsClient && record.discogsListingId) {
                    const listingId = record.discogsListingId;
                    const releaseId = record.discogsReleaseId;
                    const appUsername = process.env.DISCOGS_USERNAME; // Get username for relisting endpoint

                    try {
                        console.log(`Processing Discogs update for Listing ID: ${listingId} (Record ${record.id}, Release ${releaseId})`);

                         if (newQuantity > 0) {
                            // --- Delete + Relist Strategy --- 
                            console.log(`Deleting Discogs listing ${listingId} before relisting with quantity ${newQuantity}...`);
                            
                            // 1. Delete the old listing
                            try {
                                await discogsClient.delete(`/marketplace/listings/${listingId}`);
                                console.log(`Successfully deleted old Discogs listing ${listingId}.`);
                            } catch (deleteError) {
                                console.error(
                                    `Webhook Warning: Failed to DELETE old Discogs listing ${listingId} before relist for Order ${order.id}, Record ${record.id}. Error: ${deleteError.response?.data?.message || deleteError.message}. Attempting relist anyway, but might cause duplicates.`
                                );
                                // Decide whether to continue or stop if delete fails. Continuing might be okay.
                            }

                            // 2. Add a new listing with the updated quantity
                            const addListingPayload = {
                                release_id: releaseId,
                                condition: record.condition,
                                sleeve_condition: record.sleeveCondition,
                                price: record.price, // Assumes price is stored in the correct format/currency base
                                status: 'For Sale',
                                comments: record.notes,
                                // location: record.location, // Optional
                            };
                            
                            console.log(`Relisting item for Release ID ${releaseId} (implicit quantity 1)... Payload:`, addListingPayload);

                            try {
                                // Endpoint corrected to standard marketplace listings endpoint
                                // if (!appUsername) throw new Error('DISCOGS_USERNAME not set in env for relisting.'); // Username not needed in path
                                const newListResponse = await discogsClient.post(`/marketplace/listings`, addListingPayload);
                                const newListingId = newListResponse?.data?.listing_id; // Adjust based on actual response structure

                                if (!newListingId) {
                                     console.error(`Webhook Warning: Successfully added new listing for Release ${releaseId}, but failed to get new listing_id from response. Local record needs manual update. Response:`, newListResponse?.data);
                                     throw new Error('Failed to retrieve new listing ID after relisting.'); // Throw to potentially retry or flag
                                }
                                
                                console.log(`Successfully relisted Release ${releaseId} as new Listing ID: ${newListingId}.`);

                                // 3. Update local record with the NEW listing ID
                                await tx.record.update({
                                    where: { id: record.id },
                                    data: { discogsListingId: newListingId },
                                });
                                console.log(`Updated local Record ${record.id} with new discogsListingId: ${newListingId}`);

                            } catch (addError) {
                                console.error(
                                    `Webhook Critical Error: Failed to RELIST item on Discogs for Release ${releaseId} (Order ${order.id}, Record ${record.id}) after deleting old listing ${listingId}. Error: ${addError.response?.data?.message || addError.message}. Inventory potentially out of sync!`
                                );
                                // This is more critical - we deleted but couldn't relist. Requires manual intervention.
                                // Should this fail the whole transaction?
                                throw addError; // Fail the transaction if relist fails
                            }

                         } else {
                            // --- Delete Listing (Quantity is Zero) --- 
                             console.log(`Deleting Discogs listing ${listingId} as quantity is zero.`);
                            await discogsClient.delete(`/marketplace/listings/${listingId}`);
                            console.log(`Successfully deleted Discogs listing ${listingId}.`);
                         }

                    } catch (discogsError) {
                        // Log error but don't fail the transaction?
                        console.error(
                            `Webhook Warning: Failed during overall Discogs operation for listing ${listingId} (Order ${order.id}, Record ${record.id}). Error: ${discogsError.response?.data?.message || discogsError.message}. Manual update may be needed.`
                        );
                         // If we threw inside the try block (e.g., on relist failure), this won't be reached.
                         // If an error occurred outside the critical relist path (e.g., initial delete failed but we continued),
                         // we might end up here. Decide if these errors should also fail the transaction.
                         // For now, only critical relist failure stops the process.
                    }
                } else if (!record.discogsListingId) {
                    console.warn(`Webhook Warning: Cannot update Discogs for Record ${record.id}, missing discogsListingId.`);
                } else if (!discogsClient) {
                     console.warn(`Webhook Warning: Skipping Discogs update for Record ${record.id} due to client initialization failure.`);
                }
            }

            // 4. Clear the user's cart (associated with the userId)
            // We use userId from metadata which should be reliable
            console.log(`Clearing cart for User ID: ${userId}...`);
            const userCart = await tx.cart.findUnique({
                where: { userId: userId },
                select: { id: true }
            });

            if (userCart) {
                // Delete cart items first
                await tx.cartItem.deleteMany({
                    where: { cartId: userCart.id }
                });
                // Could also delete the cart itself, or just leave it empty
                // await tx.cart.delete({ where: { id: userCart.id } }); 
                console.log(`Cleared items from Cart ID: ${userCart.id}`);
            } else {
                console.log(`No active cart found for User ID: ${userId} to clear.`);
            }

        }, {
             timeout: 20000 // Increase transaction timeout if needed (default 5s)
         }); // End Prisma Transaction

        console.log(`Successfully completed transaction for Order ID: ${createdOrderId}`);

        // --- Post-Transaction Actions (like sending email) --- 
        if (createdOrderId) {
            try {
                // Fetch the complete order details needed for the email
                const completeOrder = await prisma.order.findUnique({
                    where: { id: createdOrderId },
                    include: {
                        orderItems: true, // Include items for the email body
                        // user: { select: { email: true, name: true } } // Optionally include user details if needed and not already on order
                    }
                });

                if (completeOrder) {
                    await sendOrderConfirmationEmail(completeOrder);
                } else {
                    console.error(`Webhook Post-Tx Error: Failed to fetch complete order details for ID ${createdOrderId} to send confirmation email.`);
                }

            } catch (emailError) {
                // Log email sending errors but don't fail the webhook response
                console.error(`Webhook Post-Tx Error: Failed to send order confirmation email for Order ID ${createdOrderId}:`, emailError);
            }
        } else {
             console.error(`Webhook Post-Tx Error: createdOrderId was null after transaction, cannot send email.`);
        }

    } catch (error) {
        console.error(`Webhook Critical Error: Transaction failed for session ${checkoutId}. Error:`, error);
        // Depending on the error, you might want specific handling or alerts
        // No email will be sent if the transaction fails.
        // Respond to Stripe to signal failure? Usually a 500 status is sufficient.
        // Rethrow the error if the calling context needs to handle it (e.g., send 500 response)
        throw error; // Rethrow to ensure the webhook endpoint knows processing failed
    }
}


/**
 * Main handler to switch based on Stripe event type.
 * @param {Stripe.Event} event - The verified Stripe event object.
 */
async function handleStripeEvent(event) {
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            await handleCheckoutSessionCompleted(session);
            break;
        // case 'payment_intent.succeeded':
        //     const paymentIntent = event.data.object;
        //     // Handle successful payment intent if needed (e.g., for non-Checkout flows)
        //     console.log('PaymentIntent succeeded:', paymentIntent.id);
        //     break;
        // case 'payment_intent.payment_failed':
        //     const failedPaymentIntent = event.data.object;
        //     // Handle failed payment intent
        //     console.log('PaymentIntent failed:', failedPaymentIntent.id);
        //     break;
        // ... handle other event types as needed
        default:
            console.log(`Webhook Info: Unhandled event type ${event.type}`);
    }
}

module.exports = {
    handleStripeEvent,
}; 