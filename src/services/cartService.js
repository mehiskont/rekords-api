const prisma = require('../lib/prisma');

/**
 * Retrieves the user's cart, creating one if it doesn't exist.
 * Includes cart items and associated record details.
 * @param {string} userId - The ID of the user.
 * @returns {Promise<object>} The user's cart object.
 */
async function getCart(userId) {
    let cart = await prisma.cart.findUnique({
        where: { userId },
        include: {
            items: {
                include: {
                    record: true, // Include details of the record in the cart item
                },
                orderBy: {
                    createdAt: 'asc', // Optional: order items by when they were added
                },
            },
        },
    });

    if (!cart) {
        console.log(`No cart found for user ${userId}, creating one.`);
        cart = await prisma.cart.create({
            data: { userId },
            include: {
                items: true, // Include empty items array for consistency
            },
        });
    }

    return cart;
}

/**
 * Adds a record to the user's cart or increases its quantity.
 * @param {string} userId - The ID of the user.
 * @param {string} recordId - The ID of the record to add.
 * @param {number} quantity - The quantity to add (must be positive).
 * @returns {Promise<object>} The updated cart object.
 * @throws {Error} If record not found, not for sale, or insufficient quantity.
 */
async function addItemToCart(userId, recordId, quantity) {
    if (!quantity || quantity <= 0) {
        throw new Error('Quantity must be a positive number.');
    }

    const cart = await getCart(userId); // Ensure cart exists and get ID

    return prisma.$transaction(async (tx) => {
        // 1. Find the record and check availability
        const record = await tx.record.findUnique({
            where: { id: recordId },
        });

        if (!record) {
            throw new Error('Record not found.');
        }
        if (record.status !== 'FOR_SALE') {
            throw new Error('Record is not available for sale.');
        }
        if (record.userId === userId) {
            throw new Error('Cannot add your own item to the cart.'); // Prevent seller buying own item
        }

        // 2. Check if item already exists in cart
        const existingItem = await tx.cartItem.findUnique({
            where: {
                cartId_recordId: { cartId: cart.id, recordId },
            },
        });

        let finalQuantity;
        if (existingItem) {
            finalQuantity = existingItem.quantity + quantity;
        } else {
            finalQuantity = quantity;
        }

        // 3. Check available quantity
        if (record.quantity < finalQuantity) {
            throw new Error(`Insufficient quantity available for record ${record.title}. Only ${record.quantity} left.`);
        }

        // 4. Upsert the cart item
        await tx.cartItem.upsert({
            where: {
                cartId_recordId: { cartId: cart.id, recordId },
            },
            update: {
                quantity: { increment: quantity },
            },
            create: {
                cartId: cart.id,
                recordId: recordId,
                quantity: quantity,
            },
        });

        // Return the updated cart (outside transaction to see the final state)
        return getCart(userId);
    });
}

/**
 * Updates the quantity of a specific item in the user's cart.
 * @param {string} userId - The ID of the user.
 * @param {string} cartItemId - The ID of the cart item to update.
 * @param {number} quantity - The new quantity (must be positive, use removeItemFromCart for 0).
 * @returns {Promise<object>} The updated cart object.
 * @throws {Error} If cart item not found, permission denied, or insufficient quantity.
 */
async function updateCartItemQuantity(userId, cartItemId, quantity) {
    if (!quantity || quantity <= 0) {
        // To remove item, use removeItemFromCart explicitly
        throw new Error('Quantity must be a positive number. To remove an item, use the delete endpoint.');
    }

    return prisma.$transaction(async (tx) => {
        // 1. Find the cart item and the associated record
        const cartItem = await tx.cartItem.findUnique({
            where: { id: cartItemId },
            include: { cart: true, record: true }, // Include cart for userId check and record for quantity check
        });

        if (!cartItem) {
            throw new Error('Cart item not found.');
        }

        // 2. Verify ownership
        if (cartItem.cart.userId !== userId) {
            throw new Error('Permission denied to update this cart item.');
        }

        // 3. Check record availability
        if (!cartItem.record) {
             // Should not happen due to db constraints, but good practice
            await tx.cartItem.delete({ where: { id: cartItemId }}); // Clean up orphan
            throw new Error('Associated record for this cart item no longer exists.');
        }
        if (cartItem.record.status !== 'FOR_SALE' && cartItem.record.quantity < quantity) {
             // If record became not for sale, remove if qty not met, else allow keeping existing qty?
             // For simplicity, let's check against available stock always
            throw new Error(`Record '${cartItem.record.title}' is no longer available in the requested quantity.`);
        }

        // 4. Check available quantity
        if (cartItem.record.quantity < quantity) {
            throw new Error(`Insufficient quantity available for record ${cartItem.record.title}. Only ${cartItem.record.quantity} left.`);
        }

        // 5. Update the quantity
        await tx.cartItem.update({
            where: { id: cartItemId },
            data: { quantity: quantity },
        });

        // Return the updated cart (outside transaction)
        return getCart(userId);
    });
}

/**
 * Removes an item completely from the user's cart.
 * @param {string} userId - The ID of the user.
 * @param {string} cartItemId - The ID of the cart item to remove.
 * @returns {Promise<object>} The updated cart object.
 * @throws {Error} If cart item not found or permission denied.
 */
async function removeItemFromCart(userId, cartItemId) {
    // 1. Find the cart item to verify ownership
    const cartItem = await prisma.cartItem.findUnique({
        where: { id: cartItemId },
        include: { cart: true }, // Include cart to check userId
    });

    if (!cartItem) {
        // If item doesn't exist, it's already 'removed', return current cart state
        console.warn(`Attempted to remove non-existent cart item ${cartItemId} for user ${userId}`);
        return getCart(userId);
    }

    // 2. Verify ownership
    if (cartItem.cart.userId !== userId) {
        throw new Error('Permission denied to remove this cart item.');
    }

    // 3. Delete the item
    await prisma.cartItem.delete({
        where: { id: cartItemId },
    });

    // Return the updated cart
    return getCart(userId);
}

/**
 * Merges guest cart items (from localStorage) into the user's persistent cart.
 * @param {string} userId - The ID of the user.
 * @param {Array<{recordId: string, quantity: number}>} guestCartItems - Array of items from guest cart.
 * @returns {Promise<object>} The final merged cart object.
 * @throws {Error} If validation fails or during database operations.
 */
async function mergeCart(userId, guestCartItems) {
    if (!Array.isArray(guestCartItems)) {
        throw new Error('Guest cart items must be provided as an array.');
    }

    const cart = await getCart(userId); // Ensure user's cart exists

    // Use a transaction to handle all merges atomically
    await prisma.$transaction(async (tx) => {
        for (const guestItem of guestCartItems) {
            if (!guestItem.recordId || typeof guestItem.quantity !== 'number' || guestItem.quantity <= 0) {
                console.warn('Skipping invalid guest cart item:', guestItem);
                continue; // Skip malformed items
            }

            const { recordId, quantity: guestQuantity } = guestItem;

            // 1. Find the record and check availability
            const record = await tx.record.findUnique({ where: { id: recordId } });

            if (!record) {
                console.warn(`Record ID ${recordId} from guest cart not found. Skipping.`);
                continue;
            }
            if (record.status !== 'FOR_SALE') {
                console.warn(`Record ID ${recordId} (${record.title}) from guest cart is no longer for sale. Skipping.`);
                continue;
            }
            if (record.userId === userId) {
                console.warn(`Skipping own record ID ${recordId} from guest cart.`);
                continue; // Prevent adding own item
            }

            // 2. Check if item already exists in the user's persistent cart
            const existingDbItem = await tx.cartItem.findUnique({
                where: {
                    cartId_recordId: { cartId: cart.id, recordId },
                },
            });

            let quantityToSet;
            if (existingDbItem) {
                // Merge Strategy: Sum quantities (or choose another strategy like overwrite)
                quantityToSet = existingDbItem.quantity + guestQuantity;
            } else {
                quantityToSet = guestQuantity;
            }

            // 3. Check available quantity against the final desired quantity
            if (record.quantity < quantityToSet) {
                console.warn(`Insufficient quantity for record ID ${recordId} (${record.title}). Available: ${record.quantity}, Requested total: ${quantityToSet}. Adjusting quantity.`);
                // Adjust quantity to max available, only if adding *new* quantity would exceed stock
                // If it already existed, we might just leave it as is, or cap it.
                // Capping at available quantity seems safest.
                quantityToSet = record.quantity;
                 if (quantityToSet <= 0) { // If capping makes it zero or less, skip adding/updating
                    console.warn(`Record ID ${recordId} (${record.title}) is out of stock. Skipping merge for this item.`);
                    continue;
                 }
            }

            // 4. Upsert the cart item with the calculated quantity
            console.log(`Merging item: Record ${recordId}, Quantity ${quantityToSet}`);
            await tx.cartItem.upsert({
                where: {
                    cartId_recordId: { cartId: cart.id, recordId },
                },
                update: {
                    quantity: quantityToSet, // Set the calculated quantity
                },
                create: {
                    cartId: cart.id,
                    recordId: recordId,
                    quantity: quantityToSet,
                },
            });
        }
    });

    // Return the fully updated cart after the transaction completes
    return getCart(userId);
}

module.exports = {
    getCart,
    addItemToCart,
    updateCartItemQuantity,
    removeItemFromCart,
    mergeCart, // Export the new function
}; 