const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_EMAIL = '350408962@tdsb.ca';

const CHAT_MAX_MESSAGES = 60;
const CHAT_TTL_MS = 1000 * 60 * 60 * 24 * 2;

const REPORT_KEY = 'flappy_duck_reports_v1';
const REPORT_CATEGORIES = ['Hacker', 'Bug', 'Cheat', 'Other'];
const REPORT_MAX = 200;

const SUGGEST_KEY = 'flappy_duck_suggestions_v1';
const SUGGEST_CATEGORIES = ['Gameplay', 'Shop', 'Teams', 'UI', 'Other'];
const SUGGEST_MAX = 200;

const TEAM_KEY = 'flappy_duck_teams_v1';
const EVENT_KEY = 'flappy_duck_events_v1';
const TEAM_WAR_KEY = 'flappy_duck_teamwars_v1';
const WEEK_MS = 1000 * 60 * 60 * 24 * 7;

const ACCOUNT_KEY = 'flappy_duck_accounts_v4';
const ACCOUNT_SESSION_KEY = 'flappy_duck_account_session_v4';
const LEADERBOARD_KEY = 'flappy_duck_leaderboard_v4';

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

function defaultAccountState() {
  return { nextId: 1, accounts: [] };
}
function defaultBoard() { return []; }
function defaultChat() { return []; }
function defaultReports() { return { reports: [] }; }
function defaultSuggestions() { return { suggestions: [] }; }
function defaultTeams() { return { teams: [] }; }
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
function defaultTeamWars() {
  const season = currentSeason();
  return { seasonId: season.id, startsAt: season.startsAt, endsAt: season.endsAt, teams: [] };
}
function defaultData() {
  return {
    accounts: defaultAccountState().accounts,
    leaderboard: defaultBoard(),
    chat: defaultChat(),
    reports: defaultReports().reports,
    suggestions: defaultSuggestions().suggestions,
    teams: defaultTeams().teams,
    teamWars: defaultTeamWars(),
    events: defaultEvents()
  };
}
function normalizeData(data) {
  const base = defaultData();
  const out = Object.assign({}, base, data || {});
  out.accounts = out.accounts && Array.isArray(out.accounts.accounts) ? out.accounts.accounts : (Array.isArray(out.accounts) ? out.accounts : []);
  out.leaderboard = Array.isArray(out.leaderboard) ? out.leaderboard : [];
  out.chat = Array.isArray(out.chat) ? out.chat : [];
  out.reports = out.reports && Array.isArray(out.reports.reports) ? out.reports.reports : (Array.isArray(out.reports) ? out.reports : []);
  out.suggestions = out.suggestions && Array.isArray(out.suggestions.suggestions) ? out.suggestions.suggestions : (Array.isArray(out.suggestions) ? out.suggestions : []);
  out.teams = out.teams && Array.isArray(out.teams.teams) ? out.teams.teams : (Array.isArray(out.teams) ? out.teams : []);
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
function defaultTeam() { return { teams: [] }; }
function readTeams() {
  const raw = readData().teams;
  return { teams: Array.isArray(raw) ? raw : [] };
}
function writeTeams(state) {
  const data = readData();
  data.teams = Array.isArray(state && state.teams) ? state.teams : [];
  writeData(data);
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
  return (state.teams || []).find((r) => String(r.id) === String(teamId)) || null;
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
function clampTeamSize(n) { return Math.max(5, Math.min(10, Number(n) || 5)); }
function resolveTeamIdForUser(key, username) {
  const state = readTeams();
  const k = String(key || '').trim();
  const u = sanitizeUsername(username) || '';
  for (const team of state.teams || []) {
    for (const member of team.members || []) {
      if ((k && String(member.key || '') === k) || (u && String(member.username || '').toLowerCase() === u.toLowerCase())) {
        return team.id;
      }
    }
  }
  return '';
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
function readEventData() {
  const data = readData();
  if (!data.events || !Array.isArray(data.events.featured)) data.events = defaultEvents();
  return data.events;
}
function getTeamLeaderboard() {
  const state = readTeams();
  return (state.teams || [])
    .map(team => summarizeTeam(team))
    .sort((a, b) => (Number(b.totalBest) || 0) - (Number(a.totalBest) || 0) || (Number(b.totalCoins) || 0) - (Number(a.totalCoins) || 0))
    .slice(0, 10);
}
function weekStartMs_(ts) { return weekStartMs(ts); }
function currentSeason_() { return currentSeason(); }
function defaultEventState_() { return defaultEvents(); }
function readEventState_() { return readEventData(); }
function writeEventState_(state) { const data = readData(); data.events = state || defaultEvents(); writeData(data); }
function defaultTeamWarState_() { return defaultTeamWars(); }
function readTeamWars_() { const d = readData(); return d.teamWars || defaultTeamWars(); }
function writeTeamWars_(state) { const data = readData(); data.teamWars = state || defaultTeamWars(); writeData(data); }
function getTeamNameById(teamId) {
  const state = readTeams();
  const team = (state.teams || []).find((t) => String(t.id) === String(teamId));
  return team ? String(team.name || 'Team') : 'Team';
}
function awardTeamWarPoints(teamId, points) {
  const id = String(teamId || '').trim();
  if (!id) return false;
  const data = readData();
  let state = data.teamWars || defaultTeamWars();
  const season = currentSeason();
  if (String(state.seasonId || '') !== String(season.id)) state = defaultTeamWars();
  state.teams = Array.isArray(state.teams) ? state.teams : [];
  let row = state.teams.find(t => String(t.teamId) === id);
  if (!row) {
    row = { teamId: id, teamName: getTeamNameById(id), points: 0, updatedAt: Date.now() };
    state.teams.push(row);
  }
  row.teamName = getTeamNameById(id);
  row.points = Math.max(0, Number(row.points || 0)) + Math.max(0, Number(points || 0));
  row.updatedAt = Date.now();
  data.teamWars = state;
  writeData(data);
  return true;
}
function getTeamWarsData() {
  const state = readTeamWars_();
  const season = currentSeason();
  if (String(state.seasonId || '') !== String(season.id)) {
    const fresh = defaultTeamWarState_();
    writeTeamWars_(fresh);
    return { season: currentSeason(), leaderboard: [] };
  }
  const leaderboard = (state.teams || [])
    .slice()
    .sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0))
    .slice(0, 10)
    .map((row, i) => ({
      rank: i + 1,
      teamId: row.teamId,
      teamName: row.teamName || getTeamNameById(row.teamId),
      points: Number(row.points || 0),
      updatedAt: Number(row.updatedAt || Date.now())
    }));
  return { season: { id: state.seasonId, startsAt: Number(state.startsAt || season.startsAt), endsAt: Number(state.endsAt || season.endsAt) }, leaderboard };
}
function isAdmin() {
  return String((reqSessionEmail && reqSessionEmail()) || '').toLowerCase() === String(ADMIN_EMAIL).toLowerCase();
}
function reqSessionEmail() {
  return '';
}

function getAccountSession(req) {
  const account = currentAccount(req);
  if (!account) return { ok: true, account: null, playerKey: '', moderator: false };
  return { ok: true, account: publicAccount(account), playerKey: String(account.accountId), moderator: false };
}

app.get('/api/session', (req, res) => res.json(getAccountSession(req)));

app.post('/api/register', (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || '').trim();
  if (!username) return res.json({ ok: false, error: 'Username must be 3-16 letters, numbers, or spaces.' });
  if (password.length < 4) return res.json({ ok: false, error: 'Password must be at least 4 characters.' });

  const data = readData();
  if (findAccountByUsername(data, username)) return res.json({ ok: false, error: 'That username already exists.' });

  const account = {
    accountId: String(data.accounts.length ? Math.max(...data.accounts.map(a => Number(a.accountId) || 0)) + 1 : 1),
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
  if (String(req.body.confirmText || '').trim().toUpperCase() !== 'DELETE') return res.json({ ok: false, error: 'Type DELETE to confirm.' });

  const id = String(account.accountId || '');
  const username = String(account.username || 'Guest').toLowerCase();
  const data = readData();

  data.accounts = (data.accounts || []).filter(a => String(a.accountId) !== id);
  data.leaderboard = (data.leaderboard || []).filter(r => String(r.key || '') !== id);

  data.reports = (data.reports || []).filter(r => String(r.key || '') !== id);
  data.suggestions = (data.suggestions || []).filter(s => String(s.key || '') !== id);

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

  if (String(account.teamId || '')) {
    const teams = readTeams();
    const team = findTeamById(teams, account.teamId);
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
      writeTeams(teams);
      awardTeamWarPoints(account.teamId, Math.max(0, Math.round((Number(incoming.bestDelta || 0) + Number(incoming.coinDelta || 0) / 10))));
    }
  }

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
  data.chat.push({ id: crypto.randomUUID(), key: String(account.accountId || ''), username: sanitizeUsername(account.username) || 'Guest', text, ts: Date.now() });
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
  res.json({ ok: true, message: 'Report submitted.', data: { categories: REPORT_CATEGORIES, reports: (data.reports || []).map(r => summarizeReport(r, getSessionAccountId(req))) } });
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
  res.json({ ok: true, data: { categories: REPORT_CATEGORIES, reports: (data.reports || []).map(r => summarizeReport(r, getSessionAccountId(req))) } });
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
  res.json({ ok: true, message: 'Suggestion submitted.', data: { categories: SUGGEST_CATEGORIES, suggestions: (data.suggestions || []).map(s => summarizeSuggestion(s, getSessionAccountId(req))) } });
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
  res.json({ ok: true, data: { categories: SUGGEST_CATEGORIES, suggestions: (data.suggestions || []).map(s => summarizeSuggestion(s, getSessionAccountId(req))) } });
});
function findSuggestionComment(comments, commentId) {
  for (const comment of (comments || [])) {
    if (String(comment.id) === String(commentId)) return comment;
    const nested = findSuggestionComment(comment.replies || [], commentId);
    if (nested) return nested;
  }
  return null;
}
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
    const parent = findSuggestionComment(suggestion.comments || [], parentId);
    if (!parent) return res.json({ ok: false, error: 'Reply target not found.' });
    parent.replies = Array.isArray(parent.replies) ? parent.replies : [];
    parent.replies.push(comment);
  }

  writeData(data);
  res.json({ ok: true, data: { categories: SUGGEST_CATEGORIES, suggestions: (data.suggestions || []).map(s => summarizeSuggestion(s, getSessionAccountId(req))) } });
});

app.get('/api/teams', (req, res) => {
  const data = readData();
  const key = getSessionAccountId(req);
  const account = currentAccount(req);
  const username = sanitizeUsername(account && account.username) || 'Guest';
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  const resolvedTeamId = resolveTeamIdForUser(key, username);
  const currentTeam = resolvedTeamId ? findTeamById(state, resolvedTeamId) : null;

  const invites = [];
  for (const team of state.teams || []) {
    for (const inv of team.invites || []) {
      if ((sanitizeUsername(inv.username) || '') === username) {
        invites.push({
          id: team.id,
          name: team.name,
          ownerName: team.ownerName,
          maxPlayers: Number(team.maxPlayers || 5),
          memberCount: (team.members || []).length
        });
      }
    }
  }

  const requests = [];
  for (const team of state.teams || []) {
    for (const reqItem of team.requests || []) {
      if (String(reqItem.key || '') === key) {
        requests.push({
          id: team.id,
          name: team.name,
          ownerName: team.ownerName,
          ts: Number(reqItem.ts || Date.now())
        });
      }
    }
  }

  res.json({
    teams: (state.teams || []).map(summarizeTeam).sort((a, b) => (Number(b.totalBest) || 0) - (Number(a.totalBest) || 0)),
    leaderboard: getTeamLeaderboard(),
    currentTeam: currentTeam ? sanitizeTeamForCurrentUser(currentTeam, key) : null,
    invites,
    requests
  });
});

app.post('/api/teams/create', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const key = String(account.accountId || '');
  const username = sanitizeUsername(account.username) || 'Guest';
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const maxPlayers = clampTeamSize(req.body.maxPlayers);

  if (!/^[A-Za-z0-9 _-]{3,24}$/.test(name)) {
    return res.json({ ok: false, error: 'Team name must be 3-24 characters and can only contain letters, numbers, spaces, underscores, and dashes.' });
  }

  const data = readData();
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  if (resolveTeamIdForUser(key, username)) return res.json({ ok: false, error: 'Leave your current team before creating a new one.' });

  const team = {
    id: crypto.randomUUID(),
    name,
    ownerKey: key,
    ownerName: username,
    maxPlayers,
    members: [createTeamMember(key, username, 'owner', account.best, account.coins)],
    requests: [],
    invites: [],
    bans: [],
    updatedAt: Date.now()
  };

  state.teams.push(team);
  data.teams = state.teams;
  writeData(data);
  account.teamId = team.id;
  data.accounts = (data.accounts || []).map(a => String(a.accountId) === key ? account : a);
  writeData(data);
  res.json({ ok: true, message: 'Team created.', team: sanitizeTeamForCurrentUser(team, key), data: getTeamDataSnapshot(req) });
});

function getTeamDataSnapshot(req) {
  const data = readData();
  const key = getSessionAccountId(req);
  const account = currentAccount(req);
  const username = sanitizeUsername(account && account.username) || 'Guest';
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  const resolvedTeamId = resolveTeamIdForUser(key, username);
  const currentTeam = resolvedTeamId ? findTeamById(state, resolvedTeamId) : null;
  return {
    teams: (state.teams || []).map(summarizeTeam).sort((a, b) => (Number(b.totalBest) || 0) - (Number(a.totalBest) || 0)),
    leaderboard: getTeamLeaderboard(),
    currentTeam: currentTeam ? sanitizeTeamForCurrentUser(currentTeam, key) : null,
    invites: [],
    requests: []
  };
}

app.post('/api/teams/join', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const key = String(account.accountId || '');
  const username = sanitizeUsername(account.username) || 'Guest';
  const teamId = String(req.body.teamId || '').trim();
  const data = readData();
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  const team = findTeamById(state, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  if (resolveTeamIdForUser(key, username)) return res.json({ ok: false, error: 'Leave your current team first.' });
  if (isBannedFromTeam(team, key, username)) return res.json({ ok: false, error: 'You are banned from this team.' });
  if ((team.members || []).length >= clampTeamSize(team.maxPlayers)) return res.json({ ok: false, error: 'That team is full.' });
  if ((team.requests || []).some(r => String(r.key || '') === key)) return res.json({ ok: false, error: 'Request already sent.' });

  team.requests = Array.isArray(team.requests) ? team.requests : [];
  team.requests.push({ key, username, ts: Date.now() });
  team.updatedAt = Date.now();
  data.teams = state.teams;
  writeData(data);
  res.json({ ok: true, message: 'Join request sent.' });
});
app.post('/api/teams/leave', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const key = String(account.accountId || '');
  const username = sanitizeUsername(account.username) || 'Guest';
  const data = readData();
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  const teamId = resolveTeamIdForUser(key, username);
  if (!teamId) return res.json({ ok: false, error: 'You are not in a team.' });

  let team = findTeamById(state, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  team.members = (team.members || []).filter(m => String(m.key || '') !== key && String(m.username || '').toLowerCase() !== username.toLowerCase());

  if (String(team.ownerKey || '') === key) {
    if (team.members.length) {
      const nextOwner = team.members[0];
      nextOwner.role = 'owner';
      team.ownerKey = nextOwner.key;
      team.ownerName = nextOwner.username;
    } else {
      state.teams = state.teams.filter(t => String(t.id) !== String(teamId));
      account.teamId = '';
      data.accounts = (data.accounts || []).map(a => String(a.accountId) === key ? account : a);
      data.teams = state.teams;
      writeData(data);
      return res.json({ ok: true, message: 'Team deleted.' });
    }
  }

  team.updatedAt = Date.now();
  account.teamId = '';
  data.accounts = (data.accounts || []).map(a => String(a.accountId) === key ? account : a);
  data.teams = state.teams;
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
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  const teamId = resolveTeamIdForUser(key, inviter);
  if (!teamId) return res.json({ ok: false, error: 'You are not in a team.' });

  const team = findTeamById(state, teamId);
  if (!team || String(team.ownerKey || '') !== key) return res.json({ ok: false, error: 'Only the owner can invite players.' });
  if (isBannedFromTeam(team, '', target)) return res.json({ ok: false, error: 'That username is banned.' });
  if ((team.members || []).some(m => sanitizeUsername(m.username) === target)) return res.json({ ok: false, error: 'That player is already in the team.' });
  if ((team.invites || []).some(i => sanitizeUsername(i.username) === target)) return res.json({ ok: false, error: 'Invite already sent.' });

  team.invites = Array.isArray(team.invites) ? team.invites : [];
  team.invites.push({ username: target, key: '', ts: Date.now() });
  team.updatedAt = Date.now();
  data.teams = state.teams;
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
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  const team = findTeamById(state, teamId);
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
  data.accounts = (data.accounts || []).map(a => String(a.accountId) === key ? account : a);
  data.teams = state.teams;
  writeData(data);
  res.json({ ok: true, message: 'Invite accepted.' });
});
app.post('/api/teams/decline', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });
  const username = sanitizeUsername(account.username) || 'Guest';
  const teamId = String(req.body.teamId || '').trim();
  const data = readData();
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  const team = findTeamById(state, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  team.invites = (team.invites || []).filter(i => sanitizeUsername(i.username) !== username);
  team.updatedAt = Date.now();
  data.teams = state.teams;
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
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  const team = findTeamById(state, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  if (String(team.ownerKey || '') !== key) return res.json({ ok: false, error: 'Only the owner can kick members.' });

  team.members = (team.members || []).filter(m => !(String(m.key || '') === targetKey || sanitizeUsername(m.username) === targetUsername));
  team.updatedAt = Date.now();
  data.teams = state.teams;
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
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  const team = findTeamById(state, teamId);
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
  data.teams = state.teams;
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
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  const team = findTeamById(state, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  if (String(team.ownerKey || '') !== key) return res.json({ ok: false, error: 'Only the owner can unban members.' });

  const before = (team.bans || []).length;
  team.bans = (team.bans || []).filter(b => String(b.key || '') !== target && sanitizeUsername(b.username) !== target);
  team.updatedAt = Date.now();
  data.teams = state.teams;
  writeData(data);
  res.json({ ok: true, message: before !== (team.bans || []).length ? 'Member unbanned.' : 'Nothing to unban.' });
});

app.get('/api/events', (req, res) => {
  const data = readData();
  res.json({ events: data.events || defaultEvents() });
});

app.get('/api/team-wars', (req, res) => {
  res.json(getTeamWarsData());
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

app.get('/api/moderation/accounts', (req, res) => {
  const account = currentAccount(req);
  if (!account || !isAdmin()) {
    return res.json({ ok: false, error: 'Not authorized.' });
  }

  const data = readData();
  res.json({
    ok: true,
    accounts: (data.accounts || []).map(a => ({
      accountId: String(a.accountId || ''),
      username: String(a.username || 'Guest'),
      banned: Boolean(a.banned),
      banReason: String(a.banReason || ''),
      createdAt: Number(a.createdAt || 0),
      lastLoginAt: Number(a.lastLoginAt || 0)
    }))
  });
});

app.post('/api/moderation/ban-account', (req, res) => {
  const account = currentAccount(req);
  if (!account || !isAdmin()) {
    return res.json({ ok: false, error: 'Not authorized.' });
  }

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

app.post('/api/teams/respond', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });

  const teamId = String(req.body.teamId || '').trim();
  const requesterKey = String(req.body.requesterKey || '').trim();
  const approve = Boolean(req.body.approve);

  const data = readData();
  const state = { teams: Array.isArray(data.teams) ? data.teams : [] };
  const team = findTeamById(state, teamId);
  if (!team) return res.json({ ok: false, error: 'Team not found.' });
  if (String(team.ownerKey || '') !== String(account.accountId || '')) {
    return res.json({ ok: false, error: 'Only the owner can respond to requests.' });
  }

  const reqIdx = (team.requests || []).findIndex(r => String(r.key || '') === requesterKey);
  if (reqIdx < 0) return res.json({ ok: false, error: 'Request not found.' });

  const request = team.requests[reqIdx];
  if (!approve) {
    team.requests.splice(reqIdx, 1);
    team.updatedAt = Date.now();
    data.teams = state.teams;
    writeData(data);
    return res.json({ ok: true, message: 'Request declined.' });
  }

  if (isBannedFromTeam(team, request.key, request.username)) {
    return res.json({ ok: false, error: 'That player is banned.' });
  }
  if ((team.members || []).length >= clampTeamSize(team.maxPlayers)) {
    return res.json({ ok: false, error: 'Team is full.' });
  }

  if (!team.members.some(m => String(m.key || '') === String(request.key || ''))) {
    team.members.push(createTeamMember(request.key, request.username, 'member', 0, 0));
  }

  team.requests.splice(reqIdx, 1);
  team.updatedAt = Date.now();
  data.teams = state.teams;
  writeData(data);
  res.json({ ok: true, message: `${request.username || 'Player'} joined the team.` });
});

app.get('/api/refresh', (req, res) => {
  const data = readData();
  const account = currentAccount(req);
  const myKey = getSessionAccountId(req);
  const teams = getTeamDataSnapshot(req);
  const leaderboards = {
    highscores: data.leaderboard.slice().sort((a, b) => (Number(b.best) || 0) - (Number(a.best) || 0)).slice(0, 10),
    coins: data.leaderboard.slice().sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0)).slice(0, 10)
  };
  const reports = (data.reports || []).map(r => summarizeReport(r, myKey)).sort((a, b) =>
    String(a.category || '').localeCompare(String(b.category || '')) ||
    ((Number(b.hearts) - Number(b.dislikes)) - (Number(a.hearts) - Number(a.dislikes))) ||
    (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)
  );
  const suggestions = (data.suggestions || []).map(s => summarizeSuggestion(s, myKey)).sort((a, b) =>
    String(a.category || '').localeCompare(String(b.category || '')) ||
    ((Number(b.hearts) - Number(b.dislikes)) - (Number(a.hearts) - Number(a.dislikes))) ||
    (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0)
  );

  res.json({
    ok: true,
    data: account ? publicAccount(account) : null,
    account: account ? publicAccount(account) : null,
    playerKey: account ? String(account.accountId || '') : '',
    leaderboards,
    chat: { messages: readChat(data) },
    teams,
    reports: { categories: REPORT_CATEGORIES.slice(), reports },
    suggestions: { categories: SUGGEST_CATEGORIES.slice(), suggestions },
    events: { events: data.events || [] },
    teamWars: getTeamWarsData()
  });
});

app.post('/api/cheat', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.json({ ok: false, error: 'Please log in first.' });

  const code = String(req.body.code || '').trim().toLowerCase();
  const cheatMap = {
    duck1: { coins: 1 },
    duck1000: { coins: 1000 },
    akhira: { coins: 250 },
    jaiden: { coins: 50 },
    jaidenisthegoat: { coins: 500 },
    kevinxbox: { coins: 75, ownedSkins: ['classic', 'xbox'], activeSkin: 'xbox' },
    saifan: { coins: 100 },
    yessaifan: { coins: 100 }
  };

  const reward = cheatMap[code];
  if (!reward) return res.json({ ok: false, error: 'Unknown cheat code.' });

  account.coins = Math.max(0, Number(account.coins || 0)) + Math.max(0, Number(reward.coins || 0));
  if (Array.isArray(reward.ownedSkins)) {
    const owned = new Set(Array.isArray(account.ownedSkins) ? account.ownedSkins : ['classic']);
    reward.ownedSkins.forEach(s => owned.add(s));
    account.ownedSkins = Array.from(owned);
  }
  if (reward.activeSkin && Array.isArray(account.ownedSkins) && account.ownedSkins.includes(reward.activeSkin)) {
    account.activeSkin = reward.activeSkin;
  }

  const data = readData();
  const idx = data.accounts.findIndex(a => String(a.accountId) === String(account.accountId));
  if (idx >= 0) data.accounts[idx] = account;
  upsertLeaderboardRow(data, account.accountId, account.username, account.best, account.coins);
  writeData(data);

  res.json({
    ok: true,
    message: 'Cheat activated.',
    data: publicAccount(account),
    leaderboards: {
      highscores: data.leaderboard.slice().sort((a, b) => (Number(b.best) || 0) - (Number(a.best) || 0)).slice(0, 10),
      coins: data.leaderboard.slice().sort((a, b) => (Number(b.coins) || 0) - (Number(a.coins) || 0)).slice(0, 10)
    }
  });
});

const multiplayerState = new Map();

io.on('connection', (socket) => {
  socket.on('join-game', (payload = {}) => {
    const player = {
      id: socket.id,
      name: sanitizeText(payload.name, 16) || 'Duck',
      username: sanitizeText(payload.username, 16) || sanitizeText(payload.name, 16) || 'Duck',
      x: Number(payload.x) || 0,
      y: Number(payload.y) || 0,
      score: Number(payload.score) || 0,
      rot: Number(payload.rot) || 0,
      skin: String(payload.skin || 'classic'),
      alive: payload.alive !== false
    };

    multiplayerState.set(socket.id, player);
    socket.emit('current-players', Array.from(multiplayerState.values()).filter(p => p.id !== socket.id));
    socket.broadcast.emit('player-joined', player);
  });

  socket.on('update-position', (payload = {}) => {
    const existing = multiplayerState.get(socket.id) || { id: socket.id };
    const player = {
      id: socket.id,
      name: sanitizeText(payload.name || existing.name, 16) || 'Duck',
      username: sanitizeText(payload.username || existing.username || payload.name, 16) || 'Duck',
      x: Number(payload.x) || 0,
      y: Number(payload.y) || 0,
      score: Number(payload.score) || 0,
      rot: Number(payload.rot) || 0,
      skin: String(payload.skin || existing.skin || 'classic'),
      alive: payload.alive !== false
    };

    multiplayerState.set(socket.id, player);
    socket.broadcast.emit('player-state', player);
  });

  socket.on('disconnect', () => {
    multiplayerState.delete(socket.id);
    socket.broadcast.emit('player-disconnected', socket.id);
  });
});


server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
