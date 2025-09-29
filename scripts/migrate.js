'use strict';
// Robust migration runner that tolerates different build layouts.
// 1) Locate a migration module from several likely paths.
// 2) Run migrations.
// 3) Close any DB handles and exit cleanly so Cloud Run Jobs complete.

const tryRequire = (p) => {
  try { return require(p); } catch { return null; }
};

const candidates = [
  '../src/lib/migrateRunner',
  '../src/db/migrateRunner',
  '../src/migrateRunner',
  './migrateRunner',
  '../dist/lib/migrateRunner',
  '../build/lib/migrateRunner',
  '../dist/migrateRunner',
  '../build/migrateRunner',
];

let mod = null;
for (const p of candidates) {
  mod = tryRequire(p);
  if (mod && typeof mod.runMigrations === 'function') {
    console.log(`[migrate] using migration module: ${p}`);
    break;
  }
}

if (!mod || typeof mod.runMigrations !== 'function') {
  console.error('[migrate] Could not locate a runMigrations() export in any known module path.');
  console.error('[migrate] Checked paths:', candidates.join(', '));
  process.exit(1);
}

const { runMigrations, pool, client, db } = mod;

const tryEnd = async (obj, label) => {
  try {
    if (obj && typeof obj.end === 'function') {
      await obj.end();
      console.log(`[migrate] closed ${label}`);
    }
  } catch (e) {
    console.error(`[migrate] close ${label} error:`, e?.message || e);
  }
};

(async () => {
  try {
    console.log('[migrate] starting migrations…');
    await runMigrations();
    console.log('[migrate] All migrations completed successfully');
    process.exitCode = 0;
  } catch (err) {
    console.error('[migrate] Failed:', err);
    process.exitCode = 1;
  } finally {
    // close likely handles from both module exports and globals
    await tryEnd(pool,   'pool');
    await tryEnd(client, 'client');
    await tryEnd(db,     'db');
    await tryEnd(globalThis.pool,   'global.pool');
    await tryEnd(globalThis.client, 'global.client');
    await tryEnd(globalThis.db,     'global.db');

    // best-effort: unref any timers/sockets that might keep the event loop alive
    const hs = (process._getActiveHandles?.() || []);
    for (const h of hs) {
      try {
        if (typeof h.hasRef === 'function' && h.hasRef()) h.unref?.();
        if (h.constructor?.name === 'Timeout')   clearTimeout(h);
        if (h.constructor?.name === 'Immediate') clearImmediate(h);
        if (h.constructor?.name === 'Interval')  clearInterval(h);
        if (typeof h.close   === 'function') h.close();
        if (typeof h.destroy === 'function') h.destroy();
      } catch {}
    }
    setImmediate(() => { console.log('[migrate] exiting now'); process.exit(process.exitCode ?? 1); });
  }
})();