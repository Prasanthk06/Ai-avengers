const qrcode = require('qrcode-terminal');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const { User, Media } = require('./database');
const { Storage } = require('@google-cloud/storage');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const qr = require('qr-image');
require('dotenv').config();

// Constants
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB limit
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const AUTH_FOLDER_PATH = path.join(process.cwd(), '.wwebjs_auth');
const CACHE_FOLDER_PATH = path.join(process.cwd(), '.wwebjs_cache');

// Initialize Gemini and Storage
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const storage = new Storage({
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
    credentials: {
        client_email: process.env.GOOGLE_CLOUD_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_CLOUD_PRIVATE_KEY
    }
});
const bucket = storage.bucket(process.env.GOOGLE_CLOUD_BUCKET_NAME);

// Ensure auth and cache directories exist
function ensureDirectoriesExist() {
    if (!fs.existsSync(AUTH_FOLDER_PATH)) {
        fs.mkdirSync(AUTH_FOLDER_PATH, { recursive: true });
    }
    
    if (!fs.existsSync(CACHE_FOLDER_PATH)) {
        fs.mkdirSync(CACHE_FOLDER_PATH, { recursive: true });
    }
}

// Cache Management
async function manageCache() {
    try {
        ensureDirectoriesExist();
        const authPath = AUTH_FOLDER_PATH;
        const files = await fsPromises.readdir(authPath);
        const sessionFiles = files.filter(file => !file.includes('session'));
        for (const file of sessionFiles) {
            await fsPromises.unlink(path.join(authPath, file));
        }
        console.log('Cache cleaned:', new Date().toISOString());
    } catch (error) {
        console.log('Cache cleanup:', error.message);
        // Continue execution even if cache cleaning fails
    }
}

// Run cache cleanup every 10 minutes
setInterval(manageCache, 10 * 60 * 1000);
// Helper Functions
async function safeSendReply(msg, content) {
    try {
        return await msg.reply(content);
    } catch (error) {
        console.log('Primary sending method failed:', error.message);
        try {
            return await client.sendMessage(msg.from, content);
        } catch (sendError) {
            console.log('Fallback sending failed:', sendError.message);
        }
    }
}

async function analyzeContent(fileBuffer, mimeType, filename) {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = "Analyze this content and return a JSON object with these fields: category (one of: poster, exam, notes, assignment, event), keywords (array of strings), subject (string or null), date (string or null)";
    const imageParts = [{
        inlineData: {
            data: fileBuffer.toString('base64'),
            mimeType: mimeType
        },
    }];

    try {
        const result = await model.generateContent([prompt, ...imageParts]);
        const response = await result.response;
        const cleanedResponse = response.text().replace(/```json|```/g, '').trim();
        return JSON.parse(cleanedResponse);
    } catch (error) {
        console.error('Gemini analysis error:', error);
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

async function uploadToGCS(fileBuffer, fileName, mimeType) {
    const file = bucket.file(fileName);
    const stream = file.createWriteStream({
        metadata: { contentType: mimeType },
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

async function shortenUrl(url) {
    try {
        const response = await axios.get(`http://tinyurl.com/api-create.php?url=${url}`);
        return response.data;
    } catch (error) {
        console.error('URL shortening failed:', error);
        return url;
    }
}

function parseDate(dateString) {
    if (!dateString) return null;
    try {
        if (dateString.includes('/')) {
            const [day, month, year] = dateString.split('/');
            const fullYear = year.length === 2 ? '20' + year : year;
            const date = new Date(`${fullYear}-${month}-${day}`);
            return date.getTime() ? date : null;
        }
        const date = new Date(dateString);
        return date.getTime() ? date : null;
    } catch {
        return null;
    }
}
// Client Configuration
// Call function to ensure directories exist before initializing client
ensureDirectoriesExist();

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "client-one",
        dataPath: AUTH_FOLDER_PATH
    }),
    puppeteer: {
        headless: 'new', // Always use headless in Railway
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--aggressive-cache-discard',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-component-extensions-with-background-pages',
            '--disable-dev-shm-usage',
            '--disable-domain-reliability',
            '--disable-hang-monitor',
            '--disable-ipc-flooding-protection',
            '--disable-renderer-backgrounding',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check'
        ],
        defaultViewport: null,
        timeout: 0,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null // Support for custom Chromium
    },
    queueMessages: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 15000, // Increased timeout further
    restartOnAuthFail: true,
    disableReconnect: false, // Ensure reconnection is enabled
    bypassCSP: true, // May help with connection issues
});

// Keep-alive strategy
// This will regularly check if the client is still connected and try to reconnect if not
let lastConnectionCheck = Date.now();
let connectionMonitor;

// Start connection monitoring
function startConnectionMonitor() {
    if (connectionMonitor) clearInterval(connectionMonitor);
    
    connectionMonitor = setInterval(async () => {
        try {
            // If client is initialized but we haven't been able to get state in 5 minutes
            const now = Date.now();
            const timeSinceLastCheck = now - lastConnectionCheck;
            
            console.log(`Connection monitor check: Last status check ${Math.round(timeSinceLastCheck/1000/60)} minutes ago`);
            
            // Check if client is connected by trying to get state
            if (client.pupPage && !client.pupPage.isClosed()) {
                try {
                    // Try to get connection state
                    const state = await client.getState();
                    lastConnectionCheck = now;
                    console.log(`WhatsApp connection state: ${state}`);
                    
                    // If we're not connected, try to reconnect
                    if (state !== 'CONNECTED') {
                        console.log('WhatsApp not in CONNECTED state, attempting reconnect...');
                        attemptReconnect();
                    }
                } catch (err) {
                    console.log('Error getting connection state:', err.message);
                    if (timeSinceLastCheck > 5 * 60 * 1000) { // 5 minutes
                        console.log('Connection appears to be stuck, attempting reconnect...');
                        attemptReconnect();
                    }
                }
            } else {
                console.log('Client page is closed or unavailable, attempting reconnect...');
                attemptReconnect();
            }
        } catch (err) {
            console.error('Connection monitor error:', err.message);
        }
    }, 2 * 60 * 1000); // Check every 2 minutes
}

// Add a special function to ensure client is up after Railway deployment
setTimeout(() => {
    // Check client status 2 minutes after startup
    console.log('Performing post-startup connection check...');
    
    if (!client.info) {
        console.log('Client appears to be disconnected, attempting to initialize...');
        client.initialize().catch(e => {
            console.error('Failed to initialize client:', e.message);
        });
    } else {
        console.log('Client is connected and ready');
    }
    
    // Start the ongoing connection monitor
    startConnectionMonitor();
}, 2 * 60 * 1000);

// Connection monitoring with improved error handling
let connectionCheckInterval;
let qrRetryTimeout; // To track QR retry timeout
let isReconnecting = false;

// Add a reconnect function that can be called when connection issues occur
async function attemptReconnect() {
    if (isReconnecting) return;
    
    isReconnecting = true;
    console.log('Attempting to reconnect WhatsApp client...');
    
    try {
        await client.destroy();
        console.log('Client destroyed, initializing new instance...');
        
        // Short delay before reinitialization
        await new Promise(r => setTimeout(r, 3000));
        
        await client.initialize();
        console.log('Client reinitialized successfully');
    } catch (error) {
        console.log('Reconnection attempt failed:', error.message);
    } finally {
        isReconnecting = false;
    }
}

client.on('ready', () => {
    console.log('Client is ready!');
    connectionCheckInterval = setInterval(() => {
        if (!client.pupPage?.isClosed()) {
            console.log('Connection active:', new Date().toISOString());
        }
    }, 30000);
});

client.on('disconnected', async (reason) => {
    console.log('Client disconnected:', reason);
    clearInterval(connectionCheckInterval);
    
    // Record the disconnection time
    const disconnectTime = new Date().toISOString();
    console.log(`Disconnection recorded at ${disconnectTime}`);
    
    // Wait a moment before trying to reconnect
    console.log('Waiting 10 seconds before attempting to reconnect...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Try to reconnect
    console.log('Attempting to reinitialize after disconnection...');
    try {
        await client.initialize();
        console.log('Client reinitialized successfully after disconnection');
    } catch (error) {
        console.error('Failed to reinitialize after disconnection:', error.message);
        console.log('Will try again via the connection monitor');
    }
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
// Event Handlers
client.on('qr', async (qr) => {
    // Clear any existing QR retry timeout
    if (qrRetryTimeout) {
        clearTimeout(qrRetryTimeout);
    }
    
    // Generate terminal QR for development
    qrcode.generate(qr, {small: true});
    console.log('QR Code generated! Scan it with your WhatsApp');
    
    // Save QR as image file for admin dashboard
    try {
        // Make sure the public directory exists
        const publicDir = path.join(process.cwd(), 'public');
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }
        
        // Generate QR code as PNG using qr-image module
        const qrCode = require('qr-image');
        const qrImg = qrCode.image(qr, { type: 'png' });
        const qrPath = path.join(publicDir, 'latest-qr.png');
        
        // Create write stream and save file
        const qrStream = fs.createWriteStream(qrPath);
        qrImg.pipe(qrStream);
        
        // Handle stream events to ensure file is properly written
        qrStream.on('finish', () => {
            // Set global variable for admin panel
            global.lastQrTimestamp = new Date().toISOString();
            console.log(`QR Code saved to ${qrPath} at ${global.lastQrTimestamp}`);
            
            // Set a timeout to regenerate QR if not scanned in 40 seconds
            qrRetryTimeout = setTimeout(() => {
                console.log('QR code expired, will generate a new one when requested');
            }, 40000);
        });
        
        qrStream.on('error', (err) => {
            console.error('Error writing QR file:', err);
        });
    } catch (error) {
        console.error('Error saving QR code:', error);
    }
});

client.on('authenticated', () => {
    console.log('Authenticated successfully');
    
    // Don't clear the QR code immediately after authentication
    // This gives admins time to see the current state transition
    setTimeout(() => {
        // Only clear if the client is still authenticated
        if (client.info) {
            console.log('Authentication confirmed, clearing QR code state');
            // Optionally clear QR timestamp after confirmed connection
            // global.lastQrTimestamp = null;
        }
    }, 10000);
});

client.on('auth_failure', msg => {
    console.error('Authentication failure:', msg);
});

// Message Handler
client.on('message', async msg => {
    try {
        console.log(`Message received: ${new Date().toISOString()}`, {
            from: msg.from,
            body: msg.body ? msg.body.substring(0, 20) + (msg.body.length > 20 ? '...' : '') : '[no text]',
            type: msg.hasMedia ? 'media' : 'text',
            timestamp: msg._data.t
        });

        if (msg.from.endsWith('@g.us')) {
            console.log('Ignoring group message');
            return;
        }

        // Verification command handling
        if (msg.body?.startsWith('#verify')) {
            console.log('Processing verification request');
            const code = msg.body.split(' ')[1];
            const user = await User.findOne({ uniqueCode: code });
            
            if (user) {
                console.log(`User found for verification: ${user.email}`);
                user.whatsappNumber = msg.from;
                user.isVerified = true;
                await user.save();
                await safeSendReply(msg, 'Verification successful! Send #help to see available commands.');
                console.log(`User ${user.email} verified successfully`);
            } else {
                console.log(`Invalid verification code: ${code}`);
                await safeSendReply(msg, 'Invalid code. Please check your code and try again.');
            }
            return;
        }

        // Check user verification
        const user = await User.findOne({ whatsappNumber: msg.from, isVerified: true });
        if (!user) {
            console.log(`Unverified user or number not found: ${msg.from}`);
            if (msg.body && !msg.body.startsWith('#')) {
                // If it's a regular message and not a command, send a hint
                await safeSendReply(msg, 'Please verify your account first. Use the #verify command followed by your unique code.');
            }
            return;
        }

        console.log(`Processing message from verified user: ${user.email}`);

        try {
            // Handle media messages
            if (msg.hasMedia) {
                try {
                    const media = await msg.downloadMedia();
                    const fileBuffer = Buffer.from(media.data, 'base64');
                    
                    if (fileBuffer.length > MAX_FILE_SIZE) {
                        await safeSendReply(msg, 'File too large. Please send a smaller file.');
                        return;
                    }
                    
                    let analysis;
                    if (media.mimetype.includes('image') || media.mimetype.includes('pdf')) {
                        await safeSendReply(msg, 'Analyzing your content...');
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
                    if (analysis.keywords?.length > 0) {
                        response += `\nKeywords: ${analysis.keywords.join(', ')}`;
                    }
                    if (analysis.subject) {
                        response += `\nSubject: ${analysis.subject}`;
                    }
                    response += `\nAccess it here: ${shortUrl}`;
                    
                    await safeSendReply(msg, response);
                } catch (mediaError) {
                    console.error('Media handling error:', mediaError);
                    await safeSendReply(msg, 'Error processing media. Please try again.');
                }
                return;
            }
                    // Handle links
            if (msg.body?.match(/(https?:\/\/[^\s]+)/g)) {
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
                
                await safeSendReply(msg, `${links.length} link(s) saved successfully!`);
                return;
            }

            // Handle commands
            switch(true) {
                case msg.body === '#categories':
                    const files = await Media.find({ userId: user._id });
                    const categories = {};
                    files.forEach(file => {
                        categories[file.category] = (categories[file.category] || 0) + 1;
                    });
                    
                    let categoryResponse = '📊 Available Categories:\n\n';
                    for (const [category, count] of Object.entries(categories)) {
                        categoryResponse += `${category}: ${count} files\n`;
                    }
                    await safeSendReply(msg, categoryResponse);
                    break;

                case msg.body === '#help':
                    await safeSendReply(msg, helpText);
                    break;

                case msg.body?.startsWith('#files'):
                    await handleFileRetrieval(msg, user);
                    break;

                case msg.body?.startsWith('#search'):
                    await handleSearch(msg, user);
                    break;

                case msg.body?.startsWith('#') && !['#help', '#verify', '#search', '#files'].includes(msg.body.split(' ')[0]):
                    await handleCategoryRetrieval(msg, user);
                    break;
            }

        } catch (error) {
            console.error('Error:', error);
            await safeSendReply(msg, 'Sorry, there was an error processing your message.');
        }
    } catch (error) {
        console.error('Error:', error);
        await safeSendReply(msg, 'Sorry, there was an error processing your message.');
    }
});

// Helper functions for command handling
async function handleFileRetrieval(msg, user) {
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
            await safeSendReply(msg, 'Please specify: today, yesterday, or week');
            return;
    }

    const files = await Media.find({
        userId: user._id,
        timestamp: { $gte: startDate, $lte: endDate }
    }).sort({ timestamp: -1 });

    if (files.length === 0) {
        await safeSendReply(msg, `No files found for ${command[1]}`);
        return;
    }

    let response = await formatFileResponse(files, command[1]);
    await safeSendReply(msg, response);
}

async function handleSearch(msg, user) {
    const keyword = msg.body.slice(8).trim().toLowerCase();
    if (!keyword) {
        await safeSendReply(msg, 'Please provide a search keyword');
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
        await safeSendReply(msg, `No files found matching "${keyword}"`);
        return;
    }

    let response = await formatSearchResponse(files, keyword);
    await safeSendReply(msg, response);
}

async function formatFileResponse(files, timeframe) {
    let groupedFiles = {};
    files.forEach(file => {
        if (!groupedFiles[file.category]) {
            groupedFiles[file.category] = [];
        }
        groupedFiles[file.category].push(file);
    });

    let response = `Files from ${timeframe}:\n\n`;
    for (const category in groupedFiles) {
        response += `${category.toUpperCase()}:\n`;
        for (let i = 0; i < groupedFiles[category].length; i++) {
            const file = groupedFiles[category][i];
            const shortUrl = await shortenUrl(file.mediaUrl);
            response += `${i + 1}. ${shortUrl}\n`;
            if (file.keywords?.length > 0) {
                response += `   Keywords: ${file.keywords.join(', ')}\n`;
            }
        }
        response += '\n';
    }
    return response;
}

async function formatSearchResponse(files, keyword) {
    let response = `Search results for "${keyword}":\n\n`;
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const shortUrl = await shortenUrl(file.mediaUrl);
        response += `${i + 1}. [${file.category}] ${shortUrl}\n`;
        if (file.keywords?.length > 0) {
            response += `   Keywords: ${file.keywords.join(', ')}\n`;
        }
        response += '\n';
    }
    return response;
}

client.initialize();

module.exports = client;

