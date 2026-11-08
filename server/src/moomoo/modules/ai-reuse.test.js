import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminConsole } from "../../admin/console.js";
import { handlePacket } from "../../network/packets.js";
import { makeGame, addPlayer, attachAnticheat, makeCtx, place } from "../../testing/harness.test.js";

function fixture(t) {
    const game = makeGame(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-ai-reuse-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const admin = addPlayer(game, { name: "ReuseAdmin", account: { id: "reuse-admin", name: "ReuseAdmin", role: "admin" } });
    attachAnticheat(admin);
    const console = new AdminConsole({
        games: new Map([[game.key, game]]), accounts: {}, moderation: {},
        build: {}, dataDir: dir, log: () => {}
    });
    return { game, admin, console };
}

test("a cleared respawning Treasure is immediately visible when reused as a Yeti", t => {
    const { game, admin, console } = fixture(t);
    const treasure = game.ais.find(ai => ai.active && ai.index === 7);
    treasure.changeHealth(-treasure.maxHealth, admin);
    assert.equal(treasure.spawnCounter, 120000);
    assert.deepEqual(console.execute("clear treasure"), ["removed 1 animals"]);

    place(admin, 5000, 3000);
    handlePacket(makeCtx(game), admin, "A", ["spawn", 10]);
    const yeti = game.ais.find(ai => ai.sid === treasure.sid);
    assert.equal(yeti, treasure, "exercise the reused object, not a fresh allocation");
    assert.equal(yeti.index, 10);
    assert.equal(yeti.spawnCounter, 0, "the old respawn delay must not hide the Yeti");
    assert.equal(yeti.despawnOnDeath, true, "the new admin override still applies");
    admin.sentPackets.length = 0;
    game.syncAnimals(admin);
    assert.ok(admin.sentPackets.some(packet => packet[0] === "I" &&
        packet[1].some((sid, i) => i % 8 === 0 && sid === yeti.sid)), "nearby viewer receives the new animal");
});

test("natural replenishment does not inherit administrative despawn or reward behavior", t => {
    const { game, admin, console } = fixture(t);
    console.execute("clear cow");
    handlePacket(makeCtx(game), admin, "A", ["spawn", 10]);
    const spawned = game.ais.find(ai => ai.active && ai.index === 10 && ai.despawnOnDeath);
    spawned.changeHealth(-spawned.maxHealth, admin);
    assert.equal(spawned.active, false);

    game.ensureAnimals();
    const cow = game.ais.find(ai => ai.sid === spawned.sid);
    assert.equal(cow.index, 0);
    assert.equal(cow.despawnOnDeath, false);
    const before = admin.food;
    cow.changeHealth(-cow.maxHealth, admin);
    assert.ok(admin.food > before, "natural animal keeps its normal food drop");
    assert.equal(cow.active, true, "natural animal follows its respawn path");
});

test("reusing a boss clears its name and queued attack", t => {
    const { game, console } = fixture(t);
    const crab = game.ais.find(ai => ai.active && ai.index === 11);
    console.execute("boss crab attack geysers");
    assert.equal(crab.nextAttack, "geysers");
    console.execute("clear crab");
    const cow = game.ai_manager.spawn(5000, 3000, 0, 0);
    assert.equal(cow, crab);
    assert.equal(cow.name, undefined, "unnamed animals must not retain a boss name");
    assert.equal(cow.nextAttack, null);
});
