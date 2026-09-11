/**
 * Player registry.
 *
 * Haxball gives every connected player a numeric `id` that is only valid for
 * that session. `auth` is a stable public key hash tied to the browser profile
 * and is what we key persistent data on. `conn` is the hex-encoded IP, useful
 * for catching alt accounts and for bans.
 */

function createRegistry() {
  const online = new Map(); // id -> session record

  return {
    add(player) {
      const rec = {
        id: player.id,
        name: player.name,
        auth: player.auth || null,
        conn: player.conn || null,
        admin: false,
        joinedAt: Date.now(),
        lastActivity: Date.now(),
        afk: false,
        muted: false,
        // per-match counters, reset every game
        match: { goals: 0, assists: 0, ownGoals: 0 },
      };
      online.set(player.id, rec);
      return rec;
    },

    remove(id) {
      const rec = online.get(id);
      online.delete(id);
      return rec;
    },

    get(id) {
      return online.get(id) || null;
    },

    /**
     * Stable key for persistence: the Haxball auth hash, or nothing.
     *
     * This used to fall back to `conn`, which is the hex-encoded IP. That put
     * everyone behind one address — a household, a cybercafé, a mobile carrier
     * doing CGNAT — on a single shared record: shared coins, shared purchases,
     * and `!reiniciarstats` from any one of them wiping the lot. An IP is not
     * an identity. A player with no auth simply does not persist, and is told
     * so when they join.
     *
     * (The old code also had a `name:` fallback after it, which could never
     * run: a template literal is always a non-empty string.)
     */
    key(id) {
      const rec = online.get(id);
      if (!rec) return null;
      return rec.auth || null;
    },

    /** Every player whose nickname matches exactly, case-insensitively. */
    matches(name) {
      const needle = String(name).toLowerCase();
      return [...online.values()].filter((rec) => rec.name.toLowerCase() === needle);
    },

    byName(name) {
      const found = this.matches(name);
      // Haxball does not enforce unique nicknames, and returning the first
      // match meant a troll could copy a regular's name and have the regular
      // kicked in their place. Ambiguous is not found.
      return found.length === 1 ? found[0] : null;
    },

    /**
     * Accepts "#3" (id) or a nickname.
     *
     * The id form is strict: "#5" used to be parsed with Number(), so a player
     * whose nickname was literally "#5" could never be targeted — every
     * attempt hit whoever happened to hold id 5 — and "#0x5" and "#5e0" landed
     * there too.
     */
    find(token) {
      return this.lookup(token).player;
    },

    /** Why a lookup failed, so commands can say something useful. */
    lookup(token) {
      if (!token) return { player: null, reason: 'missing' };
      const asId = /^#(\d+)$/.exec(String(token));
      if (asId) {
        const player = this.get(Number(asId[1]));
        // If nobody holds that id, fall through to the name search, so a
        // player whose nickname really is "#5" can still be targeted.
        if (player) return { player, reason: null };
      }
      const found = this.matches(token);
      if (found.length === 1) return { player: found[0], reason: null };
      if (found.length === 0) return { player: null, reason: 'notfound' };
      return { player: null, reason: 'ambiguous', candidates: found };
    },

    all() {
      return [...online.values()];
    },

    resetMatchStats() {
      for (const rec of online.values()) {
        rec.match = { goals: 0, assists: 0, ownGoals: 0 };
      }
    },
  };
}

module.exports = { createRegistry };
