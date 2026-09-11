const { TEAM } = require('../modules/teams');
const { t } = require('../i18n');
const ranks = require('../modules/ranks');
const modes = require('../modules/modes');
const kitsLib = require('../modules/kits');

/**
 * How a player is remembered once they have left: their Haxball auth if they
 * have one, otherwise their connection (IP). Never the session id, which is
 * reused by a different person after every restart.
 */
const identityOf = (rec) => (rec.auth ? `auth:${rec.auth}` : `conn:${rec.conn}`);

/**
 * Command table. Each entry:
 *   desc   - one line shown by !ayuda
 *   admin  - true if it requires room admin
 *   alias  - other names that trigger it
 *   run    - (ctx, player, args) => void
 *
 * ctx = { room, chat, registry, stats, teams, afk, economy, config, bans }
 */
// Null-prototype, because a plain object literal inherits Object.prototype:
// `!constructor` and `!__proto__` used to resolve to real functions, sail past
// both the unknown-command reply and the admin check, and only fail inside
// cmd.run — a free way to fill the logs with stack traces.
const commands = Object.create(null);
const aliases = Object.create(null);

function define(name, desc, opts, run) {
  commands[name] = { name, desc, admin: !!opts.admin, run };
  for (const a of opts.alias || []) aliases[a] = name;
}

function resolve(name) {
  const key = String(name).toLowerCase();
  const cmd = commands[key] || commands[aliases[key]] || null;
  return cmd && typeof cmd.run === 'function' ? cmd : null;
}

/**
 * Resolve a player argument and explain the failure.
 *
 * Nicknames are not unique in Haxball, and picking the first match meant a
 * troll could copy a regular's name and have the regular kicked in their
 * place. Ambiguous now refuses and shows the ids.
 */
function target(ctx, player, token) {
  const { player: found, reason, candidates } = ctx.registry.lookup(token);
  if (found) return found;
  if (reason === 'ambiguous') {
    ctx.chat.error(t.ambiguousName, player.id);
    ctx.chat.dim(candidates.map((c) => `#${c.id} ${c.name}`).join('   '), player.id);
  } else {
    ctx.chat.error(t.notFound, player.id);
  }
  return null;
}

// ---------------------------------------------------------------- general

define('ayuda', 'Muestra los comandos', { alias: ['help', 'comandos'] }, (ctx, player) => {
  const lines = Object.values(commands)
    .filter((c) => !c.admin || player.admin)
    .map((c) => `!${c.name} — ${c.desc}`);
  ctx.chat.info(t.helpTitle, player.id);
  for (let i = 0; i < lines.length; i += 8) {
    ctx.chat.dim(lines.slice(i, i + 8).join('\n'), player.id);
  }
});

define('me', 'Tus estadísticas', { alias: ['yo', 'stats'] }, (ctx, player) => {
  const s = ctx.stats.get(ctx.registry.key(player.id));
  ctx.chat.info(t.myStats(player.name, s), player.id);
  ctx.chat.dim(`${ranks.label(s.xp)} · ${s.coins} ${ctx.economy.coin}`, player.id);
});

define('mostrarstats', 'Muestra tus stats a todos', { alias: ['show'] }, (ctx, player) => {
  const s = ctx.stats.get(ctx.registry.key(player.id));
  ctx.chat.hype(`${ranks.label(s.xp)} ${t.showStats(player.name, s)}`);
});

define('dc', 'Invitación al Discord', { alias: ['discord'] }, (ctx, player) => {
  ctx.chat.info(ctx.config.discordLink, player.id);
});

define('bb', 'Salir de la sala', { alias: ['salir'] }, (ctx, player) => {
  ctx.room.kickPlayer(player.id, t.bye, false);
});

define('afk', 'Marcarte como AFK', {}, (ctx, player) => {
  ctx.afk.toggle(player.id);
});

define('modo', 'Modo actual (1v1/2v2/3v3/4v4)', { alias: ['mode'] }, (ctx, player) => {
  ctx.chat.info(t.modeInfo(ctx.teams.mode.name, ctx.teams.queueList.length), player.id);
});

define('fila', 'Quién está esperando turno', { alias: ['queue', 'cola'] }, (ctx, player) => {
  const names = ctx.teams.queueList
    .map((id) => ctx.registry.get(id))
    .filter(Boolean)
    .map((r, i) => `${i + 1}. ${r.name}`);
  ctx.chat.dim(names.length ? t.queueList(names.join('  ')) : t.queueEmpty, player.id);
});

define('kit', 'Cambiar el kit de tu equipo: !kit <nombre>', { alias: ['camiseta', 'uniforme'] }, (ctx, player, args) => {
  const wanted = args[0];

  if (!wanted) {
    ctx.chat.info(t.kitList(kitsLib.list().join(', ')), player.id);
    return;
  }

  const p = ctx.room.getPlayer(player.id);
  if (!p || p.team === TEAM.SPEC) return ctx.chat.error(t.kitNotPlaying, player.id);

  // Captains decide the kit; admins can always override.
  const captainId = ctx.teams.captainOf(p.team);
  if (captainId !== player.id && !player.admin) {
    ctx.chat.error(t.kitNotCaptain, player.id);
    const cap = ctx.registry.get(captainId);
    if (cap) ctx.chat.dim(t.kitCaptainIs(cap.name), player.id);
    return;
  }

  const kit = ctx.kits.set(p.team, wanted);
  if (!kit) return ctx.chat.error(t.kitUnknown, player.id);
  ctx.chat.ok(t.kitSet(p.team === TEAM.RED ? t.red : t.blue, kit.name));
});

// The owner's problem: as admin they are always in the room, so they end up
// taking a seat a regular could have had. This hands their place over
// automatically instead of them having to sit out by hand every time.
define('ceder', 'Ceder tu lugar a los demás: !ceder', { alias: ['yield', 'prioridad'] }, (ctx, player) => {
  const rec = ctx.registry.get(player.id);
  if (!rec) return;
  rec.yielding = !rec.yielding;
  ctx.chat.ok(rec.yielding ? t.yieldOn : t.yieldOff, player.id);

  // If somebody is already waiting, give up the seat now rather than at the
  // next reshuffle.
  if (rec.yielding) {
    const next = ctx.teams.queueList[0];
    if (next !== undefined) ctx.teams.tryYieldSeat(next);
  }
});

define('afks', 'Lista de ausentes', {}, (ctx, player) => {
  const list = ctx.afk.list();
  ctx.chat.dim(list.length ? t.afkList(list.map((r) => r.name).join(', ')) : t.afkNone, player.id);
});

// ---------------------------------------------------------------- progresión

define('rango', 'Tu rango y XP', { alias: ['rank'] }, (ctx, player, args) => {
  const target = args[0] ? ctx.registry.find(args[0]) : ctx.registry.get(player.id);
  if (!target) return ctx.chat.error(t.notFound, player.id);
  const s = ctx.stats.get(ctx.registry.key(target.id));
  ctx.chat.info(
    t.rankInfo(target.name, ranks.label(s.xp), s.xp, ranks.nextRank(s.xp)),
    player.id
  );
});

define('rangos', 'Lista de todos los rangos', {}, (ctx, player) => {
  ctx.chat.dim(ranks.RANKS.map((r) => `${r.tag} ${r.name} — ${r.xp} XP`).join('\n'), player.id);
});

// ---------------------------------------------------------------- economía

define('monedas', 'Tu saldo', { alias: ['coins', 'saldo', 'infocoins'] }, (ctx, player) => {
  ctx.chat.info(t.balance(ctx.economy.coin, ctx.economy.balance(player.id)), player.id);
});

define('tienda', 'Ver la tienda', { alias: ['store'] }, (ctx, player) => {
  ctx.economy.showStore(player.id);
});

define('comprar', 'Comprar algo: !comprar <id>', { alias: ['buy'] }, (ctx, player, args) => {
  ctx.economy.buy(player.id, args[0]);
});

define('celebracion', 'Elegir celebración: !celebracion <id>', { alias: ['celebration'] }, (ctx, player, args) => {
  ctx.economy.celebration(player.id, args[0]);
});

define('dar', 'Enviar monedas: !dar #id <cantidad>', { alias: ['give', 'transferir'] }, (ctx, player, args) => {
  ctx.economy.transfer(player.id, args[0], args[1]);
});

define('apostar', 'Apostar: !apostar <cantidad> <rojo|azul>', { alias: ['bet'] }, (ctx, player, args) => {
  ctx.economy.placeBet(player.id, args[0], args[1]);
});

// ---------------------------------------------------------------- rankings

const leaderboard = (field, label) => (ctx, player) => {
  const top = ctx.stats.top(field, 10);
  if (!top.length) return ctx.chat.dim(t.noData, player.id);
  const body = top.map((r, i) => `${i + 1}. ${r.name || '???'} — ${r[field]}`).join('\n');
  ctx.chat.info(`${t.topTitle(label)}\n${body}`, player.id);
};

define('goles', 'Top goleadores', { alias: ['goals'] }, leaderboard('goals', 'goleadores'));
define('asistencias', 'Top asistencias', { alias: ['assists'] }, leaderboard('assists', 'asistencias'));
define('victorias', 'Más victorias', { alias: ['wins'] }, leaderboard('wins', 'victorias'));
define('partidos', 'Más partidos jugados', { alias: ['games'] }, leaderboard('games', 'partidos'));
define('vallas', 'Más vallas invictas', { alias: ['cs'] }, leaderboard('cleanSheets', 'vallas invictas'));
define('ricos', 'Top monedas', { alias: ['rich'] }, leaderboard('coins', 'monedas'));
define('top', 'Top XP', { alias: ['xp'] }, leaderboard('xp', 'XP'));

define('reiniciarstats', 'Borra tus estadísticas', { alias: ['resetstats'] }, (ctx, player) => {
  ctx.stats.reset(ctx.registry.key(player.id));
  ctx.chat.ok(t.statsReset, player.id);
});

// ---------------------------------------------------------------- ignorar

define('bloquear', 'Ocultar a alguien: !bloquear #id', { alias: ['ignore'] }, (ctx, player, args) => {
  const who = target(ctx, player, args[0]);
  if (!who) return;
  // Blocking yourself flipped chat onto the per-listener path for every line
  // you sent, turning one announcement into thirty. Cheap way to lag a room.
  if (who.id === player.id) return ctx.chat.error(t.ignoreSelf, player.id);
  const rec = ctx.registry.get(player.id);
  rec.ignoring = rec.ignoring || new Set();
  if (rec.ignoring.size >= 50) return ctx.chat.error(t.ignoreTooMany, player.id);
  rec.ignoring.add(who.id);
  ctx.chat.ok(`Bloqueaste a ${who.name}.`, player.id);
});

define('desbloquear', 'Dejar de ocultar: !desbloquear #id', { alias: ['unignore'] }, (ctx, player, args) => {
  const who = target(ctx, player, args[0]);
  const rec = ctx.registry.get(player.id);
  if (!who || !rec.ignoring) return;
  rec.ignoring.delete(who.id);
  ctx.chat.ok(`Desbloqueaste a ${who.name}.`, player.id);
});

define('bloqueados', 'Tu lista de bloqueados', { alias: ['ignored'] }, (ctx, player) => {
  const rec = ctx.registry.get(player.id);
  const names = [...(rec.ignoring || [])]
    .map((id) => ctx.registry.get(id))
    .filter(Boolean)
    .map((r) => r.name);
  ctx.chat.dim(names.length ? `Bloqueados: ${names.join(', ')}` : 'No has bloqueado a nadie.', player.id);
});

// ---------------------------------------------------------------- admin

define('claim', 'Ser admin: !claim <contraseña>', {}, (ctx, player, args) => {
  if (args.join(' ') !== ctx.config.adminPassword) {
    return ctx.chat.error(t.adminBadPass, player.id);
  }
  ctx.guard.grant(player.id);
  ctx.chat.hype(t.adminOk(player.name));
});

define('auth', 'Ver tu auth (para la lista de staff)', {}, (ctx, player) => {
  const rec = ctx.registry.get(player.id);
  ctx.chat.dim(rec && rec.auth ? t.yourAuth(rec.auth) : t.authUnknown, player.id);
});

// Mutes used to live on the session record, which is thrown away the moment
// the player leaves — so the sanction lasted exactly as long as it took them
// to press Escape and click the link again, and !muteados then reported
// nobody muted. They are persisted by identity now, like bans.
define('mutear', 'Mutear: !mutear #id', { admin: true, alias: ['mute'] }, (ctx, player, args) => {
  const who = target(ctx, player, args[0]);
  if (!who) return;
  who.muted = true;
  ctx.mutes.set(identityOf(who), { name: who.name, conn: who.conn, auth: who.auth, at: Date.now() });
  ctx.mutes.flush();
  ctx.chat.info(t.muted(who.name));
});

define('desmutear', 'Desmutear: !desmutear #id', { admin: true, alias: ['unmute'] }, (ctx, player, args) => {
  const who = target(ctx, player, args[0]);
  if (!who) return;
  who.muted = false;
  delete ctx.mutes.all()[identityOf(who)];
  ctx.mutes.flush();
  ctx.chat.info(t.unmuted(who.name));
});

define('muteados', 'Lista de muteados', { admin: true, alias: ['mutes'] }, (ctx, player) => {
  const stored = Object.values(ctx.mutes.all()).map((m) => m.name);
  ctx.chat.dim(stored.length ? t.mutesList(stored.join(', ')) : t.mutesNone, player.id);
});

define('kick', 'Expulsar: !kick #id [razón]', { admin: true, alias: ['expulsar'] }, (ctx, player, args) => {
  const who = target(ctx, player, args[0]);
  if (!who) return;
  ctx.room.kickPlayer(who.id, args.slice(1).join(' ') || 'Kick', false);
});

// Bans were keyed on the session player id, which restarts from 1 every time
// the room restarts — and it restarts often, because tokens expire. So today's
// ban of "#3" silently overwrote the record of whoever was "#3" last week,
// deleting their auth and conn from the file and letting them walk back in.
// Keyed on identity now, and flushed immediately rather than 2 seconds later.
define('ban', 'Banear: !ban #id [razón]', { admin: true, alias: ['banear'] }, (ctx, player, args) => {
  const who = target(ctx, player, args[0]);
  if (!who) return;
  ctx.bans.set(identityOf(who), {
    name: who.name,
    conn: who.conn,
    auth: who.auth,
    at: Date.now(),
  });
  ctx.bans.flush();
  ctx.room.kickPlayer(who.id, args.slice(1).join(' ') || 'Ban', true);
});

define('bans', 'Lista de baneados', { admin: true, alias: ['baneados'] }, (ctx, player) => {
  const entries = Object.entries(ctx.bans.all());
  if (!entries.length) return ctx.chat.dim(t.bansNone, player.id);
  // Numbered, because the keys are auth hashes now and nobody wants to type
  // one. !unban takes the number, the name, or the key.
  ctx.chat.dim(
    entries.map(([key, b], i) => `${i + 1}. ${b.name || '???'}`).join('\n'),
    player.id
  );
});

define('unban', 'Quitar baneo: !unban <id|nombre>', { admin: true, alias: ['desbanear'] }, (ctx, player, args) => {
  const token = String(args[0] || '').trim();
  if (!token) return ctx.chat.error('Uso: !unban <id|nombre>', player.id);

  const entries = Object.entries(ctx.bans.all());
  const wanted = token.toLowerCase().replace(/^#/, '');
  const hit = entries.find(
    ([key, b], i) =>
      String(i + 1) === wanted ||
      key.toLowerCase() === token.toLowerCase() ||
      String(b.name || '').toLowerCase() === wanted
  );
  if (!hit) return ctx.chat.error(t.notFound, player.id);

  delete ctx.bans.all()[hit[0]];
  ctx.bans.flush();
  ctx.room.clearBans(); // ids are meaningless after a restart; clear and re-apply
  ctx.chat.ok(t.banLifted(hit[1].name || hit[0]), player.id);
});

define('rr', 'Mezclar equipos', { admin: true, alias: ['mezclar'] }, (ctx) => {
  ctx.teams.shuffle();
});

// !parar used to be useless: reconcile noticed no game was running and started
// one again within four seconds, so an admin could never hold the room still
// to sort anything out. Stopping now also hands the room over; !empezar hands
// it back.
define('empezar', 'Empezar el partido y devolver la sala al bot', { admin: true, alias: ['start'] }, (ctx) => {
  ctx.teams.setRotation(true);
  ctx.chat.info(t.rotationOn);
});

define('parar', 'Parar el partido y tomar el control', { admin: true, alias: ['stop'] }, (ctx) => {
  ctx.teams.setRotation(false);
  ctx.room.stopGame();
  ctx.chat.info(t.rotationOff);
});

define('auto', 'Rotación automática: !auto on|off', { admin: true }, (ctx, player, args) => {
  const arg = String(args[0] || '').toLowerCase();
  if (arg === 'off' || arg === '0' || arg === 'no') {
    ctx.teams.setRotation(false);
    return ctx.chat.info(t.rotationOff);
  }
  if (arg === 'on' || arg === '1' || arg === 'si' || arg === 'sí') {
    ctx.teams.setRotation(true);
    return ctx.chat.info(t.rotationOn);
  }
  ctx.chat.info(ctx.teams.rotationOn ? t.rotationOn : t.rotationOff, player.id);
});

// Captains stop the clock to make a substitution. Admins can too, from either
// side. One per team per match, and it closes itself so nobody can stall.
define('pausa', 'Parar el reloj para hacer un cambio', { alias: ['pause', 'tiempo'] }, (ctx, player) => {
  ctx.teams.startPause(player);
});

define(
  'banquear',
  'Durante la pausa: !banquear #id para sacar a alguien de tu equipo',
  { alias: ['banquar', 'cambio', 'bench'] },
  (ctx, player, args) => {
    const who = target(ctx, player, args[0]);
    if (!who) return;
    ctx.teams.benchPlayer(player, who.id);
  }
);

define('banca', 'Mandar a espectadores: !banca #id', { admin: true, alias: ['spec'] }, (ctx, player, args) => {
  const who = target(ctx, player, args[0]);
  if (!who) return;
  ctx.room.setPlayerTeam(who.id, TEAM.SPEC);
});

// Knowing which build a room is actually running has cost more debugging time
// than any bug in it. Now you can just ask.
define('version', 'Versión del bot', { alias: ['ver', 'build'] }, (ctx, player) => {
  ctx.chat.dim(`Bot v${require('../../package.json').version}`, player.id);
});

define('estado', 'Diagnóstico de equipos y fila', { admin: true, alias: ['state', 'debug'] }, (ctx, player) => {
  const st = ctx.teams.debugState();
  ctx.chat.dim(`bot v${require('../../package.json').version}`, player.id);
  ctx.chat.dim(
    `modo=${st.mode} map=${st.map} forzado=${st.forced} partido=${st.gameRunning} disponibles=${st.availableCount}`,
    player.id
  );
  ctx.chat.dim(
    'fila: ' + (st.queue.map((q) => `${q.name}${q.available ? '' : '(no disp)'}`).join(', ') || 'vacía'),
    player.id
  );
  for (const p of st.players) {
    ctx.chat.dim(
      `#${p.id} ${p.name} — ${p.team}${p.afk ? ' AFK' : ''}${p.inQueue ? ' [en fila]' : ''}${p.known ? '' : ' [SIN REGISTRO]'}`,
      player.id
    );
  }
});

define('fijarmodo', 'Fijar el modo: !fijarmodo <1v1|2v2|3v3|4v4|auto>', { admin: true, alias: ['setmode'] }, (ctx, player, args) => {
  const arg = String(args[0] || '').toLowerCase();
  if (arg === 'auto') {
    ctx.teams.force(null);
    return ctx.chat.info(t.modeAuto);
  }
  const mode = modes.byName(arg) || modes.bySize(arg.replace(/\D/g, '')[0]);
  if (!mode) return ctx.chat.error(t.modeBad, player.id);
  ctx.teams.force(mode);
  ctx.chat.info(t.modeForced(mode.name));
});

define('regalar', 'Dar monedas: !regalar #id <cantidad>', { admin: true }, (ctx, player, args) => {
  const who = target(ctx, player, args[0]);
  const amount = Math.floor(Number(args[1]));
  if (!who) return;
  if (!Number.isFinite(amount) || amount <= 0) {
    return ctx.chat.error('Uso: !regalar #id <cantidad>', player.id);
  }
  ctx.economy.give(who.id, amount, 'regalo del admin');
  ctx.chat.ok(`Le diste ${amount} ${ctx.economy.coin} a ${who.name}.`, player.id);
});

module.exports = { commands, resolve };
