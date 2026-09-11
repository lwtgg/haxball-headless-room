/**
 * Goal celebration: the scorer's disc swells up, and the assister's grows too,
 * by less. It is the single most satisfying bit of feedback in rooms that have
 * it, and it costs nothing but a radius.
 *
 * Two things to be careful about:
 *
 *   1. Restore the original radius. A player who leaves and rejoins mid
 *      celebration, or a match that ends while somebody is still puffed up,
 *      must not leave a giant disc on the pitch. Everything is restored on a
 *      timer, and again whenever a game starts or stops.
 *
 *   2. `setPlayerDiscProperties` only works on a player who has a disc, which
 *      means in a running game and on a team. Straight after a goal that holds,
 *      but the restore can easily land after the match has ended, so it has to
 *      cope with the disc being gone.
 */
function createCelebration({ room, config }) {
  /** playerId -> radius before we touched it */
  const originals = new Map();
  let timer = null;

  function discOf(playerId) {
    try {
      return room.getPlayerDiscProperties(playerId);
    } catch (err) {
      return null;
    }
  }

  function grow(playerId, scale) {
    if (!playerId && playerId !== 0) return false;
    if (!scale || scale <= 1) return false;

    const disc = discOf(playerId);
    if (!disc || !disc.radius) return false;

    // Never stack: if they are already swollen, measure from the original.
    const base = originals.has(playerId) ? originals.get(playerId) : disc.radius;
    originals.set(playerId, base);

    try {
      room.setPlayerDiscProperties(playerId, { radius: base * scale });
      return true;
    } catch (err) {
      originals.delete(playerId);
      return false;
    }
  }

  function restore(playerId) {
    if (!originals.has(playerId)) return;
    const radius = originals.get(playerId);
    originals.delete(playerId);
    // If they have no disc any more the size went with it, so a failure here
    // is fine and expected.
    if (!discOf(playerId)) return;
    try {
      room.setPlayerDiscProperties(playerId, { radius });
    } catch (err) {
      /* left the pitch mid-celebration */
    }
  }

  function restoreAll() {
    clearTimeout(timer);
    timer = null;
    for (const id of [...originals.keys()]) restore(id);
  }

  /**
   * @param scorerId  who scored, or null
   * @param assistId  who assisted, or null
   */
  function goal(scorerId, assistId) {
    // A second goal while the first celebration is still running just pushes
    // the restore back; there is no reason to make everyone flicker down and
    // up again. What must not happen is measuring the new size from the
    // already-swollen one — three times three is nine, and the restore would
    // then put back a radius nobody ever had. `grow` always measures from the
    // stored original for exactly that reason.
    const grewScorer = grow(scorerId, config.celebrationScorerScale);
    const grewAssist = grow(assistId, config.celebrationAssistScale);

    // Re-arm from whatever is actually inflated, rather than clearing the old
    // timer up front. Clearing first meant that a goal credited to somebody who
    // had already left — no disc, so both grows fail — destroyed the only timer
    // that would have shrunk the players from the *previous* goal, leaving them
    // triple-sized, with a goal-wide hitbox, for the rest of the match.
    if (!grewScorer && !grewAssist && originals.size === 0) return;

    clearTimeout(timer);
    timer = setTimeout(restoreAll, config.celebrationMs);
  }

  return { goal, restore, restoreAll, get active() { return originals.size; } };
}

module.exports = { createCelebration };
