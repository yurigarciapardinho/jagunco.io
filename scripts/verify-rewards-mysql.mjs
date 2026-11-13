#!/usr/bin/env node
// End-to-end reward persistence against an exclusive local MySQL container.
// Requires Docker, the mysql:8.4 image and a current npm run build.
// Production databases and external DATABASE_URL values are never used by the parent.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { AccountStore } from "../server/src/api/store.js";
import { hashPassword, verifyPassword } from "../server/src/api/passwords.js";
import { Game } from "../server/src/moomoo/server.js";
import { AntiCheat } from "../server/src/anticheat/index.js";
import { handlePacket } from "../server/src/network/packets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const OUT = path.join(ROOT, "verification-shots");
const SHELL = 61;
const PASSWORD = "Local reward QA password 83!";
const HERO = "reward-sql-hero@example.test";
const HELPER = "reward-sql-help@example.test";
const command = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const phase = process.argv.find(value => value.startsWith("--phase="))?.split("=")[1];

function log(stage, evidence = {}) { console.log(JSON.stringify({ stage, ...evidence })); }
async function until(run, label, timeout = 90000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await run()) return;
        await delay(250);
    }
    throw new Error("Timeout: " + label);
}
function gameFor(store) {
    const game = new Game({ key: "QA", name: "reward QA", capacity: 40, membersOnly: false, accounts: store, log: () => {}, hooks: {} });
    game.stop();
    for (const animal of game.ais) { animal.active = false; animal.alive = false; }
    return game;
}
function playerFor(game, account) {
    const player = game.addPlayer({ send() {}, account, ip: "127.0.0.1" });
    player.setUserData({ name: account.name, skin: 0 });
    player.spawn(false);
    player.anticheat = new AntiCheat({ player, log() {}, kick() {}, close() {}, store: null, session: null, sendProbes: null });
    return player;
}
function connection() {
    const url = new URL(process.env.DATABASE_URL);
    return mysql.createConnection({
        host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password), database: url.pathname.slice(1)
    });
}
function assertFixture() {
    assert.equal(process.env.JAGUNCO_REWARD_QA, "1", "worker requires the isolated QA orchestrator");
    const url = new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/jagunco_rewardqa");
    assert.equal(process.env.NODE_ENV, "production");
}
async function producer() {
    assertFixture();
    const store = new AccountStore(process.env.DATA_DIR);
    let game, sql;
    try {
        await store.ready();
        assert.equal(store.persistence.mode, "mysql");
        const account = store.accountForEmail(HERO);
        assert.equal(store.claimName(account, "RewardSqlHero").status, 200);
        account.role = "admin";
        account.passwordCredential = await hashPassword(PASSWORD);
        const helper = store.accountForEmail(HELPER);
        assert.equal(store.claimName(helper, "RewardSqlHelp").status, 200);
        store.save();
        game = gameFor(store);
        const player = playerFor(game, account);
        const assistant = playerFor(game, helper);
        for (const index of [10, 11, 7]) {
            const animal = game.ai_manager.spawn(index === 11 ? -2500 : 5000, index === 11 ? 7200 : 3000, 0, index,
                index === 11 ? { spawnDelay: 600000 } : null);
            if (index === 11) animal.changeHealth(-animal.maxHealth * 0.05, assistant);
            animal.changeHealth(-animal.health, player);
            if (animal.spawnCounter) {
                assert.equal(animal.changeHealth(-animal.maxHealth, player), false, "respawn cannot pay again");
            }
        }
        assert.equal(player.points, 13500);
        assert.equal(player.food, 800);
        assert.equal(assistant.points, 0);
        assert.ok(player.skins[SHELL] && assistant.skins[SHELL]);
        assert.ok(store.lookOptions(account).hats.includes(SHELL));
        assert.ok(store.lookOptions(helper).hats.includes(SHELL));
        assert.equal(store.setLook(account, { hat: SHELL, color: 1 }).status, 200);
        await store.persistence.flush();
        assert.equal(store.persistence.queue.errors, 0);
        sql = await connection();
        const [[award]] = await sql.execute("SELECT JSON_CONTAINS(unlocks_json, CAST(61 AS JSON), '$.hats') AS earned FROM accounts WHERE email=?", [HERO]);
        assert.equal(award.earned, 1, "SQL already contains the award before the life ends");
        player.kill(null);
        assistant.kill(null);
        game.removePlayer(player);
        game.removePlayer(assistant);
        await store.persistence.flush();
        assert.equal(store.persistence.queue.errors, 0);
        assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, "accounts.json")), false, "no JSON persistence fallback");
        const [[version]] = await sql.query("SELECT VERSION() AS version");
        const [tables] = await sql.query("SHOW TABLES");
        log("awards-before-restart", { mysql: version.version, tables: tables.length, gold: 13500, food: 800,
            finalizerShell: true, assistantShell: true, immediatelyPersisted: true, queueErrors: 0 });
    } finally {
        if (game) game.stop();
        if (sql) await sql.end();
        await store.closePersistence();
    }
}
async function freePort() {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
}
async function consumer() {
    assertFixture();
    const store = new AccountStore(process.env.DATA_DIR);
    let game, token, negativeToken;
    try {
        await store.ready();
        const account = store.accountByEmail(HERO);
        const helper = store.accountByEmail(HELPER);
        assert.ok(account && helper, "accounts survived the database restart");
        assert.equal(account.role, "admin");
        assert.equal(await verifyPassword(PASSWORD, account.passwordCredential), true);
        assert.equal(account.stats.gold, 13500);
        assert.equal(account.stats.food, 800);
        assert.equal(account.stats.lives, 1, "death and removal cannot record the same life twice");
        assert.deepEqual(account.stats.animalKills, { yeti: 1, crab_king: 1, treasure: 1 });
        assert.ok(store.lookOptions(account).hats.includes(SHELL));
        assert.ok(store.lookOptions(helper).hats.includes(SHELL));
        assert.equal(account.unlocks.hats.filter(id => id === SHELL).length, 1);
        assert.equal(account.look.hat, SHELL);
        game = gameFor(store);
        const fresh = playerFor(game, account);
        assert.equal(fresh.skins[SHELL], undefined);
        assert.equal(fresh.points, 0, "lifetime gold is not a restored resource balance");
        assert.equal(fresh.food, 0, "lifetime food is not a restored resource balance");
        for (const action of [0, 1]) handlePacket({ game, accounts: store }, fresh, "c", [action, SHELL, 0]);
        assert.equal(fresh.skinIndex, 0);
        assert.equal(fresh.skins[SHELL], undefined, "profile reward does not give competitive equipment");
        fresh.powers.god = 1;
        fresh.powers.size = 2;
        fresh.applyPowers();
        store.setRole(account.name.toLowerCase(), "mod");
        game.setAccountRole(account.id, account.role);
        assert.equal(fresh.powers.god, 0);
        assert.equal(fresh.scale, 35);
        assert.equal(fresh.role, "mod");
        store.setRole(account.name, "admin");
        game.setAccountRole(account.id, account.role);
        const negative = store.accountForEmail("reward-sql-none@example.test");
        store.claimName(negative, "RewardSqlNone");
        token = store.issueToken(account);
        negativeToken = store.issueToken(negative);
        await store.persistence.flush();
        assert.equal(store.persistence.queue.errors, 0);
        log("database-restart", { role: account.role, passwordValid: true, gold: account.stats.gold, food: account.stats.food,
            animalKills: account.stats.animalKills, profileShell: true, freshMatchShell: false, freshResources: { gold: 0, food: 0 }, revocationClearsPowers: true });
    } finally {
        if (game) game.stop();
        await store.closePersistence();
    }
    const port = await freePort();
    const base = "http://127.0.0.1:" + port;
    let app;
    let serverLog = "";
    async function start() {
        app = spawn(process.execPath, [path.join(ROOT, "dist/boot.js")], {
            cwd: ROOT, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), OWNER_EMAIL: "" }, stdio: ["ignore", "pipe", "pipe"]
        });
        app.stdout.on("data", data => { serverLog += data; });
        app.stderr.on("data", data => { serverLog += data; });
        await until(async () => {
            if (app.exitCode !== null || app.signalCode !== null) throw new Error("built application exited");
            try { return (await fetch(base + "/ping", { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
        }, "built production application", 30000);
    }
    async function stop() {
        if (app && app.exitCode === null && app.signalCode === null) {
            const exited = new Promise(resolve => app.once("exit", resolve));
            app.kill("SIGTERM");
            const timer = setTimeout(() => app.kill("SIGKILL"), 10000);
            await exited;
            clearTimeout(timer);
        }
    }
    const look = body => fetch(base + "/api/account/look", {
        method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    try {
        await start();
        assert.equal((await fetch(base + "/s/LC/ping")).status, 200);
        let response = await look({ auth: token });
        assert.equal(response.status, 200);
        assert.ok((await response.json()).options.hats.includes(SHELL));
        response = await look({ auth: token, look: { hat: SHELL, color: 2 } });
        assert.equal(response.status, 200);
        assert.equal((await look({ auth: negativeToken, look: { hat: SHELL } })).status, 400);
        assert.equal((await look({ auth: "invalid" })).status, 403);
        await stop();
        await start();
        response = await look({ auth: token });
        assert.equal(response.status, 200);
        const profile = await response.json();
        assert.ok(profile.options.hats.includes(SHELL));
        assert.equal(profile.look.hat, SHELL);
        assert.equal(profile.look.color, 2);
        await stop();
        assert.ok(!/failed to write|enqueued after close|closed with [1-9]/.test(serverLog), "no failed persistence writes in built application");
        log("built-application-restart", { health: 200, profile: 200, preservedAppearance: true, unearnedLook: 400, invalidAuth: 403 });
    } finally {
        await stop();
        fs.writeFileSync(path.join(OUT, "rewards-mysql-server.log"), serverLog);
    }
}
async function orchestrate() {
    assert.ok(fs.existsSync(path.join(ROOT, "dist/boot.js")), "run npm run build first");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-rewardqa-"));
    const name = "jagunco-rewardqa-" + process.pid + "-" + randomBytes(4).toString("hex");
    const password = randomBytes(24).toString("hex");
    const rootPassword = randomBytes(24).toString("hex");
    const secret = randomBytes(32).toString("hex");
    let created = false;
    const evidence = [];
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "rewards-mysql.json"), JSON.stringify({ pass: false, status: "running", evidence }, null, 2));
    const envFile = path.join(scratch, "mysql.env");
    fs.writeFileSync(envFile, "MYSQL_DATABASE=jagunco_rewardqa\nMYSQL_USER=rewardqa\nMYSQL_PASSWORD=" + password + "\nMYSQL_ROOT_PASSWORD=" + rootPassword + "\n", { mode: 0o600 });
    try {
        const mysqlImage = process.env.MYSQL_IMAGE || "mysql:8.4.13@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902";
        await command("docker", ["image", "inspect", mysqlImage, "--format", "{{.Id}}"]);
        await command("docker", ["run", "--detach", "--name", name, "--label", "jagunco.qa=rewards",
            "--publish", "127.0.0.1::3306", "--env-file", envFile, mysqlImage], { timeout: 30000 });
        created = true;
        const { stdout } = await command("docker", ["port", name, "3306/tcp"]);
        let port = Number(/^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)[1]);
        const databaseUrl = "mysql://rewardqa:" + password + "@127.0.0.1:" + port + "/jagunco_rewardqa";
        const env = { ...process.env, NODE_ENV: "production", APP_SECRET: secret, DATABASE_URL: databaseUrl,
            DATA_DIR: path.join(scratch, "app-data"), JAGUNCO_REWARD_QA: "1", OWNER_EMAIL: "" };
        const ready = async () => {
            await until(async () => {
                let sql;
                try {
                    sql = await mysql.createConnection({ host: "127.0.0.1", port, user: "rewardqa", password, database: "jagunco_rewardqa", connectTimeout: 1000 });
                    await sql.query("SELECT 1");
                    return true;
                } catch { return false; }
                finally { if (sql) await sql.end(); }
            }, "exclusive MySQL readiness");
        };
        log("mysql-starting");
        await ready();
        for (const step of ["producer", "consumer"]) {
            if (step === "consumer") {
                const previousPort = port;
                await command("docker", ["restart", name], { timeout: 30000 });
                const published = await command("docker", ["port", name, "3306/tcp"]);
                port = Number(/^127\.0\.0\.1:(\d+)\s*$/.exec(published.stdout)[1]);
                env.DATABASE_URL = "mysql://rewardqa:" + password + "@127.0.0.1:" + port + "/jagunco_rewardqa";
                log("mysql-restarted", { publishedPortChanged: previousPort !== port });
                await ready();
            }
            const result = await command(process.execPath, [SELF, "--phase=" + step], { cwd: ROOT, env, timeout: 120000, maxBuffer: 1024 * 1024 });
            for (const line of result.stdout.trim().split("\n")) {
                if (!line) continue;
                console.log(line);
                try { evidence.push(JSON.parse(line)); } catch {}
            }
        }
        fs.writeFileSync(path.join(OUT, "rewards-mysql.json"), JSON.stringify({ pass: true, evidence }, null, 2));
        log("verified", { isolatedMysql: true, databaseRestart: true, productionAppRestart: true, jsonFallback: false });
    } catch (error) {
        fs.writeFileSync(path.join(OUT, "rewards-mysql.json"), JSON.stringify({ pass: false, status: "failed", evidence }, null, 2));
        throw error;
    } finally {
        if (created) await command("docker", ["rm", "--force", "--volumes", name]);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}
try {
    if (phase === "producer") await producer();
    else if (phase === "consumer") await consumer();
    else {
        assert.equal(phase, undefined, "unknown worker phase");
        await orchestrate();
    }
} catch (error) {
    let message = error.message;
    for (const value of [process.env.DATABASE_URL, process.env.APP_SECRET]) {
        if (value) message = message.split(value).join("[redacted]");
    }
    console.error("VERIFY REWARDS MYSQL FAILED: " + message);
    process.exitCode = 1;
}
