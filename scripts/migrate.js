'use strict';
// Auto-discovering migration runner:
// 1) Try common module paths
// 2) If not found, scan /app up to depth 3 for a file that exports runMigrations()
// 3) Run migrations
// 4) Close handles and hard-exit so Cloud Run marks the job Completed

const fs = require('fs');
const path = require('path');
const tryRequire = (p) => { try { return require(p); } catch { return null; } };

const common = [
  '../src/lib/migrateRunner',
  '../src/db/migrateRunner',
  '../src/migrateRunner',
  './migrateRunner',
  '../lib/migrateRunner',
  '../migrateRunner',
  './lib/migrateRunner',
  '../dist/lib/migrateRunner',
  '../build/lib/migrateRunner',
  '../dist/migrateRunner',
  '../build/migrateRunner',
];

let mod = null, chosen = null;
for (const p of common) {
  const m = tryRequire(p);
  if (m && typeof m.runMigrations === 'function') { mod = m; chosen = p; break; }
}

if (!mod) {
  // filesystem search: look for candidates named *migrate*.* under /app (depth <= 3)
  const root = '/app';
  const hits = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(js|cjs|mjs|ts)$/.test(p)) continue;
      if (/migrate|runner|knexfile|prisma|sequelize/i.test(p)) hits.push(p);
    }
  };
  walk(root, 0);
  for (const file of hits) {
    const rel = path.relative(__dirname, file).replace(/\\/g, '/');
    const test = rel.startsWith('.') ? rel : './' + rel;
    const m = tryRequire(test);
    if (m && typeof m.runMigrations === 'function') { mod = m; chosen = test; break; }
  }
}

if (!mod) {
  console.error('[migrate] Could not locate runMigrations() in common paths or filesystem scan.');
  console.error('[migrate] Searched common:', common.join(', '));
  console.error('[migrate] Searched under /app (depth 3) for files matching /(migrate|runner|knexfile|prisma|sequelize)/');
  process.exit(1);
}
console.log(`[migrate] using migration module: ${chosen}`);

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
    await tryEnd(pool, 'pool');
    await tryEnd(client, 'client');
    await tryEnd(db, 'db');
    await tryEnd(globalThis.pool, 'global.pool');
    await tryEnd(globalThis.client, 'global.client');
    await tryEnd(globalThis.db, 'global.db');
    // unref stragglers (timers/sockets)
    for (const h of (process._getActiveHandles?.() || [])) {
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