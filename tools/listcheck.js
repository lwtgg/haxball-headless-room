/**
 * Room list diagnostic.
 *
 * Downloads Haxball's public room list — the same endpoint the game client
 * uses — and looks for your room in it. Bypasses the browser, the room list
 * UI, and any add-ons entirely.
 *
 * Usage:
 *   npm run listcheck              # searches for ROOM_NAME from .env
 *   npm run listcheck -- zico      # searches for whatever you pass
 *
 * Run it WHILE the room is running.
 */
require('dotenv').config();

const LIST_URL = 'https://www.haxball.com/rs/api/list';
const GEO_URL = 'https://www.haxball.com/rs/api/geo';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Haxball's CDN is fussy and inconsistent about which callers it accepts, so
// we try several shapes and use whichever gets through.
const ATTEMPTS = [
  { label: 'no headers', headers: {} },
  { label: 'user-agent only', headers: { 'User-Agent': BROWSER_UA } },
  {
    label: 'full browser headers',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://www.haxball.com',
      Referer: 'https://www.haxball.com/',
    },
  },
];

const rawName = (process.argv.slice(2).join(' ') || process.env.ROOM_NAME || '').trim();

if (!rawName) {
  console.error('Nothing to search for. Pass a name or set ROOM_NAME in .env.');
  process.exit(1);
}

// Emoji and accents survive the round trip unpredictably, so match on a plain
// ASCII run from the name rather than the whole thing. The first word is
// usually the distinctive one ("Zico's Futsal" -> "Zico"); generic words like
// "futsal" would collide with hundreds of other rooms.
const GENERIC = new Set(['futsal', 'futsala', 'room', 'the', 'sala', 'x4', 'v4', 'hax', 'haxball']);
const words = rawName.match(/[A-Za-z0-9]{3,}/g) || [];
const needle = words.find((w) => !GENERIC.has(w.toLowerCase())) || words[0] || rawName;

function describe(err) {
  if (err == null) return '(no detail)';
  if (typeof err === 'string') return err;
  return err.message || JSON.stringify(err);
}

/** Try each header shape until one returns 200. */
async function tryFetch(url, kind) {
  for (const attempt of ATTEMPTS) {
    try {
      const res = await fetch(url, { headers: attempt.headers });
      if (res.ok) {
        return kind === 'json' ? await res.json() : Buffer.from(await res.arrayBuffer());
      }
      console.log(`  ${attempt.label}: HTTP ${res.status}`);
    } catch (err) {
      console.log(`  ${attempt.label}: ${describe(err)}`);
    }
  }
  return null;
}

/** Last resort: the node-haxball library, which uses its own HTTP path. */
async function viaLibrary() {
  try {
    const { Utils } = require('node-haxball')();
    const rooms = await Utils.getRoomList();
    return rooms;
  } catch (err) {
    console.log(`  node-haxball: ${describe(err)}`);
    return null;
  }
}

function verdictFound(extra) {
  console.log('\n>>> FOUND IT. Your room IS in the public list. <<<\n');
  if (extra) console.log(extra + '\n');
  console.log('The room is published. If you still cannot see it in the game it is');
  console.log('a sorting problem, not hosting: a blank country or lat/lon of 0,0');
  console.log("sinks a room to the bottom of everyone's list.");
}

function verdictMissing() {
  console.log('\n>>> NOT IN THE PUBLIC LIST. <<<\n');
  console.log('The room runs and works by link, but Haxball is not publishing it.');
  console.log('Because players can join by link, the listing request definitely');
  console.log('reached Haxball — they are choosing not to list it.');
  console.log('\nMost likely the per-IP limit on listed rooms (about two per IP).');
}

async function main() {
  console.log(`\nRoom name: "${rawName}"`);
  console.log(`Matching on: "${needle}"\n`);

  console.log('geo endpoint:');
  const geo = await tryFetch(GEO_URL, 'json');
  if (geo) console.log('  Haxball places this machine at:', geo);
  else console.log('  (geo unavailable — not fatal, carrying on)');

  console.log('\nlist endpoint:');
  const buf = await tryFetch(LIST_URL, 'buffer');

  if (buf) {
    console.log(`  got ${buf.length} bytes\n`);
    const views = [buf.toString('utf8'), buf.toString('latin1'), buf.toString('utf16le')].map((s) =>
      s.toLowerCase()
    );
    const target = needle.toLowerCase();
    const hit = views.some((v) => v.includes(target));
    const sane = views.some((v) => v.includes('futsala') || v.includes('bazinga'));

    if (hit) verdictFound();
    else verdictMissing();

    console.log(
      `\n(sanity check: ${sane ? 'found' : 'did NOT find'} well-known public rooms in the payload` +
        `${sane ? ')' : ' — result above is unreliable, tell Claude)'}`
    );
    console.log('');
    return;
  }

  console.log('\n  direct fetch blocked, falling back to the node-haxball client:');
  const rooms = await viaLibrary();

  if (!rooms) {
    console.log('\nCould not read the room list from this machine at all.');
    console.log('Haxball is refusing API requests from this IP (common for datacenter');
    console.log('ranges). This does NOT mean your room is unlisted — it means we cannot');
    console.log('check from here. Run this same command from your home PC instead:');
    console.log(`    npm run listcheck -- ${needle}`);
    console.log('');
    return;
  }

  console.log(`  got ${rooms.length} rooms`);
  const hits = rooms.filter((r) => String(r.name || '').toLowerCase().includes(needle.toLowerCase()));
  if (hits.length) verdictFound(JSON.stringify(hits, null, 2));
  else verdictMissing();
  console.log('');
}

main();
