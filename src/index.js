require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const expressSession = require('express-session');
const pgSession = require('connect-pg-simple')(expressSession);
const prisma = require('./lib/prisma'); // Import Prisma client
const authRoutes = require('./routes/authRoutes'); // Import auth routes
const path = require('path'); // Add path module
const cors = require('cors'); // Import cors middleware
const { syncDiscogsInventory, getInventoryStats } = require('./services/inventoryService'); // Import sync function
const { startInventorySyncJob } = require('./jobs/inventorySyncJob'); // Import job starter
const { PrismaSessionStore } = require('@quixo3/prisma-session-store');
const schedule = require('node-schedule');
const discogsRoutes = require('./routes/discogsRoutes'); // Import the new Discogs routes

// --- Global BigInt JSON Serialization Patch ---
// Add this block BEFORE any routes or middleware that might handle JSON
BigInt.prototype.toJSON = function() {
  return this.toString();
};
// --- End BigInt Patch ---

// --- Environment Variable Checks ---
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'replace_this_with_a_strong_random_secret') {
  console.warn('WARNING: SESSION_SECRET is not defined or is weak in .env. Please set a strong secret.');
  // In production, you might want to exit: process.exit(1);
}
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY === 'YOUR_STRONG_32_BYTE_SECRET_KEY_HEX_HERE') {
  console.error('FATAL ERROR: ENCRYPTION_KEY is not defined or is set to the placeholder in .env. Please generate and set a proper key.');
  process.exit(1); // Exit if encryption key is missing or default
}
if (!process.env.DISCOGS_CONSUMER_KEY || !process.env.DISCOGS_CONSUMER_SECRET) {
    console.warn('WARNING: DISCOGS_CONSUMER_KEY or DISCOGS_CONSUMER_SECRET not set in .env. Discogs features may fail.');
}
const port = process.env.PORT || 3001; // Define port for use throughout the app

// Set FRONTEND_URL default if not provided
if (!process.env.FRONTEND_URL) {
    console.warn('WARNING: FRONTEND_URL not set in .env. Using default for local development.');
    process.env.FRONTEND_URL = 'http://localhost:3000'; // Default frontend port is usually 3000
}
console.log(`Using FRONTEND_URL: ${process.env.FRONTEND_URL}`);
// --- End Environment Variable Checks ---

const app = express();

// --- Session Configuration ---
// IMPORTANT: Replace SESSION_SECRET in .env with a strong random string
if (!process.env.SESSION_SECRET) {
  console.error('FATAL ERROR: SESSION_SECRET is not defined in .env');
  process.exit(1);
}

app.use(
  expressSession({
    store: new PrismaSessionStore(
      prisma,
      {
        checkPeriod: 2 * 60 * 1000,  //ms
        dbRecordIdIsSessionId: true,
        sessionModelName: 'UserSession', // Use the UserSession model created in migration
      }
    ),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // Important for cross-site cookies in production
    },
  })
);
// --- End Session Configuration ---

// --- CORS Configuration ---
const corsOptions = {
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, etc)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = process.env.NODE_ENV === 'production'
      ? [process.env.FRONTEND_URL]
      : [process.env.FRONTEND_URL, 'http://localhost:3000', 'http://127.0.0.1:3000'];
    
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      console.log(`Origin ${origin} not allowed by CORS`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // Critical for cookies/auth
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
console.log(`CORS configured with allowed origins: ${process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : [process.env.FRONTEND_URL, 'http://localhost:3000', 'http://127.0.0.1:3000']}`);
// --- End CORS Configuration ---

// --- Webhook Route (BEFORE express.json()) ---
// Stripe requires the raw body for signature verification
const webhookRoutes = require('./routes/webhookRoutes');
app.use('/api/webhooks', express.raw({type: 'application/json'}), webhookRoutes);
// --- End Webhook Route ---

// Middleware (add more as needed, e.g., body parsing, cors)
// Regular JSON parsing for other routes
app.use(express.json()); // For parsing application/json

// Basic route for testing
app.get('/', (req, res) => {
  // Example: check session
  // req.session.views = (req.session.views || 0) + 1;
  // console.log('Session:', req.session);
  res.send('Plastik API is running!');
});

// Database status check endpoint
app.get('/api/db-status', async (req, res) => {
  try {
    // Try a simple query to check DB connection
    const recordCount = await prisma.record.count();
    const userCount = await prisma.user.count();
    
    res.status(200).json({
      status: 'ok',
      database: {
        connected: true,
        records: recordCount,
        users: userCount
      }
    });
  } catch (error) {
    console.error('Database status check failed:', error);
    res.status(500).json({
      status: 'error',
      message: 'Database connection failed',
      error: error.message
    });
  }
});

// --- Simple UI Page Route (REMOVED) ---
// app.get('/connect', (req, res) => { ... });
// --- End Simple UI Page Route ---

// --- API Routes ---
app.use('/api/auth', authRoutes); // Mount auth routes
const recordRoutes = require('./routes/recordRoutes');
app.use('/api/records', recordRoutes);
const inventoryRoutes = require('./routes/inventoryRoutes'); // Import inventory routes
app.use('/api/inventory', inventoryRoutes); // Mount inventory routes
const cartRoutes = require('./routes/cartRoutes'); // Import cart routes
app.use('/api/cart', cartRoutes); // Mount cart routes
const checkoutRoutes = require('./routes/checkoutRoutes'); // Import checkout routes
app.use('/api/checkout', checkoutRoutes); // Mount checkout routes
app.use('/api/discogs', discogsRoutes); // Mount the new Discogs routes

// --- End API Routes ---

// TODO: Add Error handling middleware

// --- Start Server & Initial Checks ---
app.listen(port, async () => { // Make the callback async
  console.log(`Server listening at http://localhost:${port}`);

  // Remove OWNER_USER_ID check here
  // const ownerUserId = process.env.OWNER_USER_ID;

  // --- Initial Inventory Sync Check (Run once on startup) ---
  // Run check regardless of OWNER_USER_ID now
  try {
    const recordCount = await prisma.record.count();
    console.log(`[Startup Check] Found ${recordCount} records in the database.`);
    if (recordCount === 0) {
      console.log('[Startup Check] Database appears empty. Triggering initial Discogs inventory sync in the background...');
      // Call sync without userId
      syncDiscogsInventory() // No argument needed
        .then(result => console.log('[Startup Check] Initial background inventory sync finished:', result))
        .catch(error => console.error('[Startup Check] Initial background inventory sync failed:', error));
    }
  } catch (error) {
    console.error('[Startup Check] Failed to check initial record count or trigger sync:', error);
  }
  // Removed the 'else' block related to OWNER_USER_ID missing

  // --- Start Scheduled Background Jobs ---
  // The startInventorySyncJob function will be updated separately to remove its OWNER_USER_ID dependency.
  console.log('Starting scheduled background jobs...');
  startInventorySyncJob(); 
});
