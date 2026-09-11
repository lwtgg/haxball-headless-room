/**
 * Host player helpers.
 *
 * When the room runs with `noPlayer: false` (BOT_NAME set), Haxball puts a
 * host player in the room at id 0. It shows in the spectator list, it holds
 * admin permanently, and it turns up in `getPlayerList()` like anybody else.
 *
 * Two consequences the rest of the code has to respect:
 *
 *   1. The host must never be queued, put on a team, given stats, or counted
 *      when deciding what mode to play. `isHost` / `notHost` do that.
 *
 *   2. In callbacks, "the bot did this" is `byPlayer === null` with
 *      noPlayer: true, but `byPlayer.id === 0` with noPlayer: false.
 *      `isHostAction` covers both so the guard works either way.
 */
const HOST_ID = 0;

const isHost = (playerOrId) => {
  if (playerOrId == null) return false;
  const id = typeof playerOrId === 'number' ? playerOrId : playerOrId.id;
  return id === HOST_ID;
};

const notHost = (playerOrId) => !isHost(playerOrId);

/** True when a callback's byPlayer means "the room itself did this". */
const isHostAction = (byPlayer) => byPlayer === null || byPlayer === undefined || isHost(byPlayer);

module.exports = { HOST_ID, isHost, notHost, isHostAction };
