// RECONNECTION TESTS
// Behavioral tests for the WebSocket reconnection path (reconnection.js +
// connection.js + packets.js + Game.suspendPlayer/rejoinPlayer). These run the REAL
// stack on a local WebSocket: the production connection handler, the production
// ProtocolSession transport (HMAC tags, masks, per-session packet tables), a real
// Game world with its tick loop running, and a real AccountStore issuing/consuming
// join tickets. The test client below speaks the official client's wire protocol, so
// every test is actual socket connections against a live server, no externals.
//
// Only the ModerationStore is a stub: server/src/anticheat/index.js currently
// references createPersistence/MODERATION_FILES without importing them (pre-existing
// breakage, outside the scope of this change), so it cannot be constructed. The stub
// implements exactly the members the connection/packet code calls.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import msgpack from "msgpack-lite";
import { Game } from "../moomoo/server.js";
import { items } from "../moomoo/modules/items.js";
import { createProtocolBuild } from "../protocol/build.js";
import { AccountStore } from "../api/store.js";
import { createConnectionHandler } from "./connection.js";
import { GRACE_MS } from "./reconnection.js";
import {
    buildTables, hmacTag, xorMask, deriveMaskSeeds, s2cMaskSeed, c2sMaskSeed, hexToBytes
} from "../protocol/crypto.js";
import { CLOSE } from "../protocol/constants.js";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitUntil(fn, what = "condition", timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const value = fn();
        if (value) return value;
        await sleep(10);
    }
    throw new Error(`timeout waiting for ${what}`);
}

// ---------------------------------------------------------------- test client
// The client half of the official transport: parses io-init, mixes the session key,
// builds the shuffled packet tables and speaks tagged/masked/sequenced frames.
class GameClient {
    constructor(ws, build) {
        this.ws = ws;
        this.build = build;
        this.packets = [];
        this.waiters = [];
        this.seq = 0;
        this.received = 0;
        this.closeCode = null;
        this.tables = null;
        ws.on("message", (data) => this.onFrame(data));
        ws.on("close", (code) => { this.closeCode = code; });
        ws.on("error", () => {});
        this.ready = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            ws.on("close", () => reject(new Error(`closed before io-init`)));
        });
        this.ready.catch(() => {});   // the close-rejection is only meaningful pre-ready
    }

    onFrame(data) {
        const bytes = new Uint8Array(data);
        if (!this.tables) {
            const [type, fields] = msgpack.decode(Buffer.from(bytes));
            assert.equal(type, "io-init", "first frame is the protocol handshake");
            const seed = fields[1];
            this.key = this.build.mixKey(hexToBytes(fields[2]), seed);
            this.tables = buildTables(seed, this.build.BUILD_SALT);
            this.mask = deriveMaskSeeds(this.key);
            this.readyResolve();
            return;
        }
        xorMask(bytes, s2cMaskSeed(this.mask.s2c, ++this.received));
        const [id, args] = msgpack.decode(Buffer.from(bytes));
        const name = this.tables.s2c.dec[id];
        assert.ok(name, `known s2c packet id ${id}`);
        this.packets.push([name, args]);
        for (const waiter of [...this.waiters]) {
            if (waiter.name === name) {
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                waiter.resolve([name, args]);
            }
        }
    }

    sendPacket(name, ...args) {
        const id = this.tables.c2s.enc[name];
        assert.notEqual(id, undefined, `c2s packet "${name}" exists`);
        const body = msgpack.encode([id, args, ++this.seq]);
        const tag = hmacTag(this.key, body);
        const masked = new Uint8Array(body);
        xorMask(masked, c2sMaskSeed(this.mask.c2s, tag));
        this.ws.send(Buffer.concat([Buffer.from(tag), Buffer.from(masked)]));
    }

    find(name) {
        return this.packets.filter(p => p[0] === name);
    }

    last(name) {
        const list = this.find(name);
        return list[list.length - 1];
    }

    waitFor(name, timeout = 5000) {
        const existing = this.last(name);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timeout waiting for packet "${name}"`)), timeout);
            this.waiters.push({ name, resolve: (p) => { clearTimeout(timer); resolve(p); } });
        });
    }
}

// ---------------------------------------------------------------- test stack
function makeModeration() {
    return {
        banned: false,
        isBanned() { return this.banned; },
        lock() {}, unlock() {}, lockedFor() { return 0; },
        ban() { this.banned = true; },
        flag() {}, report() { return {}; }, reportReason() {}
    };
}

async function makeStack(t, { graceMs = GRACE_MS, gameKeys = ["T1"] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconn-test-"));
    const build = await createProtocolBuild({ outDir: path.join(dir, "protocol") });
    const accounts = new AccountStore(dir);
    const moderation = makeModeration();
    const games = new Map();
    for (const key of gameKeys) {
        const game = new Game({ key, name: key, capacity: 40, membersOnly: false, accounts, log: () => {}, hooks: {} });
        // Keep the real tick loop running (the resync evidence arrives over it), but
        // keep the world quiet: no wandering animals or trees moving our fixtures.
        game.ensureAnimals = () => {};
        for (const ai of game.ais) ai.active = false;
        for (const obj of game.game_objects) if (obj.active) game.object_manager.disableObj(obj);
        games.set(key, game);
    }
    const handler = createConnectionHandler({ build, bundle: null, accounts, moderation, log: () => {}, chat: null, graceMs });
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (ws, req) => {
        const match = /^\/s\/([A-Za-z0-9]+)/.exec(new URL(req.url, "http://localhost").pathname);
        const game = match && games.get(match[1]);
        if (!game) return ws.close(CLOSE.INVALID_CONNECTION);
        handler(ws, req, game);
    });
    await once(wss, "listening");
    const stack = {
        dir, build, accounts, moderation, games,
        game: games.get(gameKeys[0]),
        port: wss.address().port,
        clients: []
    };
    t.after(async () => {
        for (const client of stack.clients) {
            try { client.ws.terminate(); } catch {}
        }
        await new Promise(resolve => wss.close(resolve));
        for (const game of games.values()) game.stop();
        await accounts.closePersistence();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return stack;
}

// Connect with a FRESH single-use join ticket, like the client does after POST /join.
async function connect(stack, { account = null, did = null, server = null } = {}) {
    const game = stack.games.get(server || stack.game.key);
    const { ticket, did: issuedDid } = stack.accounts.issueTicket({ account, did, server: game.key });
    const url = `ws://127.0.0.1:${stack.port}/s/${game.key}?b=${stack.build.BUILD_ID}&token=tk:${ticket}`;
    const ws = new WebSocket(url, { origin: `http://127.0.0.1:${stack.port}` });
    const client = new GameClient(ws, stack.build);
    await client.ready;
    client.did = issuedDid;
    client.game = game;
    stack.clients.push(client);
    return client;
}

async function spawn(client, name = "tester") {
    // moofoll false: start from zero resources so fixture amounts are exact.
    client.sendPacket("M", { name, moofoll: false, skin: 0 });
    const [, args] = await client.waitFor("C");
    return args[0];   // sid
}

// The server-side player behind a client (guest or account, matched by device id).
function playerOf(client) {
    return client.game.players.find(p => p.did && p.did === client.did) || null;
}

// The value a client was told for a resource ("N" packets carry absolute values).
function resourceValue(client, type) {
    const entry = client.find("N").reverse().find(p => p[1][0] === type);
    return entry ? entry[1][1] : undefined;
}

const WOOD_WALL = items.list.find(i => i.name === "wood wall");

// ---------------------------------------------------------------- tests

test("resume over real WebSockets: same player, sid, position, resources, items, buildings", async (t) => {
    const stack = await makeStack(t);
    const { game } = stack;

    const a = await connect(stack);
    const sid = await spawn(a, "Lampiao");
    const player = playerOf(a);
    assert.ok(player && player.alive, "player spawned");

    // Fixture state worth preserving: a spot on the map, stocked resources, points,
    // kills, an extra item and a placed building.
    player.x = 2000; player.y = 2000; player.xVel = 0; player.yVel = 0;
    player.addResource(0, 500);        // wood: 100 -> 600
    player.addResource(2, 250);        // stone: 100 -> 350
    player.addResource(3, 5000);       // points (gold)
    player.kills = 3;
    player.addItem(4);                 // stone wall
    player.weapons = [5, 9];
    player.weaponXP[5] = 8000;
    player.skins[7] = 1;
    player.tails[3] = 1;
    game.object_manager.add(game.game_objects.length, 2150, 2000, 0, WOOD_WALL.scale, WOOD_WALL.type, WOOD_WALL, false, player);
    const building = game.game_objects.find(o => o.active && o.owner === player);
    assert.ok(building, "building placed");
    const lifeStats = player.lifeStats;

    // The link drops (no clean close, like a network cut).
    a.ws.terminate();
    await waitUntil(() => player.disconnectedAt, "suspension");

    // The player stayed in the world: no duplicate, no removal, building intact.
    assert.equal(game.players.length, 1, "still exactly one player");
    assert.equal(game.players[0], player, "same player object");
    assert.ok(player.disconnectedAt > 0, "suspended");
    assert.equal(building.active, true, "building survives the grace period");
    assert.equal(player.lifeStats, lifeStats, "the life was not recorded (no reward/stat double count)");

    // Reconnect with a NEW ticket for the same device on the same server.
    const b = await connect(stack, { did: a.did });
    assert.equal(game.players.length, 1, "resume did not add a second player");
    assert.equal(game.players[0], player, "resume kept the same player object");
    assert.equal(player.disconnectedAt, 0, "player owns the new connection");

    // The fresh client asks to spawn; it must get the current state back.
    b.sendPacket("M", { name: "Lampiao", moofoll: false, skin: 0 });
    const [, cArgs] = await b.waitFor("C");
    await waitUntil(() => b.find("A").some(p => p[1][0].admin?.active), "complete resumed snapshot");
    assert.equal(cArgs[0], sid, "same sid — no respawn, no new identity");

    // Resources / points / kills exactly as before (nothing reset, nothing doubled).
    assert.equal(resourceValue(b, "wood"), 500);
    assert.equal(resourceValue(b, "stone"), 250);
    assert.equal(resourceValue(b, "points"), 5000);
    assert.equal(resourceValue(b, "kills"), 3);
    const vItems = b.find("V").map(p => p[1]).find(args => args[1] === 0);
    assert.deepEqual(vItems[0], player.items, "item list resynced");
    assert.ok(player.items.includes(4), "the extra item was kept");
    assert.deepEqual(b.find("V").find(p => p[1][1] === 1)[1][0], [5, 9], "upgraded weapons resynced");
    assert.equal(player.weaponXP[5], 8000, "weapon progression preserved");
    assert.ok(b.find("5").some(p => p[1][0] === 0 && p[1][1] === 7 && p[1][2] === 0), "owned hat resynced");
    assert.ok(b.find("5").some(p => p[1][0] === 0 && p[1][1] === 3 && p[1][2] === 1), "owned tail resynced");
    const uPacket = b.last("U");
    assert.ok(uPacket, "upgrade state resent");
    assert.equal(uPacket[1][0], player.upgradePoints);

    // The world is re-described to the fresh client by the normal tick sync:
    // its own addPlayer ("D") carries the preserved position, and the placed
    // building arrives in an "H" object load.
    const [, dArgs] = await b.waitFor("D");
    const selfData = dArgs[0];
    assert.equal(selfData[1], sid, "own player described");
    assert.equal(selfData[3], 2000, "position x preserved");
    assert.equal(selfData[4], 2000, "position y preserved");
    assert.equal(dArgs[1], true, "marked as the client's own player");
    const ownIndex = b.packets.findIndex(p => p[0] === "D" && p[1][1] === true);
    for (const name of ["N", "T", "U", "V"]) {
        assert.ok(b.packets.findIndex(p => p[0] === name) > ownIndex, name + " must follow own D");
    }
    assert.equal(b.find("D").filter(p => p[1][1] === true).length, 1, "own spawn occurs once");
    const [, hArgs] = await b.waitFor("H");
    assert.ok(hArgs[0].includes(building.sid), "building re-loaded for the fresh client");

    assert.equal(player.x, 2000, "server-side position never reset");
    assert.equal(player.lifeStats, lifeStats, "still the same life");

    // The new session is fully functional: input moves the player again.
    b.sendPacket("9", 0);
    await waitUntil(() => player.x > 2000, "movement after resume");
    b.sendPacket("9", null);
});

test("takeover: a second connection for the same identity never duplicates the player", async (t) => {
    const stack = await makeStack(t);
    const { game } = stack;

    const a = await connect(stack);
    const sid = await spawn(a);
    const player = playerOf(a);
    player.x = 3000; player.y = 3000; player.xVel = 0; player.yVel = 0;
    player.addResource(3, 1200);

    // The old socket is still OPEN (its close event hasn't happened — the race case).
    const b = await connect(stack, { did: a.did });
    assert.equal(game.players.length, 1, "no duplicate player");
    assert.equal(game.players[0], player, "same player object took over");

    await waitUntil(() => a.closeCode !== null, "old socket retired");
    await sleep(150);   // let any late close handler run
    assert.equal(game.players.length, 1, "the stale close did not remove the player");
    assert.equal(game.players[0].disconnectedAt || 0, 0, "player is live, not suspended");

    b.sendPacket("M", { name: "tester", moofoll: true, skin: 0 });
    const [, cArgs] = await b.waitFor("C");
    assert.equal(cArgs[0], sid, "same sid after takeover");
    assert.equal(resourceValue(b, "points"), 1200, "state carried over");
    assert.equal(player.x, 3000, "position preserved");

    // A different identity must NOT take over: it becomes its own player.
    const c = await connect(stack);   // new device id
    await spawn(c, "other");
    assert.equal(game.players.length, 2, "different device = different player");
    assert.ok(playerOf(c) && playerOf(c) !== player);
});

test("grace expiry removes the player through the normal path", async (t) => {
    const stack = await makeStack(t, { graceMs: 250 });
    const { game, accounts } = stack;
    let livesRecorded = 0;
    const original = accounts.recordLife.bind(accounts);
    accounts.recordLife = (...args) => { livesRecorded++; return original(...args); };

    const account = accounts.accountForEmail("expire@example.com");
    const a = await connect(stack, { account });
    await spawn(a, "Expirer");
    const player = playerOf(a);
    game.object_manager.add(game.game_objects.length, player.x + 150, player.y, 0, WOOD_WALL.scale, WOOD_WALL.type, WOOD_WALL, false, player);
    const building = game.game_objects.find(o => o.active && o.owner === player);
    assert.ok(building);

    a.ws.terminate();
    await waitUntil(() => player.disconnectedAt, "suspension");
    assert.equal(game.players.length, 1, "suspended player still present");
    assert.equal(building.active, true, "building kept during grace");
    assert.equal(livesRecorded, 0, "nothing recorded while suspended");

    // No resume within the grace period: the normal removal runs.
    await waitUntil(() => game.players.length === 0, "expiry removal", 3000);
    assert.equal(building.active, false, "buildings torn down by the normal removal");
    assert.equal(game.playersById.has(player.id), false, "reference removed");
    assert.equal(game.sids[player.sid], true, "sid released");
    assert.equal(livesRecorded, 1, "the life was recorded exactly once, at removal");
});

test("kicked players never resume (kick = final, no grace)", async (t) => {
    const stack = await makeStack(t);
    const { game } = stack;

    const a = await connect(stack);
    await spawn(a, "Kicked");
    const player = playerOf(a);
    player.addResource(3, 9000);

    player.kick("kicked");   // the staff / anti-cheat path
    await waitUntil(() => a.closeCode !== null, "kick close");
    await waitUntil(() => game.players.length === 0, "kicked player removed immediately");
    assert.equal(player.kicked, true);

    // A fresh ticket for the same device starts a NEW player — the old life is gone.
    const b = await connect(stack, { did: a.did });
    await spawn(b, "Kicked");
    assert.equal(game.players.length, 1);
    assert.notEqual(game.players[0], player, "a new player object, not the kicked one");
    assert.ok(!resourceValue(b, "points"), "no points carried over from the kicked session");
});

test("banned identities never resume: the gate rejects the reconnect", async (t) => {
    const stack = await makeStack(t, { graceMs: 250 });
    const { game, moderation } = stack;

    const a = await connect(stack);
    await spawn(a, "Soon Banned");
    const player = playerOf(a);
    a.ws.terminate();
    await waitUntil(() => player.disconnectedAt, "suspension");

    moderation.banned = true;   // banned while suspended
    const { ticket } = stack.accounts.issueTicket({ account: null, did: a.did, server: game.key });
    const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/s/${game.key}?b=${stack.build.BUILD_ID}&token=tk:${ticket}`,
        { origin: `http://127.0.0.1:${stack.port}` });
    const [code] = await once(ws, "close");
    assert.equal(code, CLOSE.INVALID_CONNECTION, "banned reconnect rejected at the gate");
    assert.equal(game.players.length, 1, "no duplicate appeared");
    assert.equal(game.players[0], player, "the suspended player was not resumed");

    // ...and its suspension still expires on schedule.
    await waitUntil(() => game.players.length === 0, "expiry removal", 3000);
});

test("matching is scoped to the game server: another server never resumes", async (t) => {
    const stack = await makeStack(t, { gameKeys: ["T1", "T2"] });
    const [game1, game2] = [stack.games.get("T1"), stack.games.get("T2")];

    const a = await connect(stack, { server: "T1" });
    await spawn(a, "Server One");
    const player = playerOf(a);
    a.ws.terminate();
    await waitUntil(() => player.disconnectedAt, "suspension");

    // Same device, fresh ticket, but for T2: a new player there, no takeover.
    const b = await connect(stack, { did: a.did, server: "T2" });
    await spawn(b, "Server Two");
    assert.equal(game1.players.length, 1, "T1 player untouched");
    assert.equal(game2.players.length, 1, "T2 got a new player");
    assert.notEqual(game2.players[0], player);

    // And the same device back on T1 resumes the suspended player.
    const c = await connect(stack, { did: a.did, server: "T1" });
    c.sendPacket("M", { name: "Server One", moofoll: true, skin: 0 });
    const [, cArgs] = await c.waitFor("C");
    assert.equal(cArgs[0], player.sid, "resumed on the right server");
    assert.equal(game1.players[0], player);
});

test("suspended players: no input acts, nothing is gathered, no invulnerability", async (t) => {
    const stack = await makeStack(t);
    const { game } = stack;

    const a = await connect(stack);
    await spawn(a, "Frozen");
    const player = playerOf(a);
    player.x = 4000; player.y = 4000; player.xVel = 0; player.yVel = 0;

    // Moving and auto-gathering when the link drops.
    a.sendPacket("9", Math.PI / 2);
    await waitUntil(() => player.y > 4000, "movement while connected");
    a.sendPacket("K", 1);   // auto gather on
    await waitUntil(() => player.autoGather, "auto gather on");
    const yAtDrop = player.y;

    a.ws.terminate();
    await waitUntil(() => player.disconnectedAt, "suspension");

    // Every input effect was frozen at suspension.
    assert.equal(player.moveDir, undefined, "no movement input");
    assert.equal(player.mouseState, 0, "no mouse input");
    assert.equal(player.autoGather, 0, "no auto-gather while away");
    assert.equal(player.xVel, 0);
    assert.equal(player.yVel, 0);

    // The world keeps ticking but the player does not move by itself.
    await sleep(400);
    assert.equal(player.y, yAtDrop, "frozen in place");

    // No exploitable protection: the suspended player takes full damage.
    assert.equal(player.powers.god, 0);
    const before = player.health;
    player.changeHealth(-30, null);
    assert.equal(player.health, before - 30, "fully damageable while disconnected");

    // The anti-cheat does not kick a suspended player for missing probes.
    assert.equal(player.anticheat.closed, false, "anti-cheat not fired while suspended");
    assert.ok(game.players.includes(player), "still in the world");
});

test("a player that dies during the grace period resumes into a normal new life", async (t) => {
    const stack = await makeStack(t);
    const { game } = stack;

    const a = await connect(stack);
    await spawn(a, "Unlucky");
    const player = playerOf(a);
    player.addResource(3, 4000);

    a.ws.terminate();
    await waitUntil(() => player.disconnectedAt, "suspension");

    // Killed while away (the world never stopped being dangerous).
    player.changeHealth(-1000, null);
    assert.equal(player.alive, false, "died during the grace period");
    assert.ok(game.players.includes(player), "still resumable");

    const b = await connect(stack, { did: a.did });
    assert.equal(game.players.length, 1, "no duplicate");
    assert.equal(game.players[0], player, "same player object");
    // Exercise the normal spawn path on open grass, away from random map edges,
    // the river and permanent terrain. Motion itself still crosses the real wire.
    player.authoringSpawn = () => ({ x: 6000, y: 6000 });
    b.sendPacket("M", { name: "Unlucky", moofoll: false, skin: 0 });
    const [, cArgs] = await b.waitFor("C");
    assert.equal(cArgs[0], player.sid, "same sid");
    assert.equal(player.alive, true, "respawned through the normal spawn path");
    assert.equal(player.health, player.maxHealth, "fresh life health");
    assert.ok(!resourceValue(b, "points"), "the old life's points died with it");
    assert.equal(player.x, 6000, "deterministic open spawn");
    assert.equal(player.y, 6000, "deterministic open spawn");
    const spawnedX = player.x;
    b.sendPacket("9", 0);
    await waitUntil(() => player.x > spawnedX + 1, "new life moves after real input");
});

test("account identity matches across devices; anti-cheat strikes survive the resume", async (t) => {
    const stack = await makeStack(t);
    const { game, accounts } = stack;

    const account = accounts.accountForEmail("maria@example.com");
    const a = await connect(stack, { account });           // device 1
    const sid = await spawn(a, "Maria Bonita");
    const player = playerOf(a);
    player.addResource(3, 777);
    player.anticheat.strike(3, "test strike");

    a.ws.terminate();
    await waitUntil(() => player.disconnectedAt, "suspension");

    const b = await connect(stack, { account });           // device 2, same account
    assert.equal(game.players.length, 1, "no duplicate");
    assert.equal(game.players[0], player);
    b.sendPacket("M", { name: "Maria Bonita", moofoll: true, skin: 0 });
    const [, cArgs] = await b.waitFor("C");
    assert.equal(cArgs[0], sid, "same sid for the same account on a new device");
    assert.equal(resourceValue(b, "points"), 777);
    assert.equal(player.anticheat.strikes, 3, "anti-cheat strikes carried over");
});
