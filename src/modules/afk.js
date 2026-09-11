const { TEAM } = require('./teams');
const { t } = require('../i18n');
const { notHost } = require('../util/host');

/**
 * AFK handling.
 *
 * The important lesson, learned the hard way: **do not detect activity from
 * `onPlayerActivity`.** The Haxball docs describe it as firing "when a player
 * gives signs of activity (e.g. pressing a key)", and that is exactly what it
 * means — a key *press*, not a key being held. Hold a direction while chasing
 * the ball for twenty seconds and the event never fires again, so the bot
 * concluded you had walked away and kicked you mid-run. Sitting still in
 * defence, tapping nothing, was the same story. That is why it was kicking
 * people, including the owner, in the middle of playing.
 *
 * So idleness is measured from the thing we actually care about: whether the
 * player's disc has moved. Every tick we sample their position and compare it
 * to the last one. A player who is playing moves hundreds of units a second; a
 * player who has walked away moves zero. Key presses, chat and ball touches
 * still count as activity on top of that, they are just no longer the only
 * signal.
 *
 * Three more rules, each from something that went wrong in production:
 *
 *   1. Only while a match is running, and never while paused. A paused game
 *      still reports as running, and nobody can move during one.
 *   2. Never on the training pitch. Somebody practising alone is not holding
 *      anybody up, and there is no match to protect.
 *   3. Auto-AFK kicks you out of the room rather than parking you in
 *      spectators, so "who is here" and "who can play" stay the same number.
 */
function createAfk({ room, chat, registry, config, teams }) {
  let interval = null;

  /**
   * How far a disc must move between samples to count as playing. Discs drift
   * a little from collisions and the ball, so this is not zero; a player who
   * is actually moving covers far more than this in a second.
   */
  const MOVED = 3;

  /** Any sign of life: key press, chat message, command, ball touch. */
  function markActivity(playerId) {
    const rec = registry.get(playerId);
    if (!rec) return;
    rec.lastActivity = Date.now();
    rec.afkWarned = false;
  }

  /**
   * Give everybody a clean slate. Called when a pause ends: nobody can move
   * while the game is frozen, so the pause itself looks exactly like idling.
   */
  function forgiveIdle() {
    const now = Date.now();
    for (const rec of registry.all()) {
      rec.lastActivity = now;
      rec.afkWarned = false;
      rec.lastPos = null;
    }
  }

  function toggle(playerId) {
    const rec = registry.get(playerId);
    if (!rec) return;
    rec.afk = !rec.afk;
    rec.afkWarned = false;
    rec.lastActivity = Date.now();
    rec.lastPos = null;

    if (rec.afk) {
      const p = room.getPlayer(playerId);
      if (p && p.team !== TEAM.SPEC) room.setPlayerTeam(playerId, TEAM.SPEC);
      chat.info(t.afkOn(rec.name));
      if (p) teams.onPlayerLeave(p);
    } else {
      chat.ok(t.afkOff(rec.name));
      teams.onPlayerAvailable(playerId);
    }
  }

  /** True if their disc has moved since the last sample. */
  function moving(playerId, rec) {
    let disc = null;
    try {
      disc = room.getPlayerDiscProperties(playerId);
    } catch (err) {
      disc = null;
    }
    // No disc means no game, no team, or the engine has not caught up. Either
    // way we cannot tell, and guessing "idle" is how people get kicked for
    // nothing.
    if (!disc) {
      rec.lastPos = null;
      return true;
    }

    const before = rec.lastPos;
    rec.lastPos = { x: disc.x, y: disc.y };
    if (!before) return true; // first sample: no evidence either way

    return Math.abs(disc.x - before.x) > MOVED || Math.abs(disc.y - before.y) > MOVED;
  }

  function sweep() {
    if (room.getScores() === null) return; // no match, nothing to protect
    if (teams.isPaused) return; // frozen: nobody *can* move
    // The training pitch is for practising alone. Nobody is waiting on them.
    if (teams.mode && teams.mode.solo) return;

    const limit = config.afkSeconds * 1000;
    const warnAt = Math.min(config.afkWarnSeconds * 1000, limit);
    const now = Date.now();

    for (const p of room.getPlayerList().filter(notHost)) {
      if (p.team === TEAM.SPEC) continue;
      const rec = registry.get(p.id);
      if (!rec || rec.afk) continue;

      if (moving(p.id, rec)) {
        rec.lastActivity = now;
        rec.afkWarned = false;
        continue;
      }

      const idle = now - rec.lastActivity;

      if (idle > limit) {
        chat.info(t.afkKicked(rec.name));
        room.kickPlayer(p.id, t.afkKickReason, false);
      } else if (idle > warnAt && !rec.afkWarned) {
        rec.afkWarned = true;
        chat.error(t.afkWarning(Math.max(1, Math.round((limit - idle) / 1000))), p.id);
      }
    }
  }

  function start() {
    if (interval) return;
    // Has to tick well inside the warning window, or the warning and the
    // removal land on the same pass and the warning is pointless.
    //
    // Wrapped because this is the highest-frequency entry point in the whole
    // bot — once a second, forever — and it is not a leaf: it kicks players,
    // which reaches team rebuilding and map swapping. A throw out of a bare
    // interval callback is an uncaught exception, which kills the process.
    interval = setInterval(() => {
      try {
        sweep();
      } catch (err) {
        console.error('[afk] sweep failed:', err);
      }
    }, config.afkTickMs || 1000);
  }

  function stop() {
    if (interval) clearInterval(interval);
    interval = null;
  }

  return {
    markActivity,
    forgiveIdle,
    toggle,
    start,
    stop,
    sweep,
    list: () => registry.all().filter((r) => r.afk),
  };
}

module.exports = { createAfk };
