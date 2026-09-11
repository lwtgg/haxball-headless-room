const Store = require('../util/store');

const BLANK = {
  name: '',
  goals: 0,
  assists: 0,
  ownGoals: 0,
  wins: 0,
  losses: 0,
  games: 0,
  cleanSheets: 0,
  // progression
  xp: 0,
  coins: 0,
  owned: [], // store item ids
  celebration: null, // active item id
};

function createStats(config) {
  const store = new Store(config.dataFile);

  function record(key) {
    if (!key) return { ...BLANK };
    const existing = store.get(key);
    return existing ? { ...BLANK, ...existing } : { ...BLANK };
  }

  return {
    store,

    get(key) {
      return record(key);
    },

    /** patch is a partial object of numeric deltas, plus optional name. */
    bump(key, patch) {
      if (!key) return;
      const rec = record(key);
      for (const [field, delta] of Object.entries(patch)) {
        if (field === 'name' || field === 'celebration') rec[field] = delta;
        else if (Array.isArray(rec[field])) continue; // arrays are set directly, not bumped
        else rec[field] = (rec[field] || 0) + delta;
      }
      store.set(key, rec);
    },

    reset(key) {
      if (!key) return;
      const rec = record(key);
      store.set(key, { ...BLANK, name: rec.name });
    },

    /** Top N by a numeric field. */
    top(field, n = 10) {
      return Object.entries(store.all())
        .map(([key, rec]) => ({ key, ...BLANK, ...rec }))
        .filter((r) => (r[field] || 0) > 0)
        .sort((a, b) => b[field] - a[field])
        .slice(0, n);
    },

    flush: () => store.flush(),
  };
}

module.exports = { createStats, BLANK };
