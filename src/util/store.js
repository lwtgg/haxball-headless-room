const fs = require('fs');
const path = require('path');

/** Everything is stored relative to the project root, never the working
 * directory. Started from the wrong cwd, the old code silently created a fresh
 * empty database and every player's coins and stats appeared to vanish. */
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Dead simple JSON store. Writes are debounced so we never hammer the disk
 * during a match. Good enough up to a few thousand players; swap for SQLite
 * later without touching the callers.
 */
class Store {
  constructor(file) {
    this.file = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
    this.data = {};
    this._timer = null;
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (err) {
      // Starting empty here quietly destroys everything: the next write
      // rewrites the file from the blank object and every player's coins, XP
      // and purchases are gone with nothing but one log line to show for it.
      // Keep the damaged file instead, so it can be recovered by hand.
      const rescued = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, rescued);
        console.error(`[store] ${this.file} is unreadable (${err.message}).`);
        console.error(`[store] The old file has been kept as ${rescued}.`);
        console.error('[store] Starting from empty. Recover it by hand if you need it.');
      } catch (renameErr) {
        console.error('[store] could not even set the bad file aside:', renameErr.message);
      }
      this.data = {};
    }
  }

  get(key, fallback = null) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  all() {
    return this.data;
  }

  /** Write via a temp file so a crash mid-write cannot truncate the real one. */
  _writeNow() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 0));
    fs.renameSync(tmp, this.file);
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        this._writeNow();
      } catch (err) {
        console.error('[store] save failed:', err.message);
      }
    }, 2000);
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      // Same atomic path as save(). Flush runs at shutdown, which is exactly
      // when the process is most likely to be killed mid-write, and the old
      // version wrote straight over the live file.
      this._writeNow();
    } catch (err) {
      console.error('[store] flush failed:', err.message);
    }
  }
}

module.exports = Store;
