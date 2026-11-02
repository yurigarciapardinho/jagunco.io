// FILE PERSISTENCE DRIVER (development / tests only)
// Byte-for-byte the JSON behaviour the server always had: accounts.json is written with
// a 250 ms debounce, chat.json with 500 ms, bans / moderation records synchronously and
// reports as JSONL appends. Production must NOT use this driver: createPersistence()
// only returns it when DATABASE_URL is missing, and logs a loud warning when that
// happens in production.

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_FILES = {
    accounts: "accounts.json",
    chat: "chat.json",
    records: "moderation.json",
    bans: "bans.json",
    reports: "reports.jsonl"
};

export class FilePersistence {

    constructor({ dataDir, log } = {}) {
        this.mode = "file";
        this.dataDir = dataDir;
        this.log = log || (() => {});
        this.files = { ...DEFAULT_FILES };
        this.timers = new Map();
    }

    // ModerationStore tells us which file names its config picked.
    setModerationFiles({ bans, records, reports }) {
        if (bans) this.files.bans = bans;
        if (records) this.files.records = records;
        if (reports) this.files.reports = reports;
    }

    async ready() {}   // file mode hydrates synchronously in the constructors

    // Loaders return null: in file mode the constructors read the JSON files themselves.
    async loadStore() { return null; }
    async loadChat() { return null; }
    async loadModeration() { return null; }

    #debounced(key, delay, write) {
        clearTimeout((this.timers.get(key) || {}).timer);
        const entry = {
            write,
            timer: setTimeout(() => {
                this.timers.delete(key);
                try {
                    write();
                } catch (err) {
                    this.log(`persistence: failed to write ${key}: ${err.message}`);
                }
            }, delay)
        };
        this.timers.set(key, entry);
    }

    syncStore(data) {
        this.#debounced("store", 250, () => {
            fs.writeFileSync(path.join(this.dataDir, this.files.accounts), JSON.stringify(data, null, 2));
        });
    }

    syncChat(data) {
        this.#debounced("chat", 500, () => {
            fs.writeFileSync(path.join(this.dataDir, this.files.chat), JSON.stringify(data));
        });
    }

    // Bans and records were always written synchronously (join/kick paths depend on it).
    syncBans(bans) {
        fs.writeFileSync(path.join(this.dataDir, this.files.bans), JSON.stringify(bans, null, 2));
    }

    syncRecords(records) {
        fs.writeFileSync(path.join(this.dataDir, this.files.records), JSON.stringify(records, null, 2));
    }

    appendReport(entry) {
        fs.appendFileSync(path.join(this.dataDir, this.files.reports), JSON.stringify(entry) + "\n");
    }

    // Run pending debounced writes now (used by tests and graceful shutdown).
    async flush() {
        const pending = [...this.timers.values()];
        this.timers.clear();
        for (const entry of pending) {
            clearTimeout(entry.timer);
            try {
                entry.write();
            } catch (err) {
                this.log(`persistence: failed to write: ${err.message}`);
            }
        }
    }

    async close() {
        await this.flush();
    }
}
