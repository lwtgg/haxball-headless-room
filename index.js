// haxball.js v5 ships as an ES module with a default export, so under
// CommonJS the callable lives on `.default`.
const mod = require('haxball.js');
const HaxballJS = typeof mod === 'function' ? mod : mod.default;
const config = require('./config');
const { startRoom } = require('./src/room');

if (!config.token) {
  console.error(
    '\nNo HAXBALL_TOKEN set.\n' +
      'Get one at https://www.haxball.com/headlesstoken, put it in .env, then run again.\n' +
      'Tokens expire in a few minutes, so grab it right before starting.\n'
  );
  process.exit(1);
}

// Without these, one bug anywhere becomes a dead room: an uncaught exception
// kills the process, pm2 restarts it, the stale token in .env is rejected, and
// it exits again — a restart loop that cannot recover until somebody fetches a
// fresh token by hand. Staying alive and noisy is strictly better.
process.on('uncaughtException', (err) => {
  console.error('\n!! UNCAUGHT EXCEPTION — the room may be in a bad state:\n', err);
});
process.on('unhandledRejection', (err) => {
  console.error('\n!! UNHANDLED REJECTION:\n', err);
});

HaxballJS()
  .then((HBInit) => {
    startRoom(HBInit, config);
  })
  .catch((err) => {
    const msg = String(err && err.message);
    if (err instanceof mod.InvalidRoomTokenError || /token/i.test(msg)) {
      console.error(
        '\nThat token was rejected. They expire about two minutes after you generate them.\n' +
          'Get a fresh one at https://www.haxball.com/headlesstoken and start again right away.\n'
      );
    } else {
      console.error('Failed to start room:', err);
    }
    process.exit(1);
  });
