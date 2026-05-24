const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_EMAIL = '350408962@tdsb.ca';

const CHAT_MAX_MESSAGES = 60;
const CHAT_TTL_MS = 1000 * 60 * 60 * 24 * 2;
const REPORT_MAX = 200;
const SUGGEST_MAX = 200;

const REPORT_CATEGORIES = ['Hacker', 'Bug', 'Cheat', 'Other'];
const SUGGEST_CATEGORIES = ['Gameplay', 'Shop', 'Teams', 'UI', 'Mutiplayer', 'Other'];

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'flappy-duck-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' }
  })
);

app.use(express.static(path.join(__dirname, 'public')));

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return defaultData();
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeData(parsed);
  } catch {
    return defaultData();
  }
}

function writeData(data) {
  const clean = normalizeData(data);
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function defaultData() {
  return {
    accounts: [],
    leaderboard: [],
    chat: [],
    reports: [],
    suggestions: [],
    teams: [],
    teamWars: { seasonId: '', startsAt: 0, endsAt: 0, teams: [] },
    events: []
  };
}

function normalizeData(data) {
  const base = defaultData();
  const out = Object.assign({}, base, data || {});
  out.accounts = Array.isArray(out.accounts) ? out.accounts : [];
  out.leaderboard = Array.isArray(out.leaderboard) ? out.leaderboard : [];
  out.chat = Array.isArray(out.chat) ? out.chat : [];
  out.reports = out.reports && Array.isArray(out.reports.reports) ? out.reports.reports : Array.isArray(out.reports) ? out.reports : [];
  out.suggestions = out.suggestions && Array.isArray(out.suggestions.suggestions) ? out.suggestions.suggestions : Array.isArray(out.suggestions) ? out.suggestions : [];
  out.teams = out.teams && Array.isArray(out.teams.teams) ? out.teams.teams : Array.isArray(out.teams) ? out.teams : [];
  if (!out.teamWars || typeof out.teamWars !== 'object') {
    out.teamWars = { seasonId: '', startsAt: 0, endsAt: 0, teams: [] };
  }
  out.teamWars.teams = Array.isArray(out.teamWars.teams) ? out.teamWars.teams : [];
  out.events = Array.isArray(out.events) ? out.events : [];
  return out;
}

function sanitizeText(text, maxLen) {
  return String(text || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLen || 240);
}

function sanitizeUsername(name) {
  const cleaned = String(name || '').trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9 ]{3,16}$/.test(cleaned)) return '';
  return cleaned;
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || ''), 'utf8').digest('hex');
}

function getSessionAccountId(req) {
  return String(req.session.accountId || '').trim();
}

function setSessionAccountId(req, accountId) {
  req.session.accountId = String(accountId || '').trim();
}

function clearSessionAccountId(req) {
  delete req.session.accountId;
}

function findAccountById(data, accountId) {
  return (data.accounts || []).find(a => String(a.accountId) === String(accountId)) || null;
}

function findAccountByUsername(data, username) {
  const clean = sanitizeUsername(username);
  if (!clean) return null;
  return (data.accounts || []).find(a => String(a.username || '').toLowerCase() === clean.toLowerCase()) || null;
}

function publicAccount(account) {
  if (!account) return null;
  return {
    accountId: String(account.accountId || ''),
    username: String(account.username || 'Guest'),
    banned: Boolean(account.banned),
    banReason: String(account.banReason || ''),
    best: Number(account.best || 0),
    coins: Number(account.coins || 0),
    inventory: account.inventory || { shield: 0, magnet: 0, slowmo: 0, burst: 0 },
    ownedSkins: Array.isArray(account.ownedSkins) ? account.ownedSkins : ['classic'],
    activeSkin: account.activeSkin || 'classic',
    theme: account.theme === 'night' ? 'night' : 'day',
    shieldCharges: Number(account.shieldCharges || 0),
    teamId: String(account.teamId || ''),
    eventClaims: Array.isArray(account.eventClaims) ? account.eventClaims : [],
    warBestRecorded: Number(account.warBestRecorded || 0),
    warCoinsRecorded: Number(account.warCoinsRecorded || 0),
    moderator: false
  };
}

function currentAccount(req) {
  const data = readData();
  const id = getSessionAccountId(req);
  if (!id) return null;
  return findAccountById(data, id);
}

function upsertLeaderboardRow(data, accountId, username, best, coins) {
  const cleanName = sanitizeUsername(username) || 'Guest';
  const idx = data.leaderboard.findIndex(r => String(r.key || '') === String(accountId));
  const row = {
    key: String(accountId || ''),
    username: cleanName,
    best: Math.max(0, Number(best) || 0),
    coins: Math.max(0, Number(coins) || 0),
    updated: new Date().toISOString()
  };

  if (idx >= 0) {
    row.best = Math.max(Number(data.leaderboard[idx].best) || 0, row.best);
    row.coins = Math.max(Number(data.leaderboard[idx].coins) || 0, row.coins);
    data.leaderboard[idx] = row;
  } else {
    data.leaderboard.push(row);
  }

  data.leaderboard.sort((a, b) => (Number(b.best) || 0) - (Number(a.best) || 0) || (Number(b.coins) || 0) - (Number(a.coins) || 0));
  data.leaderboard = data.leaderboard.slice(0, 25);
}

function readChat(data) {
  const now = Date.now();
  data.chat = (data.chat || []).filter(m => m && m.ts && now - Number(m.ts) <= CHAT_TTL_MS);
  return data.chat.slice(-CHAT_MAX_MESSAGES);
}

function recalcVotes(item) {
  const reactions = item.reactions && typeof item.reactions === 'object' ? item.reactions : {};
  let hearts = 0;
  let dislikes = 0;
  for (const vote of Object.values(reactions)) {
    if (vote === 'heart') hearts += 1;
    if (vote === 'dislike') dislikes += 1;
  }
  item.reactions = reactions;
  item.hearts = hearts;
  item.dislikes = dislikes;
  return item;
}

function summarizeReport(report, myKey) {
  const clean = recalcVotes(Object.assign({}, report));
  return {
    id: clean.id,
    category: clean.category || 'Other',
    title: clean.title || '',
    details: clean.details || '',
    username: clean.username || 'Guest',
    key: clean.key || '',
    hearts: Number(clean.hearts || 0),
    dislikes: Number(clean.dislikes || 0),
    myReaction: (clean.reactions && clean.reactions[myKey]) || '',
    createdAt: Number(clean.createdAt || Date.now()),
    targetAccountId: String(clean.targetAccountId || ''),
    targetUsername: String(clean.targetUsername || '')
  };
}

function summarizeSuggestionComment(comment, myKey) {
  const clean = recalcVotes(Object.assign({}, comment));
  return {
    id: clean.id,
    parentId: clean.parentId || '',
    text: clean.text || '',
    username: clean.username || 'Guest',
    key: clean.key || '',
    hearts: Number(clean.hearts || 0),
    dislikes: Number(clean.dislikes || 0),
    myReaction: (clean.reactions && clean.reactions[myKey]) || '',
    createdAt: Number(clean.createdAt || Date.now()),
    replies: Array.isArray(clean.replies) ? clean.replies.map(r => summarizeSuggestionComment(r, myKey)) : []
  };
}

function summarizeSuggestion(suggestion, myKey) {
  const clean = recalcVotes(Object.assign({}, suggestion));
  return {
    id: clean.id,
    category: clean.category || 'Other',
    title: clean.title || '',
    details: clean.details || '',
    username: clean.username || 'Guest',
    key: clean.key || '',
    hearts: Number(clean.hearts || 0),
    dislikes: Number(clean.dislikes || 0),
    myReaction: (clean.reactions && clean.reactions[myKey]) || '',
    createdAt: Number(clean.createdAt || Date.now()),
    comments: Array.isArray(clean.comments) ? clean.comments.map(c => summarizeSuggestionComment(c, myKey)) : []
  };
}

function sessionState(req) {
  const account = currentAccount(req);
  return {
    ok: true,
    account: account ? publicAccount(account) : null,
    playerKey: account ? String(account.accountId || '') : '',
    moderator: false
  };
}

app.get('/api/session', (req, res) => {
  res.json(sessionState(req));
});

app.post('/api/register', (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || '').trim();

  if (!username) return res.json({ ok: false, error: 'Username must be 3-16 letters, numbers, or spaces.' });
  if (password.length < 4) return res.json({ ok: false, error: 'Password must be at least 4 characters.' });

  const data = readData();
  if (findAccountByUsername(data, username)) {
    return res.json({ ok: false, error: 'That username already exists.' });
  }

  const account = {
    accountId: String(Date.now()) + String(Math.floor(Math.random() * 100000)),
    username,
    passHash: hashPassword(password),
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
    banned: false,
    banReason: '',
    best: 0,
    coins: 0,
    inventory: { shield: 0, magnet: 0, slowmo: 0, burst: 0 },
    ownedSkins: ['classic'],
    activeSkin: 'classic',
    theme: 'day',
    shieldCharges: 0,
    teamId: '',
    eventClaims: [],
    warBestRecorded: 0,
    warCoinsRecorded: 0
  };

  data.accounts.push(account);
  writeData(data);
  setSessionAccountId(req, account.accountId);
  res.json({ ok: true, message: 'Account created.', account: publicAccount(account) });
});

app.post('/api/login', (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || '').trim();

  if (!username) return res.json({ ok: false, error: 'Enter a valid username.' });
  if (!password) return res.json({ ok: false, error: 'Enter your password.' });

  const data = readData();
  const account = findAccountByUsername(data, username);
  if (!account) return res.json({ ok: false, error: 'Account not found.' });
  if (account.passHash !== hashPassword(password)) return res.json({ ok: false, error: 'Wrong password.' });
  if (account.banned) return res.json({ ok: false, error: account.banReason || 'You are banned.' });

  account.lastLoginAt = Date.now();
  writeData(data);
  setSessionAccountId(req, account.accountId);
  res.json({ ok: true, message: 'Logged in.', account: publicAccount(account) });
});

app.post('/api/logout', (req, res) => {
  clearSessionAccountId(req);
  res.json({ ok: true, message: 'Logged out.' });
});

app.post('/api/delete-account', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  if (String(req.body.confirmText || '').trim().toUpperCase() !== 'DELETE') {
    return res.json({ ok: false, error: 'Type DELETE to confirm.' });
  }

  const data = readData();
  data.accounts = data.accounts.filter(a => String(a.accountId) !== String(account.accountId));
  data.leaderboard = data.leaderboard.filter(r => String(r.key || '') !== String(account.accountId));
  data.reports = (data.reports || []).filter(r => String(r.key || '') !== String(account.accountId));
  data.suggestions = (data.suggestions || []).filter(s => String(s.key || '') !== String(account.accountId));
  writeData(data);
  clearSessionAccountId(req);
  res.json({ ok: true, message: 'Account deleted.' });
});

app.get('/api/game-data', (req, res) => {
  const account = currentAccount(req);
  if (!account) {
    return res.json({
      best: 0,
      coins: 0,
      inventory: { shield: 0, magnet: 0, slowmo: 0, burst: 0 },
      ownedSkins: ['classic'],
      activeSkin: 'classic',
      theme: 'day',
      shieldCharges: 0,
      username: '',
      teamId: '',
      eventClaims: [],
      warBestRecorded: 0,
      warCoinsRecorded: 0,
      playerKey: '',
      moderator: false
    });
  }

  const data = publicAccount(account);
  data.playerKey = String(account.accountId || '');
  data.moderator = false;
  res.json(data);
});

app.post('/api/game/save', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });

  const incoming = req.body || {};
  account.username = sanitizeUsername(incoming.username || account.username) || account.username;
  account.best = Math.max(Number(account.best || 0), Number(incoming.best || 0));
  account.coins = Math.max(0, Number(incoming.coins ?? account.coins) || 0);
  account.inventory = incoming.inventory && typeof incoming.inventory === 'object' ? incoming.inventory : account.inventory;
  account.ownedSkins = Array.isArray(incoming.ownedSkins) && incoming.ownedSkins.length ? incoming.ownedSkins : account.ownedSkins;
  account.activeSkin = account.ownedSkins.includes(String(incoming.activeSkin || account.activeSkin)) ? String(incoming.activeSkin || account.activeSkin) : 'classic';
  account.theme = incoming.theme === 'night' ? 'night' : 'day';
  account.shieldCharges = Math.max(0, Number(incoming.shieldCharges ?? account.shieldCharges) || 0);
  account.teamId = String(incoming.teamId || account.teamId || '').trim();
  account.eventClaims = Array.isArray(incoming.eventClaims) ? incoming.eventClaims.map(String) : account.eventClaims;
  account.warBestRecorded = Math.max(0, Number(incoming.warBestRecorded ?? account.warBestRecorded) || 0);
  account.warCoinsRecorded = Math.max(0, Number(incoming.warCoinsRecorded ?? account.warCoinsRecorded) || 0);

  const data = readData();
  const idx = data.accounts.findIndex(a => String(a.accountId) === String(account.accountId));
  if (idx >= 0) data.accounts[idx] = account;
  upsertLeaderboardRow(data, account.accountId, account.username, account.best, account.coins);
  writeData(data);

  res.json({
    ok: true,
    message: 'Sync Complete',
    data: publicAccount(account),
    leaderboards: {
      highscores: data.leaderboard.slice().sort((a, b) => (Number(b.best) || 0) - (Number(a.best) || 0)).slice(0, 10),
      coins: data.leaderboard.slice().sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0)).slice(0, 10)
    }
  });
});

app.get('/api/leaderboards', (req, res) => {
  const data = readData();
  const highscores = data.leaderboard.slice().sort((a, b) => (Number(b.best) || 0) - (Number(a.best) || 0)).slice(0, 10);
  const coins = data.leaderboard.slice().sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0)).slice(0, 10);
  res.json({ highscores, coins });
});

app.get('/api/chat', (req, res) => {
  const data = readData();
  res.json({ messages: readChat(data) });
});

app.post('/api/chat/send', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });

  const text = sanitizeText(req.body.message, 120);
  if (!text) return res.json({ ok: false, error: 'Message cannot be empty.' });

  const data = readData();
  data.chat = readChat(data);
  data.chat.push({
    id: crypto.randomUUID(),
    key: String(account.accountId || ''),
    username: sanitizeUsername(account.username) || 'Guest',
    text,
    ts: Date.now()
  });
  if (data.chat.length > CHAT_MAX_MESSAGES) data.chat = data.chat.slice(-CHAT_MAX_MESSAGES);
  writeData(data);
  res.json({ ok: true, messages: data.chat });
});

app.get('/api/reports', (req, res) => {
  const data = readData();
  const myKey = getSessionAccountId(req);
  const reports = (data.reports || []).map(r => summarizeReport(r, myKey)).sort((a, b) => {
    const cat = String(a.category || '').localeCompare(String(b.category || ''));
    if (cat) return cat;
    return ((Number(b.hearts) - Number(b.dislikes)) - (Number(a.hearts) - Number(a.dislikes))) || ((Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  });
  res.json({ categories: REPORT_CATEGORIES, reports });
});

app.post('/api/reports/send', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });

  const categoryInput = String(req.body.category || '').trim().toLowerCase();
  const category = REPORT_CATEGORIES.find(c => c.toLowerCase() === categoryInput) || 'Other';
  const title = sanitizeText(req.body.title, 48);
  const details = sanitizeText(req.body.details, 240);
  const targetAccountId = String(req.body.targetAccountId || '').trim();
  const targetUsername = sanitizeUsername(req.body.targetUsername);

  if (!title && !details) return res.json({ ok: false, error: 'Report cannot be empty.' });

  const data = readData();
  data.reports = Array.isArray(data.reports) ? data.reports : [];
  data.reports.push({
    id: crypto.randomUUID(),
    category,
    title: title || details.slice(0, 48) || 'Report',
    details: details || title,
    username: sanitizeUsername(account.username) || 'Guest',
    key: String(account.accountId || ''),
    createdAt: Date.now(),
    reactions: {},
    targetAccountId: targetAccountId || '',
    targetUsername: targetUsername || ''
  });
  if (data.reports.length > REPORT_MAX) data.reports = data.reports.slice(-REPORT_MAX);
  writeData(data);
  res.json({ ok: true, reports: (data.reports || []).map(r => summarizeReport(r, getSessionAccountId(req))) });
});

app.post('/api/reports/vote', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });

  const vote = String(req.body.reaction || '').trim().toLowerCase();
  if (vote !== 'heart' && vote !== 'dislike') return res.json({ ok: false, error: 'Invalid vote.' });

  const data = readData();
  const report = (data.reports || []).find(r => String(r.id) === String(req.body.reportId || ''));
  if (!report) return res.json({ ok: false, error: 'Report not found.' });

  report.reactions = report.reactions && typeof report.reactions === 'object' ? report.reactions : {};
  const key = String(account.accountId || '');
  if (report.reactions[key] === vote) delete report.reactions[key];
  else report.reactions[key] = vote;

  writeData(data);
  res.json({ ok: true, reports: (data.reports || []).map(r => summarizeReport(r, getSessionAccountId(req))) });
});

app.get('/api/suggestions', (req, res) => {
  const data = readData();
  const myKey = getSessionAccountId(req);
  const suggestions = (data.suggestions || []).map(s => summarizeSuggestion(s, myKey)).sort((a, b) => {
    const cat = String(a.category || '').localeCompare(String(b.category || ''));
    if (cat) return cat;
    return ((Number(b.hearts) - Number(b.dislikes)) - (Number(a.hearts) - Number(a.dislikes))) || ((Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  });
  res.json({ categories: SUGGEST_CATEGORIES, suggestions });
});

app.post('/api/suggestions/send', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });

  const categoryInput = String(req.body.category || '').trim().toLowerCase();
  const category = SUGGEST_CATEGORIES.find(c => c.toLowerCase() === categoryInput) || 'Other';
  const title = sanitizeText(req.body.title, 48);
  const details = sanitizeText(req.body.details, 240);

  if (!title && !details) return res.json({ ok: false, error: 'Suggestion cannot be empty.' });

  const data = readData();
  data.suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
  data.suggestions.push({
    id: crypto.randomUUID(),
    category,
    title: title || details.slice(0, 48) || 'Suggestion',
    details: details || title,
    username: sanitizeUsername(account.username) || 'Guest',
    key: String(account.accountId || ''),
    createdAt: Date.now(),
    reactions: {},
    comments: []
  });
  if (data.suggestions.length > SUGGEST_MAX) data.suggestions = data.suggestions.slice(-SUGGEST_MAX);
  writeData(data);
  res.json({ ok: true, suggestions: (data.suggestions || []).map(s => summarizeSuggestion(s, getSessionAccountId(req))) });
});

app.post('/api/suggestions/vote', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });

  const vote = String(req.body.reaction || '').trim().toLowerCase();
  if (vote !== 'heart' && vote !== 'dislike') return res.json({ ok: false, error: 'Invalid vote.' });

  const data = readData();
  const suggestion = (data.suggestions || []).find(s => String(s.id) === String(req.body.suggestionId || ''));
  if (!suggestion) return res.json({ ok: false, error: 'Suggestion not found.' });

  suggestion.reactions = suggestion.reactions && typeof suggestion.reactions === 'object' ? suggestion.reactions : {};
  const key = String(account.accountId || '');
  if (suggestion.reactions[key] === vote) delete suggestion.reactions[key];
  else suggestion.reactions[key] = vote;

  writeData(data);
  res.json({ ok: true, suggestions: (data.suggestions || []).map(s => summarizeSuggestion(s, getSessionAccountId(req))) });
});

app.post('/api/suggestions/comment', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });

  const suggestionId = String(req.body.suggestionId || '').trim();
  const parentId = String(req.body.parentId || '').trim();
  const text = sanitizeText(req.body.text, 240);
  if (!suggestionId) return res.json({ ok: false, error: 'Missing suggestion.' });
  if (!text) return res.json({ ok: false, error: 'Comment cannot be empty.' });

  const data = readData();
  const suggestion = (data.suggestions || []).find(s => String(s.id) === suggestionId);
  if (!suggestion) return res.json({ ok: false, error: 'Suggestion not found.' });

  const comment = {
    id: crypto.randomUUID(),
    parentId: parentId || '',
    text,
    username: sanitizeUsername(account.username) || 'Guest',
    key: String(account.accountId || ''),
    createdAt: Date.now(),
    reactions: {},
    replies: []
  };

  if (!parentId) {
    suggestion.comments = Array.isArray(suggestion.comments) ? suggestion.comments : [];
    suggestion.comments.push(comment);
  } else {
    const walk = (list) => {
      for (const item of list) {
        if (String(item.id) === parentId) {
          item.replies = Array.isArray(item.replies) ? item.replies : [];
          item.replies.push(comment);
          return true;
        }
        if (walk(item.replies || [])) return true;
      }
      return false;
    };
    if (!walk(suggestion.comments || [])) return res.json({ ok: false, error: 'Reply target not found.' });
  }

  writeData(data);
  res.json({ ok: true, suggestions: (data.suggestions || []).map(s => summarizeSuggestion(s, getSessionAccountId(req))) });
});

app.get('/api/events', (req, res) => {
  const data = readData();
  res.json({ events: data.events || [] });
});

io.on('connection', (socket) => {
  socket.on('join-game', (payload) => {
    socket.data.player = {
      id: socket.id,
      name: sanitizeText(payload && payload.name, 10) || 'Duck',
      x: Number(payload && payload.x) || 0,
      y: Number(payload && payload.y) || 0,
      score: Number(payload && payload.score) || 0,
      isDead: Boolean(payload && payload.isDead)
    };
    socket.emit('current-players', {});
    socket.broadcast.emit('player-joined', socket.data.player);
  });

  socket.on('update-position', (payload) => {
    if (!socket.data.player) return;
    socket.data.player = {
      id: socket.id,
      name: sanitizeText(payload && payload.name, 10) || socket.data.player.name || 'Duck',
      x: Number(payload && payload.x) || 0,
      y: Number(payload && payload.y) || 0,
      score: Number(payload && payload.score) || 0,
      isDead: Boolean(payload && payload.isDead)
    };
    socket.broadcast.emit('player-state', socket.data.player);
  });

  socket.on('disconnect', () => {
    socket.broadcast.emit('player-disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
