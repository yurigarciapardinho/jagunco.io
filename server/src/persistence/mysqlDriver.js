// MYSQL PERSISTENCE DRIVER (production)
// Used whenever DATABASE_URL is set. Runtime state stays in memory (the clone's API is
// synchronous); this driver hydrates it at startup (ready()) and mirrors every mutation
// to MySQL through the write queue (keyed, coalescing, serialized, errors logged not
// thrown). All CRUD goes through Drizzle's query API over a mysql2 pool; the only raw
// SQL is the schema bootstrap in migrations.js. All values are bound parameters.
//
// Snapshots are written by reconcile: upsert what's in memory, delete what isn't, in a
// single transaction per sync. JSON-file data present in dataDir is imported once
// (additive, idempotent, recorded in migration_meta) the first time each domain is used.

import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { eq, asc, notInArray } from "drizzle-orm";
import * as schema from "./schema.js";
import { MIGRATIONS } from "./migrations.js";
import { WriteQueue } from "./queue.js";
import { DEFAULT_FILES } from "./fileDriver.js";

// Parse DATABASE_URL without ever logging it (it carries credentials).
function parseDatabaseUrl(databaseUrl) {
    let url;
    try {
        url = new URL(databaseUrl);
    } catch {
        throw new Error("persistence: DATABASE_URL is not a valid URL");
    }
    if (url.protocol !== "mysql:" && url.protocol !== "mysql2:") {
        throw new Error("persistence: DATABASE_URL must use the mysql:// scheme");
    }
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!database) throw new Error("persistence: DATABASE_URL must include a database name");
    return {
        host: url.hostname || "127.0.0.1",
        port: url.port ? Number(url.port) : 3306,
        user: decodeURIComponent(url.username || "root"),
        password: decodeURIComponent(url.password || ""),
        database,
        waitForConnections: true,
        connectionLimit: 4,
        namedPlaceholders: false,
        supportBigNumbers: true,
        bigNumberStrings: false
    };
}

const emptyStoreData = () => ({ accounts: {}, emails: {}, names: {}, clans: {}, social: { friends: {}, requests: [] }, legacyIds: {} });
const emptyChatData = () => ({ whispers: {}, clans: {}, said: {} });
const emptyModeration = () => ({ bans: { ips: {}, accounts: {}, devices: {} }, records: {} });
const emptyStatsShape = () => ({
    kills: 0, deaths: 0, damage: 0, healing: 0, wood: 0, food: 0, stone: 0, gold: 0,
    animalDamage: 0, animalKills: {}, bestScore: 0, maxKills: 0, lives: 0, playtime: 0, periods: {}
});

// mysql2 returns JSON columns already parsed; parse defensively in case a driver hands
// us the raw text instead.
const asJson = (value) => (typeof value === "string" ? JSON.parse(value) : value);

// The clone keeps free-form sub-objects on accounts; anything not mapped to a column is
// preserved through the flexible JSON columns only where the schema allows it.

export class MySqlPersistence {

    // createPool is injectable ONLY so tests can substitute a fake driver; production
    // code paths always use the real mysql2 pool.
    constructor({ databaseUrl, dataDir, log, createPool } = {}) {
        this.mode = "mysql";
        this.dataDir = dataDir;
        this.log = log || (() => {});
        this.files = { ...DEFAULT_FILES };
        this.queue = new WriteQueue({
            onError: (err, key) => this.log(`persistence: write "${key}" failed (state kept in memory; next change retries): ${err.message}`)
        });
        this.schemaReady = false;
        this.schemaPromise = null;
        this.migrated = new Set();
        this.migrating = new Map();   // domain -> Promise (dedupe concurrent triggers)
        this.appendSeq = 0;

        const makePool = createPool || ((config) => mysql.createPool(config));
        this.pool = makePool(parseDatabaseUrl(databaseUrl));
        this.db = drizzle(this.pool, { schema, mode: "default" });
    }

    setModerationFiles({ bans, records, reports }) {
        if (bans) this.files.bans = bans;
        if (records) this.files.records = records;
        if (reports) this.files.reports = reports;
    }

    async ready() {
        await this.#ensureSchema();
        await Promise.all([
            this.#ensureMigrated("store"),
            this.#ensureMigrated("chat"),
            this.#ensureMigrated("moderation")
        ]);
    }

    async flush() {
        await this.queue.flush();
    }

    async close() {
        await this.queue.close();
        if (this.queue.errors) this.log(`persistence: closed with ${this.queue.errors} failed write(s) - see errors above`);
        if (this.pool && typeof this.pool.end === "function") await this.pool.end();
    }

    // ---------------------------------------------------------------- schema
    // Runs migration batches; applied batches are recorded in migration_meta so boot is
    // idempotent. A batch either lists raw DDL `statements` (IF NOT EXISTS, re-runnable)
    // or provides `run(pool)` for conditional changes. (The meta table itself is created
    // by 0001, which is safe to re-run even before the marker can be written.)
    async #ensureSchema() {
        if (this.schemaReady) return;
        if (!this.schemaPromise) {
            this.schemaPromise = (async () => {
                for (const batch of MIGRATIONS) {
                    let applied = [];
                    try {
                        applied = await this.db.select().from(schema.migrationMeta).where(eq(schema.migrationMeta.mkey, "schema_" + batch.name));
                    } catch {
                        applied = []; // meta table does not exist yet (first ever boot)
                    }
                    if (applied.length) continue;
                    if (typeof batch.run === "function") {
                        await batch.run(this.pool);
                    } else {
                        for (const statement of batch.statements) {
                            try {
                                await this.pool.query(statement);
                            } catch (err) {
                                if (!batch.ignoreErrno || !batch.ignoreErrno.includes(err && err.errno)) throw err;
                            }
                        }
                    }
                    try {
                        await this.db.insert(schema.migrationMeta).values({ mkey: "schema_" + batch.name, doneAt: Date.now() });
                    } catch (err) {
                        this.log(`persistence: could not record schema batch ${batch.name}: ${err.message}`);
                    }
                }
                this.schemaReady = true;
            })();
        }
        await this.schemaPromise;
    }

    // ---------------------------------------------------------------- JSON import
    #readJsonFile(fileName) {
        try {
            return JSON.parse(fs.readFileSync(path.join(this.dataDir, fileName), "utf8"));
        } catch {
            return null;
        }
    }

    // One-shot, additive, idempotent import of the JSON files a file-mode deployment
    // left behind. Keep-existing semantics: rows already in MySQL always win, nothing
    // is ever deleted or overwritten, and migration_meta records completion (the marker
    // is written in the same transaction, so a crash simply re-runs harmlessly).
    async #ensureMigrated(domain) {
        if (this.migrated.has(domain)) return;
        if (this.migrating.has(domain)) return this.migrating.get(domain);
        const run = (async () => {
            await this.#ensureSchema();
            const marker = "json_import_" + domain;
            const done = await this.db.select().from(schema.migrationMeta).where(eq(schema.migrationMeta.mkey, marker));
            if (done.length) {
                this.migrated.add(domain);
                return;
            }
            await this.db.transaction(async (tx) => {
                if (domain === "store") {
                    const data = this.#readJsonFile(this.files.accounts);
                    if (data) await this.#writeStore(tx, normalizeStoreData(data), { deletes: false });
                }
                if (domain === "chat") {
                    const data = this.#readJsonFile(this.files.chat);
                    if (data) await this.#writeChat(tx, normalizeChatData(data), { deletes: false });
                }
                if (domain === "moderation") {
                    const bansData = this.#readJsonFile(this.files.bans);
                    const records = this.#readJsonFile(this.files.records);
                    if (bansData) await this.#writeBans(tx, normalizeBans(bansData), { deletes: false });
                    if (records) await this.#writeRecords(tx, records, { deletes: false });
                }
                await tx.insert(schema.migrationMeta).values({ mkey: marker, doneAt: Date.now() });
            });
            this.migrated.add(domain);
            this.log(`persistence: JSON import for "${domain}" done (or nothing to import)`);
        })();
        this.migrating.set(domain, run);
        try {
            await run;
        } finally {
            this.migrating.delete(domain);
        }
    }

    // ---------------------------------------------------------------- load (hydrate)
    async loadStore() {
        await this.#ensureMigrated("store");
        const data = emptyStoreData();
        const [accountRows, prefRows, socialRows, statRows, animalRows, periodRows, legacyRows,
            friendRows, requestRows, clanRows, clanPeriodRows, memberRows, memberPeriodRows,
            pastRows, inviteRows, clanRequestRows] = await Promise.all([
            this.db.select().from(schema.accounts),
            this.db.select().from(schema.accountPrefs),
            this.db.select().from(schema.accountSocials),
            this.db.select().from(schema.accountStats),
            this.db.select().from(schema.accountAnimalKills),
            this.db.select().from(schema.accountPeriods),
            this.db.select().from(schema.legacyIds),
            this.db.select().from(schema.friends),
            this.db.select().from(schema.friendRequests),
            this.db.select().from(schema.clans),
            this.db.select().from(schema.clanPeriods),
            this.db.select().from(schema.clanMembers),
            this.db.select().from(schema.clanMemberPeriods),
            this.db.select().from(schema.clanPast).orderBy(asc(schema.clanPast.ord)),
            this.db.select().from(schema.clanInvites).orderBy(asc(schema.clanInvites.ord)),
            this.db.select().from(schema.clanRequests).orderBy(asc(schema.clanRequests.ord))
        ]);

        const prefsBy = new Map(prefRows.map(r => [r.accountId, r]));
        const socialsBy = new Map(socialRows.map(r => [r.accountId, r]));
        const statsBy = new Map(statRows.map(r => [r.accountId, r]));

        for (const row of accountRows) {
            const prefs = prefsBy.get(row.id);
            const socials = socialsBy.get(row.id);
            const stats = statsBy.get(row.id);
            const account = {
                id: row.id,
                email: row.email,
                name: row.name,
                role: row.role,
                clan: row.clan,
                createdAt: row.createdAt,
                verdict: row.verdict,
                stats: stats ? {
                    kills: stats.kills, deaths: stats.deaths, damage: stats.damage, healing: stats.healing,
                    wood: stats.wood, food: stats.food, stone: stats.stone, gold: stats.gold,
                    animalDamage: stats.animalDamage, animalKills: {}, bestScore: stats.bestScore,
                    maxKills: stats.maxKills, lives: stats.lives, playtime: stats.playtime, periods: {}
                } : emptyStatsShape(),
                socials: {},
                prefs: prefs ? {
                    friendNotifs: !!prefs.friendNotifs, friendRequests: !!prefs.friendRequests,
                    clanInvites: !!prefs.clanInvites, clanChat: !!prefs.clanChat, whispers: !!prefs.whispers
                } : {}
            };
            for (const field of ["youtube", "twitch", "tiktok", "x", "discord"]) {
                if (socials && socials[field]) account.socials[field] = socials[field];
            }
            if (row.look) account.look = asJson(row.look);
            if (row.bestLook) account.bestLook = asJson(row.bestLook);
            if (row.unlocks) account.unlocks = asJson(row.unlocks);
            if (row.discordName) account.discord = { name: row.discordName, linkedAt: row.discordLinkedAt };
            if (row.passwordCredential) account.passwordCredential = row.passwordCredential;
            data.accounts[row.id] = account;
            data.emails[account.email] = row.id;
            if (account.name) data.names[account.name.toLowerCase()] = row.id;
        }
        for (const row of animalRows) {
            const account = data.accounts[row.accountId];
            if (account) account.stats.animalKills[row.animal] = row.kills;
        }
        for (const row of periodRows) {
            const account = data.accounts[row.accountId];
            if (account) account.stats.periods[row.span] = { key: row.periodKey, kills: row.kills, bestScore: row.bestScore };
        }
        for (const row of legacyRows) data.legacyIds[row.oldId] = row.newId;
        for (const row of friendRows) {
            (data.social.friends[row.ownerId] = data.social.friends[row.ownerId] || []).push({ id: row.friendId, createdAt: row.createdAt });
        }
        for (const row of requestRows) {
            data.social.requests.push({ id: row.id, senderId: row.senderId, recipientId: row.recipientId, createdAt: row.createdAt });
        }

        for (const row of clanRows) {
            data.clans[row.name] = {
                name: row.name, createdAt: row.createdAt, closed: !!row.closed, shadowed: !!row.shadowed,
                members: [], past: [], invites: [], requests: [],
                stats: { kills: row.kills, raidKills: row.raidKills, periods: {} }
            };
        }
        for (const row of clanPeriodRows) {
            const clan = data.clans[row.clanName];
            if (clan) clan.stats.periods[row.span] = { key: row.periodKey, kills: row.kills };
        }
        for (const row of memberRows) {
            const clan = data.clans[row.clanName];
            if (clan) clan.members.push({ id: row.accountId, role: row.role, stint: row.stint, joinedAt: row.joinedAt, kills: row.kills, periods: {} });
        }
        for (const row of memberPeriodRows) {
            const clan = data.clans[row.clanName];
            const member = clan && clan.members.find(m => m.id === row.accountId);
            if (member) member.periods[row.span] = { key: row.periodKey, kills: row.kills };
        }
        for (const row of pastRows) {
            const clan = data.clans[row.clanName];
            if (clan) clan.past.push({ id: row.accountId, stint: row.stint, left: row.leftAt, kicked: !!row.kicked, kills: row.kills });
        }
        for (const row of inviteRows) {
            const clan = data.clans[row.clanName];
            if (clan) clan.invites.push({ id: row.accountId, by: row.invitedBy });
        }
        for (const row of clanRequestRows) {
            const clan = data.clans[row.clanName];
            if (clan) clan.requests.push(row.accountId);
        }
        return data;
    }

    async loadChat() {
        await this.#ensureMigrated("chat");
        const data = emptyChatData();
        const [messageRows, saidRows] = await Promise.all([
            this.db.select().from(schema.chatMessages).orderBy(asc(schema.chatMessages.thread), asc(schema.chatMessages.ord)),
            this.db.select().from(schema.saidLog).orderBy(asc(schema.saidLog.accountId), asc(schema.saidLog.ord))
        ]);
        for (const row of messageRows) {
            const message = {
                id: row.id, kind: row.kind,
                from: row.fromId ? { id: row.fromId, name: row.fromName } : { name: row.fromName },
                text: row.text, at: row.at
            };
            if (row.kind === "clan") message.clan = row.thread;
            if (row.toId || row.toName) message.to = { id: row.toId, name: row.toName };
            if (row.shadow) message.shadow = true;
            if (row.isSystem) message.system = true;
            const bucket = row.kind === "clan" ? data.clans : data.whispers;
            (bucket[row.thread] = bucket[row.thread] || []).push(message);
        }
        for (const row of saidRows) {
            const entry = { at: row.at, kind: row.kind, text: row.text };
            if (row.kind === "whisper") entry.to = { name: row.target };
            else if (row.kind === "clan") entry.clan = row.target;
            else if (row.target) entry.server = row.target;
            if (row.shadow) entry.shadow = true;
            (data.said[row.accountId] = data.said[row.accountId] || []).push(entry);
        }
        return data;
    }

    async loadModeration() {
        await this.#ensureMigrated("moderation");
        const out = emptyModeration();
        const [banRows, recordRows, reportRows, flagRows] = await Promise.all([
            this.db.select().from(schema.bans),
            this.db.select().from(schema.modRecords),
            this.db.select().from(schema.modReports).orderBy(asc(schema.modReports.accountId), asc(schema.modReports.ord)),
            this.db.select().from(schema.modFlags).orderBy(asc(schema.modFlags.accountId), asc(schema.modFlags.ord))
        ]);
        const bucketOf = { ip: "ips", account: "accounts", device: "devices" };
        for (const row of banRows) {
            const bucket = bucketOf[row.kind];
            if (!bucket) continue;
            out.bans[bucket][row.banKey] = {
                name: row.name, by: row.bannedBy,
                reason: row.reason || undefined, until: row.until || undefined, at: row.at
            };
        }
        for (const row of recordRows) {
            out.records[row.accountId] = {
                reports: [], flags: [],
                verdict: row.verdictLevel ? { level: row.verdictLevel, reason: row.verdictReason, by: row.verdictBy, at: row.verdictAt } : null
            };
        }
        for (const row of reportRows) {
            const rec = out.records[row.accountId] || (out.records[row.accountId] = { reports: [], flags: [], verdict: null });
            const entry = {
                at: row.at,
                by: { name: row.byName, kind: row.byKind },
                sessionReports: row.sessionReports
            };
            if (row.reason) entry.reason = row.reason;
            rec.reports.push(entry);
        }
        for (const row of flagRows) {
            const rec = out.records[row.accountId] || (out.records[row.accountId] = { reports: [], flags: [], verdict: null });
            rec.flags.push({ at: row.at, signal: row.signal });
        }
        return out;
    }

    // ---------------------------------------------------------------- sync (write)
    // Public sync* methods are called from the (synchronous) domain stores after every
    // mutation. They enqueue one reconcile job each; the queue coalesces bursts so only
    // the latest snapshot is written. The job reads the live in-memory object at run
    // time, so it always persists the newest state.
    syncStore(data) {
        this.queue.enqueue("store", async () => {
            await this.#ensureMigrated("store");
            await this.db.transaction((tx) => this.#writeStore(tx, data, { deletes: true }));
        });
    }

    syncChat(data) {
        this.queue.enqueue("chat", async () => {
            await this.#ensureMigrated("chat");
            await this.db.transaction((tx) => this.#writeChat(tx, data, { deletes: true }));
        });
    }

    syncBans(bans) {
        this.queue.enqueue("bans", async () => {
            await this.#ensureMigrated("moderation");
            await this.db.transaction((tx) => this.#writeBans(tx, bans, { deletes: true }));
        });
    }

    syncRecords(records) {
        this.queue.enqueue("records", async () => {
            await this.#ensureMigrated("moderation");
            await this.db.transaction((tx) => this.#writeRecords(tx, records, { deletes: true }));
        });
    }

    // Append-only moderation log; each call is its own job (unique key, no coalescing).
    appendReport(entry) {
        this.queue.enqueue("report:" + (++this.appendSeq), async () => {
            await this.#ensureMigrated("moderation");
            await this.db.insert(schema.reportLog).values({
                at: String(entry.at || new Date().toISOString()),
                kind: entry.reason !== undefined ? "reason" : "report",
                targetName: (entry.target && entry.target.name) || null,
                targetAccount: (entry.target && entry.target.account) || null,
                reporterName: (entry.reporter && entry.reporter.name) || null,
                reporterAccount: (entry.reporter && entry.reporter.account) || null,
                reason: entry.reason || null,
                payload: (entry.target && entry.target.flags) ? { flags: entry.target.flags } : null
            });
        });
    }

    // upsert: full overwrite on conflict (sync); keep: existing row wins (JSON import).
    async #upsert(tx, table, row, pkSet) {
        await tx.insert(table).values(row).onDuplicateKeyUpdate({ set: pkSet || row });
    }

    async #writeStore(tx, data, { deletes }) {
        const keepExisting = !deletes;
        const accountList = Object.values(data.accounts || {});
        const ids = accountList.map(a => a.id);

        if (deletes) {
            const childTables = [schema.accountPrefs, schema.accountSocials, schema.accountStats, schema.accountAnimalKills, schema.accountPeriods];
            if (ids.length) {
                await tx.delete(schema.accounts).where(notInArray(schema.accounts.id, ids));
                for (const table of childTables) await tx.delete(table).where(notInArray(table.accountId, ids));
            } else {
                await tx.delete(schema.accounts);
                for (const table of childTables) await tx.delete(table);
            }
        }

        for (const account of accountList) {
            const row = accountRow(account);
            await this.#upsert(tx, schema.accounts, row, keepExisting && { id: row.id });
            const prefs = prefsRow(account);
            await this.#upsert(tx, schema.accountPrefs, prefs, keepExisting && { accountId: prefs.accountId });
            const socials = socialsRow(account);
            await this.#upsert(tx, schema.accountSocials, socials, keepExisting && { accountId: socials.accountId });
            const stats = statsRow(account);
            await this.#upsert(tx, schema.accountStats, stats, keepExisting && { accountId: stats.accountId });

            if (deletes) {
                await tx.delete(schema.accountAnimalKills).where(eq(schema.accountAnimalKills.accountId, account.id));
                await tx.delete(schema.accountPeriods).where(eq(schema.accountPeriods.accountId, account.id));
            }
            const animals = Object.entries((account.stats && account.stats.animalKills) || {});
            for (const [animal, kills] of animals) {
                await this.#upsert(tx, schema.accountAnimalKills, { accountId: account.id, animal, kills }, keepExisting && { accountId: account.id, animal });
            }
            const periods = Object.entries((account.stats && account.stats.periods) || {});
            for (const [span, p] of periods) {
                await this.#upsert(tx, schema.accountPeriods, { accountId: account.id, span, periodKey: p.key, kills: p.kills || 0, bestScore: p.bestScore || 0 }, keepExisting && { accountId: account.id, span });
            }
        }

        // legacy ids accumulate forever; re-mapping an old id to its new id is idempotent.
        for (const [oldId, newId] of Object.entries(data.legacyIds || {})) {
            await this.#upsert(tx, schema.legacyIds, { oldId, newId }, { newId });
        }

        if (deletes) {
            await tx.delete(schema.friends);
            await tx.delete(schema.friendRequests);
        }
        for (const [ownerId, list] of Object.entries((data.social && data.social.friends) || {})) {
            for (const friend of list) {
                const row = { ownerId, friendId: friend.id, createdAt: friend.createdAt };
                await this.#upsert(tx, schema.friends, row, keepExisting && { ownerId, friendId: friend.id });
            }
        }
        for (const request of (data.social && data.social.requests) || []) {
            const row = { id: request.id, senderId: request.senderId, recipientId: request.recipientId, createdAt: request.createdAt };
            await this.#upsert(tx, schema.friendRequests, row, keepExisting && { id: row.id });
        }

        const clanList = Object.values(data.clans || {});
        if (deletes) {
            const names = clanList.map(c => c.name);
            const clanChildren = [schema.clanPeriods, schema.clanMembers, schema.clanMemberPeriods, schema.clanPast, schema.clanInvites, schema.clanRequests];
            if (names.length) {
                await tx.delete(schema.clans).where(notInArray(schema.clans.name, names));
                for (const table of clanChildren) await tx.delete(table).where(notInArray(table.clanName, names));
            } else {
                await tx.delete(schema.clans);
                for (const table of clanChildren) await tx.delete(table);
            }
        }

        for (const clan of clanList) {
            const row = {
                name: clan.name, createdAt: clan.createdAt || Date.now(),
                closed: !!clan.closed, shadowed: !!clan.shadowed,
                kills: (clan.stats && clan.stats.kills) || 0, raidKills: (clan.stats && clan.stats.raidKills) || 0
            };
            await this.#upsert(tx, schema.clans, row, keepExisting && { name: row.name });
            if (deletes) {
                await tx.delete(schema.clanPeriods).where(eq(schema.clanPeriods.clanName, clan.name));
                await tx.delete(schema.clanMembers).where(eq(schema.clanMembers.clanName, clan.name));
                await tx.delete(schema.clanMemberPeriods).where(eq(schema.clanMemberPeriods.clanName, clan.name));
                await tx.delete(schema.clanPast).where(eq(schema.clanPast.clanName, clan.name));
                await tx.delete(schema.clanInvites).where(eq(schema.clanInvites.clanName, clan.name));
                await tx.delete(schema.clanRequests).where(eq(schema.clanRequests.clanName, clan.name));
            }
            for (const [span, p] of Object.entries((clan.stats && clan.stats.periods) || {})) {
                await this.#upsert(tx, schema.clanPeriods, { clanName: clan.name, span, periodKey: p.key, kills: p.kills || 0 }, keepExisting && { clanName: clan.name, span });
            }
            let ord = 0;
            for (const member of clan.members || []) {
                const memberRow = {
                    clanName: clan.name, accountId: member.id, role: member.role || "member",
                    stint: member.stint || 1, joinedAt: member.joinedAt || 0, kills: member.kills || 0, ord: ord++
                };
                await this.#upsert(tx, schema.clanMembers, memberRow, keepExisting && { clanName: clan.name, accountId: member.id });
                for (const [span, p] of Object.entries(member.periods || {})) {
                    await this.#upsert(tx, schema.clanMemberPeriods, { clanName: clan.name, accountId: member.id, span, periodKey: p.key, kills: p.kills || 0 }, keepExisting && { clanName: clan.name, accountId: member.id, span });
                }
            }
            ord = 0;
            for (const past of clan.past || []) {
                const pastRow = {
                    clanName: clan.name, accountId: past.id, stint: past.stint || 1,
                    leftAt: past.left || 0, kicked: !!past.kicked, kills: past.kills || 0, ord: ord++
                };
                await this.#upsert(tx, schema.clanPast, pastRow, keepExisting && { clanName: clan.name, ord: pastRow.ord });
            }
            ord = 0;
            for (const invite of clan.invites || []) {
                const inviteRow = { clanName: clan.name, accountId: invite.id, invitedBy: invite.by, ord: ord++ };
                await this.#upsert(tx, schema.clanInvites, inviteRow, keepExisting && { clanName: clan.name, accountId: invite.id });
            }
            ord = 0;
            for (const requestId of clan.requests || []) {
                const requestRow = { clanName: clan.name, accountId: requestId, ord: ord++ };
                await this.#upsert(tx, schema.clanRequests, requestRow, keepExisting && { clanName: clan.name, accountId: requestId });
            }
        }
    }

    async #writeChat(tx, data, { deletes }) {
        const keepExisting = !deletes;
        const threads = [];
        for (const [thread, list] of Object.entries(data.whispers || {})) threads.push([thread, list]);
        for (const [thread, list] of Object.entries(data.clans || {})) threads.push([thread, list]);
        for (const [thread, list] of threads) {
            if (deletes) await tx.delete(schema.chatMessages).where(eq(schema.chatMessages.thread, thread));
            let ord = 0;
            for (const message of list) {
                const row = chatRow(thread, message, ord++);
                await this.#upsert(tx, schema.chatMessages, row, keepExisting && { id: row.id });
            }
        }
        if (deletes) await tx.delete(schema.saidLog);
        for (const [accountId, list] of Object.entries(data.said || {})) {
            let ord = 0;
            for (const entry of list) {
                await tx.insert(schema.saidLog).values({
                    accountId,
                    at: entry.at || Date.now(),
                    kind: entry.kind || "game",
                    target: (entry.to && entry.to.name) || entry.clan || entry.server || null,
                    text: String(entry.text || "").slice(0, 200),
                    shadow: !!entry.shadow,
                    ord: ord++
                });
            }
        }
    }

    async #writeBans(tx, bansData, { deletes }) {
        const keepExisting = !deletes;
        if (deletes) await tx.delete(schema.bans);
        const kinds = [["ips", "ip"], ["accounts", "account"], ["devices", "device"]];
        for (const [bucket, kind] of kinds) {
            for (const [key, entry] of Object.entries(bansData[bucket] || {})) {
                const row = {
                    kind, banKey: key,
                    name: entry.name || null, bannedBy: entry.by || "system",
                    reason: entry.reason || null, until: entry.until || null,
                    at: entry.at || new Date().toISOString()
                };
                await this.#upsert(tx, schema.bans, row, keepExisting && { kind, banKey: key });
            }
        }
    }

    async #writeRecords(tx, records, { deletes }) {
        if (deletes) {
            await tx.delete(schema.modRecords);
            await tx.delete(schema.modReports);
            await tx.delete(schema.modFlags);
        }
        // Import mode: accounts already present keep their existing rows untouched.
        let skip = new Set();
        if (!deletes) {
            const existing = await tx.select({ id: schema.modRecords.accountId }).from(schema.modRecords);
            skip = new Set(existing.map(r => r.id));
        }
        for (const [accountId, rec] of Object.entries(records || {})) {
            if (skip.has(accountId)) continue;
            const verdict = rec.verdict || null;
            await this.#upsert(tx, schema.modRecords, {
                accountId,
                verdictLevel: verdict ? verdict.level : null,
                verdictReason: verdict ? verdict.reason || null : null,
                verdictBy: verdict ? verdict.by || null : null,
                verdictAt: verdict ? verdict.at || null : null
            }, { accountId });
            let ord = 0;
            for (const report of rec.reports || []) {
                await tx.insert(schema.modReports).values({
                    accountId, at: report.at || Date.now(),
                    byName: report.by && report.by.name || null,
                    byKind: report.by && report.by.kind || null,
                    reason: report.reason || null,
                    sessionReports: report.sessionReports ?? null,
                    ord: ord++
                });
            }
            ord = 0;
            for (const flag of rec.flags || []) {
                await tx.insert(schema.modFlags).values({
                    accountId, at: flag.at || Date.now(), signal: String(flag.signal || "").slice(0, 32), ord: ord++
                });
            }
        }
    }
}

// ---------------------------------------------------------------- row mappers
function accountRow(account) {
    return {
        id: account.id,
        email: account.email,
        name: account.name || null,
        role: account.role || null,
        clan: account.clan || null,
        verdict: account.verdict || null,
        createdAt: account.createdAt || Date.now(),
        look: account.look || null,
        bestLook: account.bestLook || null,
        unlocks: account.unlocks || null,
        discordName: account.discord ? account.discord.name : null,
        discordLinkedAt: account.discord ? account.discord.linkedAt : null,
        passwordCredential: account.passwordCredential || null
    };
}

const DEFAULT_PREFS_ROW = { friendNotifs: true, friendRequests: true, clanInvites: true, clanChat: true, whispers: true };

function prefsRow(account) {
    const prefs = Object.assign({}, DEFAULT_PREFS_ROW, account.prefs);
    return {
        accountId: account.id,
        friendNotifs: !!prefs.friendNotifs, friendRequests: !!prefs.friendRequests,
        clanInvites: !!prefs.clanInvites, clanChat: !!prefs.clanChat, whispers: !!prefs.whispers
    };
}

function socialsRow(account) {
    const socials = account.socials || {};
    return {
        accountId: account.id,
        youtube: socials.youtube || null, twitch: socials.twitch || null, tiktok: socials.tiktok || null,
        x: socials.x || null, discord: socials.discord || null
    };
}

function statsRow(account) {
    const s = Object.assign(emptyStatsShape(), account.stats);
    return {
        accountId: account.id,
        kills: s.kills, deaths: s.deaths, damage: s.damage, healing: s.healing,
        wood: s.wood, food: s.food, stone: s.stone, gold: s.gold,
        animalDamage: s.animalDamage, bestScore: s.bestScore, maxKills: s.maxKills,
        lives: s.lives, playtime: s.playtime
    };
}

function chatRow(thread, message, ord) {
    return {
        id: message.id,
        thread,
        kind: message.kind || "whisper",
        fromId: (message.from && message.from.id) || null,
        fromName: (message.from && message.from.name) || "",
        toId: (message.to && message.to.id) || null,
        toName: (message.to && message.to.name) || null,
        text: String(message.text || "").slice(0, 200),
        at: message.at || Date.now(),
        shadow: !!message.shadow,
        isSystem: !!message.system,
        ord
    };
}

// ---------------------------------------------------------------- normalizers (JSON import)
function normalizeStoreData(raw) {
    const data = Object.assign(emptyStoreData(), raw);
    data.social = Object.assign({ friends: {}, requests: [] }, data.social);
    data.legacyIds = data.legacyIds || {};
    return data;
}

function normalizeChatData(raw) {
    return Object.assign(emptyChatData(), raw);
}

function normalizeBans(raw) {
    return Object.assign({ ips: {}, accounts: {}, devices: {} }, raw);
}
