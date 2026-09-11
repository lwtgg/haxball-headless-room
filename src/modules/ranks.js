/**
 * Rank progression.
 *
 * XP is earned by playing, not just winning, so someone on a losing streak
 * still climbs slowly. Thresholds widen as you go so the top ranks stay rare.
 */
/**
 * `color` is what a player's chat line is painted in, so rank is visible every
 * time somebody speaks. All eight are light and saturated enough to read on
 * Haxball's dark background — nothing dim, nothing that fades into the pitch —
 * and they run cool to warm so the ladder is legible at a glance without
 * having to know the names.
 */
const RANKS = [
  { name: 'Novato', xp: 0, tag: '🥚', color: 0xc7d2da },
  { name: 'Amateur', xp: 150, tag: '🐣', color: 0x7dd87d },
  { name: 'Semipro', xp: 500, tag: '⚡', color: 0x5ac8fa },
  { name: 'Profesional', xp: 1200, tag: '🔥', color: 0xb794f6 },
  { name: 'Crack', xp: 2500, tag: '💎', color: 0xff9f45 },
  { name: 'Estrella', xp: 5000, tag: '⭐', color: 0xffd166 },
  { name: 'Ídolo', xp: 9000, tag: '👑', color: 0xff7ab6 },
  { name: 'Leyenda', xp: 15000, tag: '🏆', color: 0xff5c5c },
];

const XP = {
  goal: 20,
  assist: 12,
  win: 40,
  loss: 10, // showing up still counts
  cleanSheet: 25,
};

function rankFor(xp) {
  let current = RANKS[0];
  for (const r of RANKS) if (xp >= r.xp) current = r;
  return current;
}

function nextRank(xp) {
  return RANKS.find((r) => r.xp > xp) || null;
}

function label(xp) {
  const r = rankFor(xp);
  return `${r.tag} ${r.name}`;
}

/** Colour for a player's chat line, by XP. */
function colorFor(xp) {
  return rankFor(xp).color;
}

module.exports = { RANKS, XP, rankFor, nextRank, label, colorFor };
