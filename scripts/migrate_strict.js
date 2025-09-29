// Strict one-shot migration runner:
// 1) run migrations, 2) print active handles, 3) close them, 4) exit.
// Adjust the import below to your actual migration entrypoint.
let dbmod = {};
try { dbmod = require("../src/lib/migrateRunner"); } catch {}
const { runMigrations, pool, client, db } = dbmod;

const tryEnd = async (obj, label) => {
  try { if (obj && typeof obj.end === "function") { await obj.end(); console.log(`[strict] closed ${label}`); } }
  catch (e) { console.error(`[strict] close ${label} error:`, e?.message || e); }
};
const printActive = (phase) => {
  const reqs = (process._getActiveRequests?.() || []).map(x => x?.constructor?.name);
  const hs   = (process._getActiveHandles?.()  || []).map(x => x?.constructor?.name);
  console.log(`[strict] ${phase} activeRequests:`, reqs);
  console.log(`[strict] ${phase} activeHandles:`,  hs);
};

(async () => {
  try {
    console.log("[strict] starting migrations…");
    if (typeof runMigrations !== "function") throw new Error("runMigrations not found");
    await runMigrations();
    console.log("[strict] All migrations completed successfully");
    process.exitCode = 0;
  } catch (err) {
    console.error("[strict] Migration failed:", err);
    process.exitCode = 1;
  } finally {
    printActive("before-close");
    await tryEnd(globalThis.db,     "global.db");
    await tryEnd(globalThis.pool,   "global.pool");
    await tryEnd(globalThis.client, "global.client");
    await tryEnd(db,                "db");
    await tryEnd(pool,              "pool");
    await tryEnd(client,            "client");
    // Nuke common stragglers (timers/sockets/servers)
    for (const h of (process._getActiveHandles?.() || [])) {
      try {
        if (typeof h.hasRef === "function" && h.hasRef()) h.unref?.();
        if (h.constructor?.name === "Timeout")   clearTimeout(h);
        if (h.constructor?.name === "Immediate") clearImmediate(h);
        if (h.constructor?.name === "Interval")  clearInterval(h);
        if (typeof h.close   === "function") h.close();
        if (typeof h.destroy === "function") h.destroy();
      } catch {}
    }
    printActive("after-close");
    setImmediate(() => { console.log("[strict] exiting now"); process.exit(process.exitCode ?? 1); });
  }
})();
