import { sanitizePoem, sanitizeCouplet, coupletSummary } from '/shared.js';

const $ = (sel, parent = document) => parent.querySelector(sel);
const $$ = (sel, parent = document) => [...parent.querySelectorAll(sel)];
const rootEl = document.documentElement;
const modalRoot = $('#modal-root');

const MARKS = { absent: '×', present: '◐', correct: '✓' };
const MARK_LABEL = { absent: '无此字', present: '有字错位', correct: '字位皆对' };
const NAME_SUGGESTIONS = [
  '听雨', '拾月', '南枝', '小满', '青崖', '照野', '知遥', '临风',
  '见山', '问舟', '竹西', '晚晴', '采薇', '停云', '一苇', '清和',
];
const POINTER_FINE = matchMedia('(pointer: fine)').matches;

const app = {
  token: '',
  name: '',
  meId: null,
  roomCode: null,
  state: null,
  palettes: [],
  meta: null,
  paletteIndex: 0,
  setupLength: 7,
  draftGuessUpper: '',
  draftGuessLower: '',
  draftPuzzleUpper: '',
  draftPuzzleLower: '',
  seenGuessIds: new Set(),
  newGuessIds: new Set(),
  sse: null,
  connected: false,
  pendingGuess: false,
  pendingPuzzle: false,
  actionPending: false,
  dialogBusy: false,
  composing: false,
  pollTimer: null,
  refreshTimer: null,
  paletteTimer: null,
  toastTimer: null,
  closeDialog: null,
  freshWin: false,
  lastHomeError: '',
  pendingComposeRender: false,
};

boot();

function boot() {
  initIdentity();
  bindHome();
  bindRoom();
  bindGlobal();
  setHomeBusy(true);
  loadAssets()
    .then(() => {
      setHomeBusy(false);
      return begin();
    })
    .catch(err => {
      console.error(err);
      showBootError();
    });
}

/* ------------------------------------------------------------------ *
 * identity & storage
 * ------------------------------------------------------------------ */

function newToken() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomName() {
  return NAME_SUGGESTIONS[Math.floor(Math.random() * NAME_SUGGESTIONS.length)];
}

function initIdentity() {
  const params = new URLSearchParams(location.search);

  if (params.get('new') === '1') {
    app.token = newToken();
    safeSessionSet('sg.tabToken', app.token);
    safeSessionRemove('sg.activeRoom');
    params.delete('new');
    const q = params.toString();
    history.replaceState({}, '', q ? `/?${q}` : '/');
  } else {
    app.token = safeSessionGet('sg.tabToken') || safeLocalGet('sg.token') || newToken();
    if (!safeLocalGet('sg.token') && !safeSessionGet('sg.tabToken')) {
      safeLocalSet('sg.token', app.token);
    }
  }

  let saved = safeLocalGet('sg.name') || '';
  if (!saved || saved === '诗灵') saved = randomName();
  app.name = saved;
  $('#join-name').value = saved;
}

async function begin() {
  const params = new URLSearchParams(location.search);
  const urlCode = normalizeCode(params.get('room') || '');
  if (urlCode) $('#join-code').value = urlCode;

  const active = safeSessionGet('sg.activeRoom') || '';
  if (active && (!urlCode || urlCode === active)) {
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(active)}/join`, {
        method: 'POST',
        body: { name: app.name, token: app.token },
      });
      enterRoom(data, active);
      return;
    } catch (err) {
      safeSessionRemove('sg.activeRoom');
      if (err.status === 404 || err.status === 403) {
        setTimeout(() => toast('上一席已经散了。', 'error'), 350);
      }
    }
  }

  showHome();
  if (urlCode) $('#join-code').value = urlCode;
}

function safeLocalGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeLocalSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function safeSessionGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function safeSessionSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch {}
}
function safeSessionRemove(key) {
  try { sessionStorage.removeItem(key); } catch {}
}

/* ------------------------------------------------------------------ *
 * data & palette
 * ------------------------------------------------------------------ */

async function loadAssets() {
  const [paletteRes, meta] = await Promise.all([
    fetch('/palettes.json', { cache: 'no-store' }),
    fetch('/api/meta', { cache: 'no-store' }),
  ]);
  if (!paletteRes.ok || !meta.ok) throw new Error('assets failed');
  const paletteData = await paletteRes.json();
  app.palettes = Array.isArray(paletteData) ? paletteData : paletteData.palettes;
  if (!Array.isArray(app.palettes) || !app.palettes.length) throw new Error('no palettes');
  app.meta = await meta.json();
  applyPalette(0, false);
}

function applyPalette(index, animate = true) {
  if (!app.palettes.length) return;
  const safe = Math.max(0, Math.min(app.palettes.length - 1, Number(index) || 0));
  const palette = app.palettes[safe];
  const changed = app.paletteIndex !== safe;
  app.paletteIndex = safe;

  for (const [key, value] of Object.entries(palette.vars || {})) {
    rootEl.style.setProperty(`--c-${key}`, value);
  }
  rootEl.dataset.theme = palette.mode === 'dark' ? 'dark' : 'light';
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta && palette.vars?.bg) themeMeta.setAttribute('content', palette.vars.bg);

  const nameEl = $('#palette-name');
  if (nameEl) nameEl.textContent = `${safe + 1}/${app.palettes.length} · ${palette.name}`;

  if (animate && changed) {
    document.body.classList.remove('palette-shift');
    void document.body.offsetWidth;
    document.body.classList.add('palette-shift');
    clearTimeout(app.paletteTimer);
    app.paletteTimer = setTimeout(() => document.body.classList.remove('palette-shift'), 900);
  }
  renderSwatches();
}

function paletteGradient(palette) {
  const source = (palette.source && palette.source.length)
    ? palette.source
    : [palette.vars?.paper, palette.vars?.accent, palette.vars?.present, palette.vars?.correct];
  const colors = source.filter(Boolean).slice(0, 5)
    .map(c => /^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : '#CCCCCC');
  if (colors.length < 2) return 'background:#CCCCCC';
  const n = colors.length;
  const stops = colors.map((c, i) =>
    `${c} ${(i * 100 / n).toFixed(2)}% ${((i + 1) * 100 / n).toFixed(2)}%`).join(', ');
  return `background:linear-gradient(90deg,${stops})`;
}

function renderSwatches() {
  const host = $('#palette-swatches');
  if (!host || !app.palettes.length) return;
  host.innerHTML = app.palettes.map((p, i) => `
    <div class="swatch ${i === app.paletteIndex ? 'is-active' : ''}"
         style="${paletteGradient(p)}"
         role="img"
         aria-label="${escAttr(`第 ${i + 1} 组，${p.name}`)}"
         title="${escAttr(`${i + 1}. ${p.name} · ${p.sub || ''}`)}">
    </div>`).join('');
  const active = app.palettes[app.paletteIndex];
  const nameEl = $('#palette-name');
  if (nameEl && active) nameEl.textContent = `${app.paletteIndex + 1}/${app.palettes.length} · ${active.name}`;
}

function paletteGridMarkup() {
  if (!app.palettes.length) return '';
  return `<div class="modal-palette-grid">
    ${app.palettes.map((p, i) => `
      <div class="modal-palette ${i === app.paletteIndex ? 'is-active' : ''}" title="${escAttr(`${p.name} · ${p.sub || ''}`)}">
        <div class="modal-palette-strip" style="${paletteGradient(p)}"></div>
        <span>${i + 1}. ${esc(p.name)}</span>
      </div>`).join('')}
  </div>`;
}

/* ------------------------------------------------------------------ *
 * home
 * ------------------------------------------------------------------ */

function bindHome() {
  $('#join-form').addEventListener('submit', event => {
    event.preventDefault();
    doJoin();
  });
  $('#create-room').addEventListener('click', doCreate);
  $('#play-alone').addEventListener('click', doPractice);
  $('#home-help').addEventListener('click', openHelp);

  $('#join-code').addEventListener('input', event => {
    event.target.value = normalizeCode(event.target.value);
    clearHomeError();
  });
  $('#join-name').addEventListener('input', () => {
    clearHomeError();
    $('#join-name').classList.remove('is-invalid');
  });
}

async function doJoin() {
  if (app.actionPending) return;
  const name = readHomeName();
  const code = normalizeCode($('#join-code').value);
  if (!name) return homeFieldError('先留一个雅号吧。', '#join-name');
  if (code.length < 4) return homeFieldError('邀请码是四位，再检查一下。', '#join-code');

  setHomeBusy(true, 'join');
  clearHomeError();
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      body: { name, token: app.token },
    });
    app.name = data.you.name;
    safeLocalSet('sg.name', app.name);
    enterRoom(data, code);
  } catch (err) {
    showHomeError(err.message);
    if (err.code === 'name_taken') $('#join-name').classList.add('is-invalid');
    if (err.code === 'room_not_found') $('#join-code').classList.add('is-invalid');
  } finally {
    setHomeBusy(false);
  }
}

async function doCreate() {
  if (app.actionPending) return;
  const name = readHomeName();
  if (!name) return homeFieldError('先留一个雅号吧。', '#join-name');

  setHomeBusy(true, 'create');
  clearHomeError();
  try {
    const data = await api('/api/rooms', {
      method: 'POST',
      body: { name, token: app.token },
    });
    app.name = data.you.name;
    safeLocalSet('sg.name', app.name);
    enterRoom(data, data.state.code);
    setTimeout(() => toast('席开好了，把邀请码递给朋友吧。'), 450);
  } catch (err) {
    showHomeError(err.message);
  } finally {
    setHomeBusy(false);
  }
}

async function doPractice() {
  if (app.actionPending) return;
  const name = readHomeName();
  if (!name) return homeFieldError('先留一个雅号吧。', '#join-name');

  setHomeBusy(true, 'practice');
  clearHomeError();
  try {
    const data = await api('/api/practice', {
      method: 'POST',
      body: { name, token: app.token },
    });
    app.name = data.you.name;
    safeLocalSet('sg.name', app.name);
    enterRoom(data, data.state.code);
    setTimeout(() => toast('诗灵替你藏了一联。猜中之后，你就是房主。'), 500);
  } catch (err) {
    showHomeError(err.message);
  } finally {
    setHomeBusy(false);
  }
}

function readHomeName() {
  return $('#join-name').value.trim().replace(/\s+/g, ' ').slice(0, 12);
}

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function homeFieldError(message, selector) {
  showHomeError(message);
  const el = $(selector);
  if (el) el.focus();
}

function showHomeError(message) {
  app.lastHomeError = message;
  const el = $('#join-error');
  if (el) el.textContent = message;
}

function clearHomeError() {
  const el = $('#join-error');
  if (el) el.textContent = '';
}

function setHomeBusy(on, which = '') {
  app.actionPending = on;
  for (const id of ['#join-submit', '#create-room', '#play-alone']) {
    const el = $(id);
    if (el) el.disabled = on;
  }
  const label = $('#join-submit span');
  if (label) label.textContent = on && which === 'join' ? '入席中…' : '入席';
  const create = $('#create-room');
  if (create) create.textContent = on && which === 'create' ? '开席中…' : '新开一席';
}

function showBootError() {
  showHomeError('连不上席间的服务器。请确认 node server.js 正在运行，然后刷新页面。');
  $('#join-submit').disabled = true;
  $('#create-room').disabled = true;
  $('#play-alone').disabled = true;
}

function showHome() {
  closeStream();
  clearInterval(app.pollTimer);
  app.pollTimer = null;
  clearTimeout(app.refreshTimer);
  app.refreshTimer = null;
  safeSessionRemove('sg.activeRoom');
  app.state = null;
  app.meId = null;
  app.roomCode = null;
  app.seenGuessIds = new Set();
  app.newGuessIds = new Set();
  app.draftGuessUpper = '';
  app.draftGuessLower = '';
  app.draftPuzzleUpper = '';
  app.draftPuzzleLower = '';
  app.pendingGuess = false;
  app.pendingPuzzle = false;
  app.pendingComposeRender = false;
  $('#screen-room').hidden = true;
  $('#screen-home').hidden = false;
  $('#stage').innerHTML = '';
  $('#join-error').textContent = '';
  $('#join-name').classList.remove('is-invalid');
  $('#join-code').classList.remove('is-invalid');
  document.title = '诗光与你 · 一字一光';
  history.replaceState({}, '', '/');
  window.scrollTo({ top: 0, behavior: 'auto' });
  applyPalette(0, false);
  setHomeBusy(false);
}

/* ------------------------------------------------------------------ *
 * room entry & stream
 * ------------------------------------------------------------------ */

function enterRoom(data, code) {
  closeStream();
  clearInterval(app.pollTimer);
  app.pollTimer = null;

  app.meId = data.you.id;
  app.name = data.you.name;
  app.roomCode = code;
  app.state = data.state;
  app.paletteIndex = data.state.paletteIndex;
  app.seenGuessIds = new Set((data.state.round.guesses || []).map(g => g.id));
  app.newGuessIds = new Set();
  app.draftGuessUpper = '';
  app.draftGuessLower = '';
  app.draftPuzzleUpper = '';
  app.draftPuzzleLower = '';
  app.setupLength = data.state.round.length === 5 ? 5 : 7;
  app.pendingGuess = false;
  app.pendingPuzzle = false;
  app.pendingComposeRender = false;
  if (app.closeDialog) app.closeDialog();

  applyPalette(app.paletteIndex, false);
  $('#join-code').value = code;
  $('#screen-home').hidden = true;
  $('#screen-room').hidden = false;
  $('#connection-bar').hidden = true;
  safeSessionSet('sg.activeRoom', code);
  safeLocalSet('sg.lastRoom', code);
  history.replaceState({}, '', `/?room=${encodeURIComponent(code)}`);
  document.title = `${code} · 诗光与你`;

  renderRoom();
  openStream();
  startPolling();
  window.scrollTo({ top: 0, behavior: 'auto' });
  setTimeout(focusBestInput, 160);
}

function openStream() {
  if (!app.roomCode) return;
  closeStream();
  const url = `/api/rooms/${encodeURIComponent(app.roomCode)}/events?token=${encodeURIComponent(app.token)}`;
  const es = new EventSource(url);
  app.sse = es;

  es.addEventListener('state', event => {
    try {
      const next = JSON.parse(event.data);
      setConnection(true);
      applyState(next);
    } catch (err) {
      console.error(err);
    }
  });
  es.onopen = () => setConnection(true);
  es.onerror = () => {
    if (!app.roomCode) return;
    setConnection(false);
    scheduleRefresh();
  };
}

function closeStream() {
  if (app.sse) {
    app.sse.close();
    app.sse = null;
  }
}

function setConnection(connected) {
  app.connected = connected;
  const bar = $('#connection-bar');
  if (!bar) return;
  bar.hidden = connected;
  if (!connected) {
    $('#connection-text').textContent = '连线断了，正在接回来…';
  }
}

function scheduleRefresh() {
  if (app.refreshTimer || !app.roomCode) return;
  app.refreshTimer = setTimeout(() => {
    app.refreshTimer = null;
    refreshState();
  }, 1800);
}

async function refreshState() {
  if (!app.roomCode) return;
  try {
    const data = await api(
      `/api/rooms/${encodeURIComponent(app.roomCode)}/state?token=${encodeURIComponent(app.token)}`
    );
    setConnection(true);
    applyState(data.state);
  } catch (err) {
    if (err.status === 404 || err.status === 403) {
      toast('这一席不在了。', 'error');
      goHome();
    }
  }
}

function startPolling() {
  clearInterval(app.pollTimer);
  app.pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshState();
  }, 45000);
}

function goHome() {
  const code = app.roomCode || normalizeCode($('#join-code').value);
  if (app.closeDialog) app.closeDialog();
  showHome();
  if (code) $('#join-code').value = code;
}

function applyState(next) {
  if (!next || !next.code) return;
  if (!app.roomCode) return;
  if (app.meId && !next.players.some(p => p.id === app.meId)) {
    toast('你已不在这一席。', 'error');
    goHome();
    return;
  }

  const prev = app.state;
  const oldPalette = app.paletteIndex;
  const newIds = new Set();
  for (const guess of next.round.guesses) {
    if (!app.seenGuessIds.has(guess.id)) newIds.add(guess.id);
  }
  for (const guess of next.round.guesses) app.seenGuessIds.add(guess.id);

  if (prev) {
    app.newGuessIds = newIds;
    if (next.round.status !== 'playing') {
      app.draftGuessUpper = '';
      app.draftGuessLower = '';
    }
    if (next.round.status !== 'setup') {
      app.draftPuzzleUpper = '';
      app.draftPuzzleLower = '';
    }
    if (next.round.status === 'setup' && prev.round.status !== 'setup') {
      app.draftPuzzleUpper = '';
      app.draftPuzzleLower = '';
      app.setupLength = next.round.length === 5 ? 5 : 7;
    }
    if (next.round.number !== prev.round.number) {
      app.draftGuessUpper = '';
      app.draftGuessLower = '';
      app.draftPuzzleUpper = '';
      app.draftPuzzleLower = '';
    }
    if (next.hostId !== prev.hostId && next.hostId === app.meId && next.round.status === 'setup') {
      app.draftPuzzleUpper = '';
      app.draftPuzzleLower = '';
      app.setupLength = next.round.length === 5 ? 5 : 7;
    }
  } else {
    app.newGuessIds = new Set();
    app.setupLength = next.round.length === 5 ? 5 : 7;
  }

  const becameRevealed =
    !!prev && prev.round.status === 'playing' && next.round.status === 'revealed';
  const freshWin = becameRevealed && !!next.round.winnerId;
  app.freshWin = freshWin;

  app.state = next;
  app.roomCode = next.code;
  if (oldPalette !== next.paletteIndex) applyPalette(next.paletteIndex, true);

  const sameRound = !!prev
    && prev.round.number === next.round.number
    && prev.round.status === next.round.status
    && prev.hostId === next.hostId;
  const typing = document.activeElement
    && document.activeElement.matches('input[id^="guess-"], input[id^="puzzle-"]');
  const deferStage = app.composing && typing && sameRound;
  if (deferStage) app.pendingComposeRender = true;

  renderRoom({ skipStage: deferStage });
  app.freshWin = false;

  if (document.visibilityState === 'hidden' && newIds.size) {
    document.title = `● ${next.code} · 诗光与你`;
  } else {
    document.title = `${next.code} · 诗光与你`;
  }

  if (!prev || prev.round.status !== next.round.status || prev.round.number !== next.round.number) {
    setTimeout(focusBestInput, 80);
  }
}

function focusBestInput() {
  if (!app.state || !POINTER_FINE) return;
  if (modalRoot.classList.contains('is-open')) return;
  const active = document.activeElement;
  if (active && active.matches('input[id^="guess-"], input[id^="puzzle-"]')) return;
  if (app.state.round.status === 'playing' && app.state.hostId !== app.meId) {
    $('#guess-upper')?.focus({ preventScroll: true });
  } else if (app.state.round.status === 'setup' && app.state.hostId === app.meId) {
    $('#puzzle-upper')?.focus({ preventScroll: true });
  }
}

/* ------------------------------------------------------------------ *
 * room render
 * ------------------------------------------------------------------ */

function renderRoom(opts = {}) {
  if (!app.state) return;
  const st = app.state;
  $('#room-code').textContent = st.code;
  $('#player-count').textContent = playerCountText(st);
  renderPlayers();
  renderEvents();
  renderSwatches();
  const hint = hostHint();
  $('#host-hint').textContent = hint;
  if (!opts.skipStage) renderStage();
}

function playerCountText(st) {
  const humans = st.players.filter(p => !p.isBot).length;
  return `${humans} 人`;
}

function hostHint() {
  const st = app.state;
  if (!st) return '';
  const isHost = st.hostId === app.meId;
  if (st.round.status === 'setup') {
    return isHost ? '开局前，你可以把出题权交给席间在线的朋友。' : '房主在出题。开局前，出题权可以转交。';
  }
  if (st.round.status === 'playing') {
    if (isHost) return '你在出题席。等所有人猜完或放弃，本局结束。';
    if (st.round.viewer?.canSeeAll) return '你已结束本局，可以查看所有人的落子。';
    return '还在猜的人，只能查看还在猜的人的落子。';
  }
  return isHost ? '可以再开一局，或把出题权交出去。' : `等 ${st.hostName || '房主'} 铺开下一局。`;
}

function canViewHistory(p) {
  const st = app.state;
  if (!st || !p || p.isBot || p.isHost || !p.guessCount) return false;
  if (st.round.status === 'setup') return false;
  if (st.round.status === 'revealed') return true;
  if (st.round.viewer?.canSeeAll) return true;
  return p.outcome === null;
}

function renderPlayers() {
  const st = app.state;
  const host = $('#players-list');
  if (!host) return;
  const isHost = st.hostId === app.meId;
  const canTransfer = isHost && st.round.status !== 'playing';

  host.innerHTML = st.players.map(p => {
    const mine = p.id === app.meId;
    const offline = !p.isBot && !p.online;
    const isPlayerHost = p.id === st.hostId;
    const sub = playerSubline(p, st);
    let action = '';
    if (canTransfer && !mine && !p.isBot && p.online) {
      action = `<button type="button" class="transfer-btn" data-action="transfer"
                 data-target="${escAttr(p.id)}"
                 title="${escAttr(`把出题权交给 ${p.name}`)}">传位</button>`;
    } else if (canViewHistory(p)) {
      action = `<button type="button" class="transfer-btn history-btn" data-action="history"
                 data-player="${escAttr(p.id)}"
                 title="${escAttr(`查看 ${p.name} 的猜测历史`)}">历史</button>`;
    }
    const outcomeClass = p.outcome === 'solved' ? 'is-solved' : p.outcome === 'gaveup' ? 'is-gaveup' : '';
    return `
      <div class="player ${mine ? 'is-me' : ''} ${offline ? 'is-offline' : ''} ${outcomeClass}">
        <span class="avatar ${p.isBot ? 'is-bot' : ''}">
          ${esc(firstChar(p.name))}
          <i class="presence ${p.online || p.isBot ? 'online' : ''}"></i>
        </span>
        <span class="player-main">
          <span class="player-name">
            ${esc(p.name)}
            ${mine ? '<em>我</em>' : ''}
            ${isPlayerHost ? '<i class="host-tag">出题</i>' : ''}
          </span>
          <span class="player-sub">${sub}</span>
        </span>
        ${action}
      </div>`;
  }).join('');
}

function playerSubline(p, st) {
  if (p.isBot) return '<span class="role-note">席间诗灵</span>';
  if (p.id === st.hostId) return '<span class="role-note">出题席</span>';
  if (st.round.status === 'setup') {
    return p.online ? '<span class="role-note">等开局</span>' : '<span class="role-note">离线</span>';
  }
  if (p.outcome === 'solved') return '<span class="role-note">已猜中</span>';
  if (p.outcome === 'gaveup') return '<span class="role-note">已放弃</span>';
  if (st.round.status === 'revealed') return '<span class="role-note">未猜</span>';
  const count = p.guessCount || 0;
  return `<span class="role-note">已猜 ${count} 次</span>${p.online ? '' : '<span>· 离线</span>'}`;
}

function renderEvents() {
  const list = $('#events-list');
  if (!list) return;
  const events = (app.state?.events || []).slice(-7);
  if (!events.length) {
    list.innerHTML = '<li class="events-empty">还没有什么发生。</li>';
    return;
  }
  list.innerHTML = events.map(ev => {
    const cls = ev.type === 'win' ? 'is-win' : ev.type === 'host' ? 'is-host' : '';
    return `<li class="${cls}">
      <time datetime="${new Date(ev.at).toISOString()}">${formatTime(ev.at)}</time>
      <span class="ev-text">${esc(ev.text)}</span>
    </li>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', {
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return ''; }
}

function renderStage() {
  const st = app.state;
  const stage = $('#stage');
  if (!st || !stage) return;

  const focus = captureFocus();
  const oldBoard = $('#board');
  const atBottom = oldBoard
    ? oldBoard.scrollHeight - oldBoard.scrollTop - oldBoard.clientHeight < 36
    : true;
  const hadGuesses = !!oldBoard && oldBoard.querySelectorAll('.guess-row').length > 0;

  stage.dataset.status = st.round.status;
  stage.dataset.round = String(st.round.number);

  const r = st.round;
  if (r.status === 'setup') {
    stage.innerHTML = st.hostId === app.meId ? setupMarkup() : waitingMarkup();
  } else if (r.status === 'playing') {
    stage.innerHTML = playingMarkup();
  } else {
    stage.innerHTML = revealMarkup();
  }

  if (focus) {
    const el = document.getElementById(focus.id);
    if (el) {
      try {
        el.focus({ preventScroll: true });
        el.setSelectionRange(focus.start, focus.end);
      } catch {}
    }
  }

  updateGuessCount();
  updatePuzzlePreview();

  if (app.freshWin) {
    const card = $('.reveal-card');
    if (card) card.insertAdjacentHTML('beforeend', petalsMarkup());
  }

  const newBoard = $('#board');
  if (newBoard) {
    const myNew = [...app.newGuessIds].some(id => {
      const g = r.guesses.find(x => x.id === id);
      return g && g.playerId === app.meId;
    });
    if ((app.newGuessIds.size && (atBottom || myNew)) || (!hadGuesses && r.guesses.length > 4)) {
      newBoard.scrollTop = newBoard.scrollHeight;
    } else if (atBottom && r.status !== 'revealed') {
      newBoard.scrollTop = newBoard.scrollHeight;
    }
  }
}

function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.matches('input[id^="guess-"], input[id^="puzzle-"]')) return null;
  return { id: el.id, start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
}

function setupMarkup() {
  const st = app.state;
  const r = st.round;
  const len = app.setupLength === 5 ? 5 : 7;
  const preview = previewCoupletMarkup(len);
  return `
    <div class="setup-wrap">
      <div class="eyebrow">第 ${r.number + 1} 局 · 待出联</div>
      <h2 class="setup-title">联，由你来出。</h2>
      <p class="length-note">完整一联：上下句各 ${len} 字。</p>

      <div class="length-switch" role="group" aria-label="选择句式">
        <button type="button" data-action="length" data-length="5" class="${len === 5 ? 'is-active' : ''}">五言<b>5</b></button>
        <button type="button" data-action="length" data-length="7" class="${len === 7 ? 'is-active' : ''}">七言<b>7</b></button>
      </div>

      <form id="puzzle-form" novalidate>
        <div class="puzzle-couplet">
          <div class="puzzle-field">
            <span class="couplet-line-label">上</span>
            <input id="puzzle-upper" type="text" maxlength="30" autocomplete="off" autocapitalize="off"
                   spellcheck="false" value="${escAttr(app.draftPuzzleUpper)}"
                   placeholder="${len === 5 ? '上句 · 五字' : '上句 · 七字'}"
                   aria-label="谜底上句">
            <span class="char-count" id="puzzle-upper-count">0/${len}</span>
          </div>
          <div class="puzzle-field">
            <span class="couplet-line-label">下</span>
            <input id="puzzle-lower" type="text" maxlength="30" autocomplete="off" autocapitalize="off"
                   spellcheck="false" value="${escAttr(app.draftPuzzleLower)}"
                   placeholder="${len === 5 ? '下句 · 五字' : '下句 · 七字'}"
                   aria-label="谜底下句">
            <span class="char-count" id="puzzle-lower-count">0/${len}</span>
          </div>
        </div>
        <p id="puzzle-error" class="form-error" role="alert"></p>
        <div class="puzzle-preview" id="puzzle-preview">${preview}</div>
        <div class="setup-actions">
          <button type="button" class="btn quiet" data-action="inspiration">
            <svg class="icon"><use href="#i-shuffle"></use></svg>
            借一联名句
          </button>
          <button type="submit" class="btn primary" id="puzzle-submit" ${app.pendingPuzzle ? 'disabled' : ''}>
            ${app.pendingPuzzle ? '封联中…' : '挂出此联'}
          </button>
        </div>
      </form>

      ${inviteStripMarkup()}
      <div class="setup-alt">
        <button type="button" class="text-link" data-action="poet">
          一个人先玩 · 让诗灵替我出联
          <svg class="icon"><use href="#i-arrow"></use></svg>
        </button>
      </div>
    </div>`;
}

function waitingMarkup() {
  const st = app.state;
  const r = st.round;
  const hostName = st.hostName || '房主';
  return `
    <div class="waiting-wrap">
      <div class="waiting-mark" aria-hidden="true"><span>待</span></div>
      <div class="eyebrow">第 ${r.number + 1} 局 · 房主出联中</div>
      <h2 class="waiting-title">纸已铺开，墨还没落。</h2>
      <p class="waiting-desc">房主 <b>${esc(hostName)}</b> 正在藏一联。你可以先把邀请码递给朋友，等人齐了再开局。</p>
      ${inviteStripMarkup()}
      <div class="waiting-players">
        ${st.players.filter(p => !p.isBot).map(p => `
          <span class="waiting-chip">
            <span class="avatar">${esc(firstChar(p.name))}</span>
            ${esc(p.name)}${p.id === st.hostId ? ' · 房主' : ''}
          </span>`).join('')}
      </div>
      <p class="whisper">开局前，房主可以把出题权交给席间任意一人。猜中的人，会成为新的房主。</p>
    </div>`;
}

function playingMarkup() {
  const st = app.state;
  const r = st.round;
  const viewer = r.viewer || {};
  const lenLabel = r.length === 5 ? '五言' : '七言';
  const isHost = st.hostId === app.meId;
  const finished = viewer.outcome === 'solved' || viewer.outcome === 'gaveup';
  const humans = st.players.filter(p => !p.isBot);
  const solvedCount = st.players.filter(p => p.outcome === 'solved').length;
  const gaveUpCount = st.players.filter(p => p.outcome === 'gaveup').length;
  const activeCount = r.activeGuessers ?? 0;
  const rows = r.guesses.length
    ? r.guesses.map(g => guessRowMarkup(g)).join('')
    : boardEmptyMarkup(r, isHost);

  const footer = isHost
    ? hostWatchMarkup()
    : finished
      ? ''
      : composerMarkup();

  return `
    <div class="playing-view">
      <div class="round-top">
        <div>
          <div class="eyebrow">第 ${r.number} 局 · ${lenLabel} · 上下句各${r.length}字 · 共 ${humans.length} 人在席</div>
          <h2 class="round-title">${lenLabel}一联，藏在这一局里。</h2>
          <div class="round-meta">
            <span>${solvedCount} 人已猜中</span>
            ${gaveUpCount ? `<i>·</i><span>${gaveUpCount} 人已放弃</span>` : ''}
            <i>·</i><span>${activeCount} 人还在猜</span>
          </div>
        </div>
        <span class="status-pill is-live"><i class="dot"></i>猜题中</span>
      </div>
      ${finished ? finishedPanelMarkup() : ''}
      ${boardLegendMarkup()}
      <div class="board" id="board">${rows}</div>
      ${footer}
    </div>`;
}

function answerCoupletMarkup(answer) {
  if (!answer) return '';
  const chars = text => Array.from(text || '').map((ch, i) =>
    `<span style="--i:${i}">${esc(ch)}</span>`).join('');
  return `
    <div class="answer-couplet">
      <div class="answer-line"><span class="answer-label">上</span><span class="answer-chars">${chars(answer.upper)}</span></div>
      <div class="answer-line"><span class="answer-label">下</span><span class="answer-chars">${chars(answer.lower)}</span></div>
    </div>`;
}

function finishedPanelMarkup() {
  const r = app.state.round;
  const solved = r.viewer?.outcome === 'solved';
  const meta = r.answerMeta && (r.answerMeta.author || r.answerMeta.title)
    ? `${r.answerMeta.author || ''}${r.answerMeta.title ? `《${r.answerMeta.title}》` : ''}`
    : '';
  return `
    <div class="finished-card">
      <div class="finished-head">
        <span class="eyebrow finished-kicker">${solved ? '你已猜中' : '你已放弃'}</span>
        <span class="eyebrow">${solved ? '等其他人结束' : '答案已揭晓'}</span>
      </div>
      ${answerCoupletMarkup(r.answer)}
      <div class="answer-meta">${meta ? esc(meta) : '未记出处'}</div>
      <p class="finished-note">${solved
        ? '等其他人猜完或放弃，本局就会结束。'
        : '答案已向你揭晓。等其他人猜完或放弃，本局就会结束。'}</p>
    </div>`;
}

function hostWatchMarkup() {
  const st = app.state;
  const r = st.round;
  const noGuessers = (r.guesserCount || 0) === 0;
  return `
    <div class="host-watch">
      <div class="host-watch-copy">
        <b>你在出题席</b>
        <span>${noGuessers
          ? '席间还没有人猜题。'
          : `等所有人猜完或放弃；${r.activeGuessers || 0} 人还在猜。`}</span>
      </div>
      ${noGuessers
        ? '<button type="button" class="btn quiet" data-action="reveal">结束本局</button>'
        : ''}
    </div>`;
}

function revealMarkup() {
  const st = app.state;
  const r = st.round;
  const winner = r.winnerId ? st.players.find(p => p.id === r.winnerId) : null;
  const isHost = st.hostId === app.meId;
  const hostIsBot = st.hostId === 'bot-poet';
  const meta = r.answerMeta && (r.answerMeta.author || r.answerMeta.title)
    ? `${r.answerMeta.author || ''}${r.answerMeta.title ? `《${r.answerMeta.title}》` : ''}`
    : '';
  const rows = r.guesses.length
    ? r.guesses.map(g => guessRowMarkup(g, { winnerId: r.winnerId })).join('')
    : '<p class="events-empty">这一局没有人落子。</p>';

  let actions = '';
  if (isHost) {
    actions += `<button type="button" class="btn primary" data-action="next">再出一联
      <svg class="icon"><use href="#i-arrow"></use></svg></button>`;
  } else if (hostIsBot) {
    actions += `<button type="button" class="btn primary" data-action="poet">请诗灵再出一联
      <svg class="icon"><use href="#i-arrow"></use></svg></button>`;
  } else {
    actions += `<span class="reveal-hint">等 <b>${esc(st.hostName || '房主')}</b> 铺开下一局。</span>`;
  }
  actions += `<button type="button" class="btn quiet" data-action="copy-invite">复制邀请</button>`;

  return `
    <div class="reveal-wrap">
      <div class="reveal-card">
        <div class="reveal-head">
          <span class="eyebrow reveal-kicker">${winner ? '本局有主 · 谜底' : '谜底揭晓'}</span>
          <span class="eyebrow">第 ${r.number} 局 · ${r.length === 5 ? '五言' : '七言'} · 上下句各${r.length}字</span>
        </div>
        ${answerCoupletMarkup(r.answer)}
        <div class="answer-meta">${meta ? esc(meta) : '未记出处'}</div>
        <p class="reveal-story">
          ${winner
            ? `<b>${esc(winner.name)}</b> 第一个猜中，接过出题权。${winner.id === app.meId ? '现在，轮到你出联。' : '等新房主铺开下一局。'}`
            : '本局结束，没有人猜中。房主可以再开一局。'}
        </p>
        <div class="reveal-actions">${actions}</div>
      </div>
      <div class="log-head">
        <h3>本局落子</h3>
        <span>${r.guesses.length} 联</span>
      </div>
      <div class="board reveal-board">${rows}</div>
    </div>`;
}

function boardLegendMarkup() {
  return `
    <div class="board-legend" aria-label="颜色规则">
      <span class="legend-pair"><span class="mini-tile absent">×</span><b>无此字</b></span>
      <span class="legend-pair"><span class="mini-tile present">◐</span><b>有字错位</b></span>
      <span class="legend-pair"><span class="mini-tile correct">✓</span><b>字位皆对</b></span>
    </div>`;
}

function boardEmptyMarkup(r, isHost) {
  const len = r.length;
  const ghosts = Array.from({ length: len }, () => '<span>·</span>').join('');
  const hidden = !r.viewer?.canSeeAll && (r.finishedGuessers || 0) > 0;
  return `
    <div class="board-empty">
      <div class="ghost-couplet" style="--len:${len}">
        <div class="ghost-line"><span class="couplet-line-label">上</span><div class="ghost-tiles" style="--len:${len}">${ghosts}</div></div>
        <div class="ghost-line"><span class="couplet-line-label">下</span><div class="ghost-tiles" style="--len:${len}">${ghosts}</div></div>
      </div>
      <p>第一联，会是谁的？</p>
      <small>${hidden
        ? '已结束本局的落子暂不可见。'
        : isHost ? '还没有人落子。' : '落下一联，颜色会告诉你字的位置。'}</small>
    </div>`;
}

function tilesMarkup(chars, marks) {
  return Array.from(chars || '').map((ch, i) => {
    const mark = marks?.[i] || 'absent';
    return `<span class="tile ${mark}" style="--i:${i}" aria-label="${escAttr(`${ch}：${MARK_LABEL[mark] || ''}`)}">
      <span aria-hidden="true">${esc(ch)}</span>
      <i class="mark" aria-hidden="true">${MARKS[mark] || '·'}</i>
    </span>`;
  }).join('');
}

function guessRowMarkup(g, opts = {}) {
  const upperMarks = g.marksUpper || [];
  const lowerMarks = g.marksLower || [];
  const mine = g.playerId === app.meId;
  const summary = coupletSummary(upperMarks, lowerMarks);
  const newRow = app.newGuessIds.has(g.id);
  const winning = opts.winnerId && g.playerId === opts.winnerId && g.correct;
  const cls = ['guess-row', mine ? 'is-mine' : '', newRow ? 'is-new' : '', winning ? 'is-winner' : ''].filter(Boolean).join(' ');
  const len = upperMarks.length || lowerMarks.length;
  return `
    <div class="${cls}">
      <div class="guess-who">
        <span class="avatar">${esc(firstChar(g.playerName))}</span>
        <b>${mine ? '我' : esc(g.playerName)}</b>
      </div>
      <div class="guess-couplet">
        <div class="guess-line"><span class="couplet-line-label">上</span><div class="guess-tiles" style="--len:${len}">${tilesMarkup(g.upper, upperMarks)}</div></div>
        <div class="guess-line"><span class="couplet-line-label">下</span><div class="guess-tiles" style="--len:${len}">${tilesMarkup(g.lower, lowerMarks)}</div></div>
      </div>
      <div class="guess-stats" aria-label="${summary.correct} 个字位皆对，${summary.present} 个字有字错位">
        <b class="s-correct">✓${summary.correct}</b> <b class="s-present">◐${summary.present}</b>
      </div>
    </div>`;
}

function composerMarkup() {
  const st = app.state;
  const r = st.round;
  return `
    <div class="composer">
      <form id="guess-form" class="guess-form" novalidate>
        <div class="guess-couplet-fields">
          <div class="composer-field">
            <span class="couplet-line-label">上</span>
            <input id="guess-upper" type="text" maxlength="30" autocomplete="off" autocapitalize="off"
                   spellcheck="false" enterkeyhint="next"
                   value="${escAttr(app.draftGuessUpper)}"
                   placeholder="上句 · ${r.length} 字"
                   aria-label="写下你猜的上句，${r.length} 个字">
            <span class="char-count" id="guess-upper-count">0/${r.length}</span>
          </div>
          <div class="composer-field">
            <span class="couplet-line-label">下</span>
            <input id="guess-lower" type="text" maxlength="30" autocomplete="off" autocapitalize="off"
                   spellcheck="false" enterkeyhint="send"
                   value="${escAttr(app.draftGuessLower)}"
                   placeholder="下句 · ${r.length} 字"
                   aria-label="写下你猜的下句，${r.length} 个字">
            <span class="char-count" id="guess-lower-count">0/${r.length}</span>
          </div>
        </div>
        <button type="submit" class="btn primary guess-submit" id="guess-submit" ${app.pendingGuess ? 'disabled' : ''}>
          ${app.pendingGuess ? '落子中…' : '落子'}
        </button>
      </form>
      <div class="composer-hint">
        <span id="wash-note"></span>
        <span class="composer-right">不限次数 · <button type="button" class="giveup-link" data-action="giveup">放弃并看答案</button></span>
      </div>
    </div>`;
}

function inviteStripMarkup() {
  return `
    <div class="invite-strip">
      <div>
        <span class="invite-label">邀请码 · 同一席的钥匙</span>
        <span class="invite-code">${esc(app.roomCode || '')}</span>
      </div>
      <button type="button" class="btn quiet" data-action="copy-invite">复制邀请</button>
    </div>`;
}

function previewLineMarkup(text, len) {
  const chars = Array.from(sanitizePoem(text).text);
  return Array.from({ length: len }, (_, i) => {
    const ch = chars[i];
    return `<div class="preview-tile ${ch ? 'is-filled' : 'is-empty'}">${ch ? esc(ch) : '·'}</div>`;
  }).join('');
}

function previewCoupletMarkup(len) {
  return `
    <div class="preview-couplet">
      <div class="preview-line"><span class="couplet-line-label">上</span><div class="preview-tiles" style="--len:${len}">${previewLineMarkup(app.draftPuzzleUpper, len)}</div></div>
      <div class="preview-line"><span class="couplet-line-label">下</span><div class="preview-tiles" style="--len:${len}">${previewLineMarkup(app.draftPuzzleLower, len)}</div></div>
    </div>`;
}

function updatePuzzlePreview() {
  const wrap = $('#puzzle-preview');
  if (!wrap) return;
  const len = app.setupLength === 5 ? 5 : 7;
  wrap.innerHTML = previewCoupletMarkup(len);

  const upper = $('#puzzle-upper');
  const lower = $('#puzzle-lower');
  app.draftPuzzleUpper = upper?.value ?? app.draftPuzzleUpper;
  app.draftPuzzleLower = lower?.value ?? app.draftPuzzleLower;
  const cleanUpper = sanitizePoem(app.draftPuzzleUpper);
  const cleanLower = sanitizePoem(app.draftPuzzleLower);
  const upperCount = $('#puzzle-upper-count');
  const lowerCount = $('#puzzle-lower-count');
  if (upperCount) {
    upperCount.textContent = `${cleanUpper.count}/${len}`;
    upperCount.classList.toggle('is-over', cleanUpper.count !== len || cleanUpper.invalid);
  }
  if (lowerCount) {
    lowerCount.textContent = `${cleanLower.count}/${len}`;
    lowerCount.classList.toggle('is-over', cleanLower.count !== len || cleanLower.invalid);
  }
  upper?.closest('.puzzle-field')?.classList.toggle('is-warn', cleanUpper.invalid || cleanUpper.count > len);
  lower?.closest('.puzzle-field')?.classList.toggle('is-warn', cleanLower.invalid || cleanLower.count > len);
}

function updateGuessCount() {
  const upper = $('#guess-upper');
  const lower = $('#guess-lower');
  if (!upper || !lower || !app.state || app.state.round.status !== 'playing') return;
  const len = app.state.round.length;
  const cleanUpper = sanitizePoem(upper.value);
  const cleanLower = sanitizePoem(lower.value);
  app.draftGuessUpper = upper.value;
  app.draftGuessLower = lower.value;

  const upperCount = $('#guess-upper-count');
  const lowerCount = $('#guess-lower-count');
  if (upperCount) {
    upperCount.textContent = `${cleanUpper.count}/${len}`;
    upperCount.classList.toggle('is-full', cleanUpper.count === len && !cleanUpper.invalid);
  }
  if (lowerCount) {
    lowerCount.textContent = `${cleanLower.count}/${len}`;
    lowerCount.classList.toggle('is-full', cleanLower.count === len && !cleanLower.invalid);
  }
  upper.closest('.composer-field')?.classList.toggle('is-warn', cleanUpper.invalid || cleanUpper.count > len);
  lower.closest('.composer-field')?.classList.toggle('is-warn', cleanLower.invalid || cleanLower.count > len);

  const wash = $('#wash-note');
  if (wash) {
    if (cleanUpper.invalid || cleanLower.invalid) wash.textContent = '只收汉字';
    else if (cleanUpper.removed > 0 || cleanLower.removed > 0) wash.textContent = '标点已洗净 · 只算汉字';
    else wash.textContent = '';
  }
  const button = $('#guess-submit');
  if (button) {
    const valid = !!cleanUpper.text && !!cleanLower.text
      && !cleanUpper.invalid && !cleanLower.invalid
      && cleanUpper.count === len && cleanLower.count === len;
    button.disabled = app.pendingGuess || !valid;
  }
}

/* ------------------------------------------------------------------ *
 * stage interactions
 * ------------------------------------------------------------------ */

function bindRoom() {
  $('#copy-code').addEventListener('click', copyInvite);
  $('#help-btn').addEventListener('click', openHelp);
  $('#leave-btn').addEventListener('click', confirmLeave);
  $('#brand-home').addEventListener('click', confirmLeave);

  const stage = $('#stage');
  stage.addEventListener('click', onStageClick);
  stage.addEventListener('submit', onStageSubmit);
  stage.addEventListener('input', onStageInput);
  stage.addEventListener('keydown', onStageKeydown);
  stage.addEventListener('compositionstart', () => { app.composing = true; });
  stage.addEventListener('compositionend', () => {
    app.composing = false;
    if (!app.pendingComposeRender) return;
    const el = document.activeElement;
    if (el?.id === 'guess-upper') app.draftGuessUpper = el.value;
    if (el?.id === 'guess-lower') app.draftGuessLower = el.value;
    if (el?.id === 'puzzle-upper') app.draftPuzzleUpper = el.value;
    if (el?.id === 'puzzle-lower') app.draftPuzzleLower = el.value;
    app.pendingComposeRender = false;
    setTimeout(() => {
      if (app.state) renderStage();
    }, 0);
  });

  $('#players-list').addEventListener('click', event => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'history') {
      event.preventDefault();
      openHistory(btn.dataset.player);
      return;
    }
    if (btn.dataset.action !== 'transfer') return;
    event.preventDefault();
    if (app.actionPending || app.pendingGuess || app.pendingPuzzle) return;
    confirmTransfer(btn.dataset.target);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (app.roomCode) document.title = `${app.roomCode} · 诗光与你`;
      if (app.roomCode) refreshState();
    }
  });
}

function onStageClick(event) {
  const btn = event.target.closest('[data-action]');
  if (!btn || !$('#stage').contains(btn)) return;
  const action = btn.dataset.action;

  if (action === 'length') {
    event.preventDefault();
    setSetupLength(Number(btn.dataset.length));
    return;
  }
  if (action === 'copy-invite') {
    event.preventDefault();
    copyInvite();
    return;
  }
  if (app.actionPending || app.pendingGuess || app.pendingPuzzle) return;

  if (action === 'inspiration') {
    event.preventDefault();
    borrowInspiration(btn);
  } else if (action === 'reveal') {
    event.preventDefault();
    confirmEndRound();
  } else if (action === 'next') {
    event.preventDefault();
    doNext(btn);
  } else if (action === 'poet') {
    event.preventDefault();
    summonPoet();
  } else if (action === 'transfer') {
    event.preventDefault();
    confirmTransfer(btn.dataset.target);
  } else if (action === 'giveup') {
    event.preventDefault();
    confirmGiveUp();
  }
}

function onStageSubmit(event) {
  if (event.target.id === 'guess-form') {
    event.preventDefault();
    if (app.composing) return;
    submitGuess();
  } else if (event.target.id === 'puzzle-form') {
    event.preventDefault();
    if (app.composing) return;
    submitPuzzle();
  }
}

function onStageInput(event) {
  const el = event.target;
  if (el.id === 'puzzle-upper') {
    app.draftPuzzleUpper = el.value;
    const err = $('#puzzle-error');
    if (err) err.textContent = '';
    updatePuzzlePreview();
  } else if (el.id === 'puzzle-lower') {
    app.draftPuzzleLower = el.value;
    const err = $('#puzzle-error');
    if (err) err.textContent = '';
    updatePuzzlePreview();
  } else if (el.id === 'guess-upper') {
    app.draftGuessUpper = el.value;
    updateGuessCount();
  } else if (el.id === 'guess-lower') {
    app.draftGuessLower = el.value;
    updateGuessCount();
  }
}

function onStageKeydown(event) {
  if (event.key !== 'Enter' || event.isComposing || app.composing) return;
  const el = event.target;
  if (el.id === 'puzzle-upper') {
    event.preventDefault();
    $('#puzzle-lower')?.focus({ preventScroll: true });
  } else if (el.id === 'guess-upper') {
    event.preventDefault();
    $('#guess-lower')?.focus({ preventScroll: true });
  }
}

function setSetupLength(len) {
  if (len !== 5 && len !== 7) return;
  if (app.setupLength === len) return;
  app.setupLength = len;
  const r = app.state?.round;
  if (!r || r.status !== 'setup') return;
  renderStage();
  const el = $('#puzzle-upper');
  if (el) {
    el.focus({ preventScroll: true });
    try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
  }
}

async function submitGuess() {
  if (app.pendingGuess || !app.state || app.state.round.status !== 'playing') return false;
  if (app.state.hostId === app.meId) return false;
  if (app.state.round.viewer?.outcome) return false;
  const upperInput = $('#guess-upper');
  const lowerInput = $('#guess-lower');
  const rawUpper = upperInput?.value ?? app.draftGuessUpper ?? '';
  const rawLower = lowerInput?.value ?? app.draftGuessLower ?? '';
  const clean = sanitizeCouplet(rawUpper, rawLower);
  const len = app.state.round.length;

  if (!clean.upper.text || !clean.lower.text) {
    toast('上下句都要写。', 'error');
    (!clean.upper.text ? upperInput : lowerInput)?.focus();
    return false;
  }
  if (clean.invalid) {
    toast('上下句都只收汉字，标点可以洗掉，字母和表情不行。', 'error');
    (clean.upper.invalid ? upperInput : lowerInput)?.focus();
    return false;
  }
  if (clean.upper.count !== len) {
    toast(`上句要 ${len} 个字，现在 ${clean.upper.count} 个。`, 'error');
    upperInput?.focus();
    return false;
  }
  if (clean.lower.count !== len) {
    toast(`下句要 ${len} 个字，现在 ${clean.lower.count} 个。`, 'error');
    lowerInput?.focus();
    return false;
  }

  app.pendingGuess = true;
  const button = $('#guess-submit');
  if (button) {
    button.disabled = true;
    button.textContent = '落子中…';
  }

  try {
    const data = await roomRequest('guess', { upper: rawUpper, lower: rawLower });
    app.draftGuessUpper = '';
    app.draftGuessLower = '';
    if (upperInput) upperInput.value = '';
    if (lowerInput) lowerInput.value = '';
    applyState(data.state);
    return true;
  } catch (err) {
    handleRoomError(err);
    return false;
  } finally {
    app.pendingGuess = false;
    const liveButton = $('#guess-submit');
    if (liveButton && liveButton.isConnected) {
      const stillPlaying = app.state && app.state.round.status === 'playing';
      liveButton.disabled = !stillPlaying;
      liveButton.textContent = '落子';
      updateGuessCount();
    }
  }
}

async function submitPuzzle() {
  if (app.pendingPuzzle || !app.state || app.state.round.status !== 'setup') return false;
  if (app.state.hostId !== app.meId) return false;
  const upperInput = $('#puzzle-upper');
  const lowerInput = $('#puzzle-lower');
  const rawUpper = upperInput?.value ?? app.draftPuzzleUpper ?? '';
  const rawLower = lowerInput?.value ?? app.draftPuzzleLower ?? '';
  const clean = sanitizeCouplet(rawUpper, rawLower);
  const len = app.setupLength === 5 ? 5 : 7;
  const errorEl = $('#puzzle-error');

  if (!clean.upper.text || !clean.lower.text) {
    if (errorEl) errorEl.textContent = '上下句都要写。';
    (!clean.upper.text ? upperInput : lowerInput)?.focus();
    return false;
  }
  if (clean.invalid) {
    if (errorEl) errorEl.textContent = '上下句都只能有汉字。';
    (clean.upper.invalid ? upperInput : lowerInput)?.focus();
    return false;
  }
  if (clean.upper.count !== len) {
    if (errorEl) errorEl.textContent = `上句要正好 ${len} 个字，现在是 ${clean.upper.count} 个。`;
    upperInput?.focus();
    return false;
  }
  if (clean.lower.count !== len) {
    if (errorEl) errorEl.textContent = `下句要正好 ${len} 个字，现在是 ${clean.lower.count} 个。`;
    lowerInput?.focus();
    return false;
  }

  app.pendingPuzzle = true;
  const button = $('#puzzle-submit');
  if (button) {
    button.disabled = true;
    button.textContent = '封联中…';
  }
  if (errorEl) errorEl.textContent = '';

  try {
    const data = await roomRequest('puzzle', { upper: rawUpper, lower: rawLower, length: len });
    app.draftPuzzleUpper = '';
    app.draftPuzzleLower = '';
    applyState(data.state);
    toast('联已挂出，等大家落子。');
    return true;
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message;
    handleRoomError(err);
    return false;
  } finally {
    app.pendingPuzzle = false;
    const live = $('#puzzle-submit');
    if (live && live.isConnected) {
      live.disabled = false;
      live.textContent = '挂出此联';
      updatePuzzlePreview();
    }
  }
}

async function borrowInspiration(button) {
  if (!app.state || app.state.round.status !== 'setup') return;
  const old = button.innerHTML;
  button.disabled = true;
  button.textContent = '翻诗中…';
  try {
    const couplet = await api(`/api/inspiration?length=${app.setupLength}`);
    app.draftPuzzleUpper = couplet.upper;
    app.draftPuzzleLower = couplet.lower;
    const upper = $('#puzzle-upper');
    const lower = $('#puzzle-lower');
    if (upper) upper.value = couplet.upper;
    if (lower) lower.value = couplet.lower;
    updatePuzzlePreview();
    const err = $('#puzzle-error');
    if (err) err.textContent = '';
    upper?.focus({ preventScroll: true });
    toast(couplet.author ? `借来 ${couplet.author} 的一联。` : '借来一联好诗。');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = old;
    }
  }
}

/* ------------------------------------------------------------------ *
 * room actions
 * ------------------------------------------------------------------ */

async function roomRequest(action, extra = {}) {
  return api(`/api/rooms/${encodeURIComponent(app.roomCode)}/${action}`, {
    method: 'POST',
    body: { token: app.token, ...extra },
  });
}

async function doNext(button) {
  await runAction(button, '铺纸中…', async () => {
    const data = await roomRequest('next');
    applyState(data.state);
    toast('新一局，可以出联了。');
    setTimeout(() => $('#puzzle-upper')?.focus({ preventScroll: true }), 120);
  });
}

function confirmEndRound() {
  if (!app.state || app.state.round.status !== 'playing') return;
  if ((app.state.round.guesserCount || 0) > 0) return;
  openDialog({
    eyebrow: '结束',
    title: '结束这一局？',
    body: '<p>席间还没有其他人猜题。结束后会揭晓谜底。</p>',
    confirmLabel: '结束本局',
    cancelLabel: '再等等',
    onConfirm: async () => {
      const data = await roomRequest('reveal');
      applyState(data.state);
      toast('本局已结束。');
      return true;
    },
  });
}

function confirmGiveUp() {
  if (!app.state || app.state.round.status !== 'playing') return;
  if (app.state.hostId === app.meId) return;
  if (app.state.round.viewer?.outcome) return;
  openDialog({
    eyebrow: '放弃',
    title: '放弃本局并看答案？',
    body: '<p>放弃后本局不能再猜，答案会立刻向你揭晓；本局会等其他玩家结束。</p>',
    confirmLabel: '放弃并看答案',
    cancelLabel: '再想想',
    danger: true,
    onConfirm: async () => {
      const data = await roomRequest('giveup');
      applyState(data.state);
      toast('答案已向你揭晓。');
      return true;
    },
  });
}

function openHistory(playerId) {
  const st = app.state;
  if (!st) return;
  const player = st.players.find(p => p.id === playerId);
  if (!player) return;
  if (!canViewHistory(player)) {
    toast('本局结束后才能查看 TA 的落子。', 'error');
    return;
  }
  const guesses = st.round.guesses.filter(g => g.playerId === playerId);
  const body = guesses.length
    ? `<div class="history-list">${guesses.map(g => guessRowMarkup(g)).join('')}</div>`
    : '<p>TA 还没有落子。</p>';
  openDialog({
    eyebrow: '猜测历史',
    title: `${player.name} 的落子`,
    body,
    confirmLabel: '知道了',
    showCancel: false,
  });
}

function confirmTransfer(targetId) {
  const target = app.state?.players.find(p => p.id === targetId);
  if (!target) return;
  openDialog({
    eyebrow: '传位',
    title: `把出题权交给${target.name}？`,
    body: '<p>交出后，你坐回猜题席。开局之前，新的房主还可以继续把出题权交给别人。</p>',
    confirmLabel: '交给 TA',
    cancelLabel: '再想想',
    onConfirm: async () => {
      const data = await roomRequest('host', { targetId });
      applyState(data.state);
      toast(`出题权已交给 ${target.name}。`);
      return true;
    },
  });
}

function confirmLeave() {
  if (!app.roomCode) {
    showHome();
    return;
  }
  const isHost = app.state?.hostId === app.meId;
  openDialog({
    eyebrow: '离席',
    title: '这一席，先坐到这儿？',
    body: isHost
      ? '<p>你是这一席的房主。离席后，出题权会交给下一位在席的人；这一局的落子会留在纸上。</p>'
      : '<p>离席后，你的位置会空出来。这一局已经落下的字，仍会留在这席的纸上。</p>',
    confirmLabel: '离席',
    cancelLabel: '再坐一会儿',
    danger: true,
    onConfirm: async () => {
      const code = app.roomCode;
      try {
        await api(`/api/rooms/${encodeURIComponent(code)}/leave`, {
          method: 'POST',
          body: { token: app.token },
        });
      } catch {}
      $('#join-code').value = code;
      goHome();
      toast('已离席。');
      return true;
    },
  });
}

function summonPoet() {
  if (!app.state || app.state.round.status === 'playing') return;
  const isHost = app.state.hostId === app.meId;
  if (app.state.round.status === 'revealed' && app.state.hostId === 'bot-poet') {
    runAction(null, '', async () => {
      const data = await roomRequest('poet');
      applyState(data.state);
      toast('诗灵铺好了新题。');
    });
    return;
  }
  if (!isHost) return;
  openDialog({
    eyebrow: '诗灵',
    title: '让诗灵出这一联？',
    body: '<p>诗灵会从名句里藏一联五言或七言。你会坐回猜题席。</p>',
    confirmLabel: '交给诗灵',
    cancelLabel: '自己来',
    onConfirm: async () => {
      const data = await roomRequest('poet');
      applyState(data.state);
      toast('诗灵铺好了新联。');
      return true;
    },
  });
}

async function runAction(button, busyLabel, fn) {
  if (app.actionPending) return;
  app.actionPending = true;
  const old = button ? button.innerHTML : '';
  if (button) {
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
  }
  try {
    await fn();
  } catch (err) {
    handleRoomError(err);
  } finally {
    app.actionPending = false;
    if (button && button.isConnected) {
      button.disabled = false;
      if (button.innerHTML !== old) button.innerHTML = old;
    }
  }
}

function handleRoomError(err) {
  if (!err) return;
  if (err.status === 404 || err.status === 403 || err.code === 'not_in_room') {
    if (err.code === 'not_in_room') {
      toast('你已不在这一席。', 'error');
      goHome();
      return;
    }
    if (err.code === 'room_not_found') {
      toast('这一席不在了。', 'error');
      goHome();
      return;
    }
  }
  toast(err.message || '这一手没有落成，再试一次。', 'error');
}

/* ------------------------------------------------------------------ *
 * copy / help
 * ------------------------------------------------------------------ */

async function copyInvite() {
  if (!app.roomCode) return;
  let origin = location.origin;
  if (['localhost', '127.0.0.1', '::1'].includes(location.hostname) && app.meta?.lanUrls?.length) {
    origin = app.meta.lanUrls[0];
  }
  const link = `${origin}/?room=${app.roomCode}`;
  const text = `来「诗光与你」猜一联诗。\n邀请码：${app.roomCode}\n${link}`;
  const ok = await copyText(text);
  if (ok) toast(`邀请码 ${app.roomCode} 与链接已复制。`);
  else toast(`复制没有成功，手动抄一下：${app.roomCode}`, 'error');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function openHelp() {
  const rules = `
    <ul class="modal-rules">
      <li><span class="rule-num">1</span><span>房主选五言或七言，写下完整一联：上下句各 5 或 7 字。其余人各猜完整一联，标点与空格会被洗净。房主不猜自己的题。</span></li>
      <li><span class="rule-num">2</span><span>每落一联，上下句分别判色：<b>× 无此字</b>，<b>◐ 有字但错位</b>，<b>✓ 字位皆对</b>。</span></li>
      <li><span class="rule-num">3</span><span>每人猜测次数不限。猜中或放弃会结束你自己的本局；所有猜题人都结束，本局才结束。第一个猜中的人成为新房主。</span></li>
      <li><span class="rule-num">4</span><span>已结束的人可以查看任何人的落子；还在猜的人只能查看还在猜的人的落子。放弃会立刻看到答案。</span></li>
      <li><span class="rule-num">5</span><span>邀请码是同一席的钥匙，把入席链接发给朋友即可。开局前房主可以把出题权交给别人。</span></li>
    </ul>
    <div class="modal-legend">
      <span class="legend-pair"><span class="mini-tile absent">×</span> 无此字</span>
      <span class="legend-pair"><span class="mini-tile present">◐</span> 有字错位</span>
      <span class="legend-pair"><span class="mini-tile correct">✓</span> 字位皆对</span>
    </div>
    <p style="margin-top:18px"><b>色卡</b> — 每开一局轮换一组，当前是第 ${app.paletteIndex + 1} 组「${esc(app.palettes[app.paletteIndex]?.name || '')}」。</p>
    ${paletteGridMarkup()}
    ${app.roomCode ? `<p style="margin-top:16px">这一席的邀请码：<b>${esc(app.roomCode)}</b>。</p>` : ''}
  `;
  openDialog({
    eyebrow: '玩法',
    title: '一字一光，同席成诗。',
    body: rules,
    confirmLabel: '知道了',
    showCancel: false,
  });
}

/* ------------------------------------------------------------------ *
 * dialog & toast
 * ------------------------------------------------------------------ */

function openDialog(opts) {
  if (!modalRoot) return;
  if (modalRoot.classList.contains('is-open')) return;
  const lastFocus = document.activeElement;
  const showCancel = opts.showCancel !== false;
  const danger = !!opts.danger;

  modalRoot.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <button type="button" class="modal-close" data-close aria-label="关闭">×</button>
      ${opts.eyebrow ? `<div class="eyebrow">${esc(opts.eyebrow)}</div>` : ''}
      <h2 id="modal-title">${esc(opts.title || '')}</h2>
      <div class="modal-body">${opts.body || ''}</div>
      <p id="modal-error" class="form-error" role="alert"></p>
      <div class="modal-actions">
        ${showCancel ? `<button type="button" class="btn quiet" data-close>${esc(opts.cancelLabel || '再想想')}</button>` : ''}
        <button type="button" class="btn ${danger ? 'danger' : 'primary'}" id="modal-confirm">
          ${esc(opts.confirmLabel || '确定')}
        </button>
      </div>
    </div>`;
  modalRoot.classList.add('is-open');
  modalRoot.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  const confirmBtn = $('#modal-confirm', modalRoot);
  const errorEl = $('#modal-error', modalRoot);

  const close = () => {
    if (app.dialogBusy) return;
    modalRoot.classList.remove('is-open');
    modalRoot.setAttribute('aria-hidden', 'true');
    modalRoot.onkeydown = null;
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
    app.closeDialog = null;
    if (lastFocus && lastFocus.isConnected) {
      try { lastFocus.focus({ preventScroll: true }); } catch {}
    }
  };
  app.closeDialog = close;

  $$('[data-close]', modalRoot).forEach(btn => btn.addEventListener('click', close));

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      if (app.dialogBusy) return;
      if (!opts.onConfirm) {
        close();
        return;
      }
      app.dialogBusy = true;
      const oldLabel = confirmBtn.textContent;
      confirmBtn.disabled = true;
      confirmBtn.textContent = opts.busyLabel || '稍等…';
      if (errorEl) errorEl.textContent = '';
      let ok = false;
      try {
        const result = await opts.onConfirm();
        ok = result !== false;
      } catch (err) {
        if (errorEl) errorEl.textContent = err.message || '没有成功，再试一次。';
      } finally {
        app.dialogBusy = false;
        if (confirmBtn.isConnected) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = oldLabel;
        }
      }
      if (ok) close();
    });
  }

  const focusables = $$('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', modalRoot);
  const initialFocus = danger
    ? $('[data-close]', modalRoot) || focusables[0]
    : confirmBtn || focusables[0];
  setTimeout(() => initialFocus?.focus({ preventScroll: true }), 30);

  modalRoot.onkeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab' || !focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
}

function toast(message, type = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast is-visible ${type === 'error' ? 'is-error' : ''}`.trim();
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
  }, 3400);
}

/* ------------------------------------------------------------------ *
 * api & misc
 * ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const payload = data?.error || {};
    const err = new Error(payload.message || `这一手没有落成（${res.status}）。`);
    err.status = res.status;
    err.code = payload.code || 'request_failed';
    err.data = payload;
    throw err;
  }
  return data;
}

function getMe() {
  return app.state?.players.find(p => p.id === app.meId) || null;
}

function firstChar(name) {
  return Array.from(String(name || '诗'))[0] || '诗';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function escAttr(value) {
  return esc(value);
}

function petalsMarkup() {
  const petals = Array.from({ length: 14 }, (_, i) => {
    const x = 4 + Math.random() * 92;
    const drift = (Math.random() * 70 - 35).toFixed(0);
    const dur = 2400 + Math.random() * 2200;
    const delay = Math.random() * 900;
    return `<i class="petal" style="--x:${x.toFixed(1)}%;--drift:${drift}px;--dur:${dur.toFixed(0)}ms;--delay:${delay.toFixed(0)}ms"></i>`;
  }).join('');
  return `<div class="petals" aria-hidden="true">${petals}</div>`;
}

function bindGlobal() {
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && app.closeDialog) app.closeDialog();
  });
  modalRoot.addEventListener('mousedown', event => {
    if (event.target === modalRoot && app.closeDialog) app.closeDialog();
  });
  window.addEventListener('online', () => {
    if (app.roomCode) {
      setConnection(false);
      scheduleRefresh();
    }
  });
}
