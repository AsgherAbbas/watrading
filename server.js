/**
 * WA Trading Intelligence Platform — Full Production Backend
 * MongoDB + JWT Auth + AI Scoring + Team Features + Price Alerts + Channel Persistence
 * COMPLETE LOGGING VERSION
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── ENV ──
const CLAUDE_KEY  = process.env.CLAUDE_API_KEY || '';
const MONGO_URI   = process.env.MONGO_URI || '';
const JWT_SECRET  = process.env.JWT_SECRET || 'wa-trading-secret-2024';
const PORT        = process.env.PORT || 3000;

// ── IN-MEMORY FALLBACK (used if no MongoDB) ──
const mem = {
  users: [],
  listings: [],
  traders: {},
  deals: {},
  notes: {},
  alerts: [],
  snapshots: [],
  rawMessages: [],
};

// ── MONGODB (optional, graceful fallback) ──
let db = null;
async function connectMongo() {
  if (!MONGO_URI) { console.log('⚠️  No MONGO_URI — using in-memory storage'); return; }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('wa_trading');
    console.log('✅ MongoDB connected');
    // Indexes
    await db.collection('listings').createIndex({ timestamp: -1 });
    await db.collection('listings').createIndex({ model: 1 });
    await db.collection('listings').createIndex({ type: 1 });
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('channels').createIndex({ id: 1 }, { unique: true });
    
    // LOAD saved channels from MongoDB into memory
    const savedChannels = await loadChannelsFromDB();
    for (const ch of savedChannels) {
      channels[ch.id] = ch;
      console.log(`📱 Loaded channel from DB: ${ch.label} (${ch.id})`);
    }
    console.log(`📦 Loaded ${savedChannels.length} channels from MongoDB`);
    
  } catch (e) {
    console.error('MongoDB error:', e.message);
    console.log('⚠️  Falling back to in-memory storage');
  }
}

// ── CHANNELS DB FUNCTIONS (MongoDB Persistence) ──

// Save channel to MongoDB
async function saveChannelToDB(channel) {
  if (!db) return;
  try {
    await db.collection('channels').updateOne(
      { id: channel.id },
      { $set: { 
          id: channel.id,
          label: channel.label,
          token: channel.token,
          active: channel.active,
          groups: channel.groups,
          updatedAt: new Date()
      }},
      { upsert: true }
    );
    console.log(`✅ Channel ${channel.id} saved to MongoDB`);
  } catch(e) { console.error('Failed to save channel to DB:', e.message); }
}

// Load all channels from MongoDB
async function loadChannelsFromDB() {
  if (!db) return [];
  try {
    const channelsList = await db.collection('channels').find({}).toArray();
    console.log(`📦 Loaded ${channelsList.length} channels from MongoDB`);
    return channelsList;
  } catch(e) { 
    console.error('Failed to load channels from DB:', e.message);
    return [];
  }
}

// Delete channel from MongoDB
async function deleteChannelFromDB(channelId) {
  if (!db) return;
  try {
    await db.collection('channels').deleteOne({ id: channelId });
    console.log(`🗑 Deleted channel ${channelId} from MongoDB`);
  } catch(e) { console.error('Failed to delete channel:', e.message); }
}

// Update channel groups in MongoDB
async function updateChannelGroupsInDB(channelId, groups) {
  if (!db) return;
  try {
    await db.collection('channels').updateOne(
      { id: channelId },
      { $set: { groups: groups, updatedAt: new Date() } }
    );
  } catch(e) { console.error('Failed to update groups:', e.message); }
}

// Update entire channel in MongoDB
async function updateChannelInDB(channelId, updateData) {
  if (!db) return;
  try {
    await db.collection('channels').updateOne(
      { id: channelId },
      { $set: { ...updateData, updatedAt: new Date() } }
    );
  } catch(e) { console.error('Failed to update channel:', e.message); }
}

// ── DB HELPERS ──
const DB = {
  async getListings(filter={}, limit=200, skip=0) {
    if (db) return db.collection('listings').find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray();
    let list = mem.listings;
    if (filter.type) list = list.filter(l => l.type === filter.type);
    if (filter.timestamp?.$gt) list = list.filter(l => l.timestamp > filter.timestamp.$gt);
    return list.slice(skip, skip + limit);
  },
  async insertListing(l) {
    if (db) return db.collection('listings').insertOne(l);
    mem.listings.unshift(l);
    if (mem.listings.length > 5000) mem.listings.pop();
  },
  async countListings(filter={}) {
    if (db) return db.collection('listings').countDocuments(filter);
    return mem.listings.filter(l => (!filter.type || l.type === filter.type)).length;
  },
  async getUser(email) {
    if (db) return db.collection('users').findOne({ email });
    return mem.users.find(u => u.email === email);
  },
  async insertUser(u) {
    if (db) return db.collection('users').insertOne(u);
    mem.users.push(u);
  },
  async getUsers() {
    if (db) return db.collection('users').find({}).toArray();
    return mem.users;
  },
  async updateListing(id, update) {
    if (db) return db.collection('listings').updateOne({ id }, { $set: update });
    const l = mem.listings.find(x => x.id === id);
    if (l) Object.assign(l, update);
  },
  async saveSnapshot(snap) {
    if (db) return db.collection('snapshots').insertOne(snap);
    mem.snapshots.push(snap);
    if (mem.snapshots.length > 100) mem.snapshots.shift();
  },
  async getSnapshots(limit=30) {
    if (db) return db.collection('snapshots').find({}).sort({ date: -1 }).limit(limit).toArray();
    return mem.snapshots.slice(-limit).reverse();
  },
  async saveAlert(alert) {
    if (db) return db.collection('alerts').insertOne(alert);
    mem.alerts.push(alert);
  },
  async getAlerts(email) {
    if (db) return db.collection('alerts').find({ email, active: true }).toArray();
    return mem.alerts.filter(a => a.email === email && a.active);
  },
};

// ── MULTI-CHANNEL STORE ──
const channels = {};

function getOrCreateChannel(channelId, label='') {
  if (!channels[channelId]) {
    channels[channelId] = { id: channelId, label: label||channelId, token: '', active: true, groups: {}, addedAt: new Date() };
    console.log(`🆕 Created new channel: ${channelId} (${label||channelId})`);
  }
  return channels[channelId];
}

function isGroupAllowed(channelId, groupId) {
  const ch = channels[channelId];
  if (!ch) {
    console.log(`⚠️ Channel ${channelId} not found - allowing message (will create channel)`);
    return true;
  }
  const groupKeys = Object.keys(ch.groups || {});
  if (groupKeys.length === 0) {
    console.log(`📢 Channel ${channelId} has no groups configured - allowing all messages`);
    return true;
  }
  // Try exact match first
  if (ch.groups[groupId] !== undefined) {
    const allowed = ch.groups[groupId].enabled !== false;
    console.log(`🔘 Group ${groupId} enabled: ${allowed}`);
    return allowed;
  }
  // Try matching without @g.us suffix
  const cleanId = groupId.replace('@g.us','').replace('@s.whatsapp.net','');
  const match = groupKeys.find(k => k.replace('@g.us','').replace('@s.whatsapp.net','') === cleanId);
  if (match) {
    const allowed = ch.groups[match].enabled !== false;
    console.log(`🔘 Group ${groupId} (matched to ${match}) enabled: ${allowed}`);
    return allowed;
  }
  console.log(`📢 Group ${groupId} not in channel config - allowing (will auto-track)`);
  return true;
}

function trackGroup(channelId, groupId, groupName, msgCount=1) {
  const ch = getOrCreateChannel(channelId);
  if (!ch.groups[groupId]) {
    ch.groups[groupId] = { id: groupId, name: groupName||groupId, enabled: true, messageCount: 0, firstSeen: new Date() };
    console.log(`📁 New group tracked: ${groupName||groupId} for channel ${channelId}`);
  }
  ch.groups[groupId].messageCount += msgCount;
  ch.groups[groupId].lastSeen = new Date();
  if (groupName && !ch.groups[groupId].name) ch.groups[groupId].name = groupName;
  
  // Auto-save to MongoDB
  saveChannelToDB(ch).catch(()=>{});
}

// ── PHONE → COUNTRY ──
const PREFIXES = {
  '971':'UAE','966':'Saudi Arabia','965':'Kuwait','973':'Bahrain',
  '974':'Qatar','968':'Oman','962':'Jordan','961':'Lebanon',
  '963':'Syria','964':'Iraq','20':'Egypt','212':'Morocco',
  '213':'Algeria','216':'Tunisia','249':'Sudan','92':'Pakistan',
  '91':'India','880':'Bangladesh','94':'Sri Lanka','44':'UK',
  '1':'USA','49':'Germany','33':'France','90':'Turkey',
};
function phoneToCountry(phone) {
  const d = phone.replace(/\D/g, '');
  for (const len of [3,2,1]) { const p = d.slice(0,len); if (PREFIXES[p]) return PREFIXES[p]; }
  return null;
}

// ── JWT ──
function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ email: user.email, name: user.name, role: user.role, exp: Date.now() + 86400000 * 30 })).toString('base64');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  try {
    const [payload, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

// ── HASH ──
function hashPw(pw) { return crypto.createHash('sha256').update(pw + JWT_SECRET).digest('hex'); }

// ── SERVE APP ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', async (req, res) => {
  const count = await DB.countListings();
  console.log(`🏥 Health check - Listings: ${count}, DB: ${db ? 'MongoDB' : 'Memory'}, Channels: ${Object.keys(channels).length}`);
  res.json({ status: 'ok', listings: count, db: db ? 'mongodb' : 'memory', channelsCount: Object.keys(channels).length });
});

// DEBUG ENDPOINT
app.get('/api/debug', async (req, res) => {
  const count = await DB.countListings();
  res.json({
    claudeKey: CLAUDE_KEY ? 'SET' : 'MISSING',
    db: db ? 'MongoDB' : 'Memory',
    listingsTotal: count,
    rawMessagesReceived: mem.rawMessages.length,
    channels: Object.keys(channels),
    channelsPersisted: db ? await db.collection('channels').countDocuments() : 'N/A',
  });
});

// ============================================================
// ⭐⭐⭐ MAIN WEBHOOK ENDPOINT - WITH FULL LOGGING ⭐⭐⭐
// ============================================================

// Multiple paths to handle Whapi variations
async function processWebhook(req, res) {
  const startTime = Date.now();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🔔 WEBHOOK HIT at ${new Date().toISOString()}`);
  console.log(`📌 Method: ${req.method}`);
  console.log(`📌 Path: ${req.path}`);
  console.log(`📌 Query params:`, req.query);
  
  // Send immediate 200 response (Whapi requires this)
  res.sendStatus(200);
  
  // Get channel ID
  const channelId = req.query.channel || req.headers['x-channel-id'] || 'default';
  console.log(`📱 Channel ID: ${channelId}`);
  
  // Get messages
  const messages = req.body.messages || [];
  const entry = req.body.entry || [];
  
  let allMessages = messages;
  if (entry.length > 0 && entry[0].changes) {
    allMessages = entry[0].changes.flatMap(c => c.value?.messages || []);
  }
  
  console.log(`📨 Total messages in webhook: ${allMessages.length}`);
  
  for (let idx = 0; idx < allMessages.length; idx++) {
    const msg = allMessages[idx];
    console.log(`\n--- Processing message ${idx + 1}/${allMessages.length} ---`);
    
    const text = msg.text?.body || msg.caption || msg.text || '';
    console.log(`📝 Raw text: "${text.substring(0, 200)}"`);
    
    // Skip empty or very short messages
    if (!text || text.length < 3) {
      console.log(`⏭️ Skipping: text too short or empty`);
      continue;
    }
    
    // Skip outgoing messages
    if (msg.from_me) {
      console.log(`⏭️ Skipping: message from me (outgoing)`);
      continue;
    }
    
    const sender = (msg.from || 'Unknown').replace('@s.whatsapp.net','').replace('@g.us','');
    const group = msg.chat_id || msg.chatId || 'Unknown';
    const groupName = msg.chat_name || msg.notify || msg.chatName || group;
    const ts = msg.timestamp || Math.floor(Date.now()/1000);
    
    console.log(`👤 Sender: ${sender}`);
    console.log(`👥 Group: ${group} (${groupName})`);
    
    // ⭐ SKIP INDIVIDUAL/PRIVATE MESSAGES ⭐
    if (!group.includes('@g.us') && !group.includes('g.us')) {
      console.log(`⏭️ SKIPPING: Individual/private message (not a group). Chat ID: ${group}`);
      continue;
    }
    
    // Track group in channel registry
    trackGroup(channelId, group, groupName);
    
    // Check if group is allowed
    if (!isGroupAllowed(channelId, group)) {
      console.log(`⏭️ Skipping: group disabled for this channel`);
      continue;
    }
    
    // Store raw message
    mem.rawMessages.unshift({ text, sender, group, groupName, channelId, ts });
    if (mem.rawMessages.length > 200) mem.rawMessages.pop();
    
    // Try to classify with AI
    console.log(`🤖 Classifying message with AI...`);
    let classified = null;
    try {
      classified = await classifyMessage(text, sender);
      console.log(`📊 Classification result:`, JSON.stringify(classified));
    } catch(e) {
      console.log(`⚠️ Classification error:`, e.message);
    }
    
    const sellerCountry = phoneToCountry(sender);
    
    // Create listing object
    const listing = {
      id: `${ts}-${Math.random().toString(36).slice(2,7)}`,
      type: classified?.type || 'MESSAGE',
      condition: classified?.condition || null,
      model: classified?.model || null,
      storage: classified?.storage || null,
      ram: classified?.ram || null,
      color: classified?.color || null,
      qty: classified?.qty || null,
      grade: classified?.grade || null,
      price: classified?.price || null,
      currency: classified?.currency || 'USD',
      summary: classified?.summary || text.slice(0,80),
      dealScore: null,
      isFlagged: false,
      flagReason: null,
      sender,
      channelId,
      sellerCountry,
      listingCountry: classified?.country || null,
      group,
      timestamp: ts,
      raw: text,
      assignedTo: null,
      status: 'new',
      notes: [],
      createdAt: new Date(),
    };
    
    console.log(`✅ CREATED LISTING:`);
    console.log(`   ID: ${listing.id}`);
    console.log(`   Type: ${listing.type || 'MESSAGE'}`);
    console.log(`   Model: ${listing.model || 'N/A'}`);
    console.log(`   Price: ${listing.price || 'N/A'} ${listing.currency}`);
    
    // Save to database
    await DB.insertListing(listing);
    console.log(`💾 Listing saved to database`);
    
    // Check price alerts (only if price exists)
    if (listing.price) checkAlerts(listing);
    
    // Update trader stats
    if (!mem.traders[sender]) mem.traders[sender] = { wts:0, wtb:0, other:0, country: sellerCountry };
    if (listing.type === 'WTS') mem.traders[sender].wts++;
    else if (listing.type === 'WTB') mem.traders[sender].wtb++;
    else mem.traders[sender].other++;
    
    console.log(`📊 Trader stats updated for ${sender}`);
    
    // AI deal scoring (async, don't block)
    if (listing.model && listing.price) {
      scoreListing(listing).then(scored => {
        Object.assign(listing, scored);
        DB.updateListing(listing.id, scored);
        console.log(`⭐ Listing scored: ${scored.dealScore}/10`);
      }).catch(e => console.log(`Score error: ${e.message}`));
    }
  }
  
  const duration = Date.now() - startTime;
  console.log(`✨ Webhook processing complete in ${duration}ms`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// Register webhook endpoints
app.post('/webhook', processWebhook);
app.post('/webhook/messages/post', processWebhook);
app.post('/webhook/messages', processWebhook);

// Test endpoint for debugging
app.get('/webhook-test', (req, res) => {
  console.log('🔔 WEBHOOK TEST GET hit');
  res.json({ message: 'Webhook test endpoint working', channels: Object.keys(channels) });
});

app.post('/webhook-test', (req, res) => {
  console.log('🔔 WEBHOOK TEST POST hit');
  console.log('Body:', JSON.stringify(req.body, null, 2));
  res.json({ message: 'Webhook test received', body: req.body });
});

// ── AI CLASSIFICATION ──
async function classifyMessage(text, sender) {
  if (!CLAUDE_KEY) return fallback(text);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':CLAUDE_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 400,
        system: `Electronics trading WhatsApp classifier for Middle East markets. Return ONLY valid JSON:
{"type":"WTS"|"WTB"|"UNKNOWN","condition":"Brand New"|"Used","model":"brand+model or null","storage":"e.g.256GB or null","ram":"e.g.8GB or null","color":"color or null","qty":number|null,"grade":"A+"|"A"|"B+"|"B"|"C"|null,"price":number|null,"currency":"USD"|"AED"|"EUR"|"GBP"|"SAR"|"KWD"|null,"country":"country from text or null","summary":"max 80 chars"}`,
        messages: [{ role:'user', content:`Phone:${sender}\nMessage:${text}` }],
      }),
    });
    const d = await r.json();
    return JSON.parse((d.content?.[0]?.text||'{}').trim());
  } catch { return fallback(text); }
}

// ── AI DEAL SCORING ──
async function scoreListing(listing) {
  if (!CLAUDE_KEY || !listing.model) return { dealScore: null, isFlagged: false };
  try {
    const allListings = await DB.getListings({ model: listing.model }, 20);
    const prices = allListings.filter(l=>l.price&&l.type===listing.type).map(l=>l.price);
    const avgPrice = prices.length ? Math.round(prices.reduce((a,b)=>a+b,0)/prices.length) : null;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':CLAUDE_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 200,
        system: `You score electronics trading listings 1-10 and detect fake/suspicious ones. Return ONLY JSON: {"score":number,"reason":"one line","isFlagged":boolean,"flagReason":"reason or null"}`,
        messages: [{ role:'user', content:`Listing: ${listing.type} ${listing.condition} ${listing.model} ${listing.storage||''} ${listing.color||''} ${listing.grade?'Grade '+listing.grade:''} Price:${listing.price?'$'+listing.price:'not stated'} Qty:${listing.qty||1}\nMarket avg for similar: ${avgPrice?'$'+avgPrice:'unknown'}\nMessage: ${listing.raw}\n\nScore 1-10 (10=excellent deal). Flag if price too low to be real, vague specs, or suspicious.` }],
      }),
    });
    const d = await r.json();
    const result = JSON.parse((d.content?.[0]?.text||'{}').trim());
    return { dealScore: result.score||null, isFlagged: result.isFlagged||false, flagReason: result.flagReason||null, scoreReason: result.reason||null };
  } catch { return { dealScore: null, isFlagged: false }; }
}

// ── PRICE ALERTS ──
async function checkAlerts(listing) {
  if (!listing.price || !listing.model) return;
  const alerts = mem.alerts.filter(a => a.active && a.model?.toLowerCase() === listing.model?.toLowerCase() && listing.price <= a.targetPrice);
  alerts.forEach(a => { console.log(`🔔 Alert: ${a.email} — ${listing.model} at $${listing.price} (target: $${a.targetPrice})`); });
}

// ============================================================
// AUTH ROUTES (unchanged)
// ============================================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });
    const existing = await DB.getUser(email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const users = await DB.getUsers();
    const role = users.length === 0 ? 'admin' : 'member';
    const user = { email, name, company: company||'', role, passwordHash: hashPw(password), createdAt: new Date() };
    await DB.insertUser(user);
    res.json({ token: makeToken(user), user: { email, name, role, company } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await DB.getUser(email);
    if (!user || user.passwordHash !== hashPw(password)) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token: makeToken(user), user: { email: user.email, name: user.name, role: user.role, company: user.company } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', authMiddleware, (req, res) => res.json(req.user));
app.get('/api/team', authMiddleware, async (req, res) => {
  const users = await DB.getUsers();
  res.json(users.map(u => ({ email: u.email, name: u.name, role: u.role, company: u.company })));
});

// ── LISTINGS API ──
app.get('/api/messages', authMiddleware, async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const limit  = parseInt(req.query.limit) || 100;
  const type   = req.query.type;
  const filter = { ...(since ? { timestamp: { $gt: since } } : {}), ...(type ? { type } : {}) };
  const listings = await DB.getListings(filter, limit);
  res.json(listings);
});

app.get('/api/stats', authMiddleware, async (req, res) => {
  const all = await DB.getListings({}, 2000);
  const prices = all.filter(l=>l.price).map(l=>l.price);
  const avg = prices.length ? Math.round(prices.reduce((a,b)=>a+b,0)/prices.length) : 0;
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const models={}, countries={}, grades={};
  all.forEach(l => {
    if(l.model) models[l.model]=(models[l.model]||0)+1;
    const c=l.sellerCountry||l.listingCountry; if(c) countries[c]=(countries[c]||0)+1;
    if(l.grade) grades['Grade '+l.grade]=(grades['Grade '+l.grade]||0)+1;
  });
  res.json({
    total: all.length,
    wts: all.filter(l=>l.type==='WTS').length,
    wtb: all.filter(l=>l.type==='WTB').length,
    brandNew: all.filter(l=>l.condition==='Brand New').length,
    used: all.filter(l=>l.condition==='Used').length,
    avgPrice: avg,
    traders: Object.keys(mem.traders).length,
    today: all.filter(l=>l.timestamp*1000>todayStart.getTime()).length,
    hotCount: all.filter(l=>l.dealScore>=8).length,
    flagged: all.filter(l=>l.isFlagged).length,
    models: topN(models,8), countries: topN(countries,8), grades: topN(grades,6),
    topTraders: Object.entries(mem.traders).map(([name,d])=>({name,total:d.wts+d.wtb,...d})).sort((a,b)=>b.total-a.total).slice(0,10),
  });
});

app.patch('/api/listings/:id', authMiddleware, async (req, res) => {
  const { status, assignedTo, note } = req.body;
  const update = {};
  if (status) update.status = status;
  if (assignedTo) update.assignedTo = assignedTo;
  if (note) {
    if (!mem.notes[req.params.id]) mem.notes[req.params.id] = [];
    mem.notes[req.params.id].push({ text: note, by: req.user.name, at: new Date() });
    update.notes = mem.notes[req.params.id];
  }
  await DB.updateListing(req.params.id, update);
  res.json({ ok: true });
});

app.post('/api/alerts', authMiddleware, async (req, res) => {
  const { model, targetPrice } = req.body;
  if (!model || !targetPrice) return res.status(400).json({ error: 'Missing fields' });
  const alert = { email: req.user.email, model, targetPrice: Number(targetPrice), active: true, createdAt: new Date() };
  await DB.saveAlert(alert);
  mem.alerts.push(alert);
  res.json({ ok: true, alert });
});

app.get('/api/alerts', authMiddleware, async (req, res) => {
  const alerts = await DB.getAlerts(req.user.email);
  res.json(alerts);
});

// ── AI ROUTES ──
async function claudeCall(prompt, system, maxTokens=1000) {
  if (!CLAUDE_KEY) return '⚠️ No Claude API key configured on server.';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':CLAUDE_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:maxTokens, system, messages:[{role:'user',content:prompt}] }),
  });
  const d = await r.json();
  return d.content?.[0]?.text || 'No response';
}

app.post('/api/ai/briefing', authMiddleware, async (req, res) => {
  const all = await DB.getListings({}, 200);
  const models={}, countries={};
  all.forEach(l=>{ if(l.model)models[l.model]=(models[l.model]||0)+1; const c=l.sellerCountry||l.listingCountry; if(c)countries[c]=(countries[c]||0)+1; });
  const topModels = Object.entries(models).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([m,n])=>m+'('+n+')').join(', ');
  const wts=all.filter(l=>l.type==='WTS').length, wtb=all.filter(l=>l.type==='WTB').length;
  const prices=all.filter(l=>l.price).map(l=>l.price);
  const avg=prices.length?Math.round(prices.reduce((a,b)=>a+b,0)/prices.length):0;
  const result = await claudeCall(
    `Market data:\n- Listings: ${all.length} (${wts} WTS, ${wtb} WTB)\n- Avg price: $${avg}\n- Top models: ${topModels}\n- Sample: ${all.slice(0,15).map(l=>`${l.type} ${l.model||'?'} ${l.price?'$'+l.price:''} ${l.sellerCountry||''}`).join('\n')}\n\nWrite a daily market briefing: hottest items, demand vs supply gaps, price trends, opportunities, risks. 6-8 bullet points.`,
    'You are a senior Middle East electronics wholesale market analyst. Be concise, specific, and actionable.'
  );
  res.json({ result });
});

app.post('/api/ai/price', authMiddleware, async (req, res) => {
  const { model } = req.body;
  const listings = await DB.getListings({ model }, 30);
  const prices = listings.filter(l=>l.price).map(l=>`${l.type} ${l.condition} ${l.grade?'Grade '+l.grade:''} $${l.price} ${l.currency}`).join('\n');
  const result = await claudeCall(
    `Device: ${model}\nOur market data:\n${prices||'No price data yet'}\n\nProvide: 1) Fair price range brand new and used by grade, 2) Buy or sell signal now, 3) Key specs to verify when buying used, 4) Red flags to avoid.`,
    'Expert Middle East electronics pricing analyst. Give specific USD and AED figures. Be concise.'
  );
  res.json({ result });
});

app.post('/api/ai/profile', authMiddleware, async (req, res) => {
  const { query } = req.body;
  const all = await DB.getListings({}, 2000);
  const listings = all.filter(l=>(l.sender||'').includes(query)||(l.sender||'').toLowerCase().includes(query.toLowerCase()));
  if (!listings.length) return res.json({ result: 'No listings found for: '+query });
  const summary = listings.map(l=>`${l.type} ${l.condition} ${l.model||'?'} ${l.grade?'Grade '+l.grade:''} ${l.price?'$'+l.price:''} ${l.sellerCountry||''}`).join('\n');
  const result = await claudeCall(
    `Trader: ${query}\nListings(${listings.length}): WTS:${listings.filter(l=>l.type==='WTS').length} WTB:${listings.filter(l=>l.type==='WTB').length}\n${summary}\n\nProfile: what they sell/buy, price range, activity level, reliability, country, trading style.`,
    'Electronics trader analyst. Be concise and analytical.'
  );
  res.json({ result });
});

app.post('/api/ai/autoreply', authMiddleware, async (req, res) => {
  const { listing, intent } = req.body;
  const result = await claudeCall(
    `Listing: ${listing.type} ${listing.condition} ${listing.model} ${listing.storage||''} ${listing.grade?'Grade '+listing.grade:''} ${listing.price?'$'+listing.price:''}\nSeller: ${listing.sender} (${listing.sellerCountry||'unknown'})\nMy intent: ${intent}\n\nDraft a professional WhatsApp reply in English. Keep it brief, friendly, and business-like. Include specific questions about specs/price if needed.`,
    'You draft professional WhatsApp replies for electronics wholesale traders in the Middle East. Be direct and professional.'
  );
  res.json({ result });
});

app.post('/api/ai/item', authMiddleware, async (req, res) => {
  const { question } = req.body;
  const result = await claudeCall(question, 'Expert in consumer electronics sold in Middle East wholesale market. Give specs, typical USD/AED prices, what to check when buying used. Be concise and practical.');
  res.json({ result });
});

app.post('/api/margin', authMiddleware, async (req, res) => {
  const { buyPrice, sellPrice, qty, shippingCost, dutyPct } = req.body;
  const buy = Number(buyPrice), sell = Number(sellPrice), q = Number(qty)||1;
  const shipping = Number(shippingCost)||0, duty = Number(dutyPct)||0;
  const totalCost = (buy + shipping/q) * (1 + duty/100);
  const profit = sell - totalCost;
  const margin = ((profit/sell)*100).toFixed(1);
  const totalProfit = profit * q;
  res.json({ totalCost: totalCost.toFixed(2), profit: profit.toFixed(2), margin, totalProfit: totalProfit.toFixed(2), roi: ((profit/totalCost)*100).toFixed(1) });
});

app.post('/api/snapshots', authMiddleware, async (req, res) => {
  const all = await DB.getListings({}, 2000);
  const models={};
  all.forEach(l=>{ if(l.model)models[l.model]=(models[l.model]||0)+1; });
  const snap = { date: new Date(), totalListings: all.length, wts: all.filter(l=>l.type==='WTS').length, wtb: all.filter(l=>l.type==='WTB').length, topModels: topN(models,5), createdBy: req.user.email };
  await DB.saveSnapshot(snap);
  res.json({ ok: true, snap });
});

app.get('/api/snapshots', authMiddleware, async (req, res) => {
  const snaps = await DB.getSnapshots(30);
  res.json(snaps);
});

app.get('/api/report', authMiddleware, async (req, res) => {
  const all = await DB.getListings({}, 2000);
  const models={}, countries={};
  all.forEach(l=>{ if(l.model)models[l.model]=(models[l.model]||0)+1; const c=l.sellerCountry||l.listingCountry; if(c)countries[c]=(countries[c]||0)+1; });
  res.json({ listings: all, models: topN(models,20), countries: topN(countries,20), traders: Object.entries(mem.traders).map(([name,d])=>({name,...d})).sort((a,b)=>(b.wts+b.wtb)-(a.wts+a.wtb)) });
});

function fallback(text) {
  const l = text.toLowerCase();
  const isWTS = l.includes('wts') || l.includes('selling') || l.includes('for sale') || 
                l.includes('للبيع') || l.includes('sale') || l.includes('sell') ||
                l.includes('available') || l.includes('offer') || l.includes('price');
  const isWTB = l.includes('wtb') || l.includes('looking for') || l.includes('buying') || 
                l.includes('wanted') || l.includes('need') || l.includes('want to buy') ||
                l.includes('looking to buy') || l.includes('wt buy');
  const type = isWTS ? 'WTS' : isWTB ? 'WTB' : 'UNKNOWN';
  const pm = text.match(/(\d[\d,]{2,})/);
  const isUsed = l.includes('used') || l.includes('grade') || l.includes('refurb') || l.includes('second hand');
  const gm = text.match(/grade\s*([ABC][+]?)/i);
  const modelPatterns = [
    /iphone\s*\d+\s*(pro\s*max|pro|plus|mini)?/i,
    /samsung\s*(galaxy)?\s*[a-z]?\d+\s*(ultra|plus|fe)?/i,
    /ipad\s*(pro|air|mini)?\s*\d*/i,
    /macbook\s*(pro|air|mini)?/i,
    /pixel\s*\d+\s*(pro|a)?/i,
  ];
  let model = null;
  for (const p of modelPatterns) {
    const m = text.match(p);
    if (m) { model = m[0].trim(); break; }
  }
  return { 
    type, 
    condition: isUsed ? 'Used' : 'Brand New', 
    model, 
    storage: null, ram: null, color: null, qty: null, 
    grade: isUsed && gm ? gm[1].toUpperCase() : null, 
    price: pm ? parseInt(pm[1].replace(/,/g,'')) : null, 
    currency: l.includes('aed') ? 'AED' : l.includes('sar') || l.includes('ريال') ? 'SAR' : 'USD', 
    country: null, 
    summary: text.slice(0,80) 
  };
}

function topN(obj, n) {
  return Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,n).reduce((acc,[k,v])=>{ acc[k]=v; return acc; }, {});
}

// ── CHANNEL MANAGEMENT API ──

app.get('/api/channels', authMiddleware, (req, res) => {
  res.json(Object.values(channels));
});

app.post('/api/channels', authMiddleware, async (req, res) => {
  const { id, label, token } = req.body;
  if (!id) return res.status(400).json({ error: 'Channel id required' });
  const ch = getOrCreateChannel(id, label);
  if (label) ch.label = label;
  if (token) ch.token = token;
  ch.active = true;
  await saveChannelToDB(ch);
  res.json({ ok: true, channel: ch });
});

app.patch('/api/channels/:id/toggle', authMiddleware, async (req, res) => {
  const ch = channels[req.params.id];
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  ch.active = !ch.active;
  await updateChannelInDB(req.params.id, { active: ch.active });
  res.json({ ok: true, active: ch.active });
});

app.delete('/api/channels/:id', authMiddleware, async (req, res) => {
  const channelId = req.params.id;
  delete channels[channelId];
  await deleteChannelFromDB(channelId);
  res.json({ ok: true });
});

app.get('/api/channels/:id/groups', authMiddleware, async (req, res) => {
  const ch = channels[req.params.id];
  const token = ch?.token || req.headers['x-whapi-token'];
  if (!token) return res.status(400).json({ error: 'No token for this channel' });
  try {
    const r = await fetch('https://gate.whapi.cloud/groups?count=100', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await r.json();
    const groups = (data.groups || []).map(g => ({
      id: g.id,
      name: g.name || g.subject || g.id,
      participants: g.participants_count || 0,
    }));
    if (ch) {
      groups.forEach(g => {
        if (!ch.groups[g.id]) ch.groups[g.id] = { id: g.id, name: g.name, enabled: true, messageCount: 0, participants: g.participants };
        else { ch.groups[g.id].name = g.name; ch.groups[g.id].participants = g.participants; }
      });
      await updateChannelGroupsInDB(req.params.id, ch.groups);
    }
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/channels/:channelId/groups/:groupId', authMiddleware, async (req, res) => {
  const ch = channels[req.params.channelId];
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  if (!ch.groups[req.params.groupId]) return res.status(404).json({ error: 'Group not found' });
  ch.groups[req.params.groupId].enabled = req.body.enabled;
  await updateChannelGroupsInDB(req.params.channelId, ch.groups);
  res.json({ ok: true });
});

app.put('/api/channels/:channelId/groups', authMiddleware, async (req, res) => {
  const ch = channels[req.params.channelId];
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  const { groups } = req.body;
  groups.forEach(g => { if (ch.groups[g.id]) ch.groups[g.id].enabled = g.enabled; });
  await updateChannelGroupsInDB(req.params.channelId, ch.groups);
  res.json({ ok: true });
});

// ── DAILY SNAPSHOT SCHEDULER ──
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 23 && now.getMinutes() < 5) {
    const all = await DB.getListings({}, 2000);
    const models={};
    all.forEach(l=>{ if(l.model)models[l.model]=(models[l.model]||0)+1; });
    await DB.saveSnapshot({ date: now, totalListings: all.length, wts: all.filter(l=>l.type==='WTS').length, wtb: all.filter(l=>l.type==='WTB').length, topModels: topN(models,5), auto: true });
    console.log('📸 Daily snapshot saved');
  }
}, 5 * 60 * 1000);

// ── START ──
connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════');
    console.log(`✅ WA Trading Platform Started on port ${PORT}`);
    console.log(`🗄️  Storage: ${db ? 'MongoDB' : 'In-Memory'}`);
    console.log(`🤖 Claude AI: ${CLAUDE_KEY ? 'Enabled' : 'Disabled'}`);
    console.log(`📱 Channels loaded: ${Object.keys(channels).length}`);
    console.log(`🌐 Webhook URL: https://watrading.onrender.com/webhook?channel=YOUR_CHANNEL_ID`);
    console.log(`🧪 Test webhook: POST to /webhook-test`);
    console.log('═══════════════════════════════════════════════════');
  });
});