// src/middleware/authMiddleware.js

const requireAuth = (req, res, next) => {
    console.log('Auth check - session:', req.session ? {
        id: req.session.id,
        hasUserId: !!req.session.userId,
        cookie: req.session.cookie ? {
            maxAge: req.session.cookie.maxAge,
            httpOnly: req.session.cookie.httpOnly,
            secure: req.session.cookie.secure,
            sameSite: req.session.cookie.sameSite
        } : 'no cookie'
    } : 'no session');
    
    if (!req.session || !req.session.userId) {
        console.log('Auth failed - no valid session or userId');
        return res.status(401).json({ message: 'Authentication required. Please log in.' });
    }
    
    // If authenticated, attach userId to req for downstream use (convenient for controllers)
    req.userId = req.session.userId;
    console.log(`Auth successful for user ${req.session.userId}`);
    next(); // User is authenticated, proceed to the next middleware or route handler
};

module.exports = { requireAuth }; 