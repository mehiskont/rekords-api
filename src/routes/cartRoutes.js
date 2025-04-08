const express = require('express');
const cartController = require('../controllers/cartController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

// Apply requireAuth middleware to all cart routes
router.use(requireAuth);

// GET /api/cart - Get user's cart
router.get('/', cartController.getCartController);

// POST /api/cart/items - Add item to cart
router.post('/items', cartController.addItemController);

// PUT /api/cart/items/:itemId - Update item quantity in cart
router.put('/items/:itemId', cartController.updateItemController);

// DELETE /api/cart/items/:itemId - Remove item from cart
router.delete('/items/:itemId', cartController.removeItemController);

// POST /api/cart/merge - Merge guest cart items into user's cart
router.post('/merge', cartController.mergeCartController);

module.exports = router; 