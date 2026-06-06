const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const AUTH_COOKIE = 'fd_auth';
const AUTH_SECRET = process.env.AUTH_SECRET || 'flappy-duck-secret';
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');

const CHAT_MAX_MESSAGES = 60;
const CHAT_TTL_MS = 1000 * 60 * 60 * 24 * 2;
const REPORT_CATEGORIES = ['Hacker', 'Bug', 'Cheat', 'Other'];
const REPORT_MAX = 200;
const SUGGEST_CATEGORIES = ['Gameplay', 'Shop', 'Teams', 'UI', 'Multiplayer', 'Other'];
const SUGGEST_MAX = 200;
const WEEK_MS = 1000 * 60 * 60 * 24 * 7;
const MULTIPLAYER_TIMEOUT_MS = 12000;

const PVP_MODES = {
  easy: { label: 'Easy', reward: 10 },
  normal: { label: 'Normal', reward: 20 },
  hard: { label: 'Hard', reward: 35 },
  impossible: { label: 'Impossible', reward: 50 }
};
const PVP_MIN_MS = 20_000;
const PVP_MAX_MS = 10 * 60_000;
const PVP_MAX_PLAYERS = 5;

const onlinePlayers = new Map();
let livePvpPlayers = 0;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

function sendIndex(res) {
  if (fs.existsSync(INDEX_FILE)) return res.sendFile(INDEX_FILE);
  return res.status(200).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Flappy Duck</title></head><body><h1>Flappy Duck server is running.</h1><p>index.html was not found beside server.js.</p></body></html>`);
}

function weekStartMs(ts = Date.now()) {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d.getTime();
}

function currentSeason() {
  const startsAt = weekStartMs(Date.now());
  return { id: new Date(startsAt).toISOString().slice(0, 10), startsAt, endsAt: startsAt + WEEK_MS };
}

function defaultTeamWars() {
  const season = currentSeason();
  return { seasonId: season.id, startsAt: season.startsAt, endsAt: season.endsAt, teams: [] };
}

function defaultEvents() {
  const season = currentSeason();
  return {
    version: 1,
    featured: [
      { id: 'weekly-flap-rush', title: 'Weekly Flap Rush', desc: 'Highest score this week gets bragging rights.', rewardCoins: 250, endsAt: season.endsAt },
      { id: 'coin-collector', title: 'Coin Collector', desc: 'Keep stacking coins across the week.', rewardCoins: 150, endsAt: season.endsAt },
      { id: 'team-war-boost', title: 'Team War Bonus', desc: 'Your runs push your team upward in Team Wars.', rewardCoins: 100, endsAt: season.endsAt }
    ]
  };
}

function defaultData() {
  return {
    accounts: [],
    leaderboard: [],
    chat: [],
    reports: [],
    suggestions: [],
    teams: [],
    teamWars: defaultTeamWars(),
    events: defaultEvents()
  };
}

function normalizeData(data) {
  const base = defaultData();
  const out = Object.assign({}, base, data || {});
  out.accounts = Array.isArray(out.accounts) ? out.accounts : [];
  out.leaderboard = Array.isArray(out.leaderboard) ? out.leaderboard : [];
  out.chat = Array.isArray(out.chat) ? out.chat : [];
  out.reports = Array.isArray(out.reports) ? out.reports : [];
  out.suggestions = Array.isArray(out.suggestions) ? out.suggestions : [];
  out.teams = Array.isArray(out.teams) ? out.teams : [];
  if (!out.teamWars || typeof out.teamWars !== 'object' || !Array.isArray(out.teamWars.teams)) out.teamWars = defaultTeamWars();
  if (!out.events || typeof out.events !== 'object' || !Array.isArray(out.events.featured)) out.events = defaultEvents();
  return out;
}

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultData();
    return normalizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch {
    return defaultData();
  }
}

function writeData(data) {
  const clean = normalizeData(data);
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function sanitizeText(text, maxLen = 240) {
  return String(text || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLen);
}

function sanitizeUsername(name) {
  const cleaned = String(name || '').trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9 ]{3,16}$/.test(cleaned)) return '';
  return cleaned;
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || ''), 'utf8').digest('hex');
}

function signValue(value) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(String(value || ''), 'utf8').digest('hex');
}

function makeAuthCookie(accountId) {
  const id = String(accountId || '').trim();
  if (!id) return '';
  return `${id}.${signValue(id)}`;
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  if (!header) return {};
  const out = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
  }
  return out;
}

function getAuthAccountId(req) {
  const raw = parseCookies(req)[AUTH_COOKIE];
  if (!raw) return '';
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return '';
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (sig !== signValue(id)) return '';
  return String(id || '').trim();
}

function setAuthCookie(res, accountId) {
  const value = makeAuthCookie(accountId);
  if (!value) return;
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
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
    blockPvpRequests: Boolean(account.blockPvpRequests || false),
    moderator: false
  };
}

function currentAccount(req) {
  const data = readData();
  const id = getAuthAccountId(req);
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

function findSuggestionComment(comments, commentId) {
  for (const comment of (comments || [])) {
    if (String(comment.id) === String(commentId)) return comment;
    const nested = findSuggestionComment(comment.replies || [], commentId);
    if (nested) return nested;
  }
  return null;
}

function createTeamMember(key, username, role, best, coins) {
  return {
    key: String(key || '').trim(),
    username: sanitizeUsername(username) || 'Guest',
    role: role || 'member',
    best: Math.max(0, Number(best) || 0),
    coins: Math.max(0, Number(coins) || 0),
    joinedAt: Date.now()
  };
}

function summarizeTeam(team) {
  const members = Array.isArray(team.members) ? team.members : [];
  const totalBest = members.reduce((sum, m) => sum + (Number(m.best) || 0), 0);
  const totalCoins = members.reduce((sum, m) => sum + (Number(m.coins) || 0), 0);
  return {
    id: team.id,
    name: team.name,
    ownerKey: team.ownerKey,
    ownerName: team.ownerName,
    maxPlayers: Number(team.maxPlayers || 5),
    memberCount: members.length,
    totalBest,
    totalCoins,
    updatedAt: Number(team.updatedAt || Date.now())
  };
}

function findTeamById(state, teamId) {
  return (state.teams || []).find(t => String(t.id) === String(teamId)) || null;
}

function clampTeamSize(n) {
  return Math.max(5, Math.min(10, Number(n) || 5));
}

function isBannedFromTeam(team, key, username) {
  const k = String(key || '').trim();
  const u = sanitizeUsername(username) || '';
  return (team.bans || []).some(b => {
    const bk = String(b.key || '').trim();
    const bu = sanitizeUsername(b.username || '') || '';
    return (k && bk && k === bk) || (u && bu && u.toLowerCase() === bu.toLowerCase());
  });
}

function resolveTeamIdForUser(key, username) {
  const data = readData();
  const k = String(key || '').trim();
  const u = sanitizeUsername(username) || '';
  for (const team of data.teams || []) {
    for (const member of team.members || []) {
      if ((k && String(member.key || '') === k) || (u && String(member.username || '').toLowerCase() === u.toLowerCase())) return team.id;
    }
  }
  return '';
}

function sanitizeTeamForCurrentUser(team, currentKey) {
  const isOwner = String(team.ownerKey || '') === String(currentKey || '');
  const base = summarizeTeam(team);
  base.members = (team.members || []).map(m => ({ key: m.key, username: m.username, role: m.role || 'member', best: Number(m.best || 0), coins: Number(m.coins || 0) }));
  base.isOwner = isOwner;
  base.requests = isOwner ? (team.requests || []).map(r => ({ key: r.key, username: r.username, ts: Number(r.ts || Date.now()) })) : [];
  base.invites = isOwner ? (team.invites || []).map(i => ({ username: i.username, key: i.key || '', ts: Number(i.ts || Date.now()) })) : [];
  base.bans = isOwner ? (team.bans || []).map(b => ({ key: b.key || '', username: b.username || 'Unknown', ts: Number(b.ts || Date.now()) })) : [];
  return base;
}

function getTeamLeaderboard() {
  const data = readData();
  return (data.teams || [])
    .map(team => summarizeTeam(team))
    .sort((a, b) => (Number(b.totalBest) || 0) - (Number(a.totalBest) || 0) || (Number(b.totalCoins) || 0) - (Number(a.totalCoins) || 0))
    .slice(0, 10);
}

function getTeamWarsData() {
  const data = readData();
  const season = currentSeason();
  const state = data.teamWars || defaultTeamWars();

  if (String(state.seasonId || '') !== String(season.id)) {
    data.teamWars = defaultTeamWars();
    writeData(data);
    return { season: currentSeason(), leaderboard: [] };
  }

  const leaderboard = (state.teams || [])
    .slice()
    .sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0))
    .slice(0, 10)
    .map((row, i) => ({ rank: i + 1, teamId: row.teamId, teamName: row.teamName || 'Team', points: Number(row.points || 0), updatedAt: Number(row.updatedAt || Date.now()) }));

  return { season: { id: state.seasonId, startsAt: Number(state.startsAt || season.startsAt), endsAt: Number(state.endsAt || season.endsAt) }, leaderboard };
}

function awardTeamWarPointsInData(data, teamId, points) {
  const id = String(teamId || '').trim();
  if (!id) return false;
  const season = currentSeason();
  let state = data.teamWars || defaultTeamWars();
  if (String(state.seasonId || '') !== String(season.id)) state = defaultTeamWars();
  state.teams = Array.isArray(state.teams) ? state.teams : [];
  let row = state.teams.find(t => String(t.teamId) === id);
  if (!row) { row = { teamId: id, teamName: 'Team', points: 0, updatedAt: Date.now() }; state.teams.push(row); }
  const team = findTeamById({ teams: data.teams || [] }, id);
  row.teamName = team ? String(team.name || 'Team') : 'Team';
  row.points = Math.max(0, Number(row.points || 0)) + Math.max(0, Number(points || 0));
  row.updatedAt = Date.now();
  data.teamWars = state;
  return true;
}

function isAdminRequest(req) {
  const token = String(req.headers['x-admin-key'] || '').trim();
  return token && token === ADMIN_KEY;
}

function snapshotOnlinePlayer(socket, extra = {}) {
  const info = socket && socket.data && socket.data.playerInfo ? socket.data.playerInfo : {};
  return {
    id: String(socket && socket.id || ''),
    username: sanitizeUsername(extra.username || info.username || 'Guest') || 'Guest',
    score: Math.max(0, Number(extra.score || 0)),
    pvpActive: Boolean(extra.pvpActive || false),
    roomId: String(extra.roomId || info.roomId || ''),
    lastSeen: Date.now()
  };
}

function broadcastOnlinePlayers() {
  const list = Array.from(onlinePlayers.values()).map((row) => ({
    id: String(row.id || ''),
    username: String(row.username || 'Guest'),
    score: Math.max(0, Number(row.score || 0)),
    pvpActive: Boolean(row.pvpActive || false),
    roomId: String(row.roomId || ''),
    lastSeen: Number(row.lastSeen || Date.now())
  }));
  io.emit('onlinePlayers', list);
  io.emit('onlineCount', list.length);
}

function setOnlinePlayer(socket, extra = {}) {
  if (!socket) return;
  onlinePlayers.set(socket.id, snapshotOnlinePlayer(socket, extra));
  broadcastOnlinePlayers();
}

function clearOnlinePlayer(socketId) {
  if (!socketId) return;
  onlinePlayers.delete(socketId);
  broadcastOnlinePlayers();
}

function updateLivePvpCount() {
  io.emit('livePvpUpdate', { players: livePvpPlayers, updated: Date.now() });
}

function getGameDataForAccount(account) {
  if (!account) {
    return {
      best: 0, coins: 0,
      inventory: { shield: 0, magnet: 0, slowmo: 0, burst: 0 },
      ownedSkins: ['classic'], activeSkin: 'classic', theme: 'day', shieldCharges: 0,
      username: '', teamId: '', eventClaims: [], warBestRecorded: 0, warCoinsRecorded: 0,
      playerKey: '', moderator: false, blockPvpRequests: false
    };
  }
  const data = publicAccount(account);
  data.playerKey = String(account.accountId || '');
  data.moderator = false;
  return data;
}

function normalizeInventory(inventory) {
  const src = inventory && typeof inventory === 'object' ? inventory : {};
  return { shield: Math.max(0, Number(src.shield) || 0), magnet: Math.max(0, Number(src.magnet) || 0), slowmo: Math.max(0, Number(src.slowmo) || 0), burst: Math.max(0, Number(src.burst) || 0) };
}

function normalizeSkins(skins) {
  const list = Array.isArray(skins) && skins.length ? skins.slice() : ['classic'];
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const id = String(s || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (!out.includes('classic')) out.unshift('classic');
  return out;
}

function getReportData(req) {
  const key = getAuthAccountId(req);
  const data = readData();
  const reports = (data.reports || []).map(r => summarizeReport(r, key)).sort((a, b) => {
    const cat = String(a.category || '').localeCompare(String(b.category || ''));
    if (cat) return cat;
    return ((Number(b.hearts) - Number(b.dislikes)) - (Number(a.hearts) - Number(a.dislikes))) || ((Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  });
  return { categories: REPORT_CATEGORIES.slice(), reports };
}

function getSuggestionData(req) {
  const key = getAuthAccountId(req);
  const data = readData();
  const suggestions = (data.suggestions || []).map(s => summarizeSuggestion(s, key)).sort((a, b) => {
    const cat = String(a.category || '').localeCompare(String(b.category || ''));
    if (cat) return cat;
    return ((Number(b.hearts) - Number(b.dislikes)) - (Number(a.hearts) - Number(a.dislikes))) || ((Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  });
  return { categories: SUGGEST_CATEGORIES.slice(), suggestions };
}

function getTeamDataSnapshot(req) {
  const data = readData();
  const key = getAuthAccountId(req);
  const account = currentAccount(req);
  const username = sanitizeUsername(account && account.username) || 'Guest';
  const resolvedTeamId = resolveTeamIdForUser(key, username);
  const currentTeam = resolvedTeamId ? findTeamById({ teams: data.teams || [] }, resolvedTeamId) : null;

  const invites = [];
  for (const team of data.teams || []) {
    for (const inv of team.invites || []) {
      if ((sanitizeUsername(inv.username) || '') === username) {
        invites.push({ id: team.id, name: team.name, ownerName: team.ownerName, maxPlayers: Number(team.maxPlayers || 5), memberCount: (team.members || []).length });
      }
    }
  }

  const requests = [];
  for (const team of data.teams || []) {
    for (const reqItem of team.requests || []) {
      if (String(reqItem.key || '') === key) {
        requests.push({ id: team.id, name: team.name, ownerName: team.ownerName, ts: Number(reqItem.ts || Date.now()) });
      }
    }
  }

  return {
    teams: (data.teams || []).map(summarizeTeam).sort((a, b) => (Number(b.totalBest) || 0) - (Number(a.totalBest) || 0)),
    leaderboard: getTeamLeaderboard(),
    currentTeam: currentTeam ? sanitizeTeamForCurrentUser(currentTeam, key) : null,
    invites,
    requests
  };
}

function createTeam(data, req) {
  const account = currentAccount(req);
  if (!account) return { ok: false, error: 'Please log in first.' };
  const key = String(account.accountId || '');
  const username = sanitizeUsername(account.username) || 'Guest';
  const name = String(data && data.name || '').trim().replace(/\s+/g, ' ');
  const maxPlayers = clampTeamSize(data && data.maxPlayers);
  if (!/^[A-Za-z0-9 _-]{3,24}$/.test(name)) return { ok: false, error: 'Team name must be 3-24 characters and can only contain letters, numbers, spaces, underscores, and dashes.' };
  const db = readData();
  if (resolveTeamIdForUser(key, username)) return { ok: false, error: 'Leave your current team before creating a new one.' };
  const team = { id: crypto.randomUUID(), name, ownerKey: key, ownerName: username, maxPlayers, members: [createTeamMember(key, username, 'owner', account.best, account.coins)], requests: [], invites: [], bans: [], updatedAt: Date.now() };
  db.teams.push(team);
  account.teamId = team.id;
  const idx = db.accounts.findIndex(a => String(a.accountId) === key);
  if (idx >= 0) db.accounts[idx] = account;
  writeData(db);
  return { ok: true, message: 'Team created.', team: sanitizeTeamForCurrentUser(team, key), data: getTeamDataSnapshot(req) };
}

function voteReactionTarget(item, vote, key) {
  item.reactions = item.reactions && typeof item.reactions === 'object' ? item.reactions : {};
  if (item.reactions[key] === vote) delete item.reactions[key]; else item.reactions[key] = vote;
  recalcVotes(item);
}

function normalizeIncomingBody(body) { return (!body || typeof body !== 'object') ? {} : body; }
function getBodyValue(body, keys, fallback = '') {
  const data = normalizeIncomingBody(body);
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined && data[key] !== null) return data[key];
  }
  return fallback;
}

const multiplayerState = new Map();
const pvpRooms = new Map();

function snapshotPlayer(player) {
  return {
    id: String(player.id || ''),
    name: String(player.name || 'Duck'),
    username: String(player.username || player.name || 'Guest'),
    x: Number(player.x) || 0,
    y: Number(player.y) || 0,
    score: Number(player.score) || 0,
    rot: Number(player.rot) || 0,
    skin: String(player.skin || 'classic'),
    alive: player.alive !== false,
    lastSeen: Number(player.lastSeen || Date.now()) || Date.now(),
    accountId: String(player.accountId || ''),
    blockPvpRequests: Boolean(player.blockPvpRequests || false)
  };
}

function pruneMultiplayerState() {
  const now = Date.now();
  for (const [id, player] of multiplayerState.entries()) {
    if (!player.lastSeen || now - player.lastSeen > MULTIPLAYER_TIMEOUT_MS) {
      multiplayerState.delete(id);
      io.emit('player-disconnected', id);
    }
  }
}
setInterval(pruneMultiplayerState, 5000).unref?.();

function normalizePvpMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PVP_MODES, m) ? m : 'normal';
}
function clampPvpDuration(ms) {
  const n = Math.floor(Number(ms) || 0);
  return Math.max(PVP_MIN_MS, Math.min(PVP_MAX_MS, Number.isFinite(n) ? n : 60_000));
}
function pvpRoomSnapshot(room) {
  return { id: room.id, hostSocketId: room.hostSocketId, hostUsername: room.hostUsername, mode: room.mode, durationMs: room.durationMs, startedAt: room.startedAt || 0, status: room.status, players: room.players.map(p => ({ socketId: p.socketId, accountId: p.accountId, username: p.username, score: p.score || 0, ready: Boolean(p.ready) })) };
}
function getConnectedPlayer(socketId) { return multiplayerState.get(socketId) || null; }
function getSocketByUsername(username) {
  const clean = sanitizeUsername(username);
  if (!clean) return null;
  for (const [socketId, player] of multiplayerState.entries()) {
    if (String(player.username || '').toLowerCase() === clean.toLowerCase()) return socketId;
  }
  return null;
}
function emitRoomState(room) {
  const snapshot = pvpRoomSnapshot(room);
  for (const p of room.players) io.to(p.socketId).emit('pvp-room-state', snapshot);
}
function emitRoomScoreboard(room) {
  const board = room.players.slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)).map((p, i) => ({ rank: i + 1, socketId: p.socketId, accountId: p.accountId, username: p.username, score: Number(p.score || 0) }));
  for (const p of room.players) io.to(p.socketId).emit('pvp-scoreboard', { roomId: room.id, mode: room.mode, durationMs: room.durationMs, startedAt: room.startedAt || 0, board });
}
function removeFromPvpRoom(socketId) {
  for (const [roomId, room] of pvpRooms.entries()) {
    const idx = room.players.findIndex(p => p.socketId === socketId);
    if (idx < 0) continue;
    room.players.splice(idx, 1);
    if (room.players.length === 0) { clearTimeout(room.timer); pvpRooms.delete(roomId); continue; }
    if (room.hostSocketId === socketId) {
      room.hostSocketId = room.players[0].socketId;
      room.hostUsername = room.players[0].username;
      io.to(room.hostSocketId).emit('pvp-host-changed', { roomId: room.id, hostSocketId: room.hostSocketId, hostUsername: room.hostUsername });
    }
    emitRoomState(room);
    emitRoomScoreboard(room);
  }
}
function endPvpRoom(room, reason = 'time') {
  if (!room || !pvpRooms.has(room.id)) return;
  clearTimeout(room.timer);
  room.status = 'ended';
  const sorted = room.players.slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const winner = sorted[0] || null;
  const reward = PVP_MODES[room.mode]?.reward || 20;
  if (winner && winner.accountId) {
    const data = readData();
    const account = (data.accounts || []).find(a => String(a.accountId) === String(winner.accountId));
    if (account) {
      account.coins = Math.max(0, Number(account.coins || 0)) + reward;
      const idx = data.accounts.findIndex(a => String(a.accountId) === String(account.accountId));
      if (idx >= 0) data.accounts[idx] = account;
      upsertLeaderboardRow(data, account.accountId, account.username, account.best, account.coins);
      writeData(data);
      io.to(winner.socketId).emit('pvp-reward', { coins: reward, winner: true });
    }
  }
  const payload = { roomId: room.id, reason, mode: room.mode, reward, winner: winner ? { socketId: winner.socketId, accountId: winner.accountId, username: winner.username, score: Number(winner.score || 0) } : null, board: sorted.map((p, i) => ({ rank: i + 1, socketId: p.socketId, accountId: p.accountId, username: p.username, score: Number(p.score || 0) })) };
  for (const p of room.players) {
    io.to(p.socketId).emit('pvp-match-ended', payload);
    io.to(p.socketId).emit('pvp-match-end', payload);
  }
  pvpRooms.delete(room.id);
}
function startPvpTimer(room) { clearTimeout(room.timer); room.timer = setTimeout(() => endPvpRoom(room, 'time'), clampPvpDuration(room.durationMs)); }
function createPvpRoom(hostSocketId, hostPlayer, mode = 'normal', durationMs = 60_000) {
  const id = crypto.randomUUID();
  const room = { id, hostSocketId, hostUsername: hostPlayer.username, mode: normalizePvpMode(mode), durationMs: clampPvpDuration(durationMs), status: 'lobby', startedAt: 0, timer: null, players: [{ socketId: hostSocketId, accountId: hostPlayer.accountId || '', username: hostPlayer.username || 'Guest', score: 0, ready: true }] };
  pvpRooms.set(id, room);
  return room;
}
function joinPvpRoom(room, socketId, playerInfo) {
  if (!room) return false;
  if (room.players.some(p => p.socketId === socketId)) return true;
  if (room.players.length >= PVP_MAX_PLAYERS) return false;
  room.players.push({ socketId, accountId: playerInfo.accountId || '', username: playerInfo.username || 'Guest', score: 0, ready: true });
  return true;
}

/* ========== API ROUTES ========== */
app.get('/api/session', (req, res) => res.json({ ok: true, account: publicAccount(currentAccount(req)), playerKey: getAuthAccountId(req), moderator: false }));

app.post('/api/register', (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || '').trim();
  if (!username) return res.json({ ok: false, error: 'Username must be 3-16 letters, numbers, or spaces.' });
  if (password.length < 4) return res.json({ ok: false, error: 'Password must be at least 4 characters.' });
  const data = readData();
  if (findAccountByUsername(data, username)) return res.json({ ok: false, error: 'That username already exists.' });
  const nextId = data.accounts.length ? Math.max(...data.accounts.map(a => Number(a.accountId) || 0)) + 1 : 1;
  const account = { accountId: String(nextId), username, passHash: hashPassword(password), createdAt: Date.now(), lastLoginAt: Date.now(), banned: false, banReason: '', best: 0, coins: 0, inventory: { shield: 0, magnet: 0, slowmo: 0, burst: 0 }, ownedSkins: ['classic'], activeSkin: 'classic', theme: 'day', shieldCharges: 0, teamId: '', eventClaims: [], warBestRecorded: 0, warCoinsRecorded: 0, blockPvpRequests: false };
  data.accounts.push(account);
  writeData(data);
  setAuthCookie(res, account.accountId);
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
  setAuthCookie(res, account.accountId);
  res.json({ ok: true, message: 'Logged in.', account: publicAccount(account) });
});

app.post('/api/logout', (req, res) => { clearAuthCookie(res); res.json({ ok: true, message: 'Logged out.' }); });

app.post('/api/delete-account', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  if (String(req.body.confirmText || '').trim().toUpperCase() !== 'DELETE') return res.json({ ok: false, error: 'Type DELETE to confirm.' });
  const id = String(account.accountId || '');
  const username = String(account.username || 'Guest').toLowerCase();
  const data = readData();
  data.accounts = data.accounts.filter(a => String(a.accountId) !== id);
  data.leaderboard = data.leaderboard.filter(r => String(r.key || '') !== id);
  data.reports = data.reports.filter(r => String(r.key || '') !== id);
  data.suggestions = data.suggestions.filter(s => String(s.key || '') !== id);
  data.teams = (data.teams || []).map(team => {
    const copy = Object.assign({}, team);
    copy.members = (copy.members || []).filter(m => String(m.key || '') !== id && String(m.username || '').toLowerCase() !== username);
    copy.requests = (copy.requests || []).filter(r => String(r.key || '') !== id && String(r.username || '').toLowerCase() !== username);
    copy.invites = (copy.invites || []).filter(i => String(i.key || '') !== id && String(i.username || '').toLowerCase() !== username);
    copy.bans = (copy.bans || []).filter(b => String(b.key || '') !== id && String(b.username || '').toLowerCase() !== username);
    if (String(copy.ownerKey || '') === id) {
      if (copy.members.length) {
        const nextOwner = copy.members[0];
        nextOwner.role = 'owner';
        copy.ownerKey = nextOwner.key;
        copy.ownerName = nextOwner.username;
      } else {
        return null;
      }
    }
    return copy;
  }).filter(Boolean);
  writeData(data);
  clearAuthCookie(res);
  res.json({ ok: true, message: 'Account deleted.' });
});

app.get('/api/game-data', (req, res) => res.json(getGameDataForAccount(currentAccount(req))));

app.post(['/api/game/save', '/api/save', '/api/save-game', '/api/game-data/save'], (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const incoming = req.body || {};
  const prevBest = Number(account.best || 0);
  const prevCoins = Number(account.coins || 0);
  account.username = sanitizeUsername(incoming.username || account.username) || account.username;
  account.best = Math.max(Number(account.best || 0), Number(incoming.best || 0));
  account.coins = Math.max(0, Number(incoming.coins ?? account.coins) || 0);
  account.inventory = normalizeInventory(incoming.inventory || account.inventory);
  account.ownedSkins = Array.isArray(incoming.ownedSkins) && incoming.ownedSkins.length ? normalizeSkins(incoming.ownedSkins) : account.ownedSkins;
  account.activeSkin = account.ownedSkins.includes(String(incoming.activeSkin || account.activeSkin)) ? String(incoming.activeSkin || account.activeSkin) : 'classic';
  account.theme = incoming.theme === 'night' ? 'night' : 'day';
  account.shieldCharges = Math.max(0, Number(incoming.shieldCharges ?? account.shieldCharges) || 0);
  account.teamId = String(incoming.teamId || account.teamId || '').trim();
  account.eventClaims = Array.isArray(incoming.eventClaims) ? incoming.eventClaims.map(String) : account.eventClaims;
  account.warBestRecorded = Math.max(0, Number(incoming.warBestRecorded ?? account.warBestRecorded) || 0);
  account.warCoinsRecorded = Math.max(0, Number(incoming.warCoinsRecorded ?? account.warCoinsRecorded) || 0);
  account.blockPvpRequests = Boolean(incoming.blockPvpRequests ?? account.blockPvpRequests ?? false);
  const data = readData();
  const idx = data.accounts.findIndex(a => String(a.accountId) === String(account.accountId));
  if (idx >= 0) data.accounts[idx] = account;
  upsertLeaderboardRow(data, account.accountId, account.username, account.best, account.coins);
  if (String(account.teamId || '')) {
    const team = findTeamById({ teams: data.teams || [] }, account.teamId);
    if (team) {
      team.members = Array.isArray(team.members) ? team.members : [];
      const member = team.members.find(m => String(m.key || '') === String(account.accountId));
      if (member) {
        member.best = Math.max(Number(member.best) || 0, Number(account.best) || 0);
        member.coins = Math.max(Number(member.coins) || 0, Number(account.coins) || 0);
        member.username = account.username;
        member.updatedAt = Date.now();
      } else {
        team.members.push(createTeamMember(account.accountId, account.username, 'member', account.best, account.coins));
      }
      team.updatedAt = Date.now();
      const scoreDelta = Math.max(0, account.best - prevBest) + Math.floor(Math.max(0, account.coins - prevCoins) / 10);
      if (scoreDelta > 0) awardTeamWarPointsInData(data, account.teamId, scoreDelta);
    }
  }
  writeData(data);
  res.json({ ok: true, message: 'Sync Complete', data: publicAccount(account), leaderboards: { highscores: data.leaderboard.slice().sort((a, b) => (Number(b.best) || 0) - (Number(a.best) || 0)).slice(0, 10), coins: data.leaderboard.slice().sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0)).slice(0, 10) } });
});

app.get('/api/leaderboards', (req, res) => {
  const data = readData();
  res.json({ highscores: data.leaderboard.slice().sort((a, b) => (Number(b.best) || 0) - (Number(a.best) || 0)).slice(0, 10), coins: data.leaderboard.slice().sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0)).slice(0, 10) });
});

app.get(['/api/chat', '/api/chat/messages'], (req, res) => {
  const data = readData();
  res.json({ messages: readChat(data) });
});

app.post('/api/chat/send', (req, res) => {
  try {
    const account = currentAccount(req);
    if (!account) return res.json({ ok: false, error: 'Please log in first.' });
    const text = sanitizeText(getBodyValue(req.body, ['message', 'text', 'value'], ''), 120);
    if (!text) return res.json({ ok: false, error: 'Message cannot be empty.' });
    const data = readData();
    data.chat = readChat(data);
    const message = { id: crypto.randomUUID(), key: String(account.accountId || ''), username: sanitizeUsername(account.username) || 'Guest', text, ts: Date.now() };
    data.chat.push(message);
    if (data.chat.length > CHAT_MAX_MESSAGES) data.chat = data.chat.slice(-CHAT_MAX_MESSAGES);
    writeData(data);
    io.emit('chat-message', message);
    res.json({ ok: true, messages: data.chat });
  } catch (err) {
    console.error('/api/chat/send error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.get('/api/reports', (req, res) => res.json(getReportData(req)));
app.post('/api/reports/send', (req, res) => {
  try {
    const account = currentAccount(req);
    if (!account) return res.json({ ok: false, error: 'Please log in first.' });
    const categoryInput = String(getBodyValue(req.body, ['category'], '')).trim().toLowerCase();
    const category = REPORT_CATEGORIES.find(c => c.toLowerCase() === categoryInput) || 'Other';
    const title = sanitizeText(getBodyValue(req.body, ['title'], ''), 48);
    const details = sanitizeText(getBodyValue(req.body, ['details'], ''), 240);
    const targetAccountId = String(getBodyValue(req.body, ['targetAccountId'], '')).trim();
    const targetUsername = sanitizeUsername(getBodyValue(req.body, ['targetUsername'], ''));
    if (!title && !details) return res.json({ ok: false, error: 'Report cannot be empty.' });
    const data = readData();
    data.reports = Array.isArray(data.reports) ? data.reports : [];
    data.reports.push({ id: crypto.randomUUID(), category, title: title || details.slice(0, 48) || 'Report', details: details || title, username: sanitizeUsername(account.username) || 'Guest', key: String(account.accountId || ''), createdAt: Date.now(), reactions: {}, targetAccountId: targetAccountId || '', targetUsername: targetUsername || '' });
    if (data.reports.length > REPORT_MAX) data.reports = data.reports.slice(-REPORT_MAX);
    writeData(data);
    res.json({ ok: true, message: 'Report submitted.', data: { categories: REPORT_CATEGORIES.slice(), reports: (data.reports || []).map(r => summarizeReport(r, getAuthAccountId(req))) } });
  } catch (err) {
    console.error('/api/reports/send error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});
app.post('/api/reports/vote', (req, res) => {
  try {
    const account = currentAccount(req);
    if (!account) return res.json({ ok: false, error: 'Please log in first.' });
    const reportId = String(getBodyValue(req.body, ['reportId', 'id'], '')).trim();
    const vote = String(getBodyValue(req.body, ['reaction', 'vote', 'type'], '')).trim().toLowerCase();
    if (!reportId) return res.json({ ok: false, error: 'Missing report id.' });
    if (vote !== 'heart' && vote !== 'dislike') return res.json({ ok: false, error: 'Invalid vote.' });
    const data = readData();
    const report = (data.reports || []).find(r => String(r.id) === reportId);
    if (!report) return res.json({ ok: false, error: 'Report not found.' });
    voteReactionTarget(report, vote, String(account.accountId || ''));
    writeData(data);
    res.json({ ok: true, data: { categories: REPORT_CATEGORIES.slice(), reports: (data.reports || []).map(r => summarizeReport(r, getAuthAccountId(req))) } });
  } catch (err) {
    console.error('/api/reports/vote error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});
app.post('/api/reports/ban-target', (req, res) => {
  if (!isAdminRequest(req)) return res.json({ ok: false, error: 'Not authorized.' });
  const data = readData();
  const report = (data.reports || []).find(r => String(r.id) === String(req.body.reportId || ''));
  if (!report) return res.json({ ok: false, error: 'Report not found.' });
  if (String(report.category || '') !== 'Hacker') return res.json({ ok: false, error: 'Only Hacker reports can be used for bans.' });
  if (!String(report.targetAccountId || '')) return res.json({ ok: false, error: 'No target account on this report.' });
  const target = (data.accounts || []).find(a => String(a.accountId) === String(report.targetAccountId));
  if (!target) return res.json({ ok: false, error: 'Account not found.' });
  target.banned = true;
  target.banReason = sanitizeText(report.title || report.details || 'Banned by moderator.', 180);
  writeData(data);
  res.json({ ok: true, message: `${target.username || 'Player'} banned.` });
});

app.get('/api/suggestions', (req, res) => res.json(getSuggestionData(req)));

function extractSuggestionId(body, fallback = '') {
  if (typeof body === 'string') return String(body || fallback).trim();
  if (!body || typeof body !== 'object') return String(fallback || '').trim();
  return String(getBodyValue(body, ['suggestionId', 'id'], fallback)).trim();
}

app.post('/api/suggestions/send', (req, res) => {
  try {
    const account = currentAccount(req);
    if (!account) return res.json({ ok: false, error: 'Please log in first.' });
    const categoryInput = String(getBodyValue(req.body, ['category'], '')).trim().toLowerCase();
    const category = SUGGEST_CATEGORIES.find(c => c.toLowerCase() === categoryInput) || 'Other';
    const title = sanitizeText(getBodyValue(req.body, ['title'], ''), 48);
    const details = sanitizeText(getBodyValue(req.body, ['details'], ''), 240);
    if (!title && !details) return res.json({ ok: false, error: 'Suggestion cannot be empty.' });
    const data = readData();
    data.suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
    data.suggestions.push({ id: crypto.randomUUID(), category, title: title || details.slice(0, 48) || 'Suggestion', details: details || title, username: sanitizeUsername(account.username) || 'Guest', key: String(account.accountId || ''), createdAt: Date.now(), reactions: {}, comments: [] });
    if (data.suggestions.length > SUGGEST_MAX) data.suggestions = data.suggestions.slice(-SUGGEST_MAX);
    writeData(data);
    res.json({ ok: true, message: 'Suggestion submitted.', data: { categories: SUGGEST_CATEGORIES.slice(), suggestions: (data.suggestions || []).map(s => summarizeSuggestion(s, getAuthAccountId(req))) } });
  } catch (err) {
    console.error('/api/suggestions/send error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.post('/api/suggestions/vote', (req, res) => {
  try {
    const account = currentAccount(req);
    if (!account) return res.json({ ok: false, error: 'Please log in first.' });
    const suggestionId = extractSuggestionId(req.body);
    const vote = String(getBodyValue(req.body, ['reaction', 'vote', 'type'], '')).trim().toLowerCase();
    if (!suggestionId) return res.json({ ok: false, error: 'Missing suggestion id.' });
    if (vote !== 'heart' && vote !== 'dislike') return res.json({ ok: false, error: 'Invalid vote.' });
    const data = readData();
    const suggestion = (data.suggestions || []).find(s => String(s.id) === suggestionId);
    if (!suggestion) return res.json({ ok: false, error: 'Suggestion not found.' });
    voteReactionTarget(suggestion, vote, String(account.accountId || ''));
    writeData(data);
    res.json({ ok: true, data: { categories: SUGGEST_CATEGORIES.slice(), suggestions: (data.suggestions || []).map(s => summarizeSuggestion(s, getAuthAccountId(req))) } });
  } catch (err) {
    console.error('/api/suggestions/vote error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.post('/api/suggestions/comment', (req, res) => {
  try {
    const account = currentAccount(req);
    if (!account) return res.json({ ok: false, error: 'Please log in first.' });
    const suggestionId = extractSuggestionId(req.body);
    const parentId = String(getBodyValue(req.body, ['parentId'], '')).trim();
    const text = sanitizeText(getBodyValue(req.body, ['text'], ''), 240);
    if (!suggestionId) return res.json({ ok: false, error: 'Missing suggestion id.' });
    if (!text) return res.json({ ok: false, error: 'Comment cannot be empty.' });
    const data = readData();
    const suggestion = (data.suggestions || []).find(s => String(s.id) === suggestionId);
    if (!suggestion) return res.json({ ok: false, error: 'Suggestion not found.' });
    const comment = { id: crypto.randomUUID(), parentId: parentId || '', text, username: sanitizeUsername(account.username) || 'Guest', key: String(account.accountId || ''), createdAt: Date.now(), reactions: {}, replies: [] };
    if (!parentId) {
      suggestion.comments = Array.isArray(suggestion.comments) ? suggestion.comments : [];
      suggestion.comments.push(comment);
    } else {
      const parent = findSuggestionComment(suggestion.comments || [], parentId);
      if (!parent) return res.json({ ok: false, error: 'Reply target not found.' });
      parent.replies = Array.isArray(parent.replies) ? parent.replies : [];
      parent.replies.push(comment);
    }
    writeData(data);
    res.json({ ok: true, data: { categories: SUGGEST_CATEGORIES.slice(), suggestions: (data.suggestions || []).map(s => summarizeSuggestion(s, getAuthAccountId(req))) } });
  } catch (err) {
    console.error('/api/suggestions/comment error:', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

app.get(['/api/teams', '/api/team-data'], (req, res) => res.json(getTeamDataSnapshot(req)));
app.post('/api/teams/create', (req, res) => res.json(createTeam(req.body || {}, req)));
app.post('/api/teams/join', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const key = String(account.accountId || '');
  const username = sanitizeUsername(account.username) || 'Guest';
  const teamId = String(req.body.teamId || '').trim();
  const data = readData();
  const team = findTeamById({ teams: data.teams || [] }, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  if (resolveTeamIdForUser(key, username)) return res.json({ ok: false, error: 'Leave your current team first.' });
  if (isBannedFromTeam(team, key, username)) return res.json({ ok: false, error: 'You are banned from this team.' });
  if ((team.members || []).length >= clampTeamSize(team.maxPlayers)) return res.json({ ok: false, error: 'That team is full.' });
  if ((team.requests || []).some(r => String(r.key || '') === key)) return res.json({ ok: false, error: 'Request already sent.' });
  team.requests = Array.isArray(team.requests) ? team.requests : [];
  team.requests.push({ key, username, ts: Date.now() });
  team.updatedAt = Date.now();
  writeData(data);
  res.json({ ok: true, message: 'Join request sent.' });
});
app.post('/api/teams/respond', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const teamId = String(req.body.teamId || '').trim();
  const requesterKey = String(req.body.requesterKey || '').trim();
  const approve = Boolean(req.body.approve);
  const data = readData();
  const team = findTeamById({ teams: data.teams || [] }, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  if (String(team.ownerKey || '') !== String(account.accountId || '')) return res.json({ ok: false, error: 'Only the owner can respond to requests.' });
  const reqIdx = (team.requests || []).findIndex(r => String(r.key || '') === requesterKey);
  if (reqIdx < 0) return res.json({ ok: false, error: 'Request not found.' });
  const request = team.requests[reqIdx];
  if (!approve) { team.requests.splice(reqIdx, 1); team.updatedAt = Date.now(); writeData(data); return res.json({ ok: true, message: 'Request declined.' }); }
  if (isBannedFromTeam(team, request.key, request.username)) return res.json({ ok: false, error: 'That player is banned.' });
  if ((team.members || []).length >= clampTeamSize(team.maxPlayers)) return res.json({ ok: false, error: 'Team is full.' });
  if (!team.members.some(m => String(m.key || '') === String(request.key || ''))) team.members.push(createTeamMember(request.key, request.username, 'member', 0, 0));
  team.requests.splice(reqIdx, 1);
  team.updatedAt = Date.now();
  writeData(data);
  res.json({ ok: true, message: `${request.username || 'Player'} joined the team.` });
});
app.post('/api/teams/leave', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const key = String(account.accountId || '');
  const username = sanitizeUsername(account.username) || 'Guest';
  const data = readData();
  const teamId = resolveTeamIdForUser(key, username);
  if (!teamId) return res.json({ ok: false, error: 'You are not in a team.' });
  const team = findTeamById({ teams: data.teams || [] }, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  team.members = (team.members || []).filter(m => String(m.key || '') !== key && String(m.username || '').toLowerCase() !== username.toLowerCase());
  if (String(team.ownerKey || '') === key) {
    if (team.members.length) {
      const nextOwner = team.members[0];
      nextOwner.role = 'owner';
      team.ownerKey = nextOwner.key;
      team.ownerName = nextOwner.username;
    } else {
      data.teams = (data.teams || []).filter(t => String(t.id) !== String(teamId));
      account.teamId = '';
      const idx = data.accounts.findIndex(a => String(a.accountId) === key);
      if (idx >= 0) data.accounts[idx] = account;
      writeData(data);
      return res.json({ ok: true, message: 'Team deleted.' });
    }
  }
  team.updatedAt = Date.now();
  account.teamId = '';
  const idx = data.accounts.findIndex(a => String(a.accountId) === key);
  if (idx >= 0) data.accounts[idx] = account;
  writeData(data);
  res.json({ ok: true, message: 'Left team.' });
});
app.post('/api/teams/invite', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const key = String(account.accountId || '');
  const inviter = sanitizeUsername(account.username) || 'Guest';
  const target = sanitizeUsername(req.body.username);
  if (!target) return res.json({ ok: false, error: 'Enter a valid username.' });
  const data = readData();
  const teamId = resolveTeamIdForUser(key, inviter);
  if (!teamId) return res.json({ ok: false, error: 'You are not in a team.' });
  const team = findTeamById({ teams: data.teams || [] }, teamId);
  if (!team || String(team.ownerKey || '') !== key) return res.json({ ok: false, error: 'Only the owner can invite players.' });
  if (isBannedFromTeam(team, '', target)) return res.json({ ok: false, error: 'That username is banned.' });
  if ((team.members || []).some(m => sanitizeUsername(m.username) === target)) return res.json({ ok: false, error: 'That player is already in the team.' });
  if ((team.invites || []).some(i => sanitizeUsername(i.username) === target)) return res.json({ ok: false, error: 'Invite already sent.' });
  team.invites = Array.isArray(team.invites) ? team.invites : [];
  team.invites.push({ username: target, key: '', ts: Date.now() });
  team.updatedAt = Date.now();
  writeData(data);
  res.json({ ok: true, message: `Invite sent to ${target}.` });
});
app.post('/api/teams/accept', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const key = String(account.accountId || '');
  const username = sanitizeUsername(account.username) || 'Guest';
  const teamId = String(req.body.teamId || '').trim();
  const data = readData();
  const team = findTeamById({ teams: data.teams || [] }, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  if (resolveTeamIdForUser(key, username) && resolveTeamIdForUser(key, username) !== teamId) return res.json({ ok: false, error: 'Leave your current team first.' });
  const inviteIdx = (team.invites || []).findIndex(i => sanitizeUsername(i.username) === username);
  if (inviteIdx < 0) return res.json({ ok: false, error: 'Invite not found.' });
  if (isBannedFromTeam(team, key, username)) return res.json({ ok: false, error: 'You are banned from this team.' });
  if ((team.members || []).length >= clampTeamSize(team.maxPlayers)) return res.json({ ok: false, error: 'That team is full.' });
  team.members = Array.isArray(team.members) ? team.members : [];
  if (!team.members.some(m => String(m.key || '') === key)) team.members.push(createTeamMember(key, username, 'member', account.best, account.coins));
  team.invites.splice(inviteIdx, 1);
  team.updatedAt = Date.now();
  account.teamId = teamId;
  const idx = data.accounts.findIndex(a => String(a.accountId) === key);
  if (idx >= 0) data.accounts[idx] = account;
  writeData(data);
  res.json({ ok: true, message: 'Invite accepted.' });
});
app.post('/api/teams/decline', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const username = sanitizeUsername(account.username) || 'Guest';
  const teamId = String(req.body.teamId || '').trim();
  const data = readData();
  const team = findTeamById({ teams: data.teams || [] }, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  team.invites = (team.invites || []).filter(i => sanitizeUsername(i.username) !== username);
  team.updatedAt = Date.now();
  writeData(data);
  res.json({ ok: true, message: 'Invite declined.' });
});
app.post('/api/teams/kick', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const key = String(account.accountId || '');
  const teamId = String(req.body.teamId || '').trim();
  const targetKey = String(req.body.targetKey || '').trim();
  const targetUsername = sanitizeUsername(req.body.targetUsername) || '';
  const data = readData();
  const team = findTeamById({ teams: data.teams || [] }, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  if (String(team.ownerKey || '') !== key) return res.json({ ok: false, error: 'Only the owner can kick members.' });
  team.members = (team.members || []).filter(m => !(String(m.key || '') === targetKey || sanitizeUsername(m.username) === targetUsername));
  team.updatedAt = Date.now();
  writeData(data);
  res.json({ ok: true, message: 'Member removed.' });
});
app.post('/api/teams/ban', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const key = String(account.accountId || '');
  const teamId = String(req.body.teamId || '').trim();
  const targetKey = String(req.body.targetKey || '').trim();
  const targetUsername = sanitizeUsername(req.body.targetUsername) || '';
  const data = readData();
  const team = findTeamById({ teams: data.teams || [] }, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  if (String(team.ownerKey || '') !== key) return res.json({ ok: false, error: 'Only the owner can ban members.' });
  const memberIdx = (team.members || []).findIndex(m => (targetKey && String(m.key || '') === targetKey) || (targetUsername && sanitizeUsername(m.username) === targetUsername));
  const member = memberIdx >= 0 ? team.members[memberIdx] : { key: targetKey, username: targetUsername || 'Unknown' };
  if (memberIdx >= 0) team.members.splice(memberIdx, 1);
  team.bans = Array.isArray(team.bans) ? team.bans : [];
  if (!isBannedFromTeam(team, member.key, member.username)) team.bans.push({ key: member.key || targetKey, username: member.username || targetUsername || 'Unknown', ts: Date.now() });
  team.requests = (team.requests || []).filter(r => !(String(r.key || '') === targetKey || sanitizeUsername(r.username) === targetUsername));
  team.invites = (team.invites || []).filter(i => !(String(i.key || '') === targetKey || sanitizeUsername(i.username) === targetUsername));
  team.updatedAt = Date.now();
  writeData(data);
  res.json({ ok: true, message: 'Member banned.' });
});
app.post('/api/teams/unban', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const key = String(account.accountId || '');
  const teamId = String(req.body.teamId || '').trim();
  const target = String(req.body.target || '').trim();
  const data = readData();
  const team = findTeamById({ teams: data.teams || [] }, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  if (String(team.ownerKey || '') !== key) return res.json({ ok: false, error: 'Only the owner can unban members.' });
  const before = (team.bans || []).length;
  team.bans = (team.bans || []).filter(b => String(b.key || '') !== target && sanitizeUsername(b.username) !== target);
  team.updatedAt = Date.now();
  writeData(data);
  res.json({ ok: true, message: before !== (team.bans || []).length ? 'Member unbanned.' : 'Nothing to unban.' });
});

app.get('/api/events', (req, res) => { const data = readData(); res.json({ events: data.events || defaultEvents() }); });
app.get('/api/event-data', (req, res) => { const data = readData(); res.json({ events: data.events || defaultEvents() }); });
app.get('/api/team-wars', (req, res) => res.json(getTeamWarsData()));
app.get('/api/team-wars/data', (req, res) => res.json(getTeamWarsData()));
app.post('/api/events/claim', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const eventId = String(req.body.eventId || '').trim();
  const data = readData();
  const event = (data.events.featured || []).find(e => String(e.id) === eventId);
  if (!event) return res.json({ ok: false, error: 'Event not found.' });
  const claims = Array.isArray(account.eventClaims) ? account.eventClaims : [];
  if (claims.includes(eventId)) return res.json({ ok: false, error: 'Reward already claimed.' });
  account.coins = Math.max(0, Number(account.coins || 0)) + Math.max(0, Number(event.rewardCoins || 0));
  account.eventClaims = claims.concat(eventId);
  const idx = data.accounts.findIndex(a => String(a.accountId) === String(account.accountId));
  if (idx >= 0) data.accounts[idx] = account;
  upsertLeaderboardRow(data, account.accountId, account.username, account.best, account.coins);
  writeData(data);
  res.json({ ok: true, message: `Claimed ${Number(event.rewardCoins || 0)} coins.`, data: publicAccount(account), events: { events: data.events.featured || [] } });
});

app.get('/api/moderation/accounts', (req, res) => {
  if (!isAdminRequest(req)) return res.json({ ok: false, error: 'Not authorized.' });
  const data = readData();
  res.json({ ok: true, accounts: (data.accounts || []).map(a => ({ accountId: String(a.accountId || ''), username: String(a.username || 'Guest'), banned: Boolean(a.banned), banReason: String(a.banReason || ''), createdAt: Number(a.createdAt || 0), lastLoginAt: Number(a.lastLoginAt || 0) })) });
});
app.post('/api/moderation/ban-account', (req, res) => {
  if (!isAdminRequest(req)) return res.json({ ok: false, error: 'Not authorized.' });
  const targetId = String(req.body.accountId || '').trim();
  const reason = sanitizeText(req.body.reason || 'Banned by moderator.', 180);
  if (!targetId) return res.json({ ok: false, error: 'Missing account id.' });
  const data = readData();
  const target = (data.accounts || []).find(a => String(a.accountId) === targetId);
  if (!target) return res.json({ ok: false, error: 'Account not found.' });
  target.banned = true;
  target.banReason = reason || 'Banned by moderator.';
  writeData(data);
  res.json({ ok: true, message: `${target.username || 'Player'} banned.` });
});
app.post('/api/username', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const clean = sanitizeUsername(req.body.username);
  if (!clean) return res.json({ ok: false, error: 'Invalid username.' });
  const data = readData();
  const clash = (data.accounts || []).find(a => String(a.accountId) !== String(account.accountId) && String(a.username || '').toLowerCase() === clean.toLowerCase());
  if (clash) return res.json({ ok: false, error: 'That username is already taken.' });
  account.username = clean;
  const idx = (data.accounts || []).findIndex(a => String(a.accountId) === String(account.accountId));
  if (idx >= 0) data.accounts[idx] = account;
  writeData(data);
  res.json({ ok: true, username: clean, account: publicAccount(account) });
});
app.get('/api/refresh', (req, res) => {
  const data = readData();
  const account = currentAccount(req);
  const myKey = getAuthAccountId(req);
  const teams = getTeamDataSnapshot(req);
  const leaderboards = { highscores: data.leaderboard.slice().sort((a, b) => (Number(b.best) || 0) - (Number(a.best) || 0)).slice(0, 10), coins: data.leaderboard.slice().sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0)).slice(0, 10) };
  const reports = (data.reports || []).map(r => summarizeReport(r, myKey)).sort((a, b) => String(a.category || '').localeCompare(String(b.category || '')) || ((Number(b.hearts) - Number(b.dislikes)) - (Number(a.hearts) - Number(a.dislikes))) || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  const suggestions = (data.suggestions || []).map(s => summarizeSuggestion(s, myKey)).sort((a, b) => String(a.category || '').localeCompare(String(b.category || '')) || ((Number(b.hearts) - Number(b.dislikes)) - (Number(a.hearts) - Number(a.dislikes))) || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  res.json({ ok: true, data: account ? publicAccount(account) : null, account: account ? publicAccount(account) : null, playerKey: account ? String(account.accountId || '') : '', leaderboards, chat: { messages: readChat(data) }, teams, reports: { categories: REPORT_CATEGORIES.slice(), reports }, suggestions: { categories: SUGGEST_CATEGORIES.slice(), suggestions }, events: { events: data.events || defaultEvents() }, teamWars: getTeamWarsData() });
});
app.post('/api/cheat', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const code = String(req.body.code || '').trim().toLowerCase();
  const cheatMap = { duck1: { coins: 1 }, duck1000: { coins: 1000 }, akhira: { coins: 250 }, jaiden: { coins: 50 }, jaidenisthegoat: { coins: 500 }, kevinxbox: { coins: 75, ownedSkins: ['classic', 'xbox'], activeSkin: 'xbox' }, saifan: { coins: 100 }, yessaifan: { coins: 100 } };
  const reward = cheatMap[code];
  if (!reward) return res.json({ ok: false, error: 'Unknown cheat code.' });
  account.coins = Math.max(0, Number(account.coins || 0)) + Math.max(0, Number(reward.coins || 0));
  if (Array.isArray(reward.ownedSkins)) {
    const owned = new Set(Array.isArray(account.ownedSkins) ? account.ownedSkins : ['classic']);
    reward.ownedSkins.forEach(s => owned.add(s));
    account.ownedSkins = Array.from(owned);
  }
  if (reward.activeSkin && Array.isArray(account.ownedSkins) && account.ownedSkins.includes(reward.activeSkin)) account.activeSkin = reward.activeSkin;
  const data = readData();
  const idx = data.accounts.findIndex(a => String(a.accountId) === String(account.accountId));
  if (idx >= 0) data.accounts[idx] = account;
  upsertLeaderboardRow(data, account.accountId, account.username, account.best, account.coins);
  writeData(data);
  res.json({ ok: true, message: 'Cheat activated.', data: publicAccount(account), leaderboards: { highscores: data.leaderboard.slice().sort((a, b) => (Number(b.best) || 0) - (Number(a.best) || 0)).slice(0, 10), coins: data.leaderboard.slice().sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0)).slice(0, 10) } });
});

/* ========== SOCKET.IO ========== */
io.on('connection', (socket) => {
  socket.data.playerInfo = { accountId: '', username: 'Guest', blockPvpRequests: false };

  socket.on('join-game', (payload = {}) => {
    const player = snapshotPlayer({ id: socket.id, ...payload, lastSeen: Date.now() });
    player.accountId = String(payload.accountId || payload.playerKey || payload.key || '').trim();
    player.username = sanitizeUsername(payload.username || payload.name || player.username || 'Guest') || 'Guest';
    player.blockPvpRequests = Boolean(payload.blockPvpRequests || false);
    multiplayerState.set(socket.id, player);
    socket.data.playerInfo = { accountId: player.accountId, username: player.username, blockPvpRequests: player.blockPvpRequests, roomId: String(payload.pvpRoomId || '') };
    setOnlinePlayer(socket, { username: player.username, pvpActive: Boolean(socket.data.inPvp), roomId: String(payload.pvpRoomId || '') });
    socket.emit('current-players', Array.from(multiplayerState.values()).filter(p => p.id !== socket.id).map(snapshotPlayer));
    socket.broadcast.emit('player-joined', snapshotPlayer(player));
  });

  socket.on('update-position', (payload = {}) => {
    const existing = multiplayerState.get(socket.id) || { id: socket.id };
    const player = snapshotPlayer({ id: socket.id, ...existing, ...payload, lastSeen: Date.now() });
    player.accountId = String(payload.accountId || existing.accountId || socket.data.playerInfo.accountId || '').trim();
    player.username = sanitizeUsername(payload.username || existing.username || socket.data.playerInfo.username || 'Guest') || 'Guest';
    player.blockPvpRequests = Boolean(payload.blockPvpRequests ?? existing.blockPvpRequests ?? socket.data.playerInfo.blockPvpRequests ?? false);
    multiplayerState.set(socket.id, player);
    socket.data.playerInfo = { accountId: player.accountId, username: player.username, blockPvpRequests: player.blockPvpRequests, roomId: String(payload.pvpRoomId || '') };
    setOnlinePlayer(socket, { username: player.username, pvpActive: Boolean(socket.data.inPvp), roomId: String(payload.pvpRoomId || '') });
    socket.broadcast.emit('player-state', snapshotPlayer(player));
  });

  socket.on('pvp-create-lobby', (payload = {}, ack) => {
    const me = getConnectedPlayer(socket.id) || { accountId: socket.data.playerInfo.accountId || '', username: socket.data.playerInfo.username || 'Guest' };
    let room = null;
    for (const r of pvpRooms.values()) { if (r.hostSocketId === socket.id) { room = r; break; } }
    if (!room) {
      room = createPvpRoom(socket.id, { accountId: me.accountId || '', username: me.username || 'Guest' }, payload.mode || 'normal', payload.durationMs || 60_000);
    } else {
      room.mode = normalizePvpMode(payload.mode || room.mode);
      room.durationMs = clampPvpDuration(payload.durationMs || room.durationMs);
    }
    socket.join(room.id);
    emitRoomState(room);
    if (typeof ack === 'function') ack({ ok: true, room: pvpRoomSnapshot(room) });
  });

  socket.on('pvp-request', (payload = {}, ack) => {
    const host = getConnectedPlayer(socket.id) || { accountId: socket.data.playerInfo.accountId || '', username: socket.data.playerInfo.username || 'Guest' };
    const targetUsername = sanitizeUsername(payload.targetUsername);
    const targetSocketId = getSocketByUsername(targetUsername);
    if (!targetUsername) { if (typeof ack === 'function') ack({ ok: false, error: 'Missing target username.' }); return; }
    if (!targetSocketId) { if (typeof ack === 'function') ack({ ok: false, error: 'Player is offline.' }); return; }
    const targetPlayer = getConnectedPlayer(targetSocketId);
    if (targetPlayer && targetPlayer.blockPvpRequests) { if (typeof ack === 'function') ack({ ok: false, error: 'That player blocks PvP requests.' }); return; }
    let room = null;
    for (const r of pvpRooms.values()) { if (r.hostSocketId === socket.id) { room = r; break; } }
    if (!room) { room = createPvpRoom(socket.id, { accountId: host.accountId || '', username: host.username || 'Guest' }, payload.mode || 'normal', payload.durationMs || 60_000); socket.join(room.id); } else { room.mode = normalizePvpMode(payload.mode || room.mode); room.durationMs = clampPvpDuration(payload.durationMs || room.durationMs); }
    const invite = { requestId: crypto.randomUUID(), roomId: room.id, hostSocketId: socket.id, hostUsername: host.username || 'Guest', targetUsername, mode: room.mode, durationMs: room.durationMs, ts: Date.now() };
    io.to(targetSocketId).emit('pvp-invite', invite);
    if (typeof ack === 'function') ack({ ok: true, invite });
  });

  socket.on('pvp-response', (payload = {}, ack) => {
    const { roomId, accept } = payload;
    const room = pvpRooms.get(String(roomId || ''));
    const me = getConnectedPlayer(socket.id) || { accountId: socket.data.playerInfo.accountId || '', username: socket.data.playerInfo.username || 'Guest' };
    if (!room) { if (typeof ack === 'function') ack({ ok: false, error: 'Room not found.' }); return; }
    if (!accept) {
      io.to(room.hostSocketId).emit('pvp-invite-declined', { roomId: room.id, username: me.username || 'Guest', hostId: room.hostSocketId });
      io.to(room.hostSocketId).emit('pvp-request-declined', { roomId: room.id, username: me.username || 'Guest', hostId: room.hostSocketId });
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }
    if (room.players.length >= PVP_MAX_PLAYERS) { if (typeof ack === 'function') ack({ ok: false, error: 'PvP room is full.' }); return; }
    const wasInPvp = Boolean(socket.data.inPvp);
    const ok = joinPvpRoom(room, socket.id, { accountId: me.accountId || '', username: me.username || 'Guest' });
    if (!ok) { if (typeof ack === 'function') ack({ ok: false, error: 'PvP room is full.' }); return; }
    socket.join(room.id);
    socket.data.inPvp = true;
    if (!wasInPvp) {
      livePvpPlayers += 1;
      updateLivePvpCount();
    }
    setOnlinePlayer(socket, { username: me.username || 'Guest', pvpActive: true });
    socket.emit('pvp-joined', pvpRoomSnapshot(room));
    io.to(room.hostSocketId).emit('pvp-player-joined', { roomId: room.id, username: me.username || 'Guest' });
    emitRoomState(room);
    if (typeof ack === 'function') ack({ ok: true, room: pvpRoomSnapshot(room) });
  });

  socket.on('pvp-room-invite', (payload = {}, ack) => {
    const room = pvpRooms.get(String(payload.roomId || ''));
    const host = getConnectedPlayer(socket.id);
    if (!room) { if (typeof ack === 'function') ack({ ok: false, error: 'Room not found.' }); return; }
    if (room.hostSocketId !== socket.id) { if (typeof ack === 'function') ack({ ok: false, error: 'Only the host can invite players.' }); return; }
    if (room.players.length >= PVP_MAX_PLAYERS) { if (typeof ack === 'function') ack({ ok: false, error: 'Max 5 players.' }); return; }
    const targetUsername = sanitizeUsername(payload.targetUsername);
    const targetSocketId = getSocketByUsername(targetUsername);
    if (!targetUsername || !targetSocketId) { if (typeof ack === 'function') ack({ ok: false, error: 'Player not found.' }); return; }
    const targetPlayer = getConnectedPlayer(targetSocketId);
    if (targetPlayer && targetPlayer.blockPvpRequests) { if (typeof ack === 'function') ack({ ok: false, error: 'That player blocks PvP requests.' }); return; }
    io.to(targetSocketId).emit('pvp-room-invite', { roomId: room.id, hostUsername: host ? host.username : room.hostUsername, mode: room.mode, durationMs: room.durationMs });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('pvp-start-match', (payload = {}, ack) => {
    const room = pvpRooms.get(String(payload.roomId || ''));
    if (!room) { if (typeof ack === 'function') ack({ ok: false, error: 'Room not found.' }); return; }
    if (room.hostSocketId !== socket.id) { if (typeof ack === 'function') ack({ ok: false, error: 'Only the host can start the match.' }); return; }
    room.mode = normalizePvpMode(payload.mode || room.mode);
    room.durationMs = clampPvpDuration(payload.durationMs || room.durationMs);
    room.status = 'running';
    room.startedAt = Date.now();
    for (const p of room.players) { p.score = 0; p.ready = true; }
    startPvpTimer(room);
    const snapshot = pvpRoomSnapshot(room);
    for (const p of room.players) io.to(p.socketId).emit('pvp-match-start', { room: snapshot, modeLabel: PVP_MODES[room.mode].label, reward: PVP_MODES[room.mode].reward });
    emitRoomState(room);
    emitRoomScoreboard(room);
    if (typeof ack === 'function') ack({ ok: true, room: snapshot });
  });

  socket.on('pvp-score', (payload = {}) => {
    const room = pvpRooms.get(String(payload.roomId || ''));
    if (!room || room.status !== 'running') return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    player.score = Math.max(0, Number(payload.score) || 0);
    emitRoomScoreboard(room);
  });

  socket.on('pvp-leave-room', (payload = {}, ack) => {
    const room = pvpRooms.get(String(payload.roomId || ''));
    if (room) removeFromPvpRoom(socket.id);
    if (socket.data.inPvp) {
      socket.data.inPvp = false;
      livePvpPlayers = Math.max(0, livePvpPlayers - 1);
      updateLivePvpCount();
    }
    setOnlinePlayer(socket, { username: socket.data.playerInfo.username || 'Guest', pvpActive: false });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    if (socket.data.inPvp) {
      livePvpPlayers = Math.max(0, livePvpPlayers - 1);
      updateLivePvpCount();
    }
    removeFromPvpRoom(socket.id);
    multiplayerState.delete(socket.id);
    clearOnlinePlayer(socket.id);
    socket.broadcast.emit('player-disconnected', socket.id);
  });
});

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
  return sendIndex(res);
});

server.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });
