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
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
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
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
};

// Admin route middleware
const requireAdmin = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    
    User.findById(req.session.userId)
        .then(user => {
            if (!user || !user.isAdmin) {
                return res.status(403).send('Access denied');
            }
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

app.get('/', (req, res) => {
    res.render('landing');
});

app.get('/login',(req,res)=>
{
    res.render('login');
})

app.post('/login', async (req, res) => {
    const { email, uniqueCode } = req.body;
    
    try {
        const user = await User.findOne({ email, uniqueCode });
        if (!user) {
            return res.json({ success: false, message: 'Invalid credentials' });
        }

        req.session.user = {
            username: user.name,
          };
        
        if (!user.isVerified) {
            return res.json({ success: false, message: 'Please verify your WhatsApp first' });
        }
        
        req.session.userId = user._id;
        res.json({ success: true, message: 'Login successful' });
    } catch (error) {
        res.json({ success: false, message: 'Login failed' });
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
