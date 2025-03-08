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
const DEBUG_MODE = true;
const REDUCE_DELAYS = true; // Flag to reduce delays in message processing
const PERFORMANCE_MODE = true; // Enable all performance optimizations
const PRELOAD_USER_DATA = true; // Preload user data for faster responses
const MAX_CONCURRENT_OPERATIONS = 10; // Limit concurrent operations to prevent overload
const DIRECT_REPLY_MODE = true; // Use the most direct reply method possible for lowest latency

// Client reference for external updates
let clientRef;

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

// Add this global cache for user data
const userCache = new Map();
const messageInProgress = new Set(); // Track messages being processed to prevent duplicates
let lastCleanup = Date.now();

// Ensure auth and cache directories exist
function ensureDirectoriesExist() {
    if (!fs.existsSync(AUTH_FOLDER_PATH)) {
        fs.mkdirSync(AUTH_FOLDER_PATH, { recursive: true });
    }
    
    if (!fs.existsSync(CACHE_FOLDER_PATH)) {
        fs.mkdirSync(CACHE_FOLDER_PATH, { recursive: true });
    }
}

// Optimize the cache cleanup to run when needed
async function manageCache() {
    try {
        // Clean message tracking set every 5 minutes to prevent memory leaks
        const now = Date.now();
        if (now - lastCleanup > 5 * 60 * 1000) {
            // Clear tracking sets to prevent memory leaks
            messageInProgress.clear();
            lastCleanup = now;
            console.log('Message tracking cache cleared');
        }
        
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

// After client initialization but before the event handlers, add this console log
console.log('Setting up WhatsApp event handlers...');

// Helper Functions
async function safeSendReply(msg, content) {
    // For absolutely minimal latency, use a highly optimized direct approach
    if (DIRECT_REPLY_MODE && PERFORMANCE_MODE) {
        // For ping commands, use the absolute fastest path
        if (content.includes('Pong!')) {
            try {
                // Direct reply is fastest
                return await msg.reply(content);
            } catch (error) {
                // Fallback to other methods
                try {
                    return await clientRef.sendMessage(msg.from, content);
                } catch (e) {
                    console.log('Ping reply fallback error:', e.message);
                    return null;
                }
            }
        }
    }
    
    try {
        // Fast path: try direct reply first
        return await msg.reply(content);
    } catch (error) {
        console.log('Primary sending method failed:', error.message);
        
        try {
            // Fallback: Get chat directly (more reliable sometimes)
            const chat = await msg.getChat();
            return await chat.sendMessage(content);
        } catch (sendError) {
            console.log('Fallback sending failed:', sendError.message);
            
            // Last resort: Try direct chat by ID method
            try {
                if (msg.from) {
                    return await clientRef.sendMessage(msg.from, content);
                }
            } catch (lastError) {
                console.log('Last resort sending failed:', lastError.message);
            }
            
            return null;
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

// Add a more stable client ID that doesn't change between sessions
const STABLE_CLIENT_ID = "main-whatsapp-client";

// Modify the client configuration for maximum speed
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: STABLE_CLIENT_ID,
        dataPath: AUTH_FOLDER_PATH
    }),
    puppeteer: {
        headless: 'new',
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--disable-features=site-per-process,TranslateUI',
            '--disable-extensions',
            '--js-flags=--expose-gc',  // Expose garbage collection for better memory management
            '--disable-backgrounding-occluded-windows',
            '--disable-component-extensions-with-background-pages',
            '--disable-ipc-flooding-protection',
            '--aggressive-cache-discard',
            '--disable-background-networking',
            '--no-default-browser-check', 
            '--no-first-run'
        ],
        ignoreHTTPSErrors: true,
        defaultViewport: null,
        timeout: 120000,
        protocolTimeout: 60000  // Added protocol timeout for better error handling
    },
    authTimeoutMs: 120000,
    queueMessages: false, // Process messages in parallel for better responsiveness
    restartOnCrash: true,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    webVersionCache: { 
        type: 'remote',
        remotePath: 'https://web.whatsapp.com'
    },
    // Add a more aggressive keep-alive frequency
    webSocketKeepAliveInterval: 10000, // 10 seconds keep-alive (was 15)
    webSocketRestartOnTimeout: true,
    maxRetries: 5,  // Added retry parameter for better reliability
    takeoverOnConflict: false, // Avoid conflicts with other sessions
    disableReconnect: false  // Ensure reconnection is enabled
});

// Store the reference for updateClient function
clientRef = client;

// Keep-alive strategy
// This will regularly check if the client is still connected and try to reconnect if not
let lastConnectionCheck = Date.now();
let connectionMonitor;

// Start connection monitoring
function startConnectionMonitor() {
    if (connectionMonitor) clearInterval(connectionMonitor);
    
    connectionMonitor = setInterval(async () => {
        try {
            const now = Date.now();
            const timeSinceLastCheck = now - lastConnectionCheck;
            
            // Only log every 5 minutes to reduce noise
            if (timeSinceLastCheck >= 5 * 60 * 1000) {
                console.log(`Connection monitor check: Last status check ${Math.round(timeSinceLastCheck/1000/60)} minutes ago`);
            }
            
            // Check more frequently for disconnected state
            if (client.pupPage && !client.pupPage.isClosed()) {
                try {
                    const state = await client.getState();
                    lastConnectionCheck = now;
                    
                    // Only log state changes or infrequently
                    if (global.lastReportedState !== state || timeSinceLastCheck >= 5 * 60 * 1000) {
                        console.log(`WhatsApp connection state: ${state}`);
                        global.lastReportedState = state;
                    }
                    
                    // Reconnect if disconnected
                    if (state === 'DISCONNECTED') {
                        console.log('WhatsApp disconnected, attempting reconnect...');
                        attemptReconnect();
                    }
                } catch (err) {
                    console.log('Error getting connection state:', err.message);
                    if (timeSinceLastCheck > 10 * 60 * 1000) { // 10 minutes
                        console.log('Connection appears to be stuck, attempting reconnect...');
                        attemptReconnect();
                    }
                }
            } else if (timeSinceLastCheck > 10 * 60 * 1000) { // 10 minutes with no page
                console.log('Client page is closed or unavailable for extended period, attempting reconnect...');
                attemptReconnect();
            }
        } catch (err) {
            console.error('Connection monitor error:', err.message);
        }
    }, REDUCE_DELAYS ? 60 * 1000 : 5 * 60 * 1000); // Check every 1 minute or 5 minutes
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
        // First check if we need to destroy the client
        if (client.pupBrowser || client.pupPage) {
            try {
                console.log('Attempting to destroy client gracefully...');
                await client.destroy().catch(e => console.log('Error during client destroy:', e.message));
            } catch (error) {
                console.log('Error during destroy operation:', error.message);
                // If destroy fails, try to force close browser
                if (client.pupBrowser) {
                    try {
                        await client.pupBrowser.close().catch(e => console.log('Browser close error:', e.message));
                    } catch (err) {
                        console.log('Failed to close browser:', err.message);
                    }
                }
            }
        }
        
        console.log('Client cleanup completed, waiting before reinitializing...');
        
        // Longer delay before reinitialization (15 seconds)
        await new Promise(r => setTimeout(r, 15000));
        
        // Reset QR throttling counters
        qrRegenerationCount = 0;
        lastQrGeneration = 0;
        
        console.log('Initializing client...');
        await client.initialize().catch(e => {
            console.log('Error during initialization:', e.message);
            throw e; // Rethrow to be caught by outer try/catch
        });
        
        console.log('Client reinitialized successfully');
    } catch (error) {
        console.log('Reconnection attempt failed:', error.message);
    } finally {
        // Longer cooldown between reconnection attempts (3 minutes)
        setTimeout(() => {
            isReconnecting = false;
            console.log('Reconnection cooldown completed');
        }, 3 * 60 * 1000);
    }
}

client.on('ready', async () => {
    console.log('Client is ready!');
    
    if (PRELOAD_USER_DATA && PERFORMANCE_MODE) {
        try {
            console.log('Preloading user data...');
            const users = await User.find({ isVerified: true }).lean();
            users.forEach(user => {
                if (user.whatsappNumber) {
                    userCache.set(user.whatsappNumber, user);
                }
            });
            console.log(`Preloaded ${userCache.size} users into cache`);
        } catch (error) {
            console.error('Error preloading user data:', error.message);
        }
    }
    
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
let lastQrGeneration = 0;
const QR_THROTTLE_MS = 30000; // Minimum 30 seconds between QR generations
let qrRegenerationCount = 0;
const MAX_QR_REGENERATIONS = 5; // Maximum consecutive QR regenerations

client.on('qr', async (qr) => {
    // Check if we've generated QR codes too frequently
    const now = Date.now();
    const timeSinceLastQr = now - lastQrGeneration;
    
    // If we regenerated QR too quickly or too many times, throttle it
    if (timeSinceLastQr < QR_THROTTLE_MS) {
        qrRegenerationCount++;
        console.log(`QR regeneration too frequent (${Math.round(timeSinceLastQr/1000)}s), throttling. Count: ${qrRegenerationCount}/${MAX_QR_REGENERATIONS}`);
        
        if (qrRegenerationCount > MAX_QR_REGENERATIONS) {
            console.log('Too many QR regenerations, pausing client...');
            // Add a longer delay before allowing another QR
            setTimeout(() => {
                qrRegenerationCount = 0; // Reset counter after cooling down
                console.log('QR throttling reset after cooling period');
            }, 2 * 60 * 1000); // 2 minute cooling period
            return;
        }
        
        return; // Skip generating a new QR code
    }
    
    // We passed the throttle check, update the timestamp and reset counter if needed
    lastQrGeneration = now;
    if (timeSinceLastQr > 2 * QR_THROTTLE_MS) {
        qrRegenerationCount = 0; // Reset counter if it's been a while
    }
    
    // Terminal-based QR code (for debugging)
    qrcode.generate(qr, { small: true });
    
    try {
        // Ensure public directory exists
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
            
            // Set a timeout to clear QR if not scanned in 60 seconds (increased from 40)
            qrRetryTimeout = setTimeout(() => {
                console.log('QR code expired, will generate a new one when requested');
            }, 60000);
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

// Add a special message handler for quicker replies to commands
client.on('message_create', async (msg) => {
    // Only process commands from your own number
    if (client.info && msg.from === client.info.wid._serialized && msg.body.startsWith('#')) {
        console.log('Detected command from self:', msg.body);
        
        // Quick ping command for testing
        if (msg.body === '#ping') {
            await safeSendReply(msg, 'Pong! Response time test.');
            console.log('Sent ping response');
        }
    }
});

// Message Handler
client.on('message', async msg => {
    // Skip duplicate message processing
    const messageId = msg.id ? msg.id.id : `${msg.from}-${Date.now()}`;
    if (messageInProgress.has(messageId)) {
        return; // Skip duplicate processing
    }
    
    // Mark message as being processed
    messageInProgress.add(messageId);
    
    // Set a timeout to remove from tracking after 30 seconds
    setTimeout(() => messageInProgress.delete(messageId), 30000);
    
    try {
        // Immediate acknowledgment for long-running operations
        if (REDUCE_DELAYS && PERFORMANCE_MODE) {
            // Only acknowledge messages that would take time to process
            if (msg.hasMedia || (msg.body && (msg.body.startsWith('#') || msg.body.length > 50))) {
                try {
                    // Fire and forget acknowledgment - don't await
                    msg.react('👍').catch(() => {}); // React is much faster than reply
                    
                    // Use a timeout to avoid blocking the main message processing
                    setTimeout(() => {
                        try {
                            msg.reply('Processing your request...').catch(() => {});
                        } catch (e) {
                            // Ignore errors
                        }
                    }, 100);
                } catch (e) {
                    // Ignore errors in quick acknowledgment
                }
            }
        }
        
        // Add extensive debug logging
        if (DEBUG_MODE) {
            console.log('=========== NEW MESSAGE RECEIVED ===========');
            console.log(`ID: ${messageId}`);
            console.log(`From: ${msg.from}`);
            console.log(`Body: ${msg.body ? (msg.body.substring(0, 50) + (msg.body.length > 50 ? '...' : '')) : '[empty]'}`);
            console.log(`Has Media: ${msg.hasMedia}`);
            console.log(`Timestamp: ${new Date().toISOString()}`);
            console.log('=============================================');
        }

        console.log(`Message received: ${new Date().toISOString()}`, {
            from: msg.from,
            body: msg.body ? msg.body.substring(0, 20) + (msg.body.length > 20 ? '...' : '') : '[no text]',
            type: msg.hasMedia ? 'media' : 'text',
            timestamp: msg._data ? msg._data.t : 'unknown'
        });

        if (msg.from.endsWith('@g.us')) {
            console.log('Ignoring group message');
            messageInProgress.delete(messageId);
            return;
        }

        // Fast path for ping command
        if (msg.body?.toLowerCase() === '#ping') {
            console.log('Processing ping request - fast path');
            const timestamp = Date.now();
            await msg.reply(`Pong! Timestamp: ${timestamp}`);
            messageInProgress.delete(messageId);
            return;
        }

        // Verification command handling
        if (msg.body?.startsWith('#verify')) {
            console.log('Processing verification request');
            const code = msg.body.split(' ')[1];
            const user = await getVerifiedUser(msg.from);
            
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

        // Process #help command before user verification
        if (msg.body?.toLowerCase() === '#help') {
            console.log('Processing help request');
            
            const basicHelp = [
                '*Available Commands:*',
                '#verify [code] - Verify your account with the unique code',
                '#help - Show this help message',
                '#ping - Test response time'
            ].join('\n');
            
            await safeSendReply(msg, basicHelp);
            
            // Check user verification for additional commands
            const user = await getVerifiedUser(msg.from);
            if (user) {
                const verifiedHelp = [
                    '\n*Additional commands for verified users:*',
                    'Send any media file to save it to your account',
                    '#files - List your recently uploaded files',
                    '#files [category] - List files in a specific category',
                    '#search [keyword] - Search your files for a keyword'
                ].join('\n');
                
                await safeSendReply(msg, verifiedHelp);
            }
            
            return;
        }

        // Check user verification
        const user = await getVerifiedUser(msg.from);
        if (!user) {
            console.log(`Unverified user or number not found: ${msg.from}`);
            if (msg.body && !msg.body.startsWith('#')) {
                // If it's a regular message and not a command, send a hint
                await safeSendReply(msg, 'Please verify your account first. Use the #verify command followed by your unique code. Or type #help for assistance.');
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

// Create a faster user lookup function using cache
async function getVerifiedUser(phoneNumber) {
    // Fast path: check cache first
    if (PERFORMANCE_MODE && userCache.has(phoneNumber)) {
        return userCache.get(phoneNumber);
    }
    
    // Slow path: database lookup
    const user = await User.findOne({ whatsappNumber: phoneNumber, isVerified: true }).lean();
    
    // Update cache for future lookups
    if (user && PERFORMANCE_MODE) {
        userCache.set(phoneNumber, user);
    }
    
    return user;
}

// If safePageOperation doesn't exist, add this function, otherwise update it
async function safePageOperation(operation, fallbackValue = null) {
    try {
        // Check if client is initialized
        if (!client.pupBrowser || !client.pupPage) {
            console.log('[SafeOperation] Browser/Page not available');
            return fallbackValue;
        }
        
        // Check if page is closed
        try {
            const closed = client.pupPage.isClosed();
            if (closed) {
                console.log('[SafeOperation] Page is closed');
                return fallbackValue;
            }
        } catch (checkError) {
            console.log('[SafeOperation] Error checking page state:', checkError.message);
            return fallbackValue;
        }
        
        // Execute the actual operation with timeout for safety
        return await Promise.race([
            operation(),
            new Promise((resolve) => setTimeout(() => {
                console.log('[SafeOperation] Operation timed out');
                resolve(fallbackValue);
            }, 10000)) // 10 second timeout
        ]);
    } catch (error) {
        // Handle specific errors
        if (error.message && (
            error.message.includes('Target closed') || 
            error.message.includes('Protocol error') ||
            error.message.includes('Session closed') ||
            error.message.includes('Target page, context or browser has been closed')
        )) {
            console.log('[SafeOperation] Browser target error:', error.message);
            
            // Mark client for reconnection if needed
            if (!isReconnecting) {
                console.log('[SafeOperation] Scheduling reconnection due to closed target');
                setTimeout(() => attemptReconnect(), 10000);
            }
            
            return fallbackValue;
        }
        
        // Other errors
        console.error('[SafeOperation] Operation error:', error);
        return fallbackValue;
    }
}

// Patch WhatsApp client methods that often cause Target closed errors
function patchClientMethods() {
    // Store original methods
    const originalGetState = client.getState;
    const originalDestroy = client.destroy;
    const originalInitialize = client.initialize;
    
    // Replace getState with safe version
    client.getState = async function() {
        return safePageOperation(async () => {
            return await originalGetState.call(client);
        }, 'DISCONNECTED');
    };
    
    // Replace destroy with safe version
    client.destroy = async function() {
        console.log('Safe destroy called');
        try {
            // First try to close pages if browser is available
            if (this.pupBrowser) {
                try {
                    const pages = await this.pupBrowser.pages().catch(() => []);
                    for (const page of pages) {
                        try {
                            await page.close().catch(() => {});
                        } catch (e) {
                            // Ignore page close errors
                        }
                    }
                } catch (e) {
                    // Ignore browser errors
                }
                
                // Try to close browser
                try {
                    await this.pupBrowser.close().catch(() => {});
                } catch (e) {
                    // Ignore browser close errors
                }
            }
            
            // Call original destroy
            try {
                await originalDestroy.call(this).catch(() => {});
            } catch (e) {
                // Ignore destroy errors
            }
            
            // Reset browser references
            this.pupBrowser = null;
            this.pupPage = null;
            
            return true;
        } catch (error) {
            console.error('Error in safe destroy:', error);
            
            // Even if there's an error, reset references
            this.pupBrowser = null;
            this.pupPage = null;
            
            return false;
        }
    };
    
    // Replace initialize with safe version
    client.initialize = async function() {
        console.log('Safe initialize called');
        try {
            // Ensure we're fully destroyed before initializing
            await this.destroy().catch(() => {});
            
            // Force garbage collection if available
            if (global.gc) {
                try {
                    global.gc();
                } catch (e) {
                    // Ignore GC errors
                }
            }
            
            // Wait a moment before initializing
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Add another error boundary specifically for initialization
            try {
                // Call original initialize
                return await originalInitialize.call(this);
            } catch (initError) {
                console.error('Error in initialization, attempting direct browser restart:', initError.message);
                
                // If this fails, try a more direct browser creation
                if (initError.message.includes('Protocol error') || 
                    initError.message.includes('Target closed')) {
                    console.log('Protocol error detected, trying alternative initialization...');
                    
                    // Wait longer before retrying
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    
                    // Try to initialize with a completely clean state
                    this.pupBrowser = null;
                    this.pupPage = null;
                    
                    // One last attempt
                    return await originalInitialize.call(this);
                }
                
                // Re-throw if not a protocol error
                throw initError;
            }
        } catch (error) {
            console.error('Error in safe initialize:', error);
            throw error;
        }
    };
    
    console.log('[Patch] Client methods patched for safe operation');
}

// Call the patch function during startup
patchClientMethods();

client.initialize();

// Export the client for use in other modules
module.exports = client;

// Add function to allow updating the client reference
// This is used for emergency resets without restarting the server
module.exports.updateClient = function(newClient) {
    try {
        // Update the reference
        clientRef = newClient;
        
        // If possible, modify the module.exports to also be the new client
        const originalExport = Object.assign({}, module.exports);
        
        // Replace the default export with the new client
        Object.setPrototypeOf(module.exports, Object.getPrototypeOf(newClient));
        Object.assign(module.exports, newClient);
        
        // Restore any custom properties/methods from the original export
        for (const [key, value] of Object.entries(originalExport)) {
            if (key !== 'updateClient' && typeof value === 'function') {
                module.exports[key] = value;
            }
        }
        
        // Make sure updateClient is still available
        module.exports.updateClient = originalExport.updateClient;
        
        return true;
    } catch (error) {
        console.error('Error in updateClient:', error);
        return false;
    }
};

