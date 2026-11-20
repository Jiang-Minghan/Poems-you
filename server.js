import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sanitizePoem, sanitizeCouplet, markCouplet, coupletKey } from './public/shared.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const DATA_DIR = path.join(HERE, 'data');

const MAX_PLAYERS = 12;
const NAME_MAX = 12;
const BODY_LIMIT = 16 * 1024;
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
const ROOM_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS = 7000;
const SSE_HEARTBEAT_MS = 15000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOT_ID = 'bot-poet';
const BOT_NAME = '诗灵';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function now() {
  return Date.now();
}

function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return Array.from(
    raw.normalize('NFC').replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim()
  ).slice(0, NAME_MAX).join('').trim();
}

function normalizeChat(raw) {
  if (typeof raw !== 'string') return '';
  return Array.from(
    raw.normalize('NFC').replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim()
  ).slice(0, 80).join('').trim();
}

function validToken(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(raw);
}

function makePublicId() {
  return crypto.randomBytes(5).toString('hex');
}

function makeGuessId() {
  return crypto.randomBytes(4).toString('hex');
}

function makeCode(rooms) {
  for (let tries = 0; tries < 80; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

function emptyRound(number = 0, length = 7) {
  return {
    number,
    status: 'setup',
    length,
    answer: null,
    guesses: [],
    outcomes: new Map(),
    solvers: [],
    winnerId: null,
    startedAt: null,
    endedAt: null,
  };
}

async function loadData() {
  const corpus = new Set(
    (await fs.readFile(path.join(DATA_DIR, 'corpus.txt'), 'utf8'))
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  );
  if (corpus.size < 100) {
    throw new Error('data/corpus.txt 太小了，先运行 node tools/build-corpus.mjs');
  }

  const rawPalettes = JSON.parse(await fs.readFile(path.join(PUBLIC_DIR, 'palettes.json'), 'utf8'));
  const palettes = Array.isArray(rawPalettes) ? rawPalettes : rawPalettes.palettes;
  if (!Array.isArray(palettes) || palettes.length < 1) {
    throw new Error('public/palettes.json 里没有色卡');
  }

  const rawFamous = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'famous.json'), 'utf8'));
  const seen = new Set();
  const famous = [];
  for (const item of rawFamous) {
    if (!item || typeof item.line !== 'string') continue;
    const line = item.line.trim();
    if ((line.length !== 5 && line.length !== 7) || !corpus.has(line) || seen.has(line)) continue;
    seen.add(line);
    famous.push({
      line,
      author: typeof item.author === 'string' ? item.author : '',
      title: typeof item.title === 'string' ? item.title : '',
    });
  }
  if (famous.length < 10) {
    throw new Error('data/famous.json 里可用的名句太少');
  }

  const rawCouplets = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'couplets.json'), 'utf8'));
  const couplets = [];
  const coupletKeys = new Set();
  for (const item of rawCouplets) {
    if (!item || typeof item.upper !== 'string' || typeof item.lower !== 'string') continue;
    const upper = item.upper.trim();
    const lower = item.lower.trim();
    if (upper.length !== lower.length || (upper.length !== 5 && upper.length !== 7)) continue;
    if (!/^\p{Script=Han}+$/u.test(upper) || !/^\p{Script=Han}+$/u.test(lower)) continue;
    const key = coupletKey(upper, lower);
    if (coupletKeys.has(key)) continue;
    coupletKeys.add(key);
    couplets.push({
      upper,
      lower,
      author: typeof item.author === 'string' ? item.author : '',
      title: typeof item.title === 'string' ? item.title : '',
    });
  }
  if (couplets.length < 10) {
    throw new Error('data/couplets.json 里可用的完整联句太少');
  }

  const meta = {};
  try {
    Object.assign(meta, JSON.parse(await fs.readFile(path.join(DATA_DIR, 'line-meta.json'), 'utf8')));
  } catch {}

  // A hand-checked supplement for famous lines the bulk Tang corpus missed
  // (for example 杜甫《绝句》). It widens both validation and the 诗灵 bank.
  try {
    const curated = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'curated.json'), 'utf8'));
    for (const item of curated) {
      if (!item || typeof item.line !== 'string') continue;
      const line = item.line.trim();
      if ((line.length !== 5 && line.length !== 7) || !/^\p{Script=Han}+$/u.test(line)) continue;
      corpus.add(line);
      if (!seen.has(line)) {
        seen.add(line);
        famous.push({
          line,
          author: typeof item.author === 'string' ? item.author : '',
          title: typeof item.title === 'string' ? item.title : '',
        });
      }
      if (item.author || item.title) meta[line] = { author: item.author || '', title: item.title || '' };
    }
  } catch {}

  for (const item of famous) {
    if (item.author || item.title) meta[item.line] = { author: item.author, title: item.title };
  }

  for (const item of couplets) {
    meta[coupletKey(item.upper, item.lower)] = { author: item.author, title: item.title };
  }

  return { corpus, palettes, famous, couplets, meta };
}

function roundGuessers(room) {
  return [...room.players.values()].filter(p => !p.isBot && p.id !== room.hostId);
}

function viewerCanSeeAll(room, viewer) {
  if (!viewer) return false;
  if (room.round.status === 'revealed') return true;
  if (viewer.isBot) return false;
  if (viewer.id === room.hostId) return true;
  const outcome = room.round.outcomes.get(viewer.id);
  return outcome === 'solved' || outcome === 'gaveup';
}

function publicRound(room, meta, viewer) {
  const round = room.round;
  const canSeeAll = viewerCanSeeAll(room, viewer);
  const viewerOutcome = viewer ? (round.outcomes.get(viewer.id) || null) : null;
  const guessers = roundGuessers(room);
  const visibleGuesses = canSeeAll
    ? round.guesses
    : round.guesses.filter(g => {
        const guesser = room.players.get(g.playerId);
        return !!guesser
          && !guesser.isBot
          && guesser.id !== room.hostId
          && !round.outcomes.has(guesser.id);
      });
  const answerMeta = canSeeAll && round.answer
    ? (meta[coupletKey(round.answer.upper, round.answer.lower)] || null)
    : null;
  return {
    number: round.number,
    status: round.status,
    length: round.length,
    totalLength: round.length * 2,
    guesses: visibleGuesses.map(g => ({
      id: g.id,
      playerId: g.playerId,
      playerName: g.playerName,
      upper: g.upper,
      lower: g.lower,
      marksUpper: g.marksUpper,
      marksLower: g.marksLower,
      correct: g.correct,
      at: g.at,
    })),
    winnerId: round.winnerId,
    winnerName: round.winnerId ? (room.players.get(round.winnerId)?.name || null) : null,
    answer: canSeeAll && round.answer
      ? { upper: round.answer.upper, lower: round.answer.lower }
      : null,
    answerMeta,
    viewer: viewer ? {
      id: viewer.id,
      isHost: viewer.id === room.hostId,
      outcome: viewerOutcome,
      canSeeAll,
    } : null,
    guesserCount: guessers.length,
    activeGuessers: guessers.filter(p => !round.outcomes.has(p.id)).length,
    finishedGuessers: guessers.filter(p => round.outcomes.has(p.id)).length,
    startedAt: round.startedAt,
    endedAt: round.endedAt,
  };
}

export async function createGameServer(options = {}) {
  const { corpus, palettes, famous, couplets, meta } = await loadData();
  const rooms = new Map();
  const cleanupTimer = setInterval(cleanupRooms, 5 * 60 * 1000);
  cleanupTimer.unref();

  function cleanupRooms() {
    const t = now();
    for (const room of rooms.values()) {
      const hasHumans = [...room.players.values()].some(p => !p.isBot);
      const active = room.streams.size > 0;
      if (!hasHumans) {
        deleteRoom(room);
      } else if ((!active && t - room.updatedAt > ROOM_IDLE_MS) || t - room.createdAt > ROOM_MAX_AGE_MS) {
        deleteRoom(room);
      }
    }
  }

  function deleteRoom(room) {
    for (const stream of [...room.streams]) {
      try { stream.res.end(); } catch {}
    }
    room.streams.clear();
    for (const player of room.players.values()) {
      if (player.offlineTimer) clearTimeout(player.offlineTimer);
    }
    rooms.delete(room.code);
  }

  function addEvent(room, type, text) {
    room.events.push({ id: makeGuessId(), type, text, at: now() });
    if (room.events.length > 40) room.events.splice(0, room.events.length - 40);
    room.updatedAt = now();
  }

  function publicState(room, viewer) {
    const players = [...room.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(p => ({
        id: p.id,
        name: p.name,
        online: p.isBot ? true : !!p.online,
        isHost: p.id === room.hostId,
        isBot: !!p.isBot,
        outcome: room.round.outcomes.get(p.id) || null,
        guessCount: room.round.guesses.filter(g => g.playerId === p.id).length,
        joinedAt: p.joinedAt,
      }));
    const host = room.players.get(room.hostId);
    return {
      code: room.code,
      hostId: host ? host.id : null,
      hostName: host ? host.name : null,
      players,
      round: publicRound(room, meta, viewer),
      events: room.events.slice(-8),
      chat: (room.chat || []).slice(-40),
      paletteIndex: room.paletteIndex,
      serverNow: now(),
    };
  }

  function broadcast(room) {
    if (!rooms.has(room.code) || room.streams.size === 0) return;
    for (const stream of [...room.streams]) {
      if (stream.res.writableEnded) {
        room.streams.delete(stream);
        continue;
      }
      const viewer = room.players.get(stream.playerId);
      if (!viewer) {
        try { stream.res.end(); } catch {}
        room.streams.delete(stream);
        continue;
      }
      try {
        const payload = `event: state\ndata: ${JSON.stringify(publicState(room, viewer))}\n\n`;
        stream.res.write(payload);
      } catch {
        room.streams.delete(stream);
      }
    }
  }

  function addHuman(room, name, token) {
    const player = {
      id: makePublicId(),
      token,
      name,
      joinedAt: now(),
      isBot: false,
      online: false,
      conns: 0,
      offlineTimer: null,
    };
    room.players.set(player.id, player);
    return player;
  }

  function ensureBot(room) {
    let bot = room.players.get(BOT_ID);
    if (!bot) {
      bot = {
        id: BOT_ID,
        token: null,
        name: BOT_NAME,
        joinedAt: now(),
        isBot: true,
        online: true,
        conns: 0,
        offlineTimer: null,
      };
      room.players.set(bot.id, bot);
    }
    return bot;
  }

  function createRoom(name, token, withBotHost = false) {
    const code = makeCode(rooms);
    const room = {
      code,
      createdAt: now(),
      updatedAt: now(),
      hostId: null,
      paletteIndex: 0,
      players: new Map(),
      round: emptyRound(),
      events: [],
      chat: [],
      streams: new Set(),
      usedAnswers: new Set(),
    };
    rooms.set(code, room);

    const host = addHuman(room, name, token);
    room.hostId = host.id;
    addEvent(room, 'open', `${host.name} 开了一席`);

    if (withBotHost) {
      const bot = ensureBot(room);
      room.hostId = bot.id;
      addEvent(room, 'bot', `${BOT_NAME} 铺纸，替你出了一联`);
      const chosen = pickCouplet(room);
      startRound(room, chosen, { byBot: true });
    }
    return room;
  }

  function findPlayerByToken(room, token) {
    if (!validToken(token)) return null;
    for (const p of room.players.values()) {
      if (!p.isBot && p.token === token) return p;
    }
    return null;
  }

  function requireRoom(code) {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) throw new HttpError(404, 'room_not_found', '这一席不在了，检查一下邀请码。');
    return room;
  }

  function requirePlayer(room, token) {
    const player = findPlayerByToken(room, token);
    if (!player) throw new HttpError(403, 'not_in_room', '你还不在这席间，重新入席吧。');
    return player;
  }

  function requireHost(room, player) {
    if (room.hostId !== player.id) {
      throw new HttpError(403, 'not_host', '这一席现在不由你出题。');
    }
  }

  function nameTaken(room, name, exceptId = null) {
    const low = name.toLocaleLowerCase('zh-Hans-CN');
    for (const p of room.players.values()) {
      if (p.id === exceptId || p.isBot) continue;
      if (p.name.toLocaleLowerCase('zh-Hans-CN') === low) return true;
    }
    return false;
  }

  function pickCouplet(room) {
    const available = couplets.filter(c => !room.usedAnswers.has(coupletKey(c.upper, c.lower)));
    const pool = available.length ? available : couplets.slice();
    const five = pool.filter(c => c.upper.length === 5);
    const seven = pool.filter(c => c.upper.length === 7);
    const candidates = Math.random() < 0.5 && five.length
      ? five
      : (seven.length ? seven : five);
    const chosen = candidates[crypto.randomInt(candidates.length)];
    room.usedAnswers.add(coupletKey(chosen.upper, chosen.lower));
    return chosen;
  }

  function startRound(room, answer, { byBot = false } = {}) {
    const checked = sanitizeCouplet(answer.upper, answer.lower);
    if (checked.invalid || !checked.upper.text || !checked.lower.text) {
      throw new HttpError(400, 'invalid_chars', '谜底里只能有汉字。');
    }
    const len = checked.upper.count;
    if (checked.lower.count !== len || (len !== 5 && len !== 7)) {
      throw new HttpError(400, 'bad_length', '谜底要上下句字数相同，且各为五字或七字。');
    }
    const answerText = { upper: checked.upper.text, lower: checked.lower.text };
    room.round = {
      ...emptyRound(room.round.number + 1, len),
      status: 'playing',
      answer: answerText,
      startedAt: now(),
    };
    room.usedAnswers.add(coupletKey(answerText.upper, answerText.lower));
    addEvent(room, 'start', `第 ${room.round.number} 局 · ${len === 5 ? '五言' : '七言'} · 开题`);
    if (byBot) addEvent(room, 'bot', `${BOT_NAME} 把谜底压在了纸下`);
  }

  function enterSetup(room) {
    const completed = room.round.number;
    const length = room.round.length || 7;
    if (completed > 0) {
      room.paletteIndex = (room.paletteIndex + 1) % palettes.length;
    }
    room.round = emptyRound(completed, length);
  }

  function ensureHostOnline(room) {
    const host = room.players.get(room.hostId);
    if (!host || host.isBot) return;
    if (room.round.status === 'playing') return;
    if (host.online) return;
    const candidates = [...room.players.values()]
      .filter(p => !p.isBot && p.online)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    if (!candidates.length) return;
    room.hostId = candidates[0].id;
    addEvent(room, 'host', `${candidates[0].name} 接过了出题权`);
  }

  function finishRound(room, { keepHost = false } = {}) {
    if (room.round.status !== 'playing') return false;
    room.round.status = 'revealed';
    room.round.endedAt = now();
    const winner = room.round.solvers
      .map(id => room.players.get(id))
      .find(p => p && !p.isBot) || null;
    if (winner) {
      room.round.winnerId = winner.id;
      room.hostId = winner.id;
      addEvent(room, 'win', `${winner.name} 第一个猜中，成为新席主`);
    } else {
      room.round.winnerId = null;
      addEvent(room, 'end', '本局结束，无人猜中');
      if (!keepHost) ensureHostOnline(room);
    }
    room.updatedAt = now();
    return true;
  }

  function maybeFinishRound(room) {
    if (room.round.status !== 'playing') return false;
    const guessers = roundGuessers(room);
    if (!guessers.length) return false;
    if (!guessers.every(p => room.round.outcomes.has(p.id))) return false;
    return finishRound(room);
  }

  function removePlayer(room, player, { silent = false } = {}) {
    if (!room.players.has(player.id)) return;
    if (player.offlineTimer) {
      clearTimeout(player.offlineTimer);
      player.offlineTimer = null;
    }
    room.players.delete(player.id);
    if (!silent) addEvent(room, 'leave', `${player.name} 离席`);
    for (const stream of [...room.streams]) {
      if (stream.playerId === player.id) {
        try { stream.res.end(); } catch {}
        room.streams.delete(stream);
      }
    }
    const humans = [...room.players.values()].filter(p => !p.isBot);
    if (!humans.length) {
      deleteRoom(room);
      return;
    }
    if (room.hostId === player.id) {
      const candidates = [...humans].sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.joinedAt - b.joinedAt;
      });
      room.hostId = candidates[0].id;
      addEvent(room, 'host', `${candidates[0].name} 接过了出题权`);
    }
    room.updatedAt = now();
    if (room.round.status === 'playing') maybeFinishRound(room);
    broadcast(room);
  }

  function handleSse(req, res, room, player) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2500\n\n');

    if (player.offlineTimer) {
      clearTimeout(player.offlineTimer);
      player.offlineTimer = null;
    }
    player.conns += 1;
    player.online = true;
    room.updatedAt = now();
    ensureHostOnline(room);

    const stream = { res, playerId: player.id };
    room.streams.add(stream);
    res.write(`event: state\ndata: ${JSON.stringify(publicState(room, player))}\n\n`);
    broadcast(room);

    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      try { res.write(': keep-alive\n\n'); } catch {}
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      room.streams.delete(stream);
      player.conns = Math.max(0, player.conns - 1);
      if (player.conns === 0) {
        if (player.offlineTimer) clearTimeout(player.offlineTimer);
        player.offlineTimer = setTimeout(() => {
          player.offlineTimer = null;
          if (!room.players.has(player.id)) return;
          player.online = false;
          ensureHostOnline(room);
          if (rooms.has(room.code)) {
            room.updatedAt = now();
            broadcast(room);
          }
        }, OFFLINE_GRACE_MS);
      }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  function handleLeave(room, player) {
    addEvent(room, 'leave', `${player.name} 离席`);
    removePlayer(room, player, { silent: true });
    return { ok: true };
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    // /api/...
    if (parts[1] === 'meta' && req.method === 'GET') {
      const port = req.socket.localPort;
      const lanUrls = [];
      for (const nets of Object.values(os.networkInterfaces())) {
        for (const net of nets || []) {
          if (net.family === 'IPv4' && !net.internal) lanUrls.push(`http://${net.address}:${port}`);
        }
      }
      return sendJson(res, 200, {
        corpusSize: corpus.size,
        famousCount: famous.length,
        coupletCount: couplets.length,
        paletteCount: palettes.length,
        botName: BOT_NAME,
        lanUrls,
      });
    }

    if (parts[1] === 'inspiration' && req.method === 'GET') {
      const length = Number(url.searchParams.get('length') || 7);
      if (length !== 5 && length !== 7) {
        throw new HttpError(400, 'bad_length', '只要五言或七言。');
      }
      const pool = couplets.filter(c => c.upper.length === length);
      const chosen = pool[crypto.randomInt(pool.length)];
      return sendJson(res, 200, {
        upper: chosen.upper,
        lower: chosen.lower,
        author: chosen.author,
        title: chosen.title,
      });
    }

    if (parts[1] === 'rooms' && parts.length === 2 && req.method === 'POST') {
      const body = await readJson(req);
      const name = normalizeName(body.name);
      const token = body.token;
      if (!name) throw new HttpError(400, 'bad_name', '先留一个雅号吧。');
      if (name === BOT_NAME) throw new HttpError(400, 'reserved_name', '「诗灵」是席间的出题人，换一个雅号吧。');
      if (!validToken(token)) throw new HttpError(400, 'bad_token', '入席凭证丢了，刷新页面再试。');
      const room = createRoom(name, token);
      const player = findPlayerByToken(room, token);
      return sendJson(res, 201, {
        state: publicState(room, player),
        you: { id: player.id, name: player.name },
      });
    }

    if (parts[1] === 'practice' && req.method === 'POST') {
      const body = await readJson(req);
      const name = normalizeName(body.name);
      const token = body.token;
      if (!name) throw new HttpError(400, 'bad_name', '先留一个雅号吧。');
      if (name === BOT_NAME) throw new HttpError(400, 'reserved_name', '「诗灵」是席间的出题人，换一个雅号吧。');
      if (!validToken(token)) throw new HttpError(400, 'bad_token', '入席凭证丢了，刷新页面再试。');
      const room = createRoom(name, token, true);
      const player = findPlayerByToken(room, token);
      return sendJson(res, 201, {
        state: publicState(room, player),
        you: { id: player.id, name: player.name },
      });
    }

    if (parts[1] === 'rooms' && parts[2]) {
      const room = requireRoom(parts[2]);
      const action = parts[3] || 'state';

      if (action === 'state' && req.method === 'GET') {
        const player = requirePlayer(room, url.searchParams.get('token'));
        return sendJson(res, 200, { state: publicState(room, player), you: { id: player.id, name: player.name } });
      }

      if (action === 'events' && req.method === 'GET') {
        const player = requirePlayer(room, url.searchParams.get('token'));
        return handleSse(req, res, room, player);
      }

      const body = await readJson(req);

      if (action === 'join' && req.method === 'POST') {
        const token = body.token;
        const name = normalizeName(body.name);
        if (!validToken(token)) throw new HttpError(400, 'bad_token', '入席凭证丢了，刷新页面再试。');
        if (!name) throw new HttpError(400, 'bad_name', '先留一个雅号吧。');
        if (name === BOT_NAME) throw new HttpError(400, 'reserved_name', '「诗灵」是席间的出题人，换一个雅号吧。');

        const existing = findPlayerByToken(room, token);
        if (existing) {
          if (nameTaken(room, name, existing.id)) {
            throw new HttpError(409, 'name_taken', '这个雅号已经有人用了，换一个吧。');
          }
          if (existing.name !== name) {
            const old = existing.name;
            existing.name = name;
            addEvent(room, 'rename', `${old} 改名为 ${name}`);
          }
          room.updatedAt = now();
          broadcast(room);
          return sendJson(res, 200, { state: publicState(room, existing), you: { id: existing.id, name: existing.name } });
        }

        if (nameTaken(room, name)) {
          throw new HttpError(409, 'name_taken', '这个雅号已经有人用了，换一个吧。');
        }
        const humans = [...room.players.values()].filter(p => !p.isBot);
        if (humans.length >= MAX_PLAYERS) {
          throw new HttpError(409, 'room_full', '这席已经坐满了。');
        }
        const fresh = addHuman(room, name, token);
        addEvent(room, 'join', `${name} 入席`);
        room.updatedAt = now();
        broadcast(room);
        return sendJson(res, 200, { state: publicState(room, fresh), you: { id: fresh.id, name: fresh.name } });
      }

      const player = requirePlayer(room, body.token);

      if (action === 'chat' && req.method === 'POST') {
        const text = normalizeChat(body.text);
        if (!text) throw new HttpError(400, 'empty_chat', '写一句话再送出。');
        room.chat.push({
          playerId: player.id,
          playerName: player.name,
          text,
          at: now(),
        });
        if (room.chat.length > 80) room.chat.splice(0, room.chat.length - 80);
        room.updatedAt = now();
        broadcast(room);
        return sendJson(res, 200, { state: publicState(room, player) });
      }

      if (action === 'guess' && req.method === 'POST') {
        if (room.round.status !== 'playing') {
          throw new HttpError(409, 'not_playing', '这一局不在猜题中。');
        }
        if (player.isBot) throw new HttpError(403, 'bot', '诗灵不猜题。');
        if (room.hostId === player.id) {
          throw new HttpError(403, 'host_cannot_guess', '你是这一局的出题人，坐在旁边看大家猜吧。');
        }
        if (room.round.outcomes.has(player.id)) {
          throw new HttpError(409, 'finished', '你已经结束本局了。');
        }
        const len = room.round.length;
        let upper;
        let lower;
        let removed;
        if (typeof body.text === 'string') {
          const whole = sanitizePoem(body.text);
          if (whole.invalid) {
            throw new HttpError(400, 'invalid_chars', '整联都只收汉字，把诗句再洗一洗。', {
              cleaned: whole.text,
            });
          }
          if (whole.count !== len * 2) {
            throw new HttpError(400, 'wrong_length', `整联要 ${len * 2} 个字，你给了 ${whole.count} 个。`, {
              cleaned: whole.text,
              expected: len * 2,
            });
          }
          const chars = Array.from(whole.text);
          upper = chars.slice(0, len).join('');
          lower = chars.slice(len).join('');
          removed = whole.removed;
        } else {
          const cleaned = sanitizeCouplet(body.upper, body.lower);
          if (cleaned.invalid) {
            throw new HttpError(400, 'invalid_chars', '上下句都只收汉字，把诗句再洗一洗。', {
              upper: cleaned.upper.text,
              lower: cleaned.lower.text,
            });
          }
          if (cleaned.upper.count !== len) {
            throw new HttpError(400, 'wrong_length', `上句要正好 ${len} 个字，你给了 ${cleaned.upper.count} 个。`, {
              line: 'upper',
              cleaned: cleaned.upper.text,
              expected: len,
            });
          }
          if (cleaned.lower.count !== len) {
            throw new HttpError(400, 'wrong_length', `下句要正好 ${len} 个字，你给了 ${cleaned.lower.count} 个。`, {
              line: 'lower',
              cleaned: cleaned.lower.text,
              expected: len,
            });
          }
          upper = cleaned.upper.text;
          lower = cleaned.lower.text;
          removed = cleaned.removed;
        }
        const key = coupletKey(upper, lower);
        if (room.round.guesses.some(g => g.playerId === player.id
          && coupletKey(g.upper, g.lower) === key)) {
          throw new HttpError(409, 'duplicate_guess', '这一联你已经猜过了，换一联吧。');
        }

        const marked = markCouplet(room.round.answer, { upper, lower });
        const guess = {
          id: makeGuessId(),
          playerId: player.id,
          playerName: player.name,
          upper,
          lower,
          marksUpper: marked.upper,
          marksLower: marked.lower,
          correct: marked.correct,
          at: now(),
        };
        room.round.guesses.push(guess);
        const won = marked.correct;
        if (won) {
          room.round.outcomes.set(player.id, 'solved');
          room.round.solvers.push(player.id);
          addEvent(room, 'solved', `${player.name} 猜中了，退出本局`);
          maybeFinishRound(room);
        }
        room.updatedAt = now();
        broadcast(room);
        return sendJson(res, 200, {
          state: publicState(room, player),
          result: {
            guessId: guess.id,
            marksUpper: marked.upper,
            marksLower: marked.lower,
            correct: won,
            roundEnded: room.round.status === 'revealed',
            cleanedRemoved: removed,
          },
        });
      }

      if (action === 'giveup' && req.method === 'POST') {
        if (room.round.status !== 'playing') {
          throw new HttpError(409, 'not_playing', '这一局不在猜题中。');
        }
        if (player.isBot) throw new HttpError(403, 'bot', '诗灵不猜题。');
        if (room.hostId === player.id) {
          throw new HttpError(403, 'host_cannot_giveup', '你是这一局的出题人。');
        }
        if (room.round.outcomes.has(player.id)) {
          throw new HttpError(409, 'finished', '你已经结束本局了。');
        }
        room.round.outcomes.set(player.id, 'gaveup');
        addEvent(room, 'gaveup', `${player.name} 放弃，答案已向 TA 揭晓`);
        maybeFinishRound(room);
        room.updatedAt = now();
        broadcast(room);
        return sendJson(res, 200, { state: publicState(room, player) });
      }

      if (action === 'puzzle' && req.method === 'POST') {
        requireHost(room, player);
        if (room.round.status !== 'setup') {
          throw new HttpError(409, 'not_setup', '这一局已经开始了。');
        }
        const length = Number(body.length);
        if (length !== 5 && length !== 7) throw new HttpError(400, 'bad_length', '先选五言或七言。');
        let upper;
        let lower;
        if (typeof body.text === 'string') {
          const whole = sanitizePoem(body.text);
          if (whole.invalid) {
            throw new HttpError(400, 'invalid_chars', '谜底只能有汉字。', { cleaned: whole.text });
          }
          if (whole.count !== length * 2) {
            throw new HttpError(400, 'wrong_length', `整联要 ${length * 2} 个字，现在是 ${whole.count} 个。`, {
              cleaned: whole.text,
              expected: length * 2,
            });
          }
          const chars = Array.from(whole.text);
          upper = chars.slice(0, length).join('');
          lower = chars.slice(length).join('');
        } else {
          const cleaned = sanitizeCouplet(body.upper, body.lower);
          if (cleaned.invalid) {
            throw new HttpError(400, 'invalid_chars', '上下句都只能有汉字。', {
              upper: cleaned.upper.text,
              lower: cleaned.lower.text,
            });
          }
          if (cleaned.upper.count !== length) {
            throw new HttpError(400, 'wrong_length', `上句要正好 ${length} 个字，现在是 ${cleaned.upper.count} 个。`, {
              line: 'upper',
              cleaned: cleaned.upper.text,
              expected: length,
            });
          }
          if (cleaned.lower.count !== length) {
            throw new HttpError(400, 'wrong_length', `下句要正好 ${length} 个字，现在是 ${cleaned.lower.count} 个。`, {
              line: 'lower',
              cleaned: cleaned.lower.text,
              expected: length,
            });
          }
          upper = cleaned.upper.text;
          lower = cleaned.lower.text;
        }
        const key = coupletKey(upper, lower);
        if (room.usedAnswers.has(key)) {
          throw new HttpError(409, 'reused_answer', '这一联之前已经出过了，换一联吧。');
        }
        startRound(room, { upper, lower });
        room.updatedAt = now();
        broadcast(room);
        return sendJson(res, 200, { state: publicState(room, player) });
      }

      if (action === 'host' && req.method === 'POST') {
        requireHost(room, player);
        if (room.round.status === 'playing') {
          throw new HttpError(409, 'playing', '开局后不能传位；猜中的人自然会成为席主。');
        }
        const target = room.players.get(String(body.targetId || ''));
        if (!target || target.isBot || target.id === player.id) {
          throw new HttpError(400, 'bad_target', '只能把出题权交给席间的另一位朋友。');
        }
        room.hostId = target.id;
        addEvent(room, 'host', `${player.name} 把出题权交给了 ${target.name}`);
        room.updatedAt = now();
        broadcast(room);
        return sendJson(res, 200, { state: publicState(room, player) });
      }

      if (action === 'reveal' && req.method === 'POST') {
        requireHost(room, player);
        if (room.round.status !== 'playing') {
          throw new HttpError(409, 'not_playing', '这一局不在猜题中。');
        }
        finishRound(room, { keepHost: true });
        room.updatedAt = now();
        broadcast(room);
        return sendJson(res, 200, { state: publicState(room, player) });
      }

      if (action === 'next' && req.method === 'POST') {
        requireHost(room, player);
        if (room.round.status !== 'revealed') {
          throw new HttpError(409, 'not_revealed', '这一局还没结束。');
        }
        enterSetup(room);
        addEvent(room, 'open', `${player.name} 铺开了新一局`);
        room.updatedAt = now();
        broadcast(room);
        return sendJson(res, 200, { state: publicState(room, player) });
      }

      if (action === 'poet' && req.method === 'POST') {
        if (room.round.status === 'playing') {
          throw new HttpError(409, 'playing', '这一局还没结束。');
        }
        if (room.round.status === 'setup') {
          requireHost(room, player);
        } else if (room.round.status === 'revealed') {
          if (room.hostId !== BOT_ID) requireHost(room, player);
          enterSetup(room);
        }
        const bot = ensureBot(room);
        room.hostId = bot.id;
        const chosen = pickCouplet(room);
        addEvent(room, 'host', `${player.name} 请诗灵出联`);
        startRound(room, chosen, { byBot: true });
        room.updatedAt = now();
        broadcast(room);
        return sendJson(res, 200, { state: publicState(room, player) });
      }

      if (action === 'leave' && req.method === 'POST') {
        const result = handleLeave(room, player);
        return sendJson(res, 200, result);
      }

      throw new HttpError(404, 'not_found', '没有这个动作。');
    }

    throw new HttpError(404, 'not_found', '没有这个接口。');
  }

  async function handler(req, res) {
    setSecurityHeaders(res);
    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendText(res, 400, '请求不合法');
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendText(res, 405, 'Method Not Allowed');
      }
      await serveStatic(url.pathname, req, res);
    } catch (err) {
      if (res.headersSent) {
        try { res.end(); } catch {}
        return;
      }
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
      }
      console.error('[shiguang]', err);
      return sendJson(res, 500, { error: { code: 'internal', message: '席间出了点小岔子，再试一次。' } });
    }
  }

  const server = http.createServer(handler);
  server.keepAliveTimeout = 65000;

  async function listen(port = options.port ?? 8787, host = options.host ?? '0.0.0.0') {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server.address();
  }

  async function close() {
    clearInterval(cleanupTimer);
    for (const room of [...rooms.values()]) deleteRoom(room);
    if (!server.listening) return;
    await new Promise(resolve => server.close(resolve));
  }

  return { server, listen, close, rooms, corpus, famous, palettes };
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) {
    throw new HttpError(415, 'bad_content_type', '请用 JSON 提交。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'too_large', '提交的内容太长了。');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'bad_json', '提交的格式不对。');
  }
}

async function serveStatic(pathname, req, res) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  if (!rel || rel.includes('\0')) {
    return sendText(res, 404, 'Not Found');
  }
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return sendText(res, 404, 'Not Found');
  }
  if (!stat.isFile()) return sendText(res, 404, 'Not Found');
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const data = await fs.readFile(file);
  res.writeHead(200, {
    'content-type': mime,
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(data);
}

async function main() {
  const port = Number(process.env.PORT || 8787);
  const game = await createGameServer();
  const address = await game.listen(port, process.env.HOST || '0.0.0.0');
  const realPort = address.port;
  const lines = [];
  lines.push('');
  lines.push('  诗光与你 · 已开席');
  lines.push(`  本机   http://127.0.0.1:${realPort}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) {
        lines.push(`  同网   http://${net.address}:${realPort}`);
      }
    }
  }
  lines.push(`  诗库   ${game.corpus.size} 句 · 名句 ${game.famous.length} 句`);
  lines.push('');
  console.log(lines.join('\n'));

  const shutdown = async () => {
    console.log('\n  收席。');
    await game.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
