// src/middleware/authMiddleware.js

const requireAuth = (req, res, next) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ message: 'Authentication required. Please log in.' });
    }
    // If authenticated, attach userId to req for downstream use (optional but convenient)
    // req.userId = req.session.userId;
    next(); // User is authenticated, proceed to the next middleware or route handler
};

module.exports = { requireAuth }; 