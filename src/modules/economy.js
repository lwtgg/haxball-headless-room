const { t } = require('../i18n');

/**
 * Coins, the store, and match betting.
 *
 * Coins are stored on the same persisted stats record as everything else, so
 * they survive restarts and follow the player's Haxball auth rather than their
 * nickname.
 */

const REWARDS = {
  goal: 10,
  assist: 6,
  win: 25,
  cleanSheet: 15,
  played: 5,
};

/** Store items are goal celebrations: a temporary avatar swap when you score. */
const ITEMS = [
  { id: 'fuego', name: 'Fuego', price: 80, avatar: '🔥' },
  { id: 'rey', name: 'Rey', price: 120, avatar: '👑' },
  { id: 'cohete', name: 'Cohete', price: 120, avatar: '🚀' },
  { id: 'calavera', name: 'Calavera', price: 150, avatar: '💀' },
  { id: 'diamante', name: 'Diamante', price: 200, avatar: '💎' },
  { id: 'corona', name: 'Campeón', price: 300, avatar: '🏆' },
  { id: 'alien', name: 'Alien', price: 400, avatar: '👽' },
  { id: 'goat', name: 'GOAT', price: 750, avatar: '🐐' },
];

const itemById = (id) => ITEMS.find((i) => i.id === String(id).toLowerCase()) || null;

function createEconomy({ room, chat, registry, stats, config }) {
  const coin = config.coinName;

  // playerId -> { amount, team }
  let bets = new Map();
  let betsOpen = false;
  let betWindowTimer = null;

  function balance(playerId) {
    return stats.get(registry.key(playerId)).coins || 0;
  }

  function give(playerId, amount, why) {
    const rec = registry.get(playerId);
    if (!rec) return;
    stats.bump(registry.key(playerId), { coins: amount, name: rec.name });
    if (why) chat.dim(t.earned(coin, amount, why), playerId);
  }

  function take(playerId, amount) {
    if (balance(playerId) < amount) return false;
    stats.bump(registry.key(playerId), { coins: -amount });
    return true;
  }

  // ---------------------------------------------------------------- store
  function showStore(playerId) {
    chat.info(t.storeTitle(coin), playerId);
    chat.dim(ITEMS.map((i) => t.storeLine(i)).join('\n'), playerId);
    chat.dim(t.balance(coin, balance(playerId)), playerId);
  }

  function buy(playerId, id) {
    const item = itemById(id);
    if (!item) return chat.error(t.storeUnknown, playerId);

    const key = registry.key(playerId);
    const rec = stats.get(key);
    const owned = rec.owned || [];
    if (owned.includes(item.id)) return chat.error(t.storeOwned(item.name), playerId);

    if (!take(playerId, item.price)) return chat.error(t.notEnoughCoins(coin), playerId);

    const updated = stats.get(key);
    updated.owned = [...owned, item.id];
    if (!updated.celebration) updated.celebration = item.id;
    stats.store.set(key, updated);

    chat.ok(t.storeBought(item.name), playerId);
  }

  function celebration(playerId, id) {
    const key = registry.key(playerId);
    const rec = stats.get(key);
    const owned = rec.owned || [];

    if (!id) {
      if (!owned.length) return chat.dim(t.celebNone, playerId);
      return chat.dim(t.celebList(owned.join(', ')), playerId);
    }
    const item = itemById(id);
    if (!item || !owned.includes(item.id)) return chat.error(t.celebNotOwned, playerId);

    rec.celebration = item.id;
    stats.store.set(key, rec);
    chat.ok(t.celebSet(item.name), playerId);
  }

  /** Flash the scorer's chosen avatar, then put it back. */
  function playCelebration(playerId) {
    const rec = stats.get(registry.key(playerId));
    const item = itemById(rec.celebration);
    if (!item) return;
    room.setPlayerAvatar(playerId, item.avatar);
    setTimeout(() => {
      try {
        room.setPlayerAvatar(playerId, null);
      } catch (_) {
        /* player probably left */
      }
    }, 4000);
  }

  // ---------------------------------------------------------------- transfers
  function transfer(fromId, toToken, rawAmount) {
    const amount = Math.floor(Number(rawAmount));
    const target = registry.find(toToken);
    if (!target || !Number.isFinite(amount) || amount <= 0) {
      return chat.error(t.transferBad(coin), fromId);
    }
    if (target.id === fromId) return chat.error(t.transferSelf, fromId);
    if (!take(fromId, amount)) return chat.error(t.notEnoughCoins(coin), fromId);

    give(target.id, amount);
    const from = registry.get(fromId);
    chat.ok(t.transferOk(amount, coin, target.name), fromId);
    chat.ok(t.transferGot(amount, coin, from ? from.name : '?'), target.id);
  }

  // ---------------------------------------------------------------- betting
  function openBets() {
    // Anything still on the table belongs to the last match. Refund it rather
    // than throwing the map away: matches end without a victory all the time —
    // an admin stopping the game, the pitch swapping for a bigger mode, a side
    // emptying — and every one of those used to quietly pocket the stakes.
    refundAll('el partido anterior no terminó');

    bets = new Map();
    betsOpen = true;
    chat.dim(t.betOpen);

    // The old timer was never cleared, so a leftover from the previous match
    // closed this one's window early.
    clearTimeout(betWindowTimer);
    betWindowTimer = setTimeout(() => {
      betsOpen = false;
    }, config.betWindowSeconds * 1000);
  }

  /** Hand every stake back. Used when a match ends without a result. */
  function refundAll(why) {
    if (bets.size === 0) return;
    for (const [playerId, bet] of bets) {
      if (!registry.get(playerId)) continue;
      give(playerId, bet.amount);
      chat.info(t.betRefund(bet.amount, coin), playerId);
    }
    if (why) console.log(`[economy] refunded ${bets.size} bet(s): ${why}`);
    bets = new Map();
  }

  function placeBet(playerId, rawAmount, rawTeam) {
    if (!room.getScores()) return chat.error(t.betNoGame, playerId);
    if (!betsOpen) return chat.error(t.betClosed, playerId);
    if (bets.has(playerId)) return chat.error(t.betAlready, playerId);

    // Players cannot bet on their own match. Two friends alone in a 1v1 could
    // both stake everything, agree who wins, and double their money every
    // thirty seconds — the payout is fixed at 2x against an infinite bank.
    const self = room.getPlayer(playerId);
    if (self && self.team !== 0) return chat.error(t.betPlaying, playerId);

    const amount = Math.floor(Number(rawAmount));
    const word = String(rawTeam || '').toLowerCase();
    const team = word.startsWith('r') ? 1 : word.startsWith('a') || word.startsWith('b') ? 2 : null;

    if (!Number.isFinite(amount) || amount <= 0 || !team) return chat.error(t.betBad, playerId);
    // A ceiling keeps one lucky night from breaking the whole economy, and
    // keeps balances well clear of the range where they stop being exact.
    const max = Math.max(1, Number(config.betMax) || 500);
    if (amount > max) return chat.error(t.betTooBig(max, coin), playerId);
    if (!take(playerId, amount)) return chat.error(t.notEnoughCoins(coin), playerId);

    bets.set(playerId, { amount, team });
    chat.ok(t.betPlaced(amount, coin, team === 1 ? t.red : t.blue), playerId);
  }

  function settleBets(scores) {
    betsOpen = false;
    clearTimeout(betWindowTimer);
    betWindowTimer = null;
    if (bets.size === 0) return;

    const winner = scores.red > scores.blue ? 1 : scores.blue > scores.red ? 2 : null;

    for (const [playerId, bet] of bets) {
      if (!registry.get(playerId)) continue; // left, stake is forfeit
      if (winner === null) {
        give(playerId, bet.amount);
        chat.info(t.betRefund(bet.amount, coin), playerId);
      } else if (bet.team === winner) {
        const payout = bet.amount * 2;
        give(playerId, payout);
        chat.ok(t.betWon(payout, coin), playerId);
      } else {
        chat.error(t.betLost(bet.amount, coin), playerId);
      }
    }
    bets = new Map();
  }

  return {
    REWARDS,
    ITEMS,
    coin,
    balance,
    give,
    take,
    showStore,
    buy,
    celebration,
    playCelebration,
    transfer,
    openBets,
    placeBet,
    settleBets,
    refundAll,
    get betsOpen() {
      return betsOpen;
    },
  };
}

module.exports = { createEconomy, ITEMS, REWARDS, itemById };
