/**
 * Goal credit and the celebration.
 *
 * The assist rule is the interesting part. The first version searched
 * backwards for any earlier touch by the scoring team, so a defender
 * miscontrolling the ball to an opponent handed that opponent's team an assist
 * for a pass nobody made.
 *
 * Run with: npm run test:goals
 */
process.chdir(require('path').resolve(__dirname, '..'));

const assert = require('assert');
const { creditGoal } = require('../src/modules/goalcredit');
const { createCelebration } = require('../src/modules/celebrate');

const RED = 1;
const BLUE = 2;
const touch = (id, team) => ({ id, team });

// ---- assists -----------------------------------------------------------
{
  // A pass from a teammate is an assist.
  const log = [touch(1, RED), touch(2, RED)]; // p2 passed, p1 scored
  assert.deepStrictEqual(creditGoal(log, RED), { scorerId: 1, assistId: 2, ownGoalId: null });
}

{
  // Solo run: nobody else touched it, so nobody assisted.
  assert.deepStrictEqual(creditGoal([touch(1, RED)], RED), {
    scorerId: 1,
    assistId: null,
    ownGoalId: null,
  });
}

{
  // The scorer's own earlier touches are skipped rather than credited. The
  // touch log collapses consecutive touches before it gets here, so this
  // should not arise in practice — but if it ever did, crediting it would
  // hand the scorer an assist for their own goal.
  const log = [touch(1, RED), touch(1, RED), touch(2, RED)];
  const out = creditGoal(log, RED);
  assert.strictEqual(out.scorerId, 1);
  assert.strictEqual(out.assistId, 2, 'the teammate assisted, not the scorer themself');
}

{
  // Dribbling past people still counts as solo. Consecutive touches by the
  // same player are collapsed before they get here, but the scorer can appear
  // again further back after somebody else intervened.
  const log = [touch(1, RED), touch(9, BLUE), touch(1, RED), touch(2, RED)];
  const out = creditGoal(log, RED);
  assert.strictEqual(out.scorerId, 1, 'p1 scored');
  assert.strictEqual(out.assistId, null, 'the ball went through an opponent, so no assist');
}

{
  // The case he described: an opponent gives it away, the striker scores.
  // The striker's teammate touched it earlier, but that was a different move.
  const log = [touch(1, RED), touch(9, BLUE), touch(2, RED)];
  const out = creditGoal(log, RED);
  assert.strictEqual(out.scorerId, 1);
  assert.strictEqual(out.assistId, null, 'a gift from the opposition is not an assist');
}

{
  // Two teammates in a row: the most recent one gets it.
  const log = [touch(1, RED), touch(2, RED), touch(3, RED)];
  assert.strictEqual(creditGoal(log, RED).assistId, 2, 'the last passer assists, not the first');
}

{
  // Own goal: the last touch was an opponent of the team that scored.
  const log = [touch(9, BLUE), touch(1, RED)];
  assert.deepStrictEqual(creditGoal(log, RED), {
    scorerId: null,
    assistId: null,
    ownGoalId: 9,
  });
}

{
  // Nobody touched it at all (kickoff deflection off a wall, restarts).
  assert.deepStrictEqual(creditGoal([], RED), {
    scorerId: null,
    assistId: null,
    ownGoalId: null,
  });
}

// ---- celebration -------------------------------------------------------
function makeRoom({ radius = 15 } = {}) {
  const discs = new Map();
  const calls = [];
  return {
    calls,
    discs,
    add: (id) => discs.set(id, { radius }),
    room: {
      getPlayerDiscProperties: (id) => (discs.has(id) ? { ...discs.get(id) } : null),
      setPlayerDiscProperties: (id, props) => {
        if (!discs.has(id)) throw new Error('no disc');
        discs.set(id, { ...discs.get(id), ...props });
        calls.push({ id, ...props });
      },
    },
  };
}

const config = { celebrationScorerScale: 3, celebrationAssistScale: 2, celebrationMs: 60 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // ---- the scorer swells, the assister less so ------------------------
  {
    const w = makeRoom();
    w.add(1);
    w.add(2);
    const celebrate = createCelebration({ room: w.room, config });

    celebrate.goal(1, 2);
    assert.strictEqual(w.discs.get(1).radius, 45, 'scorer tripled');
    assert.strictEqual(w.discs.get(2).radius, 30, 'assister doubled');
    assert(w.discs.get(1).radius > w.discs.get(2).radius, 'and the scorer is the bigger one');

    await wait(120);
    assert.strictEqual(w.discs.get(1).radius, 15, 'scorer back to normal');
    assert.strictEqual(w.discs.get(2).radius, 15, 'assister back to normal');
    assert.strictEqual(celebrate.active, 0, 'nothing left inflated');
  }

  // ---- a solo goal only grows the scorer ------------------------------
  {
    const w = makeRoom();
    w.add(1);
    const celebrate = createCelebration({ room: w.room, config });

    celebrate.goal(1, null);
    assert.strictEqual(w.discs.get(1).radius, 45);
    await wait(120);
    assert.strictEqual(w.discs.get(1).radius, 15);
  }

  // ---- a second goal mid-celebration does not stack --------------------
  // Without this, a quick second goal measures from the already-swollen
  // radius and the restore puts back the wrong number, leaving a permanently
  // oversized disc on the pitch.
  {
    const w = makeRoom();
    w.add(1);
    const celebrate = createCelebration({ room: w.room, config });

    celebrate.goal(1, null);
    celebrate.goal(1, null);
    assert.strictEqual(w.discs.get(1).radius, 45, 'still three times the original, not nine');

    await wait(120);
    assert.strictEqual(w.discs.get(1).radius, 15, 'and it goes back to the real original');
  }

  // ---- a player who leaves mid-celebration does not break the restore --
  {
    const w = makeRoom();
    w.add(1);
    w.add(2);
    const celebrate = createCelebration({ room: w.room, config });

    celebrate.goal(1, 2);
    w.discs.delete(1); // they left the pitch

    await wait(120);
    assert.strictEqual(w.discs.get(2).radius, 15, 'the other one still shrank back');
    assert.strictEqual(celebrate.active, 0, 'and nothing is left tracked');
  }

  // ---- the match ending shrinks everyone immediately -------------------
  {
    const w = makeRoom();
    w.add(1);
    const celebrate = createCelebration({ room: w.room, config });

    celebrate.goal(1, null);
    celebrate.restoreAll(); // onGameStop
    assert.strictEqual(w.discs.get(1).radius, 15, 'no giant disc carried into the next match');
  }

  // ---- no disc, no crash ----------------------------------------------
  {
    const w = makeRoom();
    const celebrate = createCelebration({ room: w.room, config });
    celebrate.goal(1, 2); // neither is on the pitch
    assert.strictEqual(celebrate.active, 0, 'nothing tracked, nothing thrown');
  }

  console.log('\nAll goal/celebration tests passed.\n');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
