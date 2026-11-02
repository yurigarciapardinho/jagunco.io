// PERSISTENCE FACTORY
// Picks the storage backend for accounts/profiles/friends/clans/chat/moderation:
//
//   DATABASE_URL set    -> MySqlPersistence (production): hydrate via ready(), writes
//                          are queued async with flush()/close().
//   DATABASE_URL unset  -> FilePersistence: the original JSON files. Development and
//                          tests only. In NODE_ENV=production this logs a loud warning,
//                          because production persistence requires MySQL.
//
// The secret value of DATABASE_URL is never logged.

import { FilePersistence } from "./fileDriver.js";
import { MySqlPersistence } from "./mysqlDriver.js";

export function createPersistence({ dataDir, databaseUrl = process.env.DATABASE_URL, log = console.log, createPool } = {}) {
    if (databaseUrl) {
        return new MySqlPersistence({ databaseUrl, dataDir, log, createPool });
    }
    // File storage is a development/test convenience only: production data must live in
    // MySQL, so booting production without DATABASE_URL fails explicitly.
    if (process.env.NODE_ENV === "production") {
        throw new Error("persistence: DATABASE_URL is required in production (MySQL); JSON file storage is development-only");
    }
    return new FilePersistence({ dataDir, log });
}

export { FilePersistence } from "./fileDriver.js";
export { MySqlPersistence } from "./mysqlDriver.js";
export { WriteQueue } from "./queue.js";
