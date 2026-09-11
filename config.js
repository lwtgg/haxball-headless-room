require('dotenv').config();

/**
 * Empty BOT_NAME means "no host player". Unset means "use the default".
 */
function botName() {
  const raw = process.env.BOT_NAME;
  if (raw === undefined) return 'BOT';
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A country code with no coordinates is the worst of both worlds: the room
 * shows the right flag but sits at latitude 0, longitude 0 — in the ocean off
 * west Africa — so every player sees it as ten thousand kilometres away and it
 * sorts to the bottom of the list. Refuse to send a half-filled geo.
 */
function buildGeo() {
  const code = (process.env.GEO_CODE || '').trim();
  if (!code) return null;

  const lat = Number(process.env.GEO_LAT);
  const lon = Number(process.env.GEO_LON);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
    console.log(
      `\n!! GEO_CODE is set to "${code}" but GEO_LAT/GEO_LON are missing or 0,0.\n` +
        '!! That would put the room in the ocean and bury it at the bottom of\n' +
        "!! everyone's list. Ignoring the override and using your real location.\n" +
        '!! Set both coordinates in .env, or clear GEO_CODE.\n'
    );
    return null;
  }

  return { code, lat, lon };
}

module.exports = {
  // ---- Room identity ----
  roomName: process.env.ROOM_NAME || 'My Futsal 4v4 ⚽',
  maxPlayers: Number(process.env.MAX_PLAYERS || 30),
  // Anything other than a literal "false" means public.
  public: String(process.env.PUBLIC || 'true').trim().toLowerCase() !== 'false',

  // Name shown for the bot in the spectator list. Set BOT_NAME to empty to
  // run with no host player at all (noPlayer: true).
  botName: botName(),
  noPlayer: botName() === null,

  // Token from https://www.haxball.com/headlesstoken (expires fast)
  token: (process.env.HAXBALL_TOKEN || '').trim(),

  // Optional: lie about where the room is, which changes the flag and the
  // "distance" every player sees. Leave GEO_CODE empty to report your real
  // location. Only set this once the room is confirmed working — a wrong geo
  // pushes you down everyone's list, including your own.
  geo: buildGeo(),

  // ---- Match settings ----
  map: process.env.MAP_FILE || 'futsal4v4.hbs',
  teamSize: Number(process.env.TEAM_SIZE || 4),   // players per side
  scoreLimit: Number(process.env.SCORE_LIMIT || 3),
  timeLimit: Number(process.env.TIME_LIMIT || 3), // minutes
  autoStart: true,
  // How long the bot waits before rebuilding teams after a match ends.
  rebuildDelayMs: Number(process.env.REBUILD_DELAY_MS || 1500),
  // Extra breathing room in the lobby after a match ends, before the next one.
  lobbyPauseMs: Number(process.env.LOBBY_PAUSE_MS || 6000),
  // How long a captain has to make each pick before losing the room.
  pickSeconds: Number(process.env.PICK_SECONDS || 30),
  // DEBUG_TEAMS=1 logs the full team/queue state on every rebuild.
  debugTeams: String(process.env.DEBUG_TEAMS || '') === '1',
  // After this many minutes empty and silent, check we are still published.
  livenessQuietMinutes: Number(process.env.LIVENESS_QUIET_MINUTES || 20),
  // How often the bot re-checks that teams match reality (safety net).
  reconcileMs: Number(process.env.RECONCILE_MS || 4000),
  // How long to wait for a queued stopGame() to actually take effect before
  // touching the stadium or starting the next match.
  stopSettleMs: Number(process.env.STOP_SETTLE_MS || 250),
  // How long after applying a line-up to check that it really landed.
  confirmDelayMs: Number(process.env.CONFIRM_DELAY_MS || 400),
  // Gap between attempts to position a player who joined mid-match. They have
  // no disc until the team change lands, so the first try usually finds nothing.
  spawnRetryMs: Number(process.env.SPAWN_RETRY_MS || 120),
  // Conditions re-checked on a timer are only announced once per this long.
  repeatQuietMs: Number(process.env.REPEAT_QUIET_MS || 90000),
  // When a bigger mode needs a different pitch, restart the match immediately
  // instead of waiting for it to finish. Set to 0 to wait instead.
  instantModeSwitch: String(process.env.INSTANT_MODE_SWITCH || '1') !== '0',
  // Minimum gap between map changes, so the room cannot thrash.
  modeSwitchCooldownMs: Number(process.env.MODE_SWITCH_COOLDOWN_MS || 20000),

  // ---- Goal celebration ----
  // The scorer's disc swells to this multiple of its normal size, the
  // assister's to a smaller one, for celebrationMs before shrinking back.
  celebrationScorerScale: Number(process.env.CELEBRATION_SCORER_SCALE || 3),
  celebrationAssistScale: Number(process.env.CELEBRATION_ASSIST_SCALE || 1.9),
  celebrationMs: Number(process.env.CELEBRATION_MS || 4000),

  // ---- Economy / progression ----
  coinName: process.env.COIN_NAME || 'zicoins',
  betWindowSeconds: Number(process.env.BET_WINDOW_SECONDS || 45),
  // Ceiling on a single bet. Payouts are fixed at 2x, so without a cap one
  // arranged result can mint an unbounded pile of coins.
  betMax: Number(process.env.BET_MAX || 500),

  // ---- Chat flood protection ----
  // Only repeats are policed. Say the same line this many times and the next
  // one is swallowed; different messages are never blocked, however fast.
  spamRepeatLimit: Number(process.env.SPAM_REPEAT_LIMIT || 3),
  // How long the offender sits out after going over the limit.
  spamCooldownMs: Number(process.env.SPAM_COOLDOWN_MS || 5000),
  // Repeats only count as repeats if they come within this window.
  spamRepeatWindowMs: Number(process.env.SPAM_REPEAT_WINDOW_MS || 30000),
  spamWarnCooldownMs: Number(process.env.SPAM_WARN_COOLDOWN_MS || 3000),

  // ---- Moderation ----
  adminPassword: process.env.ADMIN_PASSWORD || 'changeme',
  // Comma-separated Haxball auth hashes that get admin automatically on join.
  // Get yours in the room with !auth.
  adminAuths: process.env.ADMIN_AUTHS || '',
  // Idle time before a player on the pitch is sent to spectators, and how long
  // before that they get warned. Only counts while a match is running.
  afkSeconds: Number(process.env.AFK_SECONDS || 20),
  afkWarnSeconds: Number(process.env.AFK_WARN_SECONDS || 12),
  // How often the AFK check runs. Has to be well inside the warning window or
  // the warning and the removal land on the same pass.
  afkTickMs: Number(process.env.AFK_TICK_MS || 1000),
  // How long a captain's !pausa window lasts before the match resumes itself.
  pauseSeconds: Number(process.env.PAUSE_SECONDS || 15),
  discordLink: process.env.DISCORD_LINK || 'https://discord.gg/yourinvite',

  // ---- Storage ----
  dataFile: 'data/stats.json',
};
