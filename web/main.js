// Glue: AirPod bridge -> MotionModel -> scene + game server.
import { MotionModel, qrot } from './motion.js';
import { createScene, shownN } from './scene.js';
import { createPodView } from './podview.js';
import { createBodyTracker } from './bodytrack.js';
import * as ui from './ui.js';                  // every HUD / screen DOM change goes through here
import * as profile from './profile.js';        // player stats (docs/ACCOUNTS.md 9): the device id, the hello, /api, sign-in. Its DOM is its own

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const HOST = qs.get('host') || location.hash.slice(1) || 'localhost';      // player 2:  /#<server-ip>
const BRIDGE = `ws://localhost:${qs.get('bridge') || 8787}`;
const HOSTED = HOST === 'localhost' && !['localhost', '127.0.0.1', ''].includes(location.hostname);      // page came from the game server itself (fly.io)
const GAME = HOSTED ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}` : `ws://${HOST}:${qs.get('game') || 8080}`;
const AUTOBOT = qs.get('autobot') === '1';
const LOBBY = qs.get('skiptitle') !== '1';                       // ?skiptitle=1 is the legacy path: no lobby, the server seats the socket in room LOCAL at once (docs/ROOMS.md)
// One id per tab, kept across reloads and reconnects: the server gives a returning tab its seat back instead of seating
// it against its own half-dead socket (bad wifi drops connections without telling the server).
let CID = ''; try { CID = sessionStorage.getItem('cid') || ''; if (!CID) sessionStorage.setItem('cid', CID = Math.random().toString(36).slice(2, 12)); } catch { CID = Math.random().toString(36).slice(2, 12); }
// The code a phone uses to be this tab's paddle (NOTES 34). Made here, shown as a QR on the set-up screen, named on the game
// socket; the server only matches the two. Kept per tab like the cid, so a reload or a server restart pairs up again by itself.
const PAD_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let PAD = ''; try { PAD = sessionStorage.getItem('pad') || ''; } catch { /* private window */ }
const newPad = () => { PAD = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => PAD_ABC[b % 32]).join(''); try { sessionStorage.setItem('pad', PAD); } catch { /* same */ } };
if (!/^[A-HJ-NP-Z2-9]{4}$/.test(PAD)) newPad();      // 4 characters, shown as P-XXXX so everyone knows it is the paddle's code (NOTES 81). The URL carries the 4 alone

const model = new MotionModel();
const scene = createScene($('stage'));
const pod = createPodView($('pod'));
ui.setServerAddress(GAME);
// A phone can be the paddle wherever the page is served securely (its sensors need https, and it cannot open 'localhost'), so
// the hosted game needs no helper and no Mac. ?padtest=1 lets the tests pair a fake phone on localhost.
const CAN_PHONE = HOSTED && location.protocol === 'https:' || qs.get('padtest') === '1';
const PHONE_SIZED = navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 600;
if (CAN_PHONE && PHONE_SIZED) { $('title-note').textContent = 'Open poddleball.com on a computer to play. This phone becomes your paddle.'; $('title-note').classList.add('is-loud'); }      // the phone is the paddle, not the screen
else if (!CAN_PHONE && (!/Mac/.test(navigator.platform) || navigator.maxTouchPoints > 1)) { $('title-note').textContent = 'To play, open poddleball.com on a computer, with your phone as the paddle. Here you can watch a match.'; $('title-note').classList.add('is-loud'); }      // no phone paddles here (a local copy), and no helper can run on Windows, a phone, an iPad
if (HOSTED) { $('down-lan').hidden = true; $('down-net').hidden = false; }      // online, 'start the server on this Mac' is no help: it is the player's own connection
const stats = window.__stats = { get phase() { return phase; }, get role() { return role; }, get room() { return room; }, get tour() { return tour ? { code: tour.code, phase: tour.phase, kind: tourKind, n: (tour.players || []).length, host: !!(tour.you && tour.you.host), out: !!(tour.you && tour.you.out), champ: tour.champ ? tour.champ.name : null } : null; }, get cam() { return body ? { ready: body.ready, error: body.error, errorName: body.errorName, seen: body.seen(), fps: Math.round(body.fps), via: body.via } : null; }, get camView() { return phase === 'camera' ? camView : ''; }, hits: 0, myHits: 0, whiffs: 0, swings: 0, errors: 0, paddlePath: 0, calibrated: false, events: {} };

let regs = [false, false];                     // a registered username in that seat (docs/ACCOUNTS.md 7.5): the badge beside the name, never text
let side = 0, role = 'player', names = [null, null], state = null, players = 0, calibrating = true;      // role: 'player' | 'spectator' (docs/SPECTATE.md). names: the server's truth, null = empty seat
// Flow: title -> lobby (pick a room) -> connect (only while there is no AirPod data) -> calibrate -> play. ?skiptitle=1 starts at connect.
let phase = 'title', lastSample = -1e9, gameEver = false;
let room = null, wantRoom = LOBBY ? ui.cleanCode(qs.get('court') || qs.get('room')) : '', wantWatch = LOBBY && qs.get('watch') === '1', pending = null, leaveAt = 0;   // room: the court I am seated in (the wire still says 'room'). wantRoom / wantWatch: from a shared link ?court=CODE (?room= is the old spelling and still works) or a reload. pending: the lobby request still waiting for its answer
let botWant = null, botLevel = '', holding = false, frozen = false, pausedUi = false, watchers = 0, over = null, overAt = 0, votedNo = false, votedYes = false, lastOpp = '';   // botWant: 'Play a bot' level, sent after the welcome. over: a matchover nobody has seen yet
const link = { m: false, g: false }, airpodLive = () => performance.now() - lastSample < 1000;
const inPlay = () => phase === 'play' && !ui.currentScreen() && !ui.currentOverlay();      // the court is what the player is looking at
// The two gates of docs/API-NEXT.md 4.2. seated: nothing from the game gets past the lobby messages while no room is joined
// (an old server seats a lobby socket by itself, and its bot then beat the idle seat behind the menu). live: what is seen
// or heard over the court (toasts, banners, the result, the hold card) waits until the court is what is on screen.
const seated = () => !LOBBY || !!room, live = () => phase === 'play' || phase === 'watch', spec = () => role === 'spectator';
if (qs.get('uitest') === '1') { window.__ui = ui; window.__scene = scene; }      // test hooks: test/e2e.mjs forces UI states for screenshots, test/menu.mjs reads the scene's mode
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: nothing is kept */ } } };
const BADGE_OUT = /[\u221a\u2122\u2610-\u2612\u2705\u2713\u2714\u{1f5f8}\u{1f5f9}\u{1f197}][\ufe0e\ufe0f]?/gu;      // text imitations of the registered badge (docs/ACCOUNTS.md 7.3): √ ™ ☐☑☒ ✅ ✓ ✔ 🗸 🗹 🆗 and a selector after one. The badge itself is an element
const cleanName = t => { const n = [...String(t == null ? '' : t).replace(BADGE_OUT, '').replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2028-\u202e\u2800\u3164\uffa0\ufff9-\ufffb\u{e0000}-\u{e0fff}<>]/gu, '').replace(/(\p{M}{2})\p{M}+/gu, '$1').replace(/\s+/g, ' ').trim()].slice(0, 12).join('').trim(); return /[\p{L}\p{N}\p{S}\p{P}]/u.test(n) ? n : ''; };      // the server's rule (docs/SPECTATE.md Names); it cleans again anyway
const myName = () => cleanName(ui.playerName()) || cleanName(ls.get('poddle.name'));      // the lobby field; what was kept last time when the field is not there
const nameOf = i => names[i] || (state && state.paddles[i] && state.paddles[i].bot ? 'Matt' : i ? 'Player 2' : 'Player 1');
const prefs = (() => { try { return JSON.parse(ls.get('poddle.settings')) || {}; } catch { return {}; } })();      // { airpod, stats, reach, sound, sink, sinkName }
// body: webcam tracks where you actually stand. auto: server runs you to the ball. (Aim, the wrist's angle moving you, is gone: NOTES 33.)
const MODES = ['body', 'auto'], MODE_TEXT = { body: 'Body: step to move, tilt the AirPod to walk', auto: 'Auto: the game runs, you swing' }, MODE_NAME = { body: 'Body', auto: 'Auto' };
let bodyZ = 6.5, walkV = 0, walkHold = 0, bodyY = 1.0, vX = 0, vY = 0, lastFrame = performance.now();
// critically damped follow (frame-rate independent): smooth, no overshoot
function damp(cur, target, vel, smooth, dt) { const o = 2 / smooth, x = o * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x), ch = cur - target, tmp = (vel + o * ch) * dt; return [target + (ch + tmp) * e, (vel - o * tmp) * e]; }
// ---------- the camera (NOTES 94) ----------
// Never asked for out of nowhere: the first seat shows the primer screen (why, what stays private, what the browser will ask), and
// only its Allow button (a click, so the browser's question follows a gesture) makes the request. The answer is kept under its OWN
// key: savePrefs rebuilds poddle.settings from a fixed list and would drop it. 'allow' | 'skip' (Play without camera: Auto, never asked again).
const CAM_KEY = 'poddle.camPrimer', NO_CAM = qs.get('cam') === '0';
let camPerm = '', permKnown = false;      // the browser's own answer: 'granted' | 'denied' | 'prompt'; '' where it will not say (Firefox and older Safari throw on 'camera')
const permReady = (async () => { try { const st = await Promise.race([navigator.permissions.query({ name: 'camera' }), new Promise((_, no) => setTimeout(no, 800))]); camPerm = st.state; st.onchange = () => { camPerm = st.state; camPermChanged(); }; } catch { /* no answer: the primer asks as if 'prompt' */ } permKnown = true; })();
const UA = navigator.userAgent, IOS = /iPad|iPhone/.test(UA) || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);      // iPadOS says 'MacIntel': it has no System Settings > Privacy or Safari menu bar, its fix is in the Settings app
const CAM_FOR = { browser: /Edg\/|EdgiOS\//.test(UA) ? 'edge' : /Firefox\/|FxiOS\//.test(UA) ? 'firefox' : /Chrome\/|Chromium\/|CriOS\//.test(UA) ? 'chrome' : /Safari\//.test(UA) ? 'safari' : 'chrome', os: IOS ? 'ios' : /Mac/.test(navigator.platform) ? 'mac' : /Win/.test(navigator.platform) ? 'win' : '' };      // whose unblock steps go first on the help
const camKind = t => { const n = t && t.errorName || 'NotAllowedError', m = t && t.error || '';      // why the camera failed -> which help (ui.js CAM_TEXT)
  if (n === 'NoMediaDevices') return 'insecure';
  if (['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(n)) return /system/i.test(m) ? 'system' : /dismiss/i.test(m) ? 'dismissed' : 'blocked';      // Chrome: 'Permission denied by system' = the OS switch; 'Permission dismissed' = the question was closed, not answered (after ~3 of those Chrome blocks it, still saying 'dismissed')
  if (['NotFoundError', 'OverconstrainedError', 'DevicesNotFoundError'].includes(n)) return 'nocam';
  if (['NotReadableError', 'TrackStartError', 'AbortError'].includes(n)) return 'busy';
  return 'other'; };
let mode = MODES.includes(qs.get('move')) ? qs.get('move') : NO_CAM || ls.get(CAM_KEY) === 'skip' ? 'auto' : 'body', body = null, bodyX = 0;      // ?cam=0, or Play without camera: there will be no camera, so not Body
let camOn = false, camGen = 0, camWant = false, camAsked = false, camView = '', camAgain = false;      // camGen: the request that counts (Try again and No start a new one; an older answer is let go). camWant: switch to Body once it is up. camAsked: the player pressed something for it (a failure is worth telling)
function startCam() {                              // the webcam is asked for when a seat is taken, never on the way to watching (docs/SPECTATE.md: spectators get no camera prompt)
  if (camOn || NO_CAM) return; camOn = true; const g = ++camGen;
  createBodyTracker($('camv'), $('camc'), () => { if (g !== camGen) return false; if (phase === 'camera') primerDone(); }).then(t => {      // Allowed: on with the set-up while the models load. false: turned down meanwhile, hand the stream back
    if (g !== camGen) { t.stop(); return; }
    body = t; ui.setCamera(t.ready); if (Number.isFinite(prefs.reach)) t.reach = Math.max(0.08, Math.min(0.42, prefs.reach)); syncSettings();
    loadSinks();                                   // a camera grant does NOT name audio devices (NOTES 64); harmless to retry, the Sound row asks for audio permission itself
    if (!t.ready) { console.warn('camera tracking unavailable:', t.errorName, t.error); t.stop(); if (!t.granted) camOn = false;      // stop(): a stream that came but whose models did not load kept the camera light on for good. Not granted: the next seat (or Try again) may ask again
      camWant = false; if (mode === 'body') setMode('auto', !inPlay()); camTrouble(t); return; }
    if (camWant) { camWant = false; if (mode !== 'body') setMode('body', !inPlay()); }      // turned on after a No: that was to play with it
    if (stats.calibrated) { const c = setInterval(() => { if (t.seen()) { clearInterval(c); t.center(); } }, 100); }      // calibration finished before the camera was up: centre on the first sight of the player instead
  });
}
function stopCam() { camGen++; if (body) { prefs.reach = body.reach; body.stop(); } body = null; camOn = false; ui.setCamera(false); syncSettings(); }      // let go of it, and of any question still open: camOn no longer latches, so the next startCam really asks again
function camRestart() { stopCam(); startCam(); }
function camTrouble(t) {                           // the camera said no. On a set-up screen that earns the help screen; over the court a toast, and only when they asked for it
  if (t.granted) return;                           // it was allowed and the tracking failed to load: nothing the player can fix, the game moves them
  const k = camKind(t);
  if (phase === 'camera' || phase === 'connect') { primer('help', k); return; }
  if (camAsked) say({ nocam: 'No camera found', busy: 'The camera won’t start. Close any app using it, then pick Body again.', insecure: 'This page can’t use a camera', dismissed: 'The camera question was closed. Pick Body again, then Allow.' }[k] || 'The camera is blocked. Allow it for this site, then pick Body again.', null, 3600);
}
// '' = no primer; 'ask'; 'help' (the browser already says no); 'wait' (its answer is not in yet)
function camAsk() { if (NO_CAM) return ''; const c = ls.get(CAM_KEY); if (c === 'skip') return ''; if (!permKnown) return 'wait'; if (camPerm === 'denied') return 'help';
  if (c === 'allow') return ''; if (camPerm === 'granted') { ls.set(CAM_KEY, 'allow'); return ''; } return 'ask'; }      // already allowed for this site: nothing to explain, it just starts
function primer(view, kind) {                      // the primer screen: its own phase, so a paddle that wakes up behind it cannot skip ahead to calibration
  camView = view; if (phase !== 'camera') { phase = 'camera'; screen('camera'); padPhase(); }
  ui.camPrimer({ view, kind, ...CAM_FOR, again: view === 'help' && camAgain }); camAgain = false;
}
function primerDone() { camView = ''; phase = 'connect'; goOn(); }      // answered: the rest of begin()
function camPermChanged() {                        // changed in the browser's site settings while the help is up: take it from there
  if (phase !== 'camera' || camView !== 'help' || camOn) return;
  if (camPerm === 'granted') { ls.set(CAM_KEY, 'allow'); camWant = true; camRestart(); } else if (camPerm === 'prompt') primer('ask');
}
function camTurnOn() { if (NO_CAM) return; ls.set(CAM_KEY, 'allow'); camWant = camAsked = true; camRestart(); }      // Settings -> Body, or the connect screen's Turn on, after a No or a failure
ui.onCamPrimer({
  allow: () => { ls.set(CAM_KEY, 'allow'); camWant = camAsked = true; camRestart(); if (phase === 'camera') primer('wait'); },      // the click IS the gesture the browser's question follows. Even an instant grant answers after this line
  retry: () => { camAgain = true; ui.camPrimer({ view: 'wait' }); camView = 'wait'; ls.set(CAM_KEY, 'allow'); camWant = camAsked = true; camRestart(); },
  skip: () => { ls.set(CAM_KEY, 'skip'); camWant = false; stopCam(); setMode('auto', true); if (phase === 'camera') primerDone(); say('No camera: Auto movement is on. The game runs you to the ball, you swing.', null, 3600); },      // say what replaces it, after primerDone so the toast lands on the next screen      // Auto, kept: never asked again (Settings -> Move -> Body still turns it on)
});
ui.onCamOn(camTurnOn);
function setMode(m, quiet) {                       // chosen in the settings panel (the M key is gone from the court). Every switch starts the mode from rest, in this ONE place: nothing of the last mode's motion is carried in
  if (m !== mode) { vX = vY = walkV = 0; walkHold = 0; bodyZ = 6.5; const mine = state && state.paddles[side]; if (mine) { bodyX = mine.x * s(); bodyY = mine.y; } }
  mode = m; ui.setMode(MODE_NAME[m]); syncSettings(); if (!quiet) say(MODE_TEXT[m], null, 2400);
}
const usingBody = () => mode === 'body' && body && body.ready;
const autoNow = () => mode === 'auto' || (mode === 'body' && !(body && body.seen()));   // lost your face: the game runs for you until it's back
const s = () => (side === 0 ? 1 : -1);

// ---------- messages ----------
const say = (text, _color, ms = 1200) => ui.toast(text, ms);   // small pill toast
let rally = 0, unsettled = null;                  // unsettled: my last swing report, while it is still a bet
// This match's stats for the result card (ui.matchResult o.stats). Memory only: nothing is saved or sent. null = not seen from 0-0 (a reconnect,
// a late spectator, a missed point), and the card shows no stats rather than wrong ones. kind: each side's last shot, counted once with its final kind.
let ms = null;
const msNew = () => ({ sum: 0, rally: 0, smash: [0, 0], run: [0, 0], best: [0, 0], cur: -1, kind: [null, null] });
const msCommit = i => { if (ms && ms.kind[i] === 'smash') ms.smash[i]++; if (ms) ms.kind[i] = null; };      // a shot counts once, with its final kind (a bet's kind can still be re-aimed by 'launch')
const alone = () => ({ them: 'Waiting', themSub: room ? '' : 'B adds a bot', meSub: '' });      // the far side of the scoreboard with nobody on it. In a room the bot walks in by itself
const clearFar = () => { rally = 0; ui.setRally(0); scene.updatePaddle(1 - side, null); if (spec()) scene.updatePaddle(side, null); scene.hideBall(); };      // nobody over there any more: no avatar, no ball, no rally
const cleanNames = a => [0, 1].map(i => Array.isArray(a) && typeof a[i] === 'string' && a[i] ? a[i].replace(BADGE_OUT, '').slice(0, 24) || null : null);      // untrusted text: ui.js writes it with textContent only
const cleanRegs = a => [0, 1].map(i => Array.isArray(a) && a[i] === true);      // only a literal true draws a badge (an old server sends none)
// Who is on the scoreboard. A player reads 'You' on the left and the other seat on the right; a spectator reads side 0 on the
// left (blue) and side 1 on the right (orange), names in both, never 'You'. Matt's second line is his level.
function drawNames() {
  const pd = state ? state.paddles : [], sub = i => !pd[i] ? '' : pd[i].bot ? botLevel : STATUS_WORD[pd[i].status] || (pd[i].wait ? 'Calibrating' : '');      // the same word as the tag over their character (wait: a server from before 'status')
  ui.setBot(!spec() && tourKind !== 'match' && pd[1 - side] && pd[1 - side].bot && botLevel ? botLevel : null);      // the 1 2 3 hint and the Difficulty row: only against Matt, and never in a tournament match (he stays at Tour)
  if (spec()) { ui.setNames({ me: pd[0] || names[0] ? nameOf(0) : 'Waiting', meSub: sub(0), them: pd[1] || names[1] ? nameOf(1) : 'Waiting', themSub: sub(1), reg: [!!pd[0] && regs[0], !!pd[1] && regs[1]] }); return; }
  const o = pd[1 - side];
  if (!o) ui.setNames({ me: 'You', ...alone(), reg: [false, false] });
  else if (o.bot) ui.setNames({ me: 'You', meSub: '', them: nameOf(1 - side), themSub: botLevel, reg: [false, false] });
  else ui.setNames({ me: 'You', meSub: side === 0 ? 'Near side' : 'Far side', them: lastOpp = nameOf(1 - side), themSub: sub(1 - side) || (side === 0 ? 'Far side' : 'Near side'), reg: [false, regs[1 - side]] });      // 'You' is not a name: no badge on it
}
const STATUS_WORD = { calibrating: 'Calibrating', paused: 'Paused', away: 'Reconnecting' };
function setPaused(on) { if (on !== pausedUi) ui.setPaused(pausedUi = on); setDim(); }

// ---------- match end, rematch (docs/SPECTATE.md) ----------
function showOver() {                              // the result card. A matchover that came while a set-up screen was up waits in `over` for the court to open
  const m = over; over = null; if (!m) return;
  const T = m.tour && typeof m.tour === 'object' ? { round: String(m.tour.round || '').slice(0, 24), next: m.tour.next ? String(m.tour.next).slice(0, 24) : null, final: !!m.tour.final, gap: Math.max(0, Math.round((+m.tour.gap || 0) - (performance.now() - overAt) / 1000)) } : null;      // a tournament match: no vote, back to the bracket after gap s
  const L = spec() ? 0 : side, won = m.winner === L, sc = Array.isArray(m.score) ? m.score : [0, 0], vote = LOBBY && m.type === 'matchover' && !T;      // the left slot: me, or side 0 for a spectator. Legacy room / old server: it restarts by itself
  ui.setServe(null); ui.hold(null); ui.settings(false);
  const rg = Array.isArray(m.reg) ? m.reg.map(x => x === true) : [false, false];      // as it was when it ended, like its names
  const W = m.winner === 1 ? 1 : 0, n = (sc[0] | 0) + (sc[1] | 0);
  const mstats = ms && !m.forfeit && ms.sum === n ? (spec() ? { rally: ms.rally, smashes: ms.smash[0] + ms.smash[1], run: ms.best[W] }      // a spectator: both sides' smashes, the winner's best run
    : { rally: ms.rally, smashes: ms.smash[L], run: ms.best[L] }) : null; ms = null;      // every point seen from 0-0, or none at all (showOver runs once per matchover: it takes `over`)
  ui.matchResult({ won, me: sc[L] | 0, them: sc[1 - L] | 0, nameMe: spec() ? nameOf(0) : 'You', nameThem: nameOf(1 - L), forfeit: !!m.forfeit, role, vote, tour: T || undefined, reg: [spec() && rg[0], rg[1 - L]], stats: mstats });
  scene.jingle(spec() ? (m.forfeit ? 'forfeit' : 'watch') : m.forfeit ? (won ? 'forfeit' : 'lose') : won ? 'win' : 'lose');      // the match point's sound: its chime was skipped (scene.js)
  const left = Math.max(0, Math.round((+m.rematchBy || 20) - (performance.now() - overAt) / 1000));      // less what was spent behind a set-up screen
  if (vote) ui.rematch(spec() ? { left } : { mine: null, theirs: null, left, name: nameOf(1 - L) });
  else if (!T) setTimeout(() => { if (ui.currentOverlay() === 'match') ui.showOverlay(null); }, 6000);        // normally the next 'serve' closes it after 5 s. A tournament match: 'closed round' takes us to the bracket
  if (won && !spec()) { ui.confetti(['#3aa0ff', '#ffd34a', '#3ecf72', '#ffffff'], 120); clearTimeout(burstT); burstT = setTimeout(() => { if (ui.currentOverlay() === 'match') ui.confetti(['#3aa0ff', '#ffd34a', '#ffffff'], 80); }, 900); }      // the second burst belongs to the card: a quick 'No rematch' had it falling over the lobby
  if (spec()) ui.confetti(W ? ['#ff8a3d', '#ffd34a', '#ffffff'] : ['#3aa0ff', '#ffd34a', '#ffffff'], 60);      // a spectator: one smaller burst in the winner's colours
}

// ---------- spectator views: keys 1-4 and the chips are one function (docs/API-NEXT.md 2.3, 3.4) ----------
const VIEWS = ['broadcast', 'split', 'pov', 'free'];
function showView() { const v = scene.getView(); if (v && spec()) ui.setView(v.name, v.name === 'pov' ? nameOf(v.side) : ''); }
function setView(name, flip) {                     // flip: asked for by the viewer (Player again = the other player), not by a restore
  if (!spec() || !VIEWS.includes(name)) return;
  const was = scene.getView() || {}, v = scene.setView(name, name === 'pov' && was.name === 'pov' ? (flip ? 1 - was.side : was.side) : 0) || { name, side: 0 };
  ui.setView(v.name, v.name === 'pov' ? nameOf(v.side) : ''); if (VIEWS.includes(v.name)) ls.set('poddle.view', v.name);
}

// ---------- settings panel (docs/API-NEXT.md 3.2): every row is also a silent key ----------
let showPod = prefs.airpod !== false, showBody = prefs.body !== false, showStats = false;      // showBody: your own see-through player model (off = the original ghost forearm alone)      // the stats panel has no switch any more (NOTES 52): off at every load, H still shows it for whoever is tuning
// Sound (NOTES 60). sinkId is a deviceId the browser gave us for THIS origin; sinks is what it is willing to name right now.
let soundOn = prefs.sound !== false, sinkId = typeof prefs.sink === 'string' ? prefs.sink : '', sinks = [], sinkDenied = false;
// sound / sink are left out while they are the default, so a player who never opens the Sound rows keeps the same saved object as before
const savePrefs = () => ls.set('poddle.settings', JSON.stringify({ airpod: showPod, stats: showStats, reach: body ? body.reach : prefs.reach, sound: soundOn ? undefined : false, body: showBody ? undefined : false, sink: sinkId || undefined }));
const reachNow = () => body ? body.reach : Number.isFinite(prefs.reach) ? prefs.reach : 0.3;
const sensOf = () => { const r = reachNow(); return { sens: Math.round((0.42 - r) / 0.03) + 1, sensMin: r > 0.419, sensMax: r < 0.081 }; };      // 1 = least sensitive. Range is Body's: how far you step to reach the sideline
function syncSettings() { ui.setSettings({ ...sensOf(), airpod: showPod, body: showBody, stats: showStats, inRoom: LOBBY && !!room, spectator: spec(), bodyOk: !NO_CAM, bodyNote: NO_CAM || (body ? body.ready : camOn) ? '' : 'Body turns the camera on', tourMatch: tourKind === 'match',      // bodyOk: Body can be picked wherever a camera can be asked for
  sound: soundOn, sink: sinkId, sinks: [{ id: '', label: 'System default' }, ...sinks],
  sinkWhy: !scene.audio.canSwitch() ? 'browser' : sinks.length ? '' : sinkDenied ? 'denied' : 'devices' }); }
function sens(dir, quiet) {                        // ] / + = more sensitive, [ / - = less. The panel shows the number, the keys say it
  if (!body) return;
  body.reach = Math.max(0.08, Math.min(0.42, body.reach - dir * 0.03)); if (!quiet) say(`Range: step ${(body.reach * 100).toFixed(0)}% of the view to reach the sideline`);
  savePrefs(); syncSettings();
}
const show = ui.show;
function setSound(on) { soundOn = !!on; scene.audio.setMute(!soundOn); if (soundOn) unlock(); savePrefs(); syncSettings(); }
function forgetSink(why) { sinkId = ''; scene.audio.setSink(''); savePrefs(); syncSettings(); if (why) say(why, null, 2600); }      // the device went away: back to wherever the system points, and the row must stop naming it
const loadSinks = () => scene.audio.devices().then(ds => { sinks = ds; syncSettings(); });      // empty until the page holds MICROPHONE permission: nothing else makes the browser name an output device
// Asking for it is the ONLY way to get a device list (measured: a camera grant does not do it, NOTES 64). The track is
// stopped the instant the permission lands — we want the permission, never the audio. Nothing is read, recorded or sent.
function findSinks() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(s => { for (const t of s.getTracks()) t.stop(); }, () => { })      // a throw is NOT proof of refusal: with no microphone, or a busy one, the PERMISSION can still have landed, and the permission is all the list needs
    .then(() => loadSinks()).then(() => {                                    // so let the device list be the judge
      sinkDenied = !sinks.length; syncSettings();
      say(sinks.length ? 'Your speakers are listed now' : 'Your speakers still can’t be listed', null, 2800);
    });
}
function pickSink(id) {
  unlock();                                        // the AudioContext has to exist before it can be pointed anywhere
  scene.audio.setSink(id).then(ok => {
    if (!ok) return forgetSink('Couldn’t use that output');
    sinkId = id || ''; savePrefs(); syncSettings();
    const d = sinks.find(x => x.id === sinkId); say(sinkId ? `Sound: ${d ? d.label : 'that output'}` : 'Sound: system default', null, 2000);
  });
}
function setPod(on) { showPod = !!on; show('podwrap', showPod); savePrefs(); syncSettings(); }
function setBody(on) { showBody = !!on; scene.setSelfBody(showBody); savePrefs(); syncSettings(); }
function setStats(on) { showStats = !!on; show('dev', showStats); savePrefs(); syncSettings(); }
function recenter() { model.recenter(); if (body) body.center(); say('Recentred'); }
function leave() { if (!LOBBY || !room) return; game.send({ type: 'leave' }); toLobby(); }
// The socket opens again so the server hears who this is now (docs/ACCOUNTS.md 6.2, 9.6, 9.7): signed in or out, stats switched, data
// deleted. It keeps the device of a socket's first hello and reads the cookie at the upgrade, so a new socket is the only way. Never
// in the middle of a match or on its result card (a drop there is a hold, a forfeit or 'No rematch' for the other player): then it
// waits for the court to be left, or for the rematch to begin (rematchon, before its first ball: nothing of it is recorded yet).
let redialWait = false;
const midMatch = () => !!room && !spec() && (struck || over != null || ui.currentOverlay() === 'match' || !!(state && state.score && state.score[0] + state.score[1] > 0));
function redial() { if (midMatch()) { redialWait = true; return; } redialWait = false; game.drop(); }
function redialDue() { if (redialWait) { redialWait = false; game.drop(); } }
function openStats() { if (room) { say('Leave the court to see your stats', null, 2400); return; } ui.settings(false); if (phase === 'title') play(); if (phase === 'lobby') ui.lobbyView('profile'); }      // Settings > You > Your stats
function playBot(level) { if (pending) return; botWant = [0, 1, 2, 3].includes(level) ? level : 1; request({ type: 'create', public: false }); }      // Play a bot = a private room, then 'bot' right after the welcome. No protocol of its own
// Opening the panel pauses a match against Matt (or an empty court); against a human it is only a card over a live rally.
const vsHuman = () => { const o = state && state.paddles[1 - side]; return !!o && !o.bot; };
const forfeits = () => LOBBY && !spec() && ui.currentOverlay() !== 'match' && (tourKind === 'match' || vsHuman() && !holding && (struck || !!state && state.score[0] + state.score[1] > 0));      // a tournament match: leaving is a forfeit from the first moment, against Matt too      // leaving now is a forfeit (docs/SPECTATE.md): the Leave button and the Q toast say so. struck: a ball has been hit in this match
function pause(on) {
  if (spec() || !seated() || !live()) return;
  if (vsHuman()) { if (on) ui.setSettings({ canPause: !(noPause = true) }); return; }
  if (on) ui.setSettings({ canPause: !(noPause = false) }); game.send({ type: 'pause', on });
}
let sentName = '', polledName = '', healAt = 0, noPause = false, burstT = 0, struck = false, saidForfeit = false, dim = false;
const cardOpen = () => ui.settings() || ui.tourCard();      // either card pauses a match against Matt (the tournament card in a warm-up)
function setDim() { const on = pausedUi && cardOpen() && !spec(); if (on !== dim) scene.setDim(dim = on); }      // paused against Matt behind the full blur: the menu's cheap picture (it ran at 2560x1440, 52 fps for up to 10 minutes)
function rename(n) {                               // the settings panel's Name row (docs/NEXT.md 10b): kept, and told to the room
  n = cleanName(n); if (!n) return; ls.set('poddle.name', n);
  if (seated() && LOBBY && n !== sentName) game.send({ type: 'name', name: sentName = n });
}

// My serve: the ball hangs and follows late. One quiet nudge per serve, from the server's reach hint, never in reply to a swing.
let svT = 0, svFar = 0, svSaid = true;
function serveCoach(m) {
  const t = performance.now();
  if (m.serving !== side || calibrating) { svT = 0; return; }
  if (!svT) { svT = t; svFar = 0; svSaid = false; }
  svFar = m.reach ? 0 : svFar || t;
  if (svSaid) return;
  if (svFar && t - svFar > 1500 && t - svT > 2800) { svSaid = true; say('Line up with the ball, then swing', null, 2200); }
  else if (m.reach && t - svT > 4500) { svSaid = true; say('Swing at the ball to serve', null, 2200); }
}

// ---------- peak logger ----------
let peaks = [], sessionPeak = 0, log10 = [];
function logSwing(e) {
  const pk = e.peak, tag = `${e.counted ? pk.toFixed(0) : '×'} (${e.rom.toFixed(0)}°)`;
  log10.push(tag); if (log10.length > 5) log10.shift();
  ui.setStat('pklist', log10.join(' · '));
  console.log(`swing power=${pk.toFixed(1)} raw=${e.raw.toFixed(1)} rad/s rom=${e.rom.toFixed(0)}deg counted=${e.counted}`);
  if (!e.counted) return;
  peaks.push(pk); sessionPeak = Math.max(sessionPeak, pk);
  ui.setStat('sw', peaks.length); ui.setStat('pkmax', sessionPeak.toFixed(1));
  ui.setStat('pkavg', (peaks.reduce((a, b) => a + b, 0) / peaks.length).toFixed(1));
}
function resetPeaks() { peaks = []; log10 = []; sessionPeak = 0; ui.setStat('sw', 0); ui.setStat('pkmax', '0.0'); ui.setStat('pkavg', '-'); ui.setStat('pklist', '-'); }

// ---------- screens: title -> connect -> calibrate -> play ----------
function showCal(e) { if (phase === 'calibrate') ui.calibration(e, { camLost: !!(body && body.ready && !body.seen()) }); }
function screen(name) { ui.showScreen(name); scene.setMenu(!!name); route(); }      // a menu screen over the court = the menu camera and the cheap render mode (docs/API-NEXT.md 2.4)
function openCourt() { screen(null); if (over) showOver(); padPhase(); }
function startCal() { if (undo) undo.kept = false; calibrating = true; stats.calibrated = false; model.startCalibration(); phase = 'calibrate'; ui.calibrationReset(); screen('calibrate'); tellCal(true); padPhase(); }
function tellCal(on) { if (seated() && !spec()) game.send({ type: 'status', cal: on }); }      // the others see 'Calibrating' on my character, and the next serve waits for me (docs/NEXT.md 14a)
function play() {                                  // leave the title for the lobby. A shared link (?room=CODE) joins at once, or watches (&watch=1).
  if (phase !== 'title') return;
  phase = 'lobby'; screen('lobby');
  if (wantRoom.length === 4) { ui.lobbyView('courts', { code: wantRoom, watch: wantWatch }); if (myName()) request({ type: wantWatch ? 'watch' : 'join', code: wantRoom }); } else ui.lobbyView('home');      // no name yet: the code is filled in, the field asks, Join does the rest
}
function begin() {                                 // seated: the camera primer first (once ever), then straight to calibration if the paddle is already streaming, straight to the court if that is done too
  phase = 'connect'; const ask = camAsk();
  if (ask === 'wait') { phase = 'camera'; camView = ''; permReady.then(() => { if (phase === 'camera' && !camView) begin(); }); return; }      // the browser's answer takes a few ms: a first seat must not start the camera before the primer
  if (ask) { primer(ask, 'blocked'); return; }      // 'help': blocked in this browser already, so the help instead of an Allow that cannot work
  if (ls.get(CAM_KEY) !== 'skip') startCam();
  goOn();
}
function goOn() { if (stats.calibrated && airpodLive()) { phase = 'play'; openCourt(); } else if (airpodLive()) startCal(); else { screen('connect'); padPhase(); } }
function enterWatch() { phase = 'watch'; openCourt(); }      // a spectator: no AirPod, no bridge, no calibration, no camera. Lobby -> court.
let pendT = 0;
function settle() { pending = null; clearTimeout(pendT); ui.lobbyBusy(false); }
function request(m) {                               // one lobby request at a time, each carrying the player's name. Not connected right now: it goes out when the socket opens
  if (pending) return; const n = myName(); m.name = sentName = n; if (n && !profile.username()) ls.set('poddle.name', n);
  pending = m; ui.lobbyBusy(true); game.send(m);
  pendT = setTimeout(() => { if (pending !== m) return; settle(); botWant = null; if (link.g) say('No answer. Try again.', null, 2600); }, 5000);      // an old server never answers: do not leave the lobby dimmed for good
}
// the menu's address (NOTES 108): each lobby view has a path the server answers with this same page, so a reload lands back on it instead of the title.
// replaceState only: the browser's Back button still leaves the site as before. A court keeps '/' with its ?court=CODE (the invite).
const VIEW_PATH = { home: '/play', courts: '/courts', create: '/create', bot: '/bot', profile: '/stats', share: '/courts', tour: '/courts', bracket: '/courts' }, PATH_VIEW = { '/play': 'home', '/courts': 'courts', '/create': 'create', '/bot': 'bot', '/stats': 'profile' };
let routing = false;      // off until the reload's view is back (the boot's title screen must not wipe /stats first)
function route() { if (!LOBBY || !routing) return; const p = room ? '/' : ui.currentScreen() === 'lobby' ? VIEW_PATH[ui.lobbyView()] || '/play' : ui.currentScreen() === 'title' ? '/' : null;
  if (p && p !== location.pathname && (location.pathname === '/' || PATH_VIEW[location.pathname])) history.replaceState(null, '', p + location.search + location.hash); }      // only ever swaps one of our own paths (a local copy served from /web/index.html keeps its path)
function setUrl(code, watch) { const u = new URL(location.href), q = u.searchParams; q.delete('room'); if (code) q.set('court', code); else q.delete('court'); if (code && watch) q.set('watch', '1'); else q.delete('watch'); history.replaceState(null, '', u); route(); }   // the address bar is the invite, and a reload comes back to the same room, in the same role
const shareLink = code => ['localhost', '127.0.0.1', ''].includes(location.hostname) ? '' : `${location.origin}/?court=${code}`;      // the root, never the menu path the address bar happens to show      // a localhost link is no use to a friend
// ---------- asking to play (docs/SPECTATE.md Asking to play) ----------
let askId = 0, askWho = '', askedFor = false, noBot = false;
const CAN_PADDLE = CAN_PHONE || /Mac/.test(navigator.platform) && navigator.maxTouchPoints <= 1;      // this device can be a paddle (the inverse of the viewer-only note at the top): only then is there an Ask to play
function askSync() { const pd = state && state.paddles || [], bots = pd.filter(p => p && p.bot).length, hum = pd.filter(p => p && !p.bot).length;      // a spectator, one human playing Matt
  ui.showAsk(LOBBY && spec() && phase === 'watch' && CAN_PADDLE && bots === 1 && hum === 1); }
function answer(yes) { if (!askId) return; game.send({ type: 'answer', id: askId, yes }); ui.askCard(null); }
function askPlay() { game.send({ type: 'ask' }); }
ui.onAnswer(answer); ui.onAsk(askPlay);
function switchSeat(m) { const toSpec = m.role === 'spectator'; role = toSpec ? 'spectator' : 'player'; room = m.code; noBot = !toSpec; ui.setRoom(room, shareLink(room)); setUrl(room, toSpec);      // the server moved me between the stands and a seat of the same court: one path
  ui.askPlay(null); ui.askCard(null); ui.setSpectator(toSpec); ui.showAsk(false); syncSettings(); clearFar(); if (toSpec) enterWatch(); else { phase = 'lobby'; begin(); } }      // begin(): connect -> calibrate -> play; a calibrated paddle goes straight to play
// ---------- tournaments (docs/COURTS-TOURNEY.md 4.5-4.7): the server runs it; this shows where you are in it ----------
let tour = null, tourKind = null, tourMoving = false, tourVsT = 0, tourHang = 0, champShown = '';
const tourOn = () => !!tour && tour.phase !== 'done';      // still running: a finished one (its champion shown) no longer steers the lobby, the address bar or the reconnect      // tour: the last snapshot. tourKind: 'warm' | 'match' while in one of its courts. tourMoving: a VS card is up, a match seat is on its way
function tourScreen(force) {                        // between courts: the code screen while it signs up, the bracket once it runs. Only a view change calls lobbyView (it moves focus)
  if (!tour || phase !== 'lobby' || room || ui.currentScreen() !== 'lobby') return; const want = tour.phase === 'reg' ? 'tour' : 'bracket', v = ui.lobbyView();
  if ((force || v === 'tour' || v === 'bracket') && v !== want) ui.lobbyView(want);
}
function onTour(m) {
  clearTimeout(tourHang); const was = tour && tour.code === m.code ? tour : null, you = m.you && typeof m.you === 'object' ? m.you : {}, mine = pending && ['tcreate', 'join', 'watch'].includes(pending.type) ? pending : null;
  if (mine) settle();                                // request() settles on 'tour' as well as on 'room'
  tour = m; ui.setTour(m, { link: shareLink(m.code) });
  if (was && m.phase === 'reg') {
    if (you.host && !(was.you && was.you.host) && you.id != null) say('You’re the host now', null, 2600);
    if (tourKind === 'warm' && live()) { const had = new Set((was.players || []).map(p => p && p.id)); for (const p of m.players || []) if (p && !had.has(p.id) && p.id !== you.id) ui.tourNote(cleanName(p.name)); }      // 'Ben joined the tournament', while you warm up
  } else if (!was && mine && mine.type === 'join' && you.id != null && m.phase === 'reg' && !you.host) say('You’re in. Warm up with Matt while people join.', null, 3200);
  if (phase === 'lobby' && !room && ui.currentScreen() === 'lobby') { tourScreen(!!mine || !was); setUrl(m.phase === 'done' ? null : m.code, !!you.viewer); }
  if (m.champ && champShown !== m.code) showChamp();
}
function tourMove(m) {                              // my next match is drawn: the VS card now, the court in m.at s (docs/COURTS-TOURNEY.md 4.6 item 6)
  clearTimeout(tourHang); tourMoving = true; ui.settings(false); ui.tourCard(false); if (ui.currentScreen() === 'lobby') screen(null);
  ui.tourVs(m); clearTimeout(tourVsT);
  tourVsT = setTimeout(() => { if (ui.currentOverlay() !== 'tour-vs') return; ui.tourVs(null); tourMoving = false; if (phase === 'lobby' && !room) { screen('lobby'); tourScreen(true); } }, ((+m.at || 4) + 10) * 1000);      // the seat never came (the other side left first: through without a ball)
}
function showChamp() {                              // for everyone: the champion card over the court, confetti twice (docs/COURTS-TOURNEY.md 4.6 item 10)
  champShown = tour.code; const c = tour.champ, me = tour.you && tour.you.id != null ? tour.you.id : null;
  if (room && !tourKind) { say(me != null && c.id === me ? 'You’re the champion!' : `${c.bot ? 'Matt' : cleanName(c.name) || 'Someone'} is the champion!`, null, 3200); tour = null; champShown = ''; ui.setTour(null); game.send({ type: 'tleave' }); return; }      // busy in an ordinary court: a toast, and the tournament lets go; nobody is pulled off their court
  if (room) { game.send({ type: 'leave' }); toLobby(); }      // off the final's court first: its 'closed round' must not take the card down
  tourMoving = false; ui.tourVs(null); screen(null); ui.champion(c, me); scene.jingle('champ');      // cuts the final's win/lose jingle, which is still ringing: this card follows it at once
  const gold = ['#ffd34a', '#f2a81d', '#3aa0ff', '#ffffff']; ui.confetti(gold, 140); clearTimeout(burstT); burstT = setTimeout(() => { if (ui.championShowing()) ui.confetti(gold, 100); }, 900);
}
function endTour(why) {                             // tourend: restart | gone | empty | expired | left
  tour = null; champShown = ''; clearTimeout(tourVsT); ui.setTour(null); ui.tourVs(null);
  if (room && !tourKind) { ui.tourEnded(why, true); if (why === 'restart' || why === 'gone') game.drop(); return; }      // in an ordinary court: said in a toast, and the court goes on (the server empties its own courts itself). restart / gone only ever answer a reconnect with &tour=, which left this socket in the lobby: open again without it (back=1), and the court comes back like any other
  if (room) game.send({ type: 'leave' });
  toLobby(); if (why === 'left') ui.lobbyView('courts'); ui.tourEnded(why);
}
function tourCourts() { const t = tour; tour = null; champShown = ''; ui.setTour(null); if (t) game.send({ type: 'tleave' }); ui.showOverlay(null); toLobby(); ui.lobbyView('courts'); }      // the champion's Back to courts: it is over for me (tleave in 'done' only lets go)
function tourBracket() { if (room) { game.send({ type: 'leave' }); toLobby(); } else { ui.showOverlay(null); if (phase === 'lobby') screen('lobby'); } if (ui.currentScreen() === 'lobby' && ui.lobbyView() !== 'bracket') ui.lobbyView('bracket'); }      // See bracket: off the result card (the court closes by itself anyway)
function tourKey() {
  if (tourKind === 'warm' && live() && !ui.currentScreen() && !ui.currentOverlay()) { ui.tourCard(!ui.tourCard()); return; }
  if (tourKind === 'match' && spec() && live()) { leave(); return; }      // watching one of its matches: back to the bracket
  if (phase === 'lobby' && !room && !ui.asking()) tourScreen(true);
}
ui.onTour({ create: () => request({ type: 'tcreate' }), open: () => tourScreen(true), warm: () => game.send({ type: 'twarm' }), start: () => game.send({ type: 'tstart' }), leave: () => game.send({ type: 'tleave' }),
  watch: r => request({ type: 'twatch', room: r }), bracket: tourBracket, courts: tourCourts,
  cardOpen: () => { pause(true); setDim(); },
  cardClose: () => { pause(false); setDim(); } });
function toLobby(msg) {                            // out of a room, back to the choices. Calibration is kept. The menu's rally takes the court back.
  if (undo) { undo = null; ui.backLabel('Back'); }
  clearFar(); clearTimeout(burstT); ui.confettiOff(); ms = null; room = null; role = 'player'; side = 0; names = [null, null]; regs = [false, false]; wantRoom = ''; wantWatch = false; state = null; over = null; botWant = null; botLevel = ''; holding = frozen = votedNo = struck = false; watchers = 0; phase = 'lobby'; setUrl(null); settle();
  ui.setSpectator(false); ui.emotesOff(); ui.notesOff(); ui.hold(null); ui.askCard(null); ui.askPlay(null); ui.showAsk(false); askedFor = noBot = false; setPaused(false); ui.settings(false); ui.setWatchers(0); syncSettings(); ui.setSettings({ canPause: true });
  scene.setFrozen(false); scene.setSide(0); scene.startAttract();
  ui.setRoom(null); ui.showOverlay(null); screen('lobby'); ui.lobbyView('home');
  ui.setScore(0, 0); ui.setServe(null); ui.setNames({ me: 'You', ...alone() });
  if (msg) say(msg, null, 2600); else ui.toastOff();                                // 'Press Q again to leave' has been answered
  tourKind = null; tourMoving = false; ui.tourCourt(null); syncSettings();
  redialDue(); if (tourOn()) { tourScreen(true); setUrl(tour.code, !!(tour.you && tour.you.viewer)); }      // redialDue: off the court, the socket may open again (stats switched, signed in or out). In a tournament, out of any court means its screen: the code while it signs up, the bracket once it runs. The address bar keeps its code, so a reload comes back to it
  padPhase();
}
function back() {                                  // Back button / Esc, wherever it is
  if (!LOBBY) return;
  if (phase === 'lobby') { const v = ui.lobbyView(); if (v === 'bracket' && tour && !tourOn() && !room) { tourCourts(); return; } if (room) { game.send({ type: 'leave' }); toLobby(); if (ui.viewParent(v)) ui.lobbyView(ui.viewParent(v)); } else if (v !== 'home') ui.lobbyView(ui.viewParent(v) || 'home'); else { phase = 'title'; screen('title'); } }      // Create court and Your court go back to Courts
  else if (undo && (phase === 'camera' || phase === 'connect' || phase === 'calibrate')) cancelSwap();      // mid-game paddle swap: Back is Cancel, it never leaves the court (the help can come up there too, after a Turn on)
  else if (phase === 'camera' || phase === 'connect' || phase === 'calibrate') { game.send({ type: 'leave' }); toLobby(); }      // the primer is a set-up screen like the others: Back leaves the court
}
function refreshStatus() {
  const setup = phase === 'title' || phase === 'lobby' || phase === 'camera' || phase === 'connect', off = phase === 'watch';      // watching needs no AirPod and no camera: never 'signal lost'
  const cam = off || NO_CAM ? 'off' : !body ? (!camOn && ls.get(CAM_KEY) === 'skip' ? 'off' : 'wait') : body.ready ? 'ok' : 'off';      // Play without camera is 'off', not 'waiting' for an Allow nobody will press
  ui.setStatus({ airpod: off ? 'off' : airpodLive() ? 'ok' : setup ? 'wait' : 'bad', game: link.g ? 'ok' : setup && !gameEver ? 'wait' : 'bad', camera: cam });
  ui.show('btn-cam-on', cam === 'off' && !off && !NO_CAM && phase === 'connect');      // the Camera row's Turn on: changed their mind
  if (phase === 'calibrate' && !airpodLive()) ui.calibrationReset();      // stream dropped mid-calibration: say so
  if (LOBBY) ui.lobbyLink(link.g || !gameEver && performance.now() < 2500);       // the lobby sits above the 'server down' card, so it says so itself (not in the first moments of a page load)
  const n = myName(); if (n !== polledName) { polledName = n; if (room) rename(n); }      // the name was changed in the settings panel while in a room
}

scene.setSelfBody(showBody); show('podwrap', showPod); show('dev', showStats); ui.setMode(MODE_NAME[mode]); syncSettings();      // what was chosen last time (poddle.settings)
if (LOBBY && qs.get('room')) setUrl(wantRoom.length === 4 ? wantRoom : null, wantWatch);      // an old ?room= link: same court, the address bar now says ?court=
if (!LOBBY) { phase = 'connect'; screen('connect'); setTimeout(begin); } else { ui.titleRoom(wantRoom.length === 4 ? wantRoom : '', wantWatch); screen('title'); scene.startAttract(); }      // the menu's own endless rally, client-side only (docs/NEXT.md 11)
refreshStatus(); setInterval(refreshStatus, 250);

// ---------- sockets (auto-reconnect) ----------
// urls: tried in turn until one opens. A stale '#<old-ip>' in the address bar must never strand you: this machine's
// own server is always the second candidate, and when it wins the dead address is dropped from the URL.
// What a reconnect says about the court it was in. If the server restarted meanwhile (every deploy does), the court is gone
// from its memory; with this the first tab back rebuilds it under the same code, same seats, same score (server: revive()).
let roomPub = false, restartUntil = 0;
function backTo() { const o = state && state.paddles && state.paddles[1 - side], lv = o && o.bot ? ['Rookie', 'Club', 'Pro', 'Tour'].indexOf(botLevel) : -1, sc = state && Array.isArray(state.score) ? state.score : null;
  return '&back=1&pub=' + (roomPub ? 1 : 0) + (spec() ? '' : '&side=' + side) + (sc ? '&score=' + (sc[0] | 0) + '-' + (sc[1] | 0) : '') + (lv >= 0 ? '&bot=' + lv : ''); }
function connect(urls, el, onmsg, onopen) {
  urls = [].concat(urls); let ws, delay = 400, i = 0, fails = 0;
  const open = () => {
    const url = urls[i % urls.length]; let opened = false;
    ws = new WebSocket(el === 'g' ? url + '?cid=' + CID + (CAN_PHONE ? '&pad=' + PAD : '') + (LOBBY ? '&lobby=1' + (tourOn() ? '&tour=' + tour.code : '') + (room ? '&room=' + room + (spec() ? '&watch=1' : '') : tourOn() && tour.you && tour.you.viewer ? '&watch=1' : '') + ((room || tourOn()) && myName() ? '&name=' + encodeURIComponent(myName()) : '') + (room && !tourOn() ? backTo() : '') : '') : url);      // room: a reconnect asks for its seat (or its place to watch) back. tour: its tournament (&watch=1 with no room: its viewer, never signed up by a reconnect; never back=1: nothing of a tournament is revived, docs/COURTS-TOURNEY.md 4.5)
    const sock = ws, giveUp = setTimeout(() => { if (!opened) sock.close(); }, 1500);       // a dead IP just hangs: don't wait for TCP to time out
    ws.onopen = () => { opened = true; clearTimeout(giveUp); delay = 400; fails = 0; link[el] = true; ui.setLink(el, true);
      if (el === 'g') { gameEver = true; if (ui.currentOverlay() === 'server-down') ui.showOverlay(null); if (i % urls.length > 0 && location.hash) { history.replaceState(null, '', location.pathname + location.search); say('Saved address didn’t answer. Using this Mac.', null, 2800); } }
      onopen && onopen(); };
    ws.onmessage = e => { try { onmsg(JSON.parse(e.data)); } catch (err) { stats.errors++; console.error(err); } };
    ws.onclose = () => { link[el] = false; ui.setLink(el, false);
      if (!opened) { i++; fails++; }                                   // never connected: try the next candidate
      if (el === 'g' && fails >= urls.length && performance.now() > restartUntil) { ui.setServerAddress(urls.join('  or  ')); if (ui.currentOverlay() !== 'game-full') ui.showOverlay('server-down'); }
      setTimeout(open, opened ? 300 : delay); delay = Math.min(delay * 1.5, 3000); };
    ws.onerror = () => {};
  };
  open();
  return { send: m => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }, drop: () => { if (ws && ws.readyState === 1) ws.close(); } };      // drop: open again at once, with the address as it is now
}

// ---------- the paddle: an AirPod (the helper on this Mac) or a phone (its page, by way of the game server) ----------
// Hosted, the helper's socket is only opened for someone who has played with an AirPod here before or asks to: a page
// reaching for localhost makes Chrome ask a first-time visitor about 'devices on your local network' for nothing.
// A phone weighs forty AirPods and nobody whips it round at 30 rad/s, so its swings count for more (?padgain= to try another value):
// motion.js scales the phone's rotation rate by it for the effortless part of the score only (RATE_GAIN), and its speed part by the gain's square root, so a relaxed phone
// stroke is a drive sooner but a smash still takes a hard swing (~19 rad/s, an AirPod ~23.4) (NOTES 82). pw() now scales only 'raw', which a serve reads.
const PHONE_GAIN = Math.max(0.5, Math.min(3, +qs.get('padgain') || 1.5)), pw = v => src === 'phone' ? v * PHONE_GAIN : v;
const AIRPOD_BUFFER = model.c.BUFFER_MAX, PHONE_BUFFER = 0.2;
let padOn = false, src = '', lastT = -1e9, bridge = null, useAirpod = !CAN_PHONE || qs.has('bridge') && qs.get('padtest') !== '1' || ls.get('poddle.airpod') === '1';
// Someone who played here before phones could be paddles (a name is saved, no choice yet) may have the helper running: it is
// tried quietly behind the phone's QR, and the first AirPod sample makes the AirPod the paddle, with no click and no change for them.
let tryBridge = !useAirpod && CAN_PHONE && ls.get('poddle.airpod') == null && !!ls.get('poddle.name');
let chose = false, undo = null;      // undo: a swap made mid-game, until the new paddle is calibrated. Cancel (the Back button) puts the old one back      // the player picked the paddle on the switch this visit: a phone page left open no longer takes over from the AirPod
function openBridge() { if (!bridge) bridge = connect(BRIDGE, 'm', sample => onSample(sample, 'airpod')); }
let myKind = null, myBet = null;      // my last hit's kind (a re-aim names it only when it changed) and its bet-fallback timer
const padFx = (fx, n, b) => { if (padOn && !useAirpod) game.send({ type: 'padfx', fx, n, b }); };      // the phone buzzes on my hits and says which step we are at
const padPhase = () => padFx(phase === 'calibrate' || phase === 'camera' ? 'cal' : phase === 'play' ? 'play' : 'idle');      // camera: the primer is up, the phone says 'Follow the steps on your computer'
function showPair() {                              // the set-up screen offers the phone first wherever a phone can be the paddle
  const phone = CAN_PHONE && !useAirpod, kind = phone ? 'phone' : 'airpod';      // the words and drawings follow the choice (a phone that scans in makes it the choice)
  ui.setPaddle(kind); pod.setKind(kind);
  ui.padPair({ show: phone && !padOn, url: `${location.origin}/pad.html?k=${PAD}`, code: 'P-' + PAD, title: phone ? 'Grab your paddle' : 'Connect your AirPod', choose: CAN_PHONE, mode: kind,
    foot: phone ? 'Nothing to install.' : 'Still waiting? Open Poddle Helper on this Mac.' });
  ui.setSettings({ paddle: CAN_PHONE ? kind : null });
}
// Phone <-> AirPod: the set-up screen's switch, or the settings row at any time. Mid-game what was calibrated was the other
// paddle, so it is back to the set-up screen (the QR, or the helper card) until the new one answers, then calibration.
// Going to the AirPod, the phone's page is told to stand down first (padFx says nothing once the AirPod is the paddle).
function pickPaddle(kind) {
  const want = kind === 'airpod'; if (want === useAirpod) return; if (undo && undo.airpod === want) return cancelSwap();      // the switch back to where it was = Cancel
  const mid = phase === 'play' || phase === 'calibrate';
  if (phase === 'play' && !undo) { undo = { airpod: useAirpod, kept: stats.calibrated }; ui.backLabel('Cancel'); }
  setPaddleTo(want);
  if (mid) { stats.calibrated = false; calibrating = true; lastSample = -1e9; phase = 'connect'; ui.settings(false); screen('connect'); tellCal(true); }
}
function setPaddleTo(want) { if (want) padFx('idle'); useAirpod = want; chose = true; tryBridge = false; if (useAirpod) openBridge(); ls.set('poddle.airpod', useAirpod ? '1' : '0'); showPair(); if (!useAirpod) padPhase(); }
// Cancel: the old paddle again. If the new one never started calibrating, the old calibration is untouched: straight back to the court.
function cancelSwap() {
  const u = undo; undo = null; ui.backLabel('Back'); if (!u) return; setPaddleTo(u.airpod); lastSample = performance.now();      // the old paddle was live a moment ago: no 'signal lost' flash while its next sample arrives
  if (u.kept) { stats.calibrated = true; calibrating = false; phase = 'play'; tellCal(false); openCourt(); }
  else { stats.calibrated = false; phase = 'connect'; screen('connect'); }      // its next sample calibrates it again
}
ui.onPaddleSwap(pickPaddle);
if (useAirpod || tryBridge) openBridge();
showPair();
if (CAN_PHONE && !useAirpod && !PHONE_SIZED) $('title-note').textContent = 'Nothing to install. Your phone is the paddle.';
function onSample(sample, from) {
  if (from === 'airpod' && !useAirpod && (padOn || !tryBridge)) return;      // a phone was scanned in (or chosen): it is the paddle, the AirPod in a pocket is not
  if (from === 'airpod' && !useAirpod) { useAirpod = true; tryBridge = false; }      // a returning AirPod player's helper answered
  if (from === 'phone' && useAirpod) { if (chose || !CAN_PHONE) return; useAirpod = false; }      // a phone page that is still open took over: it is the paddle now, say so. Unless the AirPod was picked on purpose
  if (!sample || !Array.isArray(sample.r)) return;
  // A phone's samples cross the internet, and phone wifi holds packets back and lets them go in bursts: its replay may wait
  // longer when (only when) that happens (NOTES 35). The AirPod keeps its own limit.
  if (from !== src) { src = from; lastT = -1e9; model.c.BUFFER_MAX = from === 'phone' ? PHONE_BUFFER : AIRPOD_BUFFER; model.c.RATE_GAIN = from === 'phone' ? PHONE_GAIN : 1; if (from === 'airpod') ls.set('poddle.airpod', '1'); showPair();      // the paddle changed hands: what was calibrated was the other one
    if (stats.calibrated) { stats.calibrated = false; if (phase === 'play') startCal(); } else if (phase === 'calibrate') startCal(); }
  if (sample.t < lastT - 0.5 && (stats.calibrated || phase === 'calibrate')) { stats.calibrated = false; if (phase === 'play' || phase === 'calibrate') startCal(); }      // the paddle's clock went back: the phone's page was reloaded, and its compass starts from a new zero
  lastT = sample.t;
  const power = Math.hypot(sample.r[0], sample.r[1], sample.r[2]);
  lastSample = performance.now();
  ui.setStat('pw', power.toFixed(1));
  if (phase === 'title') { if (power > 12) play(); return; }         // a swing presses Play. The model is not fed until calibration
  if (phase === 'lobby' || phase === 'watch' || phase === 'camera') return;      //  A spectator's AirPod is nobody's paddle. Behind the primer it only counts as live (airpodLive): its answer goes on to calibration
  if (phase === 'connect') startCal();                              //  begins, so a bud lying on the desk cannot calibrate itself.
  for (const e of model.feed(sample, performance.now())) {
    if (e.type === 'cal') showCal(e);
    else if (e.type === 'calibrated') { if (undo) { undo = null; ui.backLabel('Back'); } calibrating = false; stats.calibrated = true; phase = 'play'; if (body) body.center(); tellCal(false);
      // 'All set' arrives in this same batch: hold the green card long enough to be read, then open the court
      setTimeout(() => { if (phase !== 'play') return; openCourt();
        setTimeout(() => { if (inPlay() && state && state.serving === side) say('Your serve!', null, 2600); }, 380); }, 900); }     // after the fade
    else if (e.type === 'swing' || e.type === 'swingFix') { const fix = e.type === 'swingFix'; if (!fix) stats.swings++;     // swings are reported early; a fix follows if the real peak differs
      if (!calibrating && !spec() && seated() && !frozen && !holding) {      // a paused or held room takes no swings
        // Spin is DELIBERATE: intent x speed. Intent is a wrist roll through the ball clearly past what a plain stroke does
        // (|roll| is the stroke's share of rotation about the forward axis: ordinary strokes 0-0.46, a real slice 0.50-0.62), a soft
        // knee from 0.40 to full at 0.58; or a consistent sideways curl PER RADIAN swept (|curl|/rom, knee 0.35-0.60). The old `turn`
        // term is gone: a path integral of axis wander, it grew with any long or fast flick and gave spin to strokes nobody cut.
        // Roll that comes with a downward chop (0.5 -> 0.8) is overhead pronation, not a cut, so a smash leaves clean.
        // Speed then scales what the intent earns: x0.85 at 8 rad/s up to x1.40 at 20 (raw peak, not power; the 0.85 floor keeps a
        // slower phone swing's slice a slice). Sign: which way the ball breaks off the bounce. (How level the paddle is held is NOT used.)
        // Measured (test/spin.mjs, 63 real strokes): 71 % leave with no spin (was 5 %), 29 % show the swirl (was 92 %), 17 % read as a
        // slice (was 27 %); the flicks-and-wide-swings set: 0 % over 0.3 (was 50 %). Same roll 0.52: 0.63 at 8 rad/s, 0.78 at 12.5, 1.0 at 27.
        const roll = Math.max(0, Math.min(1, (Math.abs(e.roll || 0) - 0.40) / 0.18)), over = Math.max(0, Math.min(1, ((e.chop || 0) - 0.5) / 0.3)), cut = Math.max(0, Math.min(1, (Math.abs(e.curl || 0) / Math.max(0.8, (e.rom || 0) * Math.PI / 180) - 0.35) / 0.25));
        const knee = t => t * t * (3 - 2 * t), rollI = knee(roll) * (1 - knee(over)), curve = knee(cut), speed = 0.85 + 0.55 * Math.max(0, Math.min(1, ((e.raw || 0) - 8) / 12));
        const bet = e.final === false ? Math.max(0, Math.min(1, ((e.rom || 0) - 60) / 40)) : 1;   // an early report (a bet, 20-80 deg swept) reads mostly wind-up pronation: ungated it gave 0.6-0.9 spin to 10 of 63 real strokes that settle at 0. A bet earns spin only once it has swept 60-100 deg; the settled report re-aims a real slice (sliced diff > 0.2)
        const amount = Math.min(1, Math.max(rollI, curve) * speed * bet), way = curve > rollI ? Math.sign(e.curl || 0) : Math.abs(e.roll || 0) > 0.1 ? -Math.sign(e.roll) : Math.sign(e.dir || 1);
        const slice = amount * (way || 1);
        // A lob is meant (docs/NEXT.md 2). motion.js measures it on the HAND's path now, so a curved low-to-high drive (it only ends
        // going up) and a backhand's face-opening roll no longer read as scoops, and a wide underhand is no longer faded out by its curve
        // (the old turn gate zeroed it, and at full power it went out a low smash). What stays: a stroke that turns mostly about the
        // forward axis (|roll| 0.45 -> 0.75) is a wrist roll or a sideways sweep, not a pendulum; if the paddle's pointer is a little off
        // the forearm, that roll leaks into the path. A pendulum underhand rolls 0.1-0.4 (recorded: the deliberate lob 0.39).
        // An early report on a pendulum (e.pend: motion.js looked ahead) is faded by the smaller of roll and twist (the turn about the forearm
        // itself): a wide underhand swings its hanging arm across as it comes up, and that sideways turn is 'roll' about the forward axis
        // (0.5-0.7 at the bet), not a wrist. The settled report keeps the roll alone.
        const fade = r => { const k = Math.max(0, Math.min(1, (r - 0.45) / 0.3)); return 1 - k * k * (3 - 2 * k); }, rl = Math.abs(e.roll || 0);
        const g = 1 - fade(e.final === false && e.pend && e.twist != null ? Math.min(rl, Math.abs(e.twist)) : rl), lob = e.lob * (1 - g);
        game.send({ type: 'swing', power: e.power, raw: pw(e.raw || 0), rom: e.rom || 0, back: e.back || 0, off: e.off || 0, dir: e.dir, lob, chop: e.chop, age: e.age, net: net.lag(), slice, fix, final: !!e.final, pk: e.raw || 0, src: src === 'phone' ? 'phone' : 'airpod' });      // pk, src: stats only (docs/ACCOUNTS.md 4.5), the UNGAINED peak rad/s (motion.js sw.peak) and which paddle made it. final: the settled power. The first report is a bet that overshoots (a wind-up called 30 settles at 8): the server serves and calls a smash only on a settled one
        unsettled = e.final ? null : { power: e.power, raw: pw(e.raw || 0), rom: e.rom || 0, back: e.back || 0, off: e.off || 0, dir: e.dir, lob: (e.lobRaw != null ? e.lobRaw : e.lob) * fade(rl), chop: e.chop, age: e.age, slice, pk: e.raw || 0, src: src === 'phone' ? 'phone' : 'airpod' };   // standing in for a settled report, the lob is the path as it was, not the look-ahead
        if (!fix) scene.onEvent({ type: 'swung', side });            // whoosh now; the server's echo is de-duplicated
      } }
    else if (e.type === 'swingEnd') { logSwing(e);
      if (unsettled) { game.send({ type: 'swing', ...unsettled, power: e.peak, pk: e.raw || unsettled.pk, net: net.lag(), fix: true, final: true }); unsettled = null; } }      // motion.js settles every swing itself; should one ever end without, the server still hears that it is over
  }
}

const SCENE_EVENTS = ['serve', 'hit', 'swung', 'bounce', 'launch', 'whiff', 'point'];
const game = connect(HOST === 'localhost' ? GAME : [GAME, `ws://localhost:${qs.get('game') || 8080}`], 'g', m => {
  if (m.type === 'm') { onSample(m, 'phone'); return; }           // my phone's motion, passed on by the server: 60 a second, so before anything else
  stats.events[m.type] = (stats.events[m.type] || 0) + 1;
  if (m.type === 'pong') { net.pong(m); return; }
  if (m.type === 'padtaken') { newPad(); game.send({ type: 'padcode', code: PAD }); showPair(); return; }      // another live tab drew this code first: pick again (nothing was paired to it yet)
  if (m.type === 'pad') { padOn = !!m.on; stats.pad = padOn; if (padOn) padPhase(); showPair(); return; }      // the phone's page opened (or closed)
  if (m.type === 'padkey') { if (seated() && !spec()) { if (m.k === 'c' && (phase === 'play' || phase === 'calibrate')) startCal(); else if (m.k === 'r' && phase === 'play') recenter(); } return; }      // Calibrate again / Recentre, pressed on the phone
  if (m.type === 'restart') { restartUntil = performance.now() + 15000; if (tour) say('Updating. The tournament will end.', null, 4000); else if (room) say('Updating. Back in a moment.', null, 4000); return; }      // the server is about to restart (a deploy): the court comes back with the reconnect; a tournament does not
  if (m.type === 'tourend') { clearTimeout(tourHang); if (tour) endTour(m.why); return; }      // before joinfail and closed (docs/COURTS-TOURNEY.md 4.5)
  if (!LOBBY) { if (m.type === 'closed') { ui.showOverlay(null); return; } if (['lobby', 'room', 'joinfail', 'left'].includes(m.type)) return; }          // legacy path: no room UI, whatever the server says
  if (m.type === 'lobby') { ui.lobbyRooms(m.rooms, m.online, m.tours); return; }
  if (m.type === 'tour') { if (m.code && typeof m.code === 'string') onTour(m); return; }      // above the guard: between rounds nobody is in a court
  if (m.type === 'tmove') { tourMove(m); return; }
  if (m.type === 'tourfail') { say(m.why === 'busy' ? 'Courts are full right now. Try Start again in a moment.' : `Needs at least 4 players · ${m.n | 0} here now`, null, 3200); return; }
  if (m.type === 'room') {                                       // seated, or let in to watch (the normal 'welcome' follows). Also the answer to a reconnect with room=CODE.
    clearTimeout(tourHang); roomPub = m.public === true; ms = null;      // a new court (or a reconnect into one): its stats start at its next 0-0
    const tk = typeof m.tour === 'string' && (m.kind === 'warm' || m.kind === 'match') ? m.kind : null, moved = tk === 'match' && m.role !== 'spectator' && room !== m.code && room != null;      // a tournament's court. moved: pulled out of the stands (or another court) into my drawn match: no closed came first
    if ((m.promoted || m.demoted) && room === m.code) { settle(); switchSeat(m); say(m.promoted ? 'You’re in. Get your paddle ready.' : 'Time’s up. You’re watching again.', null, 2600); return; }      // moved between the stands and Matt's seat of the SAME court
    askedFor = !!m.asked;                                                                     // a join into Matt's court landed in the stands: the player is being asked
    const made = pending && pending.type === 'create' && botWant == null, again = room === m.code; settle(); room = m.code; role = m.role === 'spectator' ? 'spectator' : 'player'; wantRoom = ''; wantWatch = false;
    tourKind = tk; ui.tourCourt(tk); if (tk) noBot = true; syncSettings();       // Matt comes by himself in a tournament's court, at Tour
    const shown = tk ? m.tour : room; ui.askWatch(null); ui.setRoom(shown, shareLink(shown)); setUrl(shown, spec()); scene.stopAttract();      // the menu's rally ends the moment a room is joined. A tournament's court shows (and copies) the tournament's code, never the private court's
    if (moved) { clearFar(); ui.hold(null); over = null; ui.setSpectator(false); ui.askPlay(null); ui.showAsk(false); phase = 'lobby'; }      // from watching (or another court) straight to my match
    if (phase === 'lobby' && !again) { if (spec()) enterWatch(); else if (made) ui.lobbyView('share'); else begin(); }        // again: a reconnect got the seat back, the player stays where they were. Play a bot skips the share view
    return;
  }
  if (m.type === 'joinfail') {
    const was = pending, watching = !!was && was.type === 'watch'; settle(); wantRoom = ''; wantWatch = false; botWant = null;
    if (room) { toLobby('Court closed'); return; }                                            // a reconnect found the room gone
    if (tourOn()) setUrl(tour.code, !!(tour.you && tour.you.viewer)); else setUrl(null);
    const tcode = ui.cleanCode(typeof m.code === 'string' ? m.code : was && was.code);
    if ((m.reason === 'tfull' || m.reason === 'started') && m.watch === true && tcode.length === 4) { ui.askWatch(tcode, m.reason === 'tfull' ? 'This tournament is full. Watch instead?' : 'This tournament has started. Watch instead?'); return; }      // a tournament's code: watch its bracket instead
    if (m.reason === 'intour') { say(`You’re in tournament ${tcode}. Leave it first.`, null, 3200); if (tour) tourScreen(true); return; }
    if (was && was.type === 'twatch') { say('That match just ended', null, 2200); return; }      // a Watch on the bracket, a moment too late
    if (was && was.type === 'tcreate') { say(m.reason === 'busy' ? 'Too many tournaments right now. Try again soon.' : 'Couldn’t make a tournament. Reload and try again.', null, 3000); return; }
    if (m.reason === 'full' && m.watch === true && !watching) { const code = ui.cleanCode(typeof m.code === 'string' ? m.code : was && was.code); if (code.length === 4) { ui.askWatch(code); return; } }      // 'Court is full. Watch instead?'
    const text = (watching ? { notfound: 'Court not found', busy: 'Too many watching', full: 'Too many watching' } : { notfound: 'Court not found', full: 'Court is full', busy: 'No free courts. Try again soon.', nocid: 'Couldn’t join. Reload and try again.' })[m.reason] || 'Couldn’t join';
    if (was && (was.type === 'join' || watching) && ui.lobbyView() === 'courts' && was.code === ui.typedCode()) ui.codeError(text); else say(text, null, 2600);      // typed in the boxes: said under them. A row click: a toast
    return;
  }
  if (m.type === 'closed') { if (room) toLobby(tourKind && ['round', 'tourstart', 'tourend', 'empty'].includes(m.reason) ? '' : m.reason === 'norematch' ? (votedNo ? '' : 'No rematch') : 'Court closed'); return; }      // everyone goes back to the lobby; the one who pressed Leave needs no telling. A tournament's court closing is the tournament moving on: its screen says the rest
  if (m.type === 'full') { if (!LOBBY) ui.showOverlay('game-full'); return; }
  if (!seated()) return;                                         // THE GUARD (docs/API-NEXT.md 4.2): no room joined = no side, court, score, names, ball, banner, result, toast or sound, whatever the server sends
  if (m.type === 'welcome') {
    ms = null; side = m.side === 1 ? 1 : 0; if (LOBBY && m.role) role = m.role === 'spectator' ? 'spectator' : 'player'; names = cleanNames(m.names); regs = cleanRegs(m.reg); holding = false;
    if (LOBBY && room && !spec()) profile.seated();              // a seat of my own: the device id is made now if there is none, and its hello goes at once (docs/ACCOUNTS.md 3.1)
    if (ui.currentOverlay() === 'game-full') ui.showOverlay(null);
    scene.setCourt(m.court); scene.setSide(spec() ? null : side);
    if (spec()) setView(VIEWS.includes(ls.get('poddle.view')) ? ls.get('poddle.view') : 'broadcast', false);
    tourMoving = false; clearTimeout(tourVsT); if (ui.currentOverlay() === 'tour-vs') ui.showOverlay(null);      // the VS card gives way to the court (and its 3-2-1)
    if (botWant != null) { game.send({ type: 'bot', level: botWant }); botWant = null; } else if (AUTOBOT && !noBot && !tourKind) game.send({ type: 'bot' });      // Play a bot: Matt sits down at once, at the level picked in the menu. Never after taking Matt's seat
    noBot = false; ui.askCard(null); ui.askPlay(null); askSync();
    if (askedFor && spec()) { const who = names.find(n => n && n !== 'Matt'); say(who ? `${who} is playing Matt. We asked if you can play.` : 'We asked the player if you can play.', null, 3200); } askedFor = false;
    net.rejoined(); ui.setSpectator(spec()); syncSettings(); drawNames();
    if (cardOpen() && live()) pause(true);                       // a reconnect with a card still open: the server let time run when the socket dropped
    return;
  }
  if (m.type === 'names') {
    const was = names, bot = n => n == null || n === 'Matt'; names = cleanNames(m.names); regs = cleanRegs(m.reg); if ([0, 1].some(i => bot(names[i]) !== bot(was[i]))) { struck = false; if (spec()) ui.askPlay(null); } drawNames(); showView(); askSync();      // a seat changed hands: a fresh match (and a 'refused' Ask to play may be askable again)
    for (const i of [0, 1]) if ((spec() || i !== side) && live() && names[i] && names[i] !== 'Matt' && (!was[i] || was[i] === 'Matt')) ui.joinBanner(names[i], spec() ? i === 1 : true);      // a human sat down: the centre banner names them (a changed name is not news)
    return;
  }
  if (m.type === 'askplay') { if (!spec() && Number.isInteger(m.id)) { askId = m.id; askWho = cleanName(m.name) || 'Someone'; ui.askCard({ name: askWho, left: m.left | 0 }); } return; }      // a spectator asks for Matt's seat: the corner card, 10 s
  if (m.type === 'askoff') { const had = ui.askShowing(); ui.askCard(null); if (m.why === 'gone' && had && live()) say(`${askWho} left`, null, 1800); return; }
  if (m.type === 'askstate') { if (!spec()) return; ui.askPlay(m); const who = names.find(n => n && n !== 'Matt') || 'The player';      // the button counts; this says why, with a name (the one human on the court)
    if (m.s === 'no') say(`${who} said no`, null, 2600); else if (m.s === 'expired') say(`No answer from ${who}`, null, 2600); else if (m.s === 'wait' && m.busy) say('Someone else asked first', null, 2600); return; }
  if (m.type === 'promoff') { if (live()) say(`${cleanName(m.name) || 'They'} wasn’t ready. Matt is back.`, null, 2600); return; }
  if (m.type === 'watcher') { if (live() && !spec()) ui.watcherNote(cleanName(m.name)); return; }      // someone started watching you (the server tells only the players)
  if (m.type === 'emote') { if (live() && Number.isInteger(m.e)) ui.emote(m.e, cleanName(m.name)); return; }      // a spectator's reaction, players and spectators alike see it
  if (m.type === 'state') {
    state = m; frozen = !!m.paused; scene.setFrozen(frozen || holding);
    scene.updateBall(m.p, m.v, m.live, undefined, m.spin, m); if (frozen || holding) net.idle(); else net.packet();      // a stopped room is not a bad link
    if ((m.watchers | 0) !== watchers) ui.setWatchers(watchers = m.watchers | 0);
    setPaused(frozen && !holding); drawNames();
    if (spec()) { askSync(); ui.setScore(m.score[0], m.score[1]); for (const i of [0, 1]) { const o = m.paddles[i]; scene.updatePaddle(i, o ? { x: o.x, y: o.y, z: o.z, q: o.q, offset: null, bot: !!o.bot, status: o.status } : null); } return; }
    if (ui.settings() && noPause !== vsHuman()) ui.setSettings({ canPause: !(noPause = vsHuman()) });      // somebody sat down (or left) while the panel was open: the note follows
    if (forfeits() !== saidForfeit) ui.setSettings({ forfeit: saidForfeit = forfeits() });      // the Leave button says what it costs
    if (live() && !frozen && !holding) serveCoach(m); else svT = 0;      // no serve coaching over a set-up screen or a stopped room; its clock starts again afterwards
    ui.setScore(m.score[side], m.score[1 - side]);
    const o = m.paddles[1 - side]; players = o ? 2 : 1;
    scene.updatePaddle(1 - side, o ? { x: o.x, y: o.y, z: o.z, q: o.q, offset: null, bot: !!o.bot, status: o.status } : null);
    if (frozen && !holding && !cardOpen() && performance.now() > healAt) { healAt = performance.now() + 1000; game.send({ type: 'pause', on: false }); }      // paused with the panel shut (a lost 'pause off', a reload): nobody could ever resume it
    return;
  }
  if (m.type === 'botinfo') {
    const said = botLevel; if (m.active && typeof m.name === 'string') botLevel = m.name.slice(0, 12); drawNames();
    if (m.reason) { if (live() && m.reason !== 'tournament') say('Court is full', null, 1800); } else if (m.active && live() && botLevel !== said && !(spec() && !said)) say(`Matt · ${botLevel}`, null, 1400);      // not on a spectator's arrival: the scoreboard already says the level, and it wiped 'We asked if you can play' in the same breath. A tournament match refuses 'bot' (reason 'tournament'): Matt stays at Tour, nothing to say
    return;
  }
  if (m.type === 'countdown') { ui.countdown(live() ? m.left : 0); return; }      // 3 - 2 - 1 over the court before a match's first serve: nobody is ready for a ball the moment an opponent sits down
  if (m.type === 'left') { ui.countdown(0); const who = lastOpp || nameOf(1 - side); clearFar(); ui.setServe(null); if (live() && !spec()) say(`${who} left`, null, 2200); return; }      // only before a match has started now; mid-match it is a hold or a forfeit
  if (m.type === 'match' || m.type === 'matchover') { ui.countdown(0); struck = votedYes = false; over = m; overAt = performance.now(); votedNo = false; profile.matchover(!!m.tour); if (live()) showOver(); return; }      // 'match': a server from before docs/SPECTATE.md
  if (m.type === 'profile') { if (!spec()) profile.result(m); return; }      // what this match did to my own stats: a line on the result card (docs/ACCOUNTS.md 9.3), to my seat only
  if (m.type === 'rematch') { const v = Array.isArray(m.votes) ? m.votes : []; ui.rematch(spec() ? { left: m.left } : { mine: v[side], theirs: v[1 - side], left: m.left, name: nameOf(1 - side) }); return; }
  if (m.type === 'rematchon') { over = null; struck = false; ms = null; redialDue(); if (ui.currentOverlay() === 'match') ui.showOverlay(null); rally = 0; ui.setRally(0); return; }      // the scores follow in 'state'
  if (m.type === 'hold') { holding = true; scene.setFrozen(true); setPaused(false); if (live()) ui.hold(nameOf(m.side === 1 ? 1 : 0), m.left | 0); return; }      // their wifi dropped: the seat is held, the ball waits where it is
  if (m.type === 'holdoff') { holding = false; ui.hold(null); return; }                     // frozen follows the next 'state'
  if (m.type === 'paused') { if (m.refused) ui.setSettings({ canPause: false }); else { setPaused(!!m.on); scene.setFrozen(!!m.on || holding); } return; }
  if (m.type === 'wait') { if (live() && !holding) ui.hold(nameOf(m.side === 1 ? 1 : 0), m.left | 0); return; }      // the serve waits for a seat that is calibrating mid-match: the last 30 s of its minute are counted down, then it forfeits
  if (m.type === 'waitoff') { if (!holding) ui.hold(null); return; }
  if (m.type === 'hit') { struck = true; stats.hits++; clearTimeout(myBet); myBet = null;
    if (m.side === side && !spec()) { stats.myHits++; myKind = m.kind || 'drive'; const n = +m.n || 0;      // the glow shows what scene.js's trail shows (shownN: a lob white, a bet pale); the buzz keeps the stroke's force
      padFx('hit', shownN(m.bet ? Math.min(n, 0.3) : n, myKind), n); if (m.bet) myBet = setTimeout(() => { myBet = null; padFx('tint', shownN(n, myKind)); }, 300); }      // no settled re-aim in 0.3 s: it flies at the bet
    rally++; ui.setRally(rally); }   // the shot's name only, and only for my own hits
  // Result-card stats (ms): counted for everyone, hidden court or not, the final point included. A bet hit's kind is provisional; a settled
  // 'launch' carries kind only when it changed it (server/game.js), so the kind is committed at that side's next hit or at the point.
  if (m.type === 'hit' && (m.side === 0 || m.side === 1)) { if (!ms) ms = msNew(); msCommit(m.side); ms.kind[m.side] = m.kind || 'drive'; }      // made here, not at the first point, so the first rally's smashes count; one made mid-match fails the sum check below
  if (m.type === 'launch' && ms && m.kind && (m.by === 0 || m.by === 1) && ms.kind[m.by]) ms.kind[m.by] = m.kind;
  if (m.type === 'point' && Array.isArray(m.score)) { const sum = (m.score[0] | 0) + (m.score[1] | 0);
    if (sum === 1) { if (!ms || ms.sum !== 0) ms = msNew(); }                     // a match's first point: a clean start, keeping the first rally's shots (seen whole unless we joined mid-rally)
    else if (ms && sum !== ms.sum + 1) ms = null;                                  // a point was missed: no stats for this match
    if (ms) { ms.sum = sum; msCommit(0); msCommit(1); ms.rally = Math.max(ms.rally, rally);      // rally: this point's hits, the HUD's number ('serve' resets it later)
      const w = m.winner === 1 ? 1 : 0; ms.run[w] = ms.cur === w ? ms.run[w] + 1 : 1; ms.run[1 - w] = 0; ms.cur = w; ms.best[w] = Math.max(ms.best[w], ms.run[w]); } }
  if (m.type === 'serve') { ui.countdown(0); over = null; bodyZ = 6.5; walkV = 0; rally = 0; ui.setRally(0); ui.setServe(m.by === (spec() ? 0 : side) ? 'me' : 'them'); if (ui.currentOverlay() === 'match') ui.showOverlay(null);
    if (m.wait && m.by === side && !spec() && inPlay()) say('Your serve!', null, 2600); }
  if (m.type === 'whiff') stats.whiffs++;                        // no commentary: you can see that you missed
  if (m.type === 'point' && !m.final && live()) {
    if (spec()) ui.pointBanner(null, nameOf(m.winner === 1 ? 1 : 0), m.winner === 1 ? 1 : 0);
    else { const won = m.winner === side; ui.pointBanner(won, nameOf(m.winner === 1 ? 1 : 0)); if (won) ui.confetti(['#3aa0ff', '#ffd34a', '#ffffff']); } }      // "Your point!" / "<name> scores", nothing else
  if (m.type === 'launch' && m.by === side && m.n != null && !spec()) { if (m.kind) myKind = m.kind; clearTimeout(myBet); myBet = null; padFx('tint', shownN(+m.n || 0, myKind)); }      // my hit re-aimed on the settled swing: the phone's glow takes that power's colour
  if (SCENE_EVENTS.includes(m.type)) scene.onEvent(m);           // anything else: ignored, no throw
}, () => { const hi = profile.opened(); if (hi) game.send(hi);      // FIRST on every socket: the device id (docs/ACCOUNTS.md 9.2), never in the URL
  if (pending && !room) game.send(pending);       // the request made while the socket was down
  if (tourOn()) { clearTimeout(tourHang); tourHang = setTimeout(() => { if (tourOn()) endTour('restart'); }, 5000); } });      // a tournament socket back: no room, tour or tourend in 5 s = the server restarted under it (docs/COURTS-TOURNEY.md 4.5)

// ---------- link quality ----------
// The ball already rides out gaps by itself (scene.js coast()). This watches the connection so that (1) a swing can be
// back-dated by the round trip, (2) a struggling link gets half the state packets: over TCP every lost packet stalls
// everything behind it, so fewer packets means fewer stalls, and (3) the player is told it is the wifi, not the game.
const net = (() => {
  const rtts = []; let lastPacket = 0, gaps = 0, late = 0, worst = 0, hz = 60, bad = 0, good = 0, told = false;
  const floor = () => rtts.length ? Math.min(...rtts) : 0;
  setInterval(() => game.send({ type: 'ping', c: performance.now() }), 500);
  setInterval(() => {                                                   // judged every 2 s
    const lateShare = gaps ? late / gaps : 0, rtt = rtts.length ? rtts[rtts.length - 1] : 0, poor = link.g && gaps > 10 && (lateShare > 0.04 || worst > 250 || floor() > 140);
    stats.net = { rtt: Math.round(rtt), floor: Math.round(floor()), late: +lateShare.toFixed(3), worst: Math.round(worst), hz };
    ui.setStat('ping', link.g && rtts.length ? Math.round(rtt) + ' ms' : '-'); ui.setStat('netq', !link.g ? 'offline' : poor ? `weak (worst gap ${Math.round(worst)} ms)` : 'good'); ui.setStat('nethz', hz);
    if (poor) { bad++; good = 0; } else { good++; bad = 0; }
    if (bad >= 2 && hz === 60) { hz = 30; game.send({ type: 'net', hz }); }      // said nowhere: the player cannot do anything about it mid-rally; the ping bars show it
    if (good >= 8 && hz === 30) { hz = 60; game.send({ type: 'net', hz }); }
    gaps = late = worst = 0;
  }, 2000);
  return {
    packet() { const t = performance.now(), g = t - lastPacket; lastPacket = t; if (g > 1000) return; gaps++; if (g > worst) worst = g; if (g > 1000 / hz + 45) late++; },
    pong(m) { const r = performance.now() - m.c; if (r >= 0 && r < 5000) { rtts.push(r); if (rtts.length > 12) rtts.shift(); if (ui.setPing) ui.setPing((room || !LOBBY) && !spec() ? [...rtts].sort((a, b) => a - b)[rtts.length >> 1] : 0); } },      // the median of the last 6 s: a number that sits still
    lag: () => Math.round(floor()),                                     // the quietest recent round trip: queueing spikes are not the link's real delay
    rejoined() { hz = 60; bad = good = 0; rtts.length = 0; },           // a new socket starts at the full rate on the server
    idle() { lastPacket = 0; },                                         // paused or held: the gap to the next live packet is not the link's
  };
})();

setInterval(() => {                               // 20Hz: tell the server where my paddle is
  if (calibrating || !seated() || spec()) return;
  const p = model.pose(performance.now());
  // r: how fast the hand is turning right now. Below the swing trigger nothing is ever reported, so without it a shove
  // into a held-up paddle at the net would be invisible: with it, a still paddle blocks and a push sends the ball deeper.
  if (p.calibrated) game.send({ type: 'paddle', auto: autoNow(), autoY: mode === 'auto', x: bodyX * s(), y: bodyY, z: usingBody() && !autoNow() ? bodyZ : undefined, q: p.Pd, r: Math.round((p.rate || 0) * 10) / 10 });
}, 50);

// ---------- input ----------
let unlocked = false;
// The AudioContext only exists from the first gesture on, so the kept output is applied HERE, not at load. A device that has
// since been unplugged rejects: drop it rather than let the panel name a speaker nothing is playing out of.
const unlock = () => { if (!unlocked) { unlocked = true; scene.unlockAudio(); scene.audio.setMute(!soundOn); if (sinkId) scene.audio.setSink(sinkId).then(ok => { if (!ok) forgetSink('That output is gone: back to the system default'); }); } };
scene.audio.onDevicesChanged(loadSinks);           // an AirPod connecting mid-match changes the list under the open card
addEventListener('pointerdown', () => { unlock(); play(); });
ui.onStart(() => { unlock(); ui.fullscreen(true); play(); });           // the big title button (a click is a user gesture: go full screen)
ui.onLobby({ quick: () => request({ type: 'quick' }), create: pub => request({ type: 'create', public: !!pub }), join: code => request({ type: wantWatch && code === wantRoom ? 'watch' : 'join', code }),      // the code screen of a watch link watches
  watch: code => request({ type: 'watch', code }),             // a Watch button, or Yes on 'Court is full. Watch instead?'
  bot: playBot,
  start: () => { if (room && phase === 'lobby') begin(); }, back, copied: watch => say(watch ? 'Viewer link copied' : 'Invite copied', null, 1600),
  profile: () => profile.showProfile(), view: route });      // Your stats: web/profile.js fetches and draws it
// Player stats (docs/ACCOUNTS.md 9). On only where this page's server keeps them (hosted; ?acctest=1 is test/profile-ui.mjs on localhost).
// Called while this module loads, so the first socket's open already sends the hello. ui calls through ?. : test/menu.mjs stubs ui.js
profile.init({ on: HOSTED && LOBBY || qs.get('acctest') === '1', send: m => game.send(m), redial, toast: (t, ms) => say(t, null, ms), view: () => phase === 'lobby' && ui.currentScreen() === 'lobby' ? ui.lobbyView() : '',
  badge: (el, on) => ui.regBadge?.(el, on), lockName: n => ui.lockName?.(n), stats: openStats,
  bot: level => { if (room || pending) return; if (!myName()) { ui.lobbyView('bot'); return; } playBot(level); } });      // Next: beat Club Matt. No name yet: the bot view, where the name row asks for one
{ const v = LOBBY && wantRoom.length !== 4 && PATH_VIEW[location.pathname]; routing = true; if (v) { play(); if (v !== 'home') ui.lobbyView(v); } }      // a reload on /courts, /stats...: straight back to that view (after profile.init: Your stats fetches through it)
// open(): the device list is re-read every time the card opens, because headphones come and go.
// Keep every handler below on its own line: an end-of-line comment here once swallowed six of them (NOTES 64).
ui.onSettings({
  open: () => { pause(true); setDim(); loadSinks(); },
  close: () => { pause(false); setDim(); },
  sens: dir => sens(dir < 0 ? -1 : 1, true), airpod: setPod, body: setBody, stats: setStats, recenter, leave, name: rename,
  move: m => { if (!MODES.includes(m)) return; if (m === 'body' && !(body && body.ready)) { if (camOn && !body) { if (m !== mode) setMode(m); return; } if (!NO_CAM) { camTurnOn(); if (camPerm !== 'granted' && camPerm !== 'denied') say('Press Allow when your browser asks', null, 2600); } return; } if (m !== mode) setMode(m); },      // how you move is chosen here now, not on the court. Body with no working camera (a No, or it failed) asks for it: Body once it is up. A camera already up (Auto was picked meanwhile) is just used, never asked for twice
  paddle: pickPaddle, sound: setSound, sink: pickSink, findSinks,
  bot: level => { if ([0, 1, 2, 3].includes(level) && !spec()) game.send({ type: 'bot', level }); } });
ui.onView(name => setView(name, true));
ui.onEmote(e => { if (room && spec()) game.send({ type: 'emote', e }); });
ui.onRematch(yes => { if (!room || spec()) return; if (!yes && votedYes) { votedNo = true; return leave(); }      // Leave after Rematch: the server takes one answer each, and a player leaving the vote closes the court for everyone just the same
  votedYes = !!yes; votedNo = !yes; game.send({ type: 'rematch', yes: !!yes });      // Leave = no: the server closes the room for everyone, 'closed' brings us back to the lobby
  if (!yes) { const r = room; setTimeout(() => { if (room === r && votedNo) leave(); }, 3000); } });      // unless it never answers
ui.onRetry(() => location.reload());
function esc() { if (ui.championShowing()) { tourCourts(); return; } if (ui.currentOverlay() === 'tour-vs') return; if (ui.tourCard()) { ui.tourCard(false); return; }
  if (tourKind === 'match' && spec() && live() && !ui.currentScreen() && !ui.currentOverlay() && !ui.settings()) { leave(); return; }      // watching one of its matches: Esc (and T) is back to the bracket
  if (ui.asking()) ui.askWatch(null); else if (live() && !ui.currentScreen()) { if (!ui.currentOverlay()) ui.settings(!ui.settings()); } else back(); }      // in play and while watching Esc is the hamburger
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Tab'].includes(e.key)) return;   // browser shortcuts are not ours
  if (profile.cardOpen()) { if (e.key === 'Escape') profile.closeCard(); return; }      // a sign-in or delete card is up (its own keys stop at the card): no game key behind it
  unlock();
  const k = e.key.toLowerCase();
  if (e.target.tagName === 'INPUT') { if (k === 'escape') esc(); return; }      // typing a room code or a name: F, C, B, M are letters there
  if ((k === 'y' || k === 'n') && ui.askShowing()) { if (!e.repeat) answer(k === 'y'); return; }      // only while the card shows: otherwise Y and N do nothing
  if (k === 'f') { ui.fullscreen(); return; }
  if (phase === 'title') { if (e.repeat) return; if (k === ' ' || k === 'enter') { e.preventDefault(); ui.fullscreen(true); } play(); return; }   // first gesture: any key presses Play
  if (k === 'escape') { esc(); return; }
  if (k === 't' && tour && !e.repeat) { tourKey(); return; }     // T: the tournament (its card in a warm-up; back to the bracket while watching; its screen from the lobby)
  if (phase === 'lobby' || phase === 'camera') return;           // the lobby's keys live in ui.js; game keys wait for a room. On the primer C, B and 1-4 would calibrate or call Matt behind it
  if (k === 'q' && room) { const t = performance.now(); if (t < leaveAt) { game.send({ type: 'leave' }); toLobby(); } else { leaveAt = t + 2500; say(forfeits() ? 'Press Q again to forfeit' : 'Press Q again to leave', null, 2500); } return; }
  if (k === 'h') setStats(!showStats);
  if (spec()) { if ('1234'.includes(k) && !e.repeat) setView(VIEWS[+k - 1], true); else if (k === 'a' && !e.repeat && ui.askCan()) askPlay(); return; }      // A: Ask to play      // watching: 1-4 pick the view (3 again = the other player), F, H, Q Q and Esc. Nothing else
  if (k === 'c') startCal();
  if (k === 'r') recenter();
  if (k === 'p') resetPeaks();
  if (k === 'v') setPod(!showPod);
  if (k === '[' || k === ']') sens(k === ']' ? 1 : -1);          // [ = less sensitive, ] = more (the settings panel's - / +)
  if (k === 'b') game.send({ type: 'bot' });                     // alone: join now. playing the bot: next difficulty
  if ('1234'.includes(k)) game.send({ type: 'bot', level: [0, 1, 3, 2][+k - 1] });      // keys follow the display order: Rookie, Club, Tour, Pro (the wire keeps each level's index)
});
addEventListener('resize', () => scene.resize());

// ---------- render loop: local paddle straight from the model every frame ----------
let lastPos = null;
(function loop(now) {
  requestAnimationFrame(loop);
  const p = model.pose(now);
  if (p.calibrated && seated() && !spec()) {                     // my own paddle: only with a seat of my own
    const mine = state && state.paddles[side];
    const z = mine ? mine.z : s() * 6.5;
    const dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;
    if (usingBody() && body.seen()) {
      [bodyX, vX] = damp(bodyX, Math.max(-3.5, Math.min(3.5, body.x())), vX, 0.085, dt);
      [bodyY, vY] = damp(bodyY, Math.max(0.3, Math.min(2.3, body.y())), vY, 0.085, dt);
      scene.setViewer({ x: bodyX / 3, y: (bodyY - 1) / 1.3 });          // head-coupled camera: the screen is a window onto the court
      // Forward/back is a tilt, like pushing a stick: tip the AirPod forward to walk up to the kitchen, tip it back to
      // retreat, hold it level to stay put. Ignored while the hand is moving fast, and for a moment after a swing.
      if (p.swinging || p.rate > 3.5) walkHold = now + 450;
      const dead = 14 * Math.PI / 180, full = 38 * Math.PI / 180, t = p.tilt;
      const push = now < walkHold || Math.abs(t) < dead ? 0 : Math.sign(t) * Math.min(1, (Math.abs(t) - dead) / (full - dead));
      [walkV] = damp(walkV, push * 3.2, 0, 0.12, dt);                     // ease in and out of walking, m/s
      bodyZ = Math.max(2.6, Math.min(7.2, bodyZ + walkV * dt));          // tilt back (up) = further from the net
    }
    const auto = autoNow() && mine;
    const wx = auto ? mine.x : bodyX * s(), wy = auto || (mine && mode === 'auto') ? mine.y : bodyY;      // not auto means Body sees you: the wrist never moves you
    if (auto && usingBody()) { bodyX = mine.x * s(); bodyY = mine.y; vX = vY = 0; }                 // hand back smoothly when the camera finds you again
    scene.updatePaddle(side, { x: wx, y: wy, z, q: p.Pd, offset: p.offset, bot: false });   // Pd: the bud's real attitude
    if (ui.isVisible('dev')) { ui.setStat('px', (wx * s()).toFixed(1)); ui.setStat('py', wy.toFixed(1)); }
    const pos = [p.x + p.offset[0], p.y + p.offset[1], p.offset[2]];
    if (lastPos && p.swinging) stats.paddlePath += Math.hypot(pos[0] - lastPos[0], pos[1] - lastPos[1], pos[2] - lastPos[2]);
    lastPos = pos;
  }
  if (phase !== 'title' && phase !== 'lobby' && phase !== 'watch' && ui.isVisible('podwrap')) pod.update(p.Pd);      // (the menu camera drifts by itself now: scene.setMenu)
  scene.render(now);
})(performance.now());

addEventListener('error', () => stats.errors++);
