// Trystero wrapper: host and client message plumbing.
import { joinRoom } from 'trystero';
import { addPlayer, applyAction, removePlayer, viewFor } from './game.js';

// ponytail: add a TURN server if players on mobile data can't connect, e.g.
// { urls: ['turn:host:3478'], username: 'u', credential: 'p' }
export const TURN_SERVERS = [];

const APP_ID = 'mafia-phone-p2p-v1';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const JOIN_TIMEOUT_MS = 12000;

export const genCode = () => {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(b, (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
};
export const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
export const validCode = (s) => s.length === 4 && [...s].every((c) => CODE_CHARS.includes(c));

function open(code) {
  const cfg = { appId: APP_ID };
  if (TURN_SERVERS.length) cfg.turnConfig = TURN_SERVERS;
  const room = joinRoom(cfg, code);
  return {
    room,
    hello: room.makeAction('hello'),
    act: room.makeAction('act'),
    view: room.makeAction('view'),
    err: room.makeAction('err'),
  };
}
const quiet = (p) => p && p.catch && p.catch(() => {});
// The hashed bundle URL changes with every deploy, so it doubles as a build id.
export const BUILD = new URL(import.meta.url).pathname;

/* ------------------------------ host ------------------------------ */

// state: the authoritative game state. onChange(state) runs after every change
// (persist, timers, render own view). Returns { act, changed, leave }.
export function hostRoom(state, onChange) {
  const { room, hello, act, view, err } = open(state.code);
  const peers = new Map(); // peerId -> playerId

  const peerOf = (pid) => [...peers].find(([, v]) => v === pid)?.[0];
  const sendView = (pid) => {
    const peer = peerOf(pid);
    const p = state.players.find((q) => q.id === pid);
    if (peer && p && !p.isHost) quiet(view.send({ ...viewFor(state, pid), build: BUILD }, { target: peer }));
  };
  const changed = () => {
    state.players.forEach((p) => sendView(p.id));
    onChange(state);
  };
  const hostPlayer = () => state.players.find((p) => p.isHost);

  hello.onMessage = (data, { peerId }) => {
    const reply = (msg) => quiet(err.send({ msg }, { target: peerId }));
    if (!data || typeof data.token !== 'string') return;
    const known = state.players.find((p) => p.token === data.token);
    if (known) {
      if (known.isHost) return; // host's own token arriving from a peer: ignore
      for (const [k, v] of peers) if (v === known.id) peers.delete(k);
      peers.set(peerId, known.id);
      known.connected = true;
      return changed();
    }
    if (state.phase !== 'lobby') return reply('Game already in progress');
    const r = addPlayer(state, { name: data.name, token: data.token });
    if (r.error) return reply(r.error);
    peers.set(peerId, r.player.id);
    changed();
  };

  const run = (pid, action) => {
    const kicked = action.kind === 'kick' ? peerOf(action.target) : null;
    const e = applyAction(state, pid, action);
    if (e) return e;
    if (kicked) {
      peers.delete(kicked);
      quiet(err.send({ msg: 'Removed by host' }, { target: kicked }));
    }
    changed();
    return null;
  };

  act.onMessage = (data, { peerId }) => {
    const pid = peers.get(peerId);
    if (!pid) return quiet(err.send({ msg: 'Not in this game' }, { target: peerId }));
    const e = data && typeof data === 'object' ? run(pid, { kind: data.kind, target: data.target }) : 'Bad action';
    if (e) quiet(err.send({ msg: e }, { target: peerId }));
  };

  room.onPeerLeave = (peerId) => {
    const pid = peers.get(peerId);
    if (!pid) return;
    peers.delete(peerId);
    if (state.phase === 'lobby') removePlayer(state, pid);
    else {
      const p = state.players.find((q) => q.id === pid);
      if (p) p.connected = false;
    }
    changed();
  };

  // Our own actions go straight to the engine (no network round-trip).
  return {
    act: (action) => run(hostPlayer().id, action),
    changed,
    leave: () => room.leave(),
  };
}

/* ----------------------------- client ----------------------------- */

// handlers: onView(view), onErr(msg), onTimeout(), onHostLost()
export function joinClient(code, { name, token }, handlers) {
  const { room, hello, act, view, err } = open(code);
  let hostPeer = null;
  let timer = setTimeout(() => handlers.onTimeout(), JOIN_TIMEOUT_MS);
  const hi = (target) => quiet(hello.send({ name, token }, target ? { target } : undefined));

  room.onPeerJoin = (peerId) => hi(peerId);
  room.onPeerLeave = (peerId) => {
    if (peerId === hostPeer) {
      hostPeer = null;
      handlers.onHostLost();
    }
  };
  view.onMessage = (v, { peerId }) => {
    if (hostPeer && peerId !== hostPeer) return;
    hostPeer = peerId;
    clearTimeout(timer);
    handlers.onView(v);
  };
  err.onMessage = (e, { peerId }) => {
    if (hostPeer && peerId !== hostPeer) return;
    clearTimeout(timer);
    handlers.onErr(e && typeof e.msg === 'string' ? e.msg : 'Error');
  };

  return {
    send: (kind, target) => hostPeer && quiet(act.send({ kind, target }, { target: hostPeer })),
    rehello: () => hi(), // after phone sleep: host rebinds our token and re-sends the view
    leave: () => { clearTimeout(timer); room.leave(); },
  };
}
