import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeGame, addPlayer, attachAnticheat, makeCtx, clearAnimals, clearWorld, place } from "../testing/harness.test.js";
import { handlePacket } from "./packets.js";
import { AdminConsole } from "../admin/console.js";

const defaults = { god: 0, aura: 0, godlike: 0, boss: 0, invisible: 0, size: 1, power: 1, speed: 1, health: 1 };
function setup(t) {
    const game = makeGame(t);
    clearAnimals(game);
    clearWorld(game);
    const account = { id: "session-admin", name: "SessionAdmin", role: "admin" };
    const admin = addPlayer(game, { account });
    attachAnticheat(admin);
    place(admin, 5000, 3000);
    game.syncPlayers(admin);
    admin.sentPackets.length = 0;
    return { game, admin, account, ctx: makeCtx(game) };
}
function snapshot(player) {
    return structuredClone({ items: player.items, weapons: player.weapons, weaponXP: player.weaponXP,
        wood: player.wood, food: player.food, stone: player.stone, points: player.points,
        XP: player.XP, age: player.age, upgradePoints: player.upgradePoints,
        skins: player.skins, tails: player.tails, skinIndex: player.skinIndex, tailIndex: player.tailIndex });
}
function state(player) {
    return player.sentPackets.filter(p => p[0] === "A").at(-1)?.[1]?.admin;
}

test("resume presents self before inventory and suppresses a premature tick description", t => {
    const { game, admin, ctx } = setup(t);
    admin.items = [0, 4, 6, 10];
    admin.weapons = [5, 9];
    admin.weaponXP[5] = 8000;
    admin.addResource(0, 1200);
    admin.XP = 90; admin.age = 8; admin.upgradePoints = 2;
    admin.powers.size = 2; admin.powers.health = 5;
    admin.applyPowers();
    const before = snapshot(admin);
    const packets = [];
    game.rejoinPlayer(admin, { send: (type, ...args) => packets.push([type, ...args]), ip: "127.0.0.1" });
    game.syncPlayers(admin);
    assert.ok(!packets.some(p => p[0] === "D"), "a tick must wait for the fresh client's M");
    handlePacket(ctx, admin, "M", [{ name: "ignored", moofoll: false, skin: 0 }]);
    const setupIndex = packets.findIndex(p => p[0] === "C");
    const own = packets.findIndex(p => p[0] === "D" && p[2] === true);
    const inventory = packets.findIndex(p => p[0] === "V");
    assert.ok(setupIndex >= 0 && own > setupIndex && inventory > own, "C -> own D -> V is deterministic");
    assert.equal(packets[own][1][7], 500);
    game.syncPlayers(admin);
    assert.equal(packets.filter(p => p[0] === "D" && p[2] === true).length, 1, "tick must not spawn the client twice");
    assert.deepEqual(snapshot(admin), before);
    assert.equal(admin.powers.size, 2, "the same life keeps its powers");
});

test("accepted admin updates include own attributes without another spawn or inventory reset", t => {
    const { game, admin, ctx } = setup(t);
    const viewer = addPlayer(game);
    place(viewer, 5200, 3000);
    game.syncPlayers(viewer);
    viewer.sentPackets.length = 0;
    admin.addResource(0, 1200);
    admin.items = [0, 4, 6, 10];
    admin.XP = 140; admin.age = 5;
    const before = snapshot(admin);
    handlePacket(ctx, admin, "A", ["size", 2]);
    handlePacket(ctx, admin, "A", ["health", 5]);
    const packet = admin.sentPackets.filter(p => p[0] === "A").at(-1)?.[1];
    assert.equal(packet?.admin?.powers.size, 2);
    assert.equal(packet?.admin?.powers.health, 5);
    assert.equal(packet?.self?.[7], 500);
    assert.equal(packet?.self?.[8], 70);
    assert.ok(!admin.sentPackets.some(p => p[0] === "D"), "attribute changes cannot call client spawn again");
    assert.deepEqual(snapshot(admin), before);
    game.syncPlayers(viewer);
    assert.ok(viewer.sentPackets.some(p => p[0] === "D" && p[1][7] === 500 && p[1][8] === 70));
    handlePacket(ctx, admin, "A", ["size", 999]);
    assert.equal(admin.powers.size, 2, "invalid value never changes authoritative state");
});

test("Godlike reflects its god and aura components after individual changes", t => {
    const { admin, ctx } = setup(t);
    handlePacket(ctx, admin, "A", ["godlike", 1]);
    assert.equal(state(admin)?.powers.godlike, 1);
    handlePacket(ctx, admin, "A", ["god", 0]);
    assert.equal(state(admin)?.powers.godlike, 0);
    assert.equal(state(admin)?.powers.aura, 1);
    handlePacket(ctx, admin, "A", ["god", 1]);
    assert.equal(state(admin)?.powers.godlike, 1);
    handlePacket(ctx, admin, "A", ["aura", 0]);
    assert.equal(state(admin)?.powers.godlike, 0);
});

for (const role of [null, "mod"]) {
    test("losing admin clears active powers immediately, including suspended players: " + role, t => {
        const { game, admin, account, ctx } = setup(t);
        const second = addPlayer(game, { account });
        attachAnticheat(second);
        for (const player of [admin, second]) {
            Object.assign(player.powers, { god: 1, aura: 1, invisible: 1, size: 2, health: 5 });
            player.applyPowers();
            player.health = 250;
        }
        game.suspendPlayer(second);
        game.setAccountRole(account.id, role);
        for (const player of [admin, second]) {
            assert.deepEqual(player.powers, defaults);
            assert.equal(player.maxHealth, 100);
            assert.equal(player.health, 50, "revocation preserves the health ratio");
            assert.equal(player.scale, 35);
            const before = player.wood;
            handlePacket(ctx, player, "A", ["give", 0, 10000]);
            assert.equal(player.wood, before);
        }
        assert.equal(state(admin)?.role, role);
        assert.equal(state(admin)?.active, true);
    });
}

test("death and a new life clear temporary powers while the account keeps its role", t => {
    const { game, admin, account, ctx } = setup(t);
    Object.assign(admin.powers, { god: 0, aura: 1, godlike: 1, boss: 1, invisible: 1, size: 3, power: 5, speed: 2, health: 5 });
    admin.applyPowers();
    admin.changeHealth(-admin.health - 1);
    assert.equal(admin.alive, false);
    assert.deepEqual(admin.powers, defaults, "dead player's panel no longer claims active powers");
    assert.equal(state(admin)?.active, false);
    handlePacket(ctx, admin, "M", [{ name: "SessionAdmin", moofoll: false, skin: 0 }]);
    assert.deepEqual(admin.powers, defaults);
    assert.equal(admin.maxHealth, 100);
    assert.equal(admin.scale, 35);
    assert.equal(account.role, "admin");
    assert.equal(state(admin)?.active, true);
});

test("console grants update their recipient and delayed dive cannot revive cleared powers", t => {
    const { game, admin } = setup(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-session-console-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const terminal = new AdminConsole({ games: new Map([[game.key, game]]), accounts: {},
        moderation: {}, build: {}, dataDir: dir, log: () => {} });
    terminal.execute("size SessionAdmin 2");
    assert.equal(state(admin)?.powers.size, 2);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    terminal.execute("dive SessionAdmin 1");
    game.setAccountRole(admin.account.id, null);
    t.mock.timers.tick(4000);
    assert.deepEqual(admin.powers, defaults);
    assert.equal(admin.dive, 0);
});

test("unchanged snapshots do not resend full self data on every movement tick", t => {
    const { game, admin } = setup(t);
    game.syncAdminState(admin);
    admin.sentPackets.length = 0;
    for (let i = 0; i < 10; i++) {
        admin.x += 2;
        admin.health--;
        game.syncAdminState(admin);
    }
    assert.equal(admin.sentPackets.filter(p => p[0] === "A").length, 0);
    admin.powers.aura = 1;
    game.syncAdminState(admin);
    assert.equal(state(admin)?.powers.aura, 1);
});

test("owner console grants to non-admins update self and end with that life", t => {
    const { game } = setup(t);
    const recipient = addPlayer(game, { account: { id: "grantee", name: "Grantee", role: null } });
    game.syncPlayers(recipient);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-session-grant-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const terminal = new AdminConsole({ games: new Map([[game.key, game]]), accounts: {},
        moderation: {}, build: {}, dataDir: dir, log: () => {} });
    terminal.execute("god Grantee on");
    terminal.execute("size Grantee 2");
    assert.equal(state(recipient)?.role, null, "a console grant does not grant admin");
    assert.equal(state(recipient)?.powers.god, 1);
    assert.equal(recipient.sentPackets.filter(p => p[0] === "A").at(-1)[1].self[8], 70);
    recipient.powers.god = 0;
    recipient.changeHealth(-recipient.health - 1);
    recipient.spawn(false);
    assert.deepEqual(recipient.powers, defaults);
});
