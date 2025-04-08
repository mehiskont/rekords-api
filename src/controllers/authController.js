const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const axios = require('axios'); // Using axios for HTTP requests
const prisma = require('../lib/prisma');

// --- Discogs OAuth Configuration ---
const consumerKey = process.env.DISCOGS_CONSUMER_KEY;
const consumerSecret = process.env.DISCOGS_CONSUMER_SECRET;
const requestTokenURL = 'https://api.discogs.com/oauth/request_token';
const authorizeURL = 'https://www.discogs.com/oauth/authorize';
const accessTokenURL = 'https://api.discogs.com/oauth/access_token';
// Crucial: This callback URL MUST match the one registered in your Discogs app settings
const callbackURL = `${process.env.API_BASE_URL || 'http://localhost:3001'}/api/auth/discogs/callback`;

// --- Application's Discogs Credentials (read from environment) ---
const appDiscogsAccessToken = process.env.DISCOGS_ACCESS_TOKEN;
const appDiscogsAccessSecret = process.env.DISCOGS_ACCESS_SECRET;

if (!consumerKey || !consumerSecret) {
  console.warn(
    'WARNING: DISCOGS_CONSUMER_KEY or DISCOGS_CONSUMER_SECRET is not defined in .env. Discogs API calls will fail.'
  );
}
if (!appDiscogsAccessToken || !appDiscogsAccessSecret) {
  console.warn(
    'WARNING: DISCOGS_ACCESS_TOKEN or DISCOGS_ACCESS_SECRET is not defined in .env. Discogs API calls will fail.'
  );
}

const oauth = new OAuth({
  consumer: {
    key: consumerKey,
    secret: consumerSecret,
  },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string, key) {
    return crypto.createHmac('sha1', key).update(base_string).digest('base64');
  },
});
// --- End Discogs OAuth Configuration ---

// Helper to get Discogs API client using application credentials
// No longer needs userId
exports.getDiscogsClient = async () => {
  if (!appDiscogsAccessToken || !appDiscogsAccessSecret) {
    throw new Error('Application Discogs Access Token/Secret not configured in .env');
  }

  const appToken = {
    key: appDiscogsAccessToken,
    secret: appDiscogsAccessSecret,
  };

  // Return an axios instance or functions pre-configured with auth headers
  const discogsApi = axios.create({
    baseURL: 'https://api.discogs.com',
  });

  discogsApi.interceptors.request.use(config => {
    const requestData = {
        url: `${config.baseURL}${config.url}`,
        method: config.method.toUpperCase(),
        data: config.data,
    };
    // Remove baseURL from the final URL sent in the Authorization header
    requestData.url = requestData.url.replace(config.baseURL, '');

    config.headers = {
        ...config.headers,
        ...oauth.toHeader(oauth.authorize(requestData, appToken)), // Use appToken
        'User-Agent': 'PlastikApp/1.0', // TODO: Maybe make User-Agent configurable?
    };
    // Axios sends params for GET requests, Discogs OAuth needs them in the base string
    if(config.params) {
        const paramsString = new URLSearchParams(config.params).toString();
        if (paramsString) { // Only add '?' if there are params
             requestData.url = `${requestData.url}?${paramsString}`;
        }
        // Clear params so axios doesn't append them again
        config.params = undefined;
    }

    console.log(`Discogs Request: ${requestData.method} ${requestData.url}`);
    // Avoid logging the full Authorization header in production if possible
    // console.log('Discogs Auth Header:', config.headers['Authorization']);

    return config;
  });

  return discogsApi;
};

// POST /api/auth/mock-login (FOR DEVELOPMENT/TESTING ONLY)
// In a real app, replace this with proper login logic (e.g., password check)
exports.mockLogin = async (req, res, next) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  try {
    // Find or create a dummy user for testing
    let user = await prisma.user.findUnique({
      where: { email: email },
    });

    if (!user) {
      console.warn(`Mock user ${email} not found, creating one.`);
      user = await prisma.user.create({
        data: {
          email: email,
          name: email.split('@')[0], // Simple name generation
          // Add other default fields if necessary
        },
      });
      console.log(`Created mock user ${email} with ID ${user.id}`);
    }

    // IMPORTANT: Regenerate session to prevent session fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error('Error regenerating session:', err);
        return res.status(500).json({ message: 'Login failed' });
      }

      // Store user ID in session
      req.session.userId = user.id;
      console.log(`User ${user.id} logged in. Session ID: ${req.session.id}`);

      // Save the session before responding
      req.session.save((saveErr) => {
        if (saveErr) {
            console.error('Error saving session:', saveErr);
            return res.status(500).json({ message: 'Login failed' });
        }
        res.status(200).json({ message: 'Logged in successfully', userId: user.id });
      });
    });

  } catch (error) {
    console.error('Mock login error:', error);
    res.status(500).json({ message: 'An error occurred during login' });
    // next(error);
  }
};

// POST /api/auth/logout
exports.logout = (req, res, next) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).json({ message: 'Logout failed' });
    }
    // Clears the session cookie
    res.clearCookie('connect.sid'); // Use the default session cookie name or the one you configured
    res.status(200).json({ message: 'Logged out successfully' });
  });
};
