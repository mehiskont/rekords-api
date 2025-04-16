const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const axios = require('axios'); // Using axios for HTTP requests
const prisma = require('../lib/prisma');
const bcrypt = require('bcrypt'); // Import bcrypt

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

// POST /api/auth/register
exports.registerUser = async (req, res, next) => {
  const { name, email, password } = req.body;

  // Basic input validation
  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are required' });
  }

  if (password.length < 8) { // Example: enforce minimum password length
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
  }

  try {
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(409).json({ message: 'Email already in use' }); // 409 Conflict
    }

    // Hash the password
    const saltRounds = 10; // Recommended salt rounds
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create the new user
    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: hashedPassword, // Use the correct field name: passwordHash
        // Initialize other fields as needed (e.g., roles, profile info)
      },
      // Select only non-sensitive fields to return
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        updatedAt: true,
        // Exclude password hash
      }
    });

    // Respond with the created user (excluding password)
    // Consider logging the user in automatically here by setting up the session
    // similar to mockLogin, if desired.
    console.log(`User created successfully: ${newUser.email} (ID: ${newUser.id})`);
    res.status(201).json(newUser); // 201 Created

  } catch (error) {
    console.error('Registration error:', error);
    // Check for Prisma-specific errors if needed, e.g., validation errors
    // if (error instanceof Prisma.PrismaClientKnownRequestError) { ... }
    res.status(500).json({ message: 'An error occurred during registration' });
    // next(error); // Pass to error handling middleware if you have one
  }
};

// POST /api/auth/login
exports.loginUser = async (req, res, next) => {
  const { email, password } = req.body;
  console.log('Login attempt:', { email, hasPassword: !!password });
  console.log('Session before login:', req.session);

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email },
    });

    console.log('User found:', user ? { id: user.id, hasPasswordHash: !!user.passwordHash } : 'null');

    // Check if user exists and if they have a password hash (meaning they registered via email/pass)
    if (!user || !user.passwordHash) {
      // Generic error for security (don't reveal if email exists or not)
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Compare the provided password with the stored hash
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    console.log('Password match:', isMatch);

    if (!isMatch) {
      // Passwords don't match
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Password is correct, login successful
    // Regenerate session to prevent session fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error('Error regenerating session during login:', err);
        return res.status(500).json({ message: 'Login failed due to server error' });
      }

      // Store user ID in session
      req.session.userId = user.id;
      console.log(`User ${user.id} logged in via password. Session ID: ${req.session.id}`);
      console.log('Session after regenerate:', req.session);

      // Save the session before responding
      req.session.save((saveErr) => {
        if (saveErr) {
            console.error('Error saving session during login:', saveErr);
            return res.status(500).json({ message: 'Login failed due to server error' });
        }
        console.log('Session saved successfully, cookie details:', {
          name: 'connect.sid', // Default session cookie name
          options: req.session.cookie // Log cookie options
        });
        
        // Respond with success and user data (excluding sensitive fields)
        res.status(200).json({
          message: 'Logged in successfully',
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            // Add any other non-sensitive fields you want to return
          },
          shouldMergeCart: true // Flag to trigger cart merge in frontend
        });
      });
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'An error occurred during login' });
    // next(error);
  }
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
        res.status(200).json({
          message: 'Logged in successfully',
          userId: user.id,
          shouldMergeCart: true // Flag to trigger cart merge in frontend
        });
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
  // Check if session exists
  if (!req.session) {
    console.log('Logout called but no session exists');
    return res.status(200).json({ message: 'Already logged out' });
  }
  
  // Log the session before destroying
  console.log('Logout: Destroying session', { 
    sessionId: req.session.id,
    userId: req.session.userId
  });
  
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).json({ message: 'Logout failed' });
    }
    
    // Clear the session cookie with same settings as used to create it
    res.clearCookie('connect.sid', {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    });
    
    console.log('Session successfully destroyed and cookie cleared');
    res.status(200).json({ message: 'Logged out successfully' });
  });
};

// GET /api/auth/session
// Check if user is authenticated - for NextAuth compatibility
exports.getSession = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    // No active session
    return res.status(200).json(null);
  }
  
  try {
    // Fetch current user info
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
      select: {
        id: true,
        name: true,
        email: true,
      }
    });
    
    if (!user) {
      // User not found in database
      console.log('Session referenced non-existent user - clearing session');
      req.session.destroy();
      return res.status(200).json(null);
    }
    
    // Return session info in NextAuth format
    return res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      },
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
    });
    
  } catch (error) {
    console.error('Error fetching session data:', error);
    return res.status(500).json({ error: 'Failed to get session data' });
  }
};

// POST /api/auth/nextauth-callback
// Special endpoint to support NextAuth.js credentials provider
exports.nextauthCallback = async (req, res, next) => {
  const { email, password } = req.body;
  console.log('NextAuth callback received:', { email, hasPassword: !!password });
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  
  try {
    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
      }
    });
    
    // Check if user exists
    if (!user || !user.passwordHash) {
      console.log('NextAuth: User not found or no password hash');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Verify password
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      console.log('NextAuth: Password mismatch');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Create session same as login endpoint
    req.session.regenerate((err) => {
      if (err) {
        console.error('NextAuth: Error regenerating session:', err);
        return res.status(500).json({ error: 'Authentication failed' });
      }
      
      // Store user ID in session
      req.session.userId = user.id;
      
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('NextAuth: Error saving session:', saveErr);
          return res.status(500).json({ error: 'Authentication failed' });
        }
        
        // Return user data in the format NextAuth expects with cart merge flag
        res.status(200).json({
          id: user.id,
          name: user.name || email.split('@')[0],
          email: user.email,
          shouldMergeCart: true // Flag to trigger cart merge in frontend
        });
      });
    });
    
  } catch (error) {
    console.error('NextAuth callback error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};
