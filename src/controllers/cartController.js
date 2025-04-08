const cartService = require('../services/cartService');

// GET /api/cart - Get the current user's cart
const getCartController = async (req, res) => {
    try {
        const userId = req.session.userId;
        if (!userId) {
            // This should technically be caught by requireAuth middleware, but double-check
            return res.status(401).json({ message: 'Authentication required.' });
        }
        const cart = await cartService.getCart(userId);
        res.status(200).json(cart);
    } catch (error) {
        console.error('Error getting cart:', error);
        res.status(500).json({ message: 'Failed to retrieve cart.', error: error.message });
    }
};

// POST /api/cart/items - Add an item to the cart
const addItemController = async (req, res) => {
    try {
        const userId = req.session.userId;
        const { recordId, quantity } = req.body;

        if (!userId) {
            return res.status(401).json({ message: 'Authentication required.' });
        }
        if (!recordId || typeof quantity !== 'number') {
            return res.status(400).json({ message: 'Missing required fields: recordId and quantity (number).' });
        }

        const cart = await cartService.addItemToCart(userId, recordId, quantity);
        res.status(200).json(cart); // Return updated cart
    } catch (error) {
        console.error('Error adding item to cart:', error);
        // Send specific error messages based on service layer exceptions
        if (error.message.includes('not found') || error.message.includes('not available') || error.message.includes('Insufficient quantity') || error.message.includes('own item')) {
            res.status(400).json({ message: error.message });
        } else if (error.message.includes('positive number')) {
            res.status(400).json({ message: error.message });
        } else {
            res.status(500).json({ message: 'Failed to add item to cart.', error: error.message });
        }
    }
};

// PUT /api/cart/items/:itemId - Update item quantity
const updateItemController = async (req, res) => {
    try {
        const userId = req.session.userId;
        const { itemId } = req.params;
        const { quantity } = req.body;

        if (!userId) {
            return res.status(401).json({ message: 'Authentication required.' });
        }
        if (typeof quantity !== 'number') {
            return res.status(400).json({ message: 'Missing required field: quantity (number).' });
        }

        const cart = await cartService.updateCartItemQuantity(userId, itemId, quantity);
        res.status(200).json(cart);
    } catch (error) {
        console.error('Error updating cart item:', error);
        if (error.message.includes('not found') || error.message.includes('Permission denied') || error.message.includes('Insufficient quantity') || error.message.includes('no longer exists') || error.message.includes('not available')) {
             res.status(404).json({ message: error.message }); // Not found or forbidden
        } else if (error.message.includes('positive number')) {
            res.status(400).json({ message: error.message });
        } else {
            res.status(500).json({ message: 'Failed to update cart item.', error: error.message });
        }
    }
};

// DELETE /api/cart/items/:itemId - Remove item from cart
const removeItemController = async (req, res) => {
    try {
        const userId = req.session.userId;
        const { itemId } = req.params;

        if (!userId) {
            return res.status(401).json({ message: 'Authentication required.' });
        }

        const cart = await cartService.removeItemFromCart(userId, itemId);
        res.status(200).json(cart);
    } catch (error) {
        console.error('Error removing item from cart:', error);
        if (error.message.includes('not found') || error.message.includes('Permission denied')) {
            res.status(404).json({ message: error.message }); // Not found or forbidden
        } else {
            res.status(500).json({ message: 'Failed to remove item from cart.', error: error.message });
        }
    }
};

// POST /api/cart/merge - Merge guest cart into logged-in user's cart
const mergeCartController = async (req, res) => {
    try {
        const userId = req.session.userId;
        const { guestCartItems } = req.body; // Expecting an array like [{ recordId: '...', quantity: 1 }, ...]

        if (!userId) {
            return res.status(401).json({ message: 'Authentication required.' });
        }
        if (!Array.isArray(guestCartItems)) {
            return res.status(400).json({ message: 'Invalid request: guestCartItems must be an array.' });
        }

        if (guestCartItems.length === 0) {
            // If guest cart is empty, just return the current user cart
            console.log(`User ${userId} initiated merge with empty guest cart.`);
            const currentCart = await cartService.getCart(userId);
            return res.status(200).json(currentCart);
        }

        console.log(`User ${userId} merging ${guestCartItems.length} items from guest cart.`);
        const mergedCart = await cartService.mergeCart(userId, guestCartItems);
        res.status(200).json(mergedCart);
    } catch (error) {
        console.error('Error merging cart:', error);
        if (error.message.includes('must be provided as an array')) {
            res.status(400).json({ message: error.message });
        } else {
            // General error during merge process
            res.status(500).json({ message: 'Failed to merge cart.', error: error.message });
        }
    }
};

module.exports = {
    getCartController,
    addItemController,
    updateItemController,
    removeItemController,
    mergeCartController,
}; 