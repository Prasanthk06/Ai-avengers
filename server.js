const express = require('express');
const { connectDB } = require('./database');
const path = require('path');
const client = require('./bot');
require('dotenv').config();
const session = require('express-session');
const bcrypt = require('bcrypt');
const { User, Media } = require('./database');
const nodemailer = require('nodemailer');
const fs = require('fs');

// Use either native fetch (Node.js 18+) or node-fetch for older versions
let fetch;
try {
    fetch = globalThis.fetch; // Use native fetch if available (Node.js 18+)
    if (!fetch) throw new Error('Native fetch not available');
} catch (e) {
    // Fallback to require - this will throw an error if node-fetch is not installed
    // but that's better than silently failing
    try {
        console.log('Native fetch not available, attempting to use node-fetch');
        fetch = require('node-fetch');
    } catch (err) {
        console.warn('Warning: Neither native fetch nor node-fetch available. Self-ping will be disabled.');
        fetch = () => Promise.resolve(); // Dummy function that does nothing
    }
}

const app = express();
app.set('view engine','ejs')
app.use(express.json());
app.use(express.static(path.join(__dirname,"public")));
// Connect to MongoDB
connectDB();

// Add session handling

app.use(session({
    secret: process.env.SESSION_SECRET || 'abcdefghijklmnopq',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
        httpOnly: true,
        sameSite: 'lax'
    }
}));

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASSWORD
    }
});

// Add a cleanup middleware to reduce memory leaks
app.use((req, res, next) => {
    // Clean up expired sessions from memory store every 100 requests
    if (Math.random() < 0.01) { // 1% chance on each request
        console.log('Running session store cleanup');
        // The memory store doesn't have a built-in cleanup, but we can nudge garbage collection
        if (global.gc) {
            global.gc();
        }
    }
    next();
});

// Basic routes

// Protected route middleware
const requireAuth = (req, res, next) => {
    console.log('Auth check - Session:', req.session);
    console.log('Auth check - User ID:', req.session.userId);
    
    if (!req.session.userId) {
        console.log('Auth failed - redirecting to login');
        return res.redirect('/login');
    }
    console.log('Auth passed for user ID:', req.session.userId);
    next();
};

// Modify the admin route middleware to reduce excessive checks
const requireAdmin = (req, res, next) => {
    // Skip verbose logging for status check routes
    const isStatusCheck = req.path === '/whatsapp-status' || 
                         req.path.includes('/status') || 
                         req.originalUrl.includes('/status');
    
    if (!req.session.userId) {
        if (!isStatusCheck) console.log('Admin check failed - no session - redirecting to login');
        return res.redirect('/login');
    }
    
    // Cache admin status in session to reduce DB queries
    if (req.session.isAdmin === true) {
        // Already verified as admin, skip DB check
        if (!isStatusCheck) console.log('Admin check passed - using cached status');
        return next();
    }
    
    User.findById(req.session.userId)
        .then(user => {
            if (!isStatusCheck) console.log('Admin check - User found:', user ? user.isAdmin : 'No user');
            
            if (!user || !user.isAdmin) {
                if (!isStatusCheck) console.log('Admin check failed - not an admin');
                return res.status(403).send('Access denied');
            }
            
            // Cache the admin status in session
            req.session.isAdmin = true;
            
            if (!isStatusCheck) console.log('Admin check passed for user:', user.email);
            next();
        })
        .catch(err => {
            console.error('Admin check error:', err);
            res.status(500).send('Server error');
        });
};

// Modify the WhatsApp status route
app.get('/whatsapp-status', requireAdmin, (req, res) => {
    // Check if we have a cached status and it's recent (less than 10 seconds old)
    if (global.cachedWhatsAppStatus && 
        (Date.now() - global.cachedWhatsAppStatus.timestamp < 10000)) {
        return res.json(global.cachedWhatsAppStatus);
    }
    
    // Get current time to ensure fresh status
    const now = new Date();
    
    // Build status response object
    const status = {
        isAuthenticated: client.info ? true : false,
        info: client.info || null,
        lastQrTimestamp: global.lastQrTimestamp || null,
        qrAvailable: global.lastQrTimestamp ? true : false,
        timestamp: now.toISOString() // Add timestamp for debugging
    };
    
    // Check if QR code file exists and get its stats
    const qrPath = path.join(process.cwd(), 'public', 'latest-qr.png');
    try {
        if (fs.existsSync(qrPath)) {
            const stats = fs.statSync(qrPath);
            status.qrFileExists = true;
            status.qrFileSize = stats.size;
            status.qrFileTime = stats.mtime.toISOString();
        } else {
            status.qrFileExists = false;
        }
    } catch (error) {
        status.qrFileExists = false;
        status.qrFileError = error.message;
    }
    
    // Cache the status
    global.cachedWhatsAppStatus = {
        ...status,
        timestamp: Date.now() // Add cache timestamp
    };
    
    res.json(status);
});

// WhatsApp QR code admin page
app.get('/admin/whatsapp', requireAdmin, (req, res) => {
    res.render('whatsapp-admin', { 
        lastQrTimestamp: global.lastQrTimestamp || null
    });
});

// Add this utility function at an appropriate place (before the routes)
const safeClientOperation = async (res, operation) => {
    try {
        await operation();
    } catch (error) {
        console.error('WhatsApp client operation error:', error);
        // Avoid hanging the response
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: 'An error occurred with the WhatsApp client: ' + error.message
            });
        }
    }
};

// Modify the /admin/whatsapp/restart route (if it exists)
app.post('/admin/whatsapp/restart', requireAdmin, (req, res) => {
    console.log('Admin requested WhatsApp client restart');
    
    // Send response immediately to prevent timeouts
    res.json({
        success: true,
        message: 'WhatsApp client restart initiated. This may take a minute to complete.'
    });
    
    // Run the operation asynchronously
    safeClientOperation(res, async () => {
        try {
            await client.destroy();
            console.log('Client destroyed, waiting before restarting...');
            
            // Wait before restarting
            await new Promise(r => setTimeout(r, 5000));
            
            await client.initialize();
            console.log('Client restarted successfully');
        } catch (error) {
            console.error('Error during client restart:', error);
            // No need to send response here as we already sent it
        }
    });
});

// Replace the /admin/whatsapp/regenerate-qr route with this more robust version
app.post('/admin/whatsapp/regenerate-qr', requireAdmin, (req, res) => {
    console.log('Admin requested QR code regeneration');
    
    // Send response immediately to prevent timeout
    res.json({
        success: true,
        message: 'QR regeneration requested. Please wait 1 minute and then refresh the page.'
    });
    
    // Execute in separate context to avoid request handling issues
    setTimeout(async () => {
        try {
            console.log('Starting QR regeneration process...');
            
            // Reset QR generation throttling if exists
            if (global.lastQrGeneration) global.lastQrGeneration = 0;
            if (global.qrRegenerationCount) global.qrRegenerationCount = 0;
            
            // Clear the QR timestamp so we know we need a new one
            global.lastQrTimestamp = null;
            
            let browserClosedManually = false;
            
            // Check if puppeteer browser exists and try to close it safely
            if (client.pupBrowser) {
                try {
                    console.log('Attempting to close Puppeteer browser...');
                    const pages = await client.pupBrowser.pages().catch(() => []);
                    for (const page of pages) {
                        try {
                            await page.close().catch(() => {});
                        } catch (e) {
                            console.log('Error closing page:', e.message);
                        }
                    }
                    await client.pupBrowser.close().catch(() => {});
                    browserClosedManually = true;
                    console.log('Browser closed manually');
                } catch (error) {
                    console.log('Error closing browser:', error.message);
                }
            }
            
            // If we couldn't close the browser properly, try to destroy the client
            if (!browserClosedManually && client.pupBrowser) {
                try {
                    console.log('Attempting to destroy WhatsApp client...');
                    await client.destroy().catch(e => console.log('Destroy error:', e.message));
                    console.log('Client destroyed');
                } catch (error) {
                    console.log('Failed to destroy client:', error.message);
                }
            }
            
            // Wait a significant amount of time to ensure resources are freed
            console.log('Waiting 15 seconds before reinitializing...');
            await new Promise(resolve => setTimeout(resolve, 15000));
            
            // Delete the QR file if it exists to ensure we generate a new one
            try {
                const qrPath = path.join(__dirname, 'public', 'latest-qr.png');
                if (fs.existsSync(qrPath)) {
                    fs.unlinkSync(qrPath);
                    console.log('Deleted existing QR code file');
                }
            } catch (err) {
                console.log('Error deleting QR file:', err.message);
            }
            
            // Force garbage collection if available
            if (global.gc) {
                try {
                    global.gc();
                    console.log('Forced garbage collection');
                } catch (e) {
                    console.log('GC error:', e.message);
                }
            }
            
            // Initialize the client with a large timeout
            console.log('Reinitializing WhatsApp client...');
            try {
                await client.initialize();
                console.log('Client reinitialized successfully');
            } catch (initError) {
                console.error('Failed to initialize client:', initError.message);
                
                // If initialization fails, we need to handle it gracefully
                console.log('Attempting recovery from failed initialization...');
                
                // Wait before trying again
                await new Promise(resolve => setTimeout(resolve, 10000));
                
                try {
                    // Create a new client instance as a last resort
                    console.log('Creating a new client instance...');
                    const { Client, LocalAuth } = require('whatsapp-web.js');
                    
                    // Use the existing client configuration but with even more conservative settings
                    client = new Client({
                        authStrategy: new LocalAuth({
                            clientId: "main-whatsapp-client",
                            dataPath: path.join(process.cwd(), '.wwebjs_auth')
                        }),
                        puppeteer: {
                            headless: 'new',
                            args: [
                                '--no-sandbox',
                                '--disable-setuid-sandbox',
                                '--disable-gpu',
                                '--disable-dev-shm-usage'
                            ],
                            defaultViewport: null,
                            timeout: 180000 // 3 minutes
                        }
                    });
                    
                    // Initialize the new client
                    await client.initialize();
                    console.log('New client instance initialized');
                } catch (recoveryError) {
                    console.error('Recovery failed:', recoveryError.message);
                }
            }
        } catch (outerError) {
            console.error('Outer error in QR regeneration:', outerError);
        }
    }, 1000); // Start the process after 1 second
});

// WhatsApp connection troubleshooting route
app.post('/whatsapp-reconnect', requireAdmin, async (req, res) => {
    console.log('WhatsApp reconnection requested by admin');
    
    // Check if there was a recent reconnection request
    if (global.lastReconnectTime && (Date.now() - global.lastReconnectTime < 5 * 60 * 1000)) {
        return res.json({
            success: false,
            message: `Please wait at least 5 minutes between reconnection attempts. Last attempt was ${Math.round((Date.now() - global.lastReconnectTime) / 1000 / 60)} minutes ago.`
        });
    }
    
    // Set last reconnect time
    global.lastReconnectTime = Date.now();
    
    try {
        // Send response immediately to prevent timeout
        res.json({ 
            success: true, 
            message: 'Reconnection process started. This will take up to 60 seconds. Refresh this page after 1 minute to see the new status.'
        });
        
        // Get current state safely
        let state = 'Unknown';
        try {
            if (client.pupPage && !client.pupPage.isClosed()) {
                state = await client.getState().catch(e => 'Error: ' + e.message);
            }
            console.log(`Current WhatsApp state before reconnect: ${state}`);
        } catch (stateError) {
            console.log('Error getting state:', stateError.message);
        }
        
        // Force client destroy with error handling
        console.log('Destroying WhatsApp client...');
        try {
            if (client.pupBrowser || client.pupPage) {
                await client.destroy().catch(e => console.log('Destroy error:', e.message));
            }
        } catch (destroyError) {
            console.log('Error during destroy operation:', destroyError.message);
            // If destroy fails, attempt to force close the browser
            if (client.pupBrowser) {
                await client.pupBrowser.close().catch(e => console.log('Browser close error:', e.message));
            }
        }
        
        console.log('Client destroyed, waiting 20 seconds...');
        
        // Longer delay before reinitialization
        await new Promise(r => setTimeout(r, 20000));
        
        // Clear any QR throttling
        if (typeof client.qrRegenerationCount !== 'undefined') {
            client.qrRegenerationCount = 0;
        }
        if (typeof client.lastQrGeneration !== 'undefined') {
            client.lastQrGeneration = 0;
        }
        
        // Initialize again
        console.log('Reinitializing WhatsApp client...');
        await client.initialize().catch(error => {
            console.error('Client initialization error:', error.message);
        });
        
        console.log('WhatsApp reconnection process completed');
    } catch (error) {
        console.error('Error during WhatsApp reconnection process:', error);
    }
});

app.get('/', (req, res) => {
    res.render('landing');
});

app.get('/login',(req,res)=>
{
    res.render('login');
})

app.post('/login', async (req, res) => {
    const { email, uniqueCode } = req.body;
    
    console.log('Login attempt:', { email, uniqueCodeProvided: !!uniqueCode });
    
    try {
        const user = await User.findOne({ email, uniqueCode });
        
        if (!user) {
            console.log('User not found with provided credentials');
            return res.json({ success: false, message: 'Invalid credentials' });
        }

        console.log('User found:', { id: user._id, name: user.name, isVerified: user.isVerified });

        req.session.user = {
            username: user.name,
        };
        
        if (!user.isVerified) {
            console.log('User not verified');
            return res.json({ success: false, message: 'Please verify your WhatsApp first' });
        }
        
        // Set session data
        req.session.userId = user._id;
        
        // Save session explicitly before responding
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.json({ success: false, message: 'Session error. Please try again.' });
            }
            
            console.log('Login successful, session saved:', req.session.userId);
            res.json({ success: true, message: 'Login successful', redirectUrl: '/dashboard' });
        });
    } catch (error) {
        console.error('Login error:', error);
        res.json({ success: false, message: 'Login failed due to server error' });
    }
});

app.post('/signup', async (req, res) => {
    const { username, email } = req.body;
    const uniqueCode = Math.random().toString(36).substring(7);
    
    try {
        // Check if email already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.json({ 
                success: false, 
                message: 'This email is already registered' 
            });
        }

        const user = await User.create({
            username,
            email,
            uniqueCode,
            isVerified: false
        });
        
        res.json({ 
            success: true, 
            message: 'Registration successful! Use this code to verify on WhatsApp:', 
            code: uniqueCode 
        });
    } catch (error) {
        res.json({ 
            success: false, 
            message: 'Registration failed. Please try again.' 
        });
    }
});


app.post('/forgot-unique-code', async (req, res) => {
    const { email } = req.body;

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.json({ success: false, message: 'Email not found' });
        }

        const mailOptions = {
            from: process.env.EMAIL,
            to: email,
            subject: 'Your Unique Code',
            text: `Your unique code is: ${user.uniqueCode}`
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.log('Email error:', error);
                return res.json({ success: false, message: 'Failed to send email' });
            }
            console.log('Email sent:', info);
            res.json({ success: true, message: 'Unique code sent to your email' });
        });
    } catch (error) {
        res.json({ success: false, message: 'Failed to retrieve unique code' });
    }
});


app.get('/user-files', requireAuth, async (req, res) => {
    try {
        const { category, search, sort } = req.query;
        const query = { userId: req.session.userId };
        
        if (category) {
            query.category = category;
        }
        
        if (search) {
            query.$or = [
                { keywords: { $regex: search, $options: 'i' } },
                { 'metadata.subject': { $regex: search, $options: 'i' } }
            ];
        }
        
        const sortOrder = sort === 'old' ? 1 : -1;
        
        const files = await Media.find(query)
            .sort({ timestamp: sortOrder })
            .limit(20);
            
        res.json(files);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch files' });
    }
});




// Add this route to get user's categories
app.get('/user-categories', requireAuth, async (req, res) => {
    try {
        const categories = await Media.distinct('category', { userId: req.session.userId });
        res.json(categories);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});




// Protected routes
// Modify the dashboard route to include user data
app.get('/dashboard', requireAuth, async (req, res) => {
    const user = await User.findById(req.session.userId);
    const userFiles = await Media.find({ userId: req.session.userId });
    const categories = [...new Set(userFiles.map(file => file.category))];
   

    res.render('dashboard', {
        username: user.name,  // Use this instead
        email: user.email,
        categories: categories
    });
});


// Get user's media by category
app.get('/media/:userId/:category', async (req, res) => {
    try {
        const { Media } = require('./database');
        const media = await Media.find({
            userId: req.params.userId,
            category: req.params.category
        });
        res.json(media);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.redirect('/login');
      }
      res.clearCookie('connect.sid'); 
      res.redirect('/');
    });
  });


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Setup to prevent Railway container hibernation
const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes (just under Railway's 15-minute inactivity limit)
function pingServer() {
    try {
        console.log(`[${new Date().toISOString()}] Self-ping to prevent hibernation`);
        // This keeps the process alive even when no external requests are coming in
        fetch(`https://${process.env.RAILWAY_STATIC_URL || 'localhost:3000'}/health-check`)
            .catch(e => {/* Ignore fetch errors */});
    } catch (err) {
        // Ignore all errors
    }
}

// Add this at the end of your file (after app.listen)
// Add a health check endpoint that doesn't require authentication
app.get('/health-check', (req, res) => {
    res.status(200).send('OK');
});

// Start the self-ping interval
const pingInterval = setInterval(pingServer, PING_INTERVAL);
pingServer(); // Initial ping

// Ensure clean shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, cleaning up...');
    clearInterval(pingInterval);
    
    // Give pending operations 5 seconds to complete before exiting
    setTimeout(() => {
        process.exit(0);
    }, 5000);
});
