const express = require('express');
const { connectDB } = require('./database');
const path = require('path');
const client = require('./bot');
require('dotenv').config();
const session = require('express-session');
const bcrypt = require('bcrypt');
const { User, Media } = require('./database');
const nodemailer = require('nodemailer');




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
