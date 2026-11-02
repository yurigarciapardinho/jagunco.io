// MYSQL MODE tests. These run without a MySQL server by substituting the mysql2 pool
// with a fake DRIVER (testing/fakeMysql2.js: an in-memory emulation of the driver
// interface, NOT a persistence implementation). Everything above the driver - the
// Drizzle query-API CRUD, hydration, JSON import, write queue - executes for real.
//
// With a real MySQL available, the same behaviours hold; run the server with
// DATABASE_URL=mysql://... for an end-to-end check.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MySqlPersistence } from "./mysqlDriver.js";
import { FakePool } from "./testing/fakeMysql2.js";
import { AccountStore } from "../api/store.js";
import { Chat } from "../api/chat.js";

const URL = "mysql://tester:secret@db.internal:3306/jagunco";

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-mysql-"));
}

function driver(pool, dir, log = () => {}) {
    return new MySqlPersistence({ databaseUrl: URL, dataDir: dir, log, createPool: () => pool });
}

test("requires a mysql:// URL and never leaks credentials", () => {
    assert.throws(() => new MySqlPersistence({ databaseUrl: "not a url", dataDir: tmpDir(), log: () => {} }), /not a valid URL/);
    assert.throws(() => new MySqlPersistence({ databaseUrl: "postgres://u:p@h/db", dataDir: tmpDir(), log: () => {} }), /mysql/);
    const pool = new FakePool();
    const d = driver(pool, tmpDir());
    assert.equal(d.pool, pool);
});

test("ready() creates the schema (idempotent DDL) and records migration markers", async () => {
    const pool = new FakePool();
    const d = driver(pool, tmpDir());
    await d.ready();
    const ddl = pool.statements.filter(s => s.sql.startsWith("create table"));
    assert.ok(ddl.length >= 20, "expected all tables to be created");
    assert.ok(ddl.every(s => s.sql.includes("if not exists")), "DDL must be idempotent");
    const markers = pool.rows("migration_meta").map(r => r.mkey);
    assert.ok(markers.includes("schema_0001_initial"));
    assert.ok(markers.includes("json_import_store"));
    // second driver over the same database: no re-import, no duplicates
    const before = pool.statements.length;
    const d2 = driver(pool, tmpDir());
    await d2.ready();
    const ddlAgain = pool.statements.slice(before).filter(s => s.sql.startsWith("create table"));
    assert.equal(ddlAgain.length, 0);
    await d.close();
    await d2.close();
});

test("accounts, stats, prefs, socials, clans and passwordCredential survive a restart", async () => {
    const pool = new FakePool();
    const dir = tmpDir();
    const store = new AccountStore(dir, { persistence: driver(pool, dir) });
    await store.ready();
    const account = store.accountForEmail("hero@example.com");
    assert.equal(store.claimName(account, "Hero_1").status, 200);
    store.setPrefs(account, { whispers: false });
    store.setSocials(account, { youtube: "herochan" });
    account.passwordCredential = "scrypt$16384$8$1$salt$hash"; // set by api/passwords.js
    store.recordUnlocks(account, { hat: 5 });
    store.recordLife(account, { kills: 3, died: false, damage: 100, healing: 0, wood: 1, food: 2, stone: 3, gold: 4, animalDamage: 5, playtime: 6000, score: 700, animalKills: { cow: 2 }, bossKills: 1 });
    assert.equal(store.clanAction(account, "create", { name: "ABC" }).status, 200);
    // a life played while in the clan also feeds the clan boards
    store.recordLife(account, { kills: 2, died: true, damage: 50, healing: 0, wood: 0, food: 0, stone: 0, gold: 0, animalDamage: 0, playtime: 3000, score: 200, animalKills: {}, bossKills: 0 });
    await store.persistence.flush();
    await store.persistence.close();

    // "restart": fresh store + driver over the same database
    const reloaded = new AccountStore(dir, { persistence: driver(pool, dir) });
    await reloaded.ready();
    const again = reloaded.accountByEmail("hero@example.com");
    assert.equal(again.name, "Hero_1");
    assert.equal(again.stats.kills, 5);
    assert.equal(again.stats.animalKills.cow, 2);
    assert.equal(again.prefs.whispers, false);
    assert.deepEqual(again.socials, { youtube: "herochan" });
    assert.equal(again.passwordCredential, "scrypt$16384$8$1$salt$hash");
    assert.equal(again.clan, "ABC");
    assert.deepEqual(again.unlocks, { hats: [5], accs: [], weapons: {} });
    const clan = reloaded.data.clans.ABC;
    assert.equal(clan.members[0].role, "owner");
    assert.equal(clan.stats.kills, 2);
    assert.equal(clan.members[0].kills, 2);
    await reloaded.persistence.close();
});

test("friends, friend requests and chat history survive a restart", async () => {
    const pool = new FakePool();
    const dir = tmpDir();
    const stream = { sendTo() {} };
    const game = { whereIs: () => null, playerBySession: () => null };
    const p1 = driver(pool, dir);
    const store = new AccountStore(dir, { persistence: p1 });
    await store.ready();
    const a = store.accountForEmail("a@example.com");
    const b = store.accountForEmail("b@example.com");
    store.claimName(a, "Alpha");
    store.claimName(b, "Beta");
    const { request } = store.createFriendRequest(a.id, b.id);
    store.answerFriendRequest(b.id, request.id, true);
    const chat = new Chat({ dataDir: dir, store, stream, game, log: () => {} });
    await chat.ready();
    chat.whisper(a, "Beta", "hello mysql");
    chat.gameChat({ account: a }, "said in game", "LC");
    await p1.flush();
    await p1.close();

    const p2 = driver(pool, dir);
    const store2 = new AccountStore(dir, { persistence: p2 });
    await store2.ready();
    const chat2 = new Chat({ dataDir: dir, store: store2, stream, game, log: () => {} });
    await chat2.ready();
    const a2 = store2.accountByEmail("a@example.com");
    assert.equal(store2.friendsOf(a2.id).length, 1);
    const history = chat2.history(a2, "whisper", "Beta");
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].text, "hello mysql");
    assert.deepEqual(chat2.said("Alpha").map(m => m.kind), ["game", "whisper"]);
    await p2.close();
});

test("moderation bans, records and the report log survive a restart", async () => {
    const pool = new FakePool();
    const dir = tmpDir();
    const aid = "a".repeat(24);
    const p1 = driver(pool, dir);
    await p1.ready();
    p1.syncBans({
        ips: { "1.2.3.4": { name: "Bad", by: "system", reason: "cheat", at: "2024-01-01T00:00:00Z" } },
        accounts: { [aid]: { name: "Bad", by: "Mod", until: 9999999999999, at: "2024-01-02T00:00:00Z" } },
        devices: {}
    });
    p1.syncRecords({ [aid]: { reports: [{ at: 1, by: { name: "Rep", kind: "guest" }, sessionReports: 2, reason: "toxic" }], flags: [{ at: 2, signal: "SOCKET_HOOKED" }], verdict: { level: "shadow", reason: "sus", by: "Mod", at: 3 } } });
    p1.appendReport({ at: "2024-01-03T00:00:00Z", target: { name: "Bad", account: aid, flags: { flags: 1 } }, reporter: { name: "Rep", account: null } });
    p1.appendReport({ at: "2024-01-03T00:01:00Z", reason: "aimbot", target: { name: "Bad", account: aid }, reporter: { name: "Rep", account: null } });
    await p1.flush();

    const p2 = driver(pool, dir);
    await p2.ready();
    const m = await p2.loadModeration();
    assert.equal(m.bans.ips["1.2.3.4"].reason, "cheat");
    assert.equal(m.bans.accounts[aid].until, 9999999999999);
    assert.equal(m.records[aid].reports[0].reason, "toxic");
    assert.equal(m.records[aid].flags[0].signal, "SOCKET_HOOKED");
    assert.equal(m.records[aid].verdict.level, "shadow");
    const log = pool.rows("report_log");
    assert.deepEqual(log.map(r => r.kind), ["report", "reason"]);
    assert.equal(log[1].reason, "aimbot");
    await p2.close();
});

test("one-shot JSON import: existing files are merged, never wiped, and only once", async () => {
    const pool = new FakePool();
    const dir = tmpDir();
    const idA = "a".repeat(24), idB = "b".repeat(24);
    const stats = { kills: 9, deaths: 1, damage: 0, healing: 0, wood: 0, food: 0, stone: 0, gold: 0, animalDamage: 0, animalKills: { pig: 4 }, bestScore: 100, maxKills: 9, lives: 2, playtime: 10, periods: {} };
    fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify({
        accounts: {
            [idA]: { id: idA, email: "a@example.com", name: "Alpha", role: "admin", clan: "ABC", createdAt: 1, stats, socials: {}, prefs: {}, verdict: null },
            [idB]: { id: idB, email: "b@example.com", name: "Beta", role: null, clan: null, createdAt: 2, stats, socials: {}, prefs: {}, verdict: null }
        },
        emails: { "a@example.com": idA, "b@example.com": idB },
        names: { alpha: idA, beta: idB },
        clans: { ABC: { name: "ABC", createdAt: 1, members: [{ id: idA, role: "owner", stint: 1, joinedAt: 5, kills: 9, periods: {} }], past: [], invites: [], requests: [idB], shadowed: false, stats: { kills: 9, raidKills: 0, periods: {} } } },
        social: { friends: { [idA]: [{ id: idB, createdAt: "2024-01-01" }], [idB]: [{ id: idA, createdAt: "2024-01-01" }] }, requests: [] },
        legacyIds: { oldid123: idA }
    }));
    fs.writeFileSync(path.join(dir, "chat.json"), JSON.stringify({ whispers: { [`${idA}|${idB}`]: [{ id: "m1", kind: "whisper", from: { id: idA, name: "Alpha" }, to: { id: idB, name: "Beta" }, text: "hi", at: 7 }] }, clans: {}, said: {} }));
    fs.writeFileSync(path.join(dir, "bans.json"), JSON.stringify({ ips: { "9.9.9.9": { name: "X", by: "system", at: "2024-01-01" } } }));

    const p1 = driver(pool, dir);
    await p1.ready();
    assert.equal(pool.rows("accounts").length, 2);
    assert.equal(pool.rows("friends").length, 2);
    assert.equal(pool.rows("chat_messages").length, 1);
    assert.equal(pool.rows("bans").length, 1);
    assert.equal(pool.rows("legacy_ids").length, 1);

    // re-running ready() (or a second driver) must not duplicate or delete anything
    const p2 = driver(pool, dir);
    await p2.ready();
    assert.equal(pool.rows("accounts").length, 2);
    assert.equal(pool.rows("friends").length, 2);
    assert.equal(pool.rows("chat_messages").length, 1);

    // hydrated state matches the imported files
    const store = new AccountStore(dir, { persistence: p2 });
    await store.ready();
    const account = store.accountById("oldid123"); // legacy id mapping survived
    assert.equal(account.id, idA);
    assert.equal(account.stats.animalKills.pig, 4);
    assert.equal(store.data.clans.ABC.requests[0], idB);
    // the source files are left untouched (import never deletes)
    assert.ok(fs.existsSync(path.join(dir, "accounts.json")));
    await p2.close();
});

test("write failures are contained: queue counts the error, later writes still work", async () => {
    const pool = new FakePool();
    const dir = tmpDir();
    const logs = [];
    const p = driver(pool, dir, (msg) => logs.push(msg));
    await p.ready();
    const store = new AccountStore(dir, { persistence: p });
    await store.ready();
    const account = store.accountForEmail("x@example.com");
    pool.failNext("insert into `accounts`");
    store.claimName(account, "Fails");          // this sync hits the injected failure
    await p.flush();
    assert.equal(p.queue.errors, 1);
    assert.ok(logs.some(l => l.includes('write "store" failed')));
    // next change retries and persists
    store.setPrefs(account, { whispers: false });
    await p.flush();
    assert.equal(pool.rows("accounts").length, 1);
    assert.equal(pool.rows("account_prefs")[0].whispers, 0);
    await p.close();
});

test("close() flushes pending writes and ends the pool", async () => {
    const pool = new FakePool();
    const dir = tmpDir();
    const p = driver(pool, dir);
    await p.ready();
    const store = new AccountStore(dir, { persistence: p });
    await store.ready();
    const account = store.accountForEmail("close@example.com");
    store.claimName(account, "Closer");
    await store.closePersistence();
    assert.equal(pool.ended, true);
    assert.equal(pool.rows("accounts").length, 1);
});
