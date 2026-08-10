/* ==========================================================================
   FUSE - backend adapter
   --------------------------------------------------------------------------
   One implementation: Firebase. There is no simulator and no demo fallback.

   There used to be one, and the argument for it was that a site showing nothing
   because a CDN is slow is worse than a site showing simulated data and saying
   so. That reasoning belonged to a build with no project attached. It is the
   wrong trade for a fire console wired to a real building: an operator glancing
   at a screen has no way to tell fabricated readings from measured ones, and the
   consequence of getting that wrong is not a bad demo.

   So when Firebase cannot be reached, this returns an adapter that fails every
   subscription immediately with the reason. app.js already renders that
   honestly - feedFailed() retires the skeleton and names the feed that could not
   be read. Silence is reported as silence.
   ========================================================================== */
(function () {
'use strict';

var SDK = 'https://www.gstatic.com/firebasejs/10.12.0/';
var CDN_TIMEOUT_MS = 12000;

var CFG = window.FUSE_CONFIG || { enabled: false };

function bootMsg(text) {
  var el = document.getElementById('boot-msg');
  if (el) el.textContent = text;
}

/* A slow line must not hang the ghost screen forever. Whichever settles first
   wins: the SDK, or the clock. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error(label + ' timed out after ' + (ms / 1000) + 's')); }, ms);
    })
  ]);
}

/* Firebase is unreachable or misconfigured. Every read reports the reason
   instead of resolving empty, because an empty feed and an unreachable one look
   identical on screen and mean completely different things. Every write is
   refused rather than silently accepted into a void. */
function downBackend(reason) {
  var err = new Error(reason || 'Firebase could not be reached.');

  function deadSub(cb, onErr) {
    /* Asynchronous so the caller has finished wiring up before it hears back. */
    setTimeout(function () { if (onErr) onErr(err); }, 0);
    return function () {};
  }
  function deadWrite() { return Promise.reject(err); }

  return {
    mode: 'firebase',
    down: true,
    reason: err.message,
    /* No session can be resolved, so the console lands on sign-in and says why. */
    onAuth: function (cb) { setTimeout(function () { cb(null); }, 0); return function () {}; },
    signIn: deadWrite,
    signInWithGoogle: deadWrite,
    signOut: function () { return Promise.resolve(); },
    onZones: deadSub, onEvents: deadSub, onContacts: deadSub, onDispatches: deadSub,
    ackEvent: deadWrite, saveContact: deadWrite, deleteContact: deadWrite,
    setZoneOverride: deadWrite, retryDispatch: deadWrite
  };
}

function configLooksReal(c) {
  if (!c || !c.enabled) return false;
  var f = c.firebase || {};
  return !!f.apiKey && f.apiKey.indexOf('YOUR_') !== 0 &&
         !!f.projectId && f.projectId.indexOf('YOUR_') !== 0;
}

async function firebaseBackend() {
  bootMsg('Connecting to Firebase…');

  var appMod = await withTimeout(import(SDK + 'firebase-app.js'), CDN_TIMEOUT_MS, 'Firebase SDK');
  var authMod = await withTimeout(import(SDK + 'firebase-auth.js'), CDN_TIMEOUT_MS, 'Firebase Auth');
  var fsMod = await withTimeout(import(SDK + 'firebase-firestore.js'), CDN_TIMEOUT_MS, 'Firestore');
  var dbMod = await withTimeout(import(SDK + 'firebase-database.js'), CDN_TIMEOUT_MS, 'Realtime Database');

  var app = appMod.initializeApp(CFG.firebase);
  var auth = authMod.getAuth(app);
  var rtdb = dbMod.getDatabase(app);

  /* Keep the console usable through a dropped connection; Firestore replays the
     writes when it comes back. The multi-tab manager matters here because an
     operations console is exactly the thing someone leaves open on two screens,
     and the old enableIndexedDbPersistence() refused the second tab. */
  var fs;
  try {
    fs = fsMod.initializeFirestore(app, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() })
    });
  } catch (e) {
    /* Private browsing, an unsupported browser, or Firestore already started. */
    fs = fsMod.getFirestore(app);
  }

  var col = function (name) { return fsMod.collection(fs, name); };

  /* The role is read from the user's own document, never from the client. A
     viewer who edits their own profile in devtools still cannot write, because the
     rules check this same document server-side. */
  async function profileOf(u) {
    if (!u) return null;
    var snap = null, readErr = null;
    try { snap = await fsMod.getDoc(fsMod.doc(fs, 'users', u.uid)); } catch (e) { readErr = e; }
    var d = (snap && snap.exists()) ? snap.data() : {};
    /* Silently defaulting to viewer hides the two reasons it happens, which are
       very different problems: the rules refused the read, or the document was
       never created. Both land you in a locked console, so both get named. */
    var problem = readErr ? 'denied' : (snap && snap.exists() ? null : 'missing');
    return {
      uid: u.uid,
      email: u.email || '',
      name: d.name || u.displayName || (u.email || '').split('@')[0],
      role: d.role === 'admin' ? 'admin' : 'viewer',
      roleLabel: (d.title || (d.role === 'admin' ? 'Building manager' : 'Duty officer')).toUpperCase() +
                 ' · ' + (d.role === 'admin' ? 'ADMIN' : 'VIEWER'),
      profileProblem: problem
    };
  }

  function checkDomain(email) {
    var want = (CFG.allowedDomain || '').trim().toLowerCase();
    if (!want) return true;
    return String(email || '').toLowerCase().slice(-(want.length + 1)) === '@' + want;
  }

  return {
    mode: 'firebase',
    reason: null,

    onAuth: function (cb) {
      return authMod.onAuthStateChanged(auth, function (u) {
        if (!u) { cb(null); return; }
        profileOf(u).then(cb);
      });
    },

    signIn: function (email, password) {
      if (!checkDomain(email)) {
        return Promise.reject(new Error('Use your @' + CFG.allowedDomain + ' account.'));
      }
      return authMod.signInWithEmailAndPassword(auth, email, password);
    },

    signInWithGoogle: function () {
      var provider = new authMod.GoogleAuthProvider();
      if (CFG.allowedDomain) provider.setCustomParameters({ hd: CFG.allowedDomain });
      return authMod.signInWithPopup(auth, provider).then(function (res) {
        if (!checkDomain(res.user && res.user.email)) {
          return authMod.signOut(auth).then(function () {
            throw new Error('Use your @' + CFG.allowedDomain + ' account.');
          });
        }
        return res;
      });
    },

    signOut: function () { return authMod.signOut(auth); },

    /* ---- realtime reads ---- */

    /* Every subscription takes an error callback. A listener that is refused
       must say so: without this a denied read leaves the section on skeletons
       forever, which reads as "still loading" when it actually means "you are
       not allowed to see this". */
    onZones: function (cb, onErr) {
      var path = CFG.telemetryPath || 'zones';
      return dbMod.onValue(dbMod.ref(rtdb, path), function (snap) {
        var val = snap.val() || {};
        cb(Object.keys(val).map(function (id) {
          var z = val[id] || {};
          var r = z.r || {};
          return {
            id: id,
            name: z.name || id,
            floor: z.floor || '',
            ip: z.ip || '',
            rssi: typeof z.rssi === 'number' ? z.rssi : -70,
            lastSeen: z.ts || 0,
            r: {
              temp: +r.temp || 0, gas: +r.gas || 0, smoke: +r.smoke || 0,
              co: +r.co || 0, flame: r.flame ? 1 : 0
            },
            silenced: !!z.silenced,
            ovFan: z.ov && z.ov.fan != null ? z.ov.fan : null,
            ovMist: z.ov && z.ov.mist != null ? z.ov.mist : null,
            ovValve: z.ov && z.ov.valve != null ? z.ov.valve : null
          };
        }).sort(function (a, b) { return a.id < b.id ? -1 : 1; }));
      }, function (err) { if (onErr) onErr(err); });
    },

    onEvents: function (cb, onErr) {
      var q = fsMod.query(col('events'), fsMod.orderBy('ts', 'desc'), fsMod.limit(200));
      return fsMod.onSnapshot(q, function (snap) {
        cb(snap.docs.map(function (d) {
          var v = d.data();
          return {
            id: d.id, ts: v.ts, zone: v.zone, from: v.from, to: v.to,
            readings: v.readings, acked: !!v.acked, by: v.by || null, ackAt: v.ackAt || null
          };
        }));
      }, function (err) { if (onErr) onErr(err); });
    },

    onContacts: function (cb, onErr) {
      return fsMod.onSnapshot(col('contacts'), function (snap) {
        cb(snap.docs.map(function (d) {
          var v = d.data();
          return {
            id: d.id, name: v.name, role: v.role, phone: v.phone, email: v.email,
            channel: v.channel, scope: v.scope, min: v.min
          };
        }));
      }, function (err) { if (onErr) onErr(err); });
    },

    onDispatches: function (cb, onErr) {
      var q = fsMod.query(col('dispatches'), fsMod.orderBy('ts', 'desc'), fsMod.limit(200));
      return fsMod.onSnapshot(q, function (snap) {
        cb(snap.docs.map(function (d) {
          var v = d.data();
          return {
            id: d.id, ts: v.ts, event: v.event, zone: v.zone, sev: v.sev,
            contact: v.contact, target: v.target, channel: v.channel, status: v.status
          };
        }));
      }, function (err) { if (onErr) onErr(err); });
    },

    /* ---- writes. Every one of these is also gated by the rules files. ---- */

    ackEvent: function (id, by) {
      return fsMod.updateDoc(fsMod.doc(fs, 'events', id), { acked: true, by: by, ackAt: Date.now() });
    },
    /* No pushEvent. The client cannot append to the audit trail - events are
       written by functions/index.js through the Admin SDK, and firestore.rules
       now says `allow create: if false` on that collection. A method here would
       be a method that always fails. */
    saveContact: function (c) {
      var body = {
        name: c.name, role: c.role, phone: c.phone, email: c.email,
        channel: c.channel, scope: c.scope, min: c.min
      };
      return c.id ? fsMod.setDoc(fsMod.doc(fs, 'contacts', c.id), body) : fsMod.addDoc(col('contacts'), body);
    },
    deleteContact: function (id) { return fsMod.deleteDoc(fsMod.doc(fs, 'contacts', id)); },
    retryDispatch: function (id) {
      return fsMod.updateDoc(fsMod.doc(fs, 'dispatches', id), { status: 'sent', ts: Date.now() });
    },

    /* Overrides are commands to the node, so they go to RTDB where the ESP32 is
       already listening - not to Firestore. */
    setZoneOverride: function (zoneId, patch) {
      var path = (CFG.telemetryPath || 'zones') + '/' + zoneId;
      return dbMod.update(dbMod.ref(rtdb, path), patch);
    }
  };
}

/* ---- boot ---------------------------------------------------------------- */

(async function () {
  var api;
  if (!configLooksReal(CFG)) {
    api = downBackend('assets/js/firebase-config.js still holds placeholder values, so there is no project to connect to.');
  } else {
    try {
      api = await firebaseBackend();
    } catch (err) {
      /* Offline, blocked CDN, bad config. Say so loudly and keep saying so -
         this is not a condition to paper over with plausible-looking numbers. */
      console.error('[FUSE] Firebase unavailable:', err && err.message);
      bootMsg('Cannot reach Firebase.');
      api = downBackend((err && err.message) || 'Firebase could not be reached.');
    }
  }
  window.FUSE_BACKEND = api;
  window.__fuseReady(api);
})();

})();
