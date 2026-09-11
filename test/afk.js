/**
 * AFK handling.
 *
 * This exists because of a real deadlock: a player waiting alone for an
 * opponent was auto-marked AFK, which meant the room could never see two
 * available players, so it never started a match, so nobody ever pressed a
 * movement key, so nobody ever came back. The room sat there forever with one
 * player on red and one in spectators.
 *
 * Run with: npm run test:afk
 */
process.chdir(require('path').resolve(__dirname, '..'));

const assert = require('assert');
const { createAfk } = require('../src/modules/afk');
const { createRegistry } = require('../src/modules/players');
const { TEAM } = require('../src/modules/teams');

const config = { afkSeconds: 1, afkWarnSeconds: 0.5, afkTickMs: 50, autoStart: true };

function makeWorld() {
  let players = [];
  let started = false;
  const said = [];
  const calls = [];
  const kicked = [];

  const discs = new Map();

  const room = {
    getPlayerList: () => players.map((p) => ({ ...p })),
    getPlayer: (id) => players.find((p) => p.id === id) || null,
    getScores: () => (started ? { red: 0, blue: 0 } : null),
    // Idleness is measured from whether the player's disc actually moved.
    // onPlayerActivity only fires on a key *press*, so somebody holding a
    // direction while chasing the ball looked exactly like somebody who had
    // walked away — which is what made it kick people mid-match.
    getPlayerDiscProperties: (id) => {
      const p = players.find((x) => x.id === id);
      if (!started || !p || p.team === 0) return null;
      return discs.get(id) || { x: 0, y: 0 };
    },
    setPlayerTeam: (id, team) => {
      const p = players.find((x) => x.id === id);
      if (p) p.team = team;
    },
    kickPlayer: (id) => {
      kicked.push(id);
      players = players.filter((x) => x.id !== id);
      registry.remove(id);
    },
  };

  const chat = {
    info: (m) => said.push(String(m)),
    ok: (m) => said.push(String(m)),
    dim: (m) => said.push(String(m)),
    error: (m) => said.push(String(m)),
    hype: (m) => said.push(String(m)),
  };

  const registry = createRegistry();
  const teams = {
    onPlayerLeave: (p) => calls.push(['leave', p.id]),
    onPlayerAvailable: (id) => calls.push(['available', id]),
    maybeStart: () => calls.push(['maybeStart']),
    isPaused: false,
    mode: { name: '2v2', solo: false },
  };

  const afk = createAfk({ room, chat, registry, config, teams });

  const add = (id, team) => {
    const p = { id, name: `p${id}`, team, admin: false, auth: `a${id}`, conn: `c${id}` };
    players.push(p);
    const rec = registry.add(p);
    rec.lastActivity = 0; // long idle
    return p;
  };

  return {
    afk,
    registry,
    said,
    calls,
    kicked,
    add,
    teams,
    discs,
    /**
     * Idle means two samples with no movement between them AND the clock run
     * out. The first sample only establishes where everyone is, so it counts
     * as activity — otherwise a player would be judged on no evidence at all.
     */
    sweepAfter: (idleMs) => {
      afk.sweep(); // first sample: establishes where everybody is
      const then = Date.now() - idleMs;
      for (const rec of registry.all()) rec.lastActivity = then;
      afk.sweep(); // second sample: nobody moved, and the clock has run
    },
    moveTo: (id, x, y) => discs.set(id, { x, y }),
    get players() {
      return players;
    },
    setGameRunning: (v) => {
      started = v;
    },
  };
}

// ---- the deadlock: no auto-AFK while the room is idle -------------------
{
  const w = makeWorld();
  w.add(1, TEAM.RED); // alone on red, waiting for an opponent
  w.setGameRunning(false);

  w.sweepAfter(1500);

  assert.strictEqual(w.registry.get(1).afk, false, 'a player waiting alone is NOT marked AFK');
  assert.strictEqual(w.players[0].team, TEAM.RED, 'and is not moved to spectators');
}

// ---- during a match, idling gets you kicked out of the room -------------
// Parking idle players in spectators looked gentler and was much worse: they
// stayed in the room flagged unavailable, and only they could clear the flag —
// which somebody who has walked away by definition does not do. The room
// filled up with players who were present but did not count, so the bot saw
// five players where there were eight, stopped scrambling at full strength,
// asked for captain picks instead, and eventually collapsed onto the small
// pitch with half the room stranded. Kicking keeps "who is here" and "who can
// play" the same thing.
{
  const w = makeWorld();
  w.add(1, TEAM.RED);
  w.setGameRunning(true);

  w.sweepAfter(1500); // two samples, no movement, clock run out

  assert.deepStrictEqual(w.kicked, [1], 'kicked out of the room');
  assert.strictEqual(w.players.length, 0, 'and gone from the player list');
  assert(w.said.some((m) => m.includes('AFK')), 'announced');
  assert(
    w.said.some((m) => m.includes('volver a entrar')),
    'and told they can come straight back'
  );
}

// ---- spectators are never swept ----------------------------------------
{
  const w = makeWorld();
  w.add(1, TEAM.SPEC);
  w.setGameRunning(true);

  w.sweepAfter(1500);
  assert.strictEqual(w.registry.get(1).afk, false, 'spectators are left alone');
  assert.deepStrictEqual(w.kicked, [], 'and never kicked');
}

// ---- nobody is swept during a captain's pause ---------------------------
// The match still counts as running while it is paused, but nobody can move,
// so a ten second timeout would mark the whole pitch AFK while the captain
// decides on a substitution.
{
  const w = makeWorld();
  w.add(1, TEAM.RED);
  w.setGameRunning(true);
  w.teams.isPaused = true;

  w.sweepAfter(1500);
  assert.deepStrictEqual(w.kicked, [], 'not kicked during a pause');
  assert.strictEqual(w.players[0].team, TEAM.RED, 'still on the pitch');
}

// ---- a warning comes first ---------------------------------------------
// Ten seconds is short. Being yanked off the pitch with no notice at all
// would feel broken, so there is a warning partway through, to that player
// only, once per idle stretch.
{
  const w = makeWorld();
  const p = w.add(1, TEAM.RED);
  w.setGameRunning(true);
  w.sweepAfter(700); // past the warning, not the limit
  assert.deepStrictEqual(w.kicked, [], 'not kicked yet');
  assert(w.said.some((m) => m.includes('¿Sigues ahí?')), 'but warned');
  assert.strictEqual(p.team, TEAM.RED, 'still playing');

  const warnings = w.said.filter((m) => m.includes('¿Sigues ahí?')).length;
  w.afk.sweep();
  assert.strictEqual(
    w.said.filter((m) => m.includes('¿Sigues ahí?')).length,
    warnings,
    'and only warned once, not on every tick'
  );
}

// ---- moving in time saves you -------------------------------------------
{
  const w = makeWorld();
  w.add(1, TEAM.RED);
  w.setGameRunning(true);

  w.afk.markActivity(1); // they pressed a key
  w.afk.sweep();
  w.afk.sweep();

  assert.deepStrictEqual(w.kicked, [], 'nobody kicked');
  assert.strictEqual(w.players.length, 1, 'still in the room');
}

// ---- a player holding a key is NOT idle ---------------------------------
// The bug that made this whole rewrite necessary. onPlayerActivity fires on a
// key *press*, not while one is held, so a player running flat out after the
// ball produced no events at all and got kicked mid-run. Movement is what
// actually distinguishes playing from gone.
{
  const w = makeWorld();
  w.add(1, TEAM.RED);
  w.setGameRunning(true);
  w.registry.get(1).lastActivity = 0; // no key press for a very long time

  w.moveTo(1, 0, 0);
  w.afk.sweep();
  w.moveTo(1, 120, 40); // chasing the ball, no new key press
  w.afk.sweep();
  w.moveTo(1, 260, 90);
  w.afk.sweep();

  assert.deepStrictEqual(w.kicked, [], 'a moving player is never kicked');
  assert(
    !w.said.some((m) => m.includes('¿Sigues ahí?')),
    'and is not even warned'
  );
}

// ---- the training pitch is exempt ---------------------------------------
// Practising alone holds nobody up, and there is no match to protect.
{
  const w = makeWorld();
  w.add(1, TEAM.RED);
  w.setGameRunning(true);
  w.teams.mode = { name: 'entrenamiento', solo: true };

  w.sweepAfter(1500);
  assert.deepStrictEqual(w.kicked, [], 'nobody is kicked off the training pitch');
}

// ---- a voluntary !afk parks you in spectators, it does not kick you -----
// Choosing to sit out is different from wandering off. You stay in the room,
// you are visible in !afks, and !afk again brings you back.
{
  const w = makeWorld();
  w.add(1, TEAM.RED);
  w.setGameRunning(true);

  w.afk.toggle(1);
  assert.strictEqual(w.registry.get(1).afk, true, 'marked away');
  assert.strictEqual(w.players[0].team, TEAM.SPEC, 'and off the pitch');
  assert.deepStrictEqual(w.kicked, [], 'but still in the room');

  w.sweepAfter(1500);
  assert.deepStrictEqual(w.kicked, [], 'and the sweep leaves spectators alone');

  w.afk.toggle(1);
  assert.strictEqual(w.registry.get(1).afk, false, '!afk again brings you back');
  assert(
    w.calls.some(([kind, id]) => kind === 'available' && id === 1),
    'and the room is told, so they rejoin the queue'
  );
}

// ---- a pause does not count as idling -----------------------------------
// The worst bug in the room: nobody can move while the game is frozen, so
// after a fifteen second !pausa everyone had been "idle" for fifteen seconds
// and the next sweep put the entire pitch in spectators, taking the match with
// it. The captain was the only survivor, because typing counts as activity.
{
  const w = makeWorld();
  w.add(1, TEAM.RED);
  w.add(2, TEAM.BLUE);
  w.setGameRunning(true);
  w.teams.isPaused = true;

  // Fifteen seconds pass with nobody able to move.
  w.afk.sweep();
  assert.strictEqual(w.registry.get(1).afk, false, 'nobody swept during the pause');

  // Play resumes, and the bot forgives the time nobody could have used.
  w.teams.isPaused = false;
  w.afk.forgiveIdle();
  w.afk.sweep();

  assert.strictEqual(w.registry.get(1).afk, false, 'still playing after the restart');
  assert.strictEqual(w.registry.get(2).afk, false, 'both of them');
  assert.strictEqual(w.players[0].team, TEAM.RED, 'nobody was moved');
  assert.strictEqual(w.players[1].team, TEAM.BLUE);
}

// ---- manual toggle ------------------------------------------------------
{
  const w = makeWorld();
  w.add(1, TEAM.RED);

  w.afk.toggle(1);
  assert.strictEqual(w.registry.get(1).afk, true, '!afk marks you away');
  assert.strictEqual(w.players[0].team, TEAM.SPEC, 'and takes you off the pitch');

  w.afk.toggle(1);
  assert.strictEqual(w.registry.get(1).afk, false, '!afk again brings you back');
  assert(
    w.calls.some(([kind, id]) => kind === 'available' && id === 1),
    'and requeues you'
  );
}

console.log('\nAll AFK tests passed.\n');
