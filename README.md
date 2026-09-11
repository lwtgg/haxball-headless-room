# Futsal 4v4 — Haxball headless room

A Node.js headless Haxball host running the **AF Official 4v4 by Vitão** map, with a
retas-style queue, auto team filling, persistent stats and a command system.

---

## 1. Requirements

- **Node.js 22.18 or newer** (`node -v` to check). Download from nodejs.org.
- Nothing else. No Chrome, no Puppeteer.

## 2. First run

```bash
npm install
cp .env.example .env        # on Windows: copy .env.example .env
```

Open `.env` and set at minimum `ADMIN_PASSWORD` and `ROOM_NAME`.

Then, right before starting:

1. Go to <https://www.haxball.com/headlesstoken>
2. Solve the captcha, copy the token
3. Paste it into `.env` as `HAXBALL_TOKEN=...`
4. `npm start`

The room link prints in the terminal. **Tokens expire in a couple of minutes**, so
always grab a fresh one immediately before starting. Once the room is up the token
no longer matters — it only gates room creation, not the room's lifetime.

## 3. Commands

The room speaks Spanish. English aliases work too, so `!help` and `!ayuda` both
work, as do `!store`/`!tienda`, `!goals`/`!goles` and so on.

Everyone:

| Comando | Qué hace |
|---|---|
| `!ayuda` | Lista de comandos |
| `!version` | Qué build está corriendo la sala |
| `!pausa` | Capitán: parar el reloj 15s para hacer un cambio |
| `!banquear #id` | Durante la pausa: sacar a alguien de tu equipo |
| `!me` | Tus stats, rango y monedas (privado) |
| `!mostrarstats` | Enseña tus stats a la sala |
| `!rango` `!rangos` | Tu rango y XP / la tabla de rangos |
| `!monedas` | Tu saldo |
| `!tienda` `!comprar <id>` | Ver y comprar celebraciones |
| `!celebracion <id>` | Elegir tu celebración de gol |
| `!dar #id <cantidad>` | Enviar monedas a otro jugador |
| `!apostar <cantidad> <rojo\|azul>` | Apostar al resultado |
| `!afk` `!afks` | Marcarte AFK / ver ausentes |
| `!dc` `!bb` | Discord / salir |
| `!goles` `!asistencias` `!victorias` `!partidos` `!vallas` `!ricos` `!top` | Rankings |
| `!bloquear #id` `!desbloquear` `!bloqueados` | Lista personal de bloqueados |
| `!reiniciarstats` | Borra tus propias stats |
| `!claim <contraseña>` | Ser admin |

Admins: `!mutear` `!desmutear` `!muteados` `!kick` `!ban` `!bans` `!unban` `!rr`
`!empezar` `!parar` `!auto on|off` `!banca` `!regalar` `!estado` `!fijarmodo`

**`!parar` hands you the room.** It stops the match *and* switches the bot's
rotation off, so it will not build teams or start matches until `!empezar`.
Before that, `!parar` was useless: the safety-net timer noticed no game was
running and started one again within four seconds, so there was no way to hold
the room still and sort something out.

Both `!kick #4` and `!kick Apodo` work.

## 3b. Progression, coins and the store

**XP and ranks.** XP comes from playing, not only winning, so a bad run still
climbs slowly. Goal 20, assist 12, win 40, loss 10, clean sheet 25. Ranks run
Novato → Amateur → Semipro → Profesional → Crack → Estrella → Ídolo → Leyenda,
with widening thresholds so the top stays rare. Rank-ups are announced in chat.

**Coins.** Named by `COIN_NAME` in `.env`. Goal 10, assist 6, win 25, clean
sheet 15, and 5 just for finishing a match, so lurkers still earn something.

**Store.** Sells goal celebrations: when you score, your avatar flashes the
emoji you bought for four seconds. Eight items from 80 to 750 coins. Buy with
`!comprar fuego`, equip with `!celebracion fuego`.

**Goal celebration.** Independent of the store, and everyone gets it: the
scorer's disc swells to three times its size for four seconds, and the
assister's to about twice. Tunable with `CELEBRATION_SCORER_SCALE`,
`CELEBRATION_ASSIST_SCALE` and `CELEBRATION_MS`.

Sizes are always restored, on a timer and again whenever a game starts or
stops, so a match can never begin with somebody still inflated. A second goal
mid-celebration measures from the stored original rather than the swollen
radius, or three-times-three would leave a permanently oversized disc behind.

**Who gets the assist.** The pass before the goal counts, unless an opponent
touched the ball in between. A defender miscontrolling it straight to a striker
is not an assist for whoever on the striker's team last had it: the ball
changed hands, so nobody set that goal up. A player who dribbles it in alone
gets no assist either. The rule lives in `src/modules/goalcredit.js` as a pure
function, with the cases spelled out in `test/goals.js`.

**Betting.** When a match starts, betting opens for `BET_WINDOW_SECONDS`
(default 45). One bet per player per match, `!apostar 50 rojo`. Winners get
double, draws are refunded, and leaving the room forfeits the stake.

To tune any of the payouts, edit `REWARDS` in `src/modules/economy.js` and `XP`
in `src/modules/ranks.js`. Both are plain objects at the top of the file.

## 3c. The BOT player

`BOT_NAME` in `.env` (default `BOT`) puts a player named BOT in the spectator
list, the way most established rooms do. It is cosmetic: it holds admin, sits
in spectators, and never plays. Set `BOT_NAME=` empty to run without it.

Everything else works identically either way. The bot is excluded from the
queue, from team selection, from the player count that picks the mode, from
stats, and from AFK checks — `src/util/host.js` is the single place that
decides what counts as the host, and `test/rotation.js` verifies that a room
with the bot present behaves exactly like one without it.

One wrinkle worth knowing if you edit the code: in Haxball callbacks, "the
room itself did this" is `byPlayer === null` without a bot player and
`byPlayer.id === 0` with one. Use `isHostAction(byPlayer)` rather than
checking for null, or the protection below will start firing on the bot's own
actions.

## 3d. Room protection (important)

**Admin commands check the staff list, not the engine's admin flag.** These are
different things, and conflating them was the biggest hole in the bot. Haxball
hands admin to a player *automatically* when the room has no admin left, and it
arrives looking exactly like the room did it — the guard used to wave that
through, so a stranger could end up holding admin with `player.admin === true`,
which is all any destructive command checked. Mass kicks, mass bans, unlimited
`!regalar` to themselves.

Now: anyone outside the staff list who ends up with admin has it removed
however they got it, including "the room did it", and the command gate asks
`guard.isStaff()`. There is also a sweep on every game stop, in case a
promotion event is ever missed.

**Nobody gets admin unless you say so.** Two ways in:

- `ADMIN_AUTHS` in `.env` — a comma-separated list of Haxball auth hashes.
  Anyone on that list gets admin automatically the moment they join. Type
  `!auth` in the room to see your own hash, then paste it in.
- `!claim <password>` — grants admin for that session only.

Anyone else who somehow ends up with admin has it removed on sight.

On top of that, the bot reverts tampering:

| A player tries to | What happens |
|---|---|
| Give someone else admin | Reverted, and the promoter loses admin |
| Change the map | Game stopped, our map re-applied |
| Unlock the teams | Re-locked immediately |
| Change the kick rate limit | Restored |
| Change score or time limit | Re-applied when the next game ends |
| Get admin from the engine itself | Removed, like any other stranger |

**Bans and mutes are filed by identity, not by session id.** Player ids restart
from 1 every time the room restarts, and the room restarts often because tokens
expire. Keying bans on the id meant today's ban of `#3` silently overwrote the
record of whoever was `#3` last week — deleting their auth from the file and
letting them walk straight back in. That is almost certainly why banned people
kept reappearing. Mutes had it worse: they lived on the session record, so a
mute lasted exactly as long as it took the muted player to press Escape and
click the link again, and `!muteados` then reported nobody muted.

Both are now keyed on the player's auth hash (or connection, if they have no
auth), written to disk immediately rather than two seconds later, and re-applied
when the player rejoins. `!unban` takes the number from `!bans`, or a name.

That last row is a workaround, not a fix: Haxball has no event and no getter
for score and time limits, so there is no way to catch the change as it
happens. Re-applying on `onGameStop` is the best available defence, which is
why keeping admin locked down matters more than the reverts.

In every Haxball callback, `byPlayer === null` means the host did it. That
single fact is what separates "the bot rearranged the teams" from "a player is
messing with the room", and it is why all of this works.

## 3e. Kits and chat

**Kits.** Every match opens with two random kits, except that **the winners keep
the shirt they won in**, so a team on a run stays recognisable even after a
scramble puts them at the other end of the pitch. Only the side facing them gets
a new one, and it is checked against the kept shirt so the two never clash. The two are checked against each other in RGB space and dealt
again if they are too close, because a white Madrid against a white River is
unplayable; the plain red-and-blue `clasico` is excluded from the draw so a
random deal never looks like the feature failed.

`!kit` lists them, `!kit madrid` applies one to your team. Only your team's
captain can change it — that is the first player on the side, which after a win
is whoever has been there longest. Admins can always override. A captain's
choice lasts until the next kickoff, when fresh kits are dealt. 26 kits: clubs,
national sides, and a few fun ones. Add your own in `src/modules/kits.js`.

**Chat flood protection.** One rule, because the first version was far too
aggressive — it policed *speed*, so two friends talking quickly looked exactly
like a flood. It now only polices *repetition*, which is the thing that is
actually antisocial:

| Rule | Default | Setting |
|---|---|---|
| Same line repeated this many times | 3 | `SPAM_REPEAT_LIMIT` |
| Then the next one is swallowed and they sit out | 5s | `SPAM_COOLDOWN_MS` |
| Repeats only count within this window | 30s | `SPAM_REPEAT_WINDOW_MS` |

Different messages are never blocked, however fast you type. Nobody gets muted.
Staff are exempt. Warnings are themselves rate-limited — a flood of "stop
flooding" is still a flood.

**Captain substitutions.** A captain can stop the clock once per match to
change one of their own players:

```
!pausa            freezes the match, opens a 15 second window (PAUSE_SECONDS)
!banquear #id     names the player coming off, must be on their own team
<number>          names the player coming on, from the numbered queue
```

**A captain who goes quiet hands over.** If the pick times out, or the captain
leaves, the next player in line becomes captain and the pick carries on. The bot
used to remove them and then deal the teams out itself, which ignored everyone
still queued up waiting for exactly that turn.

The captain of a side is whoever has been on it longest. Admins can pause too,
and may bench from either team. The window closes by itself so a captain who
wanders off mid-thought cannot hold the match hostage, and it is one pause per
team per match so a losing side cannot stall forever. The AFK sweep is
suspended while paused, since nobody can move.

**AFK.** Twenty seconds without *moving* during a match and you are **kicked
out of the room**, with a private warning at twelve (`AFK_SECONDS`,
`AFK_WARN_SECONDS`). You can rejoin from the same link immediately. The
training pitch is exempt: practising alone holds nobody up.

**Idleness is measured from the player's disc, not from key events.** This is
the important part. Haxball's `onPlayerActivity` fires on a key *press*, not
while a key is held — so a player sprinting after the ball for twenty seconds
generated no events at all and got kicked mid-run, and so did anyone holding
position in defence. It was kicking people who were playing, including the
owner. The sweep now samples each player's position once a second and treats
movement as the signal; key presses, chat and ball touches still count on top.

A player is never judged on a single sample, and the clock is reset at kickoff
and whenever a pause ends, because in both cases nobody has had a chance to
move yet.

Kicking rather than parking people in spectators is deliberate, and it fixed
the worst bug the room has had. Parked players stayed in the room flagged
unavailable, and nothing cleared that flag except them typing `!afk` — which
somebody who has walked away by definition does not do. Over a session the room
filled with players who were present but did not count: eight people in the
room, five that the bot could see. It stopped scrambling at full strength,
started asking for captain picks instead, and eventually collapsed onto the
small pitch with half the room stranded in spectators. Kicking keeps "who is
here" and "who can play" the same thing.

`!afk` typed voluntarily still just parks you in spectators. Choosing to sit
out is different from wandering off, and `!afk` again brings you back.

Two things that made this catastrophic before, both fixed. A paused game still
reports as running, so the sweep kept counting against a pitch where nobody can
move: fifteen seconds after any `!pausa`, or any admin pressing pause in the
client, every player was flagged AFK at once and the match was gone. The clock
is now forgiven when play resumes, and the bot listens for the client's own
pause button as well as its own. And an AFK player is treated as gone
*immediately* rather than a tick later, because the team move is queued — one
person typing `!afk` used to tear down a live 4v4 and reset the score. Typing and moving keep the countdown alive but do not clear the flag:
with a timeout this short, a stray key press from someone who has walked away
would drop them straight back onto the pitch and stall the match again.

Spectators are never swept, and the sweep only runs during a match. Both of
those exist because of a real deadlock, documented further down.

**Rank in chat.** Every line a player sends is relayed by the bot rather than
echoed by Haxball, prefixed with their rank and painted in that rank's colour:

```
[🥚 Novato] zico: vamos
[⭐ Estrella] Ram.: que robo
```

Rank used to appear only in `!me`, which made the whole progression system
invisible. The eight colours run cool to warm up the ladder and every one of
them clears 4.5:1 contrast against Haxball's chat background, which
`test/chat.js` checks rather than trusting my eye.

**Chat colours.** Nothing uses grey; it is hard to read on Haxball's dark
background. Main lines are white and bold, secondary lines are small and plain
but still white. Errors red, highlights yellow. The palette is one small file:
`src/util/chat.js`.

## 4. How the match flow works

### The room resizes itself

| Available players | Mode | Map |
|---|---|---|
| 1 | training | `training.hbs` (shooting practice) |
| 2–3 | 1v1 | `futsal1v1.hbs` (small pitch) |
| 4–5 | 2v2 | `futsal1v1.hbs` (small pitch) |
| 6–7 | 3v3 | `futsal4v4.hbs` (big pitch) |
| 8+ | 4v4 | `futsal4v4.hbs` (big pitch) |

"Available" means in the room and not AFK.

**One player alone gets the training pitch** rather than staring at an empty
field. The moment a second person turns up it switches to a real 1v1, and when
everyone else leaves it drops back to training.

**1v1 and 2v2 deliberately share the small pitch.** Haxball cannot swap the
stadium while a game is running, so any size change that crosses a map boundary
has to wait for the match to end. Putting 2v2 on the small pitch means a live
1v1 can grow into a 2v2 mid-match with nobody interrupted — the two newcomers
are simply placed, one per side, and play continues.

### Growing mid-match

While a match is running, the bot adds players **in pairs** so the sides never
go uneven. One extra person waits until a second arrives. The upgrade happens
silently apart from a chat line, with no reset and no stoppage:

- 1v1 → 2v2: seamless (same map)
- 3v3 → 4v4: seamless (same map)
- 2v2 → 3v3: **crosses a map boundary** — see below

If someone leaves mid-match, their seat is filled from the front of the queue.
If nobody is waiting, the match plays on and the room says so.

**When nobody is spare, everyone plays again.** Winner-stays only means
something if there is a queue to challenge them. With exactly enough players
for the mode and nobody waiting:

- **1v1** — the same two swap ends, so neither defends the same goal all night
- **2v2, 3v3, 4v4** — the teams are redrawn at random; if the shuffle happens
  to deal the identical teams, they at least change ends

With spare players it works the old way: the winners hold the pitch and the
queue comes for them, with the first in line captaining and picking teammates
by number. There is no captain pick in a 1v1 — nothing to pick.

**`!ceder` gives your seat away.** The owner is always in the room, so they end
up occupying a place a regular could have had. Typing `!ceder` marks you as a
volunteer: you are the first person benched when the sides need evening up, and
when somebody walks in and there is no free seat, they take yours and you go to
the front of the queue. The match never stops for either. `!ceder` again turns
it off.

**A short-handed match is evened up, not torn down.** When somebody walks out
of a 3v3 the bot first tries to bring a substitute on from the queue. If nobody
is waiting, it takes a player off the bigger side instead, chosen at random, and
puts them at the front of the queue. The match becomes a 2v2 and never stops.

The pitch may end up bigger than the mode strictly calls for — a 2v2 left on
the 4v4 field — and that is the right trade: the alternative is swapping the
stadium, and that means stopping the game.

**Where everyone spawns.** These maps ship with `spawnDistance: 366.5`, a
number inherited from a big-pitch template. On the 4v4 pitch (goal line at 708)
that is a sensible halfway position. On the 1v1 pitch (goal line at 408) it is
90% of the way to your own net, so both players start pinned to their own goal
with the whole pitch behind the ball.

The loader rewrites it to 45% of the distance to the goal, per map, computed
from the stadium's own geometry. Mid-match arrivals get placed at the same
spot, so somebody joining a live game lines up with the people who kicked off
instead of appearing behind the net. Both numbers come from `spawnPoint` /
`SPAWN_RATIO` in `src/modules/modes.js`; the `.hbs` files are left exactly as
their authors published them, so replacing a map picks this up automatically.

The subtlety that made the first attempt at this do nothing at all: a player
has no disc until their team change has actually landed, and team changes are
queued. `setPlayerDiscProperties` on a player with no disc is a silent no-op —
no error, no effect. So the placement waits for the disc to appear before
moving it (`SPAWN_RETRY_MS`, default 120ms per attempt, giving up after 16).

### The one interruption

With two pitches there is exactly one boundary that cannot be crossed
seamlessly, because Haxball refuses to swap stadiums mid-game. Here that is
2v2 → 3v3.

Rather than leaving people in spectators for the rest of a match, the bot stops
the game, swaps the pitch, and restarts immediately — same players, same sides,
plus the newcomers. A couple of seconds of dead time instead of minutes of
waiting.

Two safeguards: it only interrupts if there are actually enough people to fill
the bigger mode, and there is a cooldown (`MODE_SWITCH_COOLDOWN_MS`, default
20s) so one person joining and leaving repeatedly cannot restart the match over
and over.

Set `INSTANT_MODE_SWITCH=0` to go back to waiting for the match to end.

If you would rather have no interruptions at all, the answer is one map for
every mode — edit `src/modules/modes.js` so all four point at the same `.hbs`.
The trade-off is a 1v1 on a pitch built for eight.

### AFK

Auto-AFK only applies **while a match is running**. A player waiting alone for
an opponent is not holding anyone up, and marking them away used to deadlock
the room: one available player meant no match, no match meant nobody pressed a
key, and nobody pressing a key meant nobody ever came back. The room would sit
there with one player on red and one in spectators, forever.

Anything you type in chat counts as being present and puts you straight back in
the queue. Haxball's activity events only fire on movement keys, which a
spectator has no reason to press — so chat is the way back. `!afk` is the one
exception, since that is how you deliberately step away.

When the room can't start, it now says why, including how many people are AFK.

### Between matches

There is a pause before the next match starts (`LOBBY_PAUSE_MS`, default 6s),
announced in chat. Snapping straight into the next game gives nobody a moment
to read the result or get their hands back on the keys, which is especially
jarring in 1v1s since those end fast.

Winner stays. Losers go to the back of the queue. Then:

- **Exactly enough people waiting** → the bot fills the challenging side
  automatically and starts.
- **More people waiting than seats** → captain picks (below).
- **Not enough** → whoever is available comes on; the bot waits if it can't
  make a match at all.

### Captain picks

The player at the front of the queue becomes captain of the challenging side.
The bot posts a numbered list of everyone waiting, and **the captain picks by
typing the number** — just `3`, or `!elegir 3` if they prefer. After each pick
the list is reprinted with fresh numbers.

Nobody else can pick. The match does not start until the side is full.

A captain who stalls is holding up the whole room, so there is a timer
(`PICK_SECONDS`, default 30 per pick). If it runs out, the captain is **kicked
from the room** and the next player in line takes over as captain.

Picking never happens in 1v1 — there is only one seat and no choice to make.

Players can check the state any time with `!modo` and `!fila`. Admins can pin
a mode with `!fijarmodo 3v3` and release it with `!fijarmodo auto`.

Teams are locked, so nobody can move themselves. The mode table is one file:
`src/modules/modes.js`.

### Staying alive

The room outlives its own errors, but it cannot be *recreated* without a human
fetching a fresh token from a captcha page. So an uncaught exception is not just
a crash, it is a manual intervention: the process dies, pm2 restarts it, the
stale token in `.env` is rejected, and it exits again in a loop until somebody
SSHes in. Three things guard against that:

- Every Haxball callback is wrapped. The library does not guard its own
  dispatch sites, and depending on whether an action was applied inline or on
  the tick, a throw either disconnects a random player with no explanation or
  kills the process.
- Every recurring timer is wrapped, the AFK sweep especially: it runs once a
  second forever and is not a leaf — through `teams.onPlayerLeave` it reaches
  team rebuilding, map swapping and `stopGame`.
- `uncaughtException` and `unhandledRejection` are logged rather than fatal.

**The heartbeat now proves something.** `getPlayerList()` reads a local array
and never touches the network, so the old "alive — 0 player(s)" line kept
printing happily long after the room had dropped off Haxball (the reported
`connection closed (4001)` after a couple of days). When the room has been empty
*and* completely silent for 20 minutes, the bot asks Haxball's own room list
whether it still exists, and if it does not, says so unmistakably and exits so
pm2 marks it errored. Same for the no-room-link watchdog, which used to log once
and then sit there looking healthy forever.

### The reconcile loop

Every "start a match" and "grow the match" action is hooked to an event — a
join, a leave, a return from AFK. That is fine until one path is missed or
fires in an unexpected order, and then the room sits there doing nothing while
players stare at it. That happened repeatedly.

So there is also a timer (`RECONCILE_MS`, default 4s) that ignores events and
just looks at the room:

- anyone in spectators who is not in the queue gets adopted into it
- if a match is running: fill gaps, grow if the numbers allow
- if no match is running and one is possible: build it
- if the line-up is already right and nothing is running: just start it

It is deliberately boring and idempotent. The worst case for any missed event
is now a few seconds of delay rather than a dead room.

One player is enough to trigger all of this. It used to require two, which
meant the solo training case had no safety net at all: if that session failed
to start for any reason, the only person in the room watched an empty pitch
until somebody else turned up. That was a real, reported bug.

Belt and braces on top: every applied line-up is re-checked a moment later
(`CONFIRM_DELAY_MS`, default 400ms). If the room does not look like the plan,
the plan is applied again; if the match was supposed to be running and is not,
it gets started. Nothing in the Haxball API reports failure, so the only
reliable way to know a write took effect is to look.

### If you edit `teams.js`, read this first

`room.setPlayerTeam()` does **not** update `room.getPlayerList()` immediately.
The move is queued and shows up a tick later. So this is a trap:

```js
room.setPlayerTeam(id, TEAM.RED);
if (teamOf(TEAM.RED).length === 0) ...   // still 0 — the move hasn't landed
```

This cost us several rounds of debugging: the bot would correctly shuffle
people onto teams and then announce "not enough players", because the decision
to start was made against a snapshot taken before its own writes applied.

The rule is **plan first, apply once, never read back**. Every function in
`teams.js` builds the whole red/blue line-up in memory, calls `applyPlan()`,
and decides from the plan. The test fakes deliberately defer `setPlayerTeam`
by a tick so that any code which reads back after writing fails the suite.

`setPlayerTeam` is not the only queued call, and the others bite harder because
they fail *silently*:

| Call | The trap |
|---|---|
| `stopGame()` | Queued. For the rest of the tick the engine still thinks a game is running, so `setCustomStadium()` **throws** and `startGame()` is **ignored**. Stop, then finish the job on a later tick. |
| `startGame()` | Ignored outright if a game is already running. No error. |
| `setCustomStadium()` | Throws if a game is in progress. |
| `setPlayerDiscProperties()` | Silent no-op if the player has no disc — which is the case until their team change lands, and whenever no game is running. |

The test fakes model all four. A fake that cheerfully accepts a stadium swap
mid-game, or records a disc move for a player who has no disc, will happily
pass code that does nothing in production — which is exactly what happened with
the first version of the spawn fix.

### Tests wait for the bot, not for the clock

Because every write lands a tick later and rebuilds run on timers, it is
tempting to write `await sleep(150)` and assert. That produced a flaky
assertion in three releases running, and each one cost a deploy while we worked
out whether it was a real race or just a busy machine.

`w.quiet()` instead waits until `teams.busy` is false — no rebuild pending, no
line-up waiting to be confirmed — and stays false across two ticks, with a 4
second ceiling. It is faster than sleeping and it cannot pass by luck. If the
bot never goes quiet, the helper logs `debugState()` next to the failing
assertion, because that is a genuine bug rather than a slow test.

Fixed sleeps remain in exactly one situation: asserting that something did
*not* happen. There you have to give the bad thing time to occur.

Stats live in `data/stats.json`, keyed on the player's Haxball auth, so they
survive restarts and nickname changes.

## 5. Swapping the maps

Drop any `.hbs` file into `maps/` and point the relevant mode at it in
`src/modules/modes.js`. Each mode names its own map, so you can give 1v1,
2v2 and 4v4 completely different pitches if you want.

## 5b. Room not showing in the room list?

With the room running, in a second terminal:

```bash
npm run listcheck
```

This asks Haxball's own room-list endpoint — the same one the game client uses —
for every public room and tells you whether yours is in it. It bypasses the
browser and any room-list add-ons completely.

- **"NOT IN THE PUBLIC LIST"** — Haxball isn't publishing the room. Almost always
  the per-IP limit on *listed* rooms: two rooms per IP, and on a shared or CGNAT
  address strangers can be holding both slots. Test from another network.
- **"FOUND IT"** — the room is published and it's a sorting problem. Check the
  `country` and `lat`/`lon` it prints. Blank country or `0,0` puts the room at the
  bottom of everyone's list; fix it with `GEO_CODE` / `GEO_LAT` / `GEO_LON`.

Worth knowing: listing travels over the same WebSocket as join signalling, so if
players can join by link, the announce reached Haxball. Anything that goes wrong
after that is on their side, not yours. Propagation is about 10 seconds — if the
room isn't listed within 30, it won't be.

## 6. Testing without going live

```bash
npm test
```

Three suites, all against a fake Haxball API, no token and no connection needed:

- `test/smoke.js` — commands, goals, coins, ranks, store, betting, moderation, room protection
- `test/rotation.js` — mode switching, map swaps, live growth, winner-stays, queue order, captain picks
- `test/afk.js` — the AFK rules, including the deadlock they exist to prevent

Run this after any change, before you restart the live room.

## 7. Moving to the VPS later

Nothing in the code changes. On the server:

```bash
sudo apt update && sudo apt install -y nodejs npm
npm install -g pm2
cd futsala-room && npm install
# put a fresh token in .env, then:
pm2 start index.js --name futsal4v4
pm2 logs futsal4v4          # room link appears here
pm2 save && pm2 startup     # survive reboots
```

Practical notes:

- **Location matters more than specs.** The headless host relays every packet
  between players, so the room's ping is dominated by the distance from the host
  to the players. For a Mexico-facing room, a box in Dallas or Miami beats a
  cheap one in Frankfurt every time.
- **Specs are tiny.** This setup is pure Node with no browser, so one room sits at
  roughly 60–100 MB of RAM. A 1 vCPU / 1 GB VPS runs several rooms. Prefer good
  network over more cores.
- **Haxball allows 2 rooms per IP.** Past that you need extra IPs or a proxy.
- **The token is still manual on restart.** Plan for it: restart during a quiet
  hour, keep the tab open, and use `pm2` so crashes restart the *process* without
  needing a new room.

## 8. Why this stack

| Option | Notes |
|---|---|
| **haxball.js** (used here) | Pure Node, no browser. Lightest and simplest. Best fit for a single custom room. |
| Puppeteer + headless Chrome | The classic approach. Works, but 300–500 MB per room and more moving parts. |
| haxroomie | Puppeteer-based, adds a plugin system (HHM) and a CLI. Good if you want to reuse community plugins. |
| haxball-server | Manages many rooms, adds Discord bot control and proxy support to get past the 2-rooms-per-IP limit. Worth revisiting when you run several rooms. |
| node-haxball | Very low level, exposes everything including client-side. Overkill unless you need custom protocol work. |

## 9. Map credit

The map is **AF Official 4v4 by Vitão ®**, distributed via HaxballPlanet. If the
room ever becomes commercial, credit the author in the room and check with them first.
