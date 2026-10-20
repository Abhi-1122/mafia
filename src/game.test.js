import assert from 'node:assert/strict';
import {
  createGame, addPlayer, removePlayer, rejoin, setConfig, validateStart, startGame,
  applyAction, advance, viewFor, configError, nightTargets, QUESTIONS, setNextQuestion,
} from './game.js';

// n players p1..pn (first is host); roles forced by `roles` array after start.
function setup(roles, config) {
  const s = createGame('TEST');
  roles.forEach((_, i) => addPlayer(s, { name: 'P' + (i + 1), token: 't' + (i + 1), isHost: i === 0 }));
  if (config) assert.equal(setConfig(s, config), null);
  assert.equal(startGame(s, () => 0.5), null);
  s.players.forEach((p, i) => { p.role = roles[i]; });
  return s;
}
const id = (i) => 'p' + i;
const byName = (s, n) => s.players.find((p) => p.name === n);
const act = (s, i, kind, target, rng) => applyAction(s, id(i), { kind, target }, rng);
const num = (p) => +p.id.slice(1);
const allReady = (s, rng) => s.players.forEach((p) => p.alive && act(s, num(p), 'ready', undefined, rng));
const sel = (s, i, t, rng) => act(s, i, 'select', t, rng);
const lock = (s, i, rng) => act(s, i, 'lock', undefined, rng);
// Every alive player (except `skip`) selects picks[id] (default: first eligible target) and locks.
function nightAll(s, picks = {}, rng, skip = []) {
  for (const p of s.players.filter((q) => q.alive && !skip.includes(q.id))) {
    if (s.night.locked[p.id]) continue;
    // default: first eligible target, but keep mafia off their own team so old scenarios hold
    const t = picks[p.id] ?? s.night.selections[p.id] ?? nightTargets(s, p).find((q) => p.role !== 'mafia' || q.role !== 'mafia').id;
    if (s.night.selections[p.id] !== t) assert.equal(sel(s, num(p), t, rng), null);
    assert.equal(lock(s, num(p), rng), null);
  }
  ackDetectives(s, rng);
}
// detectives must acknowledge their result before the night can resolve
function ackDetectives(s, rng) {
  if (s.phase !== 'night' || !s.night.choice.detective) return;
  for (const p of s.players.filter((q) => q.alive && q.role === 'detective' && !s.night.acked[q.id])) {
    assert.equal(act(s, num(p), 'ack', undefined, rng), null);
  }
}
// dawn -> vote, everyone skips, verdict -> next night
function toNextNight(s) {
  advance(s);
  s.players.filter((p) => p.alive).forEach((p) => act(s, num(p), 'vote', 'skip'));
  assert.equal(s.phase, 'verdict');
  advance(s);
  assert.equal(s.phase, 'night');
}

// ---- config validation
{
  const s = createGame('X');
  for (let i = 0; i < 2; i++) addPlayer(s, { name: 'a' + i, token: 't' + i });
  assert.match(validateStart(s), /at least 3/);
  addPlayer(s, { name: 'a2', token: 't2' });
  assert.equal(validateStart(s), null); // 1/1/1/0 with 3 players
  setConfig(s, { mafia: 0 });
  assert.match(validateStart(s), /at least 1 mafia/);
  setConfig(s, { mafia: 1, doctor: 2 });
  assert.match(validateStart(s), /Not enough players for these roles \(need 4, have 3\)/);
  setConfig(s, { mafia: 2, doctor: 0, detective: 0 });
  assert.match(validateStart(s), /Too many mafia for 3 players/);
  assert.equal(setConfig(s, { mafia: -1 }), 'Bad config');
  assert.equal(setConfig(s, { mafia: 1.5 }), 'Bad config');
  assert.equal(configError({ mafia: 2, doctor: 0, detective: 0, jester: 0 }, 5), null);
  assert.ok(configError({ mafia: 2, doctor: 0, detective: 0, jester: 0 }, 4));
  // names
  assert.ok(addPlayer(s, { name: '  A0 ', token: 'x' }).error); // dup, case-insens
  assert.ok(addPlayer(s, { name: '   ', token: 'x' }).error);
  assert.ok(addPlayer(s, { name: 'x'.repeat(17), token: 'x' }).error);
  assert.equal(addPlayer(s, { name: ' Bob  Q ', token: 'x' }).player.name, 'Bob Q');
  for (let i = 0; s.players.length < 20; i++) addPlayer(s, { name: 'f' + i, token: 'f' + i });
  assert.equal(addPlayer(s, { name: 'late', token: 'z' }).error, 'Room is full');
}

// ---- role distribution
{
  const s = createGame('X');
  for (let i = 0; i < 8; i++) addPlayer(s, { name: 'n' + i, token: 't' + i });
  setConfig(s, { mafia: 2, doctor: 1, detective: 1, jester: 1 });
  let k = 0;
  assert.equal(startGame(s, () => ((k = (k * 7 + 3) % 10) / 10)), null);
  const c = {};
  s.players.forEach((p) => (c[p.role] = (c[p.role] || 0) + 1));
  assert.deepEqual(c, { mafia: 2, doctor: 1, detective: 1, jester: 1, civilian: 3 });
  assert.equal(s.phase, 'roles');
}

// ---- roles phase -> night, host-only rules, spoofing
{
  const s = setup(['mafia', 'doctor', 'detective', 'civilian', 'civilian']);
  assert.match(act(s, 2, 'start'), /host/);
  assert.equal(act(s, 1, 'start'), 'Game already started');
  assert.match(act(s, 2, 'config', { mafia: 1 }), /host/);
  assert.equal(sel(s, 1, 'p2'), 'Wrong phase');
  allReady(s);
  assert.equal(s.phase, 'night');
  assert.equal(sel(s, 1, 'p1'), null); // mafia may target themselves
  assert.equal(sel(s, 1, 'p1'), null); // (tap again clears)
  assert.equal(sel(s, 3, 'p3'), 'Invalid target'); // detective -> detective (self)
  assert.equal(sel(s, 4, 'p4'), null); // decoy question: yourself is fine
  assert.equal(sel(s, 4, 'p4'), null);
  assert.equal(sel(s, 3, 'nope'), 'Invalid target');
  assert.equal(sel(s, 3, 42), 'Invalid target');
  assert.equal(sel(s, 9, 'p1'), 'Unknown player');
  assert.equal(act(s, 1, 'vote', 'p2'), 'Wrong phase');
  assert.equal(act(s, 1, 'night', 'p2'), 'Unknown action'); // old kinds are gone
  assert.equal(act(s, 1, 'mafiaSelect', 'p2'), 'Unknown action');
  assert.equal(lock(s, 1), 'Select a target first');
  assert.equal(sel(s, 4, 'p1'), null);
  assert.equal(sel(s, 3, 'p1'), null);
}

// ---- night kill / save, detective team, doctor self-save
{
  const s = setup(['mafia', 'doctor', 'detective', 'civilian', 'civilian']);
  allReady(s);
  nightAll(s, { p1: 'p4', p2: 'p2', p3: 'p1' }); // doctor saves self, kill goes through on p4
  assert.deepEqual(s.detectiveLog, [{ round: 1, targetId: 'p1', isMafia: true }]);
  assert.equal(s.phase, 'dawn');
  assert.equal(s.players[3].alive, false);
  assert.equal(s.lastEvent.killedId, 'p4');
  assert.equal(viewFor(s, 'p5').event.killedName, 'P4');
  assert.equal(act(s, 4, 'vote', 'p1'), 'Wrong phase');
  assert.equal(advance(s), true);
  assert.equal(s.phase, 'vote');
  assert.equal(act(s, 4, 'vote', 'p1'), 'You are dead');
  assert.equal(act(s, 1, 'vote', 'p1'), 'Invalid target'); // self
  assert.equal(act(s, 1, 'vote', 'p4'), 'Invalid target'); // dead
}
{
  // save works: doctor protects the victim; nobody dies
  const s = setup(['mafia', 'doctor', 'civilian', 'civilian', 'civilian']);
  allReady(s);
  nightAll(s, { p1: 'p3', p2: 'p3' });
  assert.equal(s.phase, 'dawn');
  assert.equal(s.lastEvent.killedId, null);
  assert.ok(s.players.every((p) => p.alive));
  assert.deepEqual(s.saveStreak, { targetId: 'p3', count: 1 });
  // no doctor/detective alive: only mafia teams, but every alive player still locks
  const t = setup(['mafia', 'civilian', 'civilian', 'civilian', 'civilian']);
  allReady(t);
  nightAll(t, { p1: 'p2' });
  assert.equal(t.phase, 'dawn');
  assert.equal(t.saveStreak, null);
}

// ---- detective team: result only for the resolved choice, jester is not Mafia
{
  const R = ['mafia', 'detective', 'detective', 'jester', 'civilian', 'civilian'];
  const C = { mafia: 1, doctor: 0, detective: 2, jester: 1 };
  const s = setup(R, C);
  allReady(s);
  assert.equal(sel(s, 2, 'p3'), 'Invalid target'); // detectives cannot target detectives
  assert.equal(sel(s, 2, 'p4'), null);
  assert.equal(sel(s, 3, 'p1'), null);
  assert.deepEqual(viewFor(s, 'p3').team, [{ id: 'p2', name: 'P2', locked: false }]);
  assert.deepEqual(viewFor(s, 'p3').teamSel.map((x) => x.targetId).sort(), ['p1', 'p4']);
  lock(s, 2);
  assert.equal(viewFor(s, 'p2').choice, null); // teammate has not locked: no result yet
  assert.deepEqual(viewFor(s, 'p2').log, []);
  assert.equal(viewFor(s, 'p3').team[0].locked, true);
  assert.equal(sel(s, 2, 'p1'), 'Already locked');
  lock(s, 3, () => 0.99); // tie p1 vs p4 -> rng picks the last tied player
  assert.equal(s.phase, 'night'); // others still choosing, but detectives already have it
  assert.equal(viewFor(s, 'p2').choice, 'p4');
  assert.deepEqual(viewFor(s, 'p3').log, [{ round: 1, targetId: 'p4', name: 'P4', isMafia: false }]); // jester = not Mafia
  assert.equal(viewFor(s, 'p5').log, undefined);
  assert.equal(viewFor(s, 'p1').log, undefined);
  nightAll(s, { p1: 'p5' });
  assert.equal(s.phase, 'dawn');
  const u = setup(R, C);
  allReady(u);
  sel(u, 2, 'p4'); sel(u, 3, 'p1');
  lock(u, 2); lock(u, 3, () => 0);
  assert.equal(u.detectiveLog[0].targetId, 'p1');
  assert.equal(u.detectiveLog[0].isMafia, true);
  // dead detectives still see the history; later nights append
  nightAll(u, { p1: 'p2' }, undefined, ['p2', 'p3']);
  assert.equal(u.night.choice.detective, 'p1');
}

// ---- mafia team: plurality + tiebreak by rng, privacy of selections
{
  const mk = () => {
    const s = setup(['mafia', 'mafia', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian'], { mafia: 2, doctor: 0, detective: 0 });
    allReady(s);
    return s;
  };
  let s = mk();
  nightAll(s, { p1: 'p3', p2: 'p4' }, () => 0); // tie -> index 0 = p3
  assert.equal(s.lastEvent.killedId, 'p3');
  s = mk();
  nightAll(s, { p1: 'p3', p2: 'p4' }, () => 0.99); // tie -> p4
  assert.equal(s.lastEvent.killedId, 'p4');
  const s3 = setup(['mafia', 'mafia', 'mafia', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian'], { mafia: 3, doctor: 0, detective: 0 });
  allReady(s3);
  nightAll(s3, { p1: 'p5', p2: 'p4', p3: 'p4' }, () => 0);
  assert.equal(s3.lastEvent.killedId, 'p4'); // plurality
  // teammates see each other's live selections; civilians do not
  const s4 = mk();
  sel(s4, 1, 'p3');
  assert.deepEqual(viewFor(s4, 'p2').teamSel, [{ id: 'p1', name: 'P1', targetId: 'p3', locked: false }]);
  assert.deepEqual(viewFor(s4, 'p2').team, [{ id: 'p1', name: 'P1', locked: false }]);
  for (const who of ['p3', 'p4', 'p5']) {
    const v = viewFor(s4, who);
    assert.equal(v.teamSel, undefined);
    assert.equal(v.team, undefined);
    assert.equal(v.choice, undefined);
  }
}

// ---- team consensus: change/clear selection, rejected after lock, no resolution until all locked
{
  const s = setup(['mafia', 'mafia', 'doctor', 'civilian', 'civilian', 'civilian', 'civilian'], { mafia: 2, doctor: 1, detective: 0 });
  allReady(s);
  assert.equal(sel(s, 1, 'p4'), null);
  assert.equal(sel(s, 2, 'p4'), null);
  assert.deepEqual(viewFor(s, 'p2').teamSel, [
    { id: 'p1', name: 'P1', targetId: 'p4', locked: false },
    { id: 'p2', name: 'P2', targetId: 'p4', locked: false },
  ]);
  assert.equal(sel(s, 1, 'p5'), null); // change
  assert.equal(s.night.selections.p1, 'p5');
  assert.equal(sel(s, 1, 'p5'), null); // tap again clears
  assert.equal(s.night.selections.p1, undefined);
  assert.equal(lock(s, 1), 'Select a target first');
  assert.equal(sel(s, 1, 'p2'), null); // mafia may target a teammate
  assert.equal(sel(s, 1, 'p2'), null); // (clear it again)
  assert.equal(sel(s, 3, 'p3'), null); // doctor may pick self
  assert.equal(s.night.locked.p1, undefined); // selecting never locks
  sel(s, 1, 'p4');
  assert.equal(lock(s, 1), null);
  assert.equal(sel(s, 1, 'p5'), 'Already locked');
  assert.equal(lock(s, 1), 'Already locked');
  assert.equal(s.night.selections.p1, 'p4');
  assert.equal(viewFor(s, 'p2').teamSel.find((x) => x.id === 'p1').locked, true);
  // everyone else locks; the mafia team still waits for p2
  nightAll(s, { p3: 'p6' }, undefined, ['p1', 'p2']);
  assert.equal(s.phase, 'night');
  assert.equal(s.night.choice.mafia, undefined);
  assert.deepEqual(viewFor(s, 'p5').count, { done: 6, total: 7 });
  assert.equal(lock(s, 2), null); // p2's selection p4 was already set
  assert.equal(s.phase, 'dawn');
  assert.equal(s.lastEvent.killedId, 'p4');
  assert.equal(sel(s, 2, 'p5'), 'Wrong phase');
}

// ---- multiple doctors: one team choice
{
  const s = setup(['mafia', 'doctor', 'doctor', 'civilian', 'civilian', 'civilian'], { mafia: 1, doctor: 2, detective: 0 });
  allReady(s);
  nightAll(s, { p1: 'p4', p2: 'p5', p3: 'p4' }, () => 0.99); // 1 vs 1: tie -> last tied (p5); mafia hits p4
  assert.equal(s.night.choice.doctor, 'p5');
  assert.equal(s.lastEvent.killedId, 'p4');
  const t = setup(['mafia', 'doctor', 'doctor', 'civilian', 'civilian', 'civilian'], { mafia: 1, doctor: 2, detective: 0 });
  allReady(t);
  nightAll(t, { p1: 'p4', p2: 'p4', p3: 'p4' });
  assert.equal(t.lastEvent.killedId, null);
}

// ---- doctor: no more than 2 nights in a row, streak reset
{
  const s = setup(['mafia', 'doctor', 'civilian', 'civilian', 'civilian', 'civilian'], { mafia: 1, doctor: 1, detective: 0 });
  allReady(s);
  nightAll(s, { p1: 'p3', p2: 'p3' });
  assert.deepEqual(s.saveStreak, { targetId: 'p3', count: 1 });
  toNextNight(s);
  assert.equal(viewFor(s, 'p2').blocked, null);
  nightAll(s, { p1: 'p4', p2: 'p3' });
  assert.deepEqual(s.saveStreak, { targetId: 'p3', count: 2 });
  assert.equal(s.lastEvent.killedId, 'p4'); // doctor saved p3 only
  toNextNight(s);
  assert.equal(viewFor(s, 'p2').blocked, 'p3');
  assert.ok(!viewFor(s, 'p2').targets.includes('p3'));
  assert.equal(sel(s, 2, 'p3'), 'Saved 2 nights in a row');
  assert.equal(sel(s, 1, 'p3'), null); // mafia may still target p3; only the doctors are blocked
  nightAll(s, { p1: 'p3', p2: 'p5' });
  assert.deepEqual(s.saveStreak, { targetId: 'p5', count: 1 }); // changed target resets
  assert.equal(s.lastEvent.killedId, 'p3'); // p3 was not saved
  toNextNight(s);
  assert.equal(viewFor(s, 'p2').blocked, null);
  // no living doctor -> streak resets to null
  const u = setup(['mafia', 'doctor', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian'], { mafia: 1, doctor: 1, detective: 0 });
  allReady(u);
  nightAll(u, { p1: 'p2', p2: 'p3' });
  assert.deepEqual(u.saveStreak, { targetId: 'p3', count: 1 });
  assert.equal(u.players[1].alive, false);
  toNextNight(u);
  nightAll(u, { p1: 'p4' });
  assert.equal(u.saveStreak, null);
}

// ---- decoy questions for civilians and jesters
{
  const s = setup(['mafia', 'doctor', 'civilian', 'jester', 'civilian'], { mafia: 1, doctor: 1, detective: 0, jester: 1 });
  allReady(s, () => 0);
  assert.equal(s.night.question, QUESTIONS[0]); // rng-driven pick
  assert.ok(QUESTIONS.length >= 30);
  assert.equal(new Set(QUESTIONS).size, QUESTIONS.length);
  for (const who of ['p3', 'p4', 'p5']) {
    const v = viewFor(s, who);
    assert.equal(v.question, QUESTIONS[0]);
    assert.ok(v.targets.includes(who)); // you may name yourself
    assert.equal(v.teamSel, undefined);
    assert.equal(v.action, undefined);
  }
  assert.equal(viewFor(s, 'p1').question, QUESTIONS[0]); // shown to roles too, but they act instead
  assert.equal(viewFor(s, 'p1').action, 'mafia');
  assert.equal(viewFor(s, 'p2').action, 'doctor');
  assert.equal(viewFor(s, 'p3').action, undefined);
  // teams lock but the night waits for the question answerers
  nightAll(s, { p1: 'p3', p2: 'p3' }, undefined, ['p3', 'p4', 'p5']);
  assert.equal(s.phase, 'night');
  assert.equal(s.night.choice.mafia, 'p3');
  assert.deepEqual(viewFor(s, 'p1').count, { done: 2, total: 5 });
  assert.equal(sel(s, 3, 'p3'), null); // answering a question about yourself is allowed
  assert.equal(sel(s, 3, 'p4'), null);
  assert.equal(lock(s, 3), null);
  assert.equal(sel(s, 3, 'p5'), 'Already locked');
  assert.equal(s.phase, 'night');
  sel(s, 4, 'p3'); lock(s, 4);
  assert.equal(s.phase, 'night');
  sel(s, 5, 'p3'); lock(s, 5);
  assert.equal(s.phase, 'dawn');
  assert.deepEqual(s.funLog, [{ round: 1, question: QUESTIONS[0], answers: { p3: 'p4', p4: 'p3', p5: 'p3' } }]);
  // second night draws a different question (rng 0 again, but index 0 is used up)
  advance(s);
  s.players.filter((p) => p.alive).forEach((p) => act(s, num(p), 'vote', 'skip'));
  advance(s, () => 0);
  assert.equal(s.phase, 'night');
  assert.equal(s.night.question, QUESTIONS[1]);
  assert.equal(s.funLog.length, 2);
}
{
  // 12 nights, never a repeated question
  const s = setup(['mafia', 'doctor', ...Array(8).fill('civilian')], { mafia: 1, doctor: 1, detective: 0 });
  allReady(s);
  for (let n = 0; n < 12; n++) {
    const t = 'p' + (3 + (n % 8)); // mafia and doctor agree each night, so nobody dies and nobody is blocked
    nightAll(s, { p1: t, p2: t });
    assert.equal(s.phase, 'dawn');
    if (n < 11) toNextNight(s);
  }
  assert.equal(new Set(s.funLog.map((e) => e.question)).size, 12);
}

// ---- question source: prefetched nextQuestion, built-in fallback, no repeats
{
  const R = ['mafia', 'civilian', 'civilian', 'civilian', 'civilian'];
  const C = { mafia: 1, doctor: 0, detective: 0 };
  const s = createGame('Q');
  for (let i = 0; i < 3; i++) addPlayer(s, { name: 'q' + i, token: 'q' + i, isHost: i === 0 });
  assert.equal(s.config.spice, 'pg');
  assert.equal(setConfig(s, { spice: 'pg13' }), null);
  assert.equal(s.config.spice, 'pg13');
  assert.equal(setConfig(s, { spice: 'xxx' }), 'Bad config');
  assert.equal(act(s, 2, 'config', { spice: 'pg' }), 'Only the host can do that');
  assert.equal(act(s, 1, 'config', { spice: 'pg' }), null);
  assert.equal(s.config.spice, 'pg');
  assert.equal(setNextQuestion(s, { id: 5, text: '' }), 'Bad question');
  assert.equal(s.nextQuestion, null);

  // a prefetched question (roles phase) is used at night start, cleared, and recorded as used
  const g = setup(R, C);
  assert.equal(g.phase, 'roles');
  assert.equal(setNextQuestion(g, { id: 'abc', text: '  Who would   eat the last slice? ' }), null);
  assert.deepEqual(g.nextQuestion, { id: 'api:abc', text: 'Who would eat the last slice?' });
  allReady(g, () => 0);
  assert.equal(g.night.question, 'Who would eat the last slice?');
  assert.equal(g.nextQuestion, null);
  assert.equal(viewFor(g, 'p3').question, 'Who would eat the last slice?');
  assert.equal(g.funLog[0].question, 'Who would eat the last slice?');
  assert.deepEqual(g.usedQuestions, [{ id: 'api:abc', text: 'Who would eat the last slice?' }]);
  // a repeat by id or by text is rejected (the host retries once)
  assert.equal(setNextQuestion(g, { id: 'abc', text: 'different' }), 'Already used');
  assert.equal(setNextQuestion(g, { id: 'zzz', text: 'Who would eat the last slice?' }), 'Already used');
  assert.equal(g.nextQuestion, null);
  // nothing prefetched: next night falls back to an unused built-in
  nightAll(g, { p1: 'p2' });
  advance(g);
  g.players.filter((p) => p.alive).forEach((p) => act(g, num(p), 'vote', 'skip'));
  advance(g, () => 0);
  assert.equal(g.night.question, QUESTIONS[0]);
  assert.equal(g.usedQuestions.length, 2);

  // fallback skips used built-ins
  const f = setup(R, C);
  f.usedQuestions = [{ id: 'b0', text: QUESTIONS[0] }];
  allReady(f, () => 0);
  assert.equal(f.night.question, QUESTIONS[1]);
  // a stale prefetched question that is already used is ignored
  const h = setup(R, C);
  h.usedQuestions = [{ id: 'api:1', text: 'old' }];
  h.nextQuestion = { id: 'api:1', text: 'old' };
  allReady(h, () => 0);
  assert.equal(h.night.question, QUESTIONS[0]);
  assert.equal(h.nextQuestion, null);
  // every built-in used: repeats allowed
  const k = setup(R, C);
  k.usedQuestions = QUESTIONS.map((text, i) => ({ id: 'b' + i, text }));
  allReady(k, () => 0.99);
  assert.equal(k.night.question, QUESTIONS[QUESTIONS.length - 1]);
  // no repeats over a whole run of built-ins
  const m = setup(['mafia', 'doctor', ...Array(8).fill('civilian')], { mafia: 1, doctor: 1, detective: 0 });
  allReady(m);
  const seen = new Set([m.night.question]);
  for (let n = 1; n < QUESTIONS.length; n++) {
    const t = 'p' + (3 + ((n - 1) % 8));
    nightAll(m, { p1: t, p2: t });
    toNextNight(m);
    assert.ok(!seen.has(m.night.question), 'question repeated');
    seen.add(m.night.question);
  }
  assert.equal(seen.size, QUESTIONS.length);
}

// ---- votes: clear winner, tie, skip >= top
function toVote(roles, config) {
  const s = setup(roles, config);
  allReady(s);
  const civ = s.players.find((q) => q.role === 'civilian').id;
  const picks = {};
  s.players.forEach((p) => { if (p.role === 'mafia' || p.role === 'doctor') picks[p.id] = civ; });
  nightAll(s, picks);
  assert.equal(s.phase, 'dawn');
  advance(s);
  return s;
}
{
  const R = ['mafia', 'doctor', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian'];
  let s = toVote(R);
  s.players.forEach((p) => act(s, num(p), 'vote', p.id === 'p3' ? 'skip' : 'p3'));
  assert.equal(s.phase, 'verdict');
  assert.equal(s.lastEvent.eliminatedId, 'p3');
  assert.deepEqual(s.lastEvent.tally.skip, ['P3']);
  assert.equal(s.lastEvent.tally.p3.length, 6);
  assert.equal(s.players[2].alive, false);
  const vv = viewFor(s, 'p1').event;
  assert.equal(vv.eliminatedName, 'P3');
  assert.equal(vv.tally[0].voters.length, 6);
  assert.equal(act(s, 1, 'vote', 'p2'), 'Wrong phase');
  advance(s);
  assert.equal(s.phase, 'night');
  assert.equal(s.round, 2);
  assert.deepEqual(s.night.selections, {});
  assert.deepEqual(s.night.locked, {});
  assert.deepEqual(s.night.choice, {});

  // tie
  s = toVote(R);
  const v = { p1: 'p2', p2: 'p1', p3: 'p2', p4: 'p1', p5: 'p6', p6: 'p7', p7: 'p6' };
  Object.entries(v).forEach(([p, t]) => act(s, +p.slice(1), 'vote', t));
  assert.equal(s.lastEvent.eliminatedId, null);
  assert.equal(s.phase, 'verdict');
  advance(s);
  assert.equal(s.phase, 'night');

  // skip > top
  s = toVote(R);
  const w = { p1: 'skip', p2: 'skip', p3: 'skip', p4: 'p5', p5: 'p4', p6: 'p4', p7: 'skip' };
  Object.entries(w).forEach(([p, t]) => act(s, +p.slice(1), 'vote', t));
  assert.equal(s.lastEvent.eliminatedId, null);
  // skip == top
  s = toVote(R);
  const x = { p1: 'skip', p2: 'skip', p3: 'p4', p4: 'p5', p5: 'p4', p6: 'p1', p7: 'p5' };
  Object.entries(x).forEach(([p, t]) => act(s, +p.slice(1), 'vote', t));
  assert.equal(s.lastEvent.eliminatedId, null);
  assert.equal(act(s, 1, 'vote', 'skip'), 'Wrong phase');
}
{
  const s = toVote(['mafia', 'doctor', 'civilian', 'civilian', 'civilian']);
  assert.equal(act(s, 1, 'vote', 'p2'), null);
  assert.equal(act(s, 1, 'vote', 'p3'), 'Already voted');
  assert.equal(viewFor(s, 'p3').count.done, 1);
  assert.deepEqual(viewFor(s, 'p3').votedIds, ['p1']);
}

// ---- win conditions
{
  // town: voting out the only mafia
  const s = toVote(['mafia', 'doctor', 'civilian', 'civilian', 'civilian']);
  s.players.forEach((p) => act(s, num(p), 'vote', p.id === 'p1' ? 'p2' : 'p1'));
  assert.equal(s.winner, 'town');
  assert.equal(s.phase, 'verdict'); // verdict shown first
  assert.equal(viewFor(s, 'p3').winner, undefined);
  assert.equal(viewFor(s, 'p3').funLog, undefined); // decoy answers hidden until the end
  advance(s);
  assert.equal(s.phase, 'over');
  assert.equal(viewFor(s, 'p3').winner, 'town');
  assert.equal(viewFor(s, 'p3').roles.find((r) => r.id === 'p1').role, 'mafia');
  const fl = viewFor(s, 'p3').funLog;
  assert.equal(fl.length, 1);
  assert.equal(fl[0].round, 1);
  assert.equal(fl[0].question, s.funLog[0].question);
  assert.deepEqual(fl[0].winners, ['P1']); // p3, p4, p5 all picked the first other player
  assert.deepEqual(fl[0].picks.map((x) => x.from), ['P3', 'P4', 'P5']);
  assert.ok(fl[0].picks.every((x) => x.to === 'P1'));
  // play again keeps connected players + config
  s.players[4].connected = false;
  assert.equal(act(s, 3, 'again'), 'Only the host can do that');
  assert.equal(act(s, 1, 'again'), null);
  assert.equal(s.phase, 'lobby');
  assert.equal(s.players.length, 4);
  assert.ok(s.players.every((p) => p.alive && p.role === null));
  assert.deepEqual(s.config, { mafia: 1, doctor: 1, detective: 1, jester: 0, spice: 'pg', narrator: false });
  assert.deepEqual(s.funLog, []);
  assert.equal(s.saveStreak, null);
}
{
  // mafia parity at night -> mafia win, straight to over
  const s = setup(['mafia', 'civilian', 'civilian']);
  allReady(s);
  nightAll(s, { p1: 'p2' });
  assert.equal(s.winner, 'mafia');
  assert.equal(s.phase, 'over');
}
{
  // jester killed at night: just dies, game goes on
  const s = setup(['mafia', 'jester', 'civilian', 'civilian', 'civilian'], { mafia: 1, doctor: 0, detective: 0, jester: 1 });
  allReady(s);
  nightAll(s, { p1: 'p2' });
  assert.equal(s.winner, null);
  assert.equal(s.phase, 'dawn');
  assert.equal(s.players[1].alive, false);
}
{
  // jester voted out: jester wins, even if that also drops mafia parity
  const s = toVote(['mafia', 'jester', 'civilian', 'civilian', 'civilian'], { mafia: 1, doctor: 0, detective: 0, jester: 1 });
  s.players.forEach((p) => act(s, num(p), 'vote', p.id === 'p2' ? 'p1' : 'p2'));
  assert.equal(s.winner, 'jester');
  assert.deepEqual(s.winnerIds, ['p2']);
  advance(s);
  assert.equal(s.phase, 'over');
}
{
  // mafia parity after a vote: night kills p2, then voting out p3 leaves 1 mafia vs 1 civilian
  const s = toVote(['mafia', 'civilian', 'civilian', 'civilian'], { mafia: 1, doctor: 0, detective: 0 });
  assert.equal(s.players[1].alive, false);
  ['p1', 'p3', 'p4'].forEach((p) => act(s, +p.slice(1), 'vote', p === 'p3' ? 'p4' : 'p3'));
  assert.equal(s.lastEvent.eliminatedId, 'p3');
  assert.equal(s.winner, 'mafia');
  advance(s);
  assert.equal(s.phase, 'over');
}

// ---- host kicks (AFK / stuck players), any phase: still in the game, nobody waits on them
{
  const s = setup(['mafia', 'doctor', 'civilian', 'civilian', 'civilian']);
  s.players[3].connected = false;
  assert.equal(act(s, 2, 'kick', 'p4'), 'Only the host can do that');
  assert.equal(act(s, 1, 'kick', 'p1'), 'Invalid player'); // the host can't kick themselves
  [1, 2, 3, 5].forEach((i) => act(s, i, 'ready'));
  assert.equal(s.phase, 'roles'); // waits for the offline player
  assert.equal(act(s, 1, 'kick', 'p4'), null);
  assert.equal(s.phase, 'night'); // requirement dropped
  assert.equal(s.players[3].alive, true); // still in the game
  assert.ok(viewFor(s, 'p1').targets.includes('p4')); // can still be killed
  assert.deepEqual(viewFor(s, 'p1').count, { done: 0, total: 4 }); // not waited on
}
{
  // AFK doctor stalls the night; kicking resolves it without the doctor's save
  const s = setup(['mafia', 'doctor', 'civilian', 'civilian', 'civilian']);
  allReady(s);
  nightAll(s, { p1: 'p3' }, undefined, ['p2']);
  assert.equal(s.phase, 'night');
  assert.equal(act(s, 1, 'kick', 'p2'), null);
  assert.equal(s.phase, 'dawn');
  assert.equal(s.lastEvent.killedId, 'p3');
  assert.equal(s.players[1].alive, true);
}
{
  // kicking a teammate who never locked lets the rest of the team resolve
  const s = setup(['mafia', 'mafia', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian'], { mafia: 2, doctor: 0, detective: 0 });
  allReady(s);
  nightAll(s, { p1: 'p3' }, undefined, ['p2']);
  assert.equal(act(s, 1, 'kick', 'p2'), null);
  assert.equal(s.night.choice.mafia, 'p3');
  assert.equal(s.phase, 'dawn');
}
{
  // kicking during the vote completes it; the kicked player can still be voted out
  const s = toVote(['mafia', 'doctor', 'civilian', 'civilian', 'civilian']);
  ['p1', 'p2', 'p3', 'p4'].forEach((p) => act(s, +p.slice(1), 'vote', 'p5'));
  assert.equal(act(s, 1, 'kick', 'p5'), null);
  assert.equal(s.phase, 'verdict');
  assert.equal(s.lastEvent.eliminatedId, 'p5');
}
{
  // kicking the last mafia ends the game: town wins
  const s = setup(['mafia', 'civilian', 'civilian', 'civilian']);
  allReady(s);
  s.players[0].isHost = false; s.players[1].isHost = true;
  assert.equal(act(s, 2, 'kick', 'p1'), null);
  assert.equal(s.winner, 'town');
  assert.equal(s.phase, 'over');
}
{
  // kicking one of two mafia: the game goes on; if the other is voted out, the town wins
  const s = toVote(['mafia', 'mafia', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian'], { mafia: 2, doctor: 0, detective: 0 });
  s.players[0].isHost = false; s.players[2].isHost = true;
  assert.equal(act(s, 3, 'kick', 'p1'), null);
  assert.equal(s.phase, 'vote');
  assert.equal(s.winner, null);
  assert.equal(s.players[2].alive, false); // p3 died in the night
  ['p2', 'p4', 'p5', 'p6', 'p7'].forEach((p) => assert.equal(act(s, +p.slice(1), 'vote', p === 'p2' ? 'p4' : 'p2'), null));
  assert.equal(s.lastEvent.eliminatedId, 'p2');
  assert.equal(s.winner, 'town');
}
{
  // kicking a civilian never decides the game
  const s = setup(['mafia', 'civilian', 'civilian', 'civilian']);
  allReady(s);
  assert.equal(act(s, 1, 'kick', 'p2'), null);
  assert.equal(s.winner, null);
  assert.equal(s.phase, 'night');
}
{
  // kick in lobby
  const s = createGame('K');
  addPlayer(s, { name: 'h', token: 'a', isHost: true });
  addPlayer(s, { name: 'x', token: 'b' });
  assert.equal(act(s, 2, 'kick', 'p1'), 'Only the host can do that');
  assert.equal(act(s, 1, 'kick', 'p1'), 'Invalid player');
  assert.equal(act(s, 1, 'kick', 'p2'), null);
  assert.equal(s.players.length, 1);
}

// ---- viewFor leaks nothing
{
  const s = setup(['mafia', 'doctor', 'detective', 'jester', 'civilian', 'civilian'], { mafia: 1, doctor: 1, detective: 1, jester: 1 });
  const checkNoLeak = (label) => {
    const v = viewFor(s, 'p5'); // civilian
    const j = JSON.stringify(v);
    assert.equal((j.match(/"role"/g) || []).length, 1, label + ': only own role key');
    assert.ok(!j.includes('token') && !j.includes('"t1"'), label + ': no tokens');
    assert.ok(!j.includes('funLog') && !j.includes('answers'), label + ': no decoy answers');
    assert.equal(v.you.role, 'civilian');
    s.players.filter((p) => p.id !== 'p5').forEach((p) => assert.ok(!('role' in v.players.find((q) => q.id === p.id))));
    assert.equal(v.team, undefined);
    assert.equal(v.teamSel, undefined);
    assert.equal(v.choice, undefined);
    assert.equal(v.log, undefined);
    assert.equal(v.mafiaSel, undefined);
  };
  checkNoLeak('roles');
  allReady(s);
  checkNoLeak('night');
  sel(s, 1, 'p4'); // mafia
  sel(s, 2, 'p6'); // doctor
  sel(s, 3, 'p1'); // detective
  sel(s, 5, 'p1'); // civilian answering the decoy
  checkNoLeak('night+selections');
  // other teams' selections never show up in a team's view
  assert.deepEqual(viewFor(s, 'p2').teamSel, [{ id: 'p2', name: 'P2', targetId: 'p6', locked: false }]);
  assert.deepEqual(viewFor(s, 'p1').teamSel, [{ id: 'p1', name: 'P1', targetId: 'p4', locked: false }]);
  assert.deepEqual(viewFor(s, 'p3').teamSel, [{ id: 'p3', name: 'P3', targetId: 'p1', locked: false }]);
  lock(s, 1); // mafia resolves; the doctor's view must not carry it
  assert.equal(viewFor(s, 'p1').choice, 'p4');
  assert.equal(viewFor(s, 'p2').choice, null);
  assert.equal(viewFor(s, 'p3').choice, null);
  checkNoLeak('night+mafia choice');
  nightAll(s, { p2: 'p6', p3: 'p1', p5: 'p1' });
  assert.equal(s.phase, 'dawn');
  checkNoLeak('dawn');
  advance(s);
  const vv = viewFor(s, 'p5');
  assert.deepEqual(vv.targets.sort(), ['p1', 'p2', 'p3', 'p6']); // alive others, not self/dead
  checkNoLeak('vote');
  assert.deepEqual(viewFor(s, 'p4').targets, []); // dead jester
  s.players.filter((p) => p.alive).forEach((p) => act(s, num(p), 'vote', p.id === 'p1' ? 'p2' : 'p1'));
  checkNoLeak('verdict');
  advance(s);
  assert.equal(s.phase, 'over');
  assert.ok(Array.isArray(viewFor(s, 'p5').funLog)); // revealed at the end
  const l = createGame('L');
  addPlayer(l, { name: 'a', token: 'secret-token', isHost: true });
  assert.ok(!JSON.stringify(viewFor(l, 'p1')).includes('secret-token'));
}

// ---- detective locks last: the night waits until they have seen (acked) the result
{
  const s = setup(['mafia', 'doctor', 'detective', 'civilian', 'civilian']);
  allReady(s);
  assert.equal(act(s, 3, 'ack'), 'No result yet');
  nightAll(s, { p1: 'p4', p3: 'p1' }, undefined, ['p3']); // everyone but the detective
  assert.equal(sel(s, 3, 'p1'), null);
  assert.equal(lock(s, 3), null);
  assert.equal(s.phase, 'night'); // all locked, but the detective hasn't seen the result yet
  const v = viewFor(s, 'p3');
  assert.equal(v.choice, 'p1');
  assert.equal(v.acked, false);
  assert.equal(v.log.at(-1).isMafia, true);
  assert.deepEqual(viewFor(s, 'p4').count, { done: 4, total: 5 });
  assert.equal(act(s, 4, 'ack'), 'Nothing to acknowledge');
  assert.equal(act(s, 3, 'ack'), null);
  assert.equal(act(s, 3, 'ack'), 'Wrong phase'); // night resolved
  assert.equal(s.phase, 'dawn');
}

// ---- narrator mode: host deals and narrates, gets no role, sees roles only after everyone is ready
{
  const s = createGame('NARR');
  ['Host', 'A', 'B', 'C'].forEach((n, i) => addPlayer(s, { name: n, token: 'n' + i, isHost: !i }));
  assert.equal(applyAction(s, 'p2', { kind: 'config', target: { narrator: true } }), 'Only the host can do that');
  assert.equal(applyAction(s, 'p1', { kind: 'config', target: { narrator: 'yes' } }), 'Bad config');
  assert.equal(applyAction(s, 'p1', { kind: 'config', target: { narrator: true, doctor: 0, detective: 0 } }), null);
  assert.equal(validateStart(s), null); // 3 playing seats: 1 mafia vs 2
  addPlayer(s, { name: 'D', token: 'n4' });
  assert.equal(applyAction(s, 'p1', { kind: 'config', target: { mafia: 2 } }), null);
  assert.match(validateStart(s), /Too many mafia for 4/); // host's seat doesn't count
  removePlayer(s, 'p5');
  assert.equal(applyAction(s, 'p1', { kind: 'config', target: { mafia: 1, jester: 1 } }), null);
  assert.equal(applyAction(s, 'p1', { kind: 'start' }, () => 0.1), null);
  assert.equal(byName(s, 'Host').role, null);
  assert.deepEqual(s.players.filter((p) => !p.isHost).map((p) => p.role).sort(), ['civilian', 'jester', 'mafia']);
  assert.equal(applyAction(s, 'p1', { kind: 'ready' }), 'The narrator does not play');
  ['p2', 'p3'].forEach((id) => applyAction(s, id, { kind: 'ready' }));
  assert.equal(s.phase, 'roles');
  assert.equal(viewFor(s, 'p1').roles, undefined); // no roles for the narrator yet
  applyAction(s, 'p4', { kind: 'ready' });
  assert.equal(s.phase, 'narrate');
  assert.equal(viewFor(s, 'p1').roles.length, 3);
  for (const id of ['p2', 'p3', 'p4']) {
    const v = JSON.stringify(viewFor(s, id));
    assert.ok(!('roles' in viewFor(s, id)));
    assert.ok(!JSON.stringify(viewFor(s, id).players).includes('role'), v); // no one else's role
  }
  const mafia = s.players.find((p) => p.role === 'mafia');
  const jester = s.players.find((p) => p.role === 'jester');
  const civ = s.players.find((p) => p.role === 'civilian');
  assert.equal(applyAction(s, civ.id, { kind: 'mark', target: { id: mafia.id, how: 'voted' } }), 'Only the host can do that');
  assert.equal(applyAction(s, 'p1', { kind: 'mark', target: { id: 'p1', how: 'killed' } }), 'Invalid player');
  assert.equal(applyAction(s, 'p1', { kind: 'mark', target: { id: civ.id, how: 'shot' } }), 'Invalid mark');
  // killed jester: no jester win; undo; then voted-out jester wins
  assert.equal(applyAction(s, 'p1', { kind: 'mark', target: { id: jester.id, how: 'killed' } }), null);
  assert.equal(s.phase, 'over'); // 1 mafia vs 1 civilian: parity
  assert.equal(s.winner, 'mafia');
  assert.equal(viewFor(s, 'p1').roles.length, 3); // narrator excluded from the lineup
  // new game from any phase goes back to the lobby with the same people
  assert.equal(applyAction(s, 'p2', { kind: 'newgame' }), 'Only the host can do that');
  assert.equal(applyAction(s, 'p1', { kind: 'newgame' }), null);
  assert.equal(s.phase, 'lobby');
  assert.equal(s.players.length, 4);
  assert.ok(s.players.every((p) => p.alive && !p.role && !p.out));
  assert.equal(applyAction(s, 'p1', { kind: 'newgame' }), 'Already in the lobby');
  // second game: jester voted out wins; undo works
  applyAction(s, 'p1', { kind: 'start' }, () => 0.7);
  ['p2', 'p3', 'p4'].forEach((id) => applyAction(s, id, { kind: 'ready' }));
  const j = s.players.find((p) => p.role === 'jester');
  const c = s.players.find((p) => p.role === 'civilian');
  applyAction(s, 'p1', { kind: 'mark', target: { id: c.id, how: 'voted' } });
  assert.equal(s.phase, 'over'); // parity again
  applyAction(s, 'p1', { kind: 'newgame' });
  applyAction(s, 'p1', { kind: 'start' }, () => 0.7);
  ['p2', 'p3', 'p4'].forEach((id) => applyAction(s, id, { kind: 'ready' }));
  const j2 = s.players.find((p) => p.role === 'jester');
  const c2 = s.players.find((p) => p.role === 'civilian');
  applyAction(s, 'p1', { kind: 'mark', target: { id: c2.id, how: 'killed' } });
  assert.equal(s.phase, 'over');
  applyAction(s, 'p1', { kind: 'newgame' });
  applyAction(s, 'p1', { kind: 'start' }, () => 0.7);
  ['p2', 'p3', 'p4'].forEach((id) => applyAction(s, id, { kind: 'ready' }));
  const j3 = s.players.find((p) => p.role === 'jester');
  assert.equal(applyAction(s, 'p1', { kind: 'mark', target: { id: j3.id, how: 'voted' } }), null);
  assert.equal(s.winner, 'jester');
  assert.deepEqual(s.winnerIds, [j3.id]);
}
// narrator undo: marking someone back alive
{
  const s = createGame('UNDO');
  ['Host', 'A', 'B', 'C', 'D', 'E'].forEach((n, i) => addPlayer(s, { name: n, token: 'u' + i, isHost: !i }));
  applyAction(s, 'p1', { kind: 'config', target: { narrator: true, doctor: 0, detective: 0 } });
  applyAction(s, 'p1', { kind: 'start' });
  s.players.filter((p) => !p.isHost).forEach((p) => applyAction(s, p.id, { kind: 'ready' }));
  const c = s.players.find((p) => p.role === 'civilian');
  applyAction(s, 'p1', { kind: 'mark', target: { id: c.id, how: 'killed' } });
  assert.equal(viewFor(s, 'p1').roles.find((r) => r.id === c.id).out, 'killed');
  assert.equal(viewFor(s, c.id).you.alive, false);
  applyAction(s, 'p1', { kind: 'mark', target: { id: c.id, how: 'alive' } });
  assert.equal(c.alive, true);
  assert.equal(s.phase, 'narrate');
  const m = s.players.find((p) => p.role === 'mafia');
  applyAction(s, 'p1', { kind: 'mark', target: { id: m.id, how: 'voted' } });
  assert.equal(s.winner, 'town');
}

// ---- the dead answer the night question (optional, never block); they watch votes live
{
  const s = setup(['mafia', 'mafia', 'doctor', 'civilian', 'civilian', 'civilian', 'civilian'], { mafia: 2, doctor: 1, detective: 0 });
  allReady(s);
  nightAll(s, { p1: 'p4', p2: 'p4', p3: 'p5' }); // p4 dies
  assert.equal(s.phase, 'dawn');
  advance(s); // vote
  act(s, 1, 'vote', 'p2'); act(s, 6, 'vote', 'skip');
  const dead = viewFor(s, 'p4');
  assert.deepEqual(dead.liveVotes, [{ from: 'P1', to: 'P2' }, { from: 'P6', to: null }]);
  assert.deepEqual(dead.targets, []);
  assert.equal(act(s, 4, 'vote', 'p1'), 'You are dead');
  assert.equal(viewFor(s, 'p5').liveVotes, undefined); // the living only see who has voted
  assert.equal(dead.roles.find((r) => r.id === 'p1').role, 'mafia'); // the dead see every role
  assert.equal(viewFor(s, 'p5').roles, undefined);
  ['p2', 'p3', 'p5', 'p7'].forEach((id) => act(s, +id.slice(1), 'vote', 'skip'));
  advance(s); // night 2
  assert.equal(s.phase, 'night');
  const dv = viewFor(s, 'p4');
  assert.equal(dv.question, s.night.question); // the dead get the question too
  assert.ok(dv.targets.includes('p4') && dv.targets.includes('p1'));
  // everyone alive locks first: the night must not wait for the dead
  nightAll(s, { p1: 'p5', p2: 'p5', p3: 'p6' }, undefined, ['p4']);
  assert.equal(s.phase, 'dawn');
  assert.equal(sel(s, 4, 'p1'), 'Wrong phase'); // too late, that's fine
}
{
  // a dead player who answers in time is recorded
  const s = setup(['mafia', 'civilian', 'civilian', 'civilian', 'civilian'], { mafia: 1, doctor: 0, detective: 0 });
  allReady(s);
  nightAll(s, { p1: 'p2' });
  advance(s);
  ['p1', 'p3', 'p4', 'p5'].forEach((id) => act(s, +id.slice(1), 'vote', 'skip'));
  advance(s);
  assert.equal(sel(s, 2, 'p2'), null); // dead p2 names themselves
  assert.equal(lock(s, 2), null);
  assert.equal(s.funLog.at(-1).answers.p2, 'p2');
}
// ---- mafia may kill a teammate or themselves; the dawn reveals no role
{
  const s = setup(['mafia', 'mafia', 'civilian', 'civilian', 'civilian', 'civilian', 'civilian'], { mafia: 2, doctor: 0, detective: 0 });
  allReady(s);
  assert.ok(viewFor(s, 'p1').targets.includes('p1') && viewFor(s, 'p1').targets.includes('p2'));
  nightAll(s, { p1: 'p2', p2: 'p2' });
  assert.equal(s.phase, 'dawn');
  assert.deepEqual(viewFor(s, 'p5').event, { killedId: 'p2', killedName: 'P2' });
  assert.ok(!JSON.stringify(viewFor(s, 'p5').players).includes('role'), 'dawn must not reveal the role');
}
{
  // the last mafia killing themselves hands the town the win
  const s = setup(['mafia', 'civilian', 'civilian', 'civilian'], { mafia: 1, doctor: 0, detective: 0 });
  allReady(s);
  nightAll(s, { p1: 'p1' });
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 'town');
}

// ---- a kicked player who rejoins is waited on again
{
  const s = setup(['mafia', 'doctor', 'civilian', 'civilian', 'civilian', 'civilian']);
  allReady(s);
  assert.equal(act(s, 1, 'kick', 'p4'), null);
  rejoin(s, 'p4');
  assert.equal(s.players[3].kicked, false);
  nightAll(s, { p1: 'p5' }, undefined, ['p4']);
  assert.equal(s.phase, 'night'); // waits for p4 again
  nightAll(s);
  assert.equal(s.phase, 'dawn');
}

console.log('game.test.js: all checks passed');
