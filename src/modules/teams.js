const { t } = require('../i18n');
const modes = require('./modes');
const { notHost, isHost } = require('../util/host');

const TEAM = { SPEC: 0, RED: 1, BLUE: 2 };

/**
 * Match manager — "retas" style.
 *
 * IMPORTANT, and the source of a long-running bug: `room.setPlayerTeam()` does
 * NOT update `room.getPlayerList()` straight away. The move is queued and shows
 * up a tick later. So this:
 *
 *     room.setPlayerTeam(id, TEAM.RED);
 *     if (teamOf(TEAM.RED).length === 0) ...   // still 0!
 *
 * reads stale data and draws the wrong conclusion. That is exactly what made
 * the room shuffle people onto teams and then announce "not enough players":
 * the moves landed, but the decision to start the match was made against a
 * snapshot taken before they did.
 *
 * The rule here is therefore: **plan first, apply once, never read back.**
 * Every function below builds the full red/blue line-up in memory, applies it,
 * and decides whether to kick off from the plan — not from the room.
 */
function createTeams({ room, chat, registry, config, guard, onResume }) {
  /** Player ids waiting for a turn, oldest first. */
  let queue = [];

  let currentMode = modes.pickMode(0, config.teamSize);
  let currentMap = null;
  let forcedMode = null;
  let lastModeChange = 0;

  let rebuildTimer = null;
  let pending = null;
  /** How many times in a row we have asked a stubborn game to stop. */
  let stopAttempts = 0;
  /**
   * Whether the bot runs the room at all. `!parar` turns it off so an admin can
   * actually hold the room still; without this, reconcile restarted the match
   * within four seconds of every stop and there was no way to intervene.
   */
  let rotation = true;
  /** Somebody pressed pause in the client, rather than using !pausa. */
  let enginePaused = false;

  /** Active captain pick, or null. */
  let picking = null;

  // ---------------------------------------------------------------- helpers

  const inRoom = (id) => room.getPlayer(id) !== null;

  const isAvailable = (id) => {
    if (isHost(id)) return false;
    const rec = registry.get(id);
    return inRoom(id) && (!rec || !rec.afk);
  };

  const nameOf = (id) => {
    const rec = registry.get(id);
    if (rec) return rec.name;
    const p = room.getPlayer(id);
    return p ? p.name : `#${id}`;
  };

  const humans = () => room.getPlayerList().filter(notHost);
  const teamOf = (team) => humans().filter((p) => p.team === team);
  const gameRunning = () => room.getScores() !== null;

  function enqueue(id, front = false) {
    if (isHost(id) || queue.includes(id)) return;
    if (front) queue.unshift(id);
    else queue.push(id);
  }

  const unqueue = (id) => {
    queue = queue.filter((x) => x !== id);
  };

  const waiting = () => queue.filter(isAvailable);

  /** Pop the next available player off the queue. */
  function take() {
    while (queue.length) {
      const id = queue.shift();
      if (isAvailable(id)) return id;
    }
    return null;
  }

  function availableCount() {
    return humans().filter((p) => isAvailable(p.id)).length;
  }

  /** Snapshot of where everyone is right now: Map(id -> team). */
  const snapshot = () => new Map(humans().map((p) => [p.id, p.team]));

  /**
   * Who is really playing for a side.
   *
   * Availability matters as much as the team column here. Going AFK moves you
   * to spectators, but that write is queued, so for the rest of the tick the
   * snapshot still shows you on the pitch. Every decision made from the raw
   * snapshot in that window was made against a roster that no longer existed —
   * which is how one player typing !afk could tear down a live 4v4 and reset
   * the score. Someone flagged AFK is gone as far as these counts go, whether
   * or not the engine has caught up.
   */
  const sideOf = (snap, team) =>
    [...snap].filter(([id, tm]) => tm === team && isAvailable(id)).map(([id]) => id);

  // ---------------------------------------------------------------- chatter

  /**
   * Some conditions are checked every few seconds by reconcile(). Announcing
   * them each time floods the chat — "Equipo incompleto" every 4 seconds is
   * worse than saying nothing. Say it once, then stay quiet until the
   * situation actually changes.
   */
  const saidAt = new Map();

  function sayOnce(key, ms, send) {
    const last = saidAt.get(key);
    if (last && Date.now() - last < ms) return;
    saidAt.set(key, Date.now());
    send();
  }

  /** The condition cleared — allow it to be announced again next time. */
  const resetSaid = (key) => saidAt.delete(key);

  /**
   * Put a player who joins a live match somewhere sensible.
   *
   * Haxball spawns late arrivals at the stadium's spawn distance, which on
   * these maps is past the goal line — they appear stuck behind their own net.
   * We move them to their own half instead.
   *
   * The catch, and the reason the first attempt at this did nothing at all: a
   * player has no disc until the team change has actually landed, and team
   * changes are queued (see the note at the top of this file). Calling
   * `setPlayerDiscProperties` in the same tick as `setPlayerTeam` is a silent
   * no-op — no error, no effect, and the player still ends up behind the net.
   *
   * So this waits for the disc to exist before touching it, and gives up after
   * a couple of seconds rather than retrying forever.
   */
  function placeOnPitch(id, team, slot = 0) {
    const spot = modes.spawnPoint(currentMap || currentMode.map, team === TEAM.RED ? -1 : 1, slot);
    const step = config.spawnRetryMs === undefined ? 120 : config.spawnRetryMs;
    let tries = 0;

    const attempt = () => {
      if (!gameRunning()) return; // match ended; kickoff will place them

      const p = room.getPlayer(id);
      if (!p || p.team !== team) return retry();

      let disc = null;
      try {
        disc = room.getPlayerDiscProperties(id);
      } catch (err) {
        disc = null;
      }
      if (!disc) return retry();

      try {
        room.setPlayerDiscProperties(id, { x: spot.x, y: spot.y, xspeed: 0, yspeed: 0 });
      } catch (err) {
        // Not fatal: they are on the pitch either way, just badly placed.
        console.error('[teams] could not position player:', err.message);
      }
    };

    const retry = () => {
      if (++tries > 16) {
        console.error('[teams] gave up positioning player', id, '— no disc appeared');
        return;
      }
      setTimeout(attempt, step);
    };

    setTimeout(attempt, step);
  }

  /**
   * Apply a planned line-up. Only players whose team actually changes are
   * touched, so we do not spam the room with no-op moves.
   *
   * Returns the intended line-up so the caller can hand it to `commit()`.
   */
  function applyPlan(snap, red, blue) {
    const intended = new Map();
    for (const [id, was] of snap) {
      const want = red.includes(id) ? TEAM.RED : blue.includes(id) ? TEAM.BLUE : TEAM.SPEC;
      intended.set(id, want);
      if (was !== want) room.setPlayerTeam(id, want);
    }
    return intended;
  }

  /**
   * Check, a moment later, that the world actually looks like the plan.
   *
   * Every write to the room is queued and none of them report failure, so a
   * plan can be applied perfectly and still not take — a stadium change landing
   * at the wrong moment, a `startGame` arriving while the previous game was
   * still stopping. The symptom is always the same and always baffling: the bot
   * announces a match, and the room just sits there with everybody in
   * spectators.
   *
   * Rather than trying to predict every such race, look at the result and fix
   * it. Once, quietly.
   */
  let confirmTimer = null;

  /**
   * Drop a pending confirmation. Anything that deliberately tears the match
   * down has to call this, or a check queued by the *previous* line-up will
   * fire afterwards and helpfully restart the match nobody wanted.
   */
  function cancelCommit() {
    clearTimeout(confirmTimer);
    confirmTimer = null;
  }

  function commit(intended, shouldStart) {
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      confirmTimer = null;
      if (picking) return;

      let drifted = false;
      for (const [id, want] of intended) {
        const p = room.getPlayer(id);
        if (!p || p.team === want) continue;
        room.setPlayerTeam(id, want);
        drifted = true;
      }
      if (drifted) console.log('[teams] line-up did not take; re-applied');

      if (shouldStart && !gameRunning()) {
        console.log('[teams] match had not started; starting it');
        room.startGame();
      }
    }, config.confirmDelayMs === undefined ? 400 : config.confirmDelayMs);
  }

  // ---------------------------------------------------------------- map

  function applyMode(mode) {
    currentMode = mode;
    if (currentMap === mode.map) return false;

    room.setCustomStadium(modes.loadMap(mode.map));
    currentMap = mode.map;
    lastModeChange = Date.now();
    if (guard) guard.applySettings();
    chat.info(t.modeSwitched(mode.name));
    return true;
  }

  // ---------------------------------------------------------------- rebuild

  function scheduleRebuild(winner, delayMs) {
    // Never lose a winner. A rebuild is already pending for six seconds after
    // every match; anyone joining or leaving in that window used to call this
    // with winner=null and overwrite it, so the winners were dumped back into
    // the queue with everybody else. "We won and got thrown off the pitch."
    const keepWinner = pending && pending.winner !== null && pending.winner !== undefined;
    pending = keepWinner && (winner === null || winner === undefined) ? pending : { winner };
    if (rebuildTimer) return;

    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      const req = pending;
      pending = null;
      if (!req) return;
      try {
        buildMatch(req.winner);
      } catch (err) {
        console.error('[teams] rebuild failed:', err);
      }
      if (pending) scheduleRebuild(pending.winner);
    }, delayMs === undefined ? config.rebuildDelayMs : delayMs);
  }

  function debugState() {
    return {
      mode: currentMode.name,
      map: currentMap,
      forced: forcedMode ? forcedMode.name : null,
      picking: picking ? { captain: nameOf(picking.captainId), side: picking.side } : null,
      gameRunning: gameRunning(),
      availableCount: availableCount(),
      queue: queue.map((id) => ({ id, name: nameOf(id), available: isAvailable(id) })),
      players: humans().map((p) => {
        const rec = registry.get(p.id);
        return {
          id: p.id,
          name: p.name,
          team: p.team === TEAM.RED ? 'red' : p.team === TEAM.BLUE ? 'blue' : 'spec',
          afk: !!(rec && rec.afk),
          known: !!rec,
          inQueue: queue.includes(p.id),
        };
      }),
    };
  }

  function buildMatch(winner) {
    cancelPicking();
    cancelCommit();
    clearPause(); // the match this pause belonged to is over

    // Rebuilding means moving people off teams and possibly swapping the
    // stadium, neither of which is legal under a live match.
    //
    // `stopGame()` is queued like every other write, so for the rest of this
    // tick the engine still believes a game is running: `setCustomStadium()`
    // would throw and `startGame()` would be ignored. Stop now, come back on
    // the next pass and build against a room that has actually settled.
    if (gameRunning()) {
      if (stopAttempts < 6) {
        stopAttempts++;
        room.stopGame();
        return scheduleRebuild(winner, config.stopSettleMs === undefined ? 250 : config.stopSettleMs);
      }
      console.error('[teams] game will not stop; building anyway');
    }
    stopAttempts = 0;

    if (config.debugTeams) {
      console.log('[teams] buildMatch winner=' + winner, JSON.stringify(debugState()));
    }

    // ---- read the world exactly once -----------------------------------
    const snap = snapshot();
    const onTeam = (team) => [...snap].filter(([, tm]) => tm === team).map(([id]) => id);

    const loser = winner === TEAM.RED ? TEAM.BLUE : winner === TEAM.BLUE ? TEAM.RED : null;
    if (loser) onTeam(loser).forEach((id) => enqueue(id));

    let keepers = winner ? onTeam(winner).filter(isAvailable) : [];

    const mode = forcedMode || modes.pickMode(availableCount(), config.teamSize);
    applyMode(mode);

    // Solo practice: one person alone gets the training pitch to themselves.
    if (mode.solo) {
      const alone = humans().filter((p) => isAvailable(p.id)).map((p) => p.id);
      alone.forEach(unqueue);
      const intended = applyPlan(snap, alone.slice(0, 1), []);
      if (alone.length === 0) return announceWaiting();
      resetSaid('waiting');
      resetSaid('unevenNoSubs');
      // Said once: reconcile can call through here repeatedly while the room
      // waits for a second player, and "you are on your own" every four
      // seconds is its own kind of spam.
      sayOnce('solo', config.repeatQuietMs, () => chat.info(t.soloTraining));
      room.startGame();
      commit(intended, true);
      return;
    }
    resetSaid('solo');

    // Nobody spare: everyone in the room is playing either way, so there is no
    // queue to challenge the winners and "winner stays" means nothing. Give
    // them a fresh match instead — same people, different arrangement.
    const roster = humans()
      .filter((p) => isAvailable(p.id))
      .map((p) => p.id);
    if (roster.length === mode.need) return rematch(snap, mode, roster);

    if (keepers.length > mode.teamSize) {
      const surplus = keepers.slice(mode.teamSize);
      keepers = keepers.slice(0, mode.teamSize);
      surplus.reverse().forEach((id) => enqueue(id, true));
    }

    // Anyone else standing on the pitch goes back to the queue.
    for (const [id, tm] of snap) {
      if (tm !== TEAM.SPEC && !keepers.includes(id)) enqueue(id);
    }

    // ---- build the line-up in memory -----------------------------------
    const keepSide = winner || TEAM.RED;
    const otherSide = keepSide === TEAM.RED ? TEAM.BLUE : TEAM.RED;

    const sides = { [TEAM.RED]: [], [TEAM.BLUE]: [] };

    keepers.forEach((id) => {
      unqueue(id);
      sides[keepSide].push(id);
    });
    while (sides[keepSide].length < mode.teamSize) {
      const id = take();
      if (id === null) break;
      sides[keepSide].push(id);
    }

    const pool = waiting();
    const need = mode.teamSize;

    // Captain picking only when a winning team holds one side and there are
    // more people waiting than seats. A cold start fills both sides in order —
    // one picked team against one random team would just be unfair.
    const wantsPicking = winner && need > 1 && pool.length > need;

    if (wantsPicking) {
      const captainId = take();
      if (captainId !== null) sides[otherSide].push(captainId);
      applyPlan(snap, sides[TEAM.RED], sides[TEAM.BLUE]);
      return startPicking(otherSide, mode, sides, captainId);
    }

    while (sides[otherSide].length < mode.teamSize) {
      const id = take();
      if (id === null) break;
      sides[otherSide].push(id);
    }

    // Never start lopsided: trim the bigger side, front of the queue.
    const size = Math.min(sides[TEAM.RED].length, sides[TEAM.BLUE].length);
    for (const side of [TEAM.RED, TEAM.BLUE]) {
      while (sides[side].length > size) enqueue(sides[side].pop(), true);
    }

    const intended = applyPlan(snap, sides[TEAM.RED], sides[TEAM.BLUE]);

    if (size === 0) return announceWaiting();

    resetSaid('waiting');
    resetSaid('unevenNoSubs');
    const left = waiting().length;
    if (left > 0) chat.dim(t.queueWaiting(left));
    room.startGame();
    commit(intended, true);
  }

  const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

  function shuffled(ids) {
    const out = [...ids];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /**
   * Everyone present, nobody waiting: play again.
   *
   * A 1v1 between the only two people in the room swaps ends, so neither of
   * them defends the same goal all night. Anything bigger gets its teams
   * redrawn, so you are not stuck with the same partner and the same opponents
   * match after match. If the shuffle happens to deal the identical teams,
   * they at least change ends.
   *
   * There is no captain pick here on purpose: with nobody spare there is
   * nothing to pick from.
   */
  function rematch(snap, mode, roster) {
    roster.forEach(unqueue);

    const onSide = (team) =>
      [...snap].filter(([id, tm]) => tm === team && roster.includes(id)).map(([id]) => id);
    const prevRed = onSide(TEAM.RED);
    const prevBlue = onSide(TEAM.BLUE);
    const hadMatch = prevRed.length > 0 && prevBlue.length > 0;

    let red;
    let blue;

    if (mode.teamSize === 1) {
      red = prevBlue.slice(0, 1);
      blue = prevRed.slice(0, 1);
    } else {
      const pool = shuffled(roster);
      red = pool.slice(0, mode.teamSize);
      blue = pool.slice(mode.teamSize, mode.need);
      if (hadMatch && sameSet(red, prevRed)) [red, blue] = [blue, red];
    }

    // Cold start, or somebody vanished between the snapshot and here: fall
    // back to plain join order rather than starting nobody.
    if (red.length !== mode.teamSize || blue.length !== mode.teamSize) {
      red = roster.slice(0, mode.teamSize);
      blue = roster.slice(mode.teamSize, mode.need);
    }

    const intended = applyPlan(snap, red, blue);
    resetSaid('waiting');
    resetSaid('unevenNoSubs');
    if (hadMatch) chat.info(mode.teamSize === 1 ? t.sidesSwapped : t.teamsScrambled);
    room.startGame();
    commit(intended, true);
  }

  /**
   * Explain why no match is running. "Faltan jugadores" on its own is
   * maddening when there are two people in the room.
   */
  function announceWaiting() {
    const all = humans().length;
    const afkCount = humans().filter((p) => {
      const rec = registry.get(p.id);
      return rec && rec.afk;
    }).length;

    sayOnce('waiting', config.repeatQuietMs, () => {
      if (afkCount > 0) chat.dim(t.waitingWithAfk(all, afkCount));
      else chat.dim(t.waitingCount(all));
    });
  }

  // ---------------------------------------------------------------- picking

  function startPicking(side, mode, sides, captainId) {
    if (captainId === null || captainId === undefined) return;

    const other = side === TEAM.RED ? TEAM.BLUE : TEAM.RED;
    picking = {
      captainId,
      side,
      mode,
      sideIds: [...sides[side]],
      oppositeIds: [...sides[other]],
      oppositeCount: sides[other].length,
      timer: null,
    };

    chat.hype(t.captainIs(nameOf(captainId), mode.name));
    promptCaptain();
  }

  function promptCaptain() {
    if (!picking) return;
    const remaining = picking.mode.teamSize - picking.sideIds.length;
    if (remaining <= 0) return finishPicking();

    const pool = waiting();
    if (pool.length === 0) return finishPicking();

    if (pool.length <= remaining) {
      // No choice left to make.
      pool.forEach((id) => {
        unqueue(id);
        picking.sideIds.push(id);
        room.setPlayerTeam(id, picking.side);
      });
      return finishPicking();
    }

    const list = pool.map((id, i) => `${i + 1}. ${nameOf(id)}`).join('   ');
    chat.info(t.pickPrompt(nameOf(picking.captainId), remaining), picking.captainId);
    chat.info(t.pickList(list));

    clearTimeout(picking.timer);
    // Bare timer callbacks that throw take the whole process down with them,
    // and this one kicks a player and schedules a rebuild.
    picking.timer = setTimeout(() => {
      try {
        onPickTimeout();
      } catch (err) {
        console.error('[teams] pick timeout failed:', err);
        cancelPicking();
      }
    }, config.pickSeconds * 1000);
  }

  function onPickTimeout() {
    if (!picking) return;
    const slow = picking.captainId;
    chat.error(t.pickTimeout(nameOf(slow)));

    const handover = { ...picking };
    clearTimeout(picking.timer);
    picking = null;

    unqueue(slow);
    room.kickPlayer(slow, t.pickKickReason, false);

    passCaptaincy(handover, slow);
  }

  /**
   * The captain went quiet, or left. Hand the pick to the next player in line
   * rather than tearing the whole thing down.
   *
   * Rebuilding from scratch here was wrong in a way that was very visible: an
   * AFK captain got removed and the bot then dealt out teams itself, ignoring
   * the people who were still queued up waiting for exactly this. Somebody
   * else's turn to captain is the obvious answer, and it is what the queue is
   * for.
   */
  function passCaptaincy(previous, dropped) {
    const sideIds = previous.sideIds.filter((id) => id !== dropped && isAvailable(id));
    const next = take();

    if (next === null) {
      // Genuinely nobody left to captain. Fall back to a rebuild.
      return scheduleRebuild(null);
    }

    sideIds.push(next);
    room.setPlayerTeam(next, previous.side);

    picking = {
      captainId: next,
      side: previous.side,
      mode: previous.mode,
      sideIds,
      oppositeIds: previous.oppositeIds,
      oppositeCount: previous.oppositeCount,
      timer: null,
    };

    chat.hype(t.captainPassed(nameOf(next)));
    promptCaptain();
  }

  /**
   * Captains choose by typing the number next to a name. Returns true if the
   * message was a pick and should not reach the room chat.
   */
  function tryPick(player, message) {
    if (!picking && !benching) return false;
    const text = String(message).trim().replace(/^!(elegir|pick|p)\s*/i, '');
    if (!/^\d{1,2}$/.test(text)) return false;

    // A substitution is also chosen by number, and it takes precedence: it can
    // only be open during a pause, when no team-building pick is running.
    if (benching) return trySubPick(player, text);

    if (player.id !== picking.captainId) {
      chat.error(t.pickNotCaptain, player.id);
      return true;
    }

    const pool = waiting();
    const index = Number(text) - 1;
    if (index < 0 || index >= pool.length) {
      chat.error(t.pickInvalid, player.id);
      return true;
    }

    const chosen = pool[index];
    unqueue(chosen);
    picking.sideIds.push(chosen);
    room.setPlayerTeam(chosen, picking.side);
    chat.ok(t.picked(nameOf(picking.captainId), nameOf(chosen)));

    promptCaptain();
    return true;
  }

  function finishPicking() {
    if (!picking) return;
    clearTimeout(picking.timer);
    const { sideIds, oppositeIds, oppositeCount, side } = picking;
    const other = side === TEAM.RED ? TEAM.BLUE : TEAM.RED;
    picking = null;

    if (sideIds.length === 0 || oppositeCount === 0) return announceWaiting();

    const left = waiting().length;
    if (left > 0) chat.dim(t.queueWaiting(left));
    room.startGame();

    const intended = new Map();
    for (const p of humans()) intended.set(p.id, TEAM.SPEC);
    sideIds.forEach((id) => intended.set(id, side));
    oppositeIds.forEach((id) => intended.set(id, other));
    commit(intended, true);
  }

  function cancelPicking() {
    if (!picking) return;
    clearTimeout(picking.timer);
    picking = null;
  }

  /**
   * Nobody to bring on, so take somebody off instead.
   *
   * A 3v3 that loses a player becomes a 2v2 rather than a 3v2, and the spare
   * goes to the front of the queue — they were playing through no fault of
   * their own, so they get first refusal on the next seat. Chosen at random,
   * because picking the newest or the worst would be its own kind of unfair.
   *
   * The match keeps running throughout. The pitch may now be bigger than the
   * mode strictly calls for (a 2v2 left on the 4v4 field), which is fine: the
   * alternative is swapping the stadium, and that means stopping the game.
   */
  function evenUp(red, blue) {
    const bigger = red.length > blue.length ? red : blue;
    const smaller = red.length > blue.length ? blue : red;

    // Never empty a side. A 1v0 is not a match, and tendRunningMatch rebuilds
    // from scratch in that case anyway.
    if (smaller.length === 0 || bigger.length - smaller.length < 1) {
      sayOnce('unevenNoSubs', config.repeatQuietMs, () => chat.dim(t.unevenNoSubs));
      return;
    }

    resetSaid('unevenNoSubs');

    // Anyone who has said "give my seat away" goes first. That is how the
    // owner stays out of regulars' way without having to sit out by hand
    // every time. Otherwise it is random, because picking the newest or the
    // worst player would be its own kind of unfair.
    const volunteers = bigger.filter((id) => {
      const rec = registry.get(id);
      return rec && rec.yielding;
    });
    const from = volunteers.length ? volunteers : bigger;
    const victim = from[Math.floor(Math.random() * from.length)];

    cancelCommit(); // deliberate line-up change; see backfill()
    // Front of the queue. In practice the queue is always empty here — this
    // only runs when take() found nobody, and take() drains as it goes — so
    // the flag is a statement of intent rather than something you can observe:
    // they were playing through no fault of their own and get first refusal.
    enqueue(victim, true);
    room.setPlayerTeam(victim, TEAM.SPEC);
    chat.info(t.evenedUp(nameOf(victim)));

    currentMode =
      modes.bySize(smaller.length, currentMap || currentMode.map) || currentMode;
  }

  /**
   * Somebody has just walked in and there is no free seat. If anyone on the
   * pitch has volunteered to stand down, give the newcomer their place. The
   * match keeps running; the volunteer goes to the front of the queue.
   */
  function tryYieldSeat(newcomerId) {
    if (!gameRunning() || picking || isPausedNow() || !rotation) return false;
    if (!isAvailable(newcomerId)) return false;

    const snap = snapshot();
    const red = sideOf(snap, TEAM.RED);
    const blue = sideOf(snap, TEAM.BLUE);
    if (red.length !== blue.length) return false; // uneven: backfill handles it

    const onPitch = [...red, ...blue];
    const volunteer = onPitch.find((id) => {
      const rec = registry.get(id);
      return rec && rec.yielding;
    });
    if (volunteer === undefined) return false;

    const team = red.includes(volunteer) ? TEAM.RED : TEAM.BLUE;
    const slot = (team === TEAM.RED ? red : blue).indexOf(volunteer);

    cancelCommit(); // deliberate line-up change; see backfill()
    unqueue(newcomerId);
    enqueue(volunteer, true);
    room.setPlayerTeam(volunteer, TEAM.SPEC);
    room.setPlayerTeam(newcomerId, team);
    placeOnPitch(newcomerId, team, Math.max(0, slot));
    chat.info(t.yieldedSeat(nameOf(volunteer), nameOf(newcomerId)));
    return true;
  }

  // ------------------------------------------------- captain pause & subs

  /**
   * A captain can stop the clock once per match and change one of their own
   * players for someone off the bench.
   *
   *   !pausa            freezes the match and opens a 15 second window
   *   !banquear #id     names the player coming off (must be on their team)
   *   <number>          names the player coming on, from the numbered queue
   *
   * The window closes by itself, so a captain who wanders off mid-thought
   * cannot hold the match hostage. One pause per team per match, or the losing
   * side can stall forever.
   */
  let pauseState = null; // { captainId, team, timer }
  let benching = null; // { captainId, team, outId }
  const pauseUsed = new Set();

  /**
   * Paused, by anyone.
   *
   * A paused game still reports as running, so the bot happily kept tending it:
   * growing teams, swapping pitches, and — worst of all — letting the AFK sweep
   * run against a pitch where nobody can move. Ten seconds after an admin hit
   * pause, every player was in spectators and the match was gone.
   */
  const isPausedNow = () => pauseState !== null || enginePaused;

  /**
   * Nobody could move while it was paused, so nobody looks idle on purpose.
   * Without this, the pause itself counts as idle time and the sweep empties
   * the pitch one second after play resumes.
   */
  function forgiveIdle() {
    if (onResume) onResume();
  }

  /** The captain of a side is whoever has been on it longest. */
  function captainSideOf(playerId) {
    for (const team of [TEAM.RED, TEAM.BLUE]) {
      const side = teamOf(team);
      if (side.length && side[0].id === playerId) return team;
    }
    return null;
  }

  /** Drop the pause without resuming — for when the match is being torn down. */
  function clearPause() {
    if (pauseState) clearTimeout(pauseState.timer);
    pauseState = null;
    benching = null;
    forgiveIdle();
  }

  function endPause(quiet) {
    if (!pauseState) return;
    clearTimeout(pauseState.timer);
    pauseState = null;
    benching = null;
    if (!quiet) chat.info(t.pauseOver);
    room.pauseGame(false);
    forgiveIdle();
  }

  function startPause(player) {
    if (!gameRunning()) return chat.error(t.pauseNoGame, player.id);
    if (pauseState) return chat.error(t.pauseAlready, player.id);

    const team = captainSideOf(player.id);
    if (team === null && !player.admin) return chat.error(t.pauseNotCaptain, player.id);
    if (team !== null && pauseUsed.has(team)) return chat.error(t.pauseUsed, player.id);
    if (team !== null) pauseUsed.add(team);

    pauseState = { captainId: player.id, team, timer: null };
    room.pauseGame(true);
    chat.hype(t.pauseOpen(config.pauseSeconds));
    pauseState.timer = setTimeout(() => {
      try {
        endPause();
      } catch (err) {
        console.error('[teams] could not end the pause:', err);
        pauseState = null;
        benching = null;
      }
    }, config.pauseSeconds * 1000);
  }

  function benchPlayer(player, outId) {
    if (!pauseState) return chat.error(t.benchNoPause, player.id);
    if (player.id !== pauseState.captainId) return chat.error(t.benchNotCaptain, player.id);

    const out = room.getPlayer(outId);
    if (!out || out.team === TEAM.SPEC) return chat.error(t.benchNotYourTeam, player.id);
    // Admins who paused without captaining a side may bench from either team.
    if (pauseState.team !== null && out.team !== pauseState.team) {
      return chat.error(t.benchNotYourTeam, player.id);
    }

    const pool = waiting();
    if (pool.length === 0) return chat.error(t.benchNobodyWaiting, player.id);

    benching = { captainId: player.id, team: out.team, outId };
    chat.info(t.benchPrompt(nameOf(outId)));
    chat.info(t.pickList(pool.map((id, i) => `${i + 1}. ${nameOf(id)}`).join('   ')));
  }

  /** Returns true if the number was consumed by a substitution. */
  function trySubPick(player, text) {
    if (player.id !== benching.captainId) {
      chat.error(t.pickNotCaptain, player.id);
      return true;
    }

    const pool = waiting();
    const index = Number(text) - 1;
    if (index < 0 || index >= pool.length) {
      chat.error(t.pickInvalid, player.id);
      return true;
    }

    const inId = pool[index];
    const { outId, team } = benching;
    benching = null;

    unqueue(inId);
    enqueue(outId);
    cancelCommit(); // deliberate line-up change; see backfill()
    room.setPlayerTeam(outId, TEAM.SPEC);
    room.setPlayerTeam(inId, team);
    placeOnPitch(inId, team, Math.max(0, teamOf(team).length - 1));

    chat.ok(t.benchDone(nameOf(outId), nameOf(inId)));
    endPause(true);
    return true;
  }

  // ---------------------------------------------------------------- growth

  /**
   * Add players to a match already in progress, keeping the sides even and
   * never touching the map. Only possible when the next mode up uses the same
   * stadium — which is why 1v1 and 2v2 share the small pitch.
   */
  /**
   * Upgrade to a bigger mode that needs a different pitch.
   *
   * Haxball will not swap the stadium mid-match, so this is the one case that
   * cannot be seamless. Rather than making everyone wait out the current game,
   * we stop it, swap, and restart immediately with the same players on the
   * same sides plus the newcomers — a couple of seconds of dead time instead
   * of minutes in the spectator list.
   */
  function upgradeAcrossMaps(target) {
    const snap = snapshot();
    const red = [...snap].filter(([, tm]) => tm === TEAM.RED).map(([id]) => id);
    const blue = [...snap].filter(([, tm]) => tm === TEAM.BLUE).map(([id]) => id);

    // Only worth interrupting if we can actually fill the bigger mode. This is
    // a guard against a race — someone leaving between the mode being chosen
    // and this running — so it is hard to reach and is not covered by a test.
    const needed = (target.teamSize - red.length) + (target.teamSize - blue.length);
    if (waiting().length < needed) return false;

    // Same people, same sides, topped up from the queue. Reserve them now so
    // nothing else can claim them during the pause below.
    while (red.length < target.teamSize) {
      const id = take();
      if (id === null) break;
      red.push(id);
    }
    while (blue.length < target.teamSize) {
      const id = take();
      if (id === null) break;
      blue.push(id);
    }
    const planned = Math.min(red.length, blue.length);
    while (red.length > planned) enqueue(red.pop(), true);
    while (blue.length > planned) enqueue(blue.pop(), true);

    chat.hype(t.upgradeInterrupt(target.name));

    // Haxball refuses to change the stadium while a game is in progress, and
    // stopGame() does not take effect until the next tick. Doing both in one
    // go throws, the swap never happens, and the room is left with a dead
    // pitch and everyone standing on it. So: stop now, swap on the way back.
    cancelCommit();
    room.stopGame();
    lastModeChange = Date.now();

    setTimeout(() => {
      try {
        if (gameRunning()) {
          console.error('[teams] upgrade aborted — the game did not stop');
          return scheduleRebuild(null);
        }
        applyMode(target);

        const live = snapshot();
        const stillHere = (id) => live.has(id);
        const finalRed = red.filter(stillHere);
        const finalBlue = blue.filter(stillHere);
        const size = Math.min(finalRed.length, finalBlue.length);
        while (finalRed.length > size) enqueue(finalRed.pop(), true);
        while (finalBlue.length > size) enqueue(finalBlue.pop(), true);

        // Anyone who was on a team and did not make the new line-up goes back
        // in the queue. Without this they are quietly dropped to spectators and
        // never called again — a slow leak of players into limbo.
        for (const [id, tm] of live) {
          if (tm !== TEAM.SPEC && !finalRed.includes(id) && !finalBlue.includes(id)) enqueue(id);
        }

        const intended = applyPlan(live, finalRed, finalBlue);
        if (size === 0) return announceWaiting();
        room.startGame();
        commit(intended, true);
      } catch (err) {
        console.error('[teams] upgrade failed:', err);
        scheduleRebuild(null);
      }
    }, config.stopSettleMs === undefined ? 250 : config.stopSettleMs);

    return true;
  }

  function tryGrow() {
    if (!gameRunning() || picking || isPausedNow() || forcedMode) return false;

    const snap = snapshot();
    let red = sideOf(snap, TEAM.RED);
    let blue = sideOf(snap, TEAM.BLUE);

    // Compare against who is actually on the pitch, not the mode label. If two
    // people left a 2v2 it is really a 1v1 out there, and two newcomers should
    // be able to rebuild it to 2v2 — but currentMode still says "2v2", so
    // trusting the label would refuse to grow.
    // In solo training one side is empty by design, so min() is 0 and any
    // real mode counts as bigger. That is what we want.
    const onPitch = Math.min(red.length, blue.length);

    const target = modes.pickMode(availableCount(), config.teamSize);
    // Growth never targets solo; that is a shrink, handled by tendRunningMatch.
    // Belt and braces — the rebuild path below catches it too.
    if (target.solo) return false;
    if (target.teamSize <= onPitch) return false;

    // Ask the *stadium that is loaded*, not the mode label. The label lags
    // reality — `bySize()` happily hands back "1v1" (small pitch) for a 1v1
    // being played on the big pitch after a 4v4 collapsed — and a stale label
    // sends a same-pitch backfill down the stop-and-restart path, which resets
    // the score of a live match. Same bug the line above was already fixed for.
    const loadedMap = currentMap || currentMode.map;

    if (target.map !== loadedMap) {
      // Different pitch. Either interrupt briefly, or wait for the match to
      // end — but never thrash: a cooldown stops one person joining and
      // leaving from restarting the match over and over.
      if (!config.instantModeSwitch) return false;
      if (Date.now() - lastModeChange < config.modeSwitchCooldownMs) return false;
      return upgradeAcrossMaps(target);
    }

    let grew = false;
    const arrivals = [];
    while (red.length < target.teamSize && blue.length < target.teamSize && waiting().length >= 2) {
      const a = take();
      const b = take();
      if (a === null || b === null) {
        if (a !== null) enqueue(a, true);
        if (b !== null) enqueue(b, true);
        break;
      }
      red.push(a);
      blue.push(b);
      arrivals.push([a, TEAM.RED, red.length - 1], [b, TEAM.BLUE, blue.length - 1]);
      grew = true;
    }

    if (!grew) return false;

    cancelCommit(); // the line-up is changing on purpose; see backfill()
    applyPlan(snap, red, blue);
    // Only now, after the team moves have been sent. Positioning someone who
    // is not yet on a team does nothing at all — they have no disc to move.
    arrivals.forEach(([id, side, slot]) => placeOnPitch(id, side, slot));
    currentMode = modes.bySize(Math.min(red.length, blue.length), loadedMap) || currentMode;
    chat.hype(t.grewTo(currentMode.name));
    return true;
  }

  /** Someone left mid-match. Backfill their seat if anyone is waiting. */
  function backfill() {
    if (!gameRunning() || picking || isPausedNow()) return;
    // In solo training one side is empty on purpose. Dropping a newcomer onto
    // it would start a 1v1 on the practice pitch instead of switching to the
    // real one, so leave it to tryGrow.
    if (currentMode.solo) return;

    const snap = snapshot();
    const red = sideOf(snap, TEAM.RED);
    const blue = sideOf(snap, TEAM.BLUE);
    if (red.length === blue.length) {
      resetSaid('unevenNoSubs'); // teams are level again
      return;
    }

    const shortSide = red.length < blue.length ? TEAM.RED : TEAM.BLUE;
    const id = take();
    if (id === null) return evenUp(red, blue);
    resetSaid('unevenNoSubs');
    // The line-up is deliberately changing, so any confirmation still armed
    // from the last one is now wrong: it would put this substitute straight
    // back in spectators, and they would be in neither the queue nor the game.
    cancelCommit();
    room.setPlayerTeam(id, shortSide);
    placeOnPitch(id, shortSide, shortSide === TEAM.RED ? red.length : blue.length);
    chat.info(t.substituted(nameOf(id)));
  }

  // ---------------------------------------------------------------- reconcile

  /**
   * Safety net, run on a timer.
   *
   * Every "grow the match" and "start a match" path so far has been hung off a
   * specific event — a join, a leave, a return from AFK. That works right up
   * until one event path is missed or fires in an order nobody predicted, and
   * then the room just sits there while players stare at it. Which is exactly
   * what kept happening.
   *
   * So instead of trusting the events, this looks at reality every few seconds
   * and fixes whatever it finds. It is deliberately boring: if a match is on,
   * fill gaps and grow; if no match is on and one is possible, build it.
   */
  function reconcile() {
    if (picking) return; // a captain is mid-pick; leave them alone
    if (isPausedNow()) return; // the clock is stopped, by us or by an admin
    if (!rotation) return; // an admin has taken the wheel with !parar

    // Adopt orphans: anyone sitting in spectators who is not in the queue.
    // They should have been queued when they joined, but if that ever misses
    // — or they got dropped by some path we did not think of — they would
    // wait forever. Cheap to check, and it makes the queue self-healing.
    for (const p of humans()) {
      if (p.team === TEAM.SPEC && !queue.includes(p.id) && isAvailable(p.id)) {
        enqueue(p.id);
      }
    }

    if (gameRunning()) {
      tendRunningMatch();
      return;
    }

    // No match on. Work out what there *should* be and close the gap.
    //
    // This used to require two available players before it would do anything,
    // which left the one-player case with no safety net at all: if the solo
    // training session failed to start for any reason, the room sat there dead
    // and the only person in it watched an empty pitch until someone else
    // turned up. That is exactly what was reported. One player is enough.
    if (!rebuildTimer && config.autoStart && rotation) {
      const avail = availableCount();
      if (avail >= 1) {
        const playing = [...snapshot()].filter(([, tm]) => tm !== TEAM.SPEC).length;
        const target = forcedMode || modes.pickMode(avail, config.teamSize);
        const want = target.solo ? 1 : Math.min(avail, target.teamSize * 2);

        if (playing < want) {
          scheduleRebuild(null);
        } else if (want > 0) {
          // The right people are on the right teams and nothing is running —
          // the whistle simply never blew. Blow it.
          room.startGame();
        }
      }
    }
  }

  /**
   * Keep a running match honest: fill gaps, grow if we can, and if the match
   * no longer suits how many people are actually here, tear it down and build
   * the right one. Called both on events and from the reconcile timer.
   */
  function tendRunningMatch() {
    if (!gameRunning() || picking || isPausedNow()) return;

    backfill();
    if (tryGrow()) return;

    const target = forcedMode || modes.pickMode(availableCount(), config.teamSize);
    const snap = snapshot();
    const red = sideOf(snap, TEAM.RED).length;
    const blue = sideOf(snap, TEAM.BLUE).length;
    const playing = red + blue;

    // Three reasons to tear down and rebuild a running match:
    const wrongKind = !!target.solo !== !!currentMode.solo; // solo <-> real
    // A side emptied — or, on the training pitch, the one player left or went
    // away and the match is now running with nobody in it.
    const stranded = target.solo ? playing === 0 : red === 0 || blue === 0;
    // Genuinely more players out there than the mode allows. Measured on the
    // *even* part of the match, not the head count: a 2v1 has three people on
    // a pitch that now only calls for a 1v1, but it is one short, not one too
    // many. Counting heads tore down a perfectly good 2v1 the moment somebody
    // walked out of it — the exact interruption this room is supposed to avoid.
    // Backfill fills that seat when the next player arrives.
    const evenSize = Math.min(red, blue);
    const tooMany = !target.solo && evenSize > target.teamSize;

    if ((wrongKind || stranded || tooMany) && !rebuildTimer && rotation) scheduleRebuild(null);
  }

  // ---------------------------------------------------------------- events

  function onPlayerJoin(player) {
    if (isHost(player)) return;
    enqueue(player.id);

    // Mid-pick, a newcomer just waits their turn in the list the captain is
    // shown. Rebuilding here cancelled the pick outright and auto-filled the
    // teams, which looked to everyone like the bot had ignored the captain.
    if (picking || !rotation) return;

    if (gameRunning()) {
      // backfill first: growth adds players in pairs, so on its own it can
      // never close an odd one-seat gap left by someone walking out.
      tendRunningMatch();
      // Still waiting? Somebody may have volunteered their seat.
      if (queue.includes(player.id)) tryYieldSeat(player.id);
    } else if (config.autoStart) {
      scheduleRebuild(null);
    }
  }

  function onPlayerLeave(player) {
    unqueue(player.id);

    if (picking && picking.captainId === player.id) {
      const handover = { ...picking };
      clearTimeout(picking.timer);
      picking = null;
      if (rotation) passCaptaincy(handover, player.id);
      return;
    }
    if (picking || !rotation) return; // someone else left; the pick continues

    if (gameRunning()) tendRunningMatch();
    else if (config.autoStart) scheduleRebuild(null);
  }

  /**
   * A player's team changed for a reason the bot did not initiate — an admin
   * dragging somebody across, most often.
   *
   * Without this the queue and the pitch drift apart: a queued spectator put
   * on a team stays in the queue, and the bot then hands them out again.
   * `backfill` would "substitute" a player who was already playing, announcing
   * it in chat, and a captain could pick someone off the opposing team.
   */
  function onExternalTeamChange(player) {
    if (!player || isHost(player)) return;
    if (player.team === TEAM.SPEC) {
      if (isAvailable(player.id)) enqueue(player.id);
    } else {
      unqueue(player.id);
    }
  }

  /**
   * A player came back from AFK. Going away removed them from the queue, so
   * returning has to put them back — otherwise they sit in spectators forever
   * while the room insists it is short of players.
   */
  function onPlayerAvailable(playerId) {
    if (playerId !== undefined && isAvailable(playerId)) {
      const p = room.getPlayer(playerId);
      // Back of the queue, not the front. Coming back from AFK used to jump
      // you ahead of everyone who had been waiting, and since the first in
      // line captains the challenging side, "!afk, !afk" was a free captaincy
      // that could be repeated all night.
      if (p && p.team === TEAM.SPEC) enqueue(playerId);
    }

    if (!rotation) return;

    if (!gameRunning()) {
      if (config.autoStart) scheduleRebuild(null);
      return;
    }
    tendRunningMatch();
  }

  function onGameEnd(scores) {
    const winner =
      scores.red > scores.blue ? TEAM.RED : scores.blue > scores.red ? TEAM.BLUE : null;

    if (winner === null) chat.info(t.draw);
    else chat.ok(t.winnerStays(winner === TEAM.RED ? t.red : t.blue));

    if (!config.autoStart || !rotation) return;

    // Breathing room between matches. Snapping straight into the next game
    // gives nobody a moment to read the result, say "gg", or get their hands
    // back on the keys — especially in 1v1s, which end fast.
    const pause = Math.max(config.rebuildDelayMs, config.lobbyPauseMs);
    chat.info(t.nextMatchIn(Math.round(pause / 1000)));
    scheduleRebuild(winner, pause);
  }

  return {
    TEAM,
    teamOf,
    onPlayerJoin,
    onPlayerLeave,
    onPlayerAvailable,
    onGameEnd,
    tryPick,
    tryGrow,
    tryYieldSeat,
    reconcile,
    startPause,
    benchPlayer,
    /** Each match gets a fresh pause allowance per team. */
    onGameStart() {
      pauseUsed.clear();
      clearPause();
    },
    get isPaused() {
      return isPausedNow();
    },
    /** The client's own pause button, which the bot does not control. */
    setEnginePaused(value) {
      const was = enginePaused;
      enginePaused = !!value;
      if (was && !enginePaused) forgiveIdle();
    },
    /**
     * Forget which stadium we think is loaded, so the next rebuild uploads ours
     * again. Used after somebody tampers with the map.
     */
    forceMapReload() {
      currentMap = null;
    },
    /** Hand the room back and forth between the bot and an admin. */
    setRotation(on) {
      rotation = !!on;
      if (rotation) scheduleRebuild(null);
    },
    get rotationOn() {
      return rotation;
    },
    onExternalTeamChange,
    /**
     * True while the bot still has work queued: a rebuild waiting to fire, or
     * a line-up waiting to be confirmed.
     *
     * Exposed for the tests. They used to sleep a fixed number of milliseconds
     * and hope, which produced a flaky assertion in three releases running —
     * every one of which cost a deploy while we worked out whether it was a
     * real race or a slow machine. Waiting for the bot to actually go quiet is
     * both faster and honest: if it never does, that is the bug.
     */
    get busy() {
      return rebuildTimer !== null || confirmTimer !== null;
    },
    availableCount,
    debugState,
    setupNextMatch: scheduleRebuild,
    maybeStart: () => scheduleRebuild(null),
    fillTeams: () => scheduleRebuild(null),

    get mode() {
      return currentMode;
    },
    get currentStadium() {
      return modes.loadMap(currentMap || currentMode.map);
    },
    get queueList() {
      return waiting();
    },
    get captain() {
      return picking ? picking.captainId : null;
    },
    /**
     * Captain of a side for everyday purposes (kits, and anything else a team
     * should decide together): the first player on it, which is the one who
     * has been there longest since the winner stays and newcomers are pushed
     * on the end.
     */
    captainOf(team) {
      const side = teamOf(team);
      return side.length ? side[0].id : null;
    },
    get isPicking() {
      return picking !== null;
    },
    get forced() {
      return forcedMode;
    },

    force(mode) {
      forcedMode = mode;
      scheduleRebuild(null);
    },

    shuffle() {
      const snap = snapshot();
      const pool = [...snap].filter(([, tm]) => tm !== TEAM.SPEC).map(([id]) => id);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const half = Math.floor(pool.length / 2);
      applyPlan(snap, pool.slice(0, half), pool.slice(half));
      chat.info(t.teamsShuffled);
    },
  };
}

module.exports = { createTeams, TEAM };
