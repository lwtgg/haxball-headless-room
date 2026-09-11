/**
 * Who gets credited for a goal.
 *
 * `touches` is the recent touch log, most recent first, with consecutive
 * touches by the same player already collapsed into one entry:
 *
 *     [{ id, team }, { id, team }, ...]
 *
 * The rule that matters, and the one the old version got wrong: **an opponent
 * touch between the pass and the goal cancels the assist.** The old code
 * searched backwards for any earlier touch by the scoring team, so a defender
 * miscontrolling the ball straight to a striker handed an assist to whoever on
 * the striker's team had touched it last, possibly half a minute earlier. If
 * the ball changed hands, nobody set that goal up.
 *
 * A player who dribbles the length of the pitch and scores gets no assist
 * either, which falls out of the same walk: their own touches are skipped, and
 * if nothing is left there is nobody to credit.
 */
function creditGoal(touches, team) {
  const last = touches && touches[0];
  if (!last) return { scorerId: null, assistId: null, ownGoalId: null };

  // Last touch by the other side means they put it in their own net.
  if (last.team !== team) {
    return { scorerId: null, assistId: null, ownGoalId: last.id };
  }

  const scorerId = last.id;

  // Walk back to the previous *different* player. Anything by the scorer in
  // between is just them carrying the ball.
  let previous = null;
  for (let i = 1; i < touches.length; i++) {
    if (touches[i].id === scorerId) continue;
    previous = touches[i];
    break;
  }

  if (!previous || previous.team !== team) {
    return { scorerId, assistId: null, ownGoalId: null };
  }

  return { scorerId, assistId: previous.id, ownGoalId: null };
}

module.exports = { creditGoal };
