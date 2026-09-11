/**
 * Offline smoke test. Fakes the Haxball room API so we can exercise the wiring
 * without a token or a live connection. Run with: npm test
 *
 * Covers room logic only. It mocks HBInit, so it says nothing about whether
 * a real token or connection works.
 */
process.chdir(require('path').resolve(__dirname, '..'));

const assert = require('assert');
const config = {
  ...require('../config'),
  dataFile: 'data/test-stats.json',
  adminPassword: 'pw',
  token: 'x',
  coinName: 'zicoins',
  betWindowSeconds: 60,
  // Flood protection off: this suite fires dozens of messages instantly.
  // It has its own file, test/antispam.js.
  spamCooldownMs: 0,
  spamRepeatMs: 0,
  spamStrikes: 999,
};
const { startRoom } = require('../src/room');
const ranks = require('../src/modules/ranks');

require('fs').rmSync('data/test-stats.json', { force: true });

let players = [];
const sent = [];
const avatars = new Map();
const kickRate = [];
const teamColors = [];
let teamsLocked = null;
const stadiumSets = [];
let stadiumSetsBeforeHijack = 0;
let started = false;

const fakeRoom = {
  onRoomLink: null,
  getPlayerList: () => players.map((p) => ({ ...p })),
  getPlayer: (id) => players.find((p) => p.id === id) || null,
  getScores: () => (started ? { red: 0, blue: 0, time: 0 } : null),
  // Deferred, like the real API. See the note in test/rotation.js.
  setPlayerTeam: (id, team) => {
    setTimeout(() => {
      const p = players.find((x) => x.id === id);
      if (p) p.team = team;
    }, 0);
  },
  setPlayerAdmin: (id, v) => {
    const p = players.find((x) => x.id === id);
    if (p) p.admin = v;
  },
  setPlayerAvatar: (id, a) => avatars.set(id, a),
  setKickRateLimit: (...a) => kickRate.push(a),
  setTeamColors: (...a) => teamColors.push(a),
  setPlayerDiscProperties: () => {},
  reorderPlayers: () => {},
  kickPlayer: (id) => {
    players = players.filter((p) => p.id !== id);
  },
  clearBan: () => {},
  startGame: () => {
    started = true;
  },
  stopGame: () => {
    started = false;
  },
  pauseGame: () => {},
  setCustomStadium: (s) => {
    assert(s.length > 1000, 'stadium string looks empty');
    JSON.parse(s);
    stadiumSets.push(s.length);
  },
  setScoreLimit: () => {},
  setTimeLimit: () => {},
  setTeamsLock: (v) => {
    teamsLocked = v;
  },
  sendAnnouncement: (msg, target, color, style, sound) =>
    sent.push({ msg, target, color, style, sound }),
};

const room = startRoom(() => fakeRoom, config);
const lastMsg = () => sent[sent.length - 1].msg;
const anySaid = (fragment) => sent.some((s) => String(s.msg).includes(fragment));

// --- join 8 players ---------------------------------------------------
for (let i = 1; i <= 8; i++) {
  const p = { id: i, name: `p${i}`, team: 0, admin: false, auth: `auth${i}`, conn: `conn${i}` };
  players.push(p);
  room.onPlayerJoin(p);
}
assert.strictEqual(players.length, 8, 'all players joined');
assert(anySaid('Bienvenido p1'), 'welcome message is in Spanish');

// --- commands ---------------------------------------------------------
const p1 = players[0];
const p2 = players[1];

assert.strictEqual(room.onPlayerChat(p1, '!ayuda'), false, 'commands are swallowed');
assert(anySaid('!me'), '!ayuda lists commands');

room.onPlayerChat(p1, '!help'); // alias
assert(anySaid('Comandos:'), 'English alias resolves to Spanish command');

room.onPlayerChat(p1, '!me');
assert(lastMsg().includes('zicoins'), '!me shows rank and coins');

room.onPlayerChat(p1, '!claim wrong');
assert(lastMsg().includes('incorrecta'), 'bad password rejected in Spanish');

room.onPlayerChat(p1, '!claim pw');
assert(p1.admin === true, 'claim grants admin');

room.onPlayerChat(p1, '!nonsense');
assert(lastMsg().includes('desconocido'), 'unknown command handled');

room.onPlayerChat(p2, '!rr');
assert(lastMsg().includes('admins'), 'admin gate works');

// --- afk --------------------------------------------------------------
room.onPlayerChat(p2, '!afk');
assert(lastMsg().includes('AFK'), 'afk toggles');
room.onPlayerChat(p2, '!afk');
assert(lastMsg().includes('fila'), 'afk toggles back');

// --- goals, coins, xp, celebrations -----------------------------------
players[0].team = 1;
players[1].team = 1;
players[2].team = 2;
started = true; // the fake room only flips this via startGame()
room.onGameStart();
assert(anySaid('Empieza el partido'), 'match start announced in Spanish');
assert(anySaid('Apuestas abiertas'), 'betting opens with the match');

assert(anySaid('Kits de hoy'), 'kits are dealt at kickoff');

room.onPlayerBallKick(players[1]); // assist
room.onPlayerBallKick(players[0]); // scorer
room.onTeamGoal(1);
assert(anySaid('⚽ p1') && anySaid('asistencia: p2'), 'goal + assist credited');

// An opponent touching the ball between the pass and the goal kills the
// assist: the ball changed hands, so nobody set the goal up.
{
  const before = sent.length;
  room.onPlayerBallKick(players[1]); // teammate has it
  room.onPlayerBallKick(players[2]); // opponent takes it off them
  room.onPlayerBallKick(players[0]); // and gives it straight back
  room.onTeamGoal(1);
  const lines = sent.slice(before).map((x) => String(x.msg));
  assert(lines.some((m) => m.includes('⚽ p1')), 'still a goal for p1');
  assert(!lines.some((m) => m.includes('asistencia')), 'but no assist after the turnover');
}

room.onPlayerChat(p1, '!monedas');
{
  const balance = Number((String(lastMsg()).match(/(\d+) zicoins/) || [])[1]);
  assert(balance > 0, `scorer earned coins (got "${lastMsg()}")`);
}

room.onPlayerChat(p1, '!rango');
assert(lastMsg().includes('Rango:'), 'rank command works');

// brace and hat-trick
room.onPlayerBallKick(players[0]);
room.onTeamGoal(1);
assert(anySaid('lleva 2 goles'), 'brace announced');
room.onPlayerBallKick(players[0]);
room.onTeamGoal(1);
assert(anySaid('HAT-TRICK'), 'hat-trick announced');

// --- own goal ---------------------------------------------------------
room.onPlayerBallKick(players[2]);
room.onTeamGoal(1);
assert(anySaid('Autogol de p3'), 'own goal credited');

// --- store & celebrations ---------------------------------------------
room.onPlayerChat(p1, '!tienda');
assert(anySaid('TIENDA'), 'store renders');

room.onPlayerChat(p1, '!comprar fuego');
assert(lastMsg().includes('suficientes') || lastMsg().includes('Compraste'), 'buy path responds');

// give enough coins then buy for real
room.onPlayerChat(p1, '!regalar #1 500');
room.onPlayerChat(p1, '!comprar fuego');
assert(anySaid('Compraste'), 'purchase succeeds once affordable');

room.onPlayerChat(p1, '!celebracion fuego');
assert(anySaid('Celebración cambiada'), 'celebration selectable');

avatars.clear();
room.onPlayerBallKick(players[0]);
room.onTeamGoal(1);
assert.strictEqual(avatars.get(1), '🔥', 'celebration avatar applied on goal');

// --- transfers --------------------------------------------------------
room.onPlayerChat(p1, '!dar #2 50');
assert(anySaid('Enviaste 50 zicoins a p2'), 'transfer works');
room.onPlayerChat(p1, '!dar #1 10');
assert(lastMsg().includes('a ti mismo'), 'self-transfer blocked');
room.onPlayerChat(p1, '!dar #2 999999');
assert(lastMsg().includes('suficientes'), 'overdraft blocked');

// --- betting ----------------------------------------------------------
// Players in the match cannot bet on it. Two friends alone in a 1v1 could
// otherwise both stake everything, agree the result, and double their money
// every thirty seconds against a bank that pays a flat 2x.
room.onPlayerChat(p2, '!apostar 20 rojo');
assert(lastMsg().includes('tu propio partido'), 'a player in the match cannot bet');

const punter = players[6]; // a spectator
room.onPlayerChat(punter, '!regalar #7 200'); // p7 is not an admin
assert(lastMsg().includes('admins'), 'and !regalar is admin-only');
room.onPlayerChat(p1, '!regalar #7 200');

room.onPlayerChat(punter, '!apostar 20 rojo');
assert(anySaid('Apostaste 20 zicoins al Rojo'), 'a spectator can bet');
room.onPlayerChat(punter, '!apostar 20 azul');
assert(lastMsg().includes('Ya tienes una apuesta'), 'one bet per match');
room.onPlayerChat(players[7], '!apostar 99999 rojo'); // a different spectator
assert(lastMsg().includes('máxima'), 'and there is a ceiling on the stake');

// --- victory: coins, xp, clean sheet, mvp, rotation --------------------
room.onTeamVictory({ red: 3, blue: 0 });
assert(anySaid('MVP'), 'MVP announced');
assert(anySaid('portería en cero'), 'clean sheet announced');
assert(anySaid('Ganaste tu apuesta'), 'winning bet paid out');
// Team rotation is asynchronous now (the bot waits before rebuilding the
// match). It has its own test file: test/rotation.js

room.onPlayerChat(p1, '!me');
assert(anySaid('1V/0D'), 'win recorded');
assert(anySaid('vallas invictas'), 'clean sheet recorded');


// --- room protection ---------------------------------------------------
{
  const stranger = players[3]; // p4, never claimed admin

  // A stranger arriving with admin gets it stripped.
  const sneaky = { id: 50, name: 'sneaky', team: 0, admin: true, auth: 'auth50', conn: 'c50' };
  players.push(sneaky);
  room.onPlayerJoin(sneaky);
  assert.strictEqual(sneaky.admin, false, 'admin stripped from a stranger on join');
  room.onPlayerLeave(sneaky);
  players = players.filter((p) => p.id !== 50);

  // A non-staff player handing out admin loses their own.
  stranger.admin = true;
  const victim = players[4];
  victim.admin = true;
  room.onPlayerAdminChange(victim, stranger);
  assert.strictEqual(victim.admin, false, 'unauthorised promotion reverted');
  assert.strictEqual(stranger.admin, false, "promoter's admin revoked");

  // Admin attributed to the room itself is NOT a free pass. Haxball hands
  // admin to a player automatically when the room has no admin left, and that
  // arrives looking exactly like a host action. Letting it stand was a
  // complete takeover: every admin command gates on the engine's admin flag.
  victim.admin = true;
  room.onPlayerAdminChange(victim, null);
  assert.strictEqual(victim.admin, false, 'a stranger promoted by the room loses it too');

  // Staff keep theirs, however it was granted.
  const staffer = players[5];
  room.onPlayerChat(staffer, '!claim ' + config.adminPassword);
  staffer.admin = true;
  room.onPlayerAdminChange(staffer, null);
  assert.strictEqual(staffer.admin, true, 'staff are left alone');

  // Stadium change by a player is reverted. The revert is deliberately
  // deferred: stopGame() is queued, and swapping the stadium in the same tick
  // throws, which is why the old version never actually reverted anything.
  // The assertion therefore lives in the deferred block at the end of the file.
  stadiumSetsBeforeHijack = stadiumSets.length;
  room.onStadiumChange('FFL 7x7 Oficial v2', stranger);
  assert(anySaid('El mapa no se puede cambiar'), 'stadium change refused');

  // Host stadium change is left alone.
  const before2 = stadiumSets.length;
  room.onStadiumChange('whatever', null);
  assert.strictEqual(stadiumSets.length, before2, 'host stadium change not reverted');

  // Unlocking teams is reverted.
  teamsLocked = false;
  room.onTeamsLockChange(false, stranger);
  assert.strictEqual(teamsLocked, true, 'teams re-locked after a player unlocked them');

  // Kick rate tampering is reverted.
  const beforeRate = kickRate.length;
  room.onKickRateLimitSet(1, 1, 1, stranger);
  assert(kickRate.length > beforeRate, 'kick rate limit restored');

  // Settings are re-applied when a game stops, since limits have no event.
  teamsLocked = false;
  room.onGameStop();
  assert.strictEqual(teamsLocked, true, 'teams lock re-asserted on game stop');
}

// --- auth command ------------------------------------------------------
room.onPlayerChat(p1, '!auth');
assert(anySaid('Tu auth: auth1'), '!auth reports the hash for the staff list');

// --- rank thresholds --------------------------------------------------
assert.strictEqual(ranks.rankFor(0).name, 'Novato', 'lowest rank');
assert.strictEqual(ranks.rankFor(999999).name, 'Leyenda', 'highest rank');
assert(ranks.nextRank(0).xp > 0, 'next rank has a threshold');
assert.strictEqual(ranks.nextRank(999999), null, 'no next rank at the top');

// --- leaderboards -----------------------------------------------------
room.onPlayerChat(p1, '!goles');
assert(lastMsg().includes('1. p1'), 'leaderboard renders');
room.onPlayerChat(p1, '!ricos');
assert(anySaid('Top monedas'), 'coin leaderboard renders');

// --- moderation -------------------------------------------------------
room.onPlayerChat(p1, '!mutear #3');
assert(anySaid('p3 fue muteado'), 'mute works');

// Chat is always relayed by hand now, so it always returns false. What tells
// mute from not-mute is whether the line actually reached the room.
{
  const before = sent.length;
  assert.strictEqual(room.onPlayerChat(players[2], 'callado'), false, 'never echoed by Haxball');
  assert(
    !sent.slice(before).some((x) => String(x.msg).includes('p3: callado')),
    'a muted player is not relayed'
  );
}

room.onPlayerChat(p1, '!desmutear #3');
{
  const before = sent.length;
  room.onPlayerChat(players[2], 'ya puedo hablar');
  assert(
    sent.slice(before).some((x) => String(x.msg).includes('p3: ya puedo hablar')),
    'unmuted chat is relayed again'
  );
}

// --- chat carries the speaker's rank ----------------------------------
// Rank only ever showed up in !me, which made the whole progression system
// invisible. Every line now shows it, painted in that rank's colour.
{
  const ranks = require('../src/modules/ranks');
  const before = sent.length;
  room.onPlayerChat(players[6], 'vamos equipo');
  const line = sent.slice(before).find((x) => String(x.msg).includes('vamos equipo'));

  assert(line, 'the message was relayed');
  assert(String(line.msg).startsWith('['), 'it is prefixed with the rank');
  assert(String(line.msg).includes('p7: vamos equipo'), 'name and text follow');
  assert(
    ranks.RANKS.some((r) => r.color === line.color),
    `painted in a rank colour (got ${line.color})`
  );
}

// --- ignore list ------------------------------------------------------
room.onPlayerChat(p1, '!bloquear #4');
assert(anySaid('Bloqueaste a p4'), 'ignore registered');
const before = sent.length;
room.onPlayerChat(players[3], 'spam');
const relayed = sent.slice(before).filter((s) => String(s.msg).includes('spam'));
assert(relayed.length === 7, `relayed to everyone except the ignorer (got ${relayed.length})`);
assert(!relayed.some((s) => s.target === 1), 'ignorer did not receive the message');

// --- spawn geometry ---------------------------------------------------
// These maps ship with spawnDistance 366.5, which is a sensible halfway spot
// on the big pitch and 90% of the way to your own net on the small one. The
// loader overrides it so both pitches start players in the same relative
// place, and so does the mid-match placement, so a late arrival lines up with
// everyone who kicked off.
{
  const modes = require('../src/modules/modes');
  for (const file of ['futsal1v1.hbs', 'futsal4v4.hbs', 'training.hbs']) {
    const geo = modes.mapGeometry(file);
    const stadium = JSON.parse(modes.loadMap(file));
    const want = Math.round(geo.goalX * 0.45);

    assert.strictEqual(stadium.spawnDistance, want, `${file}: spawn distance rewritten`);
    assert(stadium.spawnDistance < geo.goalX - 50, `${file}: spawn is not on the goal line`);

    const red = modes.spawnPoint(file, -1, 0);
    const blue = modes.spawnPoint(file, 1, 0);
    assert.strictEqual(red.x, -want, `${file}: red arrives where red kicks off`);
    assert.strictEqual(blue.x, want, `${file}: blue arrives where blue kicks off`);
  }
}

// --- persistence ------------------------------------------------------
// (stadiumSetsBeforeHijack is checked in the deferred block below)
// Team building is covered properly in test/rotation.js, which drives the
// room through its real API instead of poking the fake's state directly.
setTimeout(() => {
  assert(
    stadiumSets.length > stadiumSetsBeforeHijack,
    'our map was re-applied after a player changed it'
  );

  const fs = require('fs');
  const disk = JSON.parse(fs.readFileSync('data/test-stats.json', 'utf8'));
  assert(disk.auth1 && disk.auth1.goals >= 4, 'stats persisted to disk');
  assert(Array.isArray(disk.auth1.owned) && disk.auth1.owned.includes('fuego'), 'purchases persisted');
  assert(disk.auth1.xp > 0, 'xp persisted');

  fs.rmSync('data/test-stats.json', { force: true });
  console.log('\nAll smoke tests passed.\n');
  process.exit(0);
}, 2600);

