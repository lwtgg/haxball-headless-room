/**
 * Writes a fresh token into .env without opening an editor.
 * Tokens expire in about two minutes, so fumbling with nano over SSH is the
 * difference between a room and a rejected token.
 *
 * Usage:  npm run token -- thr1.AAAAA...
 */
const fs = require('fs');
const path = require('path');

const token = (process.argv[2] || '').trim();
if (!token) {
  console.error('Usage: npm run token -- <token from https://www.haxball.com/headlesstoken>');
  process.exit(1);
}

const envPath = path.resolve('.env');
let text = '';
if (fs.existsSync(envPath)) text = fs.readFileSync(envPath, 'utf8');

if (/^HAXBALL_TOKEN=.*$/m.test(text)) {
  text = text.replace(/^HAXBALL_TOKEN=.*$/m, `HAXBALL_TOKEN=${token}`);
} else {
  text = `HAXBALL_TOKEN=${token}\n` + text;
}

fs.writeFileSync(envPath, text);
console.log('Token written to .env. Start the room now, it expires fast.');
