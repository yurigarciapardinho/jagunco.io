// FAKE mysql2/promise POOL - TEST DOUBLE ONLY
// An in-memory stand-in for the mysql2 promise pool, used exclusively by the
// persistence unit tests so they can run without a MySQL server. It implements just the
// SQL shapes Drizzle generates for the persistence driver (single-row inserts with
// optional ON DUPLICATE KEY UPDATE, whole-table / eq / NOT IN deletes, selects with eq
// filters and ORDER BY, BEGIN/COMMIT/ROLLBACK). It is NOT persistence: nothing here
// touches disk or the network. Production code never imports this file.

const PK = {
    accounts: ["id"],
    account_prefs: ["account_id"],
    account_socials: ["account_id"],
    account_stats: ["account_id"],
    account_animal_kills: ["account_id", "animal"],
    account_periods: ["account_id", "span"],
    legacy_ids: ["old_id"],
    friends: ["owner_id", "friend_id"],
    friend_requests: ["id"],
    clans: ["name"],
    clan_periods: ["clan_name", "span"],
    clan_members: ["clan_name", "account_id"],
    clan_member_periods: ["clan_name", "account_id", "span"],
    clan_past: ["clan_name", "ord"],
    clan_invites: ["clan_name", "account_id"],
    clan_requests: ["clan_name", "account_id"],
    chat_messages: ["id"],
    said_log: ["seq"],
    bans: ["kind", "ban_key"],
    mod_records: ["account_id"],
    mod_reports: ["seq"],
    mod_flags: ["seq"],
    report_log: ["seq"],
    migration_meta: ["mkey"]
};

const AUTO_INC = new Set(["said_log", "mod_reports", "mod_flags", "report_log"]);

// The real mysql2 parses JSON columns; the fake stores them as text, so parse on read.
const JSON_COLUMNS = {
    accounts: new Set(["look_json", "best_look_json", "unlocks_json"]),
    report_log: new Set(["payload"])
};

const norm = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();
const unquote = (ident) => ident.replace(/`/g, "").split(".").pop();

function convertParam(value) {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
}

export class FakePool {

    constructor() {
        this.tables = new Map();       // name -> [rows as plain objects keyed by column]
        this.autoInc = new Map();      // table -> next seq
        this.statements = [];          // every statement seen (for assertions)
        this.failWith = null;          // when set, the next matching statement rejects
        this.ended = false;
    }

    // Test helpers -----------------------------------------------------------
    rows(table) {
        return (this.tables.get(table) || []).map(r => ({ ...r }));
    }

    // Make the next statement whose SQL contains `needle` reject once.
    failNext(needle, message = "fake driver failure") {
        this.failWith = { needle: needle.toLowerCase(), message };
    }

    async end() {
        this.ended = true;
    }

    async getConnection() {
        const pool = this;
        let released = false;
        return {
            query: (opts, params) => {
                if (released) return Promise.reject(new Error("fake connection used after release"));
                return pool.query(opts, params);
            },
            release() {
                released = true;
            }
        };
    }

    // mysql2 promise interface: query(sql) or query({sql, rowsAsArray, ...}, values)
    async query(opts, values = []) {
        const sql = typeof opts === "string" ? opts : opts.sql;
        const rowsAsArray = !!(typeof opts === "object" && opts && opts.rowsAsArray);
        const params = Array.isArray(values) ? values.map(convertParam) : [];
        const text = norm(sql);
        this.statements.push({ sql: text, params: [...params] });
        if (this.failWith && text.includes(this.failWith.needle)) {
            const failure = this.failWith;
            this.failWith = null;
            throw new Error(failure.message);
        }
        return this.#execute(text, params, rowsAsArray);
    }

    #table(name) {
        if (!this.tables.has(name)) this.tables.set(name, []);
        return this.tables.get(name);
    }

    #execute(text, params, rowsAsArray) {
        if (text.startsWith("begin") || text.startsWith("commit") || text.startsWith("rollback")) {
            return [{}];
        }
        if (text.startsWith("create table") || text.startsWith("alter table") || text.startsWith("update accounts set password_credential_v")) {
            const m = /create table if not exists `?(\w+)`?/.exec(text);
            if (m) this.#table(m[1]);
            return [{}];
        }
        if (text.includes("information_schema")) {
            // fresh install: password_credential already exists as varchar(512)
            return [[{ dataType: "varchar" }]];
        }
        if (text.startsWith("select")) return this.#select(text, params, rowsAsArray);
        if (text.startsWith("insert")) return this.#insert(text, params);
        if (text.startsWith("delete")) return this.#delete(text, params);
        throw new Error(`fake mysql2: unsupported statement: ${text.slice(0, 120)}`);
    }

    #select(text, params, rowsAsArray) {
        const m = /^select (.+?) from `(\w+)`(.*)$/.exec(text);
        if (!m) throw new Error(`fake mysql2: cannot parse select: ${text}`);
        const cols = m[1].split(",").map(c => unquote(c.trim()));
        const table = m[2];
        const rest = m[3];
        let rows = this.#table(table).slice();
        let p = 0;
        const where = /where (.*?)( order by |$)/.exec(rest);
        if (where) {
            const eqM = new RegExp("`\\w+`\\.`(\\w+)` = \\?").exec(where[1]);
            if (eqM) {
                const col = eqM[1], val = params[p++];
                rows = rows.filter(r => r[col] === val);
            } else {
                throw new Error(`fake mysql2: unsupported select filter: ${where[1]}`);
            }
        }
        const orderM = /order by (.+)$/.exec(rest);
        if (orderM) {
            const keys = orderM[1].split(",").map(part => {
                const bits = part.trim().split(/\s+/);
                return { col: unquote(bits[0]), dir: bits[1] === "desc" ? -1 : 1 };
            });
            rows.sort((a, b) => {
                for (const { col, dir } of keys) {
                    if (a[col] < b[col]) return -1 * dir;
                    if (a[col] > b[col]) return 1 * dir;
                }
                return 0;
            });
        }
        if (rowsAsArray) return [rows.map(r => cols.map(c => this.#readValue(table, c, r[c])))];
        return [rows.map(r => {
            const out = {};
            for (const c of cols) out[c] = this.#readValue(table, c, r[c]);
            return out;
        })];
    }

    #readValue(table, col, value) {
        if (value === undefined) return null;
        if (JSON_COLUMNS[table] && JSON_COLUMNS[table].has(col) && typeof value === "string") {
            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        }
        return value;
    }

    #insert(text, params) {
        const m = /^insert into `(\w+)` \((.+?)\) values (.+?)( on duplicate key update (.+))?$/.exec(text);
        if (!m) throw new Error(`fake mysql2: cannot parse insert: ${text}`);
        const table = m[1];
        const cols = m[2].split(",").map(c => unquote(c.trim()));
        const valuesPart = m[3];
        const rows = this.#table(table);
        let p = 0;
        let affected = 0;
        let insertId = 0;
        const pk = PK[table] || [];
        // Each values group mixes `?` placeholders with literals like `default`
        // (autoincrement columns); only `?` consumes a bound parameter.
        const valueGroups = (valuesPart.match(/\(([^()]*)\)/g) || []).map(g => g.slice(1, -1).split(",").map(s => s.trim()));
        for (const tokens of valueGroups) {
            const row = {};
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i] === "?") row[cols[i]] = params[p++];
                else if (tokens[i] === "default") row[cols[i]] = null;
                else row[cols[i]] = tokens[i].replace(/^'(.*)'$/, "$1");
            }
            if (AUTO_INC.has(table)) {
                const next = (this.autoInc.get(table) || 1);
                if (row.seq == null) row.seq = next;
                this.autoInc.set(table, Math.max(next + 1, row.seq + 1));
                if (!insertId) insertId = row.seq;
            }
            const existing = pk.length ? rows.find(r => pk.every(col => r[col] === row[col])) : null;
            if (!existing) {
                rows.push(row);
                affected++;
            } else if (m[5]) {
                // ON DUPLICATE KEY UPDATE `col` = ?, ...
                for (const assignment of m[5].split(",")) {
                    const col = unquote(assignment.split("=")[0].trim());
                    existing[col] = params[p++];
                    affected++;
                }
            }
        }
        return [{ insertId, affectedRows: affected }];
    }

    #delete(text, params) {
        const m = /^delete from `(\w+)`(.*)$/.exec(text);
        if (!m) throw new Error(`fake mysql2: cannot parse delete: ${text}`);
        const table = m[1];
        let rows = this.#table(table);
        const before = rows.length;
        const rest = m[2];
        if (rest.trim()) {
            const eqM = /where `\w+`\.`(\w+)` = \?/.exec(rest);
            const notInM = /where `\w+`\.`(\w+)` not in \(([^)]*)\)/.exec(rest);
            if (eqM) {
                const [col, val] = [eqM[1], params[0]];
                rows = rows.filter(r => r[col] !== val);
            } else if (notInM) {
                const col = notInM[1];
                const count = notInM[2].split(",").length;
                const vals = params.slice(0, count);
                rows = rows.filter(r => vals.includes(r[col]));
            } else {
                throw new Error(`fake mysql2: unsupported delete filter: ${rest}`);
            }
        } else {
            rows = [];
        }
        this.tables.set(table, rows);
        return [{ affectedRows: before - rows.length }];
    }
}

export function createFakePool() {
    return new FakePool();
}
