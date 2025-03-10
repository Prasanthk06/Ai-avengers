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
const STABLE_CLIENT_ID = "main-whatsapp-client";

// Performance settings
const PERFORMANCE_CONFIG = {
    DEBUG_MODE: true,
    REDUCE_DELAYS: true,
    PERFORMANCE_MODE: true,
    PRELOAD_USER_DATA: true,
    MAX_CONCURRENT_OPERATIONS: 10,
    DIRECT_REPLY_MODE: true
};

// QR code settings
const QR_CONFIG = {
    MAX_REGENERATIONS: 5,
    THRESHOLD_COOLDOWN: 60000, // 1 minute cooldown if too many QRs
    THROTTLE_MS: 30000 // Minimum 30 seconds between QR generations
};

// Reconnection settings
const RECONNECT_CONFIG = {
    STANDARD_DELAY: 15000, // 15 seconds
    COOLDOWN_PERIOD: 180000, // 3 minutes
    MIN_ACTIVITY_CHECK: 15, // minutes
    CONNECTION_CHECK_INTERVAL: 300000 // 5 minutes
};

// Client reference for external updates
let clientRef;

// Runtime variables - centralize all state variables
const STATE = {
    qrRegenerationCount: 0,
    lastQrGeneration: 0,
    isReconnecting: false,
    connectionAttempts: 0,
    isInitialized: false,
    lastStatusCheck: Date.now(),
    lastConnectionCheck: Date.now(),
    reconnectTimer: null
};

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
    if (PERFORMANCE_CONFIG.DIRECT_REPLY_MODE && PERFORMANCE_CONFIG.PERFORMANCE_MODE) {
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

// Add a centralized QR code generation function
async function generateAndSaveQrCode(qrString) {
    if (!qrString || typeof qrString !== 'string') {
        console.log('Invalid QR string provided');
        return null;
    }
    
    try {
        // 1. Generate and display QR in terminal
        qrcode.generate(qrString, { small: true });
        console.log(`QR Code generated at ${new Date().toISOString()}`);
        
        // 2. Save QR to file for web interface
        const qrPath = path.join(process.cwd(), 'public', 'latest-qr.png');
        const qrCode = require('qr-image');
        const qrImg = qrCode.image(qrString, { type: 'png' });
        
        // Create a promise for the file write operation
        return new Promise((resolve, reject) => {
            const qrStream = fs.createWriteStream(qrPath);
            
            qrImg.pipe(qrStream);
            
            // Handle successful completion
            qrStream.on('finish', () => {
                // Update global timestamp
                global.lastQrTimestamp = new Date().toISOString();
                console.log(`QR Code saved to file: ${qrPath}`);
                resolve({
                    success: true,
                    path: qrPath,
                    timestamp: global.lastQrTimestamp
                });
            });
            
            // Handle errors
            qrStream.on('error', (err) => {
                console.log('Error saving QR file:', err.message);
                reject(err);
            });
        });
    } catch (error) {
        console.log('Error generating QR code:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// Export the QR generation function
module.exports.generateQrCode = generateAndSaveQrCode;

// Update setupClientEventHandlers to use the centralized QR generation function
function setupClientEventHandlers(clientInstance) {
    if (!clientInstance) return;
    
    // QR code event
    clientInstance.on('qr', async (qr) => {
        // Throttle QR code regeneration to prevent flooding
        const now = Date.now();
        
        // Check throttling
        if (STATE.qrRegenerationCount++ > QR_CONFIG.MAX_REGENERATIONS) {
            console.log('Too many QR regenerations, pausing client...');
            await new Promise(r => setTimeout(r, QR_CONFIG.THRESHOLD_COOLDOWN));
            STATE.qrRegenerationCount = 0;
        }
        
        // Generate and save QR code
        await generateAndSaveQrCode(qr).catch(err => {
            console.log('Failed to save QR code:', err.message);
        });
        
        // Update the last generation timestamp
        STATE.lastQrGeneration = now;
    });
    
    // Ready event
    clientInstance.on('ready', async () => {
        console.log('WhatsApp client is ready!');
        STATE.isInitialized = true;
        STATE.lastStatusCheck = Date.now();
        STATE.connectionAttempts = 0;
        STATE.qrRegenerationCount = 0;
        
        // Reset reconnection flags
        STATE.isReconnecting = false;
        
        // Log client info for debugging
        try {
            if (!clientInstance.pupPage?.isClosed()) {
                console.log('WhatsApp Web version:', clientInstance.info?.wid || 'Unknown');
            }
        } catch (e) {
            console.log('Error getting client info:', e.message);
        }
    });
    
    // Disconnect event
    clientInstance.on('disconnected', async (reason) => {
        console.log('WhatsApp client was disconnected:', reason);
        STATE.isInitialized = false;
        
        // Wait a bit before attempting to reconnect
        await new Promise(r => setTimeout(r, 5000));
        
        // Only reconnect if not already reconnecting
        if (!STATE.isReconnecting) {
            await attemptReconnect();
        }
    });
    
    // Authenticated event
    clientInstance.on('authenticated', () => {
        console.log('WhatsApp client authenticated!');
        // Reset QR counters on successful authentication
        STATE.qrRegenerationCount = 0;
        STATE.connectionAttempts = 0;
        
        if (clientInstance.info) {
            console.log('Connected as:', clientInstance.info.wid.user);
        }
    });
    
    // Auth failure event
    clientInstance.on('auth_failure', msg => {
        console.log('Authentication failed:', msg);
        STATE.connectionAttempts++;
    });
    
    // Message create event
    clientInstance.on('message_create', async (msg) => {
        // Only process self-messages with # commands
        if (clientInstance.info && msg.from === clientInstance.info.wid._serialized && msg.body.startsWith('#')) {
            console.log('Admin command received:', msg.body);
            // Process admin commands (code omitted for brevity)
        }
    });
    
    // Message event
    clientInstance.on('message', async msg => {
        // Process incoming messages (code omitted for brevity)
        // This was previously implemented in the client initialization section
    });
    
    return clientInstance;
}

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

// Set up event handlers for the initial client
setupClientEventHandlers(client);

// Initialize the client
client.initialize().then(() => {
    console.log('Client initialized, starting connection monitor');
    startConnectionMonitor();
}).catch(err => {
    console.error('Failed to initialize client:', err);
});

// Keep-alive strategy
// This will regularly check if the client is still connected and try to reconnect if not
let lastConnectionCheck = Date.now();
let connectionMonitor;
let isReconnectingFromTimeout = false;
let reconnectTimer = null;

// Start connection monitoring
function startConnectionMonitor() {
    // Clear existing interval if it exists
    if (global.connectionCheckInterval) {
        clearInterval(global.connectionCheckInterval);
    }
    
    // Set up a new interval
    global.connectionCheckInterval = setInterval(async () => {
        if (STATE.isReconnecting) return; // Skip if already reconnecting
        
        try {
            // Get minutes since last status check
            const minutesSinceLastCheck = (Date.now() - STATE.lastStatusCheck) / (1000 * 60);
            console.log(`Connection monitor check: Last status check ${Math.round(minutesSinceLastCheck)} minutes ago`);
            
            // If more than defined threshold since last check, check if client is still responsive
            if (minutesSinceLastCheck > RECONNECT_CONFIG.MIN_ACTIVITY_CHECK) {
                const isAlive = await checkClientConnection();
                
                if (!isAlive) {
                    console.log('Client page is closed or unavailable for extended period, attempting reconnect...');
                    await attemptReconnect();
                } else {
                    console.log('Client connection is healthy');
                    STATE.lastStatusCheck = Date.now();
                    global.lastClientActivity = Date.now();
                }
            }
        } catch (e) {
            console.log('Error in connection monitor:', e.message);
        }
    }, RECONNECT_CONFIG.CONNECTION_CHECK_INTERVAL); // Check every 5 minutes
    
    console.log('Connection monitor started');
    return global.connectionCheckInterval;
}

// Utility function to check if the client connection is still alive
async function checkClientConnection() {
    if (!clientRef) return false;
    
    try {
        // Check if page is available
        const pageAvailable = await safePageOperation(async () => {
            return clientRef.pupPage && !clientRef.pupPage.isClosed();
        }, false);
        
        if (!pageAvailable) {
            console.log('Client page is not available');
            return false;
        }
        
        // Try to get state
        const state = await clientRef.getState().catch(e => {
            console.log('Error getting client state:', e.message);
            return null;
        });
        
        if (!state || state === 'DISCONNECTED') {
            console.log('Client is disconnected');
            return false;
        }
        
        // Additional check for authenticated state
        if (clientRef.info && clientRef.info.wid) {
            // Client has valid user info - definitely connected
            return true;
        }
        
        return true;
    } catch (error) {
        console.log('Error checking client connection:', error.message);
        return false;
    }
}

// Export the checkClientConnection function
module.exports.checkClientConnection = checkClientConnection;

// Shared function for client cleanup to avoid code duplication
async function cleanupClient(client, options = {}) {
    const { logPrefix = '', aggressive = false, waitTime = 5000 } = options;
    
    if (!client) {
        console.log(`${logPrefix}No client to clean up`);
        return;
    }
    
    try {
        console.log(`${logPrefix}Starting client cleanup...`);
        
        // First try to destroy the client properly
        if (typeof client.destroy === 'function') {
            try {
                await client.destroy().catch(e => console.log(`${logPrefix}Client destroy error:`, e.message));
                console.log(`${logPrefix}Safe destroy called`);
            } catch (e) {
                console.log(`${logPrefix}Error during client destroy:`, e.message);
            }
        }
        
        // Force close browser if it exists
        if (client.pupBrowser) {
            try {
                await client.pupBrowser.close().catch(e => console.log(`${logPrefix}Browser close error:`, e.message));
            } catch (e) {
                console.log(`${logPrefix}Failed to close browser:`, e.message);
            }
        }
        
        // Clear references
        if (client.pupPage) client.pupPage = null;
        if (client.pupBrowser) client.pupBrowser = null;
        
        // More aggressive cleanup if requested
        if (aggressive) {
            // Clear auth strategy references
            if (client.authStrategy) {
                client.authStrategy.client = null;
            }
            
            // Clear any event listeners
            if (typeof client.removeAllListeners === 'function') {
                client.removeAllListeners();
            }
            
            // Force garbage collection if available
            if (global.gc) {
                try {
                    global.gc();
                    console.log(`${logPrefix}Forced garbage collection`);
                } catch (e) {
                    console.log(`${logPrefix}GC error:`, e.message);
                }
            }
            
            // Extra cleanup for persistent issues
            try {
                // Clear session files if needed
                if (options.clearSession) {
                    console.log(`${logPrefix}Cleaning up session files...`);
                    cleanupSessionFiles();
                }
            } catch (e) {
                console.log(`${logPrefix}Error during additional cleanup:`, e.message);
            }
        }
        
        console.log(`${logPrefix}Client cleanup completed, waiting ${waitTime/1000} seconds before continuing...`);
        
        // Wait for resources to be released
        if (waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    } catch (error) {
        console.log(`${logPrefix}Unexpected error during client cleanup:`, error.message);
    }
}

// Helper function to clean session files
function cleanupSessionFiles() {
    try {
        const sessionPath = path.join(AUTH_FOLDER_PATH, `session-${STABLE_CLIENT_ID}`);
        
        if (fs.existsSync(sessionPath)) {
            const tempFiles = ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 
                             'Default/Service Worker', 'Default/Session Storage'];
            
            for (const tempDir of tempFiles) {
                const fullPath = path.join(sessionPath, tempDir);
                if (fs.existsSync(fullPath)) {
                    try {
                        fs.rmSync(fullPath, { recursive: true, force: true });
                        console.log(`Cleaned up ${tempDir}`);
                    } catch (e) {
                        console.log(`Failed to clean ${tempDir}:`, e.message);
                    }
                }
            }
        }
    } catch (error) {
        console.log('Error cleaning session files:', error.message);
    }
}

// Helper function to create a new client with consistent configuration
function createNewClient(options = {}) {
    const { timeoutMultiplier = 1, clientId = STABLE_CLIENT_ID } = options;
    
    // Create fresh auth strategy
    const freshAuthStrategy = new LocalAuth({
        clientId: clientId,
        dataPath: AUTH_FOLDER_PATH
    });
    
    // Create a new client with consistent configuration
    return new Client({
        authStrategy: freshAuthStrategy,
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
                '--js-flags=--expose-gc',
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
            timeout: 120000 * timeoutMultiplier,
            protocolTimeout: 60000 * timeoutMultiplier
        },
        authTimeoutMs: 120000 * timeoutMultiplier,
        queueMessages: false,
        restartOnCrash: true,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        webVersionCache: { 
            type: 'remote',
            remotePath: 'https://web.whatsapp.com'
        }
    });
}

// Updated forceReconnect function using shared helpers
async function forceReconnect() {
    console.log('Force reconnect requested - handling potential phantom connection');
    
    if (STATE.isReconnecting) {
        console.log('Reconnection already in progress, waiting...');
        return false;
    }
    
    STATE.isReconnecting = true;
    
    try {
        // 1. Try to get the current state to confirm if we're in a phantom state
        let currentState = 'UNKNOWN';
        try {
            if (clientRef) {
                currentState = await clientRef.getState().catch(() => 'ERROR');
            }
        } catch (e) {
            console.log('Error getting state during force reconnect:', e.message);
        }
        
        console.log(`Current client state before force reconnect: ${currentState}`);
        
        // 2. Perform an aggressive cleanup
        await cleanupClient(clientRef, {
            logPrefix: '[ForceReconnect] ',
            aggressive: true,
            clearSession: true,
            waitTime: 10000
        });
        
        // 3. Create a completely new client instance
        try {
            console.log('Creating new client instance after force reconnect');
            
            // Create with extended timeouts for reliability
            const newClient = createNewClient({ timeoutMultiplier: 1.5 });
            
            // Set up event handlers
            setupClientEventHandlers(newClient);
            
            // Initialize the new client
            console.log('Initializing new client instance after force reconnect...');
            await newClient.initialize();
            
            // Update client references
            clientRef = newClient;
            
            // Update the exported client module
            if (module.exports.updateClient) {
                module.exports.updateClient(newClient);
                console.log('Client reference updated successfully after force reconnect');
            }
            
            // Reset state variables
            STATE.isReconnecting = false;
            STATE.connectionAttempts = 0;
            STATE.qrRegenerationCount = 0;
            STATE.lastStatusCheck = Date.now();
            global.lastClientActivity = Date.now();
            
            console.log('Force reconnect completed successfully');
            return true;
            
        } catch (e) {
            console.error('Error creating new client during force reconnect:', e);
            return false;
        }
    } catch (e) {
        console.error('Error in force reconnect:', e);
        return false;
    } finally {
        // Ensure we reset the reconnecting flag even on error
        setTimeout(() => {
            STATE.isReconnecting = false;
            console.log('Force reconnect cooldown completed');
        }, 60000); // 1 minute cooldown
    }
}

// Updated attemptReconnect function using shared helpers
async function attemptReconnect() {
    if (STATE.isReconnecting) return;
    
    STATE.isReconnecting = true;
    console.log('Attempting to reconnect WhatsApp client...');
    
    try {
        // Perform standard cleanup
        await cleanupClient(clientRef, {
            logPrefix: '[Reconnect] ',
            aggressive: false,
            waitTime: RECONNECT_CONFIG.STANDARD_DELAY
        });
        
        // Reset QR throttling counters
        STATE.qrRegenerationCount = 0;
        STATE.lastQrGeneration = 0;
        
        // Create a new client instance
        try {
            console.log('Safe initialize called');
            
            // Create a new client with standard configuration
            const newClient = createNewClient();
            
            // Set up event handlers
            setupClientEventHandlers(newClient);
            
            // Initialize the new client
            console.log('Initializing new client instance...');
            await newClient.initialize();
            
            // Update client references
            clientRef = newClient;
            
            // For compatibility, also patch the exported client module
            if (module.exports.updateClient) {
                module.exports.updateClient(newClient);
                console.log('Client reference updated successfully');
            }
            
            console.log('Client reinitialized successfully with new instance');
            
            // Patch methods just to be safe
            patchClientMethods();
        } catch (initError) {
            console.log('Error in safe initialize:', initError);
            throw initError; // Rethrow to be caught by outer try/catch
        }
    } catch (error) {
        console.log('Reconnection attempt failed:', error.message);
    } finally {
        // Longer cooldown between reconnection attempts
        setTimeout(() => {
            STATE.isReconnecting = false;
            console.log('Reconnection cooldown completed');
        }, RECONNECT_CONFIG.COOLDOWN_PERIOD);
    }
}

client.on('ready', async () => {
    console.log('Client is ready!');
    
    if (PERFORMANCE_CONFIG.PRELOAD_USER_DATA && PERFORMANCE_CONFIG.PERFORMANCE_MODE) {
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
    }, RECONNECT_CONFIG.CONNECTION_CHECK_INTERVAL);
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
    // Check if we've generated QR codes too frequently
    const now = Date.now();
    const timeSinceLastQr = now - STATE.lastQrGeneration;
    
    // If we regenerated QR too quickly or too many times, throttle it
    if (timeSinceLastQr < QR_CONFIG.THROTTLE_MS) {
        STATE.qrRegenerationCount++;
        console.log(`QR regeneration too frequent (${Math.round(timeSinceLastQr/1000)}s), throttling. Count: ${STATE.qrRegenerationCount}/${QR_CONFIG.MAX_REGENERATIONS}`);
        
        if (STATE.qrRegenerationCount > QR_CONFIG.MAX_REGENERATIONS) {
            console.log('Too many QR regenerations, pausing client...');
            // Add a longer delay before allowing another QR
            setTimeout(() => {
                STATE.qrRegenerationCount = 0; // Reset counter after cooling down
                console.log('QR throttling reset after cooling period');
            }, 2 * 60 * 1000); // 2 minute cooling period
            return;
        }
        
        return; // Skip generating a new QR code
    }
    
    // We passed the throttle check, update the timestamp and reset counter if needed
    STATE.lastQrGeneration = now;
    if (timeSinceLastQr > 2 * QR_CONFIG.THROTTLE_MS) {
        STATE.qrRegenerationCount = 0; // Reset counter if it's been a while
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
        if (PERFORMANCE_CONFIG.REDUCE_DELAYS && PERFORMANCE_CONFIG.PERFORMANCE_MODE) {
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
        if (PERFORMANCE_CONFIG.DEBUG_MODE) {
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
    if (PERFORMANCE_CONFIG.PERFORMANCE_MODE && userCache.has(phoneNumber)) {
        return userCache.get(phoneNumber);
    }
    
    // Slow path: database lookup
    const user = await User.findOne({ whatsappNumber: phoneNumber, isVerified: true }).lean();
    
    // Update cache for future lookups
    if (user && PERFORMANCE_CONFIG.PERFORMANCE_MODE) {
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
            if (!STATE.isReconnecting) {
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

// Export the setupClientEventHandlers function for use in server.js
module.exports.setupClientEventHandlers = setupClientEventHandlers;

// Export the forceReconnect function
module.exports.forceReconnect = forceReconnect;

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

