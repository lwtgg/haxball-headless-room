const { t } = require('../i18n');
const { isHost, isHostAction } = require('../util/host');

/**
 * Room protection.
 *
 * With noPlayer: true the host is not a player, so in every callback
 * `byPlayer === null` means "the host did this" and anything else means a
 * human did it. That single fact is what all of this hangs on.
 *
 * Nobody gets admin except:
 *   - an auth hash listed in ADMIN_AUTHS
 *   - someone who types the correct !claim password
 *
 * Anyone else who somehow ends up with admin gets it taken away, and any
 * change they make to the room's setup is reverted.
 */
function createGuard({ room, chat, registry, config, getStadium, onStadiumHijacked }) {
  const authorised = new Set(
    String(config.adminAuths || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  // Player ids trusted for this session (via !claim or the auth list).
  const staff = new Set();

  const isStaff = (player) =>
    !!player && (isHost(player) || staff.has(player.id) || (player.auth && authorised.has(player.auth)));

  function grant(playerId) {
    staff.add(playerId);
    room.setPlayerAdmin(playerId, true);
  }

  function onJoin(player) {
    if (isHost(player)) return; // the bot keeps its own admin
    if (player.auth && authorised.has(player.auth)) {
      grant(player.id);
      chat.dim('Eres staff. Tienes admin.', player.id);
    } else if (player.admin) {
      // Should not happen, but never leave a stranger holding admin.
      room.setPlayerAdmin(player.id, false);
    }
  }

  function onLeave(player) {
    staff.delete(player.id);
  }

  /**
   * Someone's admin flag changed.
   *
   * The old version returned immediately whenever the change was attributed to
   * the room itself, which left the biggest hole in the whole bot: Haxball
   * hands admin to a player automatically when the room has no admin left, and
   * that arrives as a host action. A stranger promoted that way kept admin for
   * the rest of the session, and every admin command gates on the engine's
   * `player.admin` flag. That is a complete takeover: mass kicks, mass bans,
   * `!regalar` to themselves.
   *
   * So the rule is now about *who ended up with admin*, not who granted it.
   */
  function onAdminChange(changed, byPlayer) {
    // Nobody outside the staff list keeps admin, however they got it.
    if (changed && changed.admin && !isStaff(changed)) {
      room.setPlayerAdmin(changed.id, false);
      if (byPlayer && !isHostAction(byPlayer)) chat.error(t.guardNoPromote, byPlayer.id);
    }

    if (isHostAction(byPlayer)) return; // the bot itself, nothing further to do

    if (!isStaff(byPlayer)) {
      // A non-staff player is handing out admin. Take theirs as well.
      room.setPlayerAdmin(byPlayer.id, false);
      chat.error(t.guardNoPermission, byPlayer.id);
    }
  }

  /**
   * Belt and braces: nobody outside the staff list should be holding admin.
   * Runs whenever a game stops, which is often enough to close the gap if a
   * promotion event is ever missed.
   */
  function sweepAdmins() {
    for (const p of room.getPlayerList()) {
      if (isHost(p)) continue;
      if (p.admin && !isStaff(p)) room.setPlayerAdmin(p.id, false);
    }
  }

  /**
   * Map changes are host-only. Reverting needs the game stopped first,
   * because setCustomStadium refuses to run mid-match.
   */
  function onStadiumChange(name, byPlayer) {
    if (isHostAction(byPlayer)) return;
    chat.error(t.guardNoStadium, byPlayer.id);
    chat.info(t.guardStadiumReverted);

    // This used to stop the game and swap the stadium in the same tick, which
    // ALWAYS threw: stopGame() is queued, so the engine still thinks a game is
    // running and setCustomStadium refuses. The throw was swallowed and the
    // room carried on playing the intruder's map indefinitely — the mode
    // system believed its own map was still loaded, so it never re-uploaded.
    room.stopGame();
    setTimeout(() => {
      try {
        if (onStadiumHijacked) onStadiumHijacked(); // forget the cached map
        room.setCustomStadium(getStadium());
        applySettings();
      } catch (err) {
        console.error('[guard] could not revert stadium:', err.message);
        // Leave the cache cleared so the next rebuild re-uploads regardless.
      }
    }, config.stopSettleMs === undefined ? 250 : config.stopSettleMs);
  }

  function onTeamsLockChange(locked, byPlayer) {
    if (isHostAction(byPlayer)) return;
    if (!locked) {
      room.setTeamsLock(true);
      chat.error(t.guardNoUnlock, byPlayer.id);
    }
  }

  function onKickRateLimitSet(min, rate, burst, byPlayer) {
    if (isHostAction(byPlayer)) return;
    room.setKickRateLimit(6, 0, 0);
    chat.error(t.guardNoKickRate, byPlayer.id);
  }

  /**
   * Score and time limits have no change callback and no getter, so the only
   * defence is to re-apply them whenever a game ends.
   */
  function applySettings() {
    room.setScoreLimit(config.scoreLimit);
    room.setTimeLimit(config.timeLimit);
    room.setTeamsLock(true);
    room.setKickRateLimit(6, 0, 0);
    sweepAdmins();
  }

  return {
    isStaff,
    sweepAdmins,
    grant,
    onJoin,
    onLeave,
    onAdminChange,
    onStadiumChange,
    onTeamsLockChange,
    onKickRateLimitSet,
    applySettings,
    get authorisedCount() {
      return authorised.size;
    },
  };
}

module.exports = { createGuard };
