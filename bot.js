const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { User, Media } = require('./database');
const { Storage } = require('@google-cloud/storage');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize Google Cloud Storage
const storage = new Storage({
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
    credentials: {
        client_email: process.env.GOOGLE_CLOUD_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_CLOUD_PRIVATE_KEY
    }
});

const bucket = storage.bucket(process.env.GOOGLE_CLOUD_BUCKET_NAME);

// Gemini content analysis function
async function analyzeContent(fileBuffer, mimeType, filename) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = "Analyze this content and return a JSON object with these fields: category (one of: poster, exam, notes, assignment, event), keywords (array of strings), subject (string or null), date (string or null)";
    
    const imageParts = [
        {
            inlineData: {
                data: fileBuffer.toString('base64'),
                mimeType: mimeType
            },
        },
    ];

    try {
        const result = await model.generateContent([prompt, ...imageParts]);
        const response = await result.response;
        const cleanedResponse = response.text().replace(/```json|```/g, '').trim();
        return JSON.parse(cleanedResponse);
    } catch (error) {
        console.error('Gemini analysis error:', error);
        // Fallback with default categorization
        return {
            category: mimeType.includes('image') ? 'poster' :
                     mimeType.includes('pdf') ? 'exam' :
                     mimeType.includes('video') ? 'video' : 'others',
            keywords: [],
            subject: null,
            date: null
        };
    }
}

function parseDate(dateString) {
    if (!dateString) return null;
    
    try {
        // Handle different date formats
        if (dateString.includes('/')) {
            const [day, month, year] = dateString.split('/');
            const fullYear = year.length === 2 ? '20' + year : year;
            const date = new Date(`${fullYear}-${month}-${day}`);
            return date.getTime() ? date : null;
        }
        
        // Try parsing as a regular date string
        const date = new Date(dateString);
        return date.getTime() ? date : null;
    } catch {
        return null;
    }
}


// Helper function to upload file to Google Cloud Storage
async function uploadToGCS(fileBuffer, fileName, mimeType) {
    const file = bucket.file(fileName);
    const stream = file.createWriteStream({
        metadata: {
            contentType: mimeType
        },
        resumable: false
    });

    return new Promise((resolve, reject) => {
        stream.on('error', (err) => reject(err));
        stream.on('finish', async () => {
            await file.makePublic();
            const publicUrl = `https://storage.googleapis.com/${process.env.GOOGLE_CLOUD_BUCKET_NAME}/${fileName}`;
            resolve(publicUrl);
        });
        stream.end(fileBuffer);
    });
}

// URL Shortener Function
async function shortenUrl(url) {
    try {
        const response = await axios.get(`http://tinyurl.com/api-create.php?url=${url}`);
        return response.data;
    } catch (error) {
        console.error('URL shortening failed:', error);
        return url;
    }
}

// Create WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './whatsapp-sessions'
    }),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
        headless: true
    }
});

client.on('authenticated', (session) => {
    console.log('WhatsApp session authenticated');
});

client.on('auth_failure', () => {
    console.log('Auth failed, retrying connection...');
    client.initialize();
});


// Generate QR Code
client.on('qr', qr => {
    qrcode.generate(qr, {small: true});
    console.log('QR Code generated! Scan it with your WhatsApp');
});

// When client is ready
client.on('ready', () => {
    console.log('Client is ready!');
});

// Help Text
const helpText = `
Available Commands:

📅 Time-based Retrieval:
#files today - Show files uploaded today
#files yesterday - Show yesterday's files
#files week - Show this week's files

📂 Category Retrieval:
#posters 5 - Show last 5 posters
#exams 3 - Show last 3 exams
#links 10 - Show last 10 links
#videos 5 - Show last 5 videos

🔍 Search:
#search keyword - Search files by keyword

💡 Note:
- Numbers after categories must be greater than 0
- Large files will be shared as links
- Use #help anytime to see this menu
`;

// Handle incoming messages
client.on('message', async msg => {
    if (msg.from.includes('g.us')) return;

    // If it's just a number or text without # command, ignore
    if (msg.body && !msg.body.startsWith('#') && !msg.hasMedia) return;

    console.log('Message received:', {
        from: msg.from,
        body: msg.body,
        hasMedia: msg.hasMedia
    });

    try {
        // Handle verification command separately
        if (msg.body.startsWith('#verify')) {
            const code = msg.body.split(' ')[1];
            const user = await User.findOne({ uniqueCode: code });
            
            if (user) {
                user.whatsappNumber = msg.from;
                user.isVerified = true;
                await user.save();
                msg.reply('Verification successful! Send #help to see available commands.');
            } else {
                msg.reply('Invalid code. Please check your code and try again.');
            }
            return;
        }

        // Check if user is verified
        const user = await User.findOne({ whatsappNumber: msg.from, isVerified: true });
        if (!user) {
            msg.reply('Please verify your account first using #verify YOUR_CODE');
            return;
        }

        // Handle media messages
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            const fileBuffer = Buffer.from(media.data, 'base64');
            
            let analysis;
            if (media.mimetype.includes('image') || media.mimetype.includes('pdf')) {
                msg.reply('Analyzing your content...');
                analysis = await analyzeContent(fileBuffer, media.mimetype, media.filename);
            } else {
                analysis = {
                    category: media.mimetype.includes('video') ? 'video' : 'others',
                    keywords: [],
                    subject: null,
                    date: null
                };
            }
            
            const category = analysis.category.toLowerCase();
            const fileName = `${category}_${Date.now()}${path.extname(media.filename || '.file')}`;
            const mediaUrl = await uploadToGCS(fileBuffer, fileName, media.mimetype);

            await Media.create({
                userId: user._id,
                category: category,
                mediaUrl: mediaUrl,
                type: media.mimetype,
                fileSize: fileBuffer.length,
                keywords: analysis.keywords || [],
                metadata: {
                    subject: analysis.subject,
                    eventDate: parseDate(analysis.date),
                    contentType: media.mimetype
                },
                timestamp: new Date()
            });

            const shortUrl = await shortenUrl(mediaUrl);
            let response = `File analyzed and uploaded as ${category}!`;
            if (analysis.keywords && analysis.keywords.length > 0) {
                response += `\nKeywords: ${analysis.keywords.join(', ')}`;
            }
            if (analysis.subject) {
                response += `\nSubject: ${analysis.subject}`;
            }
            response += `\nAccess it here: ${shortUrl}`;
            
            msg.reply(response);
            return;
        }

        if (msg.body.match(/(https?:\/\/[^\s]+)/g)) {
            const links = msg.body.match(/(https?:\/\/[^\s]+)/g);
            
            for (const link of links) {
                await Media.create({
                    userId: user._id,
                    category: 'link',
                    mediaUrl: link,
                    type: 'link',
                    fileSize: 0,
                    keywords: [],
                    metadata: {
                        subject: null,
                        eventDate: null,
                        contentType: 'link'
                    },
                    timestamp: new Date()
                });
            }
            
            msg.reply(`${links.length} link(s) saved successfully!`);
            return;
        }

        // Handle commands

        if (msg.body === '#categories') {
            const files = await Media.find({ userId: user._id });
            const categories = {};
            
            files.forEach(file => {
                categories[file.category] = (categories[file.category] || 0) + 1;
            });
        
            let response = '📊 Available Categories:\n\n';
            for (const [category, count] of Object.entries(categories)) {
                response += `${category}: ${count} files\n`;
            }
            
            msg.reply(response);
            return;
        }

        if (msg.body === '#help') {
            msg.reply(helpText);
            return;
        }

        // File Retrieval Commands
        if (msg.body.startsWith('#files')) {
            const command = msg.body.split(' ');
            let startDate, endDate;
            const now = new Date();
            
            switch(command[1]) {
                case 'today':
                    startDate = new Date(now.setHours(0,0,0,0));
                    endDate = new Date(now.setHours(23,59,59,999));
                    break;
                case 'yesterday':
                    startDate = new Date(now);
                    startDate.setDate(startDate.getDate() - 1);
                    startDate.setHours(0,0,0,0);
                    endDate = new Date(startDate);
                    endDate.setHours(23,59,59,999);
                    break;
                case 'week':
                    startDate = new Date(now);
                    startDate.setDate(startDate.getDate() - 7);
                    endDate = new Date(now);
                    break;
                default:
                    msg.reply('Please specify: today, yesterday, or week');
                    return;
            }

            const files = await Media.find({
                userId: user._id,
                timestamp: { $gte: startDate, $lte: endDate }
            }).sort({ timestamp: -1 });

            if (files.length === 0) {
                msg.reply(`No files found for ${command[1]}`);
                return;
            }

            let groupedFiles = {};
            files.forEach(file => {
                if (!groupedFiles[file.category]) {
                    groupedFiles[file.category] = [];
                }
                groupedFiles[file.category].push(file);
            });

            let response = `Files from ${command[1]}:\n\n`;
            
            for (const category in groupedFiles) {
                response += `${category.toUpperCase()}:\n`;
                for (let i = 0; i < groupedFiles[category].length; i++) {
                    const file = groupedFiles[category][i];
                    const shortUrl = await shortenUrl(file.mediaUrl);
                    response += `${i + 1}. ${shortUrl}\n`;
                    if (file.keywords && file.keywords.length > 0) {
                        response += `   Keywords: ${file.keywords.join(', ')}\n`;
                    }
                }
                response += '\n';
            }
            
            msg.reply(response);
            return;
        }

        // Category Retrieval
        if (msg.body.startsWith('#') && msg.body.split(' ')[0] !== '#help' && msg.body.split(' ')[0] !== '#verify' && msg.body.split(' ')[0] !== '#search' && msg.body.split(' ')[0] !== '#files') {
            const command = msg.body.split(' ');
            const category = command[0].replace('#', '').slice(0, -1); // Remove 's' from end
            const limit = parseInt(command[1]) || 5;
        
            if (limit <= 0) {
                msg.reply('Please specify a valid number greater than 0');
                return;
            }
        
            const files = await Media.find({
                userId: user._id,
                category: category
            })
            .sort({ timestamp: -1 })
            .limit(limit);
        
            if (files.length === 0) {
                msg.reply(`No ${category} files found`);
                return;
            }
        
            let response = `Last ${limit} ${category} files:\n\n`;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const shortUrl = await shortenUrl(file.mediaUrl);
                response += `${i + 1}. ${shortUrl}\n`;
                if (file.keywords && file.keywords.length > 0) {
                    response += `   Keywords: ${file.keywords.join(', ')}\n`;
                }
            }
            
            msg.reply(response);
            return;
        }

        // Search Command
        if (msg.body.startsWith('#search')) {
            const keyword = msg.body.slice(8).trim().toLowerCase();
            if (!keyword) {
                msg.reply('Please provide a search keyword');
                return;
            }

            const files = await Media.find({
                userId: user._id,
                $or: [
                    { keywords: { $regex: keyword, $options: 'i' } },
                    { 'metadata.subject': { $regex: keyword, $options: 'i' } },
                    { category: { $regex: keyword, $options: 'i' } }
                ]
            }).sort({ timestamp: -1 });

            if (files.length === 0) {
                msg.reply(`No files found matching "${keyword}"`);
                return;
            }

            let response = `Search results for "${keyword}":\n\n`;
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const shortUrl = await shortenUrl(file.mediaUrl);
                response += `${i + 1}. [${file.category}] ${shortUrl}\n`;
                if (file.keywords && file.keywords.length > 0) {
                    response += `   Keywords: ${file.keywords.join(', ')}\n`;
                }
                response += '\n';
            }
            
            msg.reply(response);
            return;
        }

    } catch (error) {
        console.error('Error:', error);
        msg.reply('Sorry, there was an error processing your message.');
    }
});

client.initialize();

module.exports = client;
