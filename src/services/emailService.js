const { Resend } = require('resend');

// Validate environment variables
if (!process.env.RESEND_API_KEY) {
  console.error('FATAL ERROR: RESEND_API_KEY environment variable is not set.');
  process.exit(1); // Stop the process if critical config is missing
}

const configuredFromAddress = process.env.EMAIL_FROM_ADDRESS;
if (!configuredFromAddress) {
  console.warn('WARNING: EMAIL_FROM_ADDRESS environment variable is not set. Using default `onboarding@resend.dev`. Verify a domain for better deliverability.');
}

const resend = new Resend(process.env.RESEND_API_KEY);
const fromAddress = configuredFromAddress || 'onboarding@resend.dev';

/**
 * Sends an order confirmation email using Resend.
 * @param {object} order - The complete order object from Prisma, expected to include
 *                         relations like `orderItems` for a full confirmation.
 * @param {object[]} order.orderItems - Array of items in the order.
 * @param {string} order.id - The unique ID of the order.
 * @param {string} order.customerEmail - The recipient's email address.
 * @param {number} order.totalAmount - The total amount in the smallest currency unit (e.g., cents).
 * @param {string} order.currency - The currency code (e.g., 'USD').
 * @param {string} [order.customerName] - Optional customer name.
 * @param {Date} order.createdAt - The date the order was created.
 */
async function sendOrderConfirmationEmail(order) {
  // --- Input Validation ---
  if (!order) {
    console.error('Email Service Error: No order object provided.');
    return;
  }
  if (!order.id || !order.customerEmail || order.totalAmount == null || !order.currency || !order.createdAt) {
    console.error(`Email Service Error: Incomplete essential order data provided. Order ID: ${order.id || 'N/A'}. Cannot send confirmation.`);
    // Log the received order object for debugging if possible (careful with sensitive data)
    // console.error('Received order data:', JSON.stringify(order, null, 2));
    return;
  }

  const recipientEmail = order.customerEmail;
  const orderId = order.id;
  const totalAmountFormatted = (order.totalAmount / 100).toFixed(2);
  const currency = order.currency.toUpperCase();
  const customerName = order.customerName || 'Valued Customer';
  const orderDate = new Date(order.createdAt).toLocaleDateString();

  // --- Email Content Construction ---
  const subject = `Your Plastik Order Confirmation (ID: ${orderId})`;

  let textBody = `Hello ${customerName},\n\n`;
  textBody += `Thank you for your order! We've received it and will process it shortly.\n\n`;
  textBody += `--- Order Summary --- \n`;
  textBody += `Order ID: ${orderId}\n`;
  textBody += `Order Date: ${orderDate}\n\n`;

  // Include order items if available
  if (order.orderItems && Array.isArray(order.orderItems) && order.orderItems.length > 0) {
    textBody += `Items Purchased:\n`;
    order.orderItems.forEach(item => {
      const artist = item.artist || 'N/A';
      const title = item.title || 'Item';
      const quantity = item.quantity || 0;
      const price = item.price != null ? (item.price / 100).toFixed(2) : 'N/A';
      textBody += `- ${quantity} x ${artist} - ${title} @ ${currency} ${price}\n`;
    });
    textBody += `\n`;
  } else {
    // Optional: Add a note if items aren't included
    // textBody += `(Detailed item list will be sent with shipping confirmation.)\n\n`;
    console.warn(`Email Service Warning: Order ${orderId} did not have orderItems attached when sending confirmation email.`);
  }

  textBody += `Total Amount: ${currency} ${totalAmountFormatted}\n\n`;

  // TODO: Add Shipping Address if available in the order object
  // if (order.shippingAddress) {
  //   textBody += `Shipping To:\n`;
  //   textBody += `${order.shippingAddress.line1}\n`;
  //   // ... add other address lines ...
  //   textBody += `\n`;
  // }

  textBody += `If you have any questions, please reply to this email.\n\n`;
  textBody += `Thanks again for shopping at Plastik!\n`;

  // --- Sending Email via Resend ---
  console.log(`Attempting to send order confirmation email via Resend to: ${recipientEmail} for Order ID: ${orderId}`);

  try {
    const response = await resend.emails.send({
      from: fromAddress,
      to: [recipientEmail], // Resend API expects an array
      subject: subject,
      text: textBody,
      // Optionally add HTML version:
      // html: `<p>Hello ${customerName},</p><p>Thank you...</p>`
      // Add tags for tracking/filtering in Resend dashboard:
      tags: [
        { name: 'category', value: 'order_confirmation' },
        { name: 'order_id', value: orderId }
      ]
    });

    // Check Resend's response structure (it might have data or error)
    if (response.error) {
        // Resend API returned an error object
        console.error(`Email Service Error: Failed to send order confirmation for Order ${orderId}. Resend Error:`, JSON.stringify(response.error, null, 2));
    } else if (response.data && response.data.id) {
        // Success, log the email ID from Resend
        console.log(`Successfully sent order confirmation email for Order ${orderId} to ${recipientEmail}. Resend Email ID: ${response.data.id}`);
    } else {
        // Unexpected response structure from Resend
        console.warn(`Email Service Warning: Received unexpected response from Resend for Order ${orderId}. Response:`, JSON.stringify(response, null, 2));
    }

  } catch (exception) {
    // Catch network errors or other exceptions during the API call
    console.error(`Email Service Exception: An unexpected error occurred while sending confirmation for Order ${orderId}. Exception:`, exception);
    // Consider adding more robust error handling/reporting here
  }
}

module.exports = {
  sendOrderConfirmationEmail,
}; 