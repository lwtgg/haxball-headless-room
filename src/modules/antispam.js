const { t } = require('../i18n');

/**
 * Chat flood protection.
 *
 * Deliberately minimal, after the first version turned out to be far too
 * aggressive: it had a cooldown between *any* two messages, blocked any repeat
 * for twenty seconds, and muted people for a minute once they tripped it a few
 * times. Two friends talking quickly looked exactly like a flood.
 *
 * The rule now is the one thing that is actually antisocial: repeating the
 * same line over and over. Say the same thing `repeatLimit` times (default 3)
 * and the next one is swallowed and you sit out a few seconds. Different
 * messages are never blocked, however fast you type. Nobody gets muted.
 */
function createAntiSpam({ chat, registry, config, guard }) {
  // playerId -> { text, count, firstAt, cooldownUntil, warnedAt }
  const seen = new Map();

  const limit = Math.max(1, Number(config.spamRepeatLimit) || 3);
  const cooldownMs = Math.max(0, Number(config.spamCooldownMs) || 0);
  const windowMs = Math.max(0, Number(config.spamRepeatWindowMs) || 0);
  const warnEvery = Math.max(0, Number(config.spamWarnCooldownMs) || 0);

  function stateOf(id) {
    if (!seen.has(id)) {
      seen.set(id, { text: '', count: 0, firstAt: 0, cooldownUntil: 0, warnedAt: 0 });
    }
    return seen.get(id);
  }

  /** A flood of "stop flooding" is still a flood, so warnings are throttled. */
  function warn(st, playerId, message) {
    const now = Date.now();
    if (now - st.warnedAt < warnEvery) return;
    st.warnedAt = now;
    chat.error(message, playerId);
  }

  /**
   * Returns true if the message should be swallowed.
   * Staff are exempt — they need to be able to post rules and warnings.
   */
  function shouldBlock(player, message) {
    if (guard && guard.isStaff(player)) return false;

    const st = stateOf(player.id);
    const now = Date.now();
    const text = String(message).trim().toLowerCase();

    if (st.cooldownUntil > now) {
      warn(st, player.id, t.spamWait(Math.ceil((st.cooldownUntil - now) / 1000)));
      return true;
    }

    // A repeat only counts if it comes reasonably soon after the last one.
    // Saying "gg" once a match is not spam.
    const continuing = text !== '' && text === st.text && now - st.firstAt < windowMs;

    if (continuing) {
      st.count++;
    } else {
      st.text = text;
      st.count = 1;
      st.firstAt = now;
    }

    if (st.count <= limit) return false;

    // Over the line: sit out a few seconds and start counting again.
    st.cooldownUntil = now + cooldownMs;
    st.count = 0;
    st.text = '';
    warn(st, player.id, t.spamRepeat(Math.round(cooldownMs / 1000)));
    return true;
  }

  function forget(playerId) {
    seen.delete(playerId);
  }

  return { shouldBlock, forget };
}

module.exports = { createAntiSpam };
