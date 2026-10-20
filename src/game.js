// Pure game logic: no DOM, no network. Runs under Node.
export const MAX_PLAYERS = 20;
export const MIN_PLAYERS = 3;
export const MAX_NAME = 16;
export const DEFAULT_CONFIG = { mafia: 1, doctor: 1, detective: 1, jester: 0, spice: 'pg', narrator: false };
const COUNT_KEYS = ['mafia', 'doctor', 'detective', 'jester'];
export const SPICES = ['pg', 'pg13'];
const TEAM_ROLES = ['mafia', 'doctor', 'detective'];
// Who answers the night's decoy question: living civilians/jesters, plus everyone who is out
// (the dead get something to do; their answers never hold up the night).
const asksQuestion = (p) => !!p.role && (!p.alive || !TEAM_ROLES.includes(p.role));
const freshNight = () => ({ selections: {}, locked: {}, choice: {}, acked: {}, question: null });
// A player is done for the night once locked; detectives also have to acknowledge their result,
// otherwise the night could resolve before they ever see it.
const nightDone = (n, p) => n.locked[p.id] && (p.role !== 'detective' || n.acked?.[p.id]);

// Decoy questions for civilians and jesters, so every phone looks the same at night.
export const QUESTIONS = [
  'Who do you secretly not like the most?',
  'Who would survive a zombie apocalypse?',
  'Who would forget their own birthday?',
  "Who's most likely to get arrested on holiday?",
  'Who gives the worst advice?',
  'Who would cry at a wedding that is not theirs?',
  'Who takes the longest to reply to a text?',
  'Who would get lost in their own neighbourhood?',
  'Who would win a hot dog eating contest?',
  'Who is secretly the group\'s drama magnet?',
  'Who would lose a staring contest to a goldfish?',
  'Who would talk their way out of a speeding ticket?',
  'Who has the most questionable music taste?',
  'Who would be the first to snitch under pressure?',
  'Who would adopt 12 cats?',
  'Who tells the worst jokes?',
  'Who would fall asleep during an action movie?',
  'Who would accidentally join a cult?',
  'Who is the worst at keeping secrets?',
  'Who would be a terrible getaway driver?',
  'Who would show up late to their own surprise party?',
  'Who would eat the last slice without asking?',
  'Who would become famous for the wrong reason?',
  'Who is most likely to text the wrong person?',
  'Who would argue with a parking sign?',
  'Who would cheat at a board game?',
  'Who has the most chaotic search history?',
  'Who would get stuck in a revolving door?',
  'Who would bring a salad to a barbecue?',
  'Who would be the worst roommate?',
];

export const createGame = (code) => ({
  code, phase: 'lobby', round: 0,
  config: { ...DEFAULT_CONFIG },
  players: [], ready: {}, night: freshNight(), saveStreak: null, votes: {},
  lastEvent: null, detectiveLog: [], funLog: [], nextQuestion: null, usedQuestions: [], winner: null, winnerIds: [], seq: 0,
});

const byId = (s, id) => s.players.find((p) => p.id === id);
const alive = (s) => s.players.filter((p) => p.alive && p.role); // role-less narrator never counts
// Narrator mode: the host runs the table and gets no role.
export const inPlay = (s) => (s.config.narrator ? s.players.filter((p) => !p.isHost) : s.players);

// strip control / bidi / zero-width chars, collapse whitespace
export const cleanName = (raw) =>
  String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/* ---------- lobby ---------- */

export function addPlayer(state, { name, token, isHost = false }) {
  if (state.phase !== 'lobby') return { error: 'Game already in progress' };
  if (state.players.length >= MAX_PLAYERS) return { error: 'Room is full' };
  if (typeof token !== 'string' || !token || token.length > 80) return { error: 'Bad session' };
  const n = cleanName(name);
  if (!n) return { error: 'Enter a name' };
  if ([...n].length > MAX_NAME) return { error: `Name too long (max ${MAX_NAME})` };
  if (state.players.some((p) => p.name.toLowerCase() === n.toLowerCase())) return { error: 'Name already taken' };
  const player = {
    id: 'p' + ++state.seq, token, name: n, role: null,
    alive: true, connected: true, isHost,
  };
  state.players.push(player);
  return { player };
}

// Lobby / game over: the seat just goes. Mid-game: a silent death (no event, no role reveal);
// they can rejoin with the code and watch as a ghost.
export function removePlayer(state, id) {
  const p = byId(state, id);
  if (!p) return;
  if (state.phase === 'lobby' || state.phase === 'over') {
    state.players = state.players.filter((q) => q.id !== id);
    return;
  }
  p.connected = false;
  if (!p.alive) return;
  p.alive = false;
  if (state.phase === 'verdict') winCheck(state); // the winner is shown after the verdict
  else if (state.phase === 'dawn' || state.phase === 'narrate') { if (winCheck(state)) state.phase = 'over'; }
  else settle(state, Math.random, true);
}

export function setConfig(state, cfg) {
  if (state.phase !== 'lobby') return 'Game already started';
  if (!cfg || typeof cfg !== 'object') return 'Bad config';
  const next = { ...state.config };
  for (const k of COUNT_KEYS) {
    if (cfg[k] === undefined) continue;
    if (!Number.isInteger(cfg[k]) || cfg[k] < 0 || cfg[k] > MAX_PLAYERS) return 'Bad config';
    next[k] = cfg[k];
  }
  if (cfg.narrator !== undefined) {
    if (typeof cfg.narrator !== 'boolean') return 'Bad config';
    next.narrator = cfg.narrator;
  }
  if (cfg.spice !== undefined) {
    if (!SPICES.includes(cfg.spice)) return 'Bad config';
    next.spice = cfg.spice;
  }
  state.config = next;
  return null;
}

// Rules that depend only on config + player count (used by the steppers too).
export function configError(config, n) {
  const { mafia, doctor, detective, jester } = config;
  if ([mafia, doctor, detective, jester].some((x) => !Number.isInteger(x) || x < 0)) return 'Invalid role counts';
  if (mafia < 1) return 'Need at least 1 mafia';
  const need = mafia + doctor + detective + jester;
  if (need > n) return `Not enough players for these roles (need ${need}, have ${n})`;
  if (!(mafia < n - mafia)) return `Too many mafia for ${n} players`;
  return null;
}

export function validateStart(state) {
  const n = inPlay(state).length;
  if (n < MIN_PLAYERS) return `Need at least ${MIN_PLAYERS} players (have ${n})`;
  return configError(state.config, n);
}

function resetRun(state) {
  state.round = 0;
  state.ready = {};
  state.night = freshNight();
  state.saveStreak = null;
  state.votes = {};
  state.lastEvent = null;
  state.detectiveLog = [];
  state.funLog = [];
  state.nextQuestion = null;
  state.usedQuestions = [];
  state.winner = null;
  state.winnerIds = [];
  for (const p of state.players) { p.alive = true; p.role = null; p.out = null; }
}

export function startGame(state, rng = Math.random) {
  if (state.phase !== 'lobby') return 'Game already started';
  const err = validateStart(state);
  if (err) return err;
  resetRun(state);
  const { mafia, doctor, detective, jester } = state.config;
  const roles = [
    ...Array(mafia).fill('mafia'), ...Array(doctor).fill('doctor'),
    ...Array(detective).fill('detective'), ...Array(jester).fill('jester'),
  ];
  const seats = inPlay(state);
  while (roles.length < seats.length) roles.push('civilian');
  for (let i = roles.length - 1; i > 0; i--) { // Fisher-Yates
    const j = Math.floor(rng() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  seats.forEach((p, i) => { p.role = roles[i]; });
  state.round = 1;
  state.phase = 'roles';
  return null;
}

export function playAgain(state) {
  if (state.phase !== 'over') return 'Game is not over';
  return newGame(state);
}

// Back to the lobby from any phase (narrator mode: the game may have finished offline).
export function newGame(state) {
  if (state.phase === 'lobby') return 'Already in the lobby';
  state.players = state.players.filter((p) => p.connected || p.isHost);
  resetRun(state);
  state.phase = 'lobby';
  return null;
}

/* ---------- win check & resolution ---------- */

// Returns true (and records the winner) if the game is over.
function winCheck(state, votedOutId = null) {
  const out = votedOutId && byId(state, votedOutId);
  if (out && out.role === 'jester') {
    state.winner = 'jester';
    state.winnerIds = [out.id];
    return true;
  }
  const a = alive(state);
  const m = a.filter((p) => p.role === 'mafia').length;
  if (m === 0) { state.winner = 'town'; return true; }
  if (m >= a.length - m) { state.winner = 'mafia'; return true; }
  return false;
}

const isUsed = (state, q) => state.usedQuestions.some((u) => u.id === q.id || u.text === q.text);

// Host's background fetch lands here. Returns an error string (e.g. 'Already used') or null.
export function setNextQuestion(state, q) {
  const text = typeof q?.text === 'string' ? q.text.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > 200 || q.id == null) return 'Bad question';
  const next = { id: 'api:' + String(q.id).slice(0, 60), text };
  if (isUsed(state, next)) return 'Already used';
  state.nextQuestion = next;
  return null;
}

// New night: clear picks and pick the decoy question. Uses the prefetched one if any,
// else an unused built-in (random), else (everything used) allows a repeat. Never waits on the network.
function beginNight(state, rng) {
  state.night = freshNight();
  let q = state.nextQuestion && !isUsed(state, state.nextQuestion) ? state.nextQuestion : null;
  state.nextQuestion = null;
  if (!q) {
    const all = QUESTIONS.map((text, i) => ({ id: 'b' + i, text }));
    const pool = all.filter((c) => !isUsed(state, c));
    const from = pool.length ? pool : all;
    q = from[Math.floor(rng() * from.length)];
  }
  state.usedQuestions.push(q);
  state.night.question = q.text;
  if (state.players.some(asksQuestion)) {
    state.funLog.push({ round: state.round, question: q.text, answers: {} });
  }
}

// Plurality of a list of ids; ties broken by rng in stable player order.
function plurality(state, ids, rng) {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  const top = Math.max(...counts.values());
  const tied = state.players.map((p) => p.id).filter((id) => counts.get(id) === top);
  return tied.length > 1 ? tied[Math.floor(rng() * tied.length)] : tied[0];
}

// A team's choice exists once all of its living members have locked.
function resolveTeam(state, role, rng) {
  const n = state.night;
  const members = alive(state).filter((p) => p.role === role);
  if (!members.length || n.choice[role] || !members.every((p) => n.locked[p.id])) return;
  n.choice[role] = plurality(state, members.map((p) => n.selections[p.id]), rng);
  if (role === 'detective') {
    state.detectiveLog.push({ round: state.round, targetId: n.choice[role], isMafia: byId(state, n.choice[role]).role === 'mafia' });
  }
}

function resolveNight(state) {
  const { mafia: target, doctor } = state.night.choice;
  const t = target && byId(state, target);
  const victim = t && t.alive && doctor !== target ? t : null;
  if (victim) victim.alive = false;
  state.lastEvent = { type: 'night', killedId: victim ? victim.id : null };
  const ss = state.saveStreak;
  state.saveStreak = !doctor ? null : { targetId: doctor, count: ss && ss.targetId === doctor ? ss.count + 1 : 1 };
  state.phase = winCheck(state) ? 'over' : 'dawn';
}

function tallyVotes(state) {
  const a = alive(state);
  const tally = {};
  const counts = {};
  for (const p of a) {
    const t = state.votes[p.id];
    if (t === 'skip' || a.some((q) => q.id === t)) {
      (tally[t] ||= []).push(p.name);
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  const ids = Object.keys(counts).filter((k) => k !== 'skip');
  const top = Math.max(0, ...ids.map((k) => counts[k]));
  const leaders = ids.filter((k) => counts[k] === top);
  const eliminatedId = leaders.length === 1 && top > (counts.skip || 0) ? leaders[0] : null;
  if (eliminatedId) byId(state, eliminatedId).alive = false;
  state.lastEvent = { type: 'vote', eliminatedId, tally };
  winCheck(state, eliminatedId); // sets state.winner if over; shown after the verdict
  state.phase = 'verdict';
}

// Move a phase forward if everything it was waiting on is done.
function settle(state, rng, byRemoval = false) {
  if (!['roles', 'night', 'vote'].includes(state.phase)) return;
  if (byRemoval && winCheck(state)) { state.phase = 'over'; return; }
  if (state.phase === 'roles') {
    if (alive(state).every((p) => state.ready[p.id])) {
      if (state.config.narrator) state.phase = 'narrate'; // the narrator runs the rest offline
      else { state.phase = 'night'; beginNight(state, rng); }
    }
  } else if (state.phase === 'night') {
    TEAM_ROLES.forEach((role) => resolveTeam(state, role, rng));
    if (alive(state).every((p) => nightDone(state.night, p))) resolveNight(state);
  } else if (alive(state).every((p) => state.votes[p.id])) {
    tallyVotes(state);
  }
}

// Called by the host's timers for dawn / verdict. Returns true if it advanced.
export function advance(state, rng = Math.random) {
  if (state.phase === 'dawn') {
    state.phase = 'vote';
    state.votes = {};
    return true;
  }
  if (state.phase === 'verdict') {
    if (state.winner) state.phase = 'over';
    else { state.round++; state.phase = 'night'; beginNight(state, rng); }
    return true;
  }
  return false;
}

/* ---------- actions ---------- */

// The doctors' previous target is blocked once they saved the same player 2 nights running.
export const blockedTarget = (state) =>
  state.saveStreak && state.saveStreak.count >= 2 ? state.saveStreak.targetId : null;

export function nightTargets(state, me) {
  const a = alive(state);
  if (asksQuestion(me)) return state.players.filter((p) => p.role); // decoy question: anyone at the table, yourself included
  if (me.role === 'mafia') return a; // mafia may hit a teammate, or themselves
  if (me.role === 'doctor') return a.filter((p) => p.id !== blockedTarget(state));
  return a.filter((p) => p.role !== 'detective');
}

// Returns an error string, or null on success. State is mutated in place.
export function applyAction(state, playerId, action, rng = Math.random) {
  const me = byId(state, playerId);
  if (!me) return 'Unknown player';
  const { kind, target } = action || {};
  const hostOnly = () => (me.isHost ? null : 'Only the host can do that');

  switch (kind) {
    case 'config':
      return hostOnly() || setConfig(state, target);
    case 'start':
      return hostOnly() || startGame(state, rng);
    case 'again':
      return hostOnly() || playAgain(state);
    case 'newgame':
      return hostOnly() || newGame(state);
    case 'mark': { // narrator records what happened at the table: { id, how: 'killed' | 'voted' | 'alive' }
      const e = hostOnly();
      if (e) return e;
      if (state.phase !== 'narrate') return 'Wrong phase';
      const t = byId(state, target?.id);
      if (!t || !t.role) return 'Invalid player';
      if (!['killed', 'voted', 'alive'].includes(target.how)) return 'Invalid mark';
      t.alive = target.how === 'alive';
      t.out = t.alive ? null : target.how;
      if (winCheck(state, target.how === 'voted' ? t.id : null)) state.phase = 'over';
      return null;
    }
    case 'kick': { // host menu, any phase: e.g. someone went AFK
      const e = hostOnly();
      if (e) return e;
      const t = byId(state, target);
      if (!t || t.isHost) return 'Invalid player';
      removePlayer(state, t.id);
      return null;
    }
    case 'ready':
      if (state.phase !== 'roles') return 'Wrong phase';
      if (!me.role) return 'The narrator does not play';
      if (!me.alive) return 'You are out';
      if (state.ready[me.id]) return 'Already ready';
      state.ready[me.id] = true;
      break;
    case 'select':
    case 'lock': {
      if (state.phase !== 'night') return 'Wrong phase';
      if (!me.role) return 'The narrator does not play';
      const n = state.night;
      if (n.locked[me.id]) return 'Already locked';
      if (kind === 'select') {
        if (typeof target !== 'string') return 'Invalid target';
        if (me.role === 'doctor' && target === blockedTarget(state) && byId(state, target)?.alive) return 'Saved 2 nights in a row';
        if (!nightTargets(state, me).some((p) => p.id === target)) return 'Invalid target';
        if (n.selections[me.id] === target) delete n.selections[me.id]; // tap again clears
        else n.selections[me.id] = target;
        return null; // selecting never resolves anything: only locks do
      }
      if (!n.selections[me.id]) return 'Select a target first';
      n.locked[me.id] = true;
      if (asksQuestion(me)) {
        const entry = state.funLog.find((e) => e.round === state.round);
        if (entry) entry.answers[me.id] = n.selections[me.id];
      }
      break;
    }
    case 'ack': {
      const n = state.night;
      if (state.phase !== 'night') return 'Wrong phase';
      if (!me.alive) return 'You are dead';
      if (me.role !== 'detective') return 'Nothing to acknowledge';
      if (!n.choice.detective) return 'No result yet';
      if (n.acked?.[me.id]) return 'Already acknowledged';
      (n.acked ||= {})[me.id] = true;
      break;
    }
    case 'vote': {
      if (state.phase !== 'vote') return 'Wrong phase';
      if (!me.alive) return 'You are dead';
      if (state.votes[me.id]) return 'Already voted';
      if (target !== 'skip') {
        const t = typeof target === 'string' ? byId(state, target) : null;
        if (!t || !t.alive || t.id === me.id) return 'Invalid target';
      }
      state.votes[me.id] = target;
      break;
    }
    default:
      return 'Unknown action';
  }
  settle(state, rng);
  return null;
}

/* ---------- views ---------- */

export function viewFor(state, id) {
  const me = byId(state, id);
  if (!me) return null;
  const name = (pid) => byId(state, pid)?.name ?? '?';
  const v = {
    code: state.code, phase: state.phase, round: state.round,
    you: { id: me.id, name: me.name, role: me.role, alive: me.alive, isHost: me.isHost },
    players: state.players.map((p) => ({
      id: p.id, name: p.name, alive: p.alive, connected: p.connected, isHost: p.isHost,
    })),
    config: { ...state.config },
  };

  switch (state.phase) {
    case 'lobby':
      v.startError = validateStart(state);
      break;
    case 'roles':
      v.readyIds = Object.keys(state.ready);
      if (TEAM_ROLES.includes(me.role)) {
        v.team = state.players.filter((p) => p.role === me.role && p.id !== me.id).map((p) => ({ id: p.id, name: p.name }));
      }
      break;
    case 'night': {
      const n = state.night;
      const a = alive(state);
      v.count = { done: a.filter((p) => nightDone(n, p)).length, total: a.length };
      v.locked = false;
      if (me.role === 'detective') v.log = state.detectiveLog.map((e) => ({ ...e, name: name(e.targetId) }));
      if (me.role) {
        v.locked = !!n.locked[me.id];
        v.mySel = n.selections[me.id] || null;
        v.targets = nightTargets(state, me).map((p) => p.id);
        if (!asksQuestion(me)) {
          v.action = me.role;
          const mates = a.filter((p) => p.role === me.role && p.id !== me.id);
          v.team = mates.map((p) => ({ id: p.id, name: p.name, locked: !!n.locked[p.id] }));
          // live chips: only this player's own team ever appears here
          v.teamSel = a.filter((p) => p.role === me.role && n.selections[p.id])
            .map((p) => ({ id: p.id, name: p.name, targetId: n.selections[p.id], locked: !!n.locked[p.id] }));
          v.choice = n.choice[me.role] || null;
          if (me.role === 'doctor') v.blocked = blockedTarget(state);
          if (me.role === 'detective') v.acked = !!n.acked?.[me.id];
        }
        // everyone sees the question (so knowing it gives no one away); only askers answer it
        v.question = n.question;
      }
      break;
    }
    case 'narrate':
      // only the narrator sees roles, and only once everyone has seen their own
      if (me.isHost) v.roles = inPlay(state).map((p) => ({ id: p.id, role: p.role, out: p.out || null }));
      break;
    case 'dawn': {
      const k = state.lastEvent?.killedId || null;
      v.event = { killedId: k, killedName: k ? name(k) : null };
      break;
    }
    case 'vote': {
      const a = alive(state);
      v.votedIds = Object.keys(state.votes);
      v.count = { done: a.filter((p) => state.votes[p.id]).length, total: a.length };
      v.locked = !!state.votes[me.id];
      v.myVote = state.votes[me.id] || null;
      v.targets = me.alive ? a.filter((p) => p.id !== me.id).map((p) => p.id) : [];
      // the dead can't vote, but they get to watch who is voting for whom, live
      if (!me.alive) {
        v.liveVotes = Object.entries(state.votes).map(([from, t]) => ({ from: name(from), to: t === 'skip' ? null : name(t) }));
        v.roles = inPlay(state).map((p) => ({ id: p.id, role: p.role })); // the dead know everything now
      }
      break;
    }
    case 'verdict': {
      const e = state.lastEvent;
      v.event = {
        eliminatedId: e.eliminatedId,
        eliminatedName: e.eliminatedId ? name(e.eliminatedId) : null,
        tally: Object.entries(e.tally)
          .map(([key, voters]) => ({ key, name: key === 'skip' ? 'Skip' : name(key), voters }))
          .sort((x, y) => y.voters.length - x.voters.length),
      };
      break;
    }
    case 'over':
      v.winner = state.winner;
      v.winnerIds = state.winnerIds;
      v.roles = inPlay(state).map((p) => ({ id: p.id, role: p.role }));
      v.funLog = state.funLog.map((e) => {
        const counts = {};
        Object.values(e.answers).forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
        const top = Math.max(0, ...Object.values(counts));
        return {
          round: e.round, question: e.question,
          winners: Object.keys(counts).filter((t) => counts[t] === top).map((t) => name(t)),
          picks: Object.entries(e.answers).map(([from, to]) => ({ from: name(from), to: name(to) })),
        };
      });
      break;
  }
  return v;
}
