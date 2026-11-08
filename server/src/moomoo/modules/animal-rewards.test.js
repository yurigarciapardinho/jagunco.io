import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeGame, addPlayer, clearAnimals, clearWorld, attachAnticheat, makeCtx } from "../../testing/harness.test.js";
import { handlePacket } from "../../network/packets.js";
import { AccountStore } from "../../api/store.js";
import { FilePersistence } from "../../persistence/fileDriver.js";
import { MySqlPersistence } from "../../persistence/mysqlDriver.js";
import { FakePool } from "../../persistence/testing/fakeMysql2.js";

const SHELL = 61;
const rewards = [
    [6, "MOOSTAFA", 8000, 100, "moostafa"],
    [7, "Treasure", 5000, 0, "treasure"],
    [8, "MOOFIE", 3000, 1000, "moofie"],
    [10, "Yeti", 4500, 800, "yeti"],
    [11, "Crab King", 4000, 0, "crab_king"]
];
function gameFixture(t) {
    const game = makeGame(t);
    clearAnimals(game);
    clearWorld(game);
    const killer = addPlayer(game, { name: "RewardKiller", moofoll: false });
    return { game, killer };
}
function spawn(game, index, invoked = false) {
    return game.ai_manager.spawn(index === 11 ? -2500 : 5000, index === 11 ? 7200 : 3000, 0, index,
        { despawnOnDeath: invoked, ...(index === 11 ? { spawnDelay: 600000 } : {}) });
}
async function accountFixture(t, mode) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-reward-"));
    const pool = mode === "mysql" ? new FakePool() : null;
    const logs = [];
    const persistence = () => pool
        ? new MySqlPersistence({ databaseUrl: "mysql://qa:test@localhost/reward_qa", dataDir: dir, createPool: () => pool, log: line => logs.push(line) })
        : new FilePersistence({ dataDir: dir, log: line => logs.push(line) });
    const stores = [];
    const open = async () => {
        const store = new AccountStore(dir, { persistence: persistence() });
        await store.ready();
        stores.push(store);
        return store;
    };
    t.after(async () => {
        for (const store of stores) await store.closePersistence();
        fs.rmSync(dir, { recursive: true, force: true });
        for (const store of stores) {
            if (store.persistence.mode === "mysql") assert.equal(store.persistence.queue.errors, 0, logs.join("\n"));
        }
        assert.deepEqual(logs.filter(line => /failed|could not|after close/.test(line)), [], "no persistence errors");
    });
    const store = await open();
    const account = store.accountForEmail("reward-hero@example.test");
    store.claimName(account, "RewardHero");
    const game = makeGame(t);
    game.accounts = store;
    clearAnimals(game);
    clearWorld(game);
    const killer = addPlayer(game, { account, moofoll: false });
    return { store, account, game, killer, open };
}

for (const [index, name, gold, food, stat] of rewards) {
    for (const invoked of [false, true]) {
        test(name + ": " + (invoked ? "invoked" : "natural") + " rewards follow the existing economy", t => {
            const { game, killer } = gameFixture(t);
            const animal = spawn(game, index, invoked);
            assert.equal(animal.changeHealth(-animal.maxHealth, killer), true);
            assert.equal(killer.points, gold);
            assert.equal(killer.food, invoked ? 0 : food);
            assert.equal(killer.lifeStats.animalKills[stat], 1);
            const category = ["moostafa", "moofie", "crab_king"].includes(stat) ? "bosses" : "animals";
            assert.equal(killer.lifeStats[category], 1);
            assert.equal(killer.age, 2, "current XP overflow rule advances once for this fresh character");
            assert.equal(killer.XP, 0);
            assert.equal(killer.upgradePoints, 1);
            assert.equal(killer.weaponXP[0] || 0, invoked ? 0 : food, "drop-derived weapon XP follows the food reward");
            if (index === 11) assert.equal(killer.skins[SHELL], 1);
            if (invoked) {
                assert.equal(animal.active, false);
                assert.equal(animal.changeHealth(-animal.maxHealth, killer), false);
                assert.equal(killer.points, gold, "a despawned invocation cannot pay twice");
            }
        });
    }
}

for (const index of [7, 11]) {
    test("respawn delay rejects damage and duplicate rewards: " + index, t => {
        const { game, killer } = gameFixture(t);
        const animal = spawn(game, index);
        animal.changeHealth(-animal.maxHealth, killer);
        const points = killer.points;
        const kills = structuredClone(killer.lifeStats.animalKills);
        assert.ok(animal.spawnCounter > 0);
        assert.equal(animal.changeHealth(-animal.maxHealth, killer), false, "waiting entity is not a new kill");
        assert.equal(killer.points, points);
        assert.deepEqual(killer.lifeStats.animalKills, kills);
        animal.update(animal.spawnCounter + 1);
        assert.equal(animal.spawnCounter, 0);
        assert.equal(animal.changeHealth(-animal.maxHealth, killer), true, "the next actual life can pay normally");
        assert.equal(killer.points, points * 2);
    });
}

test("Crab assistance requires a live participant and at least 5 percent, without splitting finisher gold", t => {
    const { game, killer } = gameFixture(t);
    const eligible = addPlayer(game, { name: "Eligible", moofoll: false });
    const below = addPlayer(game, { name: "Below", moofoll: false });
    const dead = addPlayer(game, { name: "Dead", moofoll: false });
    const crab = spawn(game, 11);
    const threshold = crab.maxHealth * 0.05;
    crab.changeHealth(-threshold, eligible);
    crab.changeHealth(-(threshold - 1), below);
    crab.changeHealth(-threshold, dead);
    dead.kill(null);
    crab.changeHealth(-crab.health, killer);
    assert.equal(eligible.skins[SHELL], 1);
    assert.equal(below.skins[SHELL], undefined);
    assert.equal(dead.skins[SHELL], undefined);
    assert.equal(eligible.lifeStats.bossKills, 1);
    assert.equal(killer.lifeStats.bossKills, 1);
    assert.equal(eligible.points, 0);
    assert.equal(killer.points, 4000);
});

test("a departed assistant cannot award a reused sid or receive the Shell", t => {
    const { game, killer } = gameFixture(t);
    const departed = addPlayer(game, { name: "Departed", moofoll: false });
    const crab = spawn(game, 11);
    crab.changeHealth(-crab.maxHealth * 0.05, departed);
    const oldSid = departed.sid;
    game.removePlayer(departed);
    const replacement = addPlayer(game, { name: "Replacement", moofoll: false });
    assert.equal(replacement.sid, oldSid, "exercise actual sid reuse");
    crab.changeHealth(-crab.health, killer);
    assert.equal(game.crabKillers.has(replacement.sid), false, "new identity must not inherit credit");
    assert.equal(departed.skins[SHELL], undefined);
    assert.equal(replacement.skins[SHELL], undefined);
});

for (const mode of ["file", "mysql"]) {
    test("earned Shell persists immediately as profile appearance, independently of a later life record: " + mode, async t => {
        const { store, account, game, killer, open } = await accountFixture(t, mode);
        const crab = spawn(game, 11);
        crab.changeHealth(-crab.maxHealth, killer);
        assert.ok(store.lookOptions(account).hats.includes(SHELL), "earned appearance is saved at award time");
        assert.equal(store.setLook(account, { hat: SHELL }).status, 200);
        // Duplicate awards must not duplicate unlock entries.
        crab.update(crab.spawnCounter + 1);
        crab.changeHealth(-crab.maxHealth, killer);
        assert.equal(account.unlocks.hats.filter(id => id === SHELL).length, 1);
        await store.persistence.flush();
        const reloaded = await open();
        const again = reloaded.accountByEmail(account.email);
        assert.ok(reloaded.lookOptions(again).hats.includes(SHELL));
        assert.equal(again.look.hat, SHELL);
        const freshGame = makeGame(t);
        freshGame.accounts = reloaded;
        const fresh = addPlayer(freshGame, { account: again, moofoll: false });
        attachAnticheat(fresh);
        for (const action of [0, 1]) {
            handlePacket(makeCtx(freshGame), fresh, "c", [action, SHELL, 0]);
            assert.equal(fresh.skins[SHELL], undefined, "profile appearance does not grant equipment in a new match");
            assert.equal(fresh.skinIndex, 0, "earned-only equipment cannot be equipped or bought without the match reward");
        }
        killer.kill(null);
        killer.spawn(false);
        assert.equal(killer.skins[SHELL], 1, "the same character retains the already earned equipment as before");
    });

    test("life recording includes earned zero-price hats and preserves profile authorization: " + mode, async t => {
        const { store, account, game, killer, open } = await accountFixture(t, mode);
        assert.equal(store.setLook(account, { hat: SHELL }).status, 400);
        killer.skins[SHELL] = 1;
        game.recordUnlocks(killer);
        assert.ok(store.lookOptions(account).hats.includes(SHELL));
        assert.equal(account.unlocks.hats.filter(id => id === SHELL).length, 1);
        await store.persistence.flush();
        const reloaded = await open();
        assert.ok(reloaded.lookOptions(reloaded.accountByEmail(account.email)).hats.includes(SHELL));
    });
}
