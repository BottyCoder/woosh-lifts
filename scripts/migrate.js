// One-shot migration runner that *always exits*.
// Assumes your DB module exposes a client/pool with .end()
const { runMigrations, pool, client, db } = require('../src/lib/migrateRunner'); // adjust import to your project

(async () => {
  try {
    await runMigrations();
    console.log("All migrations completed successfully.");
    process.exitCode = 0;
  } catch (err) {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    try { if (globalThis.db?.end) await globalThis.db.end(); } catch {}
    try { if (typeof db?.end === 'function') await db.end(); } catch {}
    try { if (typeof pool?.end === 'function') await pool.end(); } catch {}
    try { if (typeof client?.end === 'function') await client.end(); } catch {}
    setImmediate(() => process.exit(process.exitCode ?? 1));
  }
})();