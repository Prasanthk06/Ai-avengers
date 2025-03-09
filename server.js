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
        // Only use secure cookies if not in development and if using HTTPS
        secure: process.env.NODE_ENV === 'production' ? false : false,
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

// Restart WhatsApp connection (for admin use)
app.post('/admin/whatsapp/restart', requireAdmin, async (req, res) => {
    try {
        // Clear the QR timestamp so we know we need a new one
        global.lastQrTimestamp = null;
        
        // Destroy the current client
        await client.destroy();
        console.log('WhatsApp client destroyed, reinitializing...');
        
        // Wait a moment before reinitializing
        setTimeout(() => {
            // Initialize client with forceNewSession option
            client.initialize();
            console.log('WhatsApp client restarting...');
            
            res.json({ 
                success: true, 
                message: 'WhatsApp client restarting. Please wait 15-20 seconds for a new QR code to appear, then refresh the page.' 
            });
        }, 1000);
    } catch (error) {
        console.error('Error restarting WhatsApp client:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to restart WhatsApp client: ' + error.message 
        });
    }
});

// Add this route after the existing /admin/whatsapp/restart route
app.post('/admin/whatsapp/regenerate-qr', requireAdmin, async (req, res) => {
    try {
        // Make sure the public directory exists
        const publicDir = path.join(__dirname, 'public');
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }
        
        // Force disconnect and reinitialize
        await client.destroy();
        console.log('WhatsApp client destroyed, reinitializing...');
        
        setTimeout(() => {
            client.initialize();
            res.json({ 
                success: true, 
                message: 'WhatsApp client restarting. Please wait 10-15 seconds for a new QR code to appear.' 
            });
        }, 1000);
    } catch (error) {
        console.error('Error regenerating QR:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to regenerate QR code: ' + error.message 
        });
    }
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
        if (client.info) {
            // Get current state information
            const state = await client.getState().catch(e => 'ERROR: ' + e.message);
            console.log(`Current WhatsApp state before reconnect: ${state}`);
        }
        
        // Force client destroy and reinitialize
        console.log('Destroying WhatsApp client...');
        await client.destroy();
        console.log('Client destroyed, waiting 15 seconds...');
        
        // Longer delay before reinitialization
        await new Promise(r => setTimeout(r, 15000));
        
        // Clear any existing QR throttling
        if (typeof qrRegenerationCount !== 'undefined') {
            qrRegenerationCount = 0;
        }
        if (typeof lastQrGeneration !== 'undefined') {
            lastQrGeneration = 0;
        }
        
        // Initialize again
        console.log('Reinitializing WhatsApp client...');
        try {
            await client.initialize();
            console.log('WhatsApp client reinitialized successfully');
            
            res.json({ 
                success: true, 
                message: 'WhatsApp client restarted. Please wait for a new QR code to appear (this may take up to 30 seconds). Refresh the page after 30 seconds if no QR appears.'
            });
        } catch (initError) {
            console.error('Failed to initialize WhatsApp client:', initError);
            res.json({
                success: false,
                error: initError.message,
                message: 'Failed to initialize WhatsApp client. Please try again in 5 minutes.'
            });
        }
    } catch (error) {
        console.error('Error during WhatsApp reconnection:', error);
        res.json({ 
            success: false, 
            error: error.message,
            message: 'Failed to restart WhatsApp client. Please try again in 5 minutes.'
        });
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
