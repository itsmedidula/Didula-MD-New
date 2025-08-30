const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  getContentType,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const { getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson } = require('./lib/functions');
const fs = require('fs');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const util = require('util');
const { sms, downloadMediaMessage } = require('./lib/msg');
const axios = require('axios');
const { File } = require('megajs');
const express = require('express');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const path = require('path');

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
  OWNER_NUMBERS: ['94741671668', '94718913389']
};

// MongoDB Schemas
const SessionSchema = new mongoose.Schema({
  number: { type: String, unique: true, required: true },
  sessionData: { type: Object, required: true },
  status: { 
    type: String, 
    enum: ['active', 'disconnected', 'invalid', 'failed'],
    default: 'disconnected'
  },
  health: {
    type: String,
    enum: ['active', 'reconnecting', 'disconnected'],
    default: 'disconnected'
  },
  failedAttempts: { type: Number, default: 0 },
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const UserConfigSchema = new mongoose.Schema({
  number: { type: String, unique: true, required: true },
  config: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Initialize MongoDB models
let Session, UserConfig;
let isMongoConnected = false;

// Global session manager
const sessions = new Map();
const pendingSaves = new Map();
const reconnectionAttempts = new Map();

// Express app setup
const app = express();
app.use(express.json());
const port = process.env.PORT || 8000;

// Logger setup
const logger = P({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  timestamp: () => `,"time":"${moment().format('YYYY-MM-DD HH:mm:ss')}"`,
});

// MongoDB Connection
async function connectToMongoDB() {
  try {
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    Session = mongoose.model('Session', SessionSchema);
    UserConfig = mongoose.model('UserConfig', UserConfigSchema);
    isMongoConnected = true;
    
    logger.info('✅ MongoDB Atlas connected successfully');
    return true;
  } catch (error) {
    logger.error('❌ MongoDB connection failed:', error.message);
    isMongoConnected = false;
    
    // Retry connection after 5 seconds
    setTimeout(() => connectToMongoDB(), 5000);
    return false;
  }
}

// Utility functions
function sanitizePhoneNumber(number) {
  return number.replace(/[^0-9]/g, '');
}

function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Session Management Functions
async function saveSessionToMongoDB(number, sessionData) {
  if (!isMongoConnected) {
    pendingSaves.set(number, sessionData);
    return false;
  }

  try {
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
    
    logger.info(`✅ Session saved to MongoDB for ${number}`);
    pendingSaves.delete(number);
    return true;
  } catch (error) {
    logger.error(`❌ Failed to save session for ${number}:`, error.message);
    pendingSaves.set(number, sessionData);
    return false;
  }
}

async function restoreSessionFromMongoDB(number) {
  if (!isMongoConnected) return null;

  try {
    const session = await Session.findOne({ number });
    if (session && session.sessionData) {
      logger.info(`✅ Session restored from MongoDB for ${number}`);
      return session.sessionData;
    }
    return null;
  } catch (error) {
    logger.error(`❌ Failed to restore session for ${number}:`, error.message);
    return null;
  }
}

async function updateSessionStatus(number, status, health = null) {
  if (!isMongoConnected) return;

  try {
    const updateData = {
      status,
      updatedAt: new Date()
    };
    
    if (health) updateData.health = health;
    if (status === 'active') updateData.lastActive = new Date();
    
    await Session.findOneAndUpdate({ number }, updateData);
    logger.info(`Session status updated for ${number}: ${status}/${health}`);
  } catch (error) {
    logger.error(`Failed to update session status for ${number}:`, error.message);
  }
}

// WhatsApp Connection Function
async function connectToWA(number = null, isRestore = false) {
  const sessionNumber = number || config.OWNER_NUMBER;
  const sanitizedNumber = sanitizePhoneNumber(sessionNumber);
  
  logger.info(`🔄 Connecting WhatsApp for ${sanitizedNumber}...`);
  
  // Check if session already exists
  if (sessions.has(sanitizedNumber)) {
    const existingSession = sessions.get(sanitizedNumber);
    if (existingSession.status === 'active') {
      logger.info(`Session already active for ${sanitizedNumber}`);
      return existingSession.conn;
    }
  }

  // Create auth directory
  const authPath = path.join(__dirname, 'auth_info_baileys', sanitizedNumber);
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  // Try to restore session from MongoDB if not a new pairing
  if (isRestore && !fs.existsSync(path.join(authPath, 'creds.json'))) {
    const mongoSession = await restoreSessionFromMongoDB(sanitizedNumber);
    if (mongoSession && mongoSession.creds) {
      fs.writeFileSync(
        path.join(authPath, 'creds.json'),
        JSON.stringify(mongoSession.creds)
      );
      logger.info(`Session restored from MongoDB for ${sanitizedNumber}`);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const conn = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: !number,
    browser: Browsers.macOS("Firefox"),
    syncFullHistory: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
    },
    version,
    getMessage: async (key) => {
      return {};
    }
  });

  // Store session
  sessions.set(sanitizedNumber, {
    conn,
    status: 'connecting',
    health: 'reconnecting',
    number: sanitizedNumber,
    createdAt: new Date(),
    lastActive: new Date()
  });

  // Connection update handler
  conn.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !number) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const session = sessions.get(sanitizedNumber);
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        const attempts = reconnectionAttempts.get(sanitizedNumber) || 0;
        
        if (attempts < config.MAX_FAILED_ATTEMPTS) {
          logger.info(`Reconnecting ${sanitizedNumber}... Attempt ${attempts + 1}`);
          reconnectionAttempts.set(sanitizedNumber, attempts + 1);
          
          await updateSessionStatus(sanitizedNumber, 'disconnected', 'reconnecting');
          
          setTimeout(() => {
            connectToWA(sanitizedNumber, true);
          }, 5000);
        } else {
          logger.error(`Max reconnection attempts reached for ${sanitizedNumber}`);
          await updateSessionStatus(sanitizedNumber, 'failed', 'disconnected');
          sessions.delete(sanitizedNumber);
          reconnectionAttempts.delete(sanitizedNumber);
        }
      } else {
        logger.info(`Session logged out for ${sanitizedNumber}`);
        await updateSessionStatus(sanitizedNumber, 'invalid', 'disconnected');
        sessions.delete(sanitizedNumber);
        
        // Clean auth directory
        fs.rmSync(authPath, { recursive: true, force: true });
        
        // Delete from MongoDB after delay
        setTimeout(async () => {
          await Session.findOneAndDelete({ number: sanitizedNumber });
          logger.info(`Deleted invalid session for ${sanitizedNumber}`);
        }, config.IMMEDIATE_DELETE_DELAY);
      }
    } else if (connection === 'open') {
      logger.info(`✅ WhatsApp connected for ${sanitizedNumber}`);
      
      // Update session status
      const session = sessions.get(sanitizedNumber);
      session.status = 'active';
      session.health = 'active';
      session.lastActive = new Date();
      
      reconnectionAttempts.delete(sanitizedNumber);
      await updateSessionStatus(sanitizedNumber, 'active', 'active');
      
      // Save session to MongoDB
      const authState = await conn.authState;
      await saveSessionToMongoDB(sanitizedNumber, authState);
      
      // Load plugins
      loadPlugins(conn);
      
      // Send connection notification
      if (config.OWNER_NUMBERS.includes(sanitizedNumber)) {
        const upMessage = `✅ *Bot Connected Successfully*\n\n` +
                         `📱 Number: ${sanitizedNumber}\n` +
                         `⏰ Time: ${moment().format('YYYY-MM-DD HH:mm:ss')}\n` +
                         `🔧 Prefix: ${config.PREFIX}\n` +
                         `💚 Status: Active`;
        
        for (const owner of config.OWNER_NUMBERS) {
          await conn.sendMessage(owner + '@s.whatsapp.net', {
            image: { url: 'https://pomf2.lain.la/f/uzu4feg.jpg' },
            caption: upMessage
          }).catch(() => {});
        }
      }
      
      // Auto-join group if configured
      if (config.GROUP_INVITE_LINK) {
        try {
          const inviteCode = config.GROUP_INVITE_LINK.split('/').pop();
          await conn.groupAcceptInvite(inviteCode);
          logger.info('Auto-joined configured group');
        } catch (error) {
          logger.error('Failed to auto-join group:', error.message);
        }
      }
      
      // Subscribe to newsletters
      if (config.AUTO_REACT_NEWSLETTERS === 'true' && config.NEWSLETTER_JIDS.length > 0) {
        for (const newsletterJid of config.NEWSLETTER_JIDS) {
          try {
            await conn.newsletterFollow(newsletterJid);
            logger.info(`Subscribed to newsletter: ${newsletterJid}`);
          } catch (error) {
            logger.error(`Failed to subscribe to ${newsletterJid}:`, error.message);
          }
        }
      }
    }
  });

  // Credentials update handler
  conn.ev.on('creds.update', async () => {
    await saveCreds();
    
    // Also save to MongoDB
    const authState = await state;
    await saveSessionToMongoDB(sanitizedNumber, authState);
  });

  // Message handler
  conn.ev.on('messages.upsert', async (mek) => {
    await handleMessage(conn, mek, sanitizedNumber);
  });

  return conn;
}

// Message Handler
async function handleMessage(conn, mek, sessionNumber) {
  try {
    mek = mek.messages[0];
    if (!mek.message) return;
    
    mek.message = (getContentType(mek.message) === 'ephemeralMessage') 
      ? mek.message.ephemeralMessage.message 
      : mek.message;
    
    // Auto-view status
    if (mek.key && mek.key.remoteJid === 'status@broadcast') {
      if (config.AUTO_VIEW_STATUS === 'true') {
        await conn.readMessages([mek.key]);
        
        // Set recording presence
        if (config.AUTO_RECORDING === 'true') {
          await conn.sendPresenceUpdate('recording', mek.key.remoteJid);
        }
        
        // Auto-react to status
        if (config.AUTO_LIKE_STATUS === 'true') {
          const randomEmoji = config.AUTO_LIKE_EMOJI[
            Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)
          ];
          await conn.sendMessage(mek.key.remoteJid, {
            react: { text: randomEmoji, key: mek.key }
          });
        }
      }
      return;
    }
    
    // Auto-react to newsletters
    if (config.AUTO_REACT_NEWSLETTERS === 'true' && 
        mek.key.remoteJid && 
        config.NEWSLETTER_JIDS.includes(mek.key.remoteJid)) {
      const randomEmoji = config.NEWSLETTER_REACT_EMOJIS[
        Math.floor(Math.random() * config.NEWSLETTER_REACT_EMOJIS.length)
      ];
      await conn.sendMessage(mek.key.remoteJid, {
        react: { text: randomEmoji, key: mek.key }
      });
    }
    
    // Process regular messages
    const m = sms(conn, mek);
    const type = getContentType(mek.message);
    const from = mek.key.remoteJid;
    const body = (type === 'conversation') ? mek.message.conversation : 
                 (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text : 
                 (type == 'imageMessage') && mek.message.imageMessage.caption ? mek.message.imageMessage.caption : 
                 (type == 'videoMessage') && mek.message.videoMessage.caption ? mek.message.videoMessage.caption : '';
    
    const isCmd = body.startsWith(config.PREFIX);
    const command = isCmd ? body.slice(config.PREFIX.length).trim().split(' ').shift().toLowerCase() : '';
    const args = body.trim().split(/ +/).slice(1);
    const q = args.join(' ');
    const isGroup = from.endsWith('@g.us');
    const sender = mek.key.fromMe ? (conn.user.id.split(':')[0]+'@s.whatsapp.net' || conn.user.id) : (mek.key.participant || mek.key.remoteJid);
    const senderNumber = sender.split('@')[0];
    const botNumber = conn.user.id.split(':')[0];
    const pushname = mek.pushName || 'Sin Nombre';
    const isMe = botNumber.includes(senderNumber);
    const isOwner = config.OWNER_NUMBERS.includes(senderNumber) || isMe;
    const botNumber2 = await jidNormalizedUser(conn.user.id);
    const groupMetadata = isGroup ? await conn.groupMetadata(from).catch(e => {}) : '';
    const groupName = isGroup ? groupMetadata.subject : '';
    const participants = isGroup ? await groupMetadata.participants : '';
    const groupAdmins = isGroup ? await getGroupAdmins(participants) : '';
    const isBotAdmins = isGroup ? groupAdmins.includes(botNumber2) : false;
    const isAdmins = isGroup ? groupAdmins.includes(sender) : false;
    const isReact = m.message.reactionMessage ? true : false;
    
    const reply = (teks) => {
      conn.sendMessage(from, { text: teks }, { quoted: mek });
    };
    
    // Add additional methods to conn
    conn.edit = async (mek, newmg) => {
      await conn.relayMessage(from, {
        protocolMessage: {
          key: mek.key,
          type: 14,
          editedMessage: {
            conversation: newmg
          }
        }
      }, {});
    };
    
    conn.sendFileUrl = async (jid, url, caption, quoted, options = {}) => {
      let mime = '';
      let res = await axios.head(url);
      mime = res.headers['content-type'];
      if (mime.split("/")[1] === "gif") {
        return conn.sendMessage(jid, { video: await getBuffer(url), caption: caption, gifPlayback: true, ...options }, { quoted: quoted, ...options });
      }
      let type = mime.split("/")[0] + "Message";
      if (mime === "application/pdf") {
        return conn.sendMessage(jid, { document: await getBuffer(url), mimetype: 'application/pdf', caption: caption, ...options }, { quoted: quoted, ...options });
      }
      if (mime.split("/")[0] === "image") {
        return conn.sendMessage(jid, { image: await getBuffer(url), caption: caption, ...options }, { quoted: quoted, ...options });
      }
      if (mime.split("/")[0] === "video") {
        return conn.sendMessage(jid, { video: await getBuffer(url), caption: caption, mimetype: 'video/mp4', ...options }, { quoted: quoted, ...options });
      }
      if (mime.split("/")[0] === "audio") {
        return conn.sendMessage(jid, { audio: await getBuffer(url), caption: caption, mimetype: 'audio/mpeg', ...options }, { quoted: quoted, ...options });
      }
    };
    
    // Owner auto-react
    if(config.OWNER_NUMBERS.includes(senderNumber) && !isReact) {
      m.react("💗");
    }
    
    // Process commands
    const events = require('./command');
    const cmdName = isCmd ? body.slice(1).trim().split(" ")[0].toLowerCase() : false;
    
    if (isCmd) {
      const cmd = events.commands.find((cmd) => cmd.pattern === cmdName) || 
                  events.commands.find((cmd) => cmd.alias && cmd.alias.includes(cmdName));
      
      if (cmd) {
        if (cmd.react) {
          await conn.sendMessage(from, { react: { text: cmd.react, key: mek.key }});
        }
        
        try {
          await cmd.function(conn, mek, m, {
            from, quoted: mek.quoted, body, isCmd, command, args, q, isGroup, 
            sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, 
            groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply
          });
        } catch (e) {
          logger.error("[PLUGIN ERROR]", e);
          reply(`Error: ${e.message}`);
        }
      }
    }
    
    // Process event-based commands
    events.commands.map(async(command) => {
      if (body && command.on === "body") {
        command.function(conn, mek, m, {
          from, quoted: mek.quoted, body, isCmd, command, args, q, isGroup, 
          sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, 
          groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply
        });
      } else if (mek.q && command.on === "text") {
        command.function(conn, mek, m, {
          from, quoted: mek.quoted, body, isCmd, command, args, q, isGroup, 
          sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, 
          groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply
        });
      } else if ((command.on === "image" || command.on === "photo") && type === "imageMessage") {
        command.function(conn, mek, m, {
          from, quoted: mek.quoted, body, isCmd, command, args, q, isGroup, 
          sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, 
          groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply
        });
      } else if (command.on === "sticker" && type === "stickerMessage") {
        command.function(conn, mek, m, {
          from, quoted: mek.quoted, body, isCmd, command, args, q, isGroup, 
          sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, 
          groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply
        });
      }
    });
    
    // Update last active
    const session = sessions.get(sessionNumber);
    if (session) {
      session.lastActive = new Date();
    }
    
  } catch (error) {
    logger.error('Message handler error:', error);
  }
}

// Load plugins
function loadPlugins(conn) {
  try {
    const pluginsDir = path.join(__dirname, 'plugins');
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
      logger.info('Created plugins directory');
    }
    
    fs.readdirSync(pluginsDir).forEach((plugin) => {
      if (path.extname(plugin).toLowerCase() === '.js') {
        delete require.cache[require.resolve('./plugins/' + plugin)];
        require('./plugins/' + plugin);
      }
    });
    
    logger.info('✅ Plugins loaded successfully');
  } catch (error) {
    logger.error('Failed to load plugins:', error);
  }
}

// Auto Management Functions
async function autoSaveSessions() {
  if (!isMongoConnected) return;
  
  logger.info('Running auto-save for active sessions...');
  
  for (const [number, session] of sessions) {
    if (session.status === 'active' && session.conn) {
      try {
        const authState = await session.conn.authState;
        await saveSessionToMongoDB(number, authState);
      } catch (error) {
        logger.error(`Failed to auto-save session ${number}:`, error.message);
      }
    }
  }
  
  // Process pending saves
  if (pendingSaves.size > 0) {
    logger.info(`Processing ${pendingSaves.size} pending saves...`);
    for (const [number, sessionData] of pendingSaves) {
      await saveSessionToMongoDB(number, sessionData);
    }
  }
}

async function autoCleanupSessions() {
  logger.info('Running auto-cleanup for inactive sessions...');
  
  const now = Date.now();
  
  for (const [number, session] of sessions) {
    const sessionAge = now - session.createdAt.getTime();
    const inactiveTime = now - session.lastActive.getTime();
    
    // Remove very old sessions
    if (sessionAge > config.MAX_SESSION_AGE) {
      logger.info(`Removing old session ${number} (age: ${sessionAge}ms)`);
      sessions.delete(number);
      await Session.findOneAndDelete({ number });
      continue;
    }
    
    // Clean disconnected sessions
    if (session.status === 'disconnected' && inactiveTime > config.DISCONNECTED_CLEANUP_TIME) {
      logger.info(`Cleaning disconnected session ${number}`);
      sessions.delete(number);
      await updateSessionStatus(number, 'disconnected', 'disconnected');
    }
  }
  
  // Clean invalid sessions from MongoDB
  if (isMongoConnected) {
    try {
      const invalidSessions = await Session.find({ status: 'invalid' });
      for (const session of invalidSessions) {
        const age = Date.now() - session.updatedAt.getTime();
        if (age > config.IMMEDIATE_DELETE_DELAY) {
          await Session.findByIdAndDelete(session._id);
          logger.info(`Deleted invalid session from MongoDB: ${session.number}`);
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup invalid sessions:', error.message);
    }
  }
}

async function autoReconnectSessions() {
  logger.info('Checking for sessions to reconnect...');
  
  if (!isMongoConnected) return;
  
  try {
    const disconnectedSessions = await Session.find({
      status: { $in: ['disconnected'] },
      failedAttempts: { $lt: config.MAX_FAILED_ATTEMPTS }
    });
    
    for (const session of disconnectedSessions) {
      if (!sessions.has(session.number)) {
        logger.info(`Attempting to reconnect session ${session.number}`);
        await connectToWA(session.number, true);
        await sleep(5000); // Wait 5 seconds between reconnections
      }
    }
  } catch (error) {
    logger.error('Failed to auto-reconnect sessions:', error.message);
  }
}

async function autoRestoreSessions() {
  logger.info('Auto-restoring sessions from MongoDB...');
  
  if (!isMongoConnected) return;
  
  try {
    const activeSessions = await Session.find({
      status: { $in: ['active', 'disconnected'] }
    });
    
    logger.info(`Found ${activeSessions.length} sessions to restore`);
    
    for (const session of activeSessions) {
      if (!sessions.has(session.number)) {
        logger.info(`Restoring session for ${session.number}`);
        await connectToWA(session.number, true);
        await sleep(3000); // Wait 3 seconds between restorations
      }
    }
  } catch (error) {
    logger.error('Failed to auto-restore sessions:', error.message);
  }
}

// API Endpoints
app.get('/', async (req, res) => {
  const number = req.query.number;
  
  if (!number) {
    return res.json({
      success: false,
      message: 'Please provide a phone number',
      example: '/?number=94741671668'
    });
  }
  
  const sanitized = sanitizePhoneNumber(number);
  
  if (sessions.has(sanitized)) {
    const session = sessions.get(sanitized);
    return res.json({
      success: true,
      message: 'Session already exists',
      status: session.status,
      health: session.health
    });
  }
  
  try {
    await connectToWA(sanitized);
    res.json({
      success: true,
      message: 'Scan QR code in terminal',
      number: sanitized
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get('/active', async (req, res) => {
  const activeSessions = [];
  
  for (const [number, session] of sessions) {
    activeSessions.push({
      number,
      status: session.status,
      health: session.health,
      lastActive: session.lastActive,
      uptime: Date.now() - session.createdAt.getTime()
    });
  }
  
  res.json({
    success: true,
    count: activeSessions.length,
    sessions: activeSessions,
    mongoConnected: isMongoConnected
  });
});

app.get('/ping', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running',
    uptime: process.uptime(),
    timestamp: new Date()
  });
});

app.get('/sync-mongodb', async (req, res) => {
  try {
    await autoSaveSessions();
    res.json({
      success: true,
      message: 'MongoDB sync completed',
      pendingSaves: pendingSaves.size
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get('/session-health', async (req, res) => {
  const report = {
    total: sessions.size,
    active: 0,
    disconnected: 0,
    reconnecting: 0,
    failed: 0,
    sessions: []
  };
  
  for (const [number, session] of sessions) {
    report.sessions.push({
      number,
      status: session.status,
      health: session.health,
      lastActive: session.lastActive,
      uptime: Date.now() - session.createdAt.getTime()
    });
    
    if (session.status === 'active') report.active++;
    else if (session.status === 'disconnected') report.disconnected++;
    else if (session.health === 'reconnecting') report.reconnecting++;
    else if (session.status === 'failed') report.failed++;
  }
  
  res.json({
    success: true,
    report,
    mongoConnected: isMongoConnected,
    pendingSaves: pendingSaves.size
  });
});

app.get('/restore-all', async (req, res) => {
  try {
    await autoRestoreSessions();
    res.json({
      success: true,
      message: 'Session restoration initiated'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get('/cleanup', async (req, res) => {
  try {
    await autoCleanupSessions();
    res.json({
      success: true,
      message: 'Cleanup completed'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.delete('/session/:number', async (req, res) => {
  const number = sanitizePhoneNumber(req.params.number);
  
  if (!sessions.has(number)) {
    return res.status(404).json({
      success: false,
      message: 'Session not found'
    });
  }
  
  try {
    const session = sessions.get(number);
    if (session.conn) {
      await session.conn.logout();
    }
    
    sessions.delete(number);
    await Session.findOneAndDelete({ number });
    
    // Clean auth directory
    const authPath = path.join(__dirname, 'auth_info_baileys', number);
    fs.rmSync(authPath, { recursive: true, force: true });
    
    res.json({
      success: true,
      message: 'Session deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get('/mongodb-status', async (req, res) => {
  res.json({
    success: true,
    connected: isMongoConnected,
    uri: MONGODB_URI.replace(/:[^:]*@/, ':****@'), // Hide password
    pendingSaves: pendingSaves.size,
    stats: isMongoConnected ? {
      sessions: await Session.countDocuments(),
      activeSessions: await Session.countDocuments({ status: 'active' }),
      userConfigs: await UserConfig.countDocuments()
    } : null
  });
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  
  // Save all active sessions
  await autoSaveSessions();
  
  // Close all connections
  for (const [number, session] of sessions) {
    if (session.conn) {
      await updateSessionStatus(number, 'disconnected', 'disconnected');
      await session.conn.ws.close();
    }
  }
  
  // Close MongoDB connection
  if (isMongoConnected) {
    await mongoose.connection.close();
  }
  
  // Close Express server
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after 10 seconds');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Initialize auto-management intervals
let intervals = {};

function startAutoManagement() {
  logger.info('Starting auto-management services...');
  
  intervals.autoSave = setInterval(autoSaveSessions, config.AUTO_SAVE_INTERVAL);
  intervals.autoCleanup = setInterval(autoCleanupSessions, config.AUTO_CLEANUP_INTERVAL);
  intervals.autoReconnect = setInterval(autoReconnectSessions, config.AUTO_RECONNECT_INTERVAL);
  intervals.autoRestore = setInterval(autoRestoreSessions, config.AUTO_RESTORE_INTERVAL);
  intervals.mongoSync = setInterval(async () => {
    if (pendingSaves.size > 0) {
      await autoSaveSessions();
    }
  }, config.MONGODB_SYNC_INTERVAL);
  
  logger.info('✅ Auto-management services started');
}

// Main initialization
async function initialize() {
  try {
    // Connect to MongoDB
    await connectToMongoDB();
    
    // Start Express server
    const server = app.listen(port, () => {
      logger.info(`🚀 Server running on port ${port}`);
      logger.info(`📡 API: http://localhost:${port}`);
    });
    
    // Start auto-management
    startAutoManagement();
    
    // Initial restore after delay
    setTimeout(async () => {
      logger.info('Starting initial session restoration...');
      await autoRestoreSessions();
    }, config.INITIAL_RESTORE_DELAY);
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      // Don't exit, let PM2 handle it if needed
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
      // Don't exit, let PM2 handle it if needed
    });
    
  } catch (error) {
    logger.error('Failed to initialize:', error);
    process.exit(1);
  }
}

// Start the application
initialize();

module.exports = { sessions, config };