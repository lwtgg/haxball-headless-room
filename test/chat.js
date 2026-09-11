/**
 * Chat flood protection and kits.
 *
 * Run with: npm run test:chat
 */
process.chdir(require('path').resolve(__dirname, '..'));

const assert = require('assert');
const { createAntiSpam } = require('../src/modules/antispam');
const {
  createKits,
  list,
  get,
  mainColor,
  colorDistance,
  MIN_KIT_DISTANCE,
} = require('../src/modules/kits');
const { createRegistry } = require('../src/modules/players');

const config = {
  spamRepeatLimit: 3,
  spamCooldownMs: 300, // short, so the tests do not crawl
  spamRepeatWindowMs: 30000,
  spamWarnCooldownMs: 0, // warn every time, so the tests can see them
};

function makeWorld({ staff = [], configOverride = {} } = {}) {
  const said = [];
  const chat = {
    info: (m) => said.push(String(m)),
    ok: (m) => said.push(String(m)),
    dim: (m) => said.push(String(m)),
    error: (m) => said.push(String(m)),
    hype: (m) => said.push(String(m)),
  };
  const registry = createRegistry();
  const guard = { isStaff: (p) => staff.includes(p.id) };
  const antispam = createAntiSpam({ chat, registry, config: { ...config, ...configOverride }, guard });

  const add = (id) => {
    const p = { id, name: `p${id}`, team: 0, admin: false, auth: `a${id}`, conn: `c${id}` };
    registry.add(p);
    return p;
  };

  return { antispam, said, add };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // ---- fast conversation is never blocked -----------------------------
  // The old filter had a cooldown between any two messages, so two friends
  // talking quickly tripped it constantly. Different lines, however fast,
  // must always get through.
  {
    const w = makeWorld();
    const p = w.add(1);

    const lines = ['hola', 'que tal', 'vamos', 'pasa', 'tiro', 'gol', 'uf', 'otra'];
    for (const line of lines) {
      assert.strictEqual(w.antispam.shouldBlock(p, line), false, `"${line}" got through`);
    }
    assert.strictEqual(w.said.length, 0, 'and nobody was told off');
  }

  // ---- three of the same is fine, the fourth is not -------------------
  {
    const w = makeWorld();
    const p = w.add(1);

    assert.strictEqual(w.antispam.shouldBlock(p, 'vamos'), false, '1st');
    assert.strictEqual(w.antispam.shouldBlock(p, 'vamos'), false, '2nd');
    assert.strictEqual(w.antispam.shouldBlock(p, 'vamos'), false, '3rd is still allowed');
    assert.strictEqual(w.antispam.shouldBlock(p, 'vamos'), true, '4th is swallowed');
    assert(w.said.some((m) => m.includes('repitiendo')), 'and they are told why');
  }

  // ---- the cooldown is short, and then life goes on -------------------
  {
    const w = makeWorld();
    const p = w.add(1);

    for (let i = 0; i < 4; i++) w.antispam.shouldBlock(p, 'entren a mi sala');
    assert.strictEqual(w.antispam.shouldBlock(p, 'otra cosa'), true, 'sitting out the cooldown');

    await wait(config.spamCooldownMs + 50);
    assert.strictEqual(w.antispam.shouldBlock(p, 'perdon'), false, 'back to normal after it');
    assert.strictEqual(w.antispam.shouldBlock(p, 'entren a mi sala'), false, 'counting starts over');
  }

  // ---- a line repeated across a long gap is not spam ------------------
  {
    const w = makeWorld({ configOverride: { spamRepeatWindowMs: 40 } });
    const p = w.add(1);

    w.antispam.shouldBlock(p, 'gg');
    w.antispam.shouldBlock(p, 'gg');
    w.antispam.shouldBlock(p, 'gg');
    await wait(60); // a match goes by
    assert.strictEqual(w.antispam.shouldBlock(p, 'gg'), false, 'saying gg again later is fine');
  }

  // ---- staff are exempt ------------------------------------------------
  {
    const w = makeWorld({ staff: [1] });
    const p = w.add(1);

    for (let i = 0; i < 6; i++) {
      assert.strictEqual(w.antispam.shouldBlock(p, 'reglas'), false, 'staff can repeat');
    }
  }

  // ---- leaving clears their record ------------------------------------
  {
    const w = makeWorld();
    const p = w.add(1);
    for (let i = 0; i < 4; i++) w.antispam.shouldBlock(p, 'a');
    assert.strictEqual(w.antispam.shouldBlock(p, 'a'), true, 'blocked while flooding');

    w.antispam.forget(p.id); // they left and came back
    assert.strictEqual(w.antispam.shouldBlock(p, 'a'), false, 'clean slate');
  }

  // ---- kits ------------------------------------------------------------
  {
    const applied = [];
    const room = { setTeamColors: (...a) => applied.push(a) };
    const kits = createKits({ room });

    assert(list().length > 10, 'a decent selection of kits');
    assert(get('barca'), 'known kit resolves');
    assert.strictEqual(get('nonsense'), null, 'unknown kit is null');
    assert(get('BARCA'), 'kit names are case-insensitive');

    kits.reset();
    assert.strictEqual(applied.length, 2, 'reset paints both sides');

    applied.length = 0;
    const kit = kits.set(1, 'madrid');
    assert(kit && kit.name === 'Real Madrid', 'kit applied and reported');
    assert.strictEqual(applied.length, 1, 'only the one side repainted');
    assert.strictEqual(applied[0][0], 1, 'on red');
    assert.strictEqual(kits.current(1), 'madrid', 'remembered');

    assert.strictEqual(kits.set(1, 'nope'), null, 'unknown kit rejected');

    kits.reset();
    assert.strictEqual(kits.current(1), null, 'reset clears the kit for the next match');
  }

  // ---- kits are dealt at random every match ---------------------------
  // Captains override with !kit, but that only lasts the match, so every
  // kickoff opens with a fresh look instead of red versus blue forever.
  {
    const room = { setTeamColors: () => {} };
    const kits = createKits({ room });
    const seenRed = new Set();

    for (let i = 0; i < 200; i++) {
      const dealt = kits.randomize();
      assert(dealt.red && dealt.red.name, 'red got a kit');
      assert(dealt.blue && dealt.blue.name, 'blue got a kit');
      assert.notStrictEqual(kits.current(1), kits.current(2), 'never the same kit on both sides');

      // The two must be far enough apart in colour to tell apart on the pitch.
      const redKit = get(kits.current(1));
      const blueKit = get(kits.current(2));
      const distance = colorDistance(mainColor(redKit, 1), mainColor(blueKit, 2));
      assert(
        distance >= MIN_KIT_DISTANCE,
        `${redKit.name} vs ${blueKit.name} are too alike (${Math.round(distance)})`
      );

      seenRed.add(kits.current(1));
    }

    assert(seenRed.size > 5, `it actually varies (saw ${seenRed.size} different kits on red)`);
    assert(!seenRed.has('clasico'), 'the plain default is never dealt at random');
  }

  // ---- the winners keep their shirt ------------------------------------
  // A team on a run stays recognisable, even after a scramble puts them at the
  // other end of the pitch. Only the side facing them gets a new kit.
  {
    const room = { setTeamColors: () => {} };
    const kits = createKits({ room });

    kits.randomize();
    const wonIn = kits.current(1); // red won wearing this

    for (let i = 0; i < 50; i++) {
      // The scramble put most of the winners on blue this time.
      const dealt = kits.randomize({ keepTeam: 2, keepKit: wonIn });
      assert.strictEqual(kits.current(2), wonIn, 'the winners kept their shirt');
      assert.notStrictEqual(kits.current(1), wonIn, 'and the other side got a different one');
      assert(dealt.red && dealt.blue, 'both sides were dealt something');

      const distance = colorDistance(
        mainColor(get(kits.current(1)), 1),
        mainColor(get(kits.current(2)), 2)
      );
      assert(distance >= MIN_KIT_DISTANCE, 'and they are still tellable apart');
    }
  }

  // ---- a captain's choice still wins ----------------------------------
  {
    const room = { setTeamColors: () => {} };
    const kits = createKits({ room });
    kits.randomize();
    kits.set(1, 'barca');
    assert.strictEqual(kits.current(1), 'barca', 'the captain overrides the random kit');
  }

  // ---- rank colours are legible on the dark chat background -----------
  {
    const ranks = require('../src/modules/ranks');

    const luminance = (c) => {
      const channel = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      return (
        0.2126 * channel((c >> 16) & 0xff) +
        0.7152 * channel((c >> 8) & 0xff) +
        0.0722 * channel(c & 0xff)
      );
    };
    const background = luminance(0x1b2028); // Haxball's chat panel

    const seen = new Set();
    for (const rank of ranks.RANKS) {
      assert(typeof rank.color === 'number', `${rank.name} has a colour`);
      const l = luminance(rank.color);
      const contrast =
        (Math.max(l, background) + 0.05) / (Math.min(l, background) + 0.05);
      assert(contrast >= 4.5, `${rank.name} is readable (contrast ${contrast.toFixed(1)}:1)`);
      assert(!seen.has(rank.color), `${rank.name} has its own colour`);
      seen.add(rank.color);
    }

    assert.strictEqual(ranks.colorFor(0), ranks.RANKS[0].color, 'a new player gets the first rank');
    assert.strictEqual(
      ranks.colorFor(999999),
      ranks.RANKS[ranks.RANKS.length - 1].color,
      'and a veteran gets the last'
    );
  }


  // ---- the command table cannot be walked into via the prototype ------
  // `!constructor` and `!__proto__` used to resolve to real functions,
  // sail past the unknown-command reply AND the admin check (because
  // `cmd.admin` was undefined), and only fail inside cmd.run — a free way for
  // any player to fill the logs with stack traces.
  {
    const { resolve } = require('../src/commands');
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.strictEqual(resolve(name), null, `!${name} is not a command`);
    }
    assert(resolve('ayuda'), 'and real commands still resolve');
    assert(resolve('HELP'), 'including aliases, case-insensitively');
  }

  // ---- looking up players is unambiguous ------------------------------
  {
    const { createRegistry } = require('../src/modules/players');
    const reg = createRegistry();
    const add = (id, name, auth) => reg.add({ id, name, auth, conn: 'c' + id });

    add(5, 'Pepe', 'a5');
    add(7, 'Pepe', 'a7'); // a troll copying a regular's nickname
    add(9, '#5', 'a9'); // and someone whose name looks like an id

    // Two players share a name, so the lookup refuses rather than picking the
    // earliest joiner. Kicking the wrong "Pepe" is worse than not kicking.
    assert.strictEqual(reg.find('Pepe'), null, 'ambiguous names are not resolved');
    assert.strictEqual(reg.lookup('Pepe').reason, 'ambiguous');
    assert.strictEqual(reg.lookup('Pepe').candidates.length, 2, 'and both are offered');

    // The id form is strict.
    assert.strictEqual(reg.find('#5').id, 5, '#5 is id 5');
    assert.strictEqual(reg.find('#0x5'), null, 'hex is not an id');
    assert.strictEqual(reg.find('#5e0'), null, 'nor is exponent notation');
    assert.strictEqual(reg.find('#'), null, 'nor is a bare hash');
    assert.strictEqual(reg.find('#9').id, 9, 'and a real id still works');

    // Persistence keys off auth only. Falling back to the IP put everyone
    // behind one address on a single shared record: shared coins, shared
    // purchases, and !reiniciarstats wiping the lot.
    add(11, 'SinAuth', null);
    assert.strictEqual(reg.key(11), null, 'no auth, no persistence key');
    assert.strictEqual(reg.key(5), 'a5', 'auth is the key');
  }

  // ---- bans and mutes are filed by identity, not session id -----------
  // Player ids restart from 1 on every room restart, and the room restarts
  // often because tokens expire. Keying on the id meant today's ban silently
  // overwrote the record of whoever held that id last week, deleting their
  // auth from the file and letting them walk back in.
  {
    const Store = require('../src/util/store');
    const fs = require('fs');
    const file = 'data/test-bans.json';
    fs.rmSync(file, { force: true });

    const identityOf = (rec) => (rec.auth ? `auth:${rec.auth}` : `conn:${rec.conn}`);
    const bans = new Store(file);

    const troll = { id: 3, name: 'Troll', auth: 'authTroll', conn: 'connTroll' };
    const other = { id: 3, name: 'Otro', auth: 'authOtro', conn: 'connOtro' }; // same id, later day
    bans.set(identityOf(troll), { name: troll.name, auth: troll.auth, conn: troll.conn });
    bans.set(identityOf(other), { name: other.name, auth: other.auth, conn: other.conn });

    const stored = Object.values(bans.all());
    assert.strictEqual(stored.length, 2, 'two different people, two records');
    assert(
      stored.some((b) => b.auth === 'authTroll'),
      'the first ban survived the id collision'
    );

    bans.flush();
    const reloaded = new Store(file);
    assert.strictEqual(Object.keys(reloaded.all()).length, 2, 'and it survives a restart');
    fs.rmSync(file, { force: true });
  }

  // ---- a damaged stats file is kept, not silently overwritten ---------
  {
    const Store = require('../src/util/store');
    const fs = require('fs');
    const file = 'data/test-corrupt.json';
    fs.writeFileSync(file, '{"a":{"coins":10},'); // truncated mid-write

    const store = new Store(file);
    assert.deepStrictEqual(store.all(), {}, 'starts empty rather than throwing');

    const rescued = fs.readdirSync('data').filter((f) => f.startsWith('test-corrupt.json.corrupt-'));
    assert.strictEqual(rescued.length, 1, 'and the damaged file is kept for recovery');

    fs.rmSync(file, { force: true });
    for (const f of rescued) fs.rmSync('data/' + f, { force: true });
  }

  console.log('\nAll chat/kit tests passed.\n');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
