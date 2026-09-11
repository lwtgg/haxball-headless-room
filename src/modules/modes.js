const fs = require('fs');
const path = require('path');

/**
 * Game modes.
 *
 * The room picks the biggest mode it can fill from the players who are
 * actually available, and swaps the map to match. Two people in the room get
 * a 1v1 on the small pitch; eight get a 4v4 on the big one.
 *
 * `need` is how many players must be present for the mode to be used —
 * always teamSize * 2, but spelled out so it is obvious.
 *
 * Order matters: highest first, since we take the first one that fits.
 */
const MODES = [
  { name: '4v4', teamSize: 4, need: 8, map: 'futsal4v4.hbs' },
  { name: '3v3', teamSize: 3, need: 6, map: 'futsal4v4.hbs' },
  // 2v2 shares the small pitch with 1v1 on purpose: same map means the bot can
  // grow a live 1v1 into a 2v2 without stopping the match.
  { name: '2v2', teamSize: 2, need: 4, map: 'futsal1v1.hbs' },
  { name: '1v1', teamSize: 1, need: 2, map: 'futsal1v1.hbs' },
  // One person alone gets the training pitch — shooting practice beats
  // staring at an empty field waiting for someone to turn up.
  { name: 'entrenamiento', teamSize: 1, need: 1, map: 'training.hbs', solo: true },
];

/**
 * How far from the centre spot a player stands, as a fraction of the distance
 * to their own goal. Applies to everyone: kickoff line-ups and anyone dropped
 * into a match already in progress.
 */
const SPAWN_RATIO = 0.45;

/** Stadium files are read once and kept in memory. */
const rawCache = new Map();
const preparedCache = new Map();

function readRaw(file) {
  if (rawCache.has(file)) return rawCache.get(file);
  const p = path.resolve('maps', file);
  if (!fs.existsSync(p)) throw new Error(`Map not found: ${p}`);
  const text = fs.readFileSync(p, 'utf8');
  rawCache.set(file, text);
  return text;
}

/**
 * Hand back the stadium with its spawn distance corrected.
 *
 * These maps carry `spawnDistance: 366.5`, a number that came from a big-pitch
 * template. On the 4v4 pitch (goal line at 708) that is a sensible halfway
 * position. On the 1v1 pitch (goal line at 408) it is 90% of the way to your
 * own net, so both players start pinned to their own goal line with the whole
 * pitch behind the ball. It looks wrong because it is wrong.
 *
 * Overriding it here rather than editing the `.hbs` files means the maps stay
 * byte-identical to what their authors published, and a replacement map gets
 * the same treatment automatically.
 */
function loadMap(file) {
  if (preparedCache.has(file)) return preparedCache.get(file);

  let text = readRaw(file);
  try {
    const s = JSON.parse(text);
    s.spawnDistance = Math.round(mapGeometry(file).goalX * SPAWN_RATIO);
    text = JSON.stringify(s);
  } catch (err) {
    console.error('[modes] could not set spawn distance on', file, err.message);
  }

  preparedCache.set(file, text);
  return text;
}

/**
 * Where to drop a player who joins a match already in progress.
 *
 * Haxball puts late arrivals at the stadium's spawn distance, which on these
 * maps is past the goal line — they appear stuck behind their own net and have
 * to run the length of the pitch. So we place them ourselves, in their own
 * half, between the centre circle and the penalty area.
 *
 * The numbers come from the stadium file rather than being hardcoded per mode,
 * because the maps get replaced from time to time and a hardcoded x that was
 * inside the old pitch can be outside the new one. `goalX` is the goal line;
 * anything comfortably inside it is on the grass.
 */
const geometry = new Map();

function mapGeometry(file) {
  if (geometry.has(file)) return geometry.get(file);

  let goalX = 0;
  let halfHeight = 0;
  try {
    const s = JSON.parse(readRaw(file));
    for (const g of s.goals || []) {
      goalX = Math.max(goalX, Math.abs(g.p0[0]), Math.abs(g.p1[0]));
    }
    for (const v of s.vertexes || []) {
      if (!goalX) goalX = 0; // filled in below if there are no goals
      halfHeight = Math.max(halfHeight, Math.abs(v.y));
    }
    if (!goalX) {
      // Training pitches have no goals; fall back to the outer wall.
      for (const v of s.vertexes || []) goalX = Math.max(goalX, Math.abs(v.x));
    }
  } catch (err) {
    console.error('[modes] could not read geometry of', file, err.message);
  }

  const g = { goalX: goalX || 400, halfHeight: halfHeight || 200 };
  geometry.set(file, g);
  return g;
}

/**
 * @param file  stadium file the match is being played on
 * @param side  -1 for red (negative half), +1 for blue
 * @param slot  which player of that side this is, so they do not stack up
 */
function spawnPoint(file, side, slot = 0) {
  const { goalX, halfHeight } = mapGeometry(file);

  // Same distance the stadium's own spawn points now use, so a player added
  // mid-match lines up with everyone who started the match.
  const x = goalX * SPAWN_RATIO * (side < 0 ? -1 : 1);

  // Fan out from the middle: 0, -1, +1, -2, +2 rows.
  const step = Math.round(halfHeight * 0.3);
  const n = Math.max(0, Math.floor(slot));
  const row = n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  const limitY = halfHeight - 40;
  const y = Math.max(-limitY, Math.min(limitY, row * step));

  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Biggest mode that `available` players can fill.
 * Falls back to the smallest mode so the room always has something set.
 */
function pickMode(available, maxTeamSize) {
  const usable = MODES.filter((m) => !maxTeamSize || m.teamSize <= maxTeamSize);
  return usable.find((m) => available >= m.need) || usable[usable.length - 1];
}

/** Can we move between these modes without a map swap (i.e. mid-match)? */
function sameMap(a, b) {
  return !!a && !!b && a.map === b.map;
}

function byName(name) {
  return MODES.find((m) => m.name.toLowerCase() === String(name).toLowerCase()) || null;
}

/**
 * Mode for a given team size. Pass the stadium that is actually loaded and you
 * get the mode that plays on it — without that, a 1v1 being played on the big
 * pitch (a collapsed 4v4) reports as the small-pitch "1v1" mode, and anything
 * that later trusts `mode.map` concludes the wrong pitch is loaded.
 */
function bySize(size, mapFile) {
  const n = Number(size);
  if (mapFile) {
    const onMap = MODES.find((m) => m.teamSize === n && m.map === mapFile);
    if (onMap) return onMap;
  }
  return MODES.find((m) => m.teamSize === n) || null;
}

module.exports = { MODES, pickMode, loadMap, byName, bySize, sameMap, spawnPoint, mapGeometry };
