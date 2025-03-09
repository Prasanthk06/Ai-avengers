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

// Admin route middleware
const requireAdmin = (req, res, next) => {
    console.log('Admin check - Session:', req.session);
    
    if (!req.session.userId) {
        console.log('Admin check failed - no session - redirecting to login');
        return res.redirect('/login');
    }
    
    User.findById(req.session.userId)
        .then(user => {
            console.log('Admin check - User found:', user ? user.isAdmin : 'No user');
            if (!user || !user.isAdmin) {
                console.log('Admin check failed - not an admin');
                return res.status(403).send('Access denied');
            }
            console.log('Admin check passed for user:', user.email);
            next();
        })
        .catch(err => {
            console.error('Admin check error:', err);
            res.status(500).send('Server error');
        });
};

// WhatsApp connection status route
app.get('/whatsapp-status', requireAdmin, (req, res) => {
    // Check current time to ensure fresh status
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
        console.error('Error checking QR file:', error);
        status.qrFileExists = false;
        status.qrFileError = error.message;
    }
    
    // If QR timestamp exists but file doesn't, we don't reset the timestamp
    // anymore to avoid race conditions with QR generation
    
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

// Modify the /admin/whatsapp/regenerate-qr route (if it exists)
app.post('/admin/whatsapp/regenerate-qr', requireAdmin, (req, res) => {
    console.log('Admin requested QR code regeneration');
    
    // Send response immediately
    res.json({
        success: true,
        message: 'QR regeneration initiated. This may take a minute to complete.'
    });
    
    // Run the operation asynchronously
    safeClientOperation(res, async () => {
        try {
            if (client.pupBrowser) {
                await client.destroy();
                console.log('Client destroyed, waiting before regenerating QR...');
                
                await new Promise(r => setTimeout(r, 5000));
                
                // Reset any QR throttling
                if (typeof client.lastQrGeneration !== 'undefined') {
                    client.lastQrGeneration = 0;
                }
                if (typeof client.qrRegenerationCount !== 'undefined') {
                    client.qrRegenerationCount = 0; 
                }
                
                await client.initialize();
                console.log('Client reinitialized, QR should be generated');
            } else {
                console.log('Client not initialized, starting initialization');
                await client.initialize();
            }
        } catch (error) {
            console.error('Error during QR regeneration:', error);
        }
    });
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
