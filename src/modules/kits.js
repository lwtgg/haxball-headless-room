/**
 * Team kits.
 *
 * `room.setTeamColors(team, angle, textColour, [colours])` paints a side. The
 * colour array is up to three stripes; the text colour is the number on the
 * shirt. Angle is the stripe direction in degrees.
 *
 * Captains change their own team's kit with !kit. Everything is applied fresh
 * at the start of each match so a kit never leaks into the next one.
 */
const KITS = {
  // --- defaults ---
  clasico: { name: 'Clásico', angle: 0, text: 0xffffff, red: [0xe56e56], blue: [0x5689e5] },

  // --- clubs ---
  barca: { name: 'Barcelona', angle: 90, text: 0xffd700, colors: [0xa50044, 0x004d98, 0xa50044] },
  madrid: { name: 'Real Madrid', angle: 0, text: 0x00529f, colors: [0xffffff] },
  atleti: { name: 'Atlético', angle: 90, text: 0x272e61, colors: [0xffffff, 0xcb3524, 0xffffff] },
  juve: { name: 'Juventus', angle: 90, text: 0xffffff, colors: [0x000000, 0xffffff, 0x000000] },
  milan: { name: 'Milan', angle: 90, text: 0xffffff, colors: [0xfb090b, 0x000000, 0xfb090b] },
  inter: { name: 'Inter', angle: 90, text: 0xffffff, colors: [0x0068a8, 0x000000, 0x0068a8] },
  liverpool: { name: 'Liverpool', angle: 0, text: 0xffffff, colors: [0xc8102e] },
  city: { name: 'Man City', angle: 0, text: 0xffffff, colors: [0x6cabdd] },
  united: { name: 'Man United', angle: 0, text: 0xffffff, colors: [0xda291c] },
  chelsea: { name: 'Chelsea', angle: 0, text: 0xffffff, colors: [0x034694] },
  psg: { name: 'PSG', angle: 90, text: 0xffffff, colors: [0x004170, 0xda291c, 0x004170] },
  boca: { name: 'Boca', angle: 0, text: 0xfcdd09, colors: [0x0d2d6c, 0xfcdd09, 0x0d2d6c] },
  river: { name: 'River', angle: 45, text: 0x000000, colors: [0xffffff, 0xdd0000, 0xffffff] },

  // --- national ---
  mexico: { name: 'México', angle: 0, text: 0xffffff, colors: [0x006847] },
  argentina: { name: 'Argentina', angle: 90, text: 0x000000, colors: [0x75aadb, 0xffffff, 0x75aadb] },
  brasil: { name: 'Brasil', angle: 0, text: 0x009c3b, colors: [0xffdf00] },
  espana: { name: 'España', angle: 0, text: 0xffd700, colors: [0xc60b1e] },
  italia: { name: 'Italia', angle: 0, text: 0xffffff, colors: [0x0066cc] },
  francia: { name: 'Francia', angle: 0, text: 0xffffff, colors: [0x21304d] },
  colombia: { name: 'Colombia', angle: 0, text: 0x003893, colors: [0xfcd116] },
  usa: { name: 'USA', angle: 90, text: 0x0a3161, colors: [0xffffff, 0xb31942, 0xffffff] },

  // --- fun ---
  negro: { name: 'Negro', angle: 0, text: 0xffffff, colors: [0x111111] },
  rosa: { name: 'Rosa', angle: 0, text: 0xffffff, colors: [0xff4fa3] },
  neon: { name: 'Neón', angle: 45, text: 0x000000, colors: [0xccff00, 0x00ffcc] },
  oro: { name: 'Oro', angle: 45, text: 0x3a2d00, colors: [0xffd700, 0xffec8b, 0xffd700] },
};

const TEAM = { RED: 1, BLUE: 2 };

/** How far apart two kits' main colours must be to be told apart on the pitch. */
const MIN_KIT_DISTANCE = 200;

/** Default look for a side, used at the start of every match. */
function defaultFor(team) {
  const k = KITS.clasico;
  return { angle: k.angle, text: k.text, colors: team === TEAM.RED ? k.red : k.blue };
}

function get(id) {
  const key = String(id || '').toLowerCase();
  return KITS[key] ? { key, ...KITS[key] } : null;
}

function list() {
  return Object.keys(KITS);
}

/** The main colour of a kit, used to keep two teams from looking alike. */
function mainColor(kit, team) {
  if (kit.colors && kit.colors.length) return kit.colors[0];
  const pair = team === TEAM.RED ? kit.red : kit.blue;
  return (pair && pair[0]) || 0x888888;
}

/** Crude but effective: distance in RGB space. */
function colorDistance(a, b) {
  const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff);
  const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff);
  const db = (a & 0xff) - (b & 0xff);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Kits the bot may deal out at kickoff. `clasico` is left out on purpose: it is
 * the plain red-and-blue default, and dealing it randomly would look like the
 * feature had failed rather than like a choice.
 */
const RANDOM_POOL = Object.keys(KITS).filter((k) => k !== 'clasico');

function createKits({ room }) {
  // team -> kit key, for this match only
  const active = new Map();

  function apply(team, kit) {
    const spec = kit && kit.colors ? kit : defaultFor(team);
    room.setTeamColors(team, spec.angle, spec.text, spec.colors);
  }

  return {
    KITS,
    list,
    get,

    /** Put both sides back to the standard look. */
    reset() {
      active.clear();
      apply(TEAM.RED, null);
      apply(TEAM.BLUE, null);
    },

    /**
     * Deal both sides a random kit for the coming match.
     *
     * Captains can override theirs with !kit; that choice lasts until the next
     * match starts, at which point this runs again. So every match opens with a
     * fresh look instead of the same red-versus-blue every time.
     *
     * The two kits must not look alike: a white Madrid against a white River
     * is unplayable. Pick red first, then take the first blue candidate that is
     * far enough away in colour.
     */
    randomize({ keepTeam = null, keepKit = null } = {}) {
      active.clear();

      // The winners keep the shirt they won in, so a team on a run stays
      // recognisable even after a scramble puts them at the other end. Only
      // the side facing them gets a new one — and it has to clash with the
      // kept shirt, so work out the fixed side first and choose against it.
      const keeping = keepKit && get(keepKit) ? get(keepKit) : null;
      const fixedTeam = keeping ? (keepTeam === TEAM.BLUE ? TEAM.BLUE : TEAM.RED) : null;
      const freeTeam = fixedTeam === TEAM.RED ? TEAM.BLUE : TEAM.RED;

      const pool = [...RANDOM_POOL].filter((k) => !keeping || k !== keeping.key);
      const draw = () => pool.splice(Math.floor(Math.random() * pool.length), 1)[0];

      let fixedKit = keeping;
      if (!fixedKit) fixedKit = get(draw()); // cold start: both sides random
      const fixedSide = fixedTeam || TEAM.RED;
      const fixedColor = mainColor(fixedKit, fixedSide);

      // Take the first candidate far enough away in colour: a white Madrid
      // against a white River is unplayable.
      let otherKit = null;
      while (pool.length) {
        const candidate = get(draw());
        if (colorDistance(fixedColor, mainColor(candidate, freeTeam)) >= MIN_KIT_DISTANCE) {
          otherKit = candidate;
          break;
        }
      }

      const redKit = fixedSide === TEAM.RED ? fixedKit : otherKit;
      const blueKit = fixedSide === TEAM.RED ? otherKit : fixedKit;

      if (redKit) active.set(TEAM.RED, redKit.key);
      if (blueKit) active.set(TEAM.BLUE, blueKit.key);

      apply(TEAM.RED, redKit);
      apply(TEAM.BLUE, blueKit);

      // Everything left looked similar, which should not happen with this many
      // kits, but the plain default beats two teams in the same colour.
      return { red: redKit || { name: 'Clásico' }, blue: blueKit || { name: 'Clásico' } };
    },

    set(team, kitId) {
      const kit = get(kitId);
      if (!kit) return null;
      active.set(team, kit.key);
      apply(team, kit);
      return kit;
    },

    current: (team) => active.get(team) || null,
  };
}

module.exports = {
  createKits,
  KITS,
  list,
  get,
  defaultFor,
  mainColor,
  colorDistance,
  RANDOM_POOL,
  MIN_KIT_DISTANCE,
};
