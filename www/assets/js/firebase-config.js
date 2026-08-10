/* ==========================================================================
   FUSE - Firebase project configuration
   --------------------------------------------------------------------------
   Fill this in with your own Firebase project and the console switches from the
   built-in simulator to real auth and real telemetry. Leave it as-is and the app
   runs in demo mode, so the public GitHub Pages build still works.

   Where to get these values:
     Firebase console → Project settings → General → Your apps → Web app → Config

   These keys are NOT secrets. A web apiKey identifies the project; it does not
   grant access. Access is decided by Firebase Auth plus the rules in
   firestore.rules and database.rules.json - those are what you must get right.
   Never put a service-account key or an admin credential in this file.
   ========================================================================== */

window.FUSE_CONFIG = {

  /* Flip to true once the values below are real. */
  enabled: true,

  firebase: {
    apiKey:            'AIzaSyCOGWw6onkOeMX64J9ZOshIMjJc9xoZvhY',
    authDomain:        'spendwise-dec03.firebaseapp.com',
    databaseURL:       'https://spendwise-dec03-default-rtdb.firebaseio.com',
    projectId:         'spendwise-dec03',
    storageBucket:     'spendwise-dec03.firebasestorage.app',
    messagingSenderId: '290049464757',
    appId:             '1:290049464757:web:70d63271e21c5710eda1fc',
    measurementId:     'G-MJ5P5FW6E4'   /* Analytics only; this console does not use it. */
  },

  /* Which sign-in methods to offer. These must match what is actually enabled
     under Firebase console → Authentication → Sign-in method, because the client
     cannot ask which providers exist: an unenabled provider only fails once the
     user has already clicked it.

     Google is off deliberately. The project has Email/Password enabled and not
     Google, and this console has a known handful of operators rather than open
     public sign-up, so the button would be an error waiting to be clicked. To
     turn it on: enable Google in the console, set this to true, add the
     deployment domain under Authentication → Settings → Authorised domains, and
     create a users/{uid} document for the new account or it signs in as a
     viewer. */
  providers: {
    password: true,
    google: false
  },

  /* Restrict sign-in to one email domain, e.g. 'meridiancourt.ph'. Leave empty
     to allow any account that exists. This is a UI convenience - the real gate
     is the rules file, which checks the user's role document. */
  allowedDomain: '',

  /* Realtime Database path the ESP32 nodes publish to. See CLAUDE.md § Firebase. */
  telemetryPath: 'zones',

  /* How long a node may go without a heartbeat before the console holds it at
     OFFLINE rather than trusting its last reading (ms). */
  heartbeatTimeoutMs: 60000
};
