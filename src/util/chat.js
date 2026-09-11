/**
 * Chat helpers. Haxball colors are decimal ints, styles are
 * "normal" | "bold" | "italic" | "small" | "small-bold" | "small-italic".
 */

const C = {
  white: 0xffffff,
  gray: 0x9aa4b5,
  green: 0x4ade80,
  red: 0xf87171,
  blue: 0x60a5fa,
  yellow: 0xfacc15,
  orange: 0xfb923c,
  purple: 0xc084fc,
  brand: 0x34d399,
};

function makeChat(room) {
  const send = (msg, target, color, style, sound) =>
    room.sendAnnouncement(msg, target === undefined ? null : target, color, style, sound === undefined ? 1 : sound);

  // Grey on Haxball's dark background is hard to read, so nothing here uses it.
  // Everything is white or a strong accent colour, and most of it is bold.
  return {
    C,
    // Neutral info line
    info: (msg, target) => send(msg, target, C.white, 'bold', 0),
    // Good news
    ok: (msg, target) => send(msg, target, C.green, 'bold', 1),
    // Errors / denied actions, only chimes for the person it concerns
    error: (msg, target) => send(msg, target, C.red, 'bold', 2),
    // Server-wide highlight
    hype: (msg, target) => send(msg, target, C.yellow, 'bold', 2),
    // Secondary text — smaller and plain, but white rather than grey
    dim: (msg, target) => send(msg, target, C.white, 'small', 0),
    raw: send,
  };
}

module.exports = { makeChat, C };
