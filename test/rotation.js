/**
 * Match rotation and mode switching, tested against a fake Haxball room.
 *
 * This is the part players notice most: does the right mode get picked, does
 * the winner stay on, and does the queue actually take turns in order?
 *
 * Run with: npm run test:rotation
 */
process.chdir(require('path').resolve(__dirname, '..'));

const assert = require('assert');
const { createTeams, TEAM } = require('../src/modules/teams');
const { createRegistry } = require('../src/modules/players');
const modes = require('../src/modules/modes');

const config = {
  repeatQuietMs: 90000,
  instantModeSwitch: true,
  modeSwitchCooldownMs: 0,
  teamSize: 4,
  autoStart: true,
  scoreLimit: 3,
  timeLimit: 3,
  rebuildDelayMs: 50,
  lobbyPauseMs: 50,
  pickSeconds: 0.2,
  pauseSeconds: 0.3,
  stopSettleMs: 10,
  confirmDelayMs: 20,
  spawnRetryMs: 10,
};

function makeWorld({ withHost = false, configOverride = {} } = {}) {
  const cfg = { ...config, ...configOverride };
  // With BOT_NAME set, Haxball puts a host player at id 0 in the spectator
  // list. It must be completely invisible to the queue and mode logic.
  let players = withHost ? [{ id: 0, name: 'BOT', team: 0, admin: true }] : [];
  let started = false;
  let stadium = null;
  const said = [];
  const kicked = [];
  const placed = [];
  const discs = new Map();
  let stops = 0;
  let paused = false;

  const room = {
    getPlayerList: () => players.map((p) => ({ ...p })),
    getPlayer: (id) => players.find((p) => p.id === id) || null,
    getScores: () => (started ? { red: 0, blue: 0 } : null),
    // The real Haxball API queues this — getPlayerList() does NOT reflect it
    // until a tick later. Simulating that is the whole point: code that reads
    // team counts back immediately after writing them is broken, and this is
    // what catches it.
    setPlayerTeam: (id, team) => {
      setTimeout(() => {
        const p = players.find((x) => x.id === id);
        if (p) p.team = team;
      }, 0);
    },
    // Real Haxball refuses to swap the stadium while a game is on, and
    // stopGame() is queued — so code that stops and swaps in the same tick
    // blows up in production and passed happily against the old fake.
    setCustomStadium: (s) => {
      if (started) throw new Error('Can\'t change stadium while a game is in progress');
      stadium = JSON.parse(s).name;
    },
    setScoreLimit: () => {},
    setTimeLimit: () => {},
    setTeamsLock: () => {},
    setKickRateLimit: () => {},
    // A player only has a disc while a game is running and they are on a team.
    // Ask for one at any other moment and you get null — which is exactly what
    // made the first attempt at spawn placement a silent no-op.
    getPlayerDiscProperties: (id) => {
      const p = players.find((x) => x.id === id);
      if (!started || !p || p.team === 0) return null;
      return discs.get(id) || { x: 0, y: 0, xspeed: 0, yspeed: 0 };
    },
    setPlayerDiscProperties: (id, props) => {
      const p = players.find((x) => x.id === id);
      if (!started || !p || p.team === 0) return; // silently ignored, like the real thing
      discs.set(id, { ...(discs.get(id) || {}), ...props });
      placed.push({ id, ...props });
    },
    // Both of these are queued in the real API. startGame() while a game is
    // still running is ignored outright.
    startGame: () => {
      if (started) return;
      setTimeout(() => {
        started = true;
      }, 0);
    },
    stopGame: () => {
      stops++;
      setTimeout(() => {
        started = false;
        discs.clear();
      }, 0);
    },
    pauseGame: (v) => {
      paused = !!v;
    },
    sendAnnouncement: (m) => said.push(String(m)),
    kickPlayer: (id) => {
      kicked.push(id);
      const p = players.find((x) => x.id === id);
      players = players.filter((x) => x.id !== id);
      registry.remove(id);
      if (p) teams.onPlayerLeave(p);
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
  const guard = { applySettings: () => {} };
  const teams = createTeams({ room, chat, registry, config: cfg, guard });

  const join = (id, name) => {
    const p = { id, name: name || `p${id}`, team: 0, admin: false, auth: `a${id}`, conn: `c${id}` };
    players.push(p);
    registry.add(p);
    teams.onPlayerJoin(p);
    return p;
  };
  const leave = (id) => {
    const p = players.find((x) => x.id === id);
    players = players.filter((x) => x.id !== id);
    registry.remove(id);
    if (p) teams.onPlayerLeave(p);
  };

  const sideNames = (team) =>
    players.filter((p) => p.team === team).map((p) => p.name).sort().join(',');

  return {
    room,
    teams,
    registry,
    kicked,
    placed,
    chat: (id, msg) => teams.tryPick({ id }, msg),
    join,
    leave,
    said,
    get players() {
      return players;
    },
    get stadium() {
      return stadium;
    },
    get started() {
      return started;
    },
    /** How many times the match has been torn down. Interruptions, counted. */
    get stops() {
      return stops;
    },
    get paused() {
      return paused;
    },
    sideNames,
    /** Kill the match behind the bot's back, the way a lost race would. */
    forceStop: () => {
      started = false;
      discs.clear();
    },
    // buildMatch is scheduled on a timer, so tests have to wait for it.
    //
    // Sleeping a fixed number of milliseconds and hoping produced a flaky
    // assertion in three releases running, and each one cost a deploy while we
    // worked out whether it was a real race or just a slow machine. So wait for
    // the bot to actually go quiet instead: no rebuild pending, no line-up
    // waiting to be confirmed, and stable across two ticks so a rebuild that is
    // about to be scheduled still counts as busy.
    //
    // If it never goes quiet, that is a genuine bug and the assertions that
    // follow will say so.
    quiet: async (ms = 4000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        await new Promise((r) => setTimeout(r, 5));
        if (!teams.busy) {
          await new Promise((r) => setTimeout(r, 10));
          if (!teams.busy) return;
        }
        if (Date.now() >= deadline) {
          // Never went quiet. That is a real bug, not a slow machine, so leave
          // a diagnosis next to whichever assertion is about to fail.
          console.error(
            '[test] bot still busy after ' + ms + 'ms:',
            JSON.stringify(teams.debugState())
          );
          return;
        }
      }
    },
    // Still needed where the assertion is that something did NOT happen: there
    // you have to give the bad thing time to occur.
    settle: () => new Promise((r) => setTimeout(r, 150)),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

async function run() {
  // ---- 2 players => 1v1 on the small pitch ----------------------------
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, '1v1', 'two players get a 1v1');
    assert(/1v1/.test(w.stadium), `small pitch loaded (got ${w.stadium})`);
    assert.strictEqual(w.sideNames(TEAM.RED), 'p1', 'p1 on red');
    assert.strictEqual(w.sideNames(TEAM.BLUE), 'p2', 'p2 on blue');
    assert(w.started, 'match started');
  }

  // ---- 3 players => still 1v1, third waits ----------------------------
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    w.join(3);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, '1v1', 'three players still 1v1');
    const playing = w.players.filter((p) => p.team !== TEAM.SPEC).length;
    assert.strictEqual(playing, 2, 'only two on the pitch');
    assert.deepStrictEqual(
      w.teams.queueList.map((id) => w.registry.get(id).name),
      ['p3'],
      'the last to arrive waits'
    );
  }

  // ---- winner stays, loser goes to the back of the queue --------------
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    w.join(3);
    await w.quiet();

    // red (p1) wins
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.quiet();

    assert.strictEqual(w.sideNames(TEAM.RED), 'p1', 'winner stayed on');
    assert.strictEqual(w.sideNames(TEAM.BLUE), 'p3', 'next in queue came on');
    assert.deepStrictEqual(
      w.teams.queueList.map((id) => w.registry.get(id).name),
      ['p2'],
      'loser went to the back'
    );

    // p1 wins again; p2 should get their turn back
    w.teams.onGameEnd({ red: 3, blue: 1 });
    await w.quiet();
    assert.strictEqual(w.sideNames(TEAM.BLUE), 'p2', 'queue rotates in order');
  }

  // ---- growing to 4 players switches to 2v2 and swaps the map ---------
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '1v1');

    w.teams.onGameEnd({ red: 3, blue: 0 }); // red wins
    w.join(3);
    w.join(4);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, '2v2', 'four players unlock 2v2');
    assert(/4v4/.test(w.stadium), `big pitch loaded (got ${w.stadium})`);
    assert.strictEqual(w.players.filter((p) => p.team !== TEAM.SPEC).length, 4, 'all four playing');
  }

  // ---- eight players => 4v4 ------------------------------------------
  {
    const w = makeWorld();
    for (let i = 1; i <= 8; i++) w.join(i);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, '4v4', 'eight players get 4v4');
    assert.strictEqual(w.players.filter((p) => p.team === TEAM.RED).length, 4, 'red full');
    assert.strictEqual(w.players.filter((p) => p.team === TEAM.BLUE).length, 4, 'blue full');
    assert.strictEqual(w.teams.queueList.length, 0, 'nobody waiting');
  }

  // ---- nine players => 4v4 with one waiting ---------------------------
  {
    const w = makeWorld();
    for (let i = 1; i <= 9; i++) w.join(i);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, '4v4', 'nine players still 4v4');
    assert.strictEqual(w.players.filter((p) => p.team !== TEAM.SPEC).length, 8, 'eight on the pitch');
    assert.strictEqual(w.teams.queueList.length, 1, 'the ninth waits');
  }

  // ---- shrinking: 4v4 down to 1v1 keeps surplus winners at the front --
  {
    const w = makeWorld();
    for (let i = 1; i <= 8; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '4v4');

    const redNames = w.players.filter((p) => p.team === TEAM.RED).map((p) => p.name);
    w.teams.onGameEnd({ red: 3, blue: 0 }); // red wins

    // six of the eight walk out, leaving two
    const leaving = w.players.filter((p) => !redNames.slice(0, 1).includes(p.name)).slice(0, 6);
    leaving.forEach((p) => w.leave(p.id));
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, '1v1', 'falls back to 1v1');
    assert(/1v1/.test(w.stadium), 'small pitch restored');
    assert.strictEqual(w.players.filter((p) => p.team !== TEAM.SPEC).length, 2, 'a 1v1 is running');
  }

  // ---- AFK players do not count toward the mode ----------------------
  {
    const w = makeWorld();
    for (let i = 1; i <= 4; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '2v2', '2v2 with four available');

    // two of them go AFK
    w.registry.get(3).afk = true;
    w.registry.get(4).afk = true;
    w.teams.setupNextMatch(null);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, '1v1', 'AFK players are not counted');
  }

  // ---- admin can pin a mode ------------------------------------------
  {
    const w = makeWorld();
    for (let i = 1; i <= 8; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '4v4');

    w.teams.force(modes.byName('1v1'));
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '1v1', 'forced mode wins over the auto pick');
    assert.strictEqual(w.teams.queueList.length, 6, 'the rest queue up');

    w.teams.force(null);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '4v4', 'back to automatic');
  }

  // ---- a lone player gets the training pitch --------------------------
  {
    const w = makeWorld();
    w.join(1);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, 'entrenamiento', 'solo mode');
    assert(/Training/i.test(w.stadium), `training pitch loaded (got ${w.stadium})`);
    assert(w.started, 'and it actually starts, so they can shoot around');
    assert.strictEqual(w.players.filter((p) => p.team === TEAM.RED).length, 1, 'on red');
    assert(w.said.some((m) => m.includes('entrenamiento')), 'explained in chat');
  }

  // ---- and a second player turns it into a real 1v1 -------------------
  {
    const w = makeWorld();
    w.join(1);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, 'entrenamiento');

    w.join(2);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, '1v1', 'upgraded out of training');
    assert(/1v1/.test(w.stadium), 'switched to the 1v1 pitch');
    assert.strictEqual(w.players.filter((p) => p.team !== TEAM.SPEC).length, 2, 'both playing');
    assert(w.started, 'match running');
  }

  // ---- everyone leaving drops back to training ------------------------
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '1v1');

    w.leave(2);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, 'entrenamiento', 'back to training alone');
    assert(/Training/i.test(w.stadium), 'training pitch again');
  }

  // ---- the BOT host player is never treated as a participant ----------
  {
    const w = makeWorld({ withHost: true });
    w.join(1);
    w.join(2);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, '1v1', 'the bot does not count toward the mode');
    assert.strictEqual(w.sideNames(TEAM.RED), 'p1', 'p1 on red, not the bot');
    assert.strictEqual(w.sideNames(TEAM.BLUE), 'p2', 'p2 on blue, not the bot');
    assert(!w.teams.queueList.includes(0), 'the bot is never queued');
    assert.strictEqual(
      w.players.find((p) => p.id === 0).team,
      TEAM.SPEC,
      'the bot stays in spectators'
    );
    assert.strictEqual(w.teams.availableCount(), 2, 'only the humans are counted');
  }

  // ---- with the bot present, 3 humans still means one waits -----------
  {
    const w = makeWorld({ withHost: true });
    w.join(1);
    w.join(2);
    w.join(3);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, '1v1', 'bot + 3 humans is still 1v1');
    assert.strictEqual(
      w.players.filter((p) => p.team !== TEAM.SPEC).length,
      2,
      'two on the pitch'
    );
    assert.strictEqual(w.teams.queueList.length, 1, 'one human waiting, bot excluded');

    // 4 humans should now unlock 2v2 even with the bot sitting there
    w.join(4);
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '2v2', 'bot does not inflate the count');
    assert.strictEqual(w.players.filter((p) => p.team !== TEAM.SPEC).length, 4, 'four playing');
  }

  // ---- live growth: 1v1 becomes 2v2 without stopping the match --------
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '1v1');
    assert(w.started, 'match running');
    const mapBefore = w.stadium;

    w.join(3);
    w.join(4);
    await w.quiet();

    assert(w.started, 'match was NOT interrupted');
    assert.strictEqual(w.stadium, mapBefore, 'map did not change');
    assert.strictEqual(w.teams.mode.name, '2v2', 'grew to 2v2 in place');
    assert.strictEqual(w.players.filter((p) => p.team === TEAM.RED).length, 2, 'red has 2');
    assert.strictEqual(w.players.filter((p) => p.team === TEAM.BLUE).length, 2, 'blue has 2');
    assert(w.said.some((m) => m.includes('Ahora es 2v2')), 'growth announced');
  }

  // ---- an odd joiner waits until a pair is available ------------------
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    await w.quiet();

    w.join(3);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '1v1', 'one extra is not enough');
    assert.strictEqual(w.teams.queueList.length, 1, 'the odd player waits');

    w.join(4);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '2v2', 'the pair completes the upgrade');
    assert.strictEqual(w.teams.queueList.length, 0, 'both came on');
  }

  // ---- with instant switching OFF, a map boundary waits ---------------
  {
    const w = makeWorld({ configOverride: { instantModeSwitch: false } });
    for (let i = 1; i <= 4; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '2v2');
    const mapBefore = w.stadium;

    w.join(5);
    w.join(6); // enough for 3v3, but 3v3 is on the big pitch
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, '2v2', 'does not grow across a map change');
    assert.strictEqual(w.stadium, mapBefore, 'map untouched mid-match');
    assert.strictEqual(w.teams.queueList.length, 2, 'the two newcomers wait');

    // ...but the next match picks it up
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '3v3', 'upgrades between matches');
    assert(/4v4/.test(w.stadium), 'big pitch now loaded');
  }

  // ---- exactly enough waiting => no captain, just auto-fill -----------
  {
    const w = makeWorld();
    for (let i = 1; i <= 6; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '3v3');

    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.quiet();
    assert(!w.teams.isPicking, 'no picking when the numbers are exact');
    assert(w.started, 'match started straight away');
  }

  // ---- surplus => captain picks by number ----------------------------
  {
    const w = makeWorld();
    for (let i = 1; i <= 8; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '4v4');

    // three more show up, then red wins: 7 waiting for 4 seats
    w.join(9);
    w.join(10);
    w.join(11);
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.quiet();

    assert(w.teams.isPicking, 'captain picking started');
    const captain = w.teams.captain;
    assert(captain !== null, 'there is a captain');
    assert(w.said.some((m) => m.includes('es capitán')), 'captain announced');
    assert(w.said.some((m) => m.includes('Elige:')), 'candidate list shown');

    // a non-captain trying to pick is refused
    const other = w.teams.queueList[0];
    w.chat(other, '1');
    assert(w.said.some((m) => m.includes('No eres el capitán')), 'only the captain may pick');

    // captain picks three by number
    for (let i = 0; i < 3; i++) {
      assert(w.teams.isPicking, `still picking at ${i}`);
      w.chat(captain, '1');
    }

    assert(!w.teams.isPicking, 'picking finished');
    await w.wait(20); // deferred team moves land on the next tick
    assert.strictEqual(
      w.players.filter((p) => p.team !== TEAM.SPEC).length,
      8,
      'a full 4v4 is on the pitch'
    );
    assert(w.started, 'match started after picking');
  }

  // ---- a captain who never picks loses the room ----------------------
  {
    const w = makeWorld();
    for (let i = 1; i <= 8; i++) w.join(i);
    await w.quiet();
    w.join(9);
    w.join(10);
    w.join(11);
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.quiet();

    assert(w.teams.isPicking, 'picking started');
    const slowCaptain = w.teams.captain;

    await w.wait(400); // let the pick timer expire
    assert(w.kicked.includes(slowCaptain), 'the slow captain was kicked from the room');
    assert(w.said.some((m) => m.includes('tardó demasiado')), 'timeout announced');

    await w.quiet();
    assert(w.teams.isPicking || w.started, 'the room moved on to the next captain');
  }

  // ---- rebuild requests are never dropped ----------------------------
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    // Two requests land inside the same debounce window.
    w.teams.setupNextMatch(null);
    w.teams.setupNextMatch(null);
    w.join(3);
    w.join(4);
    await w.quiet();
    await w.quiet();

    assert(w.started, 'the room still started a match');
    assert.strictEqual(
      w.players.filter((p) => p.team !== TEAM.SPEC).length,
      4,
      'all four players placed, nothing dropped'
    );
  }

  // ---- an AFK player must not deadlock the room ----------------------
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    await w.quiet();
    assert(w.started, 'a 1v1 is running');

    // p2 goes AFK: their seat is freed and the room drops to one player, which
    // now means solo training rather than a dead room.
    w.registry.get(2).afk = true;
    const p2 = w.players.find((p) => p.id === 2);
    p2.team = TEAM.SPEC;
    w.teams.onPlayerLeave(p2);
    w.teams.setupNextMatch(null);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, 'entrenamiento', 'lone player gets training');

    // p2 comes back. The match must resume without anyone else joining.
    w.registry.get(2).afk = false;
    w.teams.onPlayerAvailable(2);
    await w.quiet();

    assert.strictEqual(w.teams.availableCount(), 2, 'both available again');
    assert.strictEqual(
      w.players.filter((p) => p.team !== TEAM.SPEC).length,
      2,
      'both players are back on the pitch'
    );
    assert(w.started, 'the match restarted — no deadlock');
  }

  // ---- a joiner fills a one-seat gap in a live match ------------------
  // Found in production: someone leaves mid-match making it 2v1, the next
  // person to walk in just sat in spectators. Growth adds players in pairs so
  // it structurally cannot close an odd gap — backfill has to run too.
  {
    const w = makeWorld();
    for (let i = 1; i <= 4; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '2v2', '2v2 running');

    const blue = w.players.filter((p) => p.team === TEAM.BLUE);
    assert.strictEqual(blue.length, 2, 'blue has two');

    const stopsBefore = w.stops;
    w.leave(blue[0].id); // now 2v1, nobody waiting

    // Wait past every rebuild timer there is, so this cannot pass on luck.
    // A 2v1 is one player short, not one too many: leaving it alone and
    // waiting for a substitute is the whole point. Tearing it down to make a
    // "correct" 1v1 is an interruption, and it used to happen every time.
    await w.wait(150);
    assert.strictEqual(w.players.filter((p) => p.team === TEAM.BLUE).length, 1, 'blue is short');
    assert(w.started, 'the match is still running');
    assert.strictEqual(w.stops, stopsBefore, 'and nothing tore it down');

    w.join(50); // a newcomer should take the empty seat
    await w.wait(150);

    assert.strictEqual(
      w.players.filter((p) => p.team === TEAM.BLUE).length,
      2,
      'the newcomer filled the gap instead of sitting in spectators'
    );
    assert.strictEqual(w.teams.queueList.length, 0, 'nobody left waiting');
    assert(w.started, 'and the match was never interrupted');
    assert.strictEqual(w.stops, stopsBefore, 'no stopGame at any point');
  }

  // ---- a thinned-out match can be rebuilt back up ---------------------
  // The mode label lags reality: if two people leave a 2v2 it is a 1v1 on the
  // pitch while currentMode still reads "2v2". Growth has to look at who is
  // actually playing, or two newcomers get stuck in spectators.
  {
    const w = makeWorld();
    for (let i = 1; i <= 4; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '2v2');

    // One player walks out. The bot evens the sides up by benching one of the
    // others, so it becomes a 1v1 out there while the mode label still says
    // "2v2" — which is the state this test exists to cover.
    const red = w.players.filter((p) => p.team === TEAM.RED);
    w.leave(red[0].id);
    await w.wait(200);
    assert.strictEqual(w.players.filter((p) => p.team !== TEAM.SPEC).length, 2, 'down to a 1v1');
    assert.strictEqual(w.teams.queueList.length, 1, 'with the benched player waiting');

    const stopsBefore = w.stops;
    w.join(60);
    await w.wait(200);

    assert.strictEqual(
      w.players.filter((p) => p.team !== TEAM.SPEC).length,
      4,
      'built back up to 2v2 with the benched player and the newcomer'
    );
    assert(w.started, 'without interrupting the match');
    // Both modes live on the small pitch, so this must be seamless. Deciding
    // "same pitch?" from the mode label instead of the stadium that is loaded
    // is what used to send this down the stop-and-restart path.
    assert.strictEqual(w.stops, stopsBefore, 'no stop, no reset score');
  }

  // ---- reconcile rescues a stuck room, whatever the cause -------------
  // From production: 1v1 running with two more people sitting in spectators
  // and the bot doing nothing. Rather than trusting that every event path
  // fires, a timer re-checks reality. This test bypasses the join event
  // entirely to prove reconcile alone is enough.
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '1v1');
    assert(w.started, '1v1 running');

    // Two more people appear WITHOUT the join handler being told.
    for (const id of [7, 8]) {
      const p = { id, name: `p${id}`, team: 0, admin: false, auth: `a${id}`, conn: `c${id}` };
      w.players.push(p);
      w.registry.add(p);
      w.teams.setupNextMatch; // deliberately no event fired
    }
    await w.wait(30);
    assert.strictEqual(
      w.players.filter((p) => p.team !== TEAM.SPEC).length,
      2,
      'still a 1v1, since nothing told the bot'
    );

    w.teams.reconcile();
    await w.wait(30);

    assert.strictEqual(
      w.players.filter((p) => p.team !== TEAM.SPEC).length,
      4,
      'reconcile grew it to a 2v2 on its own'
    );
    assert(w.started, 'without interrupting the match');
  }

  // ---- reconcile also restarts a dead room ----------------------------
  {
    const w = makeWorld();
    for (const id of [1, 2]) {
      const p = { id, name: `p${id}`, team: 0, admin: false, auth: `a${id}`, conn: `c${id}` };
      w.players.push(p);
      w.registry.add(p);
      // again, no join event
    }
    assert(!w.started, 'nothing running');

    w.teams.reconcile();
    await w.quiet();

    assert(w.started, 'reconcile started a match from a dead room');
    assert.strictEqual(w.players.filter((p) => p.team !== TEAM.SPEC).length, 2, 'both playing');
  }

  // ---- crossing a map boundary mid-match ------------------------------
  // 2v2 lives on the small pitch, 3v3 on the big one, and Haxball will not
  // swap stadiums mid-game. Rather than leaving two people in spectators for
  // the rest of the match, the bot restarts it on the right pitch.
  {
    const w = makeWorld();
    for (let i = 1; i <= 4; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '2v2');
    assert(/1v1/.test(w.stadium), 'on the small pitch');

    const beforeRed = w.players.filter((p) => p.team === TEAM.RED).map((p) => p.name).sort();

    w.join(5);
    w.join(6);
    await w.wait(60);

    assert.strictEqual(w.teams.mode.name, '3v3', 'upgraded to 3v3');
    assert(/4v4/.test(w.stadium), 'swapped to the big pitch');
    assert.strictEqual(
      w.players.filter((p) => p.team !== TEAM.SPEC).length,
      6,
      'all six are playing'
    );
    assert(w.started, 'and a match is running again');

    // The people already playing keep their side — they are not benched in
    // favour of whoever was waiting.
    const afterRed = w.players.filter((p) => p.team === TEAM.RED).map((p) => p.name);
    for (const name of beforeRed) {
      assert(afterRed.includes(name), `${name} kept their place on red`);
    }
  }

  // ---- it will not interrupt if it cannot fill the bigger mode --------
  {
    const w = makeWorld();
    for (let i = 1; i <= 4; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '2v2');

    w.join(5); // only one extra — not enough for a 3v3
    await w.wait(60);

    assert.strictEqual(w.teams.mode.name, '2v2', 'stayed put');
    assert(/1v1/.test(w.stadium), 'map untouched');
    assert.strictEqual(w.teams.queueList.length, 1, 'the extra waits');
  }

  // ---- a side that loses a player is evened up, not left short --------
  // A 3v3 that loses somebody becomes a 2v2, immediately, without stopping the
  // match. The spare goes to the FRONT of the queue: they were playing through
  // no fault of their own, so they get first refusal on the next seat.
  {
    const w = makeWorld();
    for (let i = 1; i <= 6; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '3v3', 'a 3v3 is running');
    assert.strictEqual(w.teams.queueList.length, 0, 'with nobody waiting');

    const stopsBefore = w.stops;
    const blue = w.players.filter((p) => p.team === TEAM.BLUE);
    w.leave(blue[0].id);
    await w.wait(150);

    const red = w.players.filter((p) => p.team === TEAM.RED).length;
    const blueLeft = w.players.filter((p) => p.team === TEAM.BLUE).length;
    assert.strictEqual(red, 2, 'red gave one up');
    assert.strictEqual(blueLeft, 2, 'so the sides are level at 2v2');
    assert.strictEqual(w.teams.queueList.length, 1, 'and the spare is waiting');
    assert(w.started, 'the match never stopped');
    assert.strictEqual(w.stops, stopsBefore, 'nothing was torn down');
  }

  // ---- and a substitute is preferred over benching somebody -----------
  {
    const w = makeWorld();
    for (let i = 1; i <= 7; i++) w.join(i);
    await w.quiet();
    while (w.teams.isPicking) {
      w.chat(w.teams.captain, '1');
      await w.wait(20);
    }
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '3v3');
    assert.strictEqual(w.teams.queueList.length, 1, 'one player waiting');

    const blue = w.players.filter((p) => p.team === TEAM.BLUE);
    w.leave(blue[0].id);
    await w.wait(150);

    assert.strictEqual(
      w.players.filter((p) => p.team !== TEAM.SPEC).length,
      6,
      'the waiting player came on instead of somebody being benched'
    );
    assert(w.started, 'and the match never stopped');
  }

  // ---- reconcile must not flood the chat ------------------------------
  // Reported in production: "Equipo incompleto y no hay nadie en la fila."
  // repeating every few seconds. Anything reconcile re-checks has to be said
  // once, not on every tick. Reachable now only when evening up is impossible,
  // i.e. one side would be left empty.
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    await w.quiet();

    const blue = w.players.filter((p) => p.team === TEAM.BLUE);
    w.leave(blue[0].id); // 1v0: there is nobody to take off
    await w.wait(20);

    const count = () => w.said.filter((m) => m.includes('Equipo incompleto')).length;
    const before = count();

    for (let i = 0; i < 10; i++) {
      w.teams.reconcile();
      await w.wait(5);
    }

    const added = count() - before;
    assert(added <= 1, `announced at most once across ten ticks (got ${added})`);
  }

  // ---- one of two players goes AFK => the other gets training ---------
  // Reported in production: two people, one goes AFK, and the remaining
  // player was left on a dead 1v1 pitch instead of being moved to training.
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '1v1', 'a 1v1 is running');

    // p2 goes AFK exactly the way the sweep does it.
    w.registry.get(2).afk = true;
    const p2 = w.players.find((p) => p.id === 2);
    p2.team = TEAM.SPEC;
    w.teams.onPlayerLeave(p2);

    await w.quiet();

    assert.strictEqual(w.teams.mode.name, 'entrenamiento', 'switched to training');
    assert(/Training/i.test(w.stadium), 'training pitch loaded');
    assert.strictEqual(
      w.players.filter((p) => p.id === 1 && p.team === TEAM.RED).length,
      1,
      'the awake player is on the pitch, not stranded'
    );
    assert(w.started, 'and can actually play');

    // ...and when they come back it returns to a 1v1
    w.registry.get(2).afk = false;
    w.teams.onPlayerAvailable(2);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '1v1', 'back to a real match');
    assert.strictEqual(w.players.filter((p) => p.team !== TEAM.SPEC).length, 2, 'both playing');
  }

  // ---- players added mid-match are placed on the pitch, not behind it -
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '1v1');

    w.placed.length = 0;
    w.join(3);
    w.join(4);
    await w.wait(40);
    assert.strictEqual(w.teams.mode.name, '2v2', 'grew mid-match');

    // The fake only records a placement if the player actually had a disc at
    // the time — which is the whole point. Setting disc properties in the same
    // tick as the team change silently does nothing, and that is exactly how
    // the first version of this shipped: tests green, players behind the net.
    await w.wait(120);
    assert.strictEqual(w.placed.length, 2, 'both newcomers were positioned');

    const goalX = modes.mapGeometry('futsal1v1.hbs').goalX;
    for (const spot of w.placed) {
      assert(Math.abs(spot.x) > 50, 'placed off the centre spot');
      assert(Math.abs(spot.x) < goalX - 50, 'and short of the goal line, not behind the net');
      assert(Math.abs(spot.y) < modes.mapGeometry('futsal1v1.hbs').halfHeight, 'inside the touchlines');
      assert.strictEqual(spot.xspeed, 0, 'and stationary');
    }
    // red on the negative half, blue on the positive
    const redSpot = w.placed.find((s) => w.players.find((p) => p.id === s.id).team === TEAM.RED);
    const blueSpot = w.placed.find((s) => w.players.find((p) => p.id === s.id).team === TEAM.BLUE);
    assert(redSpot.x < 0, 'red placed on their own half');
    assert(blueSpot.x > 0, 'blue placed on their own half');
  }

  // ---- 4v4 arrivals land on the big pitch, not the small one's numbers -
  // Spawn positions are read from the stadium file, so replacing a map cannot
  // leave a hardcoded x sitting outside the new pitch.
  {
    const w = makeWorld();
    for (let i = 1; i <= 6; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '3v3', 'a 3v3 on the big pitch');

    w.placed.length = 0;
    w.join(7);
    w.join(8);
    await w.wait(120);
    assert.strictEqual(w.teams.mode.name, '4v4', 'grew to 4v4');
    assert.strictEqual(w.placed.length, 2, 'both were positioned');

    const big = modes.mapGeometry('futsal4v4.hbs').goalX;
    const small = modes.mapGeometry('futsal1v1.hbs').goalX;
    for (const spot of w.placed) {
      assert(Math.abs(spot.x) < big - 50, 'inside the big pitch');
      assert(Math.abs(spot.x) > small * 0.45, 'and scaled to it, not the small pitch');
    }
  }

  // ---- a dead room heals itself ---------------------------------------
  // Reported twice in production: everyone sitting in spectators, nothing
  // running, and no event left to fire. reconcile() used to need two
  // available players before it would lift a finger, so a single player had
  // no safety net at all.
  {
    const w = makeWorld();
    w.join(1);
    await w.quiet();
    assert(w.started, 'solo training started');

    // The match vanishes and the player is back in spectators, with nothing
    // to tell the bot about it.
    w.forceStop();
    w.players.find((p) => p.id === 1).team = TEAM.SPEC;
    assert(!w.started, 'room is dead');

    w.teams.reconcile();
    await w.quiet();
    assert(w.started, 'reconcile restarted it');
    assert.strictEqual(
      w.players.filter((p) => p.team !== TEAM.SPEC).length,
      1,
      'and put the player back on the pitch'
    );
  }

  // ---- an AFK player alone, then someone joins -------------------------
  // His report, exactly: "Player 1 just joined and still not being sent to
  // the training ground (im afk)".
  {
    const w = makeWorld();
    w.join(1);
    await w.quiet();

    w.registry.get(1).afk = true;
    const p1 = w.players.find((p) => p.id === 1);
    p1.team = TEAM.SPEC;
    w.teams.onPlayerLeave(p1);
    await w.quiet();
    assert(!w.started, 'nothing to play with everyone away');

    w.join(2);
    await w.quiet();

    assert.strictEqual(w.teams.mode.name, 'entrenamiento', 'training for the newcomer');
    assert(w.started, 'and it is actually running');
    assert.strictEqual(
      w.players.filter((p) => p.id === 2 && p.team === TEAM.RED).length,
      1,
      'the newcomer is on the pitch, not stuck in spectators'
    );
  }

  // ---- there is a pause between matches -------------------------------
  {
    const w = makeWorld({ configOverride: { lobbyPauseMs: 300, rebuildDelayMs: 50 } });
    w.join(1);
    w.join(2);
    await w.quiet();

    // Haxball stops the game before onGameEnd reaches us.
    w.room.stopGame();
    w.teams.onGameEnd({ red: 3, blue: 0 });
    assert(w.said.some((m) => m.includes('Siguiente partido')), 'the wait is announced');

    await w.wait(120);
    assert(!w.started, 'still in the lobby shortly after the whistle');

    await w.wait(300);
    assert(w.started, 'and the next match starts after the pause');
  }


  // ---- nobody spare: a 1v1 just swaps ends ----------------------------
  // Two people in the room, match over. There is no queue to challenge the
  // winner, so "winner stays" means nothing — they play again, other way round,
  // and neither of them defends the same goal all night.
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    await w.quiet();
    const redBefore = w.sideNames(TEAM.RED);
    const blueBefore = w.sideNames(TEAM.BLUE);

    w.room.stopGame();
    await w.wait(5);
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.quiet();

    assert.strictEqual(w.sideNames(TEAM.RED), blueBefore, 'blue player is now red');
    assert.strictEqual(w.sideNames(TEAM.BLUE), redBefore, 'and red is now blue');
    assert.strictEqual(w.teams.queueList.length, 0, 'nobody was sent to the queue');
    assert(w.started, 'and they are playing again');
    assert(w.said.some((m) => m.includes('cambiando de lado')), 'the swap is announced');
  }

  // ---- three players: the winner stays and the waiter challenges ------
  {
    const w = makeWorld();
    w.join(1);
    w.join(2);
    w.join(3);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '1v1');

    w.room.stopGame();
    await w.wait(5);
    w.teams.onGameEnd({ red: 3, blue: 0 }); // p1 wins
    await w.quiet();

    assert.strictEqual(w.sideNames(TEAM.RED), 'p1', 'winner stayed on');
    assert.strictEqual(w.sideNames(TEAM.BLUE), 'p3', 'the one who was waiting came on');
    assert(
      !w.said.some((m) => m.includes('Elige:')),
      'and there is no captain pick in a 1v1'
    );
  }

  // ---- nobody spare in a 2v2: teams are redrawn ------------------------
  {
    const w = makeWorld();
    for (let i = 1; i <= 4; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '2v2');
    const redBefore = w.sideNames(TEAM.RED);

    w.room.stopGame();
    await w.wait(5);
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.quiet();

    assert.strictEqual(w.players.filter((p) => p.team !== TEAM.SPEC).length, 4, 'all four playing');
    assert.strictEqual(w.teams.queueList.length, 0, 'nobody benched');
    assert.notStrictEqual(
      w.sideNames(TEAM.RED),
      redBefore,
      'the same pair is not defending the same goal again'
    );
    assert(w.said.some((m) => m.includes('Revancha')), 'announced as a rematch');
  }

  // ---- a scramble that deals the same teams still changes ends --------
  // The shuffle usually deals a different pair on its own, so the fallback
  // that swaps ends when it does not is easy to break without any test
  // noticing. Pin the shuffle so it deals the identical teams and check the
  // fallback actually fires.
  {
    const realRandom = Math.random;
    try {
      // Fisher-Yates leaves the order untouched when every draw picks the last
      // remaining index, so the "shuffle" deals exactly the same teams twice.
      Math.random = () => 0.9999;

      const w = makeWorld();
      for (let i = 1; i <= 4; i++) w.join(i);
      await w.quiet();
      assert.strictEqual(w.sideNames(TEAM.RED), 'p1,p2', 'pinned shuffle deals in join order');

      w.room.stopGame();
      await w.wait(5);
      w.teams.onGameEnd({ red: 3, blue: 0 });
      await w.quiet();

      assert.strictEqual(w.players.filter((p) => p.team !== TEAM.SPEC).length, 4, 'all four playing');
      assert.strictEqual(
        w.sideNames(TEAM.RED),
        'p3,p4',
        'same pairing, so they changed ends instead'
      );
    } finally {
      Math.random = realRandom;
    }
  }

  // ---- five players in a 2v2: the winners hold, the queue picks -------
  {
    const w = makeWorld();
    for (let i = 1; i <= 5; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '2v2', 'five players still play 2v2');
    assert.strictEqual(w.teams.queueList.length, 1, 'the fifth waits');

    const winners = w.sideNames(TEAM.RED);
    w.room.stopGame();
    await w.wait(5);
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.quiet();

    assert.strictEqual(w.sideNames(TEAM.RED), winners, 'winners kept their side');
    assert(w.teams.isPicking, 'and a captain is picking a partner from the three waiting');
  }

  // ---- captain pause and substitution ---------------------------------
  {
    const w = makeWorld();
    for (let i = 1; i <= 5; i++) w.join(i);
    await w.quiet();
    if (w.teams.isPicking) w.chat(w.teams.captain, '1');
    await w.quiet();

    const red = w.players.filter((p) => p.team === TEAM.RED);
    const captain = red[0];
    const benched = red[1];
    const waiter = w.teams.queueList[0];
    assert(captain && benched && waiter !== undefined, 'a 2v2 with someone waiting');

    // Somebody who is not a captain cannot stop the clock. The captain of a
    // side is whoever has been on it longest, so the *second* blue player is
    // an ordinary player.
    const blues = w.players.filter((p) => p.team === TEAM.BLUE);
    const notCaptain = blues[1];
    const opponent = blues[0];
    assert(notCaptain, 'blue has two players');
    w.teams.startPause(notCaptain);
    assert(!w.paused, 'a non-captain cannot pause');

    w.teams.startPause(captain);
    assert(w.paused, 'the captain stopped the clock');
    assert(w.said.some((m) => m.includes('PAUSA')), 'and the room was told');

    // Cannot bench someone on the other team.
    w.teams.benchPlayer(captain, opponent.id);
    assert(w.said.some((m) => m.includes('no es de tu equipo')), 'other team is off limits');

    w.teams.benchPlayer(captain, benched.id);
    assert(w.said.some((m) => m.includes('Elige')), 'the queue is offered by number');

    // Somebody else typing a number must not steal the substitution. Team
    // moves land a tick later, so this has to wait before looking, or it
    // passes whatever happens.
    w.chat(opponent.id, '1');
    await w.wait(20);
    assert.strictEqual(w.players.find((p) => p.id === waiter).team, TEAM.SPEC, 'still on the bench');
    assert(w.paused, 'and the pause is still open for the actual captain');

    w.chat(captain.id, '1');
    await w.wait(60);

    assert.strictEqual(w.players.find((p) => p.id === waiter).team, TEAM.RED, 'the sub came on');
    assert.strictEqual(w.players.find((p) => p.id === benched.id).team, TEAM.SPEC, 'and the other went off');
    assert(w.teams.queueList.includes(benched.id), 'the benched player waits their turn');
    assert(!w.paused, 'and play resumed');
    assert(w.started, 'without ending the match');
  }

  // ---- the pause window closes by itself ------------------------------
  {
    const w = makeWorld();
    for (let i = 1; i <= 5; i++) w.join(i);
    await w.quiet();
    if (w.teams.isPicking) w.chat(w.teams.captain, '1');
    await w.quiet();

    const captain = w.players.filter((p) => p.team === TEAM.RED)[0];
    w.teams.startPause(captain);
    assert(w.paused, 'paused');

    // One per team per match, so a losing side cannot stall forever.
    w.teams.startPause(captain);
    assert(w.said.some((m) => m.includes('Ya hay una pausa')), 'no double pause');

    await w.wait(400);
    assert(!w.paused, 'the clock restarts on its own');
    assert(w.started, 'and the match is still the same match');

    w.teams.startPause(captain);
    assert(!w.paused, 'that team already used its pause this match');
  }


  // ---- an AFK player is gone immediately, not a tick later -------------
  // Reported shape: someone types !afk mid-match and the score resets. The
  // team move is queued, so for the rest of that tick the snapshot still shows
  // them playing, and the "too many players for this mode" check counted them.
  {
    const w = makeWorld();
    for (let i = 1; i <= 8; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '4v4', 'a 4v4 is running');

    const stopsBefore = w.stops;
    // Exactly what afk.js does: flag them, move them, tell teams — all in one
    // tick, before the move has landed.
    w.registry.get(8).afk = true;
    w.room.setPlayerTeam(8, TEAM.SPEC);
    w.teams.onPlayerLeave(w.players.find((p) => p.id === 8));

    await w.wait(200);
    assert.strictEqual(w.stops, stopsBefore, 'the match was not torn down');
    assert(w.started, 'and it is still running');
  }

  // ---- coming back from AFK does not jump the queue --------------------
  // "!afk, !afk" used to put you at the front, and the front of the queue
  // captains the challenging side. Free captaincy, repeatable all night.
  {
    const w = makeWorld();
    for (let i = 1; i <= 11; i++) w.join(i);
    await w.quiet();

    const before = w.teams.queueList.slice();
    assert(before.length >= 3, 'a few people are waiting');
    const last = before[before.length - 1];

    w.registry.get(last).afk = true;
    w.teams.onPlayerLeave(w.players.find((p) => p.id === last));
    w.registry.get(last).afk = false;
    w.teams.onPlayerAvailable(last);
    await w.wait(60);

    assert.strictEqual(
      w.teams.queueList[0],
      before[0],
      'whoever was first is still first'
    );
    assert.strictEqual(
      w.teams.queueList[w.teams.queueList.length - 1],
      last,
      'and the returning player is at the back'
    );
  }

  // ---- a join during the lobby pause does not rob the winners ----------
  {
    // Nine players, so the newcomer does not change the mode (4v4 is the cap)
    // and a rematch scramble is not the correct answer here.
    const w = makeWorld({ configOverride: { lobbyPauseMs: 200, rebuildDelayMs: 200 } });
    for (let i = 1; i <= 9; i++) w.join(i);
    await w.quiet();
    while (w.teams.isPicking) {
      w.chat(w.teams.captain, '1');
      await w.wait(20);
    }
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '4v4', 'a 4v4 with somebody waiting');

    const winners = w.sideNames(TEAM.RED);
    w.room.stopGame();
    await w.wait(5);
    w.teams.onGameEnd({ red: 3, blue: 0 }); // red wins, rebuild in 200ms

    w.join(60); // ...and somebody walks in during the pause
    await w.quiet();

    assert.strictEqual(w.sideNames(TEAM.RED), winners, 'the winners kept their side');
  }

  // ---- an admin can actually stop the room -----------------------------
  // !parar used to be useless: reconcile started a new match within four
  // seconds and there was no way to hold the room still.
  {
    const w = makeWorld();
    for (let i = 1; i <= 4; i++) w.join(i);
    await w.quiet();
    assert(w.started, 'a match is running');

    w.teams.setRotation(false);
    w.room.stopGame();
    await w.wait(20);
    assert(!w.started, 'stopped');

    w.teams.reconcile();
    w.join(70); // even a join must not wake it up
    await w.wait(250);
    assert(!w.started, 'and it stays stopped until an admin says otherwise');

    w.teams.setRotation(true);
    await w.quiet();
    assert(w.started, 'and !empezar hands it back');
  }

  // ---- an admin dragging someone onto a team keeps the queue honest ----
  {
    const w = makeWorld();
    for (let i = 1; i <= 5; i++) w.join(i);
    await w.quiet();
    if (w.teams.isPicking) w.chat(w.teams.captain, '1');
    await w.quiet();

    const waiter = w.teams.queueList[0];
    assert(waiter !== undefined, 'somebody is waiting');

    // An admin drags them onto a team behind the bot's back.
    const p = w.players.find((x) => x.id === waiter);
    p.team = TEAM.RED;
    w.teams.onExternalTeamChange(p);

    assert(
      !w.teams.queueList.includes(waiter),
      'they are no longer waiting, because they are playing'
    );

    // And back the other way.
    p.team = TEAM.SPEC;
    w.teams.onExternalTeamChange(p);
    assert(w.teams.queueList.includes(waiter), 'benched by hand, back in the queue');
  }

  // ---- the bot leaves a paused match alone -----------------------------
  {
    const w = makeWorld();
    for (let i = 1; i <= 4; i++) w.join(i);
    await w.quiet();

    w.teams.setEnginePaused(true); // an admin hit pause in the client
    assert(w.teams.isPaused, 'the bot knows');

    const stopsBefore = w.stops;
    w.join(80);
    w.join(81);
    w.teams.reconcile();
    await w.wait(200);
    assert.strictEqual(w.stops, stopsBefore, 'no rebuilding while the clock is stopped');

    w.teams.setEnginePaused(false);
  }


  // ---- a substitution inside the confirm window survives ---------------
  // Every applied line-up is re-checked a moment later. A backfill that
  // happens inside that window is a legitimate change, but the check compared
  // against the now-obsolete plan and put the substitute straight back in
  // spectators — leaving them in neither the queue nor the game until
  // reconcile noticed, with the match playing short-handed meanwhile.
  //
  // The timing is the whole point: the leave has to land while the previous
  // confirmation is still armed, so this deliberately does NOT wait for quiet.
  {
    const w = makeWorld({ configOverride: { confirmDelayMs: 300, rebuildDelayMs: 20 } });
    for (let i = 1; i <= 5; i++) w.join(i);

    await w.wait(60); // the match is built and the confirm is armed for 300ms
    const waiter = w.teams.queueList[0];
    const red = w.players.filter((p) => p.team === TEAM.RED);
    assert(waiter !== undefined && red.length === 2, 'a 2v2 with somebody waiting');

    w.leave(red[0].id); // backfill pulls the waiter in, mid-window
    await w.wait(500); // well past the confirmation

    const sub = w.players.find((p) => p.id === waiter);
    assert(sub, 'the substitute is still in the room');
    assert.notStrictEqual(sub.team, TEAM.SPEC, 'and still on the pitch, not sent back');
    assert(
      !w.teams.queueList.includes(waiter),
      'and not left in limbo between the queue and the game'
    );
  }

  // ---- somebody leaving mid-pick does not cancel the pick --------------
  {
    const w = makeWorld({ configOverride: { pickSeconds: 5 } });
    for (let i = 1; i <= 9; i++) w.join(i);
    await w.quiet();
    w.room.stopGame();
    await w.wait(5);
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.wait(120);
    assert(w.teams.isPicking, 'a captain is choosing');

    const captain = w.teams.captain;
    // Somebody who is not the captain walks out.
    const bystander = w.teams.queueList.find((id) => id !== captain);
    assert(bystander !== undefined, 'there is a bystander in the queue');
    w.leave(bystander);
    await w.wait(120);

    assert(w.teams.isPicking, 'the pick is still running');
    assert.strictEqual(w.teams.captain, captain, 'and it is the same captain');
  }


  // ---- eight players, nobody spare: scramble, do not ask for a pick ----
  // Reported: a full 4v4 finished and the bot asked somebody to pick a team
  // instead of scrambling. The cause was upstream — players who had been
  // parked in spectators as AFK still counted as being in the room but not
  // available, so the bot saw seven playable people where there were eight and
  // took the winner-stays path. This pins the behaviour at full strength.
  {
    const w = makeWorld();
    for (let i = 1; i <= 8; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '4v4', 'a full 4v4');
    assert.strictEqual(w.teams.queueList.length, 0, 'nobody waiting');

    const redBefore = w.sideNames(TEAM.RED);
    w.room.stopGame();
    await w.wait(5);
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.quiet();

    assert(!w.teams.isPicking, 'nobody was asked to pick');
    assert.strictEqual(
      w.players.filter((p) => p.team !== TEAM.SPEC).length,
      8,
      'all eight are playing again'
    );
    assert.strictEqual(w.teams.queueList.length, 0, 'and nobody was benched');
    assert.notStrictEqual(w.sideNames(TEAM.RED), redBefore, 'the teams were redrawn');
    assert(w.said.some((m) => m.includes('Revancha')), 'announced as a rematch');
  }

  // ---- nine players: now it IS a pick ---------------------------------
  {
    const w = makeWorld();
    for (let i = 1; i <= 9; i++) w.join(i);
    await w.quiet();
    while (w.teams.isPicking) {
      w.chat(w.teams.captain, '1');
      await w.wait(20);
    }
    await w.quiet();

    const winners = w.sideNames(TEAM.RED);
    w.room.stopGame();
    await w.wait(5);
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.wait(150);

    assert.strictEqual(w.sideNames(TEAM.RED), winners, 'the winners hold the pitch');
    assert(w.teams.isPicking, 'and the challengers pick');
  }


  // ---- a captain who goes away hands over, it does not scramble --------
  // Reported: the captain went AFK, the bot removed them and then dealt out
  // the teams itself — ignoring the people still queued up waiting for exactly
  // this. Somebody else's turn is the obvious answer. Driven here by the
  // captain leaving, which is the same code path as the pick timing out, and
  // deterministic rather than racing a timer.
  {
    const w = makeWorld({ configOverride: { pickSeconds: 30 } });
    for (let i = 1; i <= 11; i++) w.join(i);
    await w.quiet();
    w.room.stopGame();
    await w.wait(5);
    w.teams.onGameEnd({ red: 3, blue: 0 });
    await w.wait(150);
    assert(w.teams.isPicking, 'a captain is choosing');

    const first = w.teams.captain;
    const waitingBefore = w.teams.queueList.length;
    assert(waitingBefore > 0, 'and there are spare players behind them');

    w.leave(first); // the captain vanishes
    await w.wait(150);

    assert(w.teams.isPicking, 'somebody is still picking');
    assert.notStrictEqual(w.teams.captain, first, 'and it is the next player in line');
    assert(w.said.some((m) => m.includes('Le toca a')), 'the handover is announced');
  }

  // ---- a volunteer gives their seat to a newcomer -----------------------
  // The owner is always in the room, so they end up taking a place a regular
  // could have had. !ceder hands it over automatically.
  {
    const w = makeWorld();
    for (let i = 1; i <= 4; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '2v2');

    const owner = w.players.find((p) => p.team !== TEAM.SPEC);
    w.registry.get(owner.id).yielding = true;

    const stopsBefore = w.stops;
    w.join(50);
    await w.wait(200);

    assert.strictEqual(
      w.players.find((p) => p.id === 50).team !== TEAM.SPEC,
      true,
      'the newcomer went straight onto the pitch'
    );
    assert.strictEqual(
      w.players.find((p) => p.id === owner.id).team,
      TEAM.SPEC,
      'and the volunteer stepped aside'
    );
    assert(w.teams.queueList.includes(owner.id), 'into the front of the queue');
    assert(w.started, 'without interrupting the match');
    assert.strictEqual(w.stops, stopsBefore, 'nothing was torn down');
  }

  // ---- and a volunteer is the first one benched when evening up --------
  {
    const w = makeWorld();
    for (let i = 1; i <= 6; i++) w.join(i);
    await w.quiet();
    assert.strictEqual(w.teams.mode.name, '3v3');

    const red = w.players.filter((p) => p.team === TEAM.RED);
    const volunteer = red[2];
    w.registry.get(volunteer.id).yielding = true;

    const blue = w.players.filter((p) => p.team === TEAM.BLUE);
    w.leave(blue[0].id); // red is now a player up
    await w.wait(200);

    assert.strictEqual(
      w.players.find((p) => p.id === volunteer.id).team,
      TEAM.SPEC,
      'the volunteer is the one who stood down'
    );
    assert(w.started, 'and the match kept going');
  }

  console.log('\nAll rotation tests passed.\n');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
