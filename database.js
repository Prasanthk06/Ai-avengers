const mongoose = require('mongoose');
require('dotenv').config();

// Create a simple user schema
const userSchema = new mongoose.Schema({
    name: String,
    email: String,
    whatsappNumber: String,
    uniqueCode: String,
    isVerified: { type: Boolean, default: false }
});

// Create a simple media schema
const mediaSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    category: {
        type: String,
        required: true
    },
    mediaUrl: {
        type: String,
        required: true
    },
    type: {
        type: String,
        required: true
    },
    fileSize: {
        type: Number,
        required: true
    },
    keywords: [{
        type: String
    }],
    metadata: {
        subject: String,
        eventDate: Date,
        contentType: String
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
});

// Create models
const User = mongoose.model('User', userSchema);
const Media = mongoose.model('Media', mediaSchema);

// Connect to MongoDB
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('MongoDB Connected');
    } catch (err) {
        console.error('MongoDB Connection Error:', err);
        process.exit(1);
    }
};

module.exports = { connectDB, User, Media };
