import './style.css';
import { createGame, addPlayer, viewFor, advance, setNextQuestion, configError, cleanName, MAX_NAME, MAX_PLAYERS } from './game.js';
import { hostRoom, joinClient, genCode, normCode, validCode } from './net.js';

const DAWN_MS = 6000;
const VERDICT_MS = 7000;

/* ------------------------------ helpers ------------------------------ */

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* no storage: still works */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  json(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  // ponytail: XOR+base64 only stops casual peeking at saved roles; the key ships in this file, so it is not security.
  seal(k, obj) {
    const b = new TextEncoder().encode(JSON.stringify(obj));
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ^ MASK.charCodeAt(i % MASK.length));
    this.set(k, btoa(s));
  },
  unseal(k) {
    try {
      const s = atob(localStorage.getItem(k));
      const b = Uint8Array.from(s, (c, i) => c.charCodeAt(0) ^ MASK.charCodeAt(i % MASK.length));
      return JSON.parse(new TextDecoder().decode(b));
    } catch { return null; }
  },
};
const MASK = 'speakeasy-noir';
const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
const getToken = () => {
  let t = store.get('mafia-token');
  if (!t) { t = uuid(); store.set('mafia-token', t); }
  return t;
};

// DOM builder. Strings become text nodes, so player-supplied text is never parsed as HTML.
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') for (const [a, b] of Object.entries(v)) e.style.setProperty(a, b);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return e;
}
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

// Keyed list reconcile: keeps existing nodes (and their animations) alive.
function sync(parent, items, key, make, update, leave) {
  const old = new Map();
  for (const c of parent.children) if (!c.classList.contains('leaving')) old.set(c.dataset.k, c);
  items.forEach((it, i) => {
    const k = String(key(it));
    let el = old.get(k);
    if (el) old.delete(k);
    else { el = make(it); el.dataset.k = k; }
    update(el, it);
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null);
  });
  old.forEach((el) => {
    if (leave) { el.classList.add('leaving'); setTimeout(() => el.remove(), 220); } else el.remove();
  });
}

const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (name, id) => h('span', { class: 'avatar', style: { '--h': hue(id || name) } }, [...name][0]?.toUpperCase() || '?');
const SUITS = ['♠', '♥', '♦', '♣'];
const suitOf = (id) => SUITS[hue(String(id)) % 4];
const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch { /* unsupported */ } };

let toastTimer = 0;
function toast(msg) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: 'toast' }, msg);
  box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  clearTimeout(toastTimer);
  setTimeout(() => t.classList.add('out'), 2800);
  setTimeout(() => t.remove(), 3200);
}

const ROLE = {
  mafia: { label: 'Mafia', icon: '\u{1F52A}', blurb: 'Eliminate the town, one night at a time. Do not get caught.' },
  doctor: { label: 'Doctor', icon: '⚕️', blurb: 'Each night, protect one player from the mafia.' },
  detective: { label: 'Detective', icon: '\u{1F50E}', blurb: 'Each night, learn whether one player is Mafia.' },
  jester: { label: 'Jester', icon: '\u{1F0CF}', blurb: 'Get yourself voted out and you win alone.' },
  civilian: { label: 'Civilian', icon: '\u{1F3E0}', blurb: 'Find the mafia and vote them out.' },
};
const WINNER = {
  town: { title: 'Town wins', head: 'Town cleans up the streets', sub: 'The mafia has been rooted out.', color: 'gold' },
  mafia: { title: 'Mafia wins', head: 'Mafia takes the city', sub: 'The town fell to the shadows.', color: 'crimson' },
  jester: { title: 'Jester wins', head: 'The Jester has the last laugh', sub: 'The fool had the last laugh.', color: 'violet' },
};

/* ------------------------------ app state ------------------------------ */

const S = {
  mode: 'home', // home | connecting | error | game
  view: null,
  sel: null, // locally selected target (not yet locked)
  host: null, // hostRoom handle when we are the host
  state: null, // authoritative state (host only)
  client: null,
  lostHost: false,
  tmp: null, // { code, name } while connecting
  errMsg: '',
};
const cur = { key: null, update: () => {}, el: null };
const timer = { key: null, id: 0 };
const nm = (v, id) => v.players.find((p) => p.id === id)?.name ?? '?';

/* ------------------------------ actions ------------------------------ */

function doAct(kind, target) {
  if (S.host) {
    const e = S.host.act({ kind, target });
    if (e) toast(e);
  } else if (S.client) {
    if (!S.client.send(kind, target)) toast('Reconnecting to host...');
  }
}

const shareUrl = (code) => `${location.origin}/?room=${code}`;
async function share(code) {
  const url = shareUrl(code);
  try {
    if (navigator.share) { await navigator.share({ title: 'Mafia', text: `Join my Mafia game: ${code}`, url }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
}

/* ------------------------------ wake lock ------------------------------ */

let wake = null;
async function keepAwake() {
  try {
    if (!navigator.wakeLock || wake || document.visibilityState !== 'visible') return;
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => { wake = null; });
  } catch { /* not allowed: fine */ }
}
function releaseAwake() { try { wake?.release(); } catch { /* ignore */ } wake = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !(S.host || S.client)) return;
  keepAwake();
  S.client?.rehello(); // phone woke up: let the host rebind our token and resend the view
});

/* ------------------------------ session / lifecycle ------------------------------ */

function resetLocal() {
  clearTimeout(timer.id);
  timer.key = null;
  S.host?.leave();
  S.client?.leave();
  fetchState.key = null;
  Object.assign(S, { host: null, client: null, state: null, view: null, sel: null, lostHost: false, tmp: null });
  releaseAwake();
}

function goHome(msg) {
  const session = store.json('mafia-session');
  if (session?.host) store.del('mafia-host-' + session.room);
  store.del('mafia-session');
  resetLocal();
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  S.mode = 'home';
  render();
  if (msg) toast(msg);
}

function leaveRoom() {
  const host = !!S.host;
  if (!confirm(host ? 'Leave? The game ends for everyone.' : 'Leave this game?')) return;
  goHome();
}

function setUrl(code) { try { history.replaceState(null, '', '?room=' + code); } catch { /* ignore */ } }

/* ---- host ---- */

function onHostChange(state) {
  store.seal('mafia-host-' + state.code, state);
  store.set('mafia-at', String(Date.now()));
  armTimer(state);
  prefetchQuestion(state);
  const me = state.players.find((p) => p.isHost);
  S.view = viewFor(state, me.id);
  S.mode = 'game';
  render();
}

/* Decoy-question prefetch (host only). Never blocks the game: any failure leaves game.js's built-in fallback. */
const QUESTION_API = 'https://api.truthordarebot.xyz/api/paranoia?rating=';
const fetchState = { key: null, busy: false };
async function fetchQuestion(rating) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(QUESTION_API + rating, { signal: ctl.signal });
    const j = await res.json();
    return { id: j.id, text: j.question };
  } finally { clearTimeout(t); }
}
async function prefetchQuestion(state) {
  if (!['roles', 'dawn', 'verdict'].includes(state.phase) || state.nextQuestion || fetchState.busy) return;
  const key = state.phase + state.round;
  if (fetchState.key === key) return; // one attempt per phase
  fetchState.key = key;
  fetchState.busy = true;
  try {
    for (let attempt = 0; attempt < 2; attempt++) { // retry once if the result is a repeat
      const q = await fetchQuestion(state.config.spice);
      if (S.state !== state) return;
      if (!setNextQuestion(state, q)) { store.seal('mafia-host-' + state.code, state); return; }
    }
  } catch { /* offline, timeout or bad JSON: fallback list is used */ } finally { fetchState.busy = false; }
}

function armTimer(state) {
  const ms = state.phase === 'dawn' ? DAWN_MS : state.phase === 'verdict' ? VERDICT_MS : 0;
  const key = ms ? state.phase + state.round : null;
  if (key === timer.key) return;
  clearTimeout(timer.id);
  timer.key = key;
  if (!ms) return;
  timer.id = setTimeout(() => {
    timer.key = null;
    if (S.state === state && state.phase + state.round === key && advance(state)) S.host.changed();
  }, ms);
}

function startHost(state, session) {
  S.state = state;
  S.host = hostRoom(state, onHostChange);
  store.set('mafia-session', JSON.stringify({ ...session, host: true }));
  setUrl(state.code);
  keepAwake();
  S.host.changed();
}

function createRoom(rawName) {
  const name = cleanName(rawName);
  const token = getToken();
  const state = createGame(genCode());
  const r = addPlayer(state, { name, token, isHost: true });
  if (r.error) return toast(r.error);
  store.set('mafia-name', name);
  startHost(state, { room: state.code, name, token });
}

function resumeHost(state, session) {
  state.players.forEach((p) => { p.connected = p.isHost; }); // everyone re-hellos
  startHost(state, session);
}

/* ---- client ---- */

function joinRoomAs(code, rawName) {
  const name = cleanName(rawName);
  if (!name) return toast('Enter a name');
  if ([...name].length > MAX_NAME) return toast(`Name too long (max ${MAX_NAME})`);
  if (!validCode(code)) return toast('Enter the 4-character room code');
  store.set('mafia-name', name);
  resetLocal();
  S.mode = 'connecting';
  S.tmp = { code, name };
  const token = getToken();
  setUrl(code);
  keepAwake();
  S.client = joinClient(code, { name, token }, {
    onView(v) {
      if (!S.client) return;
      if (S.mode !== 'game') store.set('mafia-session', JSON.stringify({ room: code, name, token }));
      S.mode = 'game';
      S.lostHost = false;
      S.view = v;
      store.set('mafia-at', String(Date.now()));
      render();
    },
    onErr(msg) {
      if (msg === 'Not in this game') return S.client?.rehello();
      if (S.mode !== 'game' || msg === 'Removed by host') return goHome(msg);
      toast(msg);
    },
    onTimeout() { S.mode = 'error'; S.errMsg = 'Room not found or host offline'; render(); },
    onHostLost() { S.lostHost = true; render(); },
  });
  render();
}

/* ------------------------------ render core ------------------------------ */

const locked = (v) => (v.phase === 'night' || v.phase === 'vote') && v.locked;
function screenKey() {
  const v = S.view;
  if (S.mode !== 'game' || !v) return S.mode;
  return [v.phase, v.round, v.you.alive ? 1 : 0, locked(v) ? 1 : 0].join('|');
}

const BUILDERS = { lobby, roles, night, dawn, vote, verdict, over };
const THEME = { lobby: 'lobby', roles: 'lobby', night: 'night', dawn: 'dawn', vote: 'day', verdict: 'day', over: 'over' };

const hud = (() => {
  const code = h('span', { class: 'hud-code' });
  const banner = h('div', { class: 'banner', hidden: true }, 'Connection to host lost. Reconnecting...');
  const el = document.getElementById('hud');
  // Hold-to-peek: the role is never left on screen, it shows only while pressed.
  const peekBox = h('div', { class: 'peek', hidden: true });
  const show = (on) => (e) => {
    e.preventDefault();
    const r = on && S.view?.you.role && ROLE[S.view.you.role];
    peekBox.hidden = !r;
    if (r) peekBox.replaceChildren(h('span', { class: 'ico' }, r.icon), h('b', {}, r.label));
  };
  const peek = h('button', {
    class: 'ghost sm peekbtn', type: 'button', onpointerdown: show(true), onpointerup: show(false),
    onpointerleave: show(false), onpointercancel: show(false), oncontextmenu: (e) => e.preventDefault(),
  }, 'Hold: role');
  el.append(h('div', { class: 'hud-row' }, h('span', { class: 'hud-label' }, 'Room'), code, peek,
    h('button', { class: 'ghost sm', type: 'button', onclick: leaveRoom }, 'Leave')), banner);
  document.body.append(peekBox);
  return {
    update() {
      const inGame = (S.mode === 'game' && S.view) || S.mode === 'connecting';
      el.hidden = !inGame;
      peek.hidden = !['night', 'dawn', 'vote', 'verdict'].includes(S.view?.phase) || S.mode !== 'game';
      if (peek.hidden) peekBox.hidden = true;
      setText(code, S.view?.code || S.tmp?.code || '');
      banner.hidden = !S.lostHost;
    },
  };
})();

function render() {
  const screen = document.getElementById('screen');
  const key = screenKey();
  if (key !== cur.key) {
    S.sel = null;
    const build = S.mode === 'game' && S.view ? BUILDERS[S.view.phase] : { home, connecting, error: errorScreen, resume: resumeScreen }[S.mode];
    const { el, update } = build(S.view);
    el.classList.add('screen', 'enter');
    screen.replaceChildren(el);
    window.scrollTo(0, 0);
    Object.assign(cur, { key, update, el });
  }
  if (S.mode === 'game' && S.view) {
    document.body.dataset.theme = S.view.phase === 'over' ? 'over-' + S.view.winner : THEME[S.view.phase];
  } else document.body.dataset.theme = 'lobby';
  cur.update(S.view);
  hud.update();
}

/* ------------------------------ shared components ------------------------------ */

function counter(label) {
  const txt = h('span', { class: 'count-txt' });
  const bar = h('i');
  return {
    el: h('div', { class: 'counter' }, h('div', { class: 'count-row' }, h('span', {}, label), txt), h('div', { class: 'bar' }, bar)),
    set(done, total) {
      setText(txt, `${done} / ${total}`);
      bar.style.width = (total ? (done / total) * 100 : 0) + '%';
    },
  };
}

function canRemove(v, p) {
  return v.you.isHost && !p.connected && p.alive && !p.isHost && ['roles', 'night', 'vote'].includes(v.phase);
}

// Player roster with offline badges, optional check marks and host-only Remove.
function roster(title, marksOf, { onlyIfOffline = false } = {}) {
  const list = h('div', { class: 'plist' });
  const head = h('h3', {}, title);
  const el = h('div', { class: 'card roster' }, head, list);
  return {
    el,
    update(v) {
      el.hidden = onlyIfOffline && !v.players.some((p) => !p.connected && p.alive);
      const marks = new Set(marksOf ? marksOf(v) : []);
      sync(list, v.players, (p) => p.id,
        (p) => h('div', { class: 'prow' }, avatar(p.name, p.id), h('span', { class: 'pname' }), h('span', { class: 'tick' }, '✓'),
          h('span', { class: 'badge off' }, 'offline'),
          h('button', { class: 'ghost sm rm', type: 'button', onclick: () => doAct('remove', p.id) }, 'Remove')),
        (row, p) => {
          setText(row.querySelector('.pname'), p.name);
          row.classList.toggle('dead', !p.alive);
          row.classList.toggle('done', marks.has(p.id));
          row.querySelector('.badge').hidden = p.connected;
          row.querySelector('.rm').hidden = !canRemove(v, p);
        });
    },
  };
}

function targetGrid({ withSkip = false, onPick, chipsOf }) {
  const grid = h('div', { class: 'targets' });
  return {
    el: grid,
    update(v, selId, enabled) {
      // v.targets = eligible ids; v.blocked = doctor-only greyed out player (kept in player order)
      const items = v.players.filter((p) => v.targets.includes(p.id) || p.id === v.blocked);
      if (withSkip) items.push({ id: 'skip', name: 'Skip (no one)', skip: true, connected: true });
      sync(grid, items, (p) => p.id,
        (p) => h('button', { class: 'target' + (p.skip ? ' skip' : '') + (['♥', '♦'].includes(suitOf(p.id)) ? ' red' : ''), type: 'button', onclick: () => onPick(p.id) },
          h('span', { class: 'pip tl' }, p.skip ? '★' : suitOf(p.id)), h('span', { class: 'pip br' }, p.skip ? '★' : suitOf(p.id)),
          p.skip ? h('span', { class: 'avatar sk' }, '\u2715') : avatar(p.name, p.id),
          h('span', { class: 'tname' }), h('span', { class: 'badge off' }, 'offline'), h('span', { class: 'note' }, 'Saved 2 nights in a row'), h('span', { class: 'chips' })),
        (el, p) => {
          const blocked = p.id === v.blocked;
          setText(el.querySelector('.tname'), p.name);
          el.querySelector('.badge').hidden = p.connected;
          el.querySelector('.note').hidden = !blocked;
          el.classList.toggle('blocked', blocked);
          el.classList.toggle('sel', selId === p.id);
          el.disabled = !enabled || blocked;
          if (chipsOf) {
            sync(el.querySelector('.chips'), chipsOf(v, p.id), (c) => c.id,
              () => h('span', { class: 'chip' }),
              (chip, c) => { setText(chip, (c.locked ? '\u{1F512} ' : '') + c.label); chip.classList.toggle('locked', c.locked); },
              true);
          }
        });
    },
  };
}

/* ------------------------------ screens ------------------------------ */

function home() {
  const params = new URLSearchParams(location.search);
  const urlRoom = normCode(params.get('room'));
  const name = h('input', { class: 'input', type: 'text', placeholder: 'Your name', maxlength: 32, autocomplete: 'off', autocapitalize: 'words', 'aria-label': 'Your name', value: store.get('mafia-name') || '' });
  const code = h('input', { class: 'input code', type: 'text', placeholder: 'CODE', maxlength: 4, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Room code', value: urlRoom });
  code.addEventListener('input', () => { code.value = normCode(code.value); });
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoomAs(normCode(code.value), name.value); });
  const emblem = h('div', { class: 'emblem', 'aria-hidden': 'true' }, h('i', { class: 'fan' }), h('i', { class: 'fan-ring' }),
    h('div', { class: 'fedora' }, h('i', { class: 'crown' }), h('i', { class: 'band' }), h('i', { class: 'brim' })));
  const el = h('section', { class: 'home' },
    h('div', { class: 'logo' }, emblem, h('h1', {}, 'MAFIA'), h('p', { class: 'tag' }, 'Trust no one. Pass the phone, not the blame.')),
    h('div', { class: 'card' },
      h('label', { class: 'lbl' }, 'Your name'), name,
      h('button', { class: 'btn primary', type: 'button', onclick: () => createRoom(name.value) }, 'Create room'),
      h('div', { class: 'or' }, h('span', {}, 'or join')),
      h('div', { class: 'join-row' }, code, h('button', { class: 'btn', type: 'button', onclick: () => joinRoomAs(normCode(code.value), name.value) }, 'Join'))),
    h('p', { class: 'fine' }, 'No accounts. Phones connect directly to each other.'));
  return { el, update() {} };
}

function connecting() {
  const msg = h('p', { class: 'muted' });
  return {
    el: h('section', { class: 'center' }, h('div', { class: 'spinner' }), h('h2', {}, 'Connecting'), msg,
      h('button', { class: 'ghost', type: 'button', onclick: () => goHome() }, 'Cancel')),
    update() { setText(msg, S.tmp ? `Looking for room ${S.tmp.code}...` : ''); },
  };
}

function errorScreen() {
  const msg = h('p', { class: 'muted' });
  return {
    el: h('section', { class: 'center' }, h('div', { class: 'big-icon' }, '\u{1F5DD}️'), h('h2', {}, 'Cannot connect'), msg,
      h('button', { class: 'btn primary', type: 'button', onclick: () => S.tmp && joinRoomAs(S.tmp.code, S.tmp.name) }, 'Retry'),
      h('button', { class: 'ghost', type: 'button', onclick: () => goHome() }, 'Back')),
    update() { setText(msg, S.errMsg); },
  };
}

function lobby(v) {
  const isHost = v.you.isHost;
  const plist = h('div', { class: 'plist' });
  const count = h('span', { class: 'muted' });
  const err = h('p', { class: 'warn' });
  const start = h('button', { class: 'btn primary', type: 'button', onclick: () => doAct('start') }, 'Start game');
  const rows = {};
  const cfgEl = h('div', { class: 'cfg' });
  const defs = [['mafia', 'Mafia'], ['doctor', 'Doctor'], ['detective', 'Detective'], ['jester', 'Jester']];
  for (const [k, label] of defs) {
    const val = h('b', { class: 'val' });
    const minus = h('button', { class: 'step', type: 'button', 'aria-label': 'Fewer ' + label, onclick: () => doAct('config', { [k]: S.view.config[k] - 1 }) }, '−');
    const plus = h('button', { class: 'step', type: 'button', 'aria-label': 'More ' + label, onclick: () => doAct('config', { [k]: S.view.config[k] + 1 }) }, '+');
    rows[k] = { val, minus, plus };
    cfgEl.append(h('div', { class: 'cfg-row' }, h('span', { class: 'cfg-ico' }, ROLE[k].icon), h('span', { class: 'cfg-name' }, label),
      h('span', { class: 'stepper' }, isHost && minus, val, isHost && plus)));
  }
  const spiceBtns = [['pg', 'Mild'], ['pg13', 'Spicy']].map(([val, label]) =>
    h('button', { class: 'seg', type: 'button', disabled: !isHost, onclick: () => doAct('config', { spice: val }) }, label));
  cfgEl.append(h('div', { class: 'cfg-row' }, h('span', { class: 'cfg-ico' }, '\u{1F336}\uFE0F'), h('span', { class: 'cfg-name' }, 'Questions'),
    h('span', { class: 'segs' }, spiceBtns)));
  const el = h('section', { class: 'lobby' },
    h('div', { class: 'codeblock' }, h('span', { class: 'lbl' }, 'Room code'), h('div', { class: 'bigcode' }, [...v.code].map((c, i) => h('span', { class: 'tile', style: { '--i': i } }, c))),
      h('button', { class: 'btn', type: 'button', onclick: () => share(S.view.code) }, 'Share invite link')),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Players'), count), plist),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Roles'), h('span', { class: 'muted' }, 'rest are civilians')), cfgEl),
    err,
    isHost ? start : h('p', { class: 'muted center-t' }, 'Waiting for the host to start...'));
  return {
    el,
    update(v) {
      setText(count, `${v.players.length} / ${MAX_PLAYERS}`);
      sync(plist, v.players, (p) => p.id,
        (p) => h('div', { class: 'prow' }, avatar(p.name, p.id), h('span', { class: 'pname' }), h('span', { class: 'tag crown' }, '♛ host'),
          h('span', { class: 'tag you' }, 'you'), h('button', { class: 'ghost sm rm', type: 'button', 'aria-label': 'Remove player', onclick: () => doAct('kick', p.id) }, 'Kick')),
        (row, p) => {
          setText(row.querySelector('.pname'), p.name);
          row.querySelector('.crown').hidden = !p.isHost;
          row.querySelector('.you').hidden = p.id !== v.you.id;
          row.querySelector('.rm').hidden = !(v.you.isHost && p.id !== v.you.id);
        });
      const n = v.players.length;
      for (const [k] of defs) {
        const c = v.config;
        const r = rows[k];
        setText(r.val, String(c[k]));
        r.minus.disabled = c[k] <= (k === 'mafia' ? 1 : 0);
        r.plus.disabled = configError({ ...c, [k]: c[k] + 1 }, n) !== null || c[k] >= MAX_PLAYERS;
      }
      spiceBtns.forEach((b, i) => b.classList.toggle('on', v.config.spice === ['pg', 'pg13'][i]));
      setText(err, v.startError || '');
      err.hidden = !v.startError;
      start.disabled = !!v.startError;
    },
  };
}

function roles(v) {
  const r = ROLE[v.you.role];
  const mates = h('div', { class: 'mates' });
  // The role hides itself again so a phone left on the table never shows it.
  let hideT = 0;
  const flip = (show) => {
    clearTimeout(hideT);
    card.classList.toggle('flipped', show);
    if (show) hideT = setTimeout(() => card.classList.remove('flipped'), 5000);
  };
  const card = h('button', { class: 'rolecard', type: 'button', 'aria-label': 'Reveal role', onclick: () => flip(!card.classList.contains('flipped')) },
    h('span', { class: 'flipper' },
      h('span', { class: 'face front' }, h('span', { class: 'sigil' }, h('i', { class: 'fan' }), h('i', { class: 'mini-hat' })), h('span', { class: 'hint' }, 'Tap to reveal your role')),
      h('span', { class: 'face back r-' + v.you.role }, h('span', { class: 'corner tl' }, r.label[0]), h('span', { class: 'corner br' }, r.label[0]),
        h('span', { class: 'ico' }, r.icon), h('span', { class: 'rname' }, r.label), h('span', { class: 'blurb' }, r.blurb), mates)));
  const btn = h('button', { class: 'btn primary', type: 'button', onclick: () => { flip(false); doAct('ready'); } }, "I'm ready");
  const cnt = counter('Ready');
  const ros = roster('Players', (v) => v.readyIds);
  const el = h('section', { class: 'roles' }, h('h2', {}, 'Your role'), card, btn, cnt.el, ros.el);
  return {
    el,
    update(v) {
      const me = v.readyIds.includes(v.you.id);
      btn.disabled = me;
      setText(btn, me ? 'Ready. Waiting for others...' : "I'm ready");
      cnt.set(v.readyIds.length, v.players.filter((p) => p.alive).length);
      if (v.team) {
        mates.hidden = false;
        mates.replaceChildren(h('span', { class: 'mates-l' }, v.team.length ? (v.you.role === 'mafia' ? 'Your crew' : 'Your team') : 'You work alone'), ...v.team.map((t) => h('span', { class: 'chip' }, t.name)));
      } else mates.hidden = true;
      ros.update(v);
    },
  };
}

// Every night screen shares one neutral layout: prompt, player list, "Lock in".
// Only the prompt text differs, so no phone looks different across the table.
const NIGHT_PROMPT = {
  mafia: 'Who do you want to eliminate?',
  doctor: 'Who do you want to save?',
  detective: 'Who do you want to investigate?',
};

function night(v) {
  const mode = !v.you.alive ? 'dead' : v.locked ? 'wait' : 'act';
  const cnt = counter('Locked in');
  const ros = roster('Players', null, { onlyIfOffline: true });
  const ups = [(v) => cnt.set(v.count.done, v.count.total), (v) => ros.update(v)];
  const parts = [];

  if (mode === 'act') {
    const grid = targetGrid({
      onPick: (id) => doAct('select', id),
      chipsOf: (v, tid) => (v.teamSel || []).filter((x) => x.targetId === tid)
        .map((x) => ({ id: x.id, label: x.id === v.you.id ? 'You' : x.name, locked: x.locked })),
    });
    const lock = h('button', { class: 'btn primary lockbtn', type: 'button', onclick: () => S.view.mySel && doAct('lock') }, 'Lock in');
    const prompt = h('h2', {});
    parts.push(h('div', { class: 'ttl' }, prompt, h('p', { class: 'muted' }, 'Choose one player.')), grid.el, lock);
    ups.push((v) => {
      setText(prompt, v.question || NIGHT_PROMPT[v.action]);
      grid.update(v, v.mySel, true);
      lock.disabled = !v.mySel;
      lock.classList.toggle('ready', !!v.mySel);
    });
  } else {
    const dead = mode === 'dead';
    parts.push(h('div', { class: 'ttl wait' }, dead ? h('div', { class: 'big-icon' }, '\u{1F47B}')
        : h('div', { class: 'watch', 'aria-hidden': 'true' }, h('i', { class: 'wcrown' }), h('i', { class: 'wring' }),
          h('div', { class: 'wface' }, h('i', { class: 'hand hh' }), h('i', { class: 'hand mm' }), h('i', { class: 'hand ss' }), h('i', { class: 'pin' }))),
      h('h2', {}, dead ? 'You are out' : 'Waiting for others...'),
      h('p', { class: 'muted' }, dead ? 'Watching the night from beyond.' : 'Your choice is locked.')));
  }

  // detectives: the team's result and case file, even on the waiting / spectator screens
  if (v.log) {
    const box = h('div', { class: 'card result' });
    const hist = h('div', { class: 'card hist' });
    parts.push(box, hist);
    ups.push((v) => {
      const last = v.log[v.log.length - 1];
      const fresh = v.choice && last && last.round === v.round;
      box.hidden = !fresh;
      if (fresh) {
        box.replaceChildren(h('p', { class: 'muted' }, 'Investigation result'), h('b', { class: 'big-name' }, last.name),
          h('p', { class: 'det-line ' + (last.isMafia ? 'yes' : 'no') }, last.isMafia ? 'is Mafia' : 'is not Mafia'));
      }
      hist.hidden = !v.log.length;
      hist.replaceChildren(h('h3', {}, 'Case file'), ...v.log.map((e) => h('div', { class: 'hrow' }, h('span', { class: 'muted' }, 'Night ' + e.round),
        h('span', { class: 'hname' }, e.name), h('span', { class: 'tag ' + (e.isMafia ? 'yes' : 'no') }, e.isMafia ? 'Mafia' : 'Not Mafia'))));
    });
  }
  parts.push(cnt.el, ros.el);
  return { el: h('section', { class: 'night' }, parts), update: (v) => ups.forEach((f) => f(v)) };
}

function dawn(v) {
  const e = v.event;
  buzz(e.killedId ? [80, 60, 80] : [40]);
  const head = e.killedId
    ? h('h1', { class: 'headline dawn-name' }, h('span', { class: 'hn' }, e.killedName), ' found dead')
    : h('h1', { class: 'headline dawn-none' }, 'Quiet night \u2014 all survive');
  const paper = h('article', { class: 'paper news' },
    h('div', { class: 'masthead' }, h('span', { class: 'mast-rule' }), h('b', {}, 'The Daily Whisper'), h('span', { class: 'mast-rule' })),
    h('div', { class: 'dateline' }, h('span', {}, 'Late Edition'), h('span', {}, 'Night ' + v.round), h('span', {}, 'Price: one secret')),
    h('p', { class: 'extra' }, 'Extra!'), head,
    h('p', { class: 'deck' }, e.killedId ? 'Police baffled. Neighbours saw nothing, as usual.' : 'Not a shot fired. The city holds its breath.'),
    h('div', { class: 'cols', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
  return {
    el: h('section', { class: 'dawn center' }, h('div', { class: 'blinds', 'aria-hidden': 'true' }), paper,
      e.killedId === v.you.id && h('p', { class: 'note-t' }, 'That was you. You can still watch.'),
      h('div', { class: 'progress', style: { '--dur': DAWN_MS + 'ms' } }, h('i')), h('p', { class: 'note-t' }, 'Discussion begins shortly...')),
    update() {},
  };
}

function vote(v) {
  const mode = !v.you.alive ? 'dead' : v.locked ? 'locked' : 'act';
  const cnt = counter('Voted');
  const ros = roster('Votes cast', (v) => v.votedIds);
  const ups = [(v) => cnt.set(v.count.done, v.count.total), (v) => ros.update(v)];
  const parts = [];
  if (mode === 'act') {
    const grid = targetGrid({ withSkip: true, onPick(id) { S.sel = id; cur.update(S.view); } });
    const lock = h('button', { class: 'btn primary lockbtn', type: 'button', onclick: () => S.sel && doAct('vote', S.sel) }, 'Lock vote');
    parts.push(h('div', { class: 'ttl' }, h('h2', {}, 'Who is the mafia?'), h('p', { class: 'muted' }, 'Discuss, then vote. Votes are final.')), grid.el, lock);
    ups.push((v) => {
      if (S.sel && S.sel !== 'skip' && !v.targets.includes(S.sel)) S.sel = null;
      grid.update(v, S.sel, true);
      lock.disabled = !S.sel;
      lock.classList.toggle('ready', !!S.sel);
    });
  } else if (mode === 'locked') {
    const who = h('b', { class: 'big-name' });
    parts.push(h('div', { class: 'ttl' }, h('div', { class: 'seal', 'aria-hidden': 'true' }, h('i', {}, '★')), h('h2', {}, 'Vote locked'), h('p', { class: 'muted' }, 'Waiting for the others...')), h('div', { class: 'card result' }, who));
    ups.push((v) => setText(who, v.myVote === 'skip' ? 'You skipped' : nm(v, v.myVote)));
  } else {
    parts.push(h('div', { class: 'ttl wait' }, h('div', { class: 'big-icon' }, '\u{1F47B}'), h('h2', {}, 'You are out'), h('p', { class: 'muted' }, 'You can watch, but not vote.')));
  }
  parts.push(cnt.el, ros.el);
  return { el: h('section', { class: 'vote' }, parts), update: (v) => ups.forEach((f) => f(v)) };
}

function verdict(v) {
  buzz([120, 80, 120]);
  const e = v.event;
  const max = Math.max(1, ...e.tally.map((t) => t.voters.length));
  const rows = e.tally.map((t, i) => h('div', { class: 'trow' + (t.key === e.eliminatedId ? ' out' : ''), style: { '--i': i } },
    h('div', { class: 'thead' }, h('span', { class: 'tn' }, t.name), h('b', {}, String(t.voters.length))),
    h('div', { class: 'tbar' }, h('i', { style: { '--w': (t.voters.length / max) * 100 + '%' } })),
    h('div', { class: 'voters' }, t.voters.map((n, j) => h('span', { class: 'chip', style: { '--j': j } }, n)))));
  const delay = e.tally.length * 0.18 + 1.1;
  return {
    el: h('section', { class: 'verdict', style: { '--delay': delay + 's' } }, h('h2', {}, 'The votes'), h('div', { class: 'tally' }, rows),
      h('div', { class: 'result-line ' + (e.eliminatedId ? 'bad' : 'good') },
        e.eliminatedId ? [h('b', { class: 'vname' }, e.eliminatedName), h('span', { class: 'stamp' }, 'Voted out'), h('span', { class: 'sr' }, ' was voted out')]
          : [h('span', { class: 'stamp none' }, 'No verdict'), h('span', { class: 'sr' }, 'No one was voted out')]),
      h('div', { class: 'progress', style: { '--dur': VERDICT_MS + 'ms' } }, h('i'))),
    update() {},
  };
}

function over(v) {
  const w = WINNER[v.winner];
  const mine = v.winner === 'jester' ? v.winnerIds.includes(v.you.id)
    : v.winner === 'mafia' ? v.you.role === 'mafia' : v.you.role !== 'mafia' && v.you.role !== 'jester';
  const roleOf = Object.fromEntries(v.roles.map((r) => [r.id, r.role]));
  const confetti = Array.from({ length: 36 }, (_, i) => h('i', { style: { '--x': Math.random() * 100 + '%', '--d': Math.random() * 3 + 's', '--t': 3 + Math.random() * 3 + 's', '--r': Math.random() * 720 - 360 + 'deg', '--k': i % 2 } }));
  const plist = h('div', { class: 'plist' });
  const again = h('button', { class: 'btn primary', type: 'button', onclick: () => doAct('again') }, 'Play again');
  return {
    el: h('section', { class: 'over c-' + w.color }, h('div', { class: 'confetti', 'aria-hidden': 'true' }, confetti),
      h('article', { class: 'paper news front' },
        h('div', { class: 'masthead' }, h('span', { class: 'mast-rule' }), h('b', {}, 'The Daily Whisper'), h('span', { class: 'mast-rule' })),
        h('div', { class: 'dateline' }, h('span', {}, 'Final Edition'), h('span', {}, mine ? 'Victory' : 'Defeat'), h('span', {}, 'Price: one secret')),
        h('p', { class: 'extra' }, 'Extra! Extra!'),
        h('h1', { class: 'headline win-title' }, w.head, h('span', { class: 'sr' }, ' ' + w.title)),
        h('p', { class: 'deck' }, w.sub), h('div', { class: 'cols', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))),
      h('div', { class: 'card lineup' }, h('h3', {}, 'The Usual Suspects'), plist),
      v.funLog.length > 0 && h('h3', { class: 'sec' }, 'Gossip Column'),
      v.funLog.map((e) => h('div', { class: 'card qcard' },
        h('p', { class: 'muted' }, 'Night ' + e.round), h('p', { class: 'qtext' }, e.question),
        h('p', { class: 'qwin' }, e.winners.length ? '🏆 ' + e.winners.join(', ') : 'No answers'),
        h('div', { class: 'qpicks' }, e.picks.map((x, i) => h('span', { class: 'qpick', style: { '--j': i } }, x.from, ' → ', x.to))))),
      v.you.isHost ? again : h('p', { class: 'muted center-t' }, 'Waiting for the host to play again...')),
    update(v) {
      sync(plist, v.players, (p) => p.id,
        (p) => h('div', { class: 'prow' }, h('span', { class: 'plate' }), avatar(p.name, p.id), h('span', { class: 'pname' }), h('span', { class: 'badge off' }, 'offline'), h('span', { class: 'rtag' })),
        (row, p) => {
          const r = roleOf[p.id];
          setText(row.querySelector('.plate'), String(v.players.indexOf(p) + 1));
          setText(row.querySelector('.pname'), p.name + (p.id === v.you.id ? ' (you)' : '') + (p.alive ? '' : ' †'));
          row.classList.toggle('dead', !p.alive);
          row.classList.toggle('win', v.winnerIds.includes(p.id));
          row.querySelector('.badge').hidden = p.connected;
          const t = row.querySelector('.rtag');
          setText(t, ROLE[r].icon + ' ' + ROLE[r].label);
          t.className = 'rtag r-' + r;
        });
    },
  };
}

/* ------------------------------ boot ------------------------------ */

// Never resume silently: ask first, and "Start new" wipes the saved game.
function askResume(room, go) {
  S.mode = 'resume';
  S.pending = { room, at: Number(store.get('mafia-at')) || 0, go };
  render();
}

function resumeScreen() {
  const { room, at, go } = S.pending;
  const mins = Math.round((Date.now() - at) / 60000);
  const ago = !at ? '' : mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  const when = at ? `Saved ${new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (${ago})` : 'Saved earlier';
  return {
    el: h('section', { class: 'center' }, h('div', { class: 'big-icon' }, '\u{1F570}\uFE0F'), h('h2', {}, 'Unfinished game'),
      h('p', { class: 'muted' }, `Room ${room}`), h('p', { class: 'muted' }, when),
      h('button', { class: 'btn primary', type: 'button', onclick: () => { S.pending = null; go(); } }, 'Resume game'),
      h('button', { class: 'btn', type: 'button', onclick: () => { S.pending = null; goHome(); } }, 'Start new')),
    update() {},
  };
}

function boot() {
  const session = store.json('mafia-session');
  // No ?room= (reopened from home screen / history): resume the saved game anyway.
  const room = normCode(new URLSearchParams(location.search).get('room')) || normCode(session?.room);
  if (room && session && session.room === room && typeof session.token === 'string') {
    const saved = store.unseal('mafia-host-' + room);
    if (session.host && saved && saved.code === room && saved.players?.some((p) => p.isHost && p.token === session.token)) {
      return askResume(room, () => resumeHost(saved, session));
    }
    if (!session.host) return askResume(room, () => joinRoomAs(room, session.name));
  }
  render();
}
boot();
