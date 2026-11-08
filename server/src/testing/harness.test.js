// TEST HARNESS (shared fixtures for the authoritative-server test suite)
// This file is itself a (small) test file so the QA scope rule ("only *.test.js may be
// added under server/src") is respected; every other suite imports these helpers.
// Everything here wires the REAL production modules (Game, Player, AI, ObjectManager,
// items, store, config). No game rule is reimplemented or altered: fixtures only place
// entities, stop the timer loop, and drive update(delta) by hand for determinism.

import test from "node:test";
import assert from "node:assert/strict";
import { Game } from "../moomoo/server.js";
import { config } from "../moomoo/config.js";
import { items } from "../moomoo/modules/items.js";
import { hats, accessories } from "../moomoo/modules/store.js";
import { UTILS } from "../moomoo/libs/utils.js";
import { AntiCheat } from "../anticheat/index.js";

export { items, hats, accessories, UTILS, config };

// A real Game world with the tick timer stopped (we drive updates manually).
export function makeGame(t) {
    const game = new Game({ key: "T" + Math.floor(Math.random() * 1e6), name: "test", capacity: 40, membersOnly: false, accounts: null, log: () => {}, hooks: {} });
    game.stop(); // never let the interval tick on its own: tests step entities by hand
    if (t) t.after(() => game.stop());
    return game;
}

// Isolate object/weapon fixtures from generated resources and static cave terrain.
export function clearWorld(game) {
    game.object_manager.terrain = null;
    for (const obj of game.game_objects) if (obj.active) game.object_manager.disableObj(obj);
}

// Deactivate every spawned animal so ai_manager.spawn() gives us fresh, controlled ones.
export function clearAnimals(game) {
    for (const ai of game.ais) {
        ai.active = false;
        ai.alive = false;
    }
}

// A spawned, alive player driven through the real Game.addPlayer + Player.spawn path.
export function addPlayer(game, { name = "tester", moofoll = true, account = null } = {}) {
    const sent = [];
    const player = game.addPlayer({ send: (...args) => sent.push(args), account, ip: "127.0.0.1" });
    assert.ok(player, "game accepted the player");
    player.sentPackets = sent;
    player.setUserData({ name, skin: 0 });
    player.spawn(moofoll);
    assert.ok(player.alive, "player is alive after spawn");
    return player;
}

// Exact placement + zeroed velocity (fixtures only, no rule changes).
export function place(entity, x, y, dir = 0) {
    entity.x = x;
    entity.y = y;
    entity.dir = dir;
    entity.xVel = 0;
    entity.yVel = 0;
    return entity;
}

// Drive entity.update in fixed steps (default 16 ms) for a total of totalMs.
export function step(entity, totalMs, stepMs = 16) {
    for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) entity.update(stepMs);
}

// Run fn with Math.random stubbed (deterministic hitScare / teleport / wander rolls).
export function withRandom(value, fn) {
    const original = Math.random;
    Math.random = typeof value === "function" ? value : () => value;
    try {
        return fn();
    } finally {
        Math.random = original;
    }
}

export function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// Unit vector from `from` to `to`.
export function toward(from, to) {
    const d = dist(from, to) || 1;
    return { x: (to.x - from.x) / d, y: (to.y - from.y) / d };
}

// dot product of an entity's velocity with a direction
export function velDot(entity, dir) {
    return entity.xVel * dir.x + entity.yVel * dir.y;
}

// Real AntiCheat attached to a player (kick/close are observable spies).
export function attachAnticheat(player, spies = {}) {
    const ac = new AntiCheat({
        player,
        log: () => {},
        kick: spies.kick || (() => {}),
        close: spies.close || (() => {}),
        store: null,
        session: null,
        sendProbes: spies.sendProbes || null
    });
    player.anticheat = ac;
    return ac;
}

// Minimal packet-handler context: real game, no accounts/chat, observable moderation.
export function makeCtx(game, extra = {}) {
    return {
        game,
        accounts: null,
        moderation: { report: () => ({}), reportReason: () => {}, ban: () => {}, isBanned: () => false },
        chat: null,
        log: null,
        ...extra
    };
}

export function itemByName(name) {
    const item = items.list.find(i => i.name === name);
    assert.ok(item, `item "${name}" exists in the shared table`);
    return item;
}

export function hatById(id) {
    const hat = hats.find(h => h.id === id);
    assert.ok(hat, `hat ${id} exists in the shared table`);
    return hat;
}

export function accessoryById(id) {
    const acc = accessories.find(a => a.id === id);
    assert.ok(acc, `accessory ${id} exists in the shared table`);
    return acc;
}

// Add a structure/object through the real ObjectManager and return the LIVE object
// (add() may recycle an inactive slot, so locate it by its coordinates).
export function placeObject(game, item, x, y, dir = 0, owner = null) {
    game.object_manager.add(game.game_objects.length, x, y, dir, item.scale, item.type, item, false, owner);
    const obj = game.game_objects.find(o => o.active && o.x === x && o.y === y && o.owner === owner);
    assert.ok(obj, `object "${item.name || item.type}" placed at ${x},${y}`);
    return obj;
}

// Packets a player received of a given type.
export function packetsOf(player, type) {
    return player.sentPackets.filter(p => p[0] === type);
}

// Only runs when this file itself is the test entry point (importing suites skip it).
if (process.argv[1] && process.argv[1].endsWith("testing/harness.test.js")) {
    test("harness: the real Game boots with world, animals and wired managers", () => {
    const game = makeGame();
    assert.ok(game.game_objects.length > 0, "world generated natural objects");
    assert.ok(game.ais.length > 0, "animals spawned from the spawn plan");
    assert.ok(game.object_manager && game.projectile_manager && game.ai_manager, "managers wired");
    const player = addPlayer(game, { name: "harness" });
    assert.equal(player.alive, true);
    assert.equal(player.health, 100, "spawn health follows config.maxHealth path");
    assert.ok(player.x >= 0 && player.x <= config.mapScale && player.y >= 0 && player.y <= config.mapScale, "spawn inside the map");
    game.stop();
    });
}
