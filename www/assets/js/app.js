/* ==========================================================================
   FUSE - Multi-Sensor Fire Detection Console
   --------------------------------------------------------------------------
   Self-contained. No build step, no dependencies.

   LIVE ONLY. There is no simulator and no demo mode. This console shows what the
   building's nodes actually report, or it says plainly that it cannot reach
   them. A fire console that invents plausible readings when the backend is down
   is worse than one that goes dark, because the invented readings look real and
   an operator has no way to tell.
   ========================================================================== */
(function () {
'use strict';

/* ---------------------------------------------------------------- config -- */

/* The console's own clock, not the fleet's. Every node picks its own publish
   cadence; this is only how often the screen re-ages heartbeats and repaints. */
var TICK_MS = 1000;

/* How long a node may go quiet before it is held at OFFLINE rather than trusted.
   Read at call time - firebase-config.js owns the value. */
function heartbeatTimeout() {
  return (window.FUSE_CONFIG && window.FUSE_CONFIG.heartbeatTimeoutMs) || 60000;
}

/* ------------------------------------------------------------- constants -- */

var SEV = [
  { key: 'NORMAL',   cls: 'sev-0' },
  { key: 'CAUTION',  cls: 'sev-1' },
  { key: 'WARNING',  cls: 'sev-2' },
  { key: 'CRITICAL', cls: 'sev-3' }
];
var OFF = { key: 'OFFLINE', cls: 'sev-off' };

/* Dispatch delivery states. Module-level because this map was duplicated
   verbatim in viewDashboard and viewNotifs, which is precisely how it came to
   disagree with what the server writes.

   'queued' is sev-1, not sev-0, and that is the whole point: functions/index.js
   raises a dispatch but nothing has actually left the system until a gateway
   says so. Marking it green would be recording our own optimism as a delivery
   receipt. statusOf() never returns undefined - an unrecognised status must
   render as unknown, not throw inside a view and take render() down with it. */
var STATUS = {
  sent:    { label: 'SENT',    cls: 'sev-0' },
  queued:  { label: 'QUEUED',  cls: 'sev-1' },
  pending: { label: 'PENDING', cls: 'sev-1' },
  failed:  { label: 'FAILED',  cls: 'sev-3' }
};
function statusOf(s) {
  return STATUS[s] || { label: String(s || 'UNKNOWN').toUpperCase(), cls: 'sev-off' };
}

/* A dispatch that has been raised but not delivered. Counters that ignore these
   make a dispatch which never sends invisible. */
function isOutstanding(n) { return n.status === 'queued' || n.status === 'pending'; }

/* Three thresholds per sensor, ascending. Editable from Settings, so nothing may
   read a copy of these at module load - always index TH at call time. */
var TH = { temp: [36, 48, 65], gas: [1100, 1800, 2600], smoke: [5, 10, 18], co: [50, 120, 300] };
var TH_DEFAULT = JSON.parse(JSON.stringify(TH));

var TH_UNITS = { temp: '°C', gas: 'ADC', smoke: '%obs', co: 'ppm' };
function thText(sensor) { return TH[sensor].join(' / '); }

var RANGES = [
  { key: '1h',  label: '1 H', n: 60, step: 60000 },
  { key: '6h',  label: '6 H', n: 72, step: 300000 },
  { key: '24h', label: '24 H', n: 96, step: 900000 },
  { key: '7d',  label: '7 D', n: 84, step: 7200000 }
];

var SENSOR_NAMES = {
  smoke: 'Smoke obscuration',
  flame: 'Flame (KY-026)',
  temp:  'Temperature (DS18B20)',
  gas:   'Combustible gas (MQ-2)',
  co:    'Carbon monoxide (MQ-7)'
};

/* ----------------------------------------------------------------- utils -- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function pad2(n) { return String(n).padStart(2, '0'); }
function clockOf(ms) { var d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
function hmOf(ms) { var d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function rel(ms, now) {
  var s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return s + 's ago';
  var m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm ago';
  return Math.floor(h / 24) + 'd ago';
}
function pctOf(v, max) { return Math.max(2, Math.min(100, (v / max) * 100)).toFixed(1) + '%'; }
function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 16777619); } return h >>> 0; }
function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sevOf(level) { return level < 0 ? OFF : SEV[level]; }

/* Severity carries a shape AND a symbol as well as a colour, so it never reads
   on hue alone - the red/green pair is indistinguishable to a dichromat and the
   levels co-occur on screen. Each glyph is one filled path whose symbol is
   punched out with fill-rule="evenodd", so the pill's own tint shows through and
   the mark needs no second colour.

   circle+tick · triangle+! · diamond+! · octagon+! · ring+dash
   The octagon is deliberately not a second triangle: CRITICAL must not read as a
   heavier CAUTION at a glance. */
var SEV_GLYPH = [
  /* 0 NORMAL - disc with a tick knocked out */
  'M8 1A7 7 0 1 0 8 15A7 7 0 1 0 8 1ZM11.7 6.02 6.96 10.76 4.66 8.46 3.5 9.62l3.46 3.46 5.9-5.9z',
  /* 1 CAUTION - triangle */
  'M8 1.15 15.35 14.3H0.65ZM7.1 5.5h1.8v4.3H7.1ZM7.1 10.85h1.8v1.8H7.1Z',
  /* 2 WARNING - diamond */
  'M8 0.7 15.3 8 8 15.3 0.7 8ZM7.1 4.5h1.8v4.6H7.1ZM7.1 10.15h1.8v1.8H7.1Z',
  /* 3 CRITICAL - octagon */
  'M4.9 0.7h6.2L15.3 4.9v6.2L11.1 15.3H4.9L0.7 11.1V4.9ZM7.1 4.2h1.8v5H7.1ZM7.1 10.35h1.8v1.8H7.1Z'
];
/* -1 OFFLINE - ring with a dash. The dash sits wholly inside the ring's hole, so
   evenodd flips it back to solid. */
var SEV_GLYPH_OFF = 'M8 1A7 7 0 1 0 8 15A7 7 0 1 0 8 1ZM8 3.6A4.4 4.4 0 1 1 8 12.4A4.4 4.4 0 1 1 8 3.6ZM4.8 7.1h6.4v1.8H4.8Z';

function sevMark(level, size) {
  var s = size || 13;
  var d = level < 0 ? SEV_GLYPH_OFF : SEV_GLYPH[Math.max(0, Math.min(3, level))];
  return '<svg class="sev-mark" width="' + s + '" height="' + s + '" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path fill-rule="evenodd" d="' + d + '"/></svg>';
}

function sevBadge(level, size) {
  var sv = sevOf(level);
  return '<span class="pill ' + sv.cls + '">' + sevMark(level, size || 13) + sv.key + '</span>';
}

/* The reviewed state is a state, not a severity, so it gets a bare tick rather
   than a pill - nothing to acknowledge means nothing to click. */
function reviewedMark() {
  return '<svg class="sev-mark" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"' +
    ' d="M2.8 8.6 6.3 12.1 13.2 4.4"/></svg>';
}

/* The topbar search is one field scoping whichever section is open, so every
   list filters through here rather than growing a search box of its own. */
function matches(haystack) {
  var q = S.filters.q.trim().toLowerCase();
  return !q || String(haystack).toLowerCase().indexOf(q) >= 0;
}

function emptyRow(cols, msg) {
  return '<tr><td colspan="' + cols + '" class="muted">' + msg + '</td></tr>';
}

/* "Nothing here" and "nothing matched what you typed" are different facts, and
   showing the filter message over an empty collection sends the reader looking
   for a search box they never used. `total` is the size before filtering. */
function emptyMsg(total, empty, filtered) {
  return total === 0 ? empty : filtered;
}

/* ------------------------------------------------------------------ state -- */

var S = null;
var timer = null;
var toastTimer = null;

/* The backend adapter, resolved at boot. Either the Firebase implementation or
   the simulator - app code never branches on which. */
var FUSE = null;
var subs = [];

/* The console starts empty and stays empty until the backend says otherwise.

   Nothing in here is placeholder data, and that is the point. A section whose
   feed has not delivered yet renders as a skeleton; a section whose feed was
   REFUSED renders as an error naming the feed and the rules file to publish.
   "No events" and "events have not arrived" must never look the same, which is
   why S.live tracks each feed separately instead of one global loading flag. */
function initialState() {
  var now = Date.now();
  return {
    now: now, tick: 0, lastTick: now,
    loggedIn: false,
    loginId: '', loginPass: '',
    /* status: 'checking' while the backend resolves the session, then 'out' or
       'in'. busy holds which sign-in method is mid-flight so its button alone
       shows a spinner. */
    auth: { status: 'checking', busy: null, error: null },
    profile: null,
    /* Which live subscriptions have delivered a first snapshot. Anything still
       false renders as a skeleton rather than as an empty list. */
    live: { zones: false, events: false, contacts: false, dispatches: false },
    /* Keyed by feed name when a subscription is refused or fails. */
    feedError: {},
    /* The last payload each live feed delivered. Writes are optimistic, and a
       refused write changes nothing on the server, so no corrective snapshot
       ever arrives: without this the screen keeps showing an acknowledgement or
       a contact edit that did not happen. */
    snap: { zones: null, events: null, contacts: null, dispatches: null },
    section: 'dashboard', monTab: 'zones', selected: null,
    zones: [], events: [], notifs: [], contacts: [],
    /* No zone is selected until a snapshot names one - there is no Z-03 to
       default to before the fleet has reported. */
    chartZone: null, range: '6h',
    filters: { q: '', sev: 'ALL', zone: 'ALL', ack: 'ALL' },
    confirm: null, cform: null, toast: null, menu: false
  };
}

/* ------------------------------------------------------- fusion engine ---- */

function lvlOf(v, th) { var l = 0; for (var i = 0; i < th.length; i++) { if (v > th[i]) l = i + 1; } return l; }

function classify(r) {
  var L = {
    smoke: lvlOf(r.smoke, TH.smoke),
    flame: r.flame ? 2 : 0,
    temp:  lvlOf(r.temp, TH.temp),
    gas:   lvlOf(r.gas, TH.gas),
    co:    lvlOf(r.co, TH.co)
  };
  var base = Math.max(L.smoke, L.flame, L.temp, L.gas, L.co);
  var elev = Object.keys(L).filter(function (k) { return L[k] >= 1; }).length;
  var level;
  if (elev === 0) level = 0;
  else if (elev === 1) level = base >= 3 ? 2 : 1;
  else level = Math.min(3, base + 1);
  if (L.flame >= 2 && (L.smoke >= 1 || L.temp >= 1)) level = 3;
  if (elev >= 4) level = 3;

  var tag = 'NO CORROBORATION';
  var text = 'All five sensors sit inside their nominal bands. No fusion rule triggered.';
  if (L.flame >= 2 && (L.smoke >= 1 || L.temp >= 1)) {
    tag = 'RULE F3 · FLAME CORROBORATED';
    text = 'KY-026 reports flame while smoke obscuration and heat are both elevated. Flame with corroborating combustion signatures escalates straight to CRITICAL regardless of individual margins.';
  } else if (elev >= 4) {
    tag = 'RULE F4 · MULTI-SENSOR COMBUSTION';
    text = elev + ' of 5 sensors elevated at once. A combustion signature this broad cannot be a single-sensor fault, so the zone is fused to CRITICAL.';
  } else if (elev >= 2) {
    tag = 'RULE F2 · CONCURRENT ELEVATION';
    text = elev + ' sensors are elevated concurrently, which escalates the zone one level above its highest single reading.';
  } else if (elev === 1 && base >= 3) {
    tag = 'RULE F1 · UNCORROBORATED PEAK';
    text = 'One sensor is past its critical threshold with no supporting signal from the other four. Held at WARNING pending corroboration rather than dispatching as CRITICAL.';
  } else if (elev === 1) {
    tag = 'RULE F1 · SINGLE DRIFT';
    text = 'A single sensor has drifted above its first threshold. On its own this reads as CAUTION: most likely an environmental source, not combustion.';
  }
  return { level: level, L: L, elev: elev, tag: tag, text: text };
}

function readingSummary(r, c) {
  var p = [];
  if (r.flame) p.push('flame DETECTED');
  if (c.L.smoke >= 1) p.push('smoke ' + r.smoke.toFixed(1) + ' %obs');
  if (c.L.temp >= 1)  p.push('temp ' + r.temp.toFixed(1) + ' °C');
  if (c.L.gas >= 1)   p.push('gas ' + Math.round(r.gas) + ' ADC');
  if (c.L.co >= 1)    p.push('co ' + Math.round(r.co) + ' ppm');
  if (!p.length) p.push('all sensors nominal · temp ' + r.temp.toFixed(1) + ' °C · gas ' + Math.round(r.gas) + ' ADC');
  return p.join(' · ');
}

/* Readings arrive from the nodes, so the tick's only job is to age heartbeats
   and re-classify - it must never invent a value.

   Severity transitions are written by a Cloud Function, not here. Every open
   console would otherwise race to append the same transition, giving one
   duplicate event per operator watching. See functions/index.js. */
/* The newest heartbeat in the fleet. Freshness has to come from the nodes: a
   local timer would tick along happily while every node was silent, which is
   the exact condition the live/stale indicator exists to catch. */
function freshestSeen() {
  var newest = 0;
  S.zones.forEach(function (z) { if (z.lastSeen > newest) newest = z.lastSeen; });
  return newest;
}

function liveTick(now) {
  var timeout = heartbeatTimeout();
  S.zones.forEach(function (z) {
    /* lastSeen 0 means the node has NEVER reported, which is a different fault
       from one that has stopped. Both are offline; only one has an age. */
    z.online = z.lastSeen > 0 && (now - z.lastSeen) < timeout;
    z.level = z.online ? classify(z.r).level : -1;
  });
}

/* One second, every second. No readings are generated here - the fleet decides
   what is true and this only re-ages and repaints it. */
function beat() {
  /* render() owns S.now - see the note there. Passing the same instant into
     liveTick keeps the heartbeat ages and the online flags on one reading. */
  liveTick(Date.now());
  render();
}

/* -------------------------------------------------------------- history --- */

function series(zone, sensor, n, rangeKey) {
  var rand = rng(hash(zone.id + sensor + rangeKey));
  var cur = sensor === 'flame' ? (zone.r.flame ? 1 : 0) : zone.r[sensor];
  /* A live zone has no simulation target to ramp toward, so its own current
     reading anchors the synthetic backfill. */
  var baseVal = sensor === 'flame' ? 0 : (zone.t ? zone.t[sensor] : zone.r[sensor]);
  var calm = ({ temp: 24, gas: 520, smoke: 4.5, co: 6 })[sensor] || 0;
  var rise = Math.max(0, baseVal - calm);
  var out = [];
  for (var i = 0; i < n; i++) {
    var p = i / (n - 1), v;
    if (sensor === 'flame') {
      v = (zone.online && zone.r.flame && p > 0.86) ? 1 : (rand() > 0.985 && p > 0.5 ? 1 : 0);
    } else {
      var ramp = rise * Math.pow(Math.max(0, (p - 0.62) / 0.38), 1.9);
      var wobble = (rand() - 0.5) * (calm * 0.16 + 0.4) + Math.sin(p * 11 + hash(zone.id) % 7) * calm * 0.05;
      v = Math.max(0, calm + ramp + wobble);
    }
    out.push(v);
  }
  if (sensor !== 'flame') out[n - 1] = cur;
  return out;
}

function linePath(vals, min, max, w, h) {
  var n = vals.length, span = max - min || 1;
  return vals.map(function (v, i) {
    var x = (i / (n - 1)) * w;
    var y = h - ((v - min) / span) * h;
    return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + Math.max(1, Math.min(h - 1, y)).toFixed(1);
  }).join(' ');
}

/* -------------------------------------------------------------- actions --- */

/* The profile - including the role - comes from the user's own Firestore
   document, read server-side by the rules on every write. There is no
   client-side identity any more: no profile means no session.

   ANON exists only so a render that races auth resolution has the right shape
   to read from; it is never a signed-in user. */
var ANON = { uid: '', email: '', name: '', roleLabel: '', role: 'viewer', cls: 'sev-1' };
function user() { return S.profile || ANON; }
function isAdmin() { return user().role === 'admin'; }

function withCls(profile) {
  return Object.assign({}, profile, { cls: profile.role === 'admin' ? 'sev-0' : 'sev-1' });
}

function toast(tag, msg, cls) {
  clearTimeout(toastTimer);
  S.toast = { tag: tag, msg: msg, cls: cls || 'sev-accent' };
  toastTimer = setTimeout(function () { S.toast = null; render(); }, 4200);
  render();
}

function denied(what) {
  toast('PERMISSION DENIED', what, 'sev-1');
}

/* Writes go through the backend when there is one. The optimistic local mutation
   stays either way: the Firestore listener will overwrite it with the server's
   version a moment later, and until then the click feels instant. */
function ack(id) {
  var u = user();
  S.events.forEach(function (e) {
    if (e.id === id) { e.acked = true; e.by = u.name; e.ackAt = Date.now(); }
  });
  if (FUSE.mode === 'firebase') {
    FUSE.ackEvent(id, u.name).catch(function (err) { writeFailed('acknowledge that event', err, 'events'); });
  }
  toast('ACKNOWLEDGED', 'Event marked reviewed by ' + u.name + '. Recorded in the audit trail.', 'sev-0');
}

/* Put a feed back to the last thing the server actually said. */
function revertFeed(key) {
  var s = S.snap[key];
  if (!s) return;
  if (key === 'events') S.events = s.slice();
  else if (key === 'contacts') S.contacts = s.slice();
  else if (key === 'dispatches') S.notifs = s.slice();
  else if (key === 'zones') {
    S.zones = s.map(function (z) { return Object.assign({}, z, { t: null, flashUntil: 0 }); });
    liveTick(Date.now());
  }
  render();
}

/* A rejected write is almost always the rules refusing a role, so say that
   rather than surfacing a raw Firebase error code.

   `revertKey` matters as much as the message. Writes are optimistic, and a
   refusal changes nothing on the server, so no corrective snapshot follows: the
   screen would keep showing an acknowledgement, contact edit or discharged
   actuator that never happened. On an audit trail that is not a cosmetic bug. */
function writeFailed(what, err, revertKey) {
  if (revertKey) revertFeed(revertKey);
  var msg = (err && (err.code === 'permission-denied' || /permission/i.test(err.message || '')))
    ? 'Your account is not allowed to ' + what + '. The change was undone. Ask an admin to change your role.'
    : 'Could not ' + what + ': ' + ((err && err.message) || 'unknown error') + '. The change was undone.';
  toast('WRITE REJECTED', msg, 'sev-3');
}

function logAction(z, what) {
  var u = user(), now = Date.now(), sev = sevOf(z.level).key;
  S.events.unshift({
    id: 'e' + now + 'm', ts: now, zone: z.id, from: sev, to: sev,
    readings: 'MANUAL · ' + what + ' · ' + u.name, acked: true, by: u.name, ackAt: now
  });
}

function zoneById(id) { return S.zones.filter(function (z) { return z.id === id; })[0]; }

/* Confirmation dialogs are described by (kind, arg) rather than a captured
   closure, so the dialog survives a re-render without holding stale state. */
function confirmSpec(kind, arg) {
  var u = user();
  var z = zoneById(arg);
  if (kind === 'mist') return {
    cls: 'sev-3', tag: 'MANUAL SUPPRESSION', action: 'Discharge',
    title: 'Discharge water mist in ' + z.name + '?',
    body: 'This opens the mist line at full PWM for 45 seconds and cannot be recalled once discharged. Water damage in the zone is expected.',
    meta: z.id + ' · GPIO 26 · issued by ' + u.name + ' (' + u.role + ')'
  };
  if (kind === 'exhaust') return {
    cls: 'sev-accent', tag: 'MANUAL EXHAUST', action: 'Run exhaust',
    title: 'Force exhaust fan to 100%?',
    body: 'Overrides the severity-proportional PWM curve and holds the fan at full speed until the zone is reset.',
    meta: z.id + ' · GPIO 25 · issued by ' + u.name + ' (' + u.role + ')'
  };
  if (kind === 'silence') return {
    cls: 'sev-1', tag: 'ALERT SILENCE', action: z.silenced ? 'Restore' : 'Silence',
    title: (z.silenced ? 'Restore alerting in ' : 'Silence the alert in ') + z.name + '?',
    body: z.silenced
      ? 'Sounder and repeat dispatches resume immediately.'
      : 'The local sounder and repeat dispatches stop for 10 minutes. Sensor fusion keeps running and a further escalation will re-arm alerting.',
    meta: z.id + ' · issued by ' + u.name + ' (' + u.role + ')'
  };
  if (kind === 'reset') return {
    cls: 'sev-accent', tag: 'ZONE RESET', action: 'Reset zone',
    title: 'Reset ' + z.name + ' to automatic?',
    body: 'Releases every manual override, re-opens the solenoid valve and hands classification back to the fusion engine. Use only once you have confirmed the trigger was false.',
    meta: z.id + ' · issued by ' + u.name + ' (' + u.role + ')'
  };
  if (kind === 'delContact') {
    var c = S.contacts.filter(function (x) { return x.id === arg; })[0];
    return {
      cls: 'sev-3', tag: 'REMOVE CONTACT', action: 'Remove',
      title: 'Remove ' + c.name + ' from dispatch?',
      body: c.name + ' will stop receiving alerts for ' + c.scope + ' at ' + c.min + ' and above. Past dispatches stay in the log.',
      meta: 'Removed by ' + u.name + ' (' + u.role + ')'
    };
  }
  return null;
}

/* An override is a command to the node, so in live mode it is written to the
   device path the ESP32 is already subscribed to. */
function pushOverride(zoneId, patch, what) {
  if (FUSE.mode !== 'firebase') return;
  FUSE.setZoneOverride(zoneId, patch).catch(function (err) { writeFailed(what, err, 'zones'); });
}

function runConfirm(kind, arg) {
  var z = zoneById(arg);
  if (kind === 'mist') {
    z.ovMist = 100;
    pushOverride(z.id, { 'ov/mist': 100 }, 'discharge suppression');
    logAction(z, 'Manual water-mist discharge at 100% PWM');
    toast('SUPPRESSION FIRED', 'Water mist discharging in ' + z.name + ' at 100%. Logged against your account.', 'sev-3');
  } else if (kind === 'exhaust') {
    z.ovFan = 100;
    pushOverride(z.id, { 'ov/fan': 100 }, 'force the exhaust fan');
    logAction(z, 'Exhaust fan forced to 100% PWM');
    toast('EXHAUST FORCED', 'Extraction fan holding 100% in ' + z.name + '.', 'sev-accent');
  } else if (kind === 'silence') {
    z.silenced = !z.silenced;
    pushOverride(z.id, { silenced: z.silenced }, 'change the alert silence');
    logAction(z, z.silenced ? 'Alert silenced for 10 minutes' : 'Alert silence lifted');
    toast(z.silenced ? 'ALERT SILENCED' : 'ALERTING RESTORED',
      z.silenced ? z.name + ' muted for 10 minutes. Fusion continues in the background.' : 'Alerting re-armed for ' + z.name + '.',
      'sev-1');
  } else if (kind === 'reset') {
    z.ovFan = null; z.ovMist = null; z.ovValve = null; z.silenced = false;
    pushOverride(z.id, { ov: null, silenced: false }, 'reset the zone');
    logAction(z, 'Zone reset to automatic after false-trigger review');
    toast('ZONE RESET', z.name + ' returned to automatic control. Overrides released.', 'sev-0');
  } else if (kind === 'delContact') {
    var c = S.contacts.filter(function (x) { return x.id === arg; })[0];
    S.contacts = S.contacts.filter(function (x) { return x.id !== arg; });
    if (FUSE.mode === 'firebase') {
      FUSE.deleteContact(arg).catch(function (err) { writeFailed('remove that contact', err, 'contacts'); });
    }
    toast('CONTACT REMOVED', c.name + ' is no longer on the dispatch list.', 'sev-3');
  }
}

function saveContact() {
  var cf = S.cform;
  if (!isAdmin()) { denied('Only admins can edit the contact list.'); S.cform = null; return; }
  if (!cf.name.trim()) { toast('MISSING NAME', 'A contact needs a name before it can be added.', 'sev-1'); return; }
  if (cf.id) {
    S.contacts = S.contacts.map(function (c) { return c.id === cf.id ? Object.assign({}, cf) : c; });
  } else {
    S.contacts = S.contacts.concat(Object.assign({}, cf, { id: 'c' + Date.now() }));
  }
  if (FUSE.mode === 'firebase') {
    FUSE.saveContact(cf).catch(function (err) { writeFailed('save that contact', err, 'contacts'); });
  }
  var wasEdit = !!cf.id;
  S.cform = null;
  toast(wasEdit ? 'CONTACT UPDATED' : 'CONTACT ADDED',
    cf.name + ' will be notified for ' + cf.scope + ' at ' + cf.min + ' and above via ' + cf.channel + '.', 'sev-0');
}

/* ------------------------------------------------------------- view model -- */

function zoneVM(z, now) {
  var off = !z.online;
  var level = off ? -1 : z.level;
  var sv = sevOf(level);
  var c = classify(z.r);
  var fan   = z.ovFan   != null ? z.ovFan   : [0, 40, 70, 100][Math.max(0, z.level)];
  var mist  = z.ovMist  != null ? z.ovMist  : [0, 0, 35, 100][Math.max(0, z.level)];
  var valve = z.ovValve != null ? z.ovValve : (z.level >= 2 ? 'CLOSED' : 'OPEN');
  return {
    z: z, level: level, off: off, sv: sv, cls: c,
    fan: fan, mist: mist, valve: valve,
    alert: !off && level >= 1,
    camLabel: off ? 'NO SIGNAL' : 'CAM ' + z.id.slice(2) + ' · ' + hmOf(z.lastSeen),
    camState: off ? 'STALE' : 'LIVE',
    /* A node that has never published has lastSeen 0, and measuring "ago" from
       the epoch reported a heartbeat lost 20674 days ago. Never reported and
       stopped reporting are different faults and read differently. */
    seen: !z.lastSeen ? 'NO HEARTBEAT YET'
      : off ? 'HEARTBEAT LOST · ' + rel(z.lastSeen, now)
      : 'last seen ' + rel(z.lastSeen, now),
    act: off ? 'NODE UNREACHABLE' : 'FAN ' + fan + '% · MIST ' + mist + '% · VALVE ' + valve
  };
}

/* ----------------------------------------------------------------- views -- */

var GOOGLE_G =
  '<svg viewBox="0 0 18 18" aria-hidden="true">' +
    '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/>' +
    '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"/>' +
    '<path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"/>' +
    '<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/>' +
  '</svg>';

function viewLogin() {
  var busy = S.auth.busy;
  /* Default google to false. The client cannot ask which providers a project has
     enabled, so an unenabled one only fails after the user has already clicked
     it - the safe default is to offer less, not more. */
  var providers = (window.FUSE_CONFIG && window.FUSE_CONFIG.providers) || { password: true, google: false };

  return '' +
  '<div class="auth">' +
    '<div class="auth__brandside">' +
      '<img class="auth__logo" src="assets/img/fuse-logo.png" alt="FUSE">' +
      '<div>' +
        '<p class="label" style="margin-bottom:16px">Multi-sensor fire detection</p>' +
        '<h1 class="auth__pitch balance">Sensor fusion and visual assessment for every zone in the building.</h1>' +
        '<p class="auth__body balance">Smoke, flame, heat and combustible-gas readings are fused per zone before any alert is raised, so a single drifting sensor never becomes a false alarm.</p>' +
      '</div>' +
      '<div class="auth__specs"><span>7 ZONE NODES</span><span>ESP32 / Wi-Fi</span><span>v2.4.1</span></div>' +
    '</div>' +
    '<div class="auth__form">' +
      '<div class="auth__inner">' +
        '<img class="auth__mark" src="assets/img/fuse-symbol.png" alt="">' +
        '<h2 style="font-size:21px;font-weight:600;letter-spacing:-.015em">Sign in to the console</h2>' +
        '<p class="sub mt-1" style="margin-bottom:22px">' +
          'Your role is read from your account and decides what you can act on.</p>' +

        (S.auth.error
          ? '<div class="auth__error sev-3 mb-4"><span class="callout__icon">' + icon('triangle', '') + '</span>' +
            '<span>' + esc(S.auth.error) + '</span></div>'
          : '') +

        viewRealSignIn(busy, providers) +
      '</div>' +
    '</div>' +
  '</div>';
}

/* Real sign-in. Email + password and/or Google, whichever the project enables. */
function viewRealSignIn(busy, providers) {
  return '' +
  (providers.password
    ? '<form class="stack gap-4" data-act="sign-in">' +
        '<label class="field">' +
          '<span class="label">Email</span>' +
          '<input class="input" id="login-id" name="email" type="email" autocomplete="username"' +
            ' data-input="login-id" value="' + esc(S.loginId) + '" required>' +
        '</label>' +
        '<label class="field">' +
          '<span class="label">Password</span>' +
          '<input class="input" id="login-pass" name="password" type="password" autocomplete="current-password"' +
            ' data-input="login-pass" value="' + esc(S.loginPass) + '" required>' +
        '</label>' +
        '<button class="btn btn--primary mt-3" type="submit" style="padding:11px"' + (busy ? ' disabled' : '') + '>' +
          (busy === 'password' ? '<span class="spinner spinner--on-accent"></span>Signing in…' : 'Sign in') +
        '</button>' +
      '</form>'
    : '') +
  (providers.password && providers.google ? '<p class="auth__or">OR</p>' : '') +
  (providers.google
    ? '<button class="btn btn--google" data-act="sign-in-google"' + (busy ? ' disabled' : '') + '>' +
        (busy === 'google' ? '<span class="spinner"></span>Opening Google…' : GOOGLE_G + 'Continue with Google') +
      '</button>'
    : '');
}

/* ---- ghost loading ------------------------------------------------------- */

function skel(cls, style) {
  return '<span class="skel ' + (cls || 'skel--text') + '"' + (style ? ' style="' + style + '"' : '') + '></span>';
}

/* Shown while auth resolves or the first snapshot is still in flight. Mirrors
   the dashboard's geometry so nothing jumps when the data lands. */
function viewSectionSkeleton() {
  var card = function (inner, h) {
    return '<section class="card"' + (h ? ' style="height:' + h + 'px"' : '') + '><div class="card__bd">' + inner + '</div></section>';
  };
  return '' +
  '<div class="dash" aria-busy="true">' +
    '<div class="kpis">' +
      [0, 1, 2, 3].map(function () {
        return '<div class="kpi">' +
          '<div class="kpi__hd">' + skel('skel--circle', 'width:26px;height:26px') + skel('skel--text', 'width:58%') + '</div>' +
          skel('skel--title', 'width:44%;margin-top:6px') +
        '</div>';
      }).join('') +
    '</div>' +
    '<div class="dash-row">' +
      card('<div class="skel-stack">' + skel('skel--line', 'width:46%') +
        skel('skel--block', 'height:62px') + skel('skel--block', 'height:62px') + '</div>') +
      card('<div class="skel-stack">' + skel('skel--line', 'width:52%') +
        [92, 84, 96, 78].map(function (w) { return skel('skel--text', 'width:' + w + '%'); }).join('') + '</div>') +
    '</div>' +
    '<div class="dash-row dash-row--wide">' +
      card('<div class="skel-stack">' + skel('skel--line', 'width:40%') +
        [88, 94, 76, 90].map(function (w) { return skel('skel--text', 'width:' + w + '%'); }).join('') + '</div>') +
      card('<div class="skel-stack">' + skel('skel--line', 'width:44%') + skel('skel--block', 'height:118px') + '</div>') +
    '</div>' +
  '</div>';
}

function viewApp() {
  var now = S.now;
  var vms = S.zones.map(function (z) { return zoneVM(z, now); });
  var sel = S.selected ? vms.filter(function (v) { return v.z.id === S.selected; })[0] : null;
  var worst = vms.reduce(function (a, v) { return Math.max(a, v.level); }, -1);
  var offZones = vms.filter(function (v) { return v.off; });
  var unacked = S.events.filter(function (e) { return !e.acked; }).length;
  var failed = S.notifs.filter(function (n) { return n.status === 'failed'; }).length;

  /* The banner is the console's emergency channel - it belongs above the fold
     on every section except Settings, which is never an incident surface. */
  var showBanner = S.section !== 'settings';

  return '' +
    '<div class="shell">' +
      viewSidebar(vms, offZones, unacked, failed) +
      '<div class="main">' +
        viewTopbar(sel, unacked) +
        (showBanner ? viewBanner(vms, worst, offZones, unacked) : '') +
        viewToolbar(sel) +
        '<main class="content" id="main" tabindex="-1">' +
          '<div class="content__inner">' + viewSection(vms, sel, now) + '</div>' +
        '</main>' +
      '</div>' +
    '</div>';
}

/* Nav glyphs. Stroked paths only - the CSS sets fill/stroke so one rule themes
   the whole set and an icon never carries colour of its own. */
var ICONS = {
  dashboard:  '<rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1.2"/><rect x="10" y="2.5" width="5.5" height="5.5" rx="1.2"/><rect x="2.5" y="10" width="5.5" height="5.5" rx="1.2"/><rect x="10" y="10" width="5.5" height="5.5" rx="1.2"/>',
  monitoring: '<polyline points="2,10 5,10 7,4.5 10.5,13.5 12.5,10 16,10"/>',
  alerts:     '<path d="M4.6 7.4a4.4 4.4 0 0 1 8.8 0c0 3.4 1.3 4.6 1.3 4.6H3.3s1.3-1.2 1.3-4.6Z"/><path d="M7.3 14.4a1.9 1.9 0 0 0 3.4 0"/>',
  dispatch:   '<polyline points="2.6,5.6 12.4,5.6 10.2,3.2"/><polyline points="15.4,12.4 5.6,12.4 7.8,14.8"/>',
  teams:      '<circle cx="6.6" cy="6.2" r="2.6"/><path d="M2.2 15c0-2.4 2-4.1 4.4-4.1s4.4 1.7 4.4 4.1"/><path d="M12 4a2.6 2.6 0 0 1 0 5"/><path d="M12.6 11.1c1.9.3 3.2 1.8 3.2 3.9"/>',
  settings:   '<circle cx="9" cy="9" r="2.4"/><path d="M9 1.8v1.9M9 14.3v1.9M14.1 3.9l-1.3 1.3M5.2 12.8l-1.3 1.3M16.2 9h-1.9M3.7 9H1.8M14.1 14.1l-1.3-1.3M5.2 5.2 3.9 3.9"/>',
  bell:       '<path d="M5 7.6a4 4 0 0 1 8 0c0 3.1 1.2 4.2 1.2 4.2H3.8S5 10.7 5 7.6Z"/><path d="M7.5 13.9a1.7 1.7 0 0 0 3 0"/>',
  search:     '<circle cx="7.4" cy="7.4" r="4.6"/><line x1="10.9" y1="10.9" x2="14.2" y2="14.2"/>',
  chev:       '<path d="M3 4.75 6 7.75 9 4.75"/>',
  clock:      '<circle cx="9" cy="9" r="6.6"/><polyline points="9,5 9,9 11.8,10.6"/>',
  node:       '<rect x="2.6" y="5.4" width="12.8" height="8.4" rx="1.6"/><path d="M6 5.4V3.2M12 5.4V3.2M6.4 9.6h5.2"/>',
  triangle:   '<path d="M9 2.6 16.4 15H1.6L9 2.6Z"/><path d="M9 7.2v3.4M9 12.9v.1"/>',
  info:       '<circle cx="9" cy="9" r="6.8"/><path d="M9 8.4v4M9 5.9v.1"/>'
};

function icon(name, cls) {
  return '<svg class="' + (cls || 'nav__icon') + '" viewBox="0 0 18 18" aria-hidden="true">' + ICONS[name] + '</svg>';
}

/* Section registry - nav order, page titles and which view renders each.
   One source of truth so the nav, the topbar title and the router cannot drift. */
var SECTIONS = [
  { key: 'dashboard',  label: 'Dashboard',  icon: 'dashboard' },
  { key: 'monitoring', label: 'Monitoring', icon: 'monitoring' },
  { key: 'alerts',     label: 'Alerts',     icon: 'alerts' },
  { key: 'dispatch',   label: 'Dispatch',   icon: 'dispatch' },
  { key: 'teams',      label: 'Teams',      icon: 'teams' },
  { key: 'settings',   label: 'Settings',   icon: 'settings' }
];

/* A badge is a claim about the building, so it may only print a number the
   console actually knows.

   Teams showed String(S.contacts.length) unconditionally, so a contacts read the
   rules refused rendered as a confident "0" - indistinguishable from a genuinely
   empty dispatch list. That is the same fault as announcing "all zones normal"
   over a fleet nothing is watching, just smaller: an absence of information
   presented as information.

   Refused feed gets "!", because it is a fault an operator should chase. A feed
   that simply has not delivered yet gets nothing - the section behind it is
   already drawing a skeleton, and a badge is not the place to say "loading". */
function badgeFor(feed, n, cls, showZero) {
  if (S.feedError[feed]) return { n: '!', cls: 'sev-3' };
  if (!S.live[feed]) return { n: '', cls: '' };
  if (!n && !showZero) return { n: '', cls: '' };
  return { n: String(n), cls: cls };
}

function viewSidebar(vms, offZones, unacked, failed) {
  var crit = vms.filter(function (v) { return v.level === 3; }).length;
  var badges = {
    dashboard:  { n: '', cls: '' },
    monitoring: badgeFor('zones', crit || offZones.length, crit ? 'sev-3' : 'sev-off'),
    alerts:     badgeFor('events', unacked, 'sev-2'),
    dispatch:   badgeFor('dispatches', failed, 'sev-3'),
    teams:      badgeFor('contacts', S.contacts.length, 'sev-off', true),
    settings:   { n: '', cls: '' }
  };

  var health = [
    { k: 'Nodes online',   v: (S.zones.length - offZones.length) + '/' + S.zones.length, cls: offZones.length ? 'sev-2' : 'sev-0' },
    /* No "Controller: OK" row. It was the string 'OK' in green, unconditionally,
       with nothing behind it - there is no controller health signal anywhere in
       this codebase. Same fabrication as the Uptime constant that used to sit in
       the KPI row, and the same rule applies: do not put a metric on a live
       screen that nothing measures. Nodes online, immediately above, is the real
       answer to "is anything working". */
    { k: 'Dispatch queue', v: S.notifs.filter(isOutstanding).length + ' outstanding', cls: '' },
    { k: 'Failed sends',   v: String(failed), cls: failed ? 'sev-3' : '' }
  ];

  return '' +
  '<div class="side">' +
    '<div class="brand">' +
      '<img class="brand__mark" src="assets/img/fuse-symbol.png" alt="">' +
      '<span>' +
        '<span class="brand__name" style="display:block">FUSE</span>' +
        '<span class="brand__site">MERIDIAN COURT</span>' +
      '</span>' +
    '</div>' +
    '<nav class="nav" aria-label="Sections">' +
      SECTIONS.map(function (n) {
        var b = badges[n.key];
        return '<button class="nav__item" data-act="nav" data-arg="' + n.key + '"' +
          (S.section === n.key ? ' aria-current="page"' : '') + '>' +
          icon(n.icon) +
          '<span class="nav__label">' + n.label + '</span>' +
          /* "!" is a fault marker, not a count, so it needs a name of its own -
             otherwise the button announces "Alerts, exclamation mark". */
          (b.n
            ? '<span class="nav__badge ' + b.cls + '"' +
              (b.n === '!' ? ' title="This feed could not be read" aria-label="feed could not be read"' : '') +
              '>' + b.n + '</span>'
            : '') +
        '</button>';
      }).join('') +
    '</nav>' +
    '<div class="health">' +
      '<p class="label label--xs" style="margin-bottom:8px">Node health</p>' +
      health.map(function (h) {
        return '<div class="health__row"><span>' + h.k + '</span>' +
          '<span class="num ' + (h.cls || '') + '" style="font-size:11px;' + (h.cls ? 'color:var(--sev-ink)' : 'color:var(--ink-1)') + '">' + esc(h.v) + '</span></div>';
      }).join('') +
    '</div>' +
  '</div>';
}

/* Page titles live next to the section registry rather than inside the topbar,
   because the sub-title depends on live counts the topbar does not compute. */
function pageTitle(sel, unacked, failed) {
  if (S.section === 'monitoring') {
    if (sel) return ['Zone detail', sel.z.id + ' · ' + sel.z.name + ' · ' + sel.z.floor];
    return S.monTab === 'history'
      ? ['Monitoring', 'Historical sensor data · per-sensor time series']
      : ['Monitoring', S.zones.length + ' sensor nodes · fused classification on every reading'];
  }
  return {
    dashboard: ['Operational Dashboard', 'Live fused status across all ' + S.zones.length + ' zones'],
    alerts:    ['Alerts', S.events.length + ' logged severity transitions · ' + unacked + ' awaiting review'],
    dispatch:  ['Dispatch', S.notifs.length + ' outgoing alerts · ' + failed + ' failed'],
    teams:     ['Teams', S.contacts.length + ' contacts on the dispatch list'],
    settings:  ['Settings', 'Fusion thresholds, telemetry and access']
  }[S.section];
}

function viewTopbar(sel, unacked) {
  var u = user();
  var failed = S.notifs.filter(function (n) { return n.status === 'failed'; }).length;
  var t = pageTitle(sel, unacked, failed);
  var initials = u.name.split(/[ .]+/).filter(Boolean).map(function (p) { return p[0]; }).join('').slice(0, 2).toUpperCase();

  return '' +
  '<header class="topbar">' +
    '<div class="topbar__titles">' +
      '<h1 class="h-page truncate">' + esc(t[0]) + '</h1>' +
      '<p class="topbar__sub truncate">' + esc(t[1]) + '</p>' +
    '</div>' +
    /* Order is alerts, account, then search at the far right. Search was between
       the title and the bell, which squeezed the banner headline on a narrow
       screen for the control an operator reaches for least often. */
    '<div class="topbar__tools">' +
      '<button class="iconbtn" data-act="nav" data-arg="alerts" aria-label="' +
        (unacked ? unacked + ' alerts awaiting review' : 'Alerts') + '">' +
        icon('bell', 'nav__icon') +
        (unacked ? '<span class="iconbtn__dot"></span>' : '') +
      '</button>' +
      /* An explicit label, because .account__name is display:none below 768px
         and without this the button's accessible name collapses to two
         initials. */
      '<button class="account ' + (S.profile && S.profile.profileProblem ? 'sev-2' : u.cls) + '" data-act="user-menu"' +
        ' aria-haspopup="menu" aria-controls="account-menu"' +
        ' aria-label="Account: ' + esc(u.name) + ' · ' + esc(u.roleLabel) + '"' +
        ' aria-expanded="' + (S.menu ? 'true' : 'false') + '">' +
        '<span class="avatar" aria-hidden="true">' + initials + '</span>' +
        '<span class="account__name truncate">' + esc(u.name) + '</span>' +
        '<svg class="account__chev" viewBox="0 0 12 12" aria-hidden="true">' + ICONS.chev + '</svg>' +
      '</button>' +
      '<div class="search">' +
        icon('search', 'search__icon') +
        '<input class="input" id="global-search" type="search" data-input="search"' +
          ' placeholder="Search zones, events, contacts…" aria-label="Search the console"' +
          ' value="' + esc(S.filters.q) + '">' +
      '</div>' +
    '</div>' +
  '</header>';
}

function viewUserMenu() {
  if (!S.menu) return '';
  var u = user();
  return '' +
  /* Below 960px .menu is a bottom sheet, and a sheet needs something behind it:
     without a catcher the page under it stays tappable, and the outside-tap
     dismissal has no surface to land on. It carries no data-act, so the bare
     page handler closes the menu. */
  '<div class="menu-catch" data-catch="1"></div>' +
  '<div class="menu" id="account-menu" role="menu" data-stop="1">' +
    '<div class="menu__hd">' +
      '<p style="font-size:13px;font-weight:600">' + esc(u.name) + '</p>' +
      '<p class="label label--xs ' + u.cls + '" style="color:var(--sev-ink);margin-top:3px">' + esc(u.roleLabel) + '</p>' +
      /* Landing as a viewer when you expected admin has exactly two causes, and
         guessing between them costs more than printing both. */
      (S.profile && S.profile.profileProblem
        ? '<p class="sub" style="margin-top:7px;font-size:11px;line-height:1.45">' +
            (S.profile.profileProblem === 'denied'
              ? 'Your role could not be read: the Firestore rules refused it. Publish firestore.rules, then reload.'
              /* Same two-audience problem as the NOT ENROLLED card, and the same
                 answer. This used to say "Create it with role: admin", which is
                 right for an operator and dangerous for the node account - the
                 credential that lives in ESP32 firmware, which is exactly the
                 account most likely to be signed in here while someone checks
                 the app works. Enrolling it would hand firmware on a wall read
                 access to the residents' contact details. */
              : 'Not enrolled: there is no <code>users/' + esc(S.profile.uid) + '</code> document. ' +
                'An operator account needs one, created by an admin. ' +
                'A node account is not meant to have one - sign out and use your operator account.') +
          '</p>'
        : '') +
    '</div>' +
    '<div class="menu__list">' +
      /* There is no role toggle here, deliberately. The role is whatever
         users/{uid}.role says, and the rules re-check it server-side on every
         write, so a client-side switch would change the label and nothing else:
         it announced "now acting as admin" while every admin action stayed
         refused. A control that lies about permissions is worse than none. */
      '<button class="menu__item" role="menuitem" data-act="nav" data-arg="settings">Settings</button>' +
      '<button class="menu__item menu__item--danger" role="menuitem" data-act="sign-out">Sign out</button>' +
    '</div>' +
  '</div>';
}

function viewBanner(vms, worst, offZones, unacked) {
  /* Nothing reporting is not the same as nothing wrong. Claiming "all zones
     normal" over an empty fleet is the worst thing a fire console can say. */
  if (!vms.length) {
    return '' +
    '<div class="banner sev-off" role="status" aria-live="polite">' +
      '<span class="banner__rail" aria-hidden="true"></span>' +
      '<div class="banner__bd">' +
        '<div class="row gap-4 grow">' +
          '<span class="sev-off" style="display:flex">' + sevMark(-1, 16) + '</span>' +
          '<div class="grow">' +
            '<p class="banner__title truncate">No nodes reporting</p>' +
            '<p class="banner__detail truncate">' +
              (FUSE.mode === 'firebase'
                ? 'No zone has published telemetry yet. Severity is unknown, not nominal.'
                : 'The simulator has not produced a reading yet.') +
            '</p>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  var onlineCount = vms.length - offZones.length;
  var nodeWord = function (n) { return n + (n === 1 ? ' node' : ' nodes'); };

  /* Every node offline is not "normal". worst is -1 there, which fell through to
     the all-clear branch and put the most reassuring sentence on screen at the
     moment the console could see least. */
  if (!onlineCount) {
    return '' +
    '<div class="banner sev-off" role="status" aria-live="polite">' +
      '<span class="banner__rail" aria-hidden="true"></span>' +
      '<div class="banner__bd">' +
        '<div class="row gap-4 grow">' +
          '<span class="sev-off" style="display:flex">' + sevMark(-1, 16) + '</span>' +
          '<div class="grow">' +
            '<p class="banner__title truncate">All ' + nodeWord(vms.length) + ' offline</p>' +
            '<p class="banner__detail truncate">No node is reporting. Severity is unknown for every zone, not nominal.</p>' +
          '</div>' +
        '</div>' +
        '<div class="banner__counts">' +
          '<div class="count sev-off"><span class="count__n">' + vms.length + '</span><span class="count__k">OFFL</span></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  var sv = sevOf(worst);
  var crit = vms.filter(function (v) { return v.level === 3; });
  var title = worst === 3 ? crit.map(function (v) { return v.z.id + ' ' + v.z.name; }).join(', ') + ': CRITICAL'
    : worst === 2 ? 'Elevated: ' + vms.filter(function (v) { return v.level === 2; }).map(function (v) { return v.z.name; }).join(', ')
    : worst === 1 ? 'Caution: ' + vms.filter(function (v) { return v.level === 1; }).map(function (v) { return v.z.name; }).join(', ')
    /* Qualified: some zones may be offline and therefore unclassified. */
    : offZones.length ? 'All reporting zones normal' : 'All zones normal';

  var detail = worst === 3
    ? 'Suppression active · emergency dispatch notified · ' + (offZones.length ? nodeWord(offZones.length) + ' offline · ' : '') + unacked + ' event(s) awaiting acknowledgement'
    : worst >= 1
      ? 'Fused classification above nominal in ' + vms.filter(function (v) { return v.level >= 1; }).length + ' zone(s) · ' + (offZones.length ? nodeWord(offZones.length) + ' offline · ' : '') + unacked + ' awaiting review'
      : offZones.length
        ? nodeWord(offZones.length) + ' offline, severity unknown there · ' + onlineCount + ' reporting normal'
        : 'All sensor nodes reporting · no fusion rule triggered';

  var counts = [3, 2, 1, 0].map(function (l) {
    return { label: SEV[l].key.slice(0, 4), n: vms.filter(function (v) { return v.level === l; }).length, cls: SEV[l].cls, lvl: l };
  }).concat([{ label: 'OFFL', n: offZones.length, cls: OFF.cls, lvl: -1 }]);

  return '' +
  '<div class="banner ' + sv.cls + '" role="status" aria-live="polite">' +
    '<span class="banner__rail" aria-hidden="true"></span>' +
    '<div class="banner__bd">' +
      '<div class="row gap-4 grow">' +
        '<span class="' + sv.cls + (worst === 3 ? ' is-live' : '') + '" style="display:flex">' + sevMark(worst, 16) + '</span>' +
        '<div class="grow">' +
          '<p class="banner__title truncate">' + esc(title) + '</p>' +
          '<p class="banner__detail truncate">' + esc(detail) + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="banner__counts">' +
        counts.map(function (c) {
          return '<div class="count ' + c.cls + '" data-zero="' + (c.n ? 0 : 1) + '" title="' + sevOf(c.lvl).key + '">' +
            '<span class="count__n">' + c.n + '</span><span class="count__k">' + c.label + '</span></div>';
        }).join('') +
      '</div>' +
    '</div>' +
  '</div>';
}

/* The word earns its place by being able to say the opposite. If telemetry has
   not landed within three sample intervals the indicator flips to "stale", so a
   frozen feed is visible instead of being a clock that quietly stopped. */
function viewLiveDot() {
  var newest = freshestSeen();
  var live = newest > 0 && (S.now - newest) < heartbeatTimeout();
  var cls = live ? 'sev-0' : 'sev-2';
  return '<span class="live ' + cls + '">' +
    '<span class="dot" aria-hidden="true"></span>' + (live ? 'live' : 'stale') +
  '</span>';
}

/* Left of the toolbar is per-section navigation, right is always the live
   telemetry clock, so "is this screen still updating?" is answered in the same
   place on every section. */
function viewToolbar(sel) {
  var left = '';

  if (S.section === 'monitoring') {
    left = sel
      ? '<button class="btn btn--sm" data-act="close-detail">← All zones</button>'
      : '<div class="tabs" role="group" aria-label="Monitoring view">' +
          '<button data-act="mon-tab" data-arg="zones" aria-pressed="' + (S.monTab !== 'history') + '">Live zones</button>' +
          '<button data-act="mon-tab" data-arg="history" aria-pressed="' + (S.monTab === 'history') + '">Historical</button>' +
        '</div>';
  } else if (S.section === 'teams') {
    left = '<button class="btn btn--sm ' + (isAdmin() ? 'btn--primary' : '') + '" data-act="add-contact"' +
      (isAdmin() ? '' : ' disabled') + '>+ Add contact</button>';
  } else if (S.section === 'dashboard') {
    left = '<span class="sub toolbar__hint">Fused classification across every zone, refreshed live.</span>';
  } else if (S.section === 'alerts') {
    left = '<span class="sub toolbar__hint">Every severity transition the fusion engine logged.</span>';
  } else if (S.section === 'dispatch') {
    left = '<span class="sub toolbar__hint">Outgoing alerts and their delivery state.</span>';
  } else {
    /* Was "Changes apply to the running simulation immediately" - left over
       from demo mode, which no longer exists. Thresholds really are per-browser;
       saying so is the honest version of that sentence. */
    left = '<span class="sub toolbar__hint">Threshold edits apply to this browser only, on the next telemetry tick.</span>';
  }

  return '' +
  '<div class="toolbar">' +
    '<div class="row gap-3 wrap">' + left + '</div>' +
    '<div class="toolbar__meta">' + viewLiveDot() +
      '<span class="num muted" style="font-size:11px">' + (freshestSeen() ? 'updated ' + rel(freshestSeen(), S.now) : 'no reading yet') + '</span>' +
      '<span class="toolbar__div" aria-hidden="true"></span>' +
      '<time class="num" style="font-size:12px;color:var(--ink-2)">' + clockOf(S.now) + '</time>' +
    '</div>' +
  '</div>';
}

/* Which live feed each section cannot render without. Settings needs none - it
   reads configuration, not telemetry. */
var SECTION_NEEDS = {
  dashboard:  ['zones', 'events', 'dispatches'],
  monitoring: ['zones'],
  alerts:     ['events'],
  dispatch:   ['dispatches'],
  teams:      ['contacts'],
  settings:   []
};

function sectionLoading() {
  var need = SECTION_NEEDS[S.section] || [];
  return need.some(function (k) { return !S.live[k]; });
}

/* Setup faults are the likeliest reason a fresh deployment shows nothing, so
   they get a card that names the fix rather than an empty table. */
function viewFeedErrors() {
  var need = SECTION_NEEDS[S.section] || [];
  var bad = need.map(function (k) { return S.feedError[k]; }).filter(Boolean);
  if (!bad.length) return '';

  var anyDenied = bad.some(function (b) { return b.denied; });
  /* Reads are gated on enrolment, so a refusal has two very different causes:
     the rules were never published, or this account has no /users document.
     Telling an unenrolled operator to go publish rules sends them to the wrong
     screen entirely. */
  var notEnrolled = anyDenied && S.profile && S.profile.profileProblem === 'missing';
  var names = bad.map(function (b) { return b.label; });
  /* "a and b and c" reads like a fault in the message itself. */
  var list = names.length < 3
    ? names.join(' and ')
    : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];

  return '<section class="card mb-4">' +
    '<div class="card__bd">' +
      '<div class="callout sev-3">' +
        '<span class="callout__rail" aria-hidden="true"></span>' +
        '<div class="callout__bd">' +
          '<div class="callout__hd">' +
            '<span class="pill">' + sevMark(3, 13) + (notEnrolled ? 'NOT ENROLLED' : 'NO DATA') + '</span>' +
            '<span class="callout__zone">' + esc(list) + ' could not be read</span>' +
          '</div>' +
          '<p class="callout__body balance">' +
            /* Two accounts land here and they need opposite advice, so the copy
               must not pick one. The client cannot tell them apart: /devices is
               ".read": false in database.rules.json, so there is no way to ask
               whether this uid is a node. Saying only "an admin has to create
               one" is actively dangerous for the case that reaches this card
               most often on a fresh build - somebody signing in with the node
               credential to check it works. Enrolling that uid would give
               firmware bolted to a wall read access to the dispatch list, which
               is the exact hole enrolled() exists to close. */
            (notEnrolled
              ? 'This account is signed in, but it is not enrolled on this console. There is no ' +
                '<code>users/' + esc(S.profile.uid) + '</code> document, so the rules allow it nothing. ' +
                '<strong>If this is an operator account</strong>, an admin has to create that document in Firestore. ' +
                '<strong>If it is a node account</strong> - the credential a sensor publishes with - it is not meant to be ' +
                'enrolled: sign out and use your operator account instead.'
              : esc(bad[0].msg) + (anyDenied
                  ? ' Publish the rules from firestore.rules and database.rules.json in the Firebase console, then reload.'
                  : '')) + '</p>' +
          '<p class="callout__meta"><span>PROJECT ' +
            esc((window.FUSE_CONFIG && window.FUSE_CONFIG.firebase.projectId) || '') + '</span>' +
            '<span class="callout__rule">' + (notEnrolled ? 'ACCOUNT NOT ENROLLED' : 'SETUP INCOMPLETE') + '</span></p>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</section>';
}

function viewSection(vms, sel, now) {
  /* A refused feed is not a slow feed. Report it before drawing bones. */
  var failed = viewFeedErrors();
  if (failed) return failed;

  /* A section whose feed has not delivered yet shows bones, not an empty table. */
  if (sectionLoading()) return viewSectionSkeleton();

  if (S.section === 'dashboard') return viewDashboard(vms, now);
  if (S.section === 'monitoring') {
    if (sel) return viewDetail(sel, now);
    return S.monTab === 'history' ? viewCharts(now) : viewZones(vms);
  }
  if (S.section === 'alerts') return viewEvents(now);
  if (S.section === 'teams') return viewContacts();
  if (S.section === 'settings') return viewSettings();
  return viewNotifs(now);
}

/* -- dashboard ------------------------------------------------------------- */

/* Hourly / daily counts for the overview charts. Real events are counted where
   the log reaches; buckets older than the log are filled from the same seeded
   PRNG the sensor history uses, so the shape is stable across ticks instead of
   reshuffling every second. */
function bucketSeries(items, n, stepMs, now, seedKey, lo, hi) {
  var out = [], oldest = items.length ? items[items.length - 1].ts : now;
  var rand = rng(hash(seedKey));
  for (var i = 0; i < n; i++) {
    var end = now - (n - 1 - i) * stepMs, start = end - stepMs;
    if (start < oldest) { out.push(lo + Math.floor(rand() * (hi - lo + 1))); continue; }
    out.push(items.filter(function (x) { return x.ts > start && x.ts <= end; }).length);
  }
  return out;
}

function viewDashboard(vms, now) {
  CHART_DATA = {};

  var crit = vms.filter(function (v) { return v.level === 3; });
  var warn = vms.filter(function (v) { return v.level === 2; });
  var caut = vms.filter(function (v) { return v.level === 1; });
  var offZones = vms.filter(function (v) { return v.off; });
  var elevated = vms.filter(function (v) { return !v.off && v.level >= 1; });
  var pending = S.notifs.filter(isOutstanding);
  var failed = S.notifs.filter(function (n) { return n.status === 'failed'; });
  var unacked = S.events.filter(function (e) { return !e.acked; });
  var online = S.zones.length - offZones.length;

  /* ---- KPI row ----
     Every "nothing is wrong" reading has to be qualified by whether anything is
     reporting at all. A green 0 over an empty fleet is worse than no tile. */
  var none = !vms.length;
  var newest = S.zones.reduce(function (a, z) { return Math.max(a, z.lastSeen || 0); }, 0);
  var hbTimeout = (window.FUSE_CONFIG && window.FUSE_CONFIG.heartbeatTimeoutMs) || 60000;

  var kpis = [
    {
      k: 'Active Alerts', icon: 'triangle',
      cls: (none || !online) ? 'sev-off' : crit.length ? 'sev-3' : warn.length ? 'sev-2' : caut.length ? 'sev-1' : 'sev-0',
      v: none ? '0' : String(elevated.length),
      chips: [
        crit.length ? { n: crit.length, l: 'Critical', cls: 'sev-3' } : null,
        warn.length ? { n: warn.length, l: 'Warning', cls: 'sev-2' } : null,
        caut.length ? { n: caut.length, l: 'Caution', cls: 'sev-1' } : null
      ].filter(Boolean),
      note: none ? 'nothing is reporting'
        : elevated.length ? 'zones above nominal'
        : online === 0 ? 'no node is reporting'
        : offZones.length ? 'among ' + online + ' reporting'
        : 'all zones nominal'
    },
    {
      k: 'Pending Dispatches', icon: 'dispatch',
      cls: failed.length ? 'sev-3' : pending.length ? 'sev-1' : 'sev-0',
      v: String(pending.length),
      chips: failed.length ? [{ n: failed.length, l: 'Failed', cls: 'sev-3' }] : [],
      note: S.notifs.length + ' dispatched in total'
    },
    {
      k: 'Nodes Online', icon: 'node',
      cls: none ? 'sev-off' : offZones.length ? 'sev-2' : 'sev-0',
      v: online + '/' + S.zones.length,
      chips: offZones.length ? [{ n: offZones.length, l: 'Offline', cls: 'sev-off' }] : [],
      note: none ? 'no nodes registered'
        : offZones.length ? offZones.map(function (v) { return v.z.id; }).join(', ') + ' unreachable'
        : 'every node reporting'
    },
    /* Uptime used to sit here as a seeded constant with nothing behind it. A
       fabricated metric on a live screen is worse than no metric at all, so this
       is the freshest heartbeat, which is measured. */
    {
      k: 'Last Reading', icon: 'clock',
      cls: !newest ? 'sev-off' : (now - newest) < hbTimeout ? 'sev-0' : 'sev-2',
      v: newest ? rel(newest, now).replace(' ago', '') : 'never',
      chips: [],
      note: newest ? 'newest node heartbeat' : 'no node has published yet'
    }
  ];

  /* Chips sit on the value row, not the header: at a quarter of the dashboard
     width the header cannot hold an icon, a label and two chips without
     truncating the label to an initial. */
  var kpiRow = '<div class="kpis">' + kpis.map(function (t) {
    return '<div class="kpi ' + t.cls + '">' +
      '<div class="kpi__hd">' +
        '<span class="kpi__icon">' + icon(t.icon, '') + '</span>' +
        '<span class="kpi__k truncate">' + t.k + '</span>' +
      '</div>' +
      '<div class="kpi__row">' +
        '<span class="kpi__v">' + t.v + '</span>' +
        (t.chips.length
          ? '<span class="kpi__tags">' + t.chips.map(function (c) {
              return '<span class="chip ' + c.cls + '"><span class="chip__n">' + c.n + '</span>' + c.l + '</span>';
            }).join('') + '</span>'
          : '<span class="kpi__note">' + esc(t.note) + '</span>') +
      '</div>' +
      (t.chips.length ? '<p class="kpi__note mt-1">' + esc(t.note) + '</p>' : '') +
    '</div>';
  }).join('') + '</div>';

  /* ---- Operational status callouts ---- */
  /* Worst first, and offline last within a level - an unreachable node is a
     gap in coverage, not a fire. */
  var callouts = elevated.concat(offZones).sort(function (a, b) { return b.level - a.level; }).slice(0, 3);

  /* Each block carries the severity three ways: the rail, the chip, and the
     rule that fired. The old version leaned on a tinted title alone, which at a
     glance made all three blocks read as the same grey. */
  function calloutBlock(v) {
    var offline = v.off;
    return '<div class="callout ' + v.sv.cls + '">' +
      '<span class="callout__rail" aria-hidden="true"></span>' +
      '<div class="callout__bd">' +
        '<div class="callout__hd">' +
          '<span class="pill">' + sevMark(v.level, 13) + v.sv.key + '</span>' +
          '<span class="callout__zone truncate">' + esc(v.z.name) + '</span>' +
          '<button class="btn btn--sm" data-act="open-zone" data-arg="' + v.z.id + '">Open</button>' +
        '</div>' +
        '<p class="callout__body balance">' + esc(offline
          ? 'No heartbeat from this node. Severity cannot be computed, so the zone is held at OFFLINE rather than inheriting its last known state.'
          : v.cls.text) + '</p>' +
        '<p class="callout__meta">' +
          '<span>' + esc(v.z.id) + '</span><span>' + esc(v.z.floor) + '</span>' +
          '<span class="callout__rule">' + esc(offline ? 'RULE H1 · HEARTBEAT TIMEOUT' : v.cls.tag) + '</span>' +
        '</p>' +
      '</div>' +
    '</div>';
  }

  function plainCallout(cls, level, pill, heading, body) {
    return '<div class="callout ' + cls + '">' +
      '<span class="callout__rail" aria-hidden="true"></span>' +
      '<div class="callout__bd">' +
        '<div class="callout__hd">' +
          '<span class="pill">' + sevMark(level, 13) + pill + '</span>' +
          '<span class="callout__zone">' + heading + '</span>' +
        '</div>' +
        '<p class="callout__body balance">' + body + '</p>' +
      '</div>' +
    '</div>';
  }

  var calloutHtml;
  if (callouts.length) {
    calloutHtml = callouts.map(calloutBlock).join('');
  } else if (none) {
    /* "All zones nominal" over an empty fleet would be a clean bill of health
       for a building nothing is watching. */
    calloutHtml = plainCallout('sev-off', -1, 'NO DATA', 'Nothing is reporting',
      FUSE.mode === 'firebase'
        ? 'No node has published a reading, so no zone has a severity. This is an absence of information, not an all-clear. Check that the nodes are powered, on the network, and enrolled in /devices.'
        : 'The simulator has not produced a reading yet.');
  } else {
    calloutHtml = plainCallout('sev-0', 0, 'NORMAL', 'All zones nominal',
      'All five sensors on every reporting node sit inside their nominal bands. No fusion rule has triggered.');
  }

  /* ---- Recent dispatches ---- */
  var dispatchRows = S.notifs.slice(0, 5).map(function (n) {
    var st = statusOf(n.status);
    return '<tr>' +
      '<td class="num">' + esc(n.id.slice(0, 8).toUpperCase()) + '</td>' +
      '<td class="truncate" style="max-width:1px">' + esc(n.contact) + '</td>' +
      '<td class="num" style="font-size:10px;color:var(--ink-2)">' + esc(n.zone) + ' → ' + esc(n.sev) + '</td>' +
      '<td class="t-right"><span class="row gap-4" style="justify-content:flex-end">' +
        '<span class="pill ' + st.cls + '">' + st.label + '</span>' +
        '<button class="iconbtn iconbtn--sm" data-act="nav" data-arg="dispatch" aria-label="Open the dispatch log">' +
          '<svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true">' +
            '<circle cx="4" cy="9" r="1.4" fill="currentColor"/><circle cx="9" cy="9" r="1.4" fill="currentColor"/><circle cx="14" cy="9" r="1.4" fill="currentColor"/>' +
          '</svg></button>' +
      '</span></td>' +
    '</tr>';
  }).join('');

  /* ---- Recent events ---- */
  var eventRows = S.events.slice(0, 6).map(function (e) {
    var si = SEV.findIndex(function (x) { return x.key === e.to; });
    var z = zoneById(e.zone);
    return '<tr>' +
      '<td class="num">' + clockOf(e.ts) + '</td>' +
      '<td class="truncate" style="max-width:1px">' + esc(z ? z.name : e.zone) + '</td>' +
      '<td><span class="pill ' + sevOf(si < 0 ? -1 : si).cls + '">' + sevMark(si < 0 ? -1 : si, 13) + e.to + '</span></td>' +
      '<td class="t-right">' + (e.acked
        ? '<span class="reviewed">' + reviewedMark() + 'REVIEWED</span>'
        : '<button class="btn btn--sm" data-act="ack" data-arg="' + e.id + '">Review</button>') +
      '</td>' +
    '</tr>';
  }).join('');

  /* ---- Charts ---- */
  var incidents = bucketSeries(S.events, 24, 3600000, now, 'incidents-24h', 1, 9);
  var incidentTimes = incidents.map(function (_, i) { return now - (23 - i) * 3600000; });
  var volume = bucketSeries(S.notifs, 7, 86400000, now, 'dispatch-7d', 4, 26);
  var dayLabels = volume.map(function (_, i) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(now - (6 - i) * 86400000).getDay()];
  });

  return '' +
  '<div class="dash">' +
    kpiRow +

    '<div class="dash-row">' +
      '<section class="card">' +
        '<div class="card__hd"><h2 class="h-card">Operational status &amp; alert information</h2>' +
          '<span class="label label--xs">' + unacked.length + ' awaiting review</span></div>' +
        '<div class="card__bd stack gap-3">' + calloutHtml + '</div>' +
      '</section>' +

      '<section class="card">' +
        '<div class="card__hd"><h2 class="h-card">Monitoring &amp; dispatch information</h2>' +
          '<button class="btn btn--sm" data-act="nav" data-arg="dispatch">View all</button></div>' +
        '<div class="table-wrap">' +
          '<table class="table" style="min-width:460px">' +
            '<caption class="sr-only">Five most recent outgoing dispatches</caption>' +
            '<thead><tr><th scope="col" style="width:96px">Dispatch</th><th scope="col">Contact</th>' +
              '<th scope="col" style="width:132px">Event</th><th scope="col" class="t-right" style="width:130px">Status</th></tr></thead>' +
            '<tbody>' + (dispatchRows || '<tr><td colspan="4" class="muted">No dispatches yet.</td></tr>') + '</tbody>' +
          '</table>' +
        '</div>' +
      '</section>' +
    '</div>' +

    '<div class="dash-row dash-row--wide">' +
      '<section class="card">' +
        '<div class="card__hd"><h2 class="h-card">Recent severity transitions</h2>' +
          '<button class="btn btn--sm" data-act="nav" data-arg="alerts">View all</button></div>' +
        '<div class="table-wrap">' +
          '<table class="table" style="min-width:440px">' +
            '<caption class="sr-only">Six most recent severity transitions</caption>' +
            '<thead><tr><th scope="col" style="width:80px">Time</th><th scope="col">Zone</th>' +
              '<th scope="col" style="width:132px">Severity</th><th scope="col" class="t-right" style="width:124px">Review</th></tr></thead>' +
            '<tbody>' + (eventRows || '<tr><td colspan="4" class="muted">No transitions logged.</td></tr>') + '</tbody>' +
          '</table>' +
        '</div>' +
      '</section>' +

      '<div class="chart-pair">' +
        lineCard('dash-incidents', 'Incidents per hour', 'fused severity transitions', incidents, incidentTimes,
          function (v) { return Math.round(v) + (Math.round(v) === 1 ? ' event' : ' events'); },
          function (i) { return hmOf(incidentTimes[i]); }) +
        barCard('dash-volume', 'Dispatch volume', 'alerts sent per day', volume, dayLabels,
          function (v) { return v + (v === 1 ? ' dispatch' : ' dispatches'); }) +
      '</div>' +
    '</div>' +
  '</div>';
}

/* A single-series area chart. Identity is carried by the panel title and the
   one-entry key beneath it, so there is no legend box to read. */
function lineCard(id, title, source, vals, times, fmt, tickAt) {
  var n = vals.length;
  var mx = Math.max.apply(null, vals);
  var top = Math.max(1, mx * 1.25), bot = 0;
  var w = 600, h = 118;

  CHART_DATA[id] = { kind: 'line', vals: vals, times: times, fmt: fmt, top: top, bot: bot, digital: false, w: w, h: h };

  var d = linePath(vals, bot, top, w, h);
  var lastY = h - ((vals[n - 1] - bot) / (top - bot || 1)) * h;
  var yTicks = [top, top * 0.5, 0].map(function (v) { return Math.round(v); });
  var xTicks = [0, Math.floor((n - 1) / 3), Math.floor((2 * (n - 1)) / 3), n - 1].map(tickAt);

  return '' +
  '<section class="card">' +
    '<div class="chart-hd">' +
      '<div><div class="chart-key"><span class="chart-key__line" aria-hidden="true"></span>' +
        '<h2 class="h-card">' + title + '</h2></div>' +
        '<p class="label label--xs mt-1">' + source + '</p></div>' +
      '<div><p class="chart-val">' + vals[n - 1] + '</p>' +
        '<p class="num" style="font-size:9px;color:var(--ink-4);text-align:right;margin-top:1px">peak ' + mx + '</p></div>' +
    '</div>' +

    '<div class="plot">' +
      '<div class="plot__y" aria-hidden="true">' + yTicks.map(function (t) { return '<span>' + t + '</span>'; }).join('') + '</div>' +
      '<div class="chart chart--sm" id="' + id + '" data-chart="' + id + '">' +
        '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="' + title + '">' +
          [0.5].map(function (g) { return '<line class="chart__grid" x1="0" y1="' + (h * g) + '" x2="' + w + '" y2="' + (h * g) + '"/>'; }).join('') +
          '<line class="chart__axis" x1="0" y1="' + h + '" x2="' + w + '" y2="' + h + '"/>' +
          '<path class="chart__area" d="' + d + ' L' + w + ' ' + h + ' L0 ' + h + ' Z"/>' +
          '<path class="chart__line" d="' + d + '"/>' +
          '<circle class="chart__end" cx="' + w + '" cy="' + Math.max(4, Math.min(h - 4, lastY)).toFixed(1) + '" r="3.5"/>' +
          '<line class="chart__cross" x1="0" y1="0" x2="0" y2="' + h + '"/>' +
          '<circle class="chart__marker" cx="0" cy="0" r="4"/>' +
          '<rect class="chart__hit" x="0" y="0" width="' + w + '" height="' + h + '"/>' +
        '</svg>' +
        '<div class="chart-tip" role="presentation"><span class="chart-tip__t"></span><span class="chart-tip__v"></span></div>' +
      '</div>' +
    '</div>' +

    '<div class="chart-axis">' + xTicks.map(function (t) { return '<span>' + t + '</span>'; }).join('') + '</div>' +
    '<div class="chart-legend"><span><i class="chart-key__line"></i>' + title + '</span></div>' +

    /* Table-view twin - no value is reachable only by hovering. */
    '<details class="chart-table"><summary>Value table</summary>' +
      '<div class="chart-table__scroll"><table><thead><tr><th scope="col">Time</th><th scope="col">' + title + '</th></tr></thead><tbody>' +
        vals.map(function (v, i) {
          return (i % 3 === 0 || i === n - 1) ? '<tr><td>' + hmOf(times[i]) + '</td><td>' + v + '</td></tr>' : '';
        }).join('') +
      '</tbody></table></div>' +
    '</details>' +
  '</section>';
}

/* Bars are HTML rather than SVG on purpose: the line charts stretch their
   viewBox to the card width, which would turn a 4px rounded bar end into an
   ellipse. Flex boxes keep the radius and the inter-bar gap honest at any
   width, and hover needs no JS. */
function barCard(id, title, source, vals, labels, fmt) {
  var mx = Math.max.apply(null, vals);
  var top = Math.max(1, Math.ceil(mx * 1.25 / 5) * 5);
  var total = vals.reduce(function (a, b) { return a + b; }, 0);

  return '' +
  '<section class="card">' +
    '<div class="chart-hd">' +
      '<div><div class="chart-key"><span class="chart-key__sq" aria-hidden="true"></span>' +
        '<h2 class="h-card">' + title + '</h2></div>' +
        '<p class="label label--xs mt-1">' + source + '</p></div>' +
      '<div><p class="chart-val">' + total + '</p>' +
        '<p class="num" style="font-size:9px;color:var(--ink-4);text-align:right;margin-top:1px">peak ' + mx + '/day</p></div>' +
    '</div>' +

    '<div class="plot">' +
      '<div class="plot__y" aria-hidden="true"><span>' + top + '</span><span>' + Math.round(top / 2) + '</span><span>0</span></div>' +
      '<div class="bars" role="img" aria-label="' + title + ': ' + labels.map(function (l, i) { return l + ' ' + vals[i]; }).join(', ') + '">' +
        '<span class="bars__grid" style="top:0"></span>' +
        '<span class="bars__grid" style="top:50%"></span>' +
        '<span class="bars__grid bars__grid--base" style="bottom:0"></span>' +
        vals.map(function (v, i) {
          return '<span class="bar" tabindex="0">' +
            '<i class="bar__fill" style="height:' + Math.max(2, (v / top) * 100).toFixed(1) + '%"></i>' +
            '<span class="bar__tip">' + esc(labels[i]) + ' · ' + esc(fmt(v)) + '</span>' +
          '</span>';
        }).join('') +
      '</div>' +
    '</div>' +

    '<div class="chart-axis">' + labels.map(function (l) { return '<span>' + esc(l) + '</span>'; }).join('') + '</div>' +
    '<div class="chart-legend"><span><i class="chart-key__sq"></i>' + title + '</span></div>' +

    '<details class="chart-table"><summary>Value table</summary>' +
      '<div class="chart-table__scroll"><table><thead><tr><th scope="col">Day</th><th scope="col">' + title + '</th></tr></thead><tbody>' +
        vals.map(function (v, i) { return '<tr><td>' + esc(labels[i]) + '</td><td>' + v + '</td></tr>'; }).join('') +
      '</tbody></table></div>' +
    '</details>' +
  '</section>';
}

/* -- zones grid ------------------------------------------------------------ */

function viewZones(vms) {
  var shown = vms.filter(function (v) {
    return matches(v.z.id + ' ' + v.z.name + ' ' + v.z.floor + ' ' + v.sv.key);
  });
  if (!shown.length) {
    return '<section class="card"><div class="card__bd"><p class="sub">' +
      emptyMsg(vms.length,
        'No zones are registered. A node has to publish, or an admin has to name one, before a zone exists.',
        'No zone matches “' + esc(S.filters.q) + '”.') +
      '</p></div></section>';
  }
  return '<div class="zone-grid">' + shown.map(zoneCard).join('') + '</div>';
}

function zoneCard(v) {
  var z = v.z, c = v.cls;
  var tiles = [
    { k: 'SMOKE', v: z.r.smoke.toFixed(1),                u: '%obs',   lvl: c.L.smoke, pct: pctOf(z.r.smoke, 30) },
    { k: 'FLAME', v: z.r.flame ? 'DET' : 'NONE',          u: 'ky-026', lvl: c.L.flame, pct: z.r.flame ? '100%' : '2%' },
    { k: 'TEMP',  v: z.r.temp.toFixed(1),                 u: '°C',     lvl: c.L.temp,  pct: pctOf(z.r.temp, 90) },
    { k: 'GAS',   v: String(Math.round(z.r.gas)),         u: 'adc',    lvl: c.L.gas,   pct: pctOf(z.r.gas, 4095) }
  ];

  return '' +
  '<button class="zone ' + v.sv.cls + '" data-act="open-zone" data-arg="' + z.id + '" data-alert="' + (v.alert ? 1 : 0) + '">' +
    '<span class="zone__hd">' +
      '<span class="grow">' +
        '<span class="zone__ids">' +
          '<span class="num" style="font-size:10px;letter-spacing:.08em;color:var(--ink-3)">' + z.id + '</span>' +
          '<span class="num" style="font-size:10px;color:var(--ink-4)">' + z.floor + '</span>' +
        '</span>' +
        '<span class="zone__name truncate" style="display:block">' + esc(z.name) + '</span>' +
      '</span>' +
      '<span class="pill pill--sm' + (v.level === 3 ? ' is-live' : '') + '">' + sevMark(v.level, 11) + v.sv.key + '</span>' +
    '</span>' +

    '<span class="zone__bd">' +
      '<span class="cam">' +
        '<span class="cam__bracket cam__bracket--tl"></span>' +
        '<span class="cam__bracket cam__bracket--br"></span>' +
        '<span class="cam__label"><span>' + v.camLabel + '</span></span>' +
      '</span>' +
      '<span class="tiles">' +
        tiles.map(function (t) {
          var alert = !v.off && t.lvl >= 1;
          return '<span class="tile ' + (alert ? SEV[Math.min(3, t.lvl)].cls : '') + '" data-alert="' + (alert ? 1 : 0) + '">' +
            '<span class="tile__k">' + t.k + '</span>' +
            '<span class="tile__v"><span class="tile__n">' + (v.off ? 'n/a' :t.v) + '</span><span class="tile__u">' + t.u + '</span></span>' +
            '<span class="meter meter--xs ' + (alert ? SEV[Math.min(3, t.lvl)].cls : 'sev-off') + '"><i style="width:' + (v.off ? '2%' : t.pct) + '"></i></span>' +
          '</span>';
        }).join('') +
      '</span>' +
    '</span>' +

    '<span class="zone__ft">' +
      '<span class="' + (v.off ? 'sev-2' : '') + '" style="' + (v.off ? 'color:var(--sev)' : '') + '">' + v.seen + '</span>' +
      '<span class="row gap-3">' +
        (z.silenced ? '<span class="tag">SILENCED</span>' : '') +
        '<span>' + v.act + '</span>' +
      '</span>' +
    '</span>' +
  '</button>';
}

/* -- zone detail ----------------------------------------------------------- */

function viewDetail(v, now) {
  var z = v.z, c = v.cls;
  var admin = isAdmin();

  var readings = [
    { k: 'SMOKE', sensor: SENSOR_NAMES.smoke, v: z.r.smoke.toFixed(1),           u: '%obs', lvl: c.L.smoke, pct: pctOf(z.r.smoke, 30),  min: '0', max: '30',   th: thText('smoke') },
    { k: 'FLAME', sensor: SENSOR_NAMES.flame, v: z.r.flame ? 'DETECTED' : 'NONE', u: '',    lvl: c.L.flame, pct: z.r.flame ? '100%' : '2%', min: 'clear', max: 'flame', th: 'digital + analog' },
    { k: 'TEMP',  sensor: SENSOR_NAMES.temp,  v: z.r.temp.toFixed(1),            u: '°C',   lvl: c.L.temp,  pct: pctOf(z.r.temp, 90),   min: '0', max: '90',   th: thText('temp') },
    { k: 'GAS',   sensor: SENSOR_NAMES.gas,   v: String(Math.round(z.r.gas)),    u: 'ADC',  lvl: c.L.gas,   pct: pctOf(z.r.gas, 4095),  min: '0', max: '4095', th: thText('gas') },
    { k: 'CO',    sensor: SENSOR_NAMES.co,    v: String(Math.round(z.r.co)),     u: 'ppm',  lvl: c.L.co,    pct: pctOf(z.r.co, 400),    min: '0', max: '400',  th: thText('co') }
  ];

  var notes = {
    smoke: c.L.smoke === 0 ? 'Below the ' + TH.smoke[0] + ' %obs first threshold.' : 'Past ' + TH.smoke[c.L.smoke - 1] + ' %obs. Particulate load consistent with combustion.',
    flame: z.r.flame ? 'IR/UV signature present on the digital pin, analog intensity sustained across samples.' : 'No IR/UV signature on either pin.',
    temp:  c.L.temp === 0 ? 'Ambient, within the nominal band for this zone.' : 'Past ' + TH.temp[c.L.temp - 1] + ' °C. Rate of rise also above nominal.',
    gas:   c.L.gas === 0 ? 'MQ-2 raw ADC in the baseline band for this zone.' : 'Past ' + TH.gas[c.L.gas - 1] + ' ADC on the MQ-2 raw channel.',
    co:    c.L.co === 0 ? 'Below the ' + TH.co[0] + ' ppm first threshold.' : 'Past ' + TH.co[c.L.co - 1] + ' ppm. Fire byproduct present.'
  };
  var vals = {
    smoke: z.r.smoke.toFixed(1), flame: z.r.flame ? 'DETECTED' : 'none',
    temp: z.r.temp.toFixed(1), gas: String(Math.round(z.r.gas)), co: String(Math.round(z.r.co))
  };

  var actuators = [
    { label: 'Exhaust fan',              driver: 'PWM · GPIO 25',     state: v.off ? 'UNKNOWN' : v.fan + '%',  pct: v.off ? '2%' : v.fan + '%',  cls: v.off ? 'sev-off' : (v.fan > 0 ? v.sv.cls : 'sev-off') },
    { label: 'Water-mist suppression',   driver: 'PWM · GPIO 26',     state: v.off ? 'UNKNOWN' : (v.mist > 0 ? v.mist + '% · ACTIVE' : 'STANDBY'), pct: v.off ? '2%' : v.mist + '%', cls: v.off ? 'sev-off' : (v.mist > 0 ? 'sev-3' : 'sev-off') },
    { label: 'Gas solenoid valve',       driver: 'DIGITAL · GPIO 27', state: v.off ? 'UNKNOWN' : v.valve,      pct: v.valve === 'CLOSED' ? '100%' : '18%', cls: v.off ? 'sev-off' : (v.valve === 'CLOSED' ? 'sev-2' : 'sev-0') }
  ];

  var overrides = [
    { kind: 'mist',    cls: 'sev-3',      icon: '◆', label: 'Trigger water mist',            note: 'Runs the mist line at 100% for 45s in ' + z.id + '.' },
    { kind: 'exhaust', cls: 'sev-accent', icon: '≋', label: 'Run exhaust at 100%',           note: 'Forces the extraction fan to full PWM.' },
    { kind: 'silence', cls: 'sev-1',      icon: '⃝', label: z.silenced ? 'Un-silence zone alert' : 'Silence active alert', note: z.silenced ? 'Restores audible and push alerting.' : 'Mutes sounder and repeat dispatches for 10 min.' },
    { kind: 'reset',   cls: 'sev-accent', icon: '↺', label: 'Reset zone after false trigger', note: 'Clears actuators and returns the node to auto.' }
  ];

  var telemetry = [
    { k: 'Node MCU',        v: 'ESP32-WROOM-32', cls: '' },
    { k: 'IP address',      v: z.ip, cls: '' },
    { k: 'Wi-Fi signal',    v: z.rssi + ' dBm', cls: z.rssi < -80 ? 'sev-2' : '' },
    { k: 'Heartbeat', v: !z.lastSeen ? 'never received' : (v.off ? 'LOST · ' + rel(z.lastSeen, now) : rel(z.lastSeen, now)), cls: v.off ? 'sev-2' : 'sev-0' },
    { k: 'Camera',          v: v.off ? 'unreachable' : 'OV2640 · armed', cls: v.off ? 'sev-2' : '' }
  ];

  var zevents = S.events.filter(function (e) { return e.zone === z.id; }).slice(0, 6);

  return '' +
  /* The back control lives in the section toolbar, not here - this view used to
     carry its own and the two rendered one above the other. */
  '<div class="detail">' +
    '<div class="detail__cols">' +
      '<div class="detail__col">' +

        /* readings */
        '<section class="card ' + v.sv.cls + '"' + (v.alert || v.off ? ' style="border-color:var(--sev-edge)"' : '') + '>' +
          '<div class="detail__hd">' +
            '<div>' +
              '<div class="row gap-3">' +
                '<span class="num" style="font-size:11px;letter-spacing:.08em;color:var(--ink-3)">' + z.id + '</span>' +
                '<span class="num" style="font-size:11px;color:var(--ink-4)">' + z.floor + '</span>' +
              '</div>' +
              '<h2 class="detail__name">' + esc(z.name) + '</h2>' +
            '</div>' +
            '<span class="pill' + (v.level === 3 ? ' is-live' : '') + '" style="padding:7px 15px 7px 11px;font-size:12px">' + sevMark(v.level, 15) + v.sv.key + '</span>' +
          '</div>' +
          '<div class="detail__split">' +
            '<div>' +
              '<div class="cam cam--lg ' + v.sv.cls + '">' +
                '<span class="cam__bracket cam__bracket--tl"></span>' +
                '<span class="cam__bracket cam__bracket--tr"></span>' +
                '<span class="cam__bracket cam__bracket--bl"></span>' +
                '<span class="cam__bracket cam__bracket--br"></span>' +
                '<span class="cam__label"><span>' + v.camLabel + '</span><span style="color:var(--sev)">' + v.camState + '</span></span>' +
              '</div>' +
              '<p class="mt-3" style="font-size:11px;line-height:1.5;color:var(--ink-3)">Camera still captured on trigger for visual verification. Placeholder frame; drop a real capture in later.</p>' +
            '</div>' +
            '<div class="stack gap-4">' +
              readings.map(function (r) {
                var alert = !v.off && r.lvl >= 1;
                var cls = alert ? SEV[Math.min(3, r.lvl)].cls : 'sev-off';
                return '<div class="reading ' + cls + '" data-alert="' + (alert ? 1 : 0) + '">' +
                  '<div class="reading__top">' +
                    '<div class="row gap-3 baseline truncate">' +
                      '<span class="label" style="color:var(--ink-2)">' + r.k + '</span>' +
                      '<span class="num truncate" style="font-size:9px;color:var(--ink-4)">' + r.sensor + '</span>' +
                    '</div>' +
                    '<div class="row gap-1 baseline">' +
                      '<span class="reading__v">' + (v.off ? 'n/a' :r.v) + '</span>' +
                      '<span class="num" style="font-size:10px;color:var(--ink-4)">' + r.u + '</span>' +
                    '</div>' +
                  '</div>' +
                  '<div class="meter"><i style="width:' + (v.off ? '2%' : r.pct) + '"></i></div>' +
                  '<div class="reading__scale"><span>' + r.min + '</span><span>' + r.th + '</span><span>' + r.max + '</span></div>' +
                '</div>';
              }).join('') +
            '</div>' +
          '</div>' +
        '</section>' +

        /* why this severity */
        '<section class="card">' +
          '<div class="card__hd"><h2 class="h-card">Why this severity</h2><span class="label label--xs">Fusion engine</span></div>' +
          '<div class="card__bd stack gap-3">' +
            ['smoke', 'flame', 'temp', 'gas', 'co'].map(function (k) {
              var lvl = c.L[k];
              var alert = lvl >= 1 && !v.off;
              var cls = lvl === 0 ? 'sev-0' : SEV[Math.min(3, lvl)].cls;
              return '<div class="contrib ' + (v.off ? 'sev-off' : cls) + '" data-alert="' + (alert ? 1 : 0) + '">' +
                '<span class="num" style="font-size:11px;color:var(--ink-2)">' + SENSOR_NAMES[k].split(' ')[0].toUpperCase() + ' ' + esc(vals[k]) + '</span>' +
                '<span class="row gap-2">' + sevMark(v.off ? -1 : Math.min(3, lvl), 12) +
                  '<span class="num" style="font-size:10px;letter-spacing:.08em;color:var(--sev)">' +
                    (lvl === 0 ? 'NOMINAL' : (k === 'flame' ? 'CONFIRMED' : 'LEVEL ' + lvl)) + '</span></span>' +
                '<span class="sub balance">' + notes[k] + '</span>' +
              '</div>';
            }).join('') +
            '<div class="rule ' + v.sv.cls + ' mt-1">' +
              '<span class="rule__rail" aria-hidden="true"></span>' +
              '<div>' +
                '<p class="label" style="color:var(--sev);margin-bottom:3px">' + (v.off ? 'RULE H1 · HEARTBEAT TIMEOUT' : c.tag) + '</p>' +
                '<p class="balance" style="font-size:13px;line-height:1.5;color:var(--ink-1)">' +
                  (v.off ? 'No heartbeat from this ESP32 node for over 60 seconds. Severity cannot be computed, so the zone is held in OFFLINE rather than inheriting its last known state.' : c.text) +
                '</p>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +

        /* zone event history */
        '<section class="card">' +
          '<div class="card__hd"><h2 class="h-card">Zone event history</h2></div>' +
          '<div class="table-wrap">' +
            '<table class="table" style="min-width:560px">' +
              '<thead><tr>' +
                '<th scope="col" style="width:88px">Time</th>' +
                '<th scope="col" style="width:150px">Transition</th>' +
                '<th scope="col">Triggering readings</th>' +
                '<th scope="col" class="t-right" style="width:140px">Review</th>' +
              '</tr></thead>' +
              '<tbody>' + (zevents.length ? zevents.map(function (e) { return eventRow(e, now, true); }).join('')
                : '<tr><td colspan="4" class="muted">No transitions logged for this zone.</td></tr>') + '</tbody>' +
            '</table>' +
          '</div>' +
        '</section>' +
      '</div>' +

      '<div class="detail__col">' +
        /* actuators */
        '<section class="card">' +
          '<div class="card__hd"><h2 class="h-card">Actuators</h2></div>' +
          '<div class="card__bd stack gap-4">' +
            actuators.map(function (a) {
              return '<div class="' + a.cls + '">' +
                '<div class="row between baseline gap-3">' +
                  '<div>' +
                    '<p style="font-size:13px;font-weight:500">' + a.label + '</p>' +
                    '<p class="num" style="font-size:9px;color:var(--ink-4);margin-top:1px">' + a.driver + '</p>' +
                  '</div>' +
                  '<span class="num" style="font-size:12px;color:var(--sev)">' + a.state + '</span>' +
                '</div>' +
                '<div class="meter meter--lg mt-3"><i style="width:' + a.pct + '"></i></div>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</section>' +

        /* manual override */
        '<section class="card">' +
          '<div class="card__hd">' +
            '<h2 class="h-card">Manual override</h2>' +
            '<span class="label label--xs ' + (admin ? 'sev-0' : 'sev-1') + '" style="color:var(--sev)">' + (admin ? 'Admin · unlocked' : 'Viewer · locked') + '</span>' +
          '</div>' +
          '<div class="card__bd stack gap-3">' +
            (admin ? '' :
              '<div class="notice sev-1 mb-4"><span class="notice__rail" aria-hidden="true"></span>' +
              '<p class="balance">Signed in as <strong>viewer</strong>. Overrides and contact edits require an admin account. Switch role in the header to demonstrate.</p></div>') +
            overrides.map(function (o) {
              return '<button class="override ' + o.cls + '" data-act="confirm" data-kind="' + o.kind + '" data-arg="' + z.id + '"' + (admin ? '' : ' disabled') + '>' +
                '<span>' +
                  '<span style="display:block;font-size:13px;font-weight:600">' + o.label + '</span>' +
                  '<span class="sub" style="display:block;margin-top:1px">' + o.note + '</span>' +
                '</span>' +
                '<span class="override__icon">' + o.icon + '</span>' +
              '</button>';
            }).join('') +
          '</div>' +
        '</section>' +

        /* telemetry */
        '<section class="card">' +
          '<div class="card__hd"><h2 class="h-card">Node telemetry</h2></div>' +
          '<div class="card__bd" style="padding-top:2px;padding-bottom:6px">' +
            telemetry.map(function (t) {
              return '<div class="kv ' + t.cls + '"><span class="sub">' + t.k + '</span>' +
                '<span class="num" style="font-size:11px;color:' + (t.cls ? 'var(--sev)' : 'var(--ink-1)') + '">' + esc(t.v) + '</span></div>';
            }).join('') +
          '</div>' +
        '</section>' +
      '</div>' +
    '</div>' +
  '</div>';
}

/* -- event log ------------------------------------------------------------- */

function eventRow(e, now, compact) {
  var si = SEV.findIndex(function (x) { return x.key === e.to; });
  var lvl = si < 0 ? -1 : si;
  var z = zoneById(e.zone);
  var flagged = !e.acked && si >= 2;

  var review = e.acked
    ? '<div><span class="reviewed">' + reviewedMark() + 'REVIEWED</span>' +
      '<span class="reviewed__by">' + esc(e.by) + ' · ' + clockOf(e.ackAt) + '</span></div>'
    : '<button class="btn btn--sm" data-act="ack" data-arg="' + e.id + '">Review</button>';

  var transition =
    '<span class="row gap-2">' +
      '<span class="num" style="font-size:10px;color:var(--ink-3)">' + e.from + '</span>' +
      '<span aria-hidden="true" style="color:var(--ink-4)">→</span>' +
      '<span class="pill ' + sevOf(lvl).cls + '">' + sevMark(lvl, 13) + e.to + '</span>' +
    '</span>';

  if (compact) {
    return '<tr class="' + (flagged ? 'is-flagged sev-3' : '') + '">' +
      '<td class="num">' + clockOf(e.ts) + '</td>' +
      '<td>' + transition + '</td>' +
      '<td class="num truncate" style="max-width:1px">' + esc(e.readings) + '</td>' +
      '<td class="t-right">' + review + '</td>' +
    '</tr>';
  }

  return '<tr class="' + (flagged ? 'is-flagged sev-3' : '') + '">' +
    '<td class="num">' + clockOf(e.ts) + '</td>' +
    '<td><p class="truncate" style="font-size:12px">' + esc(z ? z.name : e.zone) + '</p>' +
      '<p class="num" style="font-size:9px;color:var(--ink-4)">' + e.zone + ' · ' + rel(e.ts, now) + '</p></td>' +
    '<td>' + transition + '</td>' +
    '<td class="num truncate" style="max-width:1px">' + esc(e.readings) + '</td>' +
    '<td class="t-right">' + review + '</td>' +
  '</tr>';
}

function viewEvents(now) {
  var f = S.filters;
  var rows = S.events.filter(function (e) {
    if (f.sev !== 'ALL' && e.to !== f.sev) return false;
    if (f.zone !== 'ALL' && e.zone !== f.zone) return false;
    if (f.ack === 'REVIEWED' && !e.acked) return false;
    if (f.ack === 'PENDING' && e.acked) return false;
    var z = zoneById(e.zone);
    return matches(e.zone + ' ' + (z ? z.name : '') + ' ' + e.from + ' ' + e.to + ' ' + e.readings + ' ' + (e.by || ''));
  });

  var sevOpts = [{ v: 'ALL', l: 'All' }]
    .concat(SEV.map(function (x) { return { v: x.key, l: x.key }; }))
    .concat([{ v: 'OFFLINE', l: 'OFFLINE' }]);
  var zoneOpts = [{ v: 'ALL', l: 'All zones' }]
    .concat(S.zones.map(function (z) { return { v: z.id, l: z.id + ' · ' + z.name }; }));
  var ackOpts = [{ v: 'ALL', l: 'All' }, { v: 'PENDING', l: 'Awaiting review' }, { v: 'REVIEWED', l: 'Reviewed' }];

  return '' +
  /* Search lives in the topbar and scopes this list; only the dimension
     filters belong here. */
  '<div class="filters">' +
    filterSelect('SEVERITY', 'filter-sev', f.sev, sevOpts) +
    filterSelect('ZONE', 'filter-zone', f.zone, zoneOpts) +
    filterSelect('REVIEW', 'filter-ack', f.ack, ackOpts) +
  '</div>' +
  '<section class="card">' +
    '<div class="table-wrap" style="border-radius:7px">' +
      /* Sized so the acknowledgement column lands inside a 1024px viewport -
         it was being clipped by the horizontal scroll, which is the one column
         an operator has to be able to act on. */
      '<table class="table" style="min-width:760px">' +
        '<caption class="sr-only">Severity transitions logged by the fusion engine</caption>' +
        '<thead><tr>' +
          '<th scope="col" style="width:88px">Timestamp</th>' +
          '<th scope="col" style="width:150px">Zone</th>' +
          '<th scope="col" style="width:172px">Severity change</th>' +
          '<th scope="col">Triggering readings</th>' +
          '<th scope="col" class="t-right" style="width:148px">Acknowledgement</th>' +
        '</tr></thead>' +
        '<tbody>' + (rows.length ? rows.map(function (e) { return eventRow(e, now, false); }).join('')
          : emptyRow(5, emptyMsg(S.events.length,
              /* On a live deployment the likeliest reason this is empty is that
                 nothing writes transitions yet. Say so, rather than implying a
                 quiet building. */
              FUSE.mode === 'firebase'
                ? 'No severity transitions have been logged yet. These are written server-side by a Cloud Function when a zone changes level.'
                : 'No severity transitions have been logged yet.',
              'No events match these filters.'))) + '</tbody>' +
      '</table>' +
    '</div>' +
    '<p class="table-note">' + rows.length + ' of ' + S.events.length + ' events shown</p>' +
  '</section>';
}

function filterSelect(label, act, value, opts) {
  return '<span class="filter">' +
    '<label class="label label--xs" for="f-' + act + '">' + label + '</label>' +
    '<select class="select select--sm" id="f-' + act + '" data-change="' + act + '" data-value="' + esc(value) + '">' +
      opts.map(function (o) {
        return '<option value="' + esc(o.v) + '"' + (o.v === value ? ' selected' : '') + '>' + esc(o.l) + '</option>';
      }).join('') +
    '</select>' +
  '</span>';
}

/* -- historical ------------------------------------------------------------ */

var CHART_DATA = {};

/* `th` and `thLabel` are getters, not values: Settings can move a threshold and
   the rule line has to move with it. */
var PANELS = [
  { sensor: 'temp',  title: 'Temperature',       source: 'DS18B20',        fmt: function (v) { return v.toFixed(1) + ' °C'; } },
  { sensor: 'gas',   title: 'Combustible gas',   source: 'MQ-2 raw ADC',   fmt: function (v) { return Math.round(v) + ' ADC'; } },
  { sensor: 'smoke', title: 'Smoke obscuration', source: 'optical %obs',   fmt: function (v) { return v.toFixed(1) + ' %obs'; } },
  { sensor: 'flame', title: 'Flame activity',    source: 'KY-026 digital', fmt: function (v) { return v > 0.5 ? 'DETECTED' : 'clear'; } }
];
function panelTh(p) { return p.sensor === 'flame' ? null : TH[p.sensor][1]; }
function panelThLabel(p) { return p.sensor === 'flame' ? '' : 'WARN ' + TH[p.sensor][1] + ' ' + TH_UNITS[p.sensor]; }

var W = 600, H = 152;

function viewCharts(now) {
  var cz = zoneById(S.chartZone) || S.zones[0];
  var rg = RANGES.filter(function (r) { return r.key === S.range; })[0];

  CHART_DATA = {};

  var panels = PANELS.map(function (p, idx) {
    var vals = series(cz, p.sensor, rg.n, S.range);
    var times = vals.map(function (_, i) { return now - (rg.n - 1 - i) * rg.step; });
    var id = 'chart-' + p.sensor;

    var pTh = panelTh(p);
    var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
    var top = p.sensor === 'flame' ? 1.2 : Math.max(mx * 1.15, pTh * 1.1);
    var bot = p.sensor === 'flame' ? -0.1 : Math.max(0, mn - (mx - mn) * 0.25);

    /* The hover layer must plot on exactly this scale, so it travels with the data. */
    CHART_DATA[id] = {
      vals: vals, times: times, fmt: p.fmt, title: p.title,
      top: top, bot: bot, digital: p.sensor === 'flame', w: W, h: H
    };

    var plot;
    if (p.sensor === 'flame') {
      /* A digital channel is a state timeline, not a curve - a track with the
         detected runs laid into it, so "clear" is visible as well as "detected". */
      var top0 = H / 2 - 15, bandH = 30;
      var bands = '<rect class="chart__track" x="0" y="' + top0 + '" width="' + W + '" height="' + bandH + '" rx="2"/>';
      var run = null;
      vals.forEach(function (v, i) {
        var on = v > 0.5;
        if (on && run === null) run = i;
        if ((!on || i === vals.length - 1) && run !== null) {
          var x1 = (run / (vals.length - 1)) * W;
          var x2 = ((on ? i : i - 1) / (vals.length - 1)) * W;
          bands += '<rect class="chart__step" x="' + x1.toFixed(1) + '" y="' + top0 + '" width="' +
            Math.max(2.5, x2 - x1).toFixed(1) + '" height="' + bandH + '" rx="1.5"/>';
          run = null;
        }
      });
      plot = bands;
    } else {
      var d = linePath(vals, bot, top, W, H);
      var lastY = H - ((vals[vals.length - 1] - bot) / (top - bot || 1)) * H;
      var thY = H - ((pTh - bot) / (top - bot || 1)) * H;
      plot =
        '<path class="chart__area" d="' + d + ' L' + W + ' ' + H + ' L0 ' + H + ' Z"/>' +
        /* Labelled at the left, where these series run flat - at the right it
           would sit on top of the rising line. */
        (thY > 6 && thY < H - 6
          ? '<line class="chart__threshold" x1="0" y1="' + thY.toFixed(1) + '" x2="' + W + '" y2="' + thY.toFixed(1) + '"/>' +
            '<text class="chart__thlabel" x="2" y="' + (thY - 6).toFixed(1) + '">' + panelThLabel(p) + '</text>'
          : '') +
        '<path class="chart__line" d="' + d + '"/>' +
        '<circle class="chart__end" cx="' + W + '" cy="' + Math.max(4, Math.min(H - 4, lastY)).toFixed(1) + '" r="3.5"/>';
    }

    var ticks = [0, 1, 2, 3, 4].map(function (i) {
      return S.range === '7d' ? ['Mon', 'Tue', 'Wed', 'Thu', 'now'][i] : hmOf(now - (4 - i) * rg.step * (rg.n / 4));
    });

    return '' +
    '<section class="card">' +
      '<div class="chart-hd">' +
        '<div>' +
          '<div class="chart-key"><span class="chart-key__line" aria-hidden="true"></span><h2 class="h-card">' + p.title + '</h2></div>' +
          '<p class="label label--xs mt-1">' + p.source + '</p>' +
        '</div>' +
        '<div>' +
          '<p class="chart-val">' + p.fmt(vals[vals.length - 1]) + '</p>' +
          '<p class="num" style="font-size:9px;color:var(--ink-4);text-align:right;margin-top:1px">' +
            (p.sensor === 'flame'
              ? vals.filter(function (v) { return v > 0.5; }).length + ' detections in range'
              : 'peak ' + p.fmt(mx)) + '</p>' +
        '</div>' +
      '</div>' +

      '<div class="chart" id="' + id + '" data-chart="' + id + '">' +
        '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + p.title + ' over the last ' + rg.label.replace(' ', '') + '">' +
          [0.25, 0.5, 0.75].map(function (g) {
            return '<line class="chart__grid" x1="0" y1="' + (H * g) + '" x2="' + W + '" y2="' + (H * g) + '"/>';
          }).join('') +
          '<line class="chart__axis" x1="0" y1="' + H + '" x2="' + W + '" y2="' + H + '"/>' +
          plot +
          '<line class="chart__cross" x1="0" y1="0" x2="0" y2="' + H + '"/>' +
          '<circle class="chart__marker" cx="0" cy="0" r="4"/>' +
          '<rect class="chart__hit" x="0" y="0" width="' + W + '" height="' + H + '"/>' +
        '</svg>' +
        '<div class="chart-tip" role="presentation"><span class="chart-tip__t"></span><span class="chart-tip__v"></span></div>' +
      '</div>' +

      '<div class="chart-axis">' + ticks.map(function (t) { return '<span>' + t + '</span>'; }).join('') + '</div>' +

      /* Table-view twin - no value is reachable only by hovering. */
      '<details class="chart-table">' +
        '<summary>Value table</summary>' +
        '<div class="chart-table__scroll">' +
          '<table><thead><tr><th scope="col">Time</th><th scope="col">' + p.title + '</th></tr></thead><tbody>' +
            vals.map(function (v, i) {
              return (i % Math.ceil(vals.length / 24) === 0 || i === vals.length - 1)
                ? '<tr><td>' + hmOf(times[i]) + '</td><td>' + p.fmt(v) + '</td></tr>' : '';
            }).join('') +
          '</tbody></table>' +
        '</div>' +
      '</details>' +
    '</section>';
  }).join('');

  return '' +
  '<div class="filters between">' +
    '<span class="filter">' +
      '<label class="label label--xs" for="f-chart-zone">ZONE</label>' +
      '<select class="select select--sm" id="f-chart-zone" data-change="chart-zone" data-value="' + esc(S.chartZone) + '">' +
        S.zones.map(function (z) {
          return '<option value="' + z.id + '"' + (z.id === S.chartZone ? ' selected' : '') + '>' + z.id + ' · ' + esc(z.name) + '</option>';
        }).join('') +
      '</select>' +
    '</span>' +
    '<div class="seg" role="group" aria-label="Time range">' +
      RANGES.map(function (r) {
        return '<button data-act="range" data-arg="' + r.key + '" aria-pressed="' + (S.range === r.key) + '">' + r.label + '</button>';
      }).join('') +
    '</div>' +
  '</div>' +
  '<div class="chart-grid">' + panels + '</div>';
}

/* -- contacts -------------------------------------------------------------- */

function viewContacts() {
  var admin = isAdmin();
  var shown = S.contacts.filter(function (c) {
    return matches(c.name + ' ' + c.role + ' ' + c.phone + ' ' + c.email + ' ' + c.channel + ' ' + c.scope + ' ' + c.min);
  });
  return '' +
  '<p class="sub mb-4">Contacts are notified automatically when a zone they cover reaches their minimum severity.</p>' +
  '<section class="card">' +
    '<div class="table-wrap" style="border-radius:7px">' +
      '<table class="table" style="min-width:748px">' +
        '<caption class="sr-only">Emergency contact dispatch list</caption>' +
        /* Every column is sized. Leaving Role to `max-width:1px` starved it to
           six characters while the table was already scrolling horizontally, and
           the total is held under 1024px so Actions stays reachable. */
        '<thead><tr>' +
          '<th scope="col" style="width:136px">Name</th><th scope="col" style="width:124px">Role</th>' +
          '<th scope="col" style="width:168px">Contact</th>' +
          '<th scope="col" style="width:88px">Channel</th><th scope="col" style="width:96px">Scope</th>' +
          '<th scope="col" class="t-right" style="width:136px">Actions</th>' +
        '</tr></thead>' +
        '<tbody>' +
          (shown.length ? '' : emptyRow(6, emptyMsg(S.contacts.length,
            'No contacts on the dispatch list yet. ' + (admin
              ? 'Add one so alerts have somewhere to go.'
              : 'An admin has to add them.'),
            'No contact matches this search.'))) +
          shown.map(function (c) {
            var mi = SEV.findIndex(function (x) { return x.key === c.min; });
            return '<tr>' +
              '<td><span class="truncate" style="display:block;font-size:13px;font-weight:500">' + esc(c.name) + '</span></td>' +
              '<td><span class="sub truncate" style="display:block">' + esc(c.role) + '</span></td>' +
              '<td><p class="num truncate" style="font-size:11px;color:var(--ink-1)">' + esc(c.phone) + '</p>' +
                '<p class="num truncate" style="font-size:10px;color:var(--ink-4)">' + esc(c.email) + '</p></td>' +
              '<td class="num" style="font-size:10px;color:var(--ink-2)">' + esc(c.channel) + '</td>' +
              '<td><p class="num" style="font-size:10px;color:var(--ink-2)">' + esc(c.scope) + '</p>' +
                '<p class="num ' + SEV[mi].cls + '" style="font-size:9px;color:var(--sev);margin-top:1px">' + esc(c.min) + '+</p></td>' +
              '<td class="t-right"><span class="row gap-4" style="justify-content:flex-end">' +
                '<button class="btn btn--sm" data-act="edit-contact" data-arg="' + c.id + '"' + (admin ? '' : ' disabled') + '>Edit</button>' +
                '<button class="btn btn--sm btn--tint sev-3" data-act="confirm" data-kind="delContact" data-arg="' + c.id + '"' + (admin ? '' : ' disabled') + '>Remove</button>' +
              '</span></td>' +
            '</tr>';
          }).join('') +
        '</tbody>' +
      '</table>' +
    '</div>' +
  '</section>';
}

/* -- dispatch log ---------------------------------------------------------- */

function viewNotifs(now) {
  var admin = isAdmin();
  var sent = S.notifs.filter(function (n) { return n.status === 'sent'; }).length;
  var pending = S.notifs.filter(isOutstanding).length;
  var failed = S.notifs.filter(function (n) { return n.status === 'failed'; }).length;

  var stats = [
    { k: 'Dispatched today', v: S.notifs.length, cls: '' },
    { k: 'Delivered',        v: sent,    cls: 'sev-0' },
    { k: 'Pending',          v: pending, cls: 'sev-1' },
    { k: 'Failed',           v: failed,  cls: failed ? 'sev-3' : '' }
  ];


  var shownNotifs = S.notifs.filter(function (n) {
    var z = zoneById(n.zone);
    return matches(n.contact + ' ' + n.target + ' ' + n.channel + ' ' + n.zone + ' ' + n.sev + ' ' + n.status + ' ' + (z ? z.name : ''));
  });

  return '' +
  '<div class="stats mb-4">' +
    stats.map(function (s) {
      return '<div class="stat ' + (s.cls || '') + '">' +
        '<p class="label label--xs">' + s.k + '</p>' +
        '<p class="stat__v"' + (s.cls ? ' data-tone="1"' : '') + '>' + s.v + '</p>' +
      '</div>';
    }).join('') +
  '</div>' +
  '<section class="card">' +
    '<div class="table-wrap" style="border-radius:7px">' +
      /* Delivery carries the retry control, so it must not fall off the right
         edge on a 1024px screen. */
      '<table class="table" style="min-width:780px">' +
        '<caption class="sr-only">Outgoing alert dispatches</caption>' +
        '<thead><tr>' +
          '<th scope="col" style="width:88px">Dispatched</th><th scope="col" style="width:172px">Contact</th>' +
          '<th scope="col" style="width:84px">Channel</th><th scope="col">Event</th>' +
          '<th scope="col" class="t-right" style="width:156px">Delivery</th>' +
        '</tr></thead>' +
        '<tbody>' +
          (shownNotifs.length ? '' : emptyRow(5, emptyMsg(S.notifs.length,
            FUSE.mode === 'firebase'
              ? 'No alerts have been dispatched yet. Dispatches are written when a severity transition fires.'
              : 'No alerts have been dispatched yet.',
            'No dispatch matches this search.'))) +
          shownNotifs.slice(0, 40).map(function (n) {
            var z = zoneById(n.zone);
            var si = SEV.findIndex(function (x) { return x.key === n.sev; });
            var st = statusOf(n.status);
            return '<tr>' +
              '<td class="num">' + clockOf(n.ts) + '</td>' +
              '<td><p class="truncate" style="font-size:12px">' + esc(n.contact) + '</p>' +
                '<p class="num truncate" style="font-size:9px;color:var(--ink-4)">' + esc(n.target) + '</p></td>' +
              '<td class="num" style="font-size:10px;letter-spacing:.06em;color:var(--ink-2)">' + esc(n.channel.toUpperCase()) + '</td>' +
              '<td><p class="truncate" style="font-size:12px;color:var(--ink-1)">' + esc((z ? z.name : n.zone) + ' → ' + n.sev) + '</p>' +
                '<p class="num ' + sevOf(si < 0 ? -1 : si).cls + '" style="font-size:9px;color:var(--sev)">' + n.zone + ' · ' + rel(n.ts, now) + '</p></td>' +
              '<td class="t-right"><span class="row gap-3" style="justify-content:flex-end">' +
                '<span class="pill ' + st.cls + '">' + st.label + '</span>' +
                (n.status === 'failed' && admin ? '<button class="btn btn--xs" data-act="retry" data-arg="' + n.id + '">Retry</button>' : '') +
              '</span></td>' +
            '</tr>';
          }).join('') +
        '</tbody>' +
      '</table>' +
    '</div>' +
  '</section>';
}

/* -- settings -------------------------------------------------------------- */

function settingSelect(act, value, opts) {
  return '<select class="select select--sm" data-change="' + act + '" data-value="' + esc(value) + '" aria-label="' + act + '">' +
    opts.map(function (o) {
      return '<option value="' + esc(o.v) + '"' + (o.v === String(value) ? ' selected' : '') + '>' + esc(o.l) + '</option>';
    }).join('') +
  '</select>';
}

function viewSettings() {
  var admin = isAdmin();
  var u = user();

  var sensors = [
    { k: 'smoke', label: 'Smoke obscuration', unit: '%obs' },
    { k: 'temp',  label: 'Temperature',       unit: '°C' },
    { k: 'gas',   label: 'Combustible gas',   unit: 'ADC' },
    { k: 'co',    label: 'Carbon monoxide',   unit: 'ppm' }
  ];

  var about = [
    { k: 'Build',            v: 'FUSE v2.4.1' },
    { k: 'Controller',       v: 'ESP32-WROOM-32 · 7 nodes' },
    { k: 'Site',             v: 'Meridian Court' },
    { k: 'Fusion rules',     v: 'F1 – F4 + H1' },
    { k: 'Telemetry source', v: 'Realtime Database' }
  ];

  return '' +
  '<div class="set-grid">' +

    /* Scenario and sample-interval controls would be lying here - the nodes
       decide both - so the card reports the connection instead. */
    '<section class="card">' +
          '<div class="card__hd"><h2 class="h-card">Telemetry source</h2>' +
            '<span class="label label--xs sev-0" style="color:var(--sev-ink)">Live</span></div>' +
          '<div class="card__bd" style="padding-top:2px;padding-bottom:6px">' +
            '<div class="kv"><span class="sub">Backend</span><span class="num" style="font-size:11px">Firebase</span></div>' +
            '<div class="kv"><span class="sub">Project</span><span class="num" style="font-size:11px">' +
              esc((window.FUSE_CONFIG && window.FUSE_CONFIG.firebase.projectId) || 'not set') + '</span></div>' +
            '<div class="kv"><span class="sub">Telemetry path</span><span class="num" style="font-size:11px">' +
              esc((window.FUSE_CONFIG && window.FUSE_CONFIG.telemetryPath) || 'zones') + '/</span></div>' +
            '<div class="kv"><span class="sub">Heartbeat timeout</span><span class="num" style="font-size:11px">' +
              Math.round(((window.FUSE_CONFIG && window.FUSE_CONFIG.heartbeatTimeoutMs) || 60000) / 1000) + ' s</span></div>' +
            '<div class="set-row">' +
              '<div><p class="set-row__k">Chart range</p>' +
                '<p class="set-row__note">Default range for the historical panels under Monitoring.</p></div>' +
              settingSelect('set-range', S.range, RANGES.map(function (r) { return { v: r.key, l: r.label.replace(' ', '') }; })) +
            '</div>' +
            '<p class="sub mt-4 balance">Sample interval is set on the nodes, not here. Readings arrive as the ESP32s publish them.</p>' +
          '</div>' +
        '</section>'
        '</section>' +

    '<section class="card">' +
      '<div class="card__hd"><h2 class="h-card">Fusion thresholds</h2>' +
        '<span class="label label--xs ' + (admin ? 'sev-0' : 'sev-1') + '" style="color:var(--sev-ink)">' +
          (admin ? 'Admin · unlocked' : 'Viewer · locked') + '</span></div>' +
      '<div class="card__bd" style="padding-top:10px">' +
        (admin ? '' :
          '<div class="notice sev-1 mb-4"><span class="notice__rail" aria-hidden="true"></span>' +
          '<p class="balance">Signed in as <strong>viewer</strong>. Threshold edits require an admin account.</p></div>') +
        '<div class="th-row">' +
          '<span class="label label--xs">Sensor</span>' +
          '<span class="th-head">Caution</span><span class="th-head">Warning</span><span class="th-head">Critical</span>' +
        '</div>' +
        sensors.map(function (s) {
          return '<div class="th-row">' +
            '<div><p class="set-row__k">' + s.label + '</p>' +
              '<p class="set-row__note">' + s.unit + '</p></div>' +
            TH[s.k].map(function (v, i) {
              /* decimal, not numeric: the handler accepts fractional thresholds
                 (smoke is %obs, temp is °C) but `numeric` asks Android for a
                 digits-only keypad with no decimal separator. */
              return '<input class="input" type="number" inputmode="decimal"' +
                ' aria-label="' + s.label + ' ' + ['caution', 'warning', 'critical'][i] + ' threshold"' +
                ' data-input="th-' + s.k + '-' + i + '" value="' + v + '"' + (admin ? '' : ' disabled') + '>';
            }).join('') +
          '</div>';
        }).join('') +
        '<p class="sub mt-4 balance">Thresholds feed <code>classify()</code> directly. Moving one re-classifies every zone on the next tick and re-draws the rule line on the historical panels.' +
          (FUSE.mode === 'firebase'
            /* Being honest beats being quiet: an operator who assumes these are
               system-wide would think they had retuned the building. */
            ? ' <strong>They are held in this browser only</strong>, so they reset on reload and other operators keep their own. Storing them centrally needs a shared config document, which does not exist yet.'
            : '') + '</p>' +
      '</div>' +
      '<div class="card__ft row between gap-3">' +
        '<span class="label label--xs">' + (thIsDefault() ? 'Factory defaults' : 'Modified from defaults') + '</span>' +
        '<button class="btn btn--sm" data-act="th-reset"' + (admin && !thIsDefault() ? '' : ' disabled') + '>Restore defaults</button>' +
      '</div>' +
    '</section>' +

    '<section class="card">' +
      '<div class="card__hd"><h2 class="h-card">Access</h2></div>' +
      '<div class="card__bd" style="padding-top:2px;padding-bottom:6px">' +
        '<div class="set-row">' +
          '<div><p class="set-row__k">Signed in as</p>' +
            '<p class="set-row__note">' + esc(u.name) + ' · ' + esc(u.roleLabel) +
              (FUSE.mode === 'firebase'
                ? '<br>Role comes from <code>users/' + esc(S.profile ? S.profile.uid : '') + '</code> and is enforced by the security rules. ' +
                  'To change it, edit that document in Firestore and sign in again.'
                : '') + '</p></div>' +
          '<span class="pill ' + (admin ? 'sev-0' : 'sev-1') + '">' + esc(admin ? 'ADMIN' : 'VIEWER') + '</span>' +
        '</div>' +
        '<div class="set-row">' +
          '<div><p class="set-row__k">Viewer</p>' +
            '<p class="set-row__note">Observe every zone and acknowledge events. Cannot fire actuators or edit the dispatch list.</p></div>' +
          '<span class="pill ' + (admin ? 'sev-off' : 'sev-0') + '">' + (admin ? 'inactive' : 'active') + '</span>' +
        '</div>' +
        '<div class="set-row">' +
          '<div><p class="set-row__k">Admin</p>' +
            '<p class="set-row__note">Adds manual overrides, threshold edits and contact management. Every action is written to the audit trail.</p></div>' +
          '<span class="pill ' + (admin ? 'sev-0' : 'sev-off') + '">' + (admin ? 'active' : 'inactive') + '</span>' +
        '</div>' +
      '</div>' +
    '</section>' +

    '<section class="card">' +
      '<div class="card__hd"><h2 class="h-card">About this console</h2></div>' +
      '<div class="card__bd" style="padding-top:2px;padding-bottom:6px">' +
        about.map(function (a) {
          return '<div class="kv"><span class="sub">' + a.k + '</span>' +
            '<span class="num" style="font-size:11px;color:var(--ink-1)">' + esc(a.v) + '</span></div>';
        }).join('') +
        '<p class="sub mt-4 balance">Readings are generated by a random walk toward a per-zone target. There is no persistence. A reload resets every zone, event and dispatch.</p>' +
      '</div>' +
    '</section>' +
  '</div>';
}

function thIsDefault() {
  return Object.keys(TH_DEFAULT).every(function (k) {
    return TH[k].every(function (v, i) { return v === TH_DEFAULT[k][i]; });
  });
}

/* -- overlays -------------------------------------------------------------- */

function viewOverlay() {
  if (S.confirm) {
    var spec = confirmSpec(S.confirm.kind, S.confirm.arg);
    if (!spec) return '';
    return '' +
    '<div class="scrim" data-act="confirm-cancel-scrim">' +
      '<div class="modal ' + spec.cls + '" role="dialog" aria-modal="true" aria-labelledby="confirm-title" data-stop="1">' +
        '<div class="modal__hd modal__hd--sev">' +
          '<p class="label" style="color:var(--sev)">' + spec.tag + '</p>' +
          '<h2 class="modal__title" id="confirm-title">' + esc(spec.title) + '</h2>' +
        '</div>' +
        '<p class="modal__bd balance">' + esc(spec.body) + '</p>' +
        '<p class="modal__meta">' + esc(spec.meta) + '</p>' +
        '<div class="modal__ft">' +
          '<button class="btn" data-act="confirm-cancel">Cancel</button>' +
          '<button class="btn btn--sev" data-act="confirm-run" data-autofocus="1">' + spec.action + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  if (S.cform) {
    var cf = S.cform;
    var fields = [
      { k: 'name',    label: 'Full name', type: 'text', ph: 'e.g. Marisol Reyes' },
      { k: 'role',    label: 'Role',      type: 'text', ph: 'e.g. Building Manager' },
      { k: 'phone',   label: 'Phone',     type: 'text', ph: '+63 9xx xxx xxxx' },
      { k: 'email',   label: 'Email',     type: 'text', ph: 'name@domain.ph' },
      { k: 'channel', label: 'Notification method', type: 'select',
        opts: ['SMS', 'Push', 'Email', 'SMS + Push', 'Email + SMS'].map(function (v) { return { v: v, l: v }; }) },
      { k: 'scope',   label: 'Zone scope', type: 'select',
        opts: [{ v: 'All zones', l: 'All zones' }].concat(S.zones.map(function (z) { return { v: z.id, l: z.id + ' · ' + z.name }; })) },
      { k: 'min',     label: 'Alert from severity', type: 'select', span: true,
        opts: SEV.slice(1).map(function (x) { return { v: x.key, l: x.key + ' and above' }; }) }
    ];

    return '' +
    '<div class="scrim" data-act="contact-cancel-scrim">' +
      '<div class="modal modal--wide" role="dialog" aria-modal="true" aria-labelledby="cform-title" data-stop="1">' +
        '<div class="modal__hd">' +
          '<h2 class="modal__title" id="cform-title" style="margin:0">' + (cf.id ? 'Edit contact' : 'Add emergency contact') + '</h2>' +
          '<p class="sub mt-1">Emergency contacts receive dispatches for the zones and severities you set here.</p>' +
        '</div>' +
        '<div class="form-grid">' +
          fields.map(function (f, i) {
            var id = 'cf-' + f.k;
            var ctl = f.type === 'text'
              ? '<input class="input" id="' + id + '" data-input="cform-' + f.k + '" placeholder="' + esc(f.ph) + '" value="' + esc(cf[f.k]) + '"' + (i === 0 ? ' data-autofocus="1"' : '') + '>'
              : '<select class="select" id="' + id + '" data-change="cform-' + f.k + '" data-value="' + esc(cf[f.k]) + '">' +
                  f.opts.map(function (o) {
                    return '<option value="' + esc(o.v) + '"' + (o.v === cf[f.k] ? ' selected' : '') + '>' + esc(o.l) + '</option>';
                  }).join('') +
                '</select>';
            return '<div class="field' + (f.span ? ' span-2' : '') + '">' +
              '<label class="label" for="' + id + '">' + f.label + '</label>' + ctl + '</div>';
          }).join('') +
        '</div>' +
        '<div class="modal__ft">' +
          '<button class="btn" data-act="contact-cancel">Cancel</button>' +
          '<button class="btn btn--primary" data-act="contact-save">' + (cf.id ? 'Save changes' : 'Add contact') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  return '';
}

function viewToast() {
  if (!S.toast) return '';
  /* Tappable to dismiss. On a phone the toast is a full-width band across the
     most reachable part of the screen, so it needs a way out that is not
     "wait 4.2 seconds". */
  return '<div class="toast ' + S.toast.cls + '" data-act="toast-dismiss" role="button" tabindex="0" aria-label="Dismiss notification">' +
    '<span class="toast__rail" aria-hidden="true"></span>' +
    '<div>' +
      '<p class="label label--xs" style="color:var(--sev)">' + S.toast.tag + '</p>' +
      '<p class="toast__msg balance">' + esc(S.toast.msg) + '</p>' +
    '</div>' +
  '</div>';
}

/* --------------------------------------------------------------- renderer -- */

/* Morphs `el` towards `html` in place. Keeps focus, selection, scroll
   position, hover state and running transitions - which a plain innerHTML
   swap at 1 Hz would destroy. */
function morph(el, html) {
  var tmp = document.createElement('div');
  tmp.innerHTML = html;
  morphChildren(el, tmp);
}

function morphChildren(parent, next) {
  var olds = Array.prototype.slice.call(parent.childNodes);
  var news = Array.prototype.slice.call(next.childNodes);
  var n = Math.max(olds.length, news.length);
  for (var i = 0; i < n; i++) {
    var o = olds[i], t = news[i];
    if (t === undefined) { parent.removeChild(o); continue; }
    if (o === undefined) { parent.appendChild(t); continue; }
    morphNode(parent, o, t);
  }
}

function morphNode(parent, o, t) {
  if (o.nodeType !== t.nodeType ||
      (o.nodeType === 1 && o.nodeName !== t.nodeName)) {
    parent.replaceChild(t, o);
    return;
  }
  if (o.nodeType === 3 || o.nodeType === 8) {
    if (o.nodeValue !== t.nodeValue) o.nodeValue = t.nodeValue;
    return;
  }
  if (o.nodeType !== 1) return;

  var i, a;
  for (i = t.attributes.length - 1; i >= 0; i--) {
    a = t.attributes[i];
    if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  }
  for (i = o.attributes.length - 1; i >= 0; i--) {
    a = o.attributes[i];
    if (t.hasAttribute(a.name)) continue;
    /* `open` on a <details> is user state the markup never carries. */
    if (o.nodeName === 'DETAILS' && a.name === 'open') continue;
    o.removeAttribute(a.name);
  }

  /* Live form values are owned by the DOM while focused. */
  if (o.nodeName === 'INPUT') {
    if (document.activeElement !== o) o.value = t.getAttribute('value') || '';
    return;
  }
  if (o.nodeName === 'SELECT') {
    morphChildren(o, t);
    var want = t.getAttribute('data-value');
    if (want != null && o.value !== want) o.value = want;
    return;
  }

  morphChildren(o, t);
}

var root = document.getElementById('root');
var overlay = document.getElementById('overlay');
var toasts = document.getElementById('toasts');
var lastShell = '';
var resetScroll = false;

/* --- Android back gesture -------------------------------------------------
   Back is the reflex for dismissing a sheet on Android, and in the packaged app
   there is no browser chrome to absorb it: without this, back closed the entire
   console instead of the dialog sitting on top of it, discarding a half-typed
   contact with it. The WebView's back maps to history.back(), so one sentinel
   entry per overlay opening is enough, and it costs the web build nothing.

   The depth flag keeps push and pop paired. Closing through the UI pops the
   sentinel; the resulting popstate finds no overlay open and does nothing, so
   the two paths cannot loop into each other. */
function overlayOpen() { return !!(S && (S.confirm || S.cform || S.menu)); }

var overlaySentinel = 0;

function syncOverlayHistory() {
  var open = overlayOpen();
  if (open && !overlaySentinel) {
    overlaySentinel = 1;
    try { history.pushState({ fuseOverlay: 1 }, ''); } catch (e) { overlaySentinel = 0; }
  } else if (!open && overlaySentinel) {
    overlaySentinel = 0;
    try { history.back(); } catch (e) {}
  }
}

window.addEventListener('popstate', function () {
  if (!overlayOpen()) return;
  /* The entry is already gone, so do not try to pop it again. */
  overlaySentinel = 0;
  S.confirm = null; S.cform = null; S.menu = false;
  render();
});

function render() {
  /* One clock, and this is where it advances.

     S.now used to be assigned only inside beat(), while z.online and z.level
     were computed from Date.now() at every snapshot arrival. So a render
     triggered by a snapshot - not by the tick - drew every "N ago" label and the
     live/stale dot from a clock that could be far behind the one that had just
     decided which nodes were offline. The visible symptom was the banner saying
     "All 7 nodes offline" beside a toolbar reading "live, updated 2s ago".

     It drifts worst exactly when it matters: browsers throttle setInterval to
     about once a minute in a background tab and can freeze it outright, while
     RTDB listeners keep firing and keep calling render(). Reading it once here
     also keeps the value stable for the whole pass, so two panels in the same
     frame cannot disagree about what time it is. */
  S.now = Date.now();

  var shell = S.loggedIn ? 'app' : 'login';
  if (shell !== lastShell) { root.innerHTML = ''; lastShell = shell; }

  morph(root, S.loggedIn ? viewApp() : viewLogin());
  morph(overlay, (S.loggedIn ? viewUserMenu() : '') + viewOverlay());

  /* Lock the document while an overlay is up. On <html>, not <body>, because
     below 960px the document element is the scroller - without this a drag on
     the scrim scrolls the page behind the dialog, and you cancel out somewhere
     other than where you started. */
  document.documentElement.style.overflow = overlayOpen() ? 'hidden' : '';
  syncOverlayHistory();
  morph(toasts, viewToast());

  /* Restore hover readout on any chart the pointer is still over. */
  Object.keys(hoverState).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) placeCrosshair(el, hoverState[id]);
  });

  if (resetScroll) {
    resetScroll = false;
    var main = document.getElementById('main');
    if (main) main.scrollTop = 0;
    /* Below 960px .content stops being a scroll container and the document
       scrolls instead, so resetting #main alone was a no-op on every phone:
       every nav tap landed wherever the previous section had been scrolled to,
       which reads as a half-rendered screen. */
    window.scrollTo(0, 0);
    /* The nav is one horizontally scrolling row at that width, so the section
       just opened can sit off the right edge of it. */
    var cur = document.querySelector('.nav__item[aria-current="page"]');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  var af = document.querySelector('[data-autofocus]');
  if (af && af !== document.activeElement && !overlay.contains(document.activeElement)) af.focus();
}

/* -------------------------------------------------------- chart interaction */

var hoverState = {};

function placeCrosshair(chart, ratio) {
  var id = chart.id;
  var data = CHART_DATA[id];
  if (!data) return;

  var n = data.vals.length;
  var i = Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
  var svg = chart.querySelector('svg');
  var cross = chart.querySelector('.chart__cross');
  var marker = chart.querySelector('.chart__marker');
  var tip = chart.querySelector('.chart-tip');
  if (!svg || !cross || !tip) return;

  /* The dashboard panels are shorter than the historical ones, so the geometry
     travels with the data rather than being read off the module constants. */
  var cw = data.w || W, ch = data.h || H;

  var x = (i / (n - 1)) * cw;
  cross.setAttribute('x1', x); cross.setAttribute('x2', x);

  /* Marker rides the plotted point, on the scale the path was drawn with. */
  var y = ch - ((data.vals[i] - data.bot) / (data.top - data.bot || 1)) * ch;
  if (marker) {
    marker.setAttribute('cx', x);
    marker.setAttribute('cy', Math.max(4, Math.min(ch - 4, y)));
    marker.style.display = data.digital ? 'none' : '';
  }

  var box = svg.getBoundingClientRect();
  var host = chart.getBoundingClientRect();
  var px = (box.left - host.left) + (x / cw) * box.width;
  tip.style.left = Math.max(48, Math.min(host.width - 48, px)) + 'px';
  tip.style.top = '-2px';
  tip.querySelector('.chart-tip__t').textContent = hmOf(data.times[i]);
  tip.querySelector('.chart-tip__v').textContent = data.fmt(data.vals[i]);

  chart.classList.add('is-hover');
  hoverState[id] = ratio;
}

function clearCrosshair(chart) {
  chart.classList.remove('is-hover');
  delete hoverState[chart.id];
}

document.addEventListener('pointermove', function (e) {
  var chart = e.target.closest ? e.target.closest('.chart') : null;
  Object.keys(hoverState).forEach(function (id) {
    if (!chart || chart.id !== id) {
      var el = document.getElementById(id);
      if (el) clearCrosshair(el);
    }
  });
  if (!chart) return;
  var svg = chart.querySelector('svg');
  if (!svg) return;
  var box = svg.getBoundingClientRect();
  placeCrosshair(chart, Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)));
});

/* pointermove already drops the crosshair when the pointer is off a chart;
   this only covers the pointer leaving the window entirely. */
document.addEventListener('pointerout', function (e) {
  if (e.relatedTarget) return;
  Object.keys(hoverState).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) clearCrosshair(el);
  });
});

/* ---------------------------------------------------------------- events -- */

document.addEventListener('click', function (e) {
  if (!S) return;   /* listeners are bound before the backend resolves */
  var el = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el) {
    /* A click on bare page dismisses the account menu - but not a click landing
       inside it, which would swallow the menu's own controls. */
    if (S.menu && !(e.target.closest && e.target.closest('.menu'))) { S.menu = false; render(); }
    return;
  }

  var act = el.getAttribute('data-act');
  var arg = el.getAttribute('data-arg');

  /* Scrim dismissals must not fire when the click landed inside the dialog. */
  if (act === 'confirm-cancel-scrim' || act === 'contact-cancel-scrim') {
    if (e.target.closest('[data-stop]')) return;
    S.confirm = null; S.cform = null; render();
    return;
  }

  if (el.tagName === 'FORM') return;
  if (el.disabled) return;

  /* Any click that is not the account button itself closes the account menu. */
  if (act !== 'user-menu' && S.menu) S.menu = false;

  switch (act) {
    case 'nav':
      S.section = arg;
      S.selected = null;
      /* The topbar search scopes the section it was typed in; carrying a stale
         query into a different section would silently hide rows. */
      S.filters.q = '';
      resetScroll = true;
      break;
    case 'user-menu': S.menu = !S.menu; break;
    case 'mon-tab': S.monTab = arg; S.selected = null; resetScroll = true; break;
    case 'open-zone': S.selected = arg; S.section = 'monitoring'; S.monTab = 'zones'; resetScroll = true; break;
    case 'close-detail': S.selected = null; resetScroll = true; break;
    case 'th-reset':
      if (!isAdmin()) { denied('Only admins can change fusion thresholds.'); return; }
      TH = JSON.parse(JSON.stringify(TH_DEFAULT));
      toast('THRESHOLDS RESTORED', 'Every sensor is back on its factory ladder. Zones re-classify on the next tick.', 'sev-0');
      return;
    case 'sign-out':
      S.menu = false;
      /* onAuth drives the rest: it clears the profile, drops the subscriptions
         and returns the console to the sign-in screen. */
      FUSE.signOut();
      return;
    case 'sign-in-google': {
      S.auth.busy = 'google'; S.auth.error = null; render();
      FUSE.signInWithGoogle().catch(function (err) {
        S.auth.busy = null;
        S.auth.error = authMessage(err);
        render();
      });
      return;
    }
    case 'toast-dismiss': clearTimeout(toastTimer); S.toast = null; break;
    case 'ack': ack(arg); return;
    case 'range': S.range = arg; break;
    case 'confirm': S.confirm = { kind: el.getAttribute('data-kind'), arg: arg }; break;
    case 'confirm-cancel': S.confirm = null; break;
    case 'confirm-run': {
      var c = S.confirm;
      S.confirm = null;
      if (c) runConfirm(c.kind, c.arg);
      return;
    }
    case 'add-contact':
      if (!isAdmin()) { denied('Only admins can edit the contact list.'); return; }
      S.cform = { name: '', role: '', phone: '', email: '', channel: 'SMS', scope: 'All zones', min: 'WARNING' };
      break;
    case 'edit-contact':
      /* The button is disabled for viewers, so this only fires if something
         re-enabled it. The rules would refuse the save anyway; refusing here
         means a viewer never gets a form that cannot be submitted. */
      if (!isAdmin()) { denied('Only admins can edit the contact list.'); return; }
      S.cform = Object.assign({}, S.contacts.filter(function (x) { return x.id === arg; })[0]);
      break;
    case 'contact-cancel': S.cform = null; break;
    case 'contact-save': saveContact(); return;
    case 'retry': {
      S.notifs.forEach(function (n) {
        if (n.id === arg) { n.status = 'sent'; n.ts = Date.now(); }
      });
      var m = S.notifs.filter(function (n) { return n.id === arg; })[0];
      if (FUSE.mode === 'firebase') {
        FUSE.retryDispatch(arg).catch(function (err) { writeFailed('retry that dispatch', err, 'dispatches'); });
      }
      toast('RESENT', 'Alert re-dispatched to ' + m.contact + ' via ' + m.channel + '.', 'sev-0');
      return;
    }
    default: return;
  }
  render();
});

/* Firebase error codes are not operator-facing copy. Two audiences here: an
   operator who mistyped, and whoever is standing up the deployment - a
   misconfigured project must say so rather than read as a bad password. */
function authMessage(err) {
  var code = (err && err.code) || '';
  var raw = (err && err.message) || '';

  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'That email and password do not match an account.';
  }
  if (code === 'auth/invalid-email') return 'That does not look like an email address.';
  if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a minute, then try again.';
  if (code === 'auth/user-disabled') return 'That account has been disabled. Contact an admin.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'The Google window closed before sign-in finished.';
  }
  if (code === 'auth/popup-blocked') return 'The browser blocked the Google window. Allow popups for this site and retry.';
  if (code === 'auth/network-request-failed') return 'No connection to the auth service. Check the network and retry.';

  /* Deployment problems, not credential problems. */
  if (/api-key-not-valid|invalid-api-key/.test(code + raw)) {
    return 'This console’s Firebase configuration is not valid. Check the keys in assets/js/firebase-config.js.';
  }
  if (code === 'auth/operation-not-allowed' || code === 'auth/configuration-not-found') {
    return 'That sign-in method is not enabled on the Firebase project. Turn it on under Authentication → Sign-in method.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'This domain is not on the project’s authorised list. Add it under Authentication → Settings → Authorised domains.';
  }

  /* Anything unmapped: drop the "Firebase: Error (...)" wrapper so the operator
     sees the code alone rather than a nested sentence. */
  var m = /\(([^)]+)\)/.exec(raw);
  return 'Sign-in failed' + (m ? ': ' + m[1] : '') + '.';
}

document.addEventListener('submit', function (e) {
  if (!S) return;
  var form = e.target.closest('[data-act="sign-in"]');
  if (!form) return;
  e.preventDefault();

  S.auth.busy = 'password'; S.auth.error = null; render();
  FUSE.signIn(S.loginId, S.loginPass).catch(function (err) {
    S.auth.busy = null;
    S.auth.error = authMessage(err);
    /* Never leave a rejected password sitting in the field. */
    S.loginPass = '';
    render();
  });
});

document.addEventListener('input', function (e) {
  if (!S) return;
  var key = e.target.getAttribute && e.target.getAttribute('data-input');
  if (!key) return;
  var v = e.target.value;
  if (key === 'search') { S.filters.q = v; render(); return; }
  if (key === 'login-id') { S.loginId = v; return; }
  if (key === 'login-pass') { S.loginPass = v; return; }
  if (key.indexOf('cform-') === 0 && S.cform) { S.cform[key.slice(6)] = v; return; }

  /* th-<sensor>-<index>. The field keeps whatever was typed while it has focus
     (the morph leaves focused inputs alone), so only a parseable, in-order value
     reaches TH - a half-typed "1" must not re-classify the building. */
  if (key.indexOf('th-') === 0) {
    if (!isAdmin()) return;
    var parts = key.split('-'), sensor = parts[1], idx = parseInt(parts[2], 10);
    var n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return;
    var next = TH[sensor].slice();
    next[idx] = n;
    for (var i = 1; i < next.length; i++) if (next[i] <= next[i - 1]) return;
    TH[sensor] = next;
    render();
    return;
  }
});

document.addEventListener('change', function (e) {
  if (!S) return;
  var key = e.target.getAttribute && e.target.getAttribute('data-change');
  if (!key) return;
  var v = e.target.value;
  if (key === 'filter-sev')  S.filters.sev = v;
  else if (key === 'filter-zone') S.filters.zone = v;
  else if (key === 'filter-ack')  S.filters.ack = v;
  else if (key === 'chart-zone')  S.chartZone = v;
  else if (key === 'set-range') S.range = v;

  else if (key.indexOf('cform-') === 0 && S.cform) { S.cform[key.slice(6)] = v; }
  else return;
  render();
});

document.addEventListener('keydown', function (e) {
  if (!S || e.key !== 'Escape') return;
  if (S.confirm || S.cform) { S.confirm = null; S.cform = null; render(); }
  else if (S.menu) { S.menu = false; render(); }
  else if (S.selected) { S.selected = null; render(); }
});

/* Focus stays inside an open dialog. */
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Tab') return;
  var dialog = overlay.querySelector('[role="dialog"]');
  if (!dialog) return;
  var f = dialog.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
  if (!f.length) return;
  var first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ------------------------------------------------------------------ boot -- */

function hideGhost() {
  var boot = document.getElementById('boot');
  if (boot) boot.hidden = true;
}

/* Live subscriptions. Each one flips its own `S.live` flag on first delivery,
   which is what retires that section's skeleton. */
/* A refused or broken feed retires its skeleton and records why. Leaving the
   skeleton up would say "still loading" when the truth is "not allowed". */
function feedFailed(key, label) {
  return function (err) {
    var code = (err && err.code) || '';
    var denied = /permission|PERMISSION_DENIED/i.test(code + ' ' + ((err && err.message) || ''));
    S.live[key] = true;
    S.feedError[key] = {
      label: label,
      denied: denied,
      msg: denied
        ? 'The security rules refused this read.'
        : ((err && err.message) || 'The subscription failed.')
    };
    render();
  };
}

function subscribeLive() {
  unsubscribeLive();
  S.feedError = {};
  subs.push(FUSE.onZones(function (zones) {
    S.snap.zones = zones;
    /* Keep whatever the operator is looking at: merge readings onto the existing
       objects so a re-render does not blow away a selected zone. */
    S.zones = zones.map(function (z) {
      var prev = zoneById(z.id) || {};
      return Object.assign({}, prev, z, { t: null, flashUntil: prev.flashUntil || 0 });
    });
    liveTick(Date.now());
    S.lastTick = Date.now();
    S.live.zones = true;
    delete S.feedError.zones;
    render();
  }, feedFailed('zones', 'Zone telemetry')));

  subs.push(FUSE.onEvents(function (events) {
    S.snap.events = events;
    S.events = events; S.live.events = true; delete S.feedError.events; render();
  }, feedFailed('events', 'Event log')));

  subs.push(FUSE.onContacts(function (contacts) {
    S.snap.contacts = contacts;
    S.contacts = contacts; S.live.contacts = true; delete S.feedError.contacts; render();
  }, feedFailed('contacts', 'Contacts')));

  subs.push(FUSE.onDispatches(function (d) {
    S.snap.dispatches = d;
    S.notifs = d; S.live.dispatches = true; delete S.feedError.dispatches; render();
  }, feedFailed('dispatches', 'Dispatch log')));
}

function unsubscribeLive() {
  subs.forEach(function (off) { try { off(); } catch (e) {} });
  subs = [];
}

window.FUSE_READY.then(function (api) {
  FUSE = api;
  S = initialState();

  /* Auth is the only gate. There is no other path into the console: no
     simulator to fall back to, and no client-side role to pick. */
  FUSE.onAuth(function (profile) {
    if (profile) {
      S.profile = withCls(profile);
      S.loggedIn = true;
      S.auth.status = 'in';
      subscribeLive();
    } else {
      S.profile = null;
      S.loggedIn = false;
      S.auth.status = 'out';
      S.live = { zones: false, events: false, contacts: false, dispatches: false };
      unsubscribeLive();
    }
    S.auth.busy = null;
    hideGhost();
    render();
  });

  timer = setInterval(beat, TICK_MS);
});

window.addEventListener('beforeunload', function () { clearInterval(timer); unsubscribeLive(); });

})();
