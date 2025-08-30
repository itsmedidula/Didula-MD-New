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
  proto,
  getAggregateVotesInPollMessage
} = require('@whiskeysockets/baileys');

const { getBuffer, getGroupAdmins, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson } = require('./lib/functions');
const fs = require('fs');
const P = require('pino');
const qrcode = require('qrcode');
const util = require('util');
const { sms, downloadMediaMessage } = require('./lib/msg');
const axios = require('axios');
const { File } = require('megajs');
const express = require('express');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

// Configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://Didula:DidulaMD@didulamd.mgwjqat.mongodb.net/Didulamdnew?retryWrites=true&w=majority';
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
    enum: ['active', 'disconnected', 'invalid', 'failed', 'waiting'],
    default: 'disconnected'
  },
  health: {
    type: String,
    enum: ['active', 'reconnecting', 'disconnected'],
    default: 'disconnected'
  },
  pairCode: { type: String, default: null },
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
const pairCodeRequests = new Map();

// Express app setup
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
const port = process.env.PORT || 8000;

// Logger setup
const logger = P({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  timestamp: () => `,"time":"${moment().format('YYYY-MM-DD HH:mm:ss')}"`,
});

// Create public directory structure
if (!fs.existsSync('public')) {
  fs.mkdirSync('public');
}

// HTML Template
const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Session Manager</title>
    <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        
        * {
            font-family: 'Inter', sans-serif;
        }
        
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        
        .glass-morphism {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .pulse-animation {
            animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        
        @keyframes pulse {
            0%, 100% {
                opacity: 1;
            }
            50% {
                opacity: 0.5;
            }
        }
        
        .gradient-text {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .status-active {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        }
        
        .status-waiting {
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
        }
        
        .status-disconnected {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        }
        
        .loader {
            border-top-color: #667eea;
            animation: spinner 1.5s linear infinite;
        }
        
        @keyframes spinner {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .fade-in {
            animation: fadeIn 0.5s ease-in;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .qr-container {
            padding: 20px;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        .session-card {
            transition: all 0.3s ease;
        }
        
        .session-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 20px 40px rgba(0,0,0,0.2);
        }
    </style>
</head>
<body>
    <div class="container mx-auto px-4 py-8">
        <!-- Header -->
        <div class="text-center mb-10 fade-in">
            <h1 class="text-5xl font-bold text-white mb-4">
                <i class="fab fa-whatsapp text-green-400"></i> 
                WhatsApp Session Manager
            </h1>
            <p class="text-white text-lg opacity-90">Connect and manage your WhatsApp sessions easily</p>
        </div>

        <!-- Main Content -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-6xl mx-auto">
            
            <!-- Connection Panel -->
            <div class="glass-morphism p-8 fade-in">
                <h2 class="text-2xl font-bold text-white mb-6">
                    <i class="fas fa-link"></i> New Connection
                </h2>
                
                <!-- Connection Method Tabs -->
                <div class="flex space-x-4 mb-6">
                    <button onclick="switchMethod('paircode')" id="paircode-tab" 
                            class="flex-1 py-2 px-4 bg-white bg-opacity-20 text-white rounded-lg font-medium transition hover:bg-opacity-30">
                        <i class="fas fa-key"></i> Pair Code
                    </button>
                    <button onclick="switchMethod('qr')" id="qr-tab"
                            class="flex-1 py-2 px-4 bg-white bg-opacity-10 text-white rounded-lg font-medium transition hover:bg-opacity-30">
                        <i class="fas fa-qrcode"></i> QR Code
                    </button>
                </div>
                
                <!-- Pair Code Method -->
                <div id="paircode-method">
                    <div class="mb-6">
                        <label class="block text-white mb-2 font-medium">Phone Number</label>
                        <div class="flex space-x-2">
                            <input type="tel" id="phone-input" 
                                   placeholder="94741671668" 
                                   class="flex-1 px-4 py-3 rounded-lg bg-white bg-opacity-20 text-white placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-white">
                            <button onclick="requestPairCode()" 
                                    class="px-6 py-3 bg-gradient-to-r from-green-500 to-green-600 text-white rounded-lg font-medium hover:from-green-600 hover:to-green-700 transition">
                                <i class="fas fa-paper-plane"></i> Get Code
                            </button>
                        </div>
                    </div>
                    
                    <div id="pair-code-display" class="hidden">
                        <div class="bg-white bg-opacity-20 rounded-lg p-6 text-center">
                            <p class="text-white mb-2">Your Pair Code:</p>
                            <div class="text-3xl font-bold text-white tracking-wider" id="pair-code-text"></div>
                            <p class="text-sm text-gray-300 mt-4">
                                <i class="fas fa-info-circle"></i> 
                                Enter this code in WhatsApp > Linked Devices > Link with phone number
                            </p>
                        </div>
                    </div>
                </div>
                
                <!-- QR Code Method -->
                <div id="qr-method" class="hidden">
                    <div class="text-center">
                        <div id="qr-container" class="qr-container inline-block">
                            <div id="qr-code"></div>
                        </div>
                        <p class="text-white mt-4">
                            <i class="fas fa-mobile-alt"></i> 
                            Scan with WhatsApp on your phone
                        </p>
                    </div>
                </div>
                
                <!-- Status Messages -->
                <div id="status-message" class="mt-6 hidden">
                    <div class="bg-white bg-opacity-20 rounded-lg p-4 flex items-center space-x-3">
                        <div class="loader border-4 border-gray-300 rounded-full w-8 h-8"></div>
                        <span class="text-white" id="status-text">Connecting...</span>
                    </div>
                </div>
            </div>
            
            <!-- Active Sessions Panel -->
            <div class="glass-morphism p-8 fade-in">
                <h2 class="text-2xl font-bold text-white mb-6">
                    <i class="fas fa-users"></i> Active Sessions
                </h2>
                
                <div id="sessions-list" class="space-y-4">
                    <!-- Sessions will be loaded here -->
                </div>
                
                <button onclick="loadSessions()" 
                        class="mt-6 w-full py-3 bg-white bg-opacity-20 text-white rounded-lg font-medium hover:bg-opacity-30 transition">
                    <i class="fas fa-sync-alt"></i> Refresh Sessions
                </button>
            </div>
        </div>
        
        <!-- Stats Dashboard -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mt-10 max-w-6xl mx-auto">
            <div class="glass-morphism p-6 text-center fade-in">
                <i class="fas fa-server text-3xl text-green-400 mb-3"></i>
                <h3 class="text-white font-semibold">Server Status</h3>
                <p class="text-2xl font-bold text-white" id="server-status">Active</p>
            </div>
            
            <div class="glass-morphism p-6 text-center fade-in">
                <i class="fas fa-database text-3xl text-blue-400 mb-3"></i>
                <h3 class="text-white font-semibold">MongoDB</h3>
                <p class="text-2xl font-bold text-white" id="mongo-status">Connected</p>
            </div>
            
            <div class="glass-morphism p-6 text-center fade-in">
                <i class="fas fa-plug text-3xl text-yellow-400 mb-3"></i>
                <h3 class="text-white font-semibold">Total Sessions</h3>
                <p class="text-2xl font-bold text-white" id="total-sessions">0</p>
            </div>
            
            <div class="glass-morphism p-6 text-center fade-in">
                <i class="fas fa-clock text-3xl text-purple-400 mb-3"></i>
                <h3 class="text-white font-semibold">Uptime</h3>
                <p class="text-2xl font-bold text-white" id="uptime">0h 0m</p>
            </div>
        </div>
    </div>
    
    <script>
        let currentMethod = 'paircode';
        let ws = null;
        
        // Initialize WebSocket connection
        function initWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(\`\${protocol}//\${window.location.host}/ws\`);
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                handleWebSocketMessage(data);
            };
            
            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
            
            ws.onclose = () => {
                setTimeout(initWebSocket, 5000);
            };
        }
        
        function handleWebSocketMessage(data) {
            if (data.type === 'qr') {
                displayQRCode(data.qr);
            } else if (data.type === 'paircode') {
                displayPairCode(data.code);
            } else if (data.type === 'connected') {
                showSuccess(data.message);
                loadSessions();
            } else if (data.type === 'error') {
                showError(data.message);
            }
        }
        
        function switchMethod(method) {
            currentMethod = method;
            
            // Update tabs
            document.getElementById('paircode-tab').classList.toggle('bg-opacity-20', method === 'paircode');
            document.getElementById('paircode-tab').classList.toggle('bg-opacity-10', method !== 'paircode');
            document.getElementById('qr-tab').classList.toggle('bg-opacity-20', method === 'qr');
            document.getElementById('qr-tab').classList.toggle('bg-opacity-10', method !== 'qr');
            
            // Show/hide methods
            document.getElementById('paircode-method').classList.toggle('hidden', method !== 'paircode');
            document.getElementById('qr-method').classList.toggle('hidden', method !== 'qr');
            
            if (method === 'qr') {
                requestQRCode();
            }
        }
        
        async function requestPairCode() {
            const phone = document.getElementById('phone-input').value.trim();
            
            if (!phone) {
                showError('Please enter a phone number');
                return;
            }
            
            showStatus('Requesting pair code...');
            
            try {
                const response = await fetch('/api/request-pair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ number: phone })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    displayPairCode(data.code);
                    showStatus('Waiting for pairing...');
                } else {
                    showError(data.message);
                }
            } catch (error) {
                showError('Failed to request pair code');
            }
        }
        
        async function requestQRCode() {
            showStatus('Generating QR code...');
            
            try {
                const response = await fetch('/api/request-qr', { method: 'POST' });
                const data = await response.json();
                
                if (data.success) {
                    hideStatus();
                } else {
                    showError(data.message);
                }
            } catch (error) {
                showError('Failed to generate QR code');
            }
        }
        
        function displayPairCode(code) {
            document.getElementById('pair-code-display').classList.remove('hidden');
            document.getElementById('pair-code-text').textContent = code;
        }
        
        function displayQRCode(qrData) {
            const qrContainer = document.getElementById('qr-code');
            qrContainer.innerHTML = \`<img src="\${qrData}" alt="QR Code" />\`;
        }
        
        async function loadSessions() {
            try {
                const response = await fetch('/api/sessions');
                const data = await response.json();
                
                if (data.success) {
                    displaySessions(data.sessions);
                    updateStats(data);
                }
            } catch (error) {
                console.error('Failed to load sessions:', error);
            }
        }
        
        function displaySessions(sessions) {
            const container = document.getElementById('sessions-list');
            
            if (sessions.length === 0) {
                container.innerHTML = \`
                    <div class="text-center text-white opacity-70 py-8">
                        <i class="fas fa-inbox text-4xl mb-4"></i>
                        <p>No active sessions</p>
                    </div>
                \`;
                return;
            }
            
            container.innerHTML = sessions.map(session => \`
                <div class="session-card bg-white bg-opacity-10 rounded-lg p-4">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center space-x-3">
                            <div class="w-3 h-3 rounded-full \${getStatusClass(session.status)}"></div>
                            <div>
                                <p class="text-white font-medium">\${session.number}</p>
                                <p class="text-gray-300 text-sm">
                                    <i class="fas fa-clock"></i> 
                                    \${formatUptime(session.uptime)}
                                </p>
                            </div>
                        </div>
                        <button onclick="deleteSession('\${session.number}')" 
                                class="text-red-400 hover:text-red-300 transition">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            \`).join('');
        }
        
        async function deleteSession(number) {
            if (!confirm('Are you sure you want to delete this session?')) return;
            
            try {
                const response = await fetch(\`/api/session/\${number}\`, { method: 'DELETE' });
                const data = await response.json();
                
                if (data.success) {
                    showSuccess('Session deleted successfully');
                    loadSessions();
                } else {
                    showError(data.message);
                }
            } catch (error) {
                showError('Failed to delete session');
            }
        }
        
        function updateStats(data) {
            document.getElementById('server-status').textContent = 'Active';
            document.getElementById('mongo-status').textContent = data.mongoConnected ? 'Connected' : 'Disconnected';
            document.getElementById('total-sessions').textContent = data.count;
            
            if (data.uptime) {
                document.getElementById('uptime').textContent = formatUptime(data.uptime * 1000);
            }
        }
        
        function getStatusClass(status) {
            switch(status) {
                case 'active': return 'status-active';
                case 'waiting': return 'status-waiting';
                default: return 'status-disconnected';
            }
        }
        
        function formatUptime(ms) {
            const hours = Math.floor(ms / 3600000);
            const minutes = Math.floor((ms % 3600000) / 60000);
            return \`\${hours}h \${minutes}m\`;
        }
        
        function showStatus(message) {
            const statusEl = document.getElementById('status-message');
            statusEl.classList.remove('hidden');
            document.getElementById('status-text').textContent = message;
        }
        
        function hideStatus() {
            document.getElementById('status-message').classList.add('hidden');
        }
        
        function showSuccess(message) {
            hideStatus();
            // You can implement a toast notification here
            alert(message);
        }
        
        function showError(message) {
            hideStatus();
            // You can implement a toast notification here
            alert('Error: ' + message);
        }
        
        // Initialize on page load
        document.addEventListener('DOMContentLoaded', () => {
            initWebSocket();
            loadSessions();
            
            // Auto-refresh sessions every 30 seconds
            setInterval(loadSessions, 30000);
        });
    </script>
</body>
</html>
`;

// Save HTML file
fs.writeFileSync('public/index.html', htmlTemplate);

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

// WebSocket support
const expressWs = require('express-ws')(app);
const wsClients = new Set();

app.ws('/ws', (ws, req) => {
  wsClients.add(ws);
  
  ws.on('close', () => {
    wsClients.delete(ws);
  });
  
  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
    wsClients.delete(ws);
  });
});

function broadcastToClients(data) {
  const message = JSON.stringify(data);
  wsClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
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

// WhatsApp Connection with Pair Code Support
async function connectWithPairCode(number) {
  const sanitizedNumber = sanitizePhoneNumber(number);
  
  logger.info(`🔄 Requesting pair code for ${sanitizedNumber}...`);
  
  const authPath = path.join(__dirname, 'auth_info_baileys', sanitizedNumber);
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  const conn = makeWASocket({
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS("Firefox"),
    syncFullHistory: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
    },
    version
  });

  // Request pair code
  if (!state.creds.registered) {
    const phoneNumber = '+' + sanitizedNumber;
    const code = await conn.requestPairingCode(phoneNumber);
    
    // Store pair code request
    pairCodeRequests.set(sanitizedNumber, {
      code,
      timestamp: Date.now(),
      conn
    });
    
    logger.info(`Pair code generated for ${sanitizedNumber}: ${code}`);
    
    // Broadcast to WebSocket clients
    broadcastToClients({
      type: 'paircode',
      code,
      number: sanitizedNumber
    });
    
    return { success: true, code };
  }
  
  return { success: false, message: 'Session already exists' };
}

// WhatsApp Connection Function (Updated)
async function connectToWA(number = null, isRestore = false, usePairCode = false) {
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
    printQRInTerminal: false,
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

    if (qr) {
      // Generate QR code image
      const qrImage = await qrcode.toDataURL(qr, { width: 256 });
      
      // Broadcast to WebSocket clients
      broadcastToClients({
        type: 'qr',
        qr: qrImage,
        number: sanitizedNumber
      });
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
          
          broadcastToClients({
            type: 'error',
            message: 'Connection failed after multiple attempts',
            number: sanitizedNumber
          });
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
        
        broadcastToClients({
          type: 'error',
          message: 'Session logged out',
          number: sanitizedNumber
        });
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
      
      // Broadcast success
      broadcastToClients({
        type: 'connected',
        message: 'WhatsApp connected successfully!',
        number: sanitizedNumber
      });

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

// Message Handler (keeping original)
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

// API Routes

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Request pair code
app.post('/api/request-pair', async (req, res) => {
  const { number } = req.body;
  
  if (!number) {
    return res.json({
      success: false,
      message: 'Phone number is required'
    });
  }
  
  try {
    const result = await connectWithPairCode(number);
    res.json(result);
  } catch (error) {
    res.json({
      success: false,
      message: error.message
    });
  }
});

// Request QR code
app.post('/api/request-qr', async (req, res) => {
  try {
    await connectToWA();
    res.json({
      success: true,
      message: 'QR code will be sent via WebSocket'
    });
  } catch (error) {
    res.json({
      success: false,
      message: error.message
    });
  }
});

// Get active sessions
app.get('/api/sessions', async (req, res) => {
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
    mongoConnected: isMongoConnected,
    uptime: process.uptime()
  });
});

// Delete session
app.delete('/api/session/:number', async (req, res) => {
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

// Server health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    uptime: process.uptime(),
    mongoConnected: isMongoConnected,
    activeSessions: sessions.size,
    timestamp: new Date()
  });
});


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

  // Close WebSocket connections
  wsClients.forEach(client => client.close());

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
let server;

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
    server = app.listen(port, () => {
      logger.info(`🚀 Server running on port ${port}`);
      logger.info(`📡 Web Interface: http://localhost:${port}`);
      logger.info(`🔌 WebSocket: ws://localhost:${port}/ws`);
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
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

  } catch (error) {
    logger.error('Failed to initialize:', error);
    process.exit(1);
  }
}

// Start the application
initialize();

