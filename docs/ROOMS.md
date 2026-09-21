# Rooms: protocol contract (server/game.js <-> web/main.js)

One fly.io process hosts many 2-player matches. A match is a **room**. Everything that is one game today (players, ball,
score, bot, serve state, ball history) becomes per-room state; the 60 Hz loop steps every room. Message shapes inside a
room (`welcome`, `state`, `hit`, `swing`, `paddle`, `ping`, `net`, ...) do not change.

## Connecting
`wss://host/?cid=<tab id>&lobby=1[&room=CODE]`

- **No `lobby=1`** (every existing test, `?skiptitle=1`, old clients): legacy. The socket is seated at once in the
  always-present room `LOCAL`, exactly as today. `LOCAL` is never listed and never deleted.
- **`lobby=1`**: the socket starts in the lobby, in no room. If `room=CODE` is also given the server treats it as an
  immediate `join` (this is how a reconnect gets its seat back, and how a shared link works).

## Lobby messages
server -> client
- `{ type:'lobby', rooms:[{ code, players, open, watch, watchers, score, live }], online }` on entering the lobby, then whenever
  the list changes (at most once a second). Every **public** room with at least one human in it is listed: `open` = a seat is
  free (joinable), otherwise it can be watched (docs/SPECTATE.md). An empty room is not listed (nobody is coming to it), but
  `quick` still reuses it and its code still joins. `online` = sockets connected in total.
- `{ type:'room', code, public }` you are now seated in this room. The normal `welcome` follows immediately.
- `{ type:'joinfail', reason }` with reason `'notfound' | 'full' | 'busy'` (`busy`: the server is at its room cap).
  The socket stays in the lobby.

client -> server (only valid in the lobby, ignored otherwise, except `leave`)
- `{ type:'quick' }` seat me in the public room that has waited longest for a second human; if none, create a public one.
- `{ type:'create', public: boolean }` new room, seat me.
- `{ type:'join', code }` code is case-insensitive, surrounding spaces ignored.
- `{ type:'leave' }` (valid in a room) back to the lobby; the server sends a fresh `lobby`.

## Rooms
- `code`: 4 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no I, L, O, 0, 1), unique among live rooms.
- 2 human seats. A third joiner gets `joinfail full`. The bot rules inside a room are unchanged: alone for 2.5 s and the
  bot joins, a second human replaces it, `B` / `1 2 3` still work.
- A room with no human for 30 s is deleted. Cap: 40 rooms (`busy` beyond that).
- Reconnect: a socket arriving with the `cid` of a player still seated in that room takes that seat over (today's
  ghost rule, now per room). A `cid` seated in a *different* room is removed from the old one first.
- The serve waits for a human who has not sent a `paddle` message yet (a client sends none until it is calibrated), so
  no point is played against someone who cannot see the court. While that lasts their entry in `state.paddles` carries
  `wait: true`. Additive: nothing else in `state` changes. (Off with `AUTOBOT=0`, where scripted clients may never
  send one.)
- Input is untrusted: `code` must be a string, `ping.c` is echoed only if it is a number, messages over 4 KB close the socket.
  A socket is heard 200 times a second (the rest is dropped unread; past 1000 it is closed), a socket with 256 KB unread is closed, and one address
  (`fly-client-ip`, never this machine's own) may have 4 rooms of its making standing at once: `busy` beyond that.
- When the other human leaves BEFORE a ball is struck, the one who stays gets `{ type:'left' }`, then the bot comes back as it
  does today. Mid-match it is a seat hold or a forfeit: docs/SPECTATE.md.

## Client flow
title (Play) -> lobby (Quick play / Create room / Enter code, plus the public room list) -> connect gear -> calibrate
-> play. The game socket is opened with `lobby=1` when the page loads; nothing is seated until the player chooses.
`?court=CODE` in the page URL joins straight away after Play (shareable link; `?room=CODE` is the old spelling and still
works; players read "court" everywhere, the wire protocol keeps `room`). `?skiptitle=1` keeps today's legacy path
(no lobby, room `LOCAL`), which is what `test/e2e.mjs` plays its match on; its title check walks title -> lobby ->
Quick play -> connect. In a room, the code is shown on the HUD so it can be read out.
