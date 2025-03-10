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

// Improve the WhatsApp status route with better error handling
app.get('/whatsapp-status', requireAdmin, (req, res) => {
    // Set JSON content type upfront
    res.setHeader('Content-Type', 'application/json');
    
    try {
        // Check if we have a cached status and it's recent (less than 10 seconds old)
        if (global.cachedWhatsAppStatus && 
            (Date.now() - global.cachedWhatsAppStatus.timestamp < 10000)) {
            return res.json(global.cachedWhatsAppStatus);
        }
        
        // Get current time to ensure fresh status
        const now = new Date();
        let clientInfo = null;
        let isAuthenticated = false;
        
        // Safely check client info
        try {
            if (client && client.info) {
                isAuthenticated = true;
                clientInfo = {
                    pushname: client.info.pushname || '',
                    platform: client.info.platform || '',
                    wid: client.info.wid ? client.info.wid._serialized : ''
                };
            }
        } catch (clientError) {
            console.error('Error accessing client info:', clientError.message);
        }
        
        // Build status response object
        const status = {
            isAuthenticated: isAuthenticated,
            info: clientInfo,
            lastQrTimestamp: global.lastQrTimestamp || null,
            qrAvailable: global.lastQrTimestamp ? true : false,
            timestamp: now.toISOString(), // Add timestamp for debugging
            serverTime: Date.now()
        };
        
        // Check if QR code file exists and get its stats
        let qrStatus = { qrFileExists: false };
        try {
            const qrPath = path.join(process.cwd(), 'public', 'latest-qr.png');
            if (fs.existsSync(qrPath)) {
                const stats = fs.statSync(qrPath);
                qrStatus.qrFileExists = true;
                qrStatus.qrFileSize = stats.size;
                qrStatus.qrFileTime = stats.mtime.toISOString();
            }
        } catch (error) {
            qrStatus.qrFileError = error.message;
        }
        
        // Merge QR status with main status
        const fullStatus = { ...status, ...qrStatus };
        
        // Cache the status
        global.cachedWhatsAppStatus = {
            ...fullStatus,
            timestamp: Date.now() // Add cache timestamp
        };
        
        // Return the status as JSON
        return res.json(fullStatus);
        
    } catch (error) {
        // If any error occurs, still return a valid JSON response
        console.error('Error generating status response:', error);
        return res.json({
            error: true,
            message: 'Error generating status: ' + error.message,
            timestamp: new Date().toISOString(),
            serverTime: Date.now()
        });
    }
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

// Replace the QR regeneration route with this crash-proof version
app.post('/admin/whatsapp/regenerate-qr', requireAdmin, (req, res) => {
    console.log('Admin requested QR code regeneration');
    
    // Send response immediately to prevent timeout
    res.json({
        success: true,
        message: 'QR regeneration requested. The server will restart WhatsApp services. Please wait 60 seconds and then refresh the page.'
    });
    
    // Execute in separate context with error boundaries
    setTimeout(async () => {
        // Wrap everything in try/catch to prevent process crashes
        try {
            console.log('Starting QR regeneration process...');
            
            // Reset global state
            if (global.lastQrGeneration) global.lastQrGeneration = 0;
            if (global.qrRegenerationCount) global.qrRegenerationCount = 0;
            global.lastQrTimestamp = null;
            
            // Track what we've attempted for better error recovery
            let browserClosed = false;
            let clientDestroyed = false;
            
            // Safely destroy the WhatsApp client
            try {
                console.log('Attempting to safely destroy WhatsApp client...');
                
                // Safely handle browser closing
                if (client.pupBrowser) {
                    try {
                        console.log('Closing Puppeteer browser...');
                        const pages = await client.pupBrowser.pages().catch(() => []);
                        
                        // Close any open pages
                        for (const page of pages) {
                            try {
                                await page.close().catch(() => {});
                            } catch (e) {
                                console.log('Page close error (non-fatal):', e.message);
                            }
                        }
                        
                        // Attempt to close browser
                        try {
                            await client.pupBrowser.close().catch(() => {});
                            browserClosed = true;
                            console.log('Browser closed successfully');
                        } catch (e) {
                            console.log('Browser close error (non-fatal):', e.message);
                        }
                    } catch (error) {
                        console.log('Error accessing browser (non-fatal):', error.message);
                    }
                }
                
                // Wait a moment before destroy (racing condition protection)
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Try to destroy client if browser close failed or wasn't attempted
                if (!browserClosed) {
                    try {
                        await client.destroy().catch(e => {
                            console.log('Client destroy error (non-fatal):', e.message);
                        });
                        clientDestroyed = true;
                        console.log('Client destroyed successfully');
                    } catch (error) {
                        console.log('Failed to destroy client (non-fatal):', error.message);
                    }
                } else {
                    clientDestroyed = true; // If browser closed, consider client destroyed
                }
            } catch (outerError) {
                console.error('Error during client cleanup (non-fatal):', outerError.message);
            }
            
            // Wait to ensure everything is properly cleaned up
            console.log('Waiting for 15 seconds before reinitializing...');
            await new Promise(resolve => setTimeout(resolve, 15000));
            
            // Delete the QR file if it exists
            try {
                const qrPath = path.join(__dirname, 'public', 'latest-qr.png');
                if (fs.existsSync(qrPath)) {
                    fs.unlinkSync(qrPath);
                    console.log('Deleted existing QR code file');
                }
            } catch (err) {
                console.log('Error deleting QR file (non-fatal):', err.message);
            }
            
            // Force garbage collection if available
            if (global.gc) {
                try {
                    global.gc();
                    console.log('Garbage collection completed');
                } catch (e) {
                    console.log('GC error (non-fatal):', e.message);
                }
            }
            
            // If we couldn't properly destroy things, we'll need to restart the server
            // But first, let's try to initialize as a last resort
            if (browserClosed || clientDestroyed) {
                console.log('Client cleanup successful, attempting to initialize...');
                
                try {
                    // Ensure null references to prevent errors
                    if (!client.pupBrowser && !client.pupPage) {
                        await client.initialize().catch(e => {
                            console.error('Client initialization error (attempting recovery):', e.message);
                            throw e; // Rethrow for outer catch
                        });
                        console.log('Client initialized successfully');
                    } else {
                        console.error('Client has browser/page references but should be destroyed, cannot initialize safely');
                        throw new Error('Client not properly destroyed');
                    }
                } catch (initError) {
                    // If initialization fails, suggest server restart
                    console.error('Failed to initialize WhatsApp client, server restart may be required:', initError.message);
                }
            } else {
                console.error('Failed to properly clean up WhatsApp client, server restart recommended');
            }
        } catch (outerError) {
            console.error('Outer error in QR regeneration (non-fatal):', outerError.message);
        }
    }, 1000);
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

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
    console.error('UNCAUGHT EXCEPTION - keeping process alive:', error);
    
    // If it's a Puppeteer Protocol error, it's likely from WhatsApp Web
    if (error.message && error.message.includes('Protocol error')) {
        console.log('WhatsApp/Puppeteer protocol error detected - will recover automatically');
        
        // Try to reset WhatsApp client if possible in next tick
        process.nextTick(() => {
            try {
                if (client && client.pupBrowser) {
                    console.log('Attempting emergency browser reset...');
                    client.pupBrowser.close().catch(() => {});
                }
            } catch (e) {
                console.log('Failed emergency reset:', e.message);
            }
        });
    }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Promise Rejection at:', promise, 'reason:', reason);
    // No need to crash the server for promise rejections
});

// Add this middleware after app is defined but before any routes
// Add JSON error handling middleware
app.use((req, res, next) => {
    // Only apply to API and status routes
    const isApiRoute = req.path.startsWith('/api/') || 
                      req.path.includes('status') ||
                      req.path.includes('whatsapp');
    
    // Save original res.status to use later
    const originalStatus = res.status;
    
    // Override res.status for API routes
    if (isApiRoute) {
        // Replace res.status to ensure it returns valid JSON
        res.status = function(code) {
            // Call the original method
            originalStatus.call(this, code);
            
            // For error codes, ensure we return JSON
            if (code >= 400) {
                res.setHeader('Content-Type', 'application/json');
                
                // Attach a send method to ensure JSON response
                const originalSend = this.send;
                this.send = function(data) {
                    let jsonResponse;
                    
                    try {
                        // Check if data is already JSON
                        if (typeof data === 'object') {
                            jsonResponse = data;
                        } else {
                            // Convert to JSON error response
                            jsonResponse = { 
                                error: true, 
                                status: code,
                                message: data || 'An error occurred',
                                timestamp: new Date().toISOString()
                            };
                        }
                        
                        // Send as JSON
                        return originalSend.call(this, jsonResponse);
                        
                    } catch (err) {
                        // If anything fails, ensure we still send valid JSON
                        return originalSend.call(this, { 
                            error: true, 
                            status: 500,
                            message: 'Internal Server Error',
                            timestamp: new Date().toISOString()
                        });
                    }
                };
            }
            
            return this;
        };
    }
    
    next();
});

// Add this route after the other WhatsApp routes
// Complete WhatsApp reset route (emergency use only)
app.post('/admin/whatsapp/complete-reset', requireAdmin, (req, res) => {
    console.log('Admin requested COMPLETE WhatsApp reset - this is a nuclear option');
    
    // Send response immediately
    res.json({
        success: true,
        message: 'Complete WhatsApp reset initiated. This will take up to 2 minutes and will restart the entire WhatsApp system.'
    });
    
    // Execute outside the request-response cycle
    setTimeout(async () => {
        try {
            console.log('Starting complete WhatsApp client reset...');
            
            // Store reference to the old client first
            const oldClient = global.client || client;
            
            // 1. First try normal cleanup
            console.log('Attempting graceful cleanup first...');
            try {
                if (oldClient) {
                    // Try to close the browser directly
                    if (oldClient.pupBrowser) {
                        try {
                            await oldClient.pupBrowser.close().catch(() => {});
                        } catch (e) {
                            console.log('Browser close error (non-fatal):', e.message);
                        }
                    }
                    
                    // Try to destroy the client
                    try {
                        await oldClient.destroy().catch(() => {});
                        console.log('Safe destroy called');
                    } catch (e) {
                        console.log('Client destroy error (non-fatal):', e.message);
                    }
                }
            } catch (err) {
                console.log('Protocol error detected, trying alternative initialization...', err.message);
            }
            
            // 2. Manually clear all references
            console.log('Forcefully clearing all WhatsApp client references...');
            try {
                if (oldClient) {
                    // Nullify all properties that might hold references
                    if (oldClient.pupBrowser) oldClient.pupBrowser = null;
                    if (oldClient.pupPage) oldClient.pupPage = null;
                    if (oldClient.authStrategy) {
                        oldClient.authStrategy.client = null;
                    }
                    
                    // Clear any event listeners
                    if (typeof oldClient.removeAllListeners === 'function') {
                        oldClient.removeAllListeners();
                    }
                }
                
                // Clear global references
                global.client = null;
                
                // Try to clear require cache for the bot module
                try {
                    const botModulePath = require.resolve('./bot');
                    if (require.cache[botModulePath]) {
                        delete require.cache[botModulePath];
                        console.log('Cleared bot.js module from require cache');
                    }
                } catch (cacheError) {
                    console.log('Error clearing module cache (non-fatal):', cacheError.message);
                }
            } catch (e) {
                console.log('Error clearing references (non-fatal):', e.message);
            }
            
            // 3. Clean up old session files
            console.log('Cleaning up WhatsApp session files...');
            try {
                const authPath = path.join(process.cwd(), '.wwebjs_auth');
                const sessionPath = path.join(authPath, 'session-client-one');
                
                // Delete QR file
                const qrPath = path.join(process.cwd(), 'public', 'latest-qr.png');
                if (fs.existsSync(qrPath)) {
                    fs.unlinkSync(qrPath);
                    console.log('Deleted QR code file');
                }
                
                // Don't delete the entire session to preserve login, but clean temporary files
                if (fs.existsSync(sessionPath)) {
                    const tempFiles = ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 
                                      'Default/Service Worker', 'Default/Session Storage'];
                    
                    for (const tempDir of tempFiles) {
                        const fullPath = path.join(sessionPath, tempDir);
                        if (fs.existsSync(fullPath)) {
                            try {
                                // Use rm with recursive option for directories
                                fs.rmSync(fullPath, { recursive: true, force: true });
                                console.log(`Cleaned up ${tempDir}`);
                            } catch (e) {
                                console.log(`Failed to clean ${tempDir}:`, e.message);
                            }
                        }
                    }
                }
            } catch (err) {
                console.log('Session cleanup error (non-fatal):', err.message);
            }
            
            // 4. Force garbage collection
            if (global.gc) {
                try {
                    global.gc();
                    console.log('Forced garbage collection');
                } catch (e) {
                    console.log('GC error (non-fatal):', e.message);
                }
            }
            
            // 5. Wait for all resources to be fully released
            console.log('Waiting 20 seconds for full resource release...');
            await new Promise(resolve => setTimeout(resolve, 20000));
            
            // 6. Create a completely new client instance with clean state
            console.log('Recreating WhatsApp client with clean state...');
            try {
                // Re-require the dependencies to ensure fresh instances
                const { Client, LocalAuth } = require('whatsapp-web.js');
                const qrcode = require('qrcode-terminal');
                
                // Define auth before using it to avoid the null error
                const authStrategy = new LocalAuth({
                    clientId: "client-one",
                    dataPath: path.join(process.cwd(), '.wwebjs_auth')
                });
                
                // Create new client with very basic settings
                const newClient = new Client({
                    authStrategy: authStrategy,
                    puppeteer: {
                        headless: 'new',
                        args: [
                            '--no-sandbox',
                            '--disable-setuid-sandbox',
                            '--disable-gpu',
                            '--disable-dev-shm-usage',
                            '--disable-web-security',
                            '--no-default-browser-check', 
                            '--no-first-run'
                        ]
                    }
                });
                
                // Set to global scope
                global.client = newClient;
                
                // Load the bot module to access its functions
                const botModule = require('./bot');
                
                // Set up event handlers using the bot's function
                if (typeof botModule.setupClientEventHandlers === 'function') {
                    botModule.setupClientEventHandlers(newClient);
                    console.log('Client event handlers set up successfully');
                } else {
                    // Fallback to basic event handlers if function not available
                    newClient.on('qr', (qr) => {
                        try {
                            qrcode.generate(qr, { small: true });
                            console.log('QR Code generated! Scan it with your WhatsApp');
                            
                            // Save QR code to file
                            try {
                                const qrPath = path.join(process.cwd(), 'public', 'latest-qr.png');
                                const qrCode = require('qr-image');
                                const qrImg = qrCode.image(qr, { type: 'png' });
                                const qrStream = fs.createWriteStream(qrPath);
                                
                                qrImg.pipe(qrStream);
                                
                                // Set timestamp when ready
                                qrStream.on('finish', () => {
                                    // Update global timestamp
                                    global.lastQrTimestamp = new Date().toISOString();
                                    console.log('QR Code saved to file after complete reset at:', global.lastQrTimestamp);
                                });
                                
                                qrStream.on('error', (e) => {
                                    console.log('Error saving QR file:', e.message);
                                });
                            } catch (qrError) {
                                console.log('Error creating QR file:', qrError.message);
                            }
                        } catch (e) {
                            console.log('QR code generation error:', e.message);
                        }
                    });
                    
                    newClient.on('ready', () => {
                        console.log('Client is ready after complete reset!');
                    });
                    
                    newClient.on('disconnected', (reason) => {
                        console.log('Client disconnected after reset:', reason);
                    });
                }
                
                // Initialize the client
                console.log('Initializing new WhatsApp client...');
                await newClient.initialize();
                console.log('WhatsApp client successfully reinitialized with clean state');
                
                // Update the exported module without reassigning the constant
                // This makes the new client available throughout the application
                try {
                    if (typeof botModule.updateClient === 'function') {
                        botModule.updateClient(newClient);
                        console.log('Successfully updated client reference in bot.js');
                    } else {
                        console.log('Warning: updateClient function not found in bot.js');
                        console.log('IMPORTANT: Server restart may be required to fully apply changes');
                    }
                } catch (moduleErr) {
                    console.log('Error updating module exports:', moduleErr.message);
                    console.log('IMPORTANT: Server restart may be required to fully apply changes');
                }
                
            } catch (recreateError) {
                console.error('Failed to recreate WhatsApp client:', recreateError);
                console.log('IMPORTANT: Server restart may be required to recover WhatsApp functionality');
                
                // Create a restart script as fallback
                try {
                    // Create a restart script in the root directory
                    const restartScriptPath = path.join(process.cwd(), 'restart-whatsapp.sh');
                    const isWindows = process.platform === 'win32';
                    
                    if (isWindows) {
                        // Windows batch script
                        const batchContent = `@echo off
echo Restarting WhatsApp service...
timeout /t 5
taskkill /f /pid ${process.pid}
echo Server terminated, restarting...
start cmd /c "node server.js"
exit
`;
                        fs.writeFileSync(path.join(process.cwd(), 'restart-whatsapp.bat'), batchContent);
                        console.log('Created Windows restart script: restart-whatsapp.bat');
                        console.log('If WhatsApp is still not working, run the script manually as administrator');
                    } else {
                        // Unix shell script
                        const shellContent = `#!/bin/bash
echo "Restarting WhatsApp service..."
sleep 5
kill -9 ${process.pid}
echo "Server terminated, restarting..."
node server.js &
exit 0
`;
                        fs.writeFileSync(restartScriptPath, shellContent);
                        fs.chmodSync(restartScriptPath, '755');
                        console.log('Created restart script: restart-whatsapp.sh');
                        console.log('If WhatsApp is still not working, run the script manually:');
                        console.log('  chmod +x restart-whatsapp.sh && ./restart-whatsapp.sh');
                    }
                } catch (scriptErr) {
                    console.error('Error creating restart script:', scriptErr);
                }
            }
            
        } catch (outerError) {
            console.error('Outer error in complete WhatsApp reset:', outerError);
        }
    }, 1000);
});
