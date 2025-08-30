// index.js - Main bot file with all requirements implemented

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    jidNormalizedUser,
    getContentType,
    fetchLatestBaileysVersion,
    Browsers,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
    proto
} = require('@whiskeysockets/baileys');

const { getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson } = require('./lib/functions');
const fs = require('fs');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const util = require('util');
const { sms, downloadMediaMessage } = require('./lib/msg');
const axios = require('axios');
const express = require('express');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const path = require('path');
const { File } = require('megajs');
require('dotenv').config();

// Configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://Didula:DidulaMD@didulamd.mgwjqat.mongodb.net/Didulamd?retryWrites=true&w=majority';
process.env.NODE_ENV = 'production';
process.env.PM2_NAME = 'devil-tech-md-session';

console.log('🚀 Auto Session Manager initialized with MongoDB Atlas');

const config = {
    // General Bot Settings
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💗', '🔥'],

    // Newsletter Auto-React Settings
    AUTO_REACT_NEWSLETTERS: 'true',
    NEWSLETTER_JIDS: [
        '120363402033322416@newsletter',
        '120363403158436908@newsletter',
        '120363421499257491@newsletter',
        '120363420895783008@newsletter'
    ],
    NEWSLETTER_REACT_EMOJIS: ['❤️', '🪄', '🩷'],

    // Auto Session Management
    AUTO_SAVE_INTERVAL: 120000,
    AUTO_CLEANUP_INTERVAL: 300000,
    AUTO_RECONNECT_INTERVAL: 300000,
    AUTO_RESTORE_INTERVAL: 3600000,
    MONGODB_SYNC_INTERVAL: 600000,
    MAX_SESSION_AGE: 2592000000,
    DISCONNECTED_CLEANUP_TIME: 180000,
    MAX_FAILED_ATTEMPTS: 2,
    INITIAL_RESTORE_DELAY: 10000,
    IMMEDIATE_DELETE_DELAY: 120000,

    // Command Settings
    PREFIX: '.',
    MAX_RETRIES: 3,

    // Group & Channel Settings
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/Hc1ca2KOSiPLT52IqET45J',
    NEWSLETTER_JID: '120363403158436908@newsletter',
    NEWSLETTER_MESSAGE_ID: '291',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbAua1VK5cDL3AtIEP3I',

    // Owner Details
    OWNER_NUMBER: '94741671668',
    ADMIN_NUMBERS: ['94741671668', '94718913389']
};

// MongoDB Schemas
const sessionSchema = new mongoose.Schema({
    number: { type: String, unique: true, required: true },
    sessionData: { type: Object, required: true },
    status: { 
        type: String, 
        enum: ['active', 'disconnected', 'invalid', 'failed'],
        default: 'active'
    },
    health: {
        type: String,
        enum: ['active', 'reconnecting', 'disconnected'],
        default: 'active'
    },
    failedAttempts: { type: Number, default: 0 },
    lastActive: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const userConfigSchema = new mongoose.Schema({
    number: { type: String, unique: true, required: true },
    config: { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', sessionSchema);
const UserConfig = mongoose.model('UserConfig', userConfigSchema);

// Global variables
const activeSessions = new Map();
const sessionHealthMap = new Map();
const pendingSaves = new Map();
const reconnectionAttempts = new Map();
let mongoConnected = false;

// Express app setup
const app = express();
app.use(express.json());
const port = process.env.PORT || 8000;

// MongoDB Connection
async function connectMongoDB() {
    try {
        await mongoose.connect(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        mongoConnected = true;
        console.log('✅ MongoDB Atlas connected successfully');
        return true;
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error.message);
        mongoConnected = false;
        setTimeout(connectMongoDB, 30000);
        return false;
    }
}

// Sanitize phone number
function sanitizeNumber(number) {
    return number.replace(/[^0-9]/g, '');
}

// Initialize directories
function initializeDirectories() {
    const dirs = ['./auth_info_baileys', './temp', './logs'];
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// Session health monitoring
function updateSessionHealth(number, health) {
    sessionHealthMap.set(number, {
        health,
        lastUpdate: new Date(),
        uptime: process.uptime()
    });
}

// Save session to MongoDB
async function saveSessionToMongoDB(number, sessionData) {
    try {
        if (!mongoConnected) {
            pendingSaves.set(number, sessionData);
            return false;
        }

        await Session.findOneAndUpdate(
            { number },
            {
                sessionData,
                status: 'active',
                health: 'active',
                lastActive: new Date(),
                updatedAt: new Date(),
                failedAttempts: 0
            },
            { upsert: true, new: true }
        );

        pendingSaves.delete(number);
        console.log(`✅ Session saved to MongoDB: ${number}`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to save session ${number}:`, error.message);
        pendingSaves.set(number, sessionData);
        return false;
    }
}

// Restore sessions from MongoDB
async function restoreSessionsFromMongoDB() {
    try {
        if (!mongoConnected) {
            console.log('⚠️ MongoDB not connected, skipping restoration');
            return [];
        }

        const sessions = await Session.find({ 
            status: { $in: ['active', 'disconnected'] },
            lastActive: { $gte: new Date(Date.now() - config.MAX_SESSION_AGE) }
        });

        console.log(`📦 Found ${sessions.length} sessions to restore`);

        for (const session of sessions) {
            if (!activeSessions.has(session.number)) {
                console.log(`🔄 Restoring session: ${session.number}`);
                await createWhatsAppSession(session.number, session.sessionData);
                await sleep(2000);
            }
        }

        return sessions;
    } catch (error) {
        console.error('❌ Failed to restore sessions:', error.message);
        return [];
    }
}

// Clean inactive sessions
async function cleanupInactiveSessions() {
    try {
        const cutoffTime = new Date(Date.now() - config.DISCONNECTED_CLEANUP_TIME);
        
        const inactiveSessions = await Session.find({
            $or: [
                { status: 'disconnected', lastActive: { $lt: cutoffTime } },
                { status: 'failed' },
                { status: 'invalid' }
            ]
        });

        for (const session of inactiveSessions) {
            console.log(`🗑️ Cleaning up inactive session: ${session.number}`);
            
            // Close active connection if exists
            if (activeSessions.has(session.number)) {
                const conn = activeSessions.get(session.number);
                try {
                    await conn.logout();
                } catch (e) {}
                activeSessions.delete(session.number);
            }

            // Remove from database
            await Session.deleteOne({ number: session.number });
            
            // Clean auth files
            const authPath = `./auth_info_baileys/${session.number}`;
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
            }
        }

        console.log(`✅ Cleaned up ${inactiveSessions.length} inactive sessions`);
    } catch (error) {
        console.error('❌ Cleanup failed:', error.message);
    }
}

// Create WhatsApp session
async function createWhatsAppSession(number, existingAuth = null) {
    const sanitized = sanitizeNumber(number);
    const authPath = `./auth_info_baileys/${sanitized}`;
    
    if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true });
    }

    // If existing auth provided, save it
    if (existingAuth && existingAuth.creds) {
        fs.writeFileSync(`${authPath}/creds.json`, JSON.stringify(existingAuth.creds));
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
        logger: P({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.macOS("Safari"),
        syncFullHistory: false,
        auth: state,
        version,
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            return { conversation: 'hello' };
        }
    });

    // Store connection
    activeSessions.set(sanitized, conn);
    updateSessionHealth(sanitized, 'active');

    // Connection update handler
    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`📱 QR Code for ${sanitized}:`);
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                const attempts = reconnectionAttempts.get(sanitized) || 0;
                
                if (attempts < config.MAX_FAILED_ATTEMPTS) {
                    console.log(`🔄 Reconnecting ${sanitized} (Attempt ${attempts + 1}/${config.MAX_FAILED_ATTEMPTS})`);
                    reconnectionAttempts.set(sanitized, attempts + 1);
                    updateSessionHealth(sanitized, 'reconnecting');
                    
                    setTimeout(() => {
                        createWhatsAppSession(sanitized);
                    }, 5000);
                } else {
                    console.log(`❌ Max reconnection attempts reached for ${sanitized}`);
                    await Session.findOneAndUpdate(
                        { number: sanitized },
                        { status: 'failed', health: 'disconnected' }
                    );
                    activeSessions.delete(sanitized);
                    updateSessionHealth(sanitized, 'disconnected');
                }
            } else {
                console.log(`🔒 Session logged out: ${sanitized}`);
                await Session.findOneAndUpdate(
                    { number: sanitized },
                    { status: 'invalid' }
                );
                activeSessions.delete(sanitized);
            }
        } else if (connection === 'open') {
            console.log(`✅ WhatsApp connected: ${sanitized}`);
            reconnectionAttempts.delete(sanitized);
            updateSessionHealth(sanitized, 'active');
            
            // Save session to MongoDB
            const authState = {
                creds: state.creds,
                keys: state.keys
            };
            await saveSessionToMongoDB(sanitized, authState);

            // Load plugins
            loadPlugins();

            // Send connection notification
            const admins = config.ADMIN_NUMBERS.map(num => `${num}@s.whatsapp.net`);
            for (const admin of admins) {
                await conn.sendMessage(admin, {
                    text: `🤖 *Bot Connected Successfully*\n\n` +
                          `📱 Number: ${sanitized}\n` +
                          `⏰ Time: ${moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss')}\n` +
                          `📊 Status: Active\n` +
                          `🔧 Prefix: ${config.PREFIX}`
                });
            }

            // Auto-join group
            if (config.GROUP_INVITE_LINK) {
                try {
                    const inviteCode = config.GROUP_INVITE_LINK.split('/').pop();
                    await conn.groupAcceptInvite(inviteCode);
                    console.log('✅ Auto-joined group');
                } catch (e) {
                    console.error('Failed to join group:', e.message);
                }
            }

            // Follow newsletters
            if (config.AUTO_REACT_NEWSLETTERS === 'true') {
                for (const newsletterJid of config.NEWSLETTER_JIDS) {
                    try {
                        await conn.newsletterFollow(newsletterJid);
                        console.log(`✅ Following newsletter: ${newsletterJid}`);
                    } catch (e) {
                        console.error(`Failed to follow ${newsletterJid}:`, e.message);
                    }
                }
            }
        }
    });

    // Save credentials
    conn.ev.on('creds.update', async () => {
        await saveCreds();
        const authState = {
            creds: state.creds,
            keys: state.keys
        };
        await saveSessionToMongoDB(sanitized, authState);
    });

    // Message handler
    conn.ev.on('messages.upsert', async (mek) => {
        try {
            await handleMessage(conn, mek, sanitized);
        } catch (error) {
            console.error('Message handling error:', error);
        }
    });

    return conn;
}

// Message handler
async function handleMessage(conn, mek, sessionNumber) {
    const msg = mek.messages[0];
    if (!msg.message) return;

    msg.message = (getContentType(msg.message) === 'ephemeralMessage') 
        ? msg.message.ephemeralMessage.message 
        : msg.message;

    const from = msg.key.remoteJid;
    
    // Auto-view status
    if (from === 'status@broadcast' && config.AUTO_VIEW_STATUS === 'true') {
        await conn.readMessages([msg.key]);
        
        // Set recording presence
        if (config.AUTO_RECORDING === 'true') {
            await conn.sendPresenceUpdate('recording', from);
        }

        // Auto-react to status
        if (config.AUTO_LIKE_STATUS === 'true') {
            const emoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
            await conn.sendMessage(from, {
                react: { text: emoji, key: msg.key }
            });
        }
        return;
    }

    // Auto-react to newsletters
    if (from.endsWith('@newsletter') && 
        config.AUTO_REACT_NEWSLETTERS === 'true' && 
        config.NEWSLETTER_JIDS.includes(from)) {
        
        const emoji = config.NEWSLETTER_REACT_EMOJIS[Math.floor(Math.random() * config.NEWSLETTER_REACT_EMOJIS.length)];
        try {
            await conn.sendMessage(from, {
                react: { text: emoji, key: msg.key }
            });
            console.log(`✅ Reacted to newsletter ${from} with ${emoji}`);
        } catch (e) {
            console.error('Newsletter react failed:', e.message);
        }
        return;
    }

    // Process regular messages
    const m = sms(conn, msg);
    const type = getContentType(msg.message);
    const body = m.body || '';
    const isCmd = body.startsWith(config.PREFIX);
    const command = isCmd ? body.slice(config.PREFIX.length).trim().split(' ')[0].toLowerCase() : '';
    const args = body.trim().split(/ +/).slice(1);
    const q = args.join(' ');
    const isGroup = from.endsWith('@g.us');
    const sender = msg.key.fromMe ? conn.user.id : (msg.key.participant || msg.key.remoteJid);
    const senderNumber = sender.split('@')[0];
    const pushname = msg.pushName || 'User';
    const isOwner = config.ADMIN_NUMBERS.includes(senderNumber);

    // Command handling
    if (isCmd) {
        const events = require('./command');
        const cmd = events.commands.find((cmd) => 
            cmd.pattern === command || 
            (cmd.alias && cmd.alias.includes(command))
        );

        if (cmd) {
            if (cmd.react) {
                await conn.sendMessage(from, { 
                    react: { text: cmd.react, key: msg.key }
                });
            }

            try {
                await cmd.function(conn, msg, m, {
                    from, body, isCmd, command, args, q, 
                    isGroup, sender, senderNumber, pushname, 
                    isOwner, sessionNumber
                });
            } catch (error) {
                console.error(`[PLUGIN ERROR] ${command}:`, error);
                await conn.sendMessage(from, {
                    text: '❌ An error occurred while executing this command.'
                }, { quoted: msg });
            }
        }
    }
}

// Load plugins
function loadPlugins() {
    const pluginsPath = './plugins';
    if (fs.existsSync(pluginsPath)) {
        fs.readdirSync(pluginsPath).forEach((plugin) => {
            if (path.extname(plugin).toLowerCase() === '.js') {
                delete require.cache[require.resolve(`${pluginsPath}/${plugin}`)];
                require(`${pluginsPath}/${plugin}`);
            }
        });
        console.log('✅ Plugins loaded successfully');
    }
}

// Auto-management intervals
function startAutoManagement() {
    // Auto-save active sessions
    setInterval(async () => {
        console.log('💾 Auto-saving active sessions...');
        for (const [number, conn] of activeSessions.entries()) {
            if (conn.user) {
                const authPath = `./auth_info_baileys/${number}`;
                if (fs.existsSync(`${authPath}/creds.json`)) {
                    const creds = JSON.parse(fs.readFileSync(`${authPath}/creds.json`));
                    await saveSessionToMongoDB(number, { creds });
                }
            }
        }
    }, config.AUTO_SAVE_INTERVAL);

    // Auto-cleanup inactive sessions
    setInterval(async () => {
        console.log('🧹 Running auto-cleanup...');
        await cleanupInactiveSessions();
    }, config.AUTO_CLEANUP_INTERVAL);

    // Auto-reconnect failed sessions
    setInterval(async () => {
        console.log('🔄 Checking for reconnection...');
        const sessions = await Session.find({ 
            status: 'disconnected',
            failedAttempts: { $lt: config.MAX_FAILED_ATTEMPTS }
        });

        for (const session of sessions) {
            if (!activeSessions.has(session.number)) {
                console.log(`🔄 Attempting to reconnect: ${session.number}`);
                await createWhatsAppSession(session.number, session.sessionData);
                await sleep(2000);
            }
        }
    }, config.AUTO_RECONNECT_INTERVAL);

    // Auto-restore from MongoDB
    setInterval(async () => {
        console.log('📥 Auto-restoring sessions from MongoDB...');
        await restoreSessionsFromMongoDB();
    }, config.AUTO_RESTORE_INTERVAL);

    // MongoDB sync for pending saves
    setInterval(async () => {
        if (pendingSaves.size > 0 && mongoConnected) {
            console.log(`📤 Syncing ${pendingSaves.size} pending saves...`);
            for (const [number, sessionData] of pendingSaves.entries()) {
                await saveSessionToMongoDB(number, sessionData);
            }
        }
    }, config.MONGODB_SYNC_INTERVAL);
}

// API Endpoints
app.get('/', async (req, res) => {
    const { number } = req.query;
    
    if (!number) {
        return res.status(400).json({
            success: false,
            message: 'Phone number required',
            usage: '/?number=94XXXXXXXXX'
        });
    }

    const sanitized = sanitizeNumber(number);
    
    if (activeSessions.has(sanitized)) {
        return res.json({
            success: true,
            message: 'Session already active',
            number: sanitized,
            health: sessionHealthMap.get(sanitized)
        });
    }

    try {
        await createWhatsAppSession(sanitized);
        res.json({
            success: true,
            message: 'Session creation initiated',
            number: sanitized
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to create session',
            error: error.message
        });
    }
});

app.get('/active', async (req, res) => {
    const sessions = [];
    
    for (const [number, conn] of activeSessions.entries()) {
        const dbSession = await Session.findOne({ number });
        sessions.push({
            number,
            status: dbSession?.status || 'unknown',
            health: sessionHealthMap.get(number),
            user: conn.user || null,
            uptime: process.uptime()
        });
    }

    res.json({
        success: true,
        count: sessions.length,
        sessions
    });
});

app.get('/ping', (req, res) => {
    res.json({
        success: true,
        message: 'pong',
        timestamp: new Date(),
        uptime: process.uptime(),
        mongodb: mongoConnected,
        activeSessions: activeSessions.size
    });
});

app.get('/sync-mongodb', async (req, res) => {
    try {
        const synced = [];
        
        for (const [number, sessionData] of pendingSaves.entries()) {
            const saved = await saveSessionToMongoDB(number, sessionData);
            if (saved) synced.push(number);
        }

        res.json({
            success: true,
            message: 'MongoDB sync completed',
            synced
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Sync failed',
            error: error.message
        });
    }
});

app.get('/session-health', (req, res) => {
    const health = [];
    
    for (const [number, data] of sessionHealthMap.entries()) {
        health.push({
            number,
            ...data
        });
    }

    res.json({
        success: true,
        sessions: health,
        overall: {
            total: activeSessions.size,
            active: Array.from(sessionHealthMap.values()).filter(s => s.health === 'active').length,
            reconnecting: Array.from(sessionHealthMap.values()).filter(s => s.health === 'reconnecting').length,
            disconnected: Array.from(sessionHealthMap.values()).filter(s => s.health === 'disconnected').length
        }
    });
});

app.get('/restore-all', async (req, res) => {
    try {
        const restored = await restoreSessionsFromMongoDB();
        res.json({
            success: true,
            message: 'Restoration initiated',
            count: restored.length
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Restoration failed',
            error: error.message
        });
    }
});

app.get('/cleanup', async (req, res) => {
    try {
        await cleanupInactiveSessions();
        res.json({
            success: true,
            message: 'Cleanup completed'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Cleanup failed',
            error: error.message
        });
    }
});

app.delete('/session/:number', async (req, res) => {
    const { number } = req.params;
    const sanitized = sanitizeNumber(number);

    try {
        // Close connection
        if (activeSessions.has(sanitized)) {
            const conn = activeSessions.get(sanitized);
            await conn.logout();
            activeSessions.delete(sanitized);
        }

        // Remove from database
        await Session.deleteOne({ number: sanitized });

        // Clean files
        const authPath = `./auth_info_baileys/${sanitized}`;
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }

        res.json({
            success: true,
            message: 'Session deleted successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to delete session',
            error: error.message
        });
    }
});

app.get('/mongodb-status', (req, res) => {
    res.json({
        success: true,
        connected: mongoConnected,
        connectionState: mongoose.connection.readyState,
        pendingSaves: pendingSaves.size,
        host: mongoose.connection.host,
        name: mongoose.connection.name
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    // Save all active sessions
    for (const [number, conn] of activeSessions.entries()) {
        try {
            const authPath = `./auth_info_baileys/${number}`;
            if (fs.existsSync(`${authPath}/creds.json`)) {
                const creds = JSON.parse(fs.readFileSync(`${authPath}/creds.json`));
                await saveSessionToMongoDB(number, { creds });
            }
            await conn.ws.close();
        } catch (e) {}
    }

    // Close MongoDB connection
    await mongoose.connection.close();
    
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await mongoose.connection.close();
    process.exit(0);
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't exit in production - PM2 will handle restart if needed
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Helper function for initial session restoration from config
async function loadInitialSession() {
    if (config.SESSION_ID) {
        try {
            console.log('📥 Loading initial session from config...');
            const sessdata = config.SESSION_ID;
            const filer = File.fromURL(`https://mega.nz/file/${sessdata}`);
            
            filer.download((err, data) => {
                if (err) {
                    console.error('Failed to download session:', err);
                    return;
                }
                
                const authPath = `./auth_info_baileys/${config.OWNER_NUMBER}`;
                if (!fs.existsSync(authPath)) {
                    fs.mkdirSync(authPath, { recursive: true });
                }
                
                fs.writeFileSync(`${authPath}/creds.json`, data);
                console.log('✅ Initial session downloaded');
                
                // Create WhatsApp session
                createWhatsAppSession(config.OWNER_NUMBER);
            });
        } catch (error) {
            console.error('Failed to load initial session:', error);
        }
    }
}

// Main initialization
async function initialize() {
    console.log('🚀 Initializing WhatsApp Multi-Session Bot...');
    
    // Initialize directories
    initializeDirectories();
    
    // Connect to MongoDB
    await connectMongoDB();
    
    // Start Express server
    app.listen(port, () => {
        console.log(`🌐 Server running on http://localhost:${port}`);
    });
    
    // Start auto-management
    startAutoManagement();
    
    // Load initial session if available
    await loadInitialSession();
    
    // Restore sessions after delay
    setTimeout(async () => {
        console.log('📦 Starting initial session restoration...');
        await restoreSessionsFromMongoDB();
    }, config.INITIAL_RESTORE_DELAY);
}

// Start the bot
initialize().catch(console.error);

module.exports = {
    activeSessions,
    config,
    Session,
    UserConfig
};