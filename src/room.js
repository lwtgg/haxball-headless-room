const { makeChat, C } = require('./util/chat');
const { createRegistry } = require('./modules/players');
const { createStats } = require('./modules/stats');
const { createTeams, TEAM } = require('./modules/teams');
const { createAfk } = require('./modules/afk');
const { createEconomy } = require('./modules/economy');
const { createGuard } = require('./modules/guard');
const { createAntiSpam } = require('./modules/antispam');
const { createKits } = require('./modules/kits');
const { createCelebration } = require('./modules/celebrate');
const { creditGoal } = require('./modules/goalcredit');
const { resolve: resolveCommand } = require('./commands');
const { t } = require('./i18n');
const ranks = require('./modules/ranks');
const Store = require('./util/store');
const { notHost, isHost, isHostAction } = require('./util/host');

function startRoom(HBInit, config) {
  const roomConfig = {
    roomName: config.roomName,
    maxPlayers: config.maxPlayers,
    public: config.public,
    noPlayer: config.noPlayer,
    token: config.token,
  };
  // With noPlayer: false Haxball creates a host player at id 0 that sits in
  // the spectator list. Purely cosmetic — it holds admin and nothing else.
  if (!config.noPlayer) roomConfig.playerName = config.botName;
  // Only send geo if one was configured. Sending a wrong one buries the room
  // in everyone's list, including your own.
  if (config.geo && config.geo.code) roomConfig.geo = config.geo;

  // Haxball works out the room's location by calling its own geo API. If that
  // call fails (datacenter IPs often get a 403), it silently falls back to
  // country "" and lat/lon 0,0, which drops the room to the very bottom of
  // every player's distance-sorted list. Warn early, because the fix is just
  // setting GEO_CODE / GEO_LAT / GEO_LON in .env.
  if (!roomConfig.geo) {
    fetch('https://www.haxball.com/rs/api/geo')
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then((g) => console.log('Haxball geo lookup OK:', g))
      .catch((err) => {
        console.log('\n!! Haxball geo lookup FAILED (' + err.message + ').');
        console.log('!! This room will be listed with no country and coordinates 0,0,');
        console.log('!! which puts it at the bottom of everyone\'s room list.');
        console.log('!! Fix: set GEO_CODE / GEO_LAT / GEO_LON in .env and restart.\n');
      });
  }

  console.log('\nFutsal bot v' + require('../package.json').version);
  console.log('Starting room with:');
  console.log({ ...roomConfig, token: roomConfig.token ? '(set)' : '(MISSING)' });
  if (roomConfig.public !== true) {
    console.log('\n!! public is not true, so this room will NOT appear in the room list.\n');
  }

  const room = HBInit(roomConfig);

  const chat = makeChat(room);
  const registry = createRegistry();
  const stats = createStats(config);
  const bans = new Store('data/bans.json');
  const mutes = new Store('data/mutes.json');
  const guard = createGuard({
    room,
    chat,
    registry,
    config,
    getStadium: () => teams.currentStadium,
    // After a hijack the bot's cached map is a lie, so make it re-upload.
    onStadiumHijacked: () => teams.forceMapReload(),
  });
  const teams = createTeams({
    room,
    chat,
    registry,
    config,
    guard,
    // Nobody could move while the game was frozen, so nobody is really idle.
    onResume: () => afk.forgiveIdle(),
  });
  const afk = createAfk({ room, chat, registry, config, teams });
  const economy = createEconomy({ room, chat, registry, stats, config });
  const kits = createKits({ room });
  const antispam = createAntiSpam({ chat, registry, config, guard });
  const celebration = createCelebration({ room, config });

  const ctx = { room, chat, registry, stats, teams, afk, economy, guard, kits, config, bans, mutes, celebration };

  /** Same identity a ban or mute is filed under. */
  const identityOf = (rec) => (rec.auth ? `auth:${rec.auth}` : `conn:${rec.conn}`);

  /**
   * Wrap a Haxball callback so a bug in it cannot take the room down.
   *
   * The library does not guard its dispatch sites. Depending on whether the
   * action was applied inline or on the tick, a throw either disconnects a
   * random player with no explanation, or becomes an uncaught exception and
   * kills the process — and the process cannot come back without a human
   * fetching a fresh token from a captcha page. Every uncaught throw is one
   * manual intervention, which is exactly what this release is about.
   */
  const safe = (name, fn) => (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      console.error(`[handler:${name}]`, err);
      // onPlayerChat must return a boolean; swallowing the message is safer
      // than letting an error re-broadcast it.
      return false;
    }
  };

  // Consecutive wins by the team currently holding the pitch.
  let streak = { team: null, count: 0 };
  /** Did this match end with a result, or was it stopped? Bets depend on it. */
  let victoryHandled = false;
  /** Last time anything at all happened, for the liveness check. */
  let lastEventAt = Date.now();
  /** Who won the last match and what shirt they were wearing. */
  let lastWinners = null;

  // ---- rules -----------------------------------------------------------
  // The stadium is chosen by the mode system (see modules/modes.js), which
  // swaps it between matches as the number of players changes.
  guard.applySettings(); // score/time limits, teams lock, kick rate
  teams.setupNextMatch(null);

  // Safety net. Every "start a match" and "grow the match" path is also hooked
  // to an event, but events get missed and orders surprise you. This just looks
  // at the room every few seconds and fixes what it finds, so the worst case is
  // a short delay rather than a room that sits dead.
  setInterval(() => {
    try {
      teams.reconcile();
    } catch (err) {
      console.error('[teams] reconcile failed:', err);
    }
  }, config.reconcileMs);

  // ---- goal / assist tracking -----------------------------------------
  let touches = []; // most recent first: { id, team, at }

  function registerTouch(player) {
    if (touches[0] && touches[0].id === player.id) return;
    touches.unshift({ id: player.id, team: player.team, at: Date.now() });
    // Deep enough that a scorer who dribbles past several opponents still has
    // the pass that started it in view.
    touches = touches.slice(0, 8);
  }

  // ---- lifecycle -------------------------------------------------------
  // If the link never arrives, say so instead of hanging silently.
  const linkWatchdog = setTimeout(() => {
    console.error(
      '\nNo room link after 30 seconds. Usually one of:\n' +
        '  1. The token expired. They only last ~2 minutes — get a new one and restart.\n' +
        '  2. You already have 2 rooms open on this IP (Haxball\'s limit).\n' +
        '  3. Outbound UDP is blocked by a firewall or VPN.\n'
    );
    // Exit rather than sit here looking healthy. There is no room, nothing can
    // fix that without a fresh token, and a process that lingers shows up in
    // pm2 as "online" — so the failure is invisible until players complain.
    console.error('Exiting so pm2 marks this errored instead of online.\n');
    process.exit(1);
  }, 30000);

  /**
   * Ask Haxball's own room list whether this room is still published. If it is
   * not, the room is gone and only a restart with a fresh token brings it
   * back — so say so unmistakably and exit, which at least moves pm2's restart
   * counter and leaves a greppable line in the log.
   */
  async function checkStillListed() {
    if (!roomConfig.public) return;
    try {
      const res = await fetch('https://www.haxball.com/rs/api/list');
      if (!res.ok) return; // Haxball's API being grumpy is not our problem
      const text = await res.text();
      if (text.includes(roomConfig.roomName)) return;
      console.error('\n!! ROOM IS GONE FROM THE HAXBALL LIST.');
      console.error('!! It is empty, silent, and no longer published.');
      console.error('!! This needs a fresh token and a restart. Exiting.\n');
      process.exit(1);
    } catch (err) {
      console.log('[liveness] could not reach the room list:', err.message);
    }
  }

  room.onRoomLink = safe('onRoomLink', (link) => {
    clearTimeout(linkWatchdog);
    console.log('\n=== ROOM IS LIVE ===');
    console.log(link);
    console.log(
      roomConfig.public
        ? 'Listed as public. Search the room list for: ' + roomConfig.roomName
        : 'NOT public — link only.'
    );
    console.log('');

    // Heartbeat. Note what it does NOT prove: getPlayerList() reads a local
    // array and never touches the network, so it stays happy long after the
    // room has dropped off Haxball (the reported "connection closed (4001)"
    // after a couple of days). So when the room has been empty and completely
    // silent for a long stretch, go and ask Haxball whether it still exists.
    setInterval(() => {
      const n = room.getPlayerList().filter(notHost).length;
      const quietFor = Math.round((Date.now() - lastEventAt) / 60000);
      console.log(`[${new Date().toLocaleTimeString()}] alive — ${n} player(s)`);

      if (n === 0 && quietFor >= (config.livenessQuietMinutes || 20)) {
        lastEventAt = Date.now(); // only check once per quiet stretch
        checkStillListed();
      }
    }, 60000);
  });

  room.onPlayerJoin = safe('onPlayerJoin', (player) => {
    lastEventAt = Date.now();
    if (isHost(player)) return; // the bot is not a participant
    const rec = registry.add(player);

    const banned = Object.values(bans.all()).some(
      (b) => (player.auth && b.auth === player.auth) || (player.conn && b.conn === player.conn)
    );
    if (banned) {
      room.kickPlayer(player.id, t.banned, true);
      return;
    }

    chat.ok(t.welcome(player.name), player.id);
    chat.dim(t.welcomeDiscord(config.discordLink), player.id);

    guard.onJoin(player);

    const key = registry.key(player.id);
    stats.bump(key, { name: player.name });
    const s = stats.get(key);
    chat.dim(`${ranks.label(s.xp)} · ${s.coins} ${economy.coin}`, player.id);

    // Mutes are filed by identity, so leaving and coming back no longer clears
    // one. Without this the only sanction that survived a reconnect was a ban.
    if (mutes.get(identityOf(rec))) {
      rec.muted = true;
      chat.error(t.youAreMuted, player.id);
    }

    // Everything persistent hangs off the auth hash. No auth, no saving —
    // better than the old behaviour, which filed them under their IP and had
    // strangers behind one address sharing a wallet.
    if (!rec.auth) chat.dim(t.noAuthSave, player.id);

    teams.onPlayerJoin(player);
  });

  room.onPlayerLeave = safe('onPlayerLeave', (player) => {
    lastEventAt = Date.now();
    antispam.forget(player.id);
    celebration.restore(player.id);
    guard.onLeave(player);
    teams.onPlayerLeave(player);
    registry.remove(player.id);
  });

  room.onPlayerActivity = safe('onPlayerActivity', (player) => afk.markActivity(player.id));

  room.onPlayerBallKick = safe('onPlayerBallKick', (player) => registerTouch(player));

  /** Award XP and announce a rank-up if the player crossed a threshold. */
  function addXp(playerId, amount) {
    const key = registry.key(playerId);
    const rec = registry.get(playerId);
    if (!key || !rec) return;
    const before = stats.get(key).xp || 0;
    stats.bump(key, { xp: amount, name: rec.name });
    const after = before + amount;
    if (ranks.rankFor(before).name !== ranks.rankFor(after).name) {
      chat.hype(t.rankUp(rec.name, ranks.label(after)));
    }
  }

  room.onTeamGoal = safe('onTeamGoal', (team) => {
    lastEventAt = Date.now();
    // An opponent touch between the pass and the goal cancels the assist —
    // see modules/goalcredit.js for why that matters.
    const { scorerId, assistId, ownGoalId } = creditGoal(touches, team);

    // A goal credited to someone who has already left is not a goal anybody
    // can be paid for: the announcement never fires, and the assister used to
    // be quietly paid for a goal the room never mentioned.
    if (scorerId !== null && registry.get(scorerId)) {
      // The scorer's disc swells, the assister's grows by less. Do this first
      // so it lands while the goal is still on screen.
      celebration.goal(scorerId, assistId);

      const rec = registry.get(scorerId);
      if (rec) {
        rec.match.goals++;
        stats.bump(registry.key(scorerId), { goals: 1, name: rec.name });
        const arec = assistId !== null ? registry.get(assistId) : null;
        chat.hype(t.goal(rec.name, arec ? arec.name : null));

        economy.give(scorerId, economy.REWARDS.goal, t.reasonGoal);
        addXp(scorerId, ranks.XP.goal);
        economy.playCelebration(scorerId);

        if (rec.match.goals === 2) chat.hype(t.brace(rec.name));
        if (rec.match.goals === 3) chat.hype(t.hatTrick(rec.name));
      }
      if (assistId !== null) {
        const arec = registry.get(assistId);
        if (arec) {
          arec.match.assists++;
          stats.bump(registry.key(assistId), { assists: 1, name: arec.name });
          economy.give(assistId, economy.REWARDS.assist, t.reasonAssist);
          addXp(assistId, ranks.XP.assist);
        }
      }
    } else if (ownGoalId !== null) {
      const rec = registry.get(ownGoalId);
      if (rec) {
        rec.match.ownGoals++;
        stats.bump(registry.key(ownGoalId), { ownGoals: 1, name: rec.name });
        chat.info(t.ownGoal(rec.name));
      }
    }

    touches = [];
  });

  room.onGameStart = safe('onGameStart', () => {
    victoryHandled = false;
    // Fresh kits every match, except that the winners keep theirs. Whichever
    // side most of them ended up on gets their old shirt back, so a team on a
    // run stays recognisable even after a scramble puts them at the other end.
    let keepTeam = null;
    let keepKit = null;
    if (lastWinners && lastWinners.kit) {
      const here = room.getPlayerList().filter((p) => lastWinners.ids.includes(p.id));
      const onRed = here.filter((p) => p.team === TEAM.RED).length;
      const onBlue = here.filter((p) => p.team === TEAM.BLUE).length;
      if (onRed || onBlue) {
        keepTeam = onRed >= onBlue ? TEAM.RED : TEAM.BLUE;
        keepKit = lastWinners.kit;
      }
    }

    const dealt = kits.randomize({ keepTeam, keepKit });
    chat.dim(t.kitsRandom(dealt.red.name, dealt.blue.name));
    teams.onGameStart(); // each match gets a fresh pause allowance per team
    // Kickoff teleports everyone, and nobody has had a chance to move yet, so
    // start the idle clock from now rather than from whenever they last
    // touched a key in the previous match.
    afk.forgiveIdle();
    celebration.restoreAll(); // nobody starts a match still puffed up
    touches = [];
    registry.resetMatchStats();
    chat.info(t.matchOn(config.scoreLimit, config.timeLimit));
    chat.dim(t.modeInfo(teams.mode.name, teams.queueList.length));
    economy.openBets();
  });

  room.onGameStop = safe('onGameStop', () => {
    touches = [];
    celebration.restoreAll();
    // A match can end without a victory in half a dozen ways — an admin
    // stopping it, the pitch swapping for a bigger mode, a side emptying — and
    // every one of them used to pocket the stakes silently.
    if (!victoryHandled) economy.refundAll('el partido no terminó');
    // Score and time limits have no change event and no getter, so the only
    // way to be sure a player has not tampered with them is to set them again.
    guard.applySettings();
  });

  // ---- room protection -------------------------------------------------
  room.onPlayerAdminChange = safe('onPlayerAdminChange', (changed, byPlayer) =>
    guard.onAdminChange(changed, byPlayer)
  );
  room.onStadiumChange = safe('onStadiumChange', (name, byPlayer) =>
    guard.onStadiumChange(name, byPlayer)
  );
  room.onTeamsLockChange = safe('onTeamsLockChange', (locked, byPlayer) =>
    guard.onTeamsLockChange(locked, byPlayer)
  );
  room.onKickRateLimitSet = safe('onKickRateLimitSet', (min, rate, burst, byPlayer) =>
    guard.onKickRateLimitSet(min, rate, burst, byPlayer)
  );

  /**
   * Someone moved a player between teams without going through the bot — an
   * admin dragging somebody across, usually. Keep the queue honest, or the bot
   * hands out players who are already on the pitch: "substituting" someone who
   * never moved, or a captain picking a player off the opposing team.
   */
  room.onPlayerTeamChange = safe('onPlayerTeamChange', (changed) => {
    teams.onExternalTeamChange(changed);
  });

  /**
   * The client's own pause button. A paused game still reports as running, so
   * without these the AFK sweep kept counting against a pitch where nobody can
   * move: ten seconds after an admin paused, everyone was in spectators and the
   * match was gone.
   */
  room.onGamePause = safe('onGamePause', (byPlayer) => {
    if (!isHostAction(byPlayer)) teams.setEnginePaused(true);
  });
  room.onGameUnpause = safe('onGameUnpause', () => {
    teams.setEnginePaused(false);
  });

  room.onTeamVictory = safe('onTeamVictory', (scores) => {
    victoryHandled = true;
    // A level score used to elect Blue, handing them a win, a clean sheet, the
    // coins and the XP, while the very same event refunded the bets as a draw
    // and the chat announced "empate". One winner, computed once.
    const winner =
      scores.red > scores.blue ? TEAM.RED : scores.blue > scores.red ? TEAM.BLUE : null;
    if (winner === null) {
      lastWinners = null;
      economy.settleBets(scores);
      teams.onGameEnd(scores);
      return;
    }

    // Remember the winners and their shirt, before the bot rearranges anyone.
    lastWinners = {
      ids: room.getPlayerList().filter((p) => p.team === winner).map((p) => p.id),
      kit: kits.current(winner),
    };
    const loser = winner === TEAM.RED ? TEAM.BLUE : TEAM.RED;
    const conceded = winner === TEAM.RED ? scores.blue : scores.red;
    const winnerName = winner === TEAM.RED ? t.red : t.blue;

    let mvp = null;
    for (const p of room.getPlayerList().filter(notHost)) {
      if (p.team === TEAM.SPEC) continue;
      const key = registry.key(p.id);
      const rec = registry.get(p.id);
      const patch = { games: 1, name: rec ? rec.name : p.name };

      economy.give(p.id, economy.REWARDS.played, t.reasonPlayed);

      if (p.team === winner) {
        patch.wins = 1;
        economy.give(p.id, economy.REWARDS.win, t.reasonWin);
        addXp(p.id, ranks.XP.win);
        if (conceded === 0) {
          patch.cleanSheets = 1;
          economy.give(p.id, economy.REWARDS.cleanSheet, t.reasonCleanSheet);
          addXp(p.id, ranks.XP.cleanSheet);
        }
      } else {
        patch.losses = 1;
        addXp(p.id, ranks.XP.loss);
      }
      stats.bump(key, patch);

      // MVP: most goals, assists break the tie.
      if (rec) {
        const score = rec.match.goals * 2 + rec.match.assists;
        if (score > 0 && (!mvp || score > mvp.score)) mvp = { rec, score };
      }
    }

    if (conceded === 0) chat.ok(t.cleanSheet(winnerName));
    if (mvp) chat.hype(t.mvp(mvp.rec.name, mvp.rec.match.goals, mvp.rec.match.assists));

    streak = streak.team === winner ? { team: winner, count: streak.count + 1 } : { team: winner, count: 1 };
    if (streak.count >= 3) chat.hype(t.streak(winnerName, streak.count));

    economy.settleBets(scores);
    teams.onGameEnd(scores);
  });

  // ---- chat & commands -------------------------------------------------
  room.onPlayerChat = safe('onPlayerChat', (player, message) => {
    lastEventAt = Date.now();
    // Typing keeps the idle countdown alive, but it does NOT bring an AFK
    // player back — only !afk does. With a ten second timeout, a stray message
    // from someone who has walked away would otherwise put them straight back
    // on the pitch and stall the match again.
    afk.markActivity(player.id);

    const rec = registry.get(player.id);
    if (rec && rec.muted) {
      chat.error(t.youAreMuted, player.id);
      return false;
    }

    // Flood protection. Commands count too — !ayuda spam is still spam.
    if (antispam.shouldBlock(player, message)) return false;

    // Captains choose teammates by typing the number next to a name.
    if (teams.tryPick(player, message)) return false;

    if (message.startsWith('!')) {
      const [name, ...args] = message.slice(1).trim().split(/\s+/);
      const cmd = resolveCommand(name);
      if (!cmd) {
        chat.error(t.unknownCmd(name), player.id);
        return false;
      }
      // Gate on our own staff list, not the engine's admin flag. Haxball can
      // hand admin to a stranger on its own (it does so whenever the room has
      // no admin left), and a staff member can promote a friend from the admin
      // panel — either way `player.admin` becomes true for someone we never
      // trusted, and every destructive command reads that flag.
      if (cmd.admin && !guard.isStaff(player)) {
        chat.error(t.adminOnly, player.id);
        return false;
      }
      try {
        cmd.run(ctx, player, args);
      } catch (err) {
        console.error(`[cmd:${name}]`, err);
        chat.error(t.cmdError, player.id);
      }
      return false;
    }

    // Every line is relayed by hand rather than letting Haxball echo it, so
    // it can carry the speaker's rank and be painted in that rank's colour.
    // Rank is the whole point of the progression system; showing it only in
    // !me made it invisible.
    const xp = stats.get(registry.key(player.id)).xp || 0;
    const line = `[${ranks.label(xp)}] ${player.name}: ${message}`;
    const color = ranks.colorFor(xp);

    const ignorers = registry.all().filter((r) => r.ignoring && r.ignoring.has(player.id));

    // One announcement for the whole room unless somebody is ignoring them, in
    // which case it has to go out person by person.
    // Sound 1 is the normal chat blip. Relaying by hand meant passing 0 here,
    // which silently took the notification sound away from every message in
    // the room — you stop noticing people talking to you.
    if (ignorers.length === 0) {
      room.sendAnnouncement(line, null, color, 'normal', 1);
      return false;
    }

    for (const listener of registry.all()) {
      if (listener.ignoring && listener.ignoring.has(player.id)) continue;
      room.sendAnnouncement(line, listener.id, color, 'normal', 1);
    }
    return false;
  });

  afk.start();

  function shutdown(signal) {
    console.log(`\nGot ${signal}. Saving and exiting.`);
    stats.flush();
    bans.flush();
    mutes.flush();
    process.exit(0);
  }

  // SIGTERM was not handled at all, so `kill`, a container stop, or pm2's own
  // restart lost up to two seconds of debounced writes every time.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return room;
}

module.exports = { startRoom };
