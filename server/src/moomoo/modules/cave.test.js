import test from "node:test";
import assert from "node:assert/strict";
import { AdminConsole } from "../../admin/console.js";
import caveGeometry from "../../../../shared/cave.js";
import { makeGame, addPlayer, clearAnimals, place, withRandom, config, items, itemByName } from "../../testing/harness.test.js";
const { BOSS_CAVE, intersectsDisk, resolveMotion } = caveGeometry;

function setup(t, wildlife = false) {
    const game = makeGame(t);
    // Remove resource fixtures while keeping the actual cave terrain.
    for (const object of game.game_objects) if (object.active) game.object_manager.disableObj(object);
    if (!wildlife) clearAnimals(game);
    return game;
}
function player(game, x, y, scale = 35) {
    const p = addPlayer(game, { moofoll: false });
    place(p, x, y);
    p.scale = scale;
    return p;
}
function assertOutsideWalls(entity) {
    for (const wall of BOSS_CAVE.walls) {
        const cx = Math.max(wall.x, Math.min(wall.x + wall.width, entity.x));
        const cy = Math.max(wall.y, Math.min(wall.y + wall.height, entity.y));
        assert.ok(Math.hypot(entity.x - cx, entity.y - cy) >= entity.scale - 0.001, "body must not penetrate solid terrain");
    }
}

test("natural encounters share the cave without creating duplicate bosses", t => {
    const game = makeGame(t);
    assert.deepEqual(game.object_manager.terrain, BOSS_CAVE);
    for (const [index, name] of [[6, "moostafa"], [7, "treasure"], [8, "moofie"]]) {
        const list = game.ais.filter(ai => ai.active && ai.index === index && !ai.despawnOnDeath);
        assert.equal(list.length, 1);
        assert.equal(list[0].x, BOSS_CAVE.spawns[name].x);
        assert.equal(list[0].y, BOSS_CAVE.spawns[name].y);
        assert.deepEqual(list[0].homeBounds, BOSS_CAVE.interior);
    }
    const crab = game.ais.find(ai => ai.active && ai.index === 11);
    assert.ok(crab.x < 0, "the Crab King keeps its secret pool");
    game.ensureAnimals();
    assert.equal(game.ais.filter(ai => ai.active && [6, 7, 8].includes(ai.index) && !ai.despawnOnDeath).length, 3);
});

test("generated resources and wildlife stay out of the reserved cave approach", t => {
    const game = makeGame(t);
    for (const object of game.game_objects.filter(o => o.active)) {
        assert.ok(!intersectsDisk(object.x, object.y, object.scale, BOSS_CAVE.reserved));
    }
    for (const animal of game.ais.filter(ai => ai.active && ![6, 7, 8, 11].includes(ai.index))) {
        assert.ok(!intersectsDisk(animal.x, animal.y, animal.scale, BOSS_CAVE.reserved));
    }
});

for (const radius of [35, 105, 175]) {
    test("south entrance admits entry and retreat at radius " + radius, t => {
        const game = setup(t);
        const p = player(game, 2600, 5400, radius);
        p.y = 4500;
        p.keepInWorld(2600, 5400);
        assert.equal(p.y, 4500);
        p.y = 5400;
        p.keepInWorld(2600, 4500);
        assert.equal(p.y, 5400);
        assertOutsideWalls(p);
    });
    test("continuous terrain stops high-speed crossing at radius " + radius, t => {
        const game = setup(t);
        const p = player(game, 1100, 3500, radius);
        p.x = 4300; p.xVel = 20;
        p.keepInWorld(1100, 3500);
        assert.ok(p.x <= 1400 - radius + 0.001);
        assert.equal(p.xVel, 0);
        assertOutsideWalls(p);
    });
}

test("diagonal approaches and invalid teleports resolve outside actual rounded wall corners", () => {
    for (const radius of [35, 105, 175]) {
        for (const [x1, y1, x2, y2] of [
            [1300, 2400, 3200, 3900], [2600, 5500, 2300, 4600],
            [4000, 5200, 3000, 3500], [2100, 4500, 2900, 5200],
            [1450, 3300, 1450, 3300], [1500, 2660, 1500, 2660]
        ]) {
            const entity = { x: x2, y: y2, scale: radius, xVel: 5, yVel: 5 };
            resolveMotion(BOSS_CAVE, entity, x1, y1);
            assertOutsideWalls(entity);
        }
    }
});

test("natural guardians stay confined under knockback and while lured outside", t => {
    const game = setup(t, true);
    const lure = player(game, 2600, 5300);
    lure.powers.god = 1;
    for (const index of [6, 8]) {
        const guardian = game.ais.find(ai => ai.active && ai.index === index);
        place(guardian, 2600, 4770);
        guardian.xVel = 15; guardian.yVel = 25;
        guardian.chargeTarget = lure; guardian.moveCount = 10000; guardian.waitCount = 0;
        for (let i = 0; i < 50; i++) guardian.update(100);
        const inset = guardian.scale + 8;
        assert.ok(guardian.x >= BOSS_CAVE.interior.x + inset && guardian.x <= BOSS_CAVE.interior.x + BOSS_CAVE.interior.width - inset);
        assert.ok(guardian.y <= BOSS_CAVE.interior.y + BOSS_CAVE.interior.height - inset);
    }
});

test("reused and administrative animals do not inherit a guardian's confinement", t => {
    const game = setup(t, true);
    const guardian = game.ais.find(ai => ai.index === 6);
    guardian.active = false; guardian.alive = false;
    const cow = game.ai_manager.spawn(5000, 6000, 0, 0);
    assert.equal(cow, guardian);
    assert.equal(cow.homeBounds, null);
    const summoned = game.ai_manager.spawn(5000, 6000, 0, 8, { despawnOnDeath: true });
    assert.equal(summoned.homeBounds, null);
});

test("respawning guardians stay absent until their original delay finishes", t => {
    const game = setup(t, true);
    const p = player(game, 5000, 6000);
    const guardian = game.ais.find(ai => ai.index === 6);
    guardian.changeHealth(-guardian.health, p);
    assert.equal(guardian.spawnCounter, 60000);
    guardian.update(10);
    assert.equal(guardian.x, -1000000);
    guardian.update(60000);
    assert.equal(guardian.x, BOSS_CAVE.spawns.moostafa.x);
    assert.equal(guardian.y, BOSS_CAVE.spawns.moostafa.y);
});

test("Treasure can be damaged while both natural guardians are alive", t => {
    const game = setup(t, true);
    const treasure = game.ais.find(ai => ai.index === 7);
    const p = player(game, BOSS_CAVE.spawns.treasure.x + 160, BOSS_CAVE.spawns.treasure.y);
    p.dir = Math.PI;
    const before = treasure.health;
    p.gather();
    assert.ok(treasure.health < before, "physical protection does not add a kill-both gate");
    assert.ok(game.ais.filter(ai => [6, 8].includes(ai.index)).every(ai => ai.active && !ai.spawnCounter));
});

test("melee cannot cross a solid wall but still works through the entrance", t => {
    const game = setup(t);
    const attacker = player(game, 1360, 3500);
    const target = player(game, 1560, 3500);
    attacker.weaponIndex = items.weapons.find(w => w.gather && w.range >= 140).id;
    attacker.gather();
    assert.equal(target.health, 100);
    place(attacker, 2600, 5030, -Math.PI / 2);
    place(target, 2600, 4850);
    attacker.gather();
    assert.ok(target.health < 100);
});

for (const variableTick of [false, true]) {
    test("arrows stop at terrain before damaging targets, variable tick=" + variableTick, t => {
        const game = setup(t);
        const owner = player(game, 1200, 3500);
        const target = player(game, variableTick ? 2300 : 1600, 3500);
        const arrow = game.projectile_manager.addProjectile(1300, 3500, 0, 3000, 1.6, 0, owner, null, 0);
        if (variableTick) arrow.update(1);
        arrow.update(500);
        assert.equal(target.health, 100);
        assert.equal(arrow.active, false);
    });
}

test("entrance construction is refused without spending resources; ordinary building remains available", t => {
    const game = setup(t);
    const p = player(game, 2600, 5100);
    p.wood = 1000; p.dir = -Math.PI / 2;
    const wall = itemByName("wood wall");
    p.buildItem(wall);
    assert.equal(p.wood, 1000);
    assert.equal(game.game_objects.filter(o => o.active && o.owner === p).length, 0);
    place(p, 6000, 6000, 0);
    p.buildItem(wall);
    assert.equal(p.wood, 990);
});

test("random player and wildlife respawns cannot land in the reserved terrain", t => {
    const game = setup(t);
    const p = player(game, 6000, 6000);
    withRandom(0.2, () => p.spawn(false));
    assert.ok(!intersectsDisk(p.x, p.y, p.scale, BOSS_CAVE.reserved));
    const cow = game.ai_manager.spawn(6000, 6000, 0, 0);
    withRandom(0.2, () => cow.changeHealth(-cow.health, p));
    assert.ok(!intersectsDisk(cow.x, cow.y, cow.scale, BOSS_CAVE.reserved));
});

test("initial and resumed clients receive the exact terrain used by collision", t => {
    const game = setup(t);
    const p = player(game, 2600, 4400);
    assert.deepEqual(p.sentPackets.find(packet => packet[0] === "A" && packet[1].cave)?.[1].cave, BOSS_CAVE);
    const packets = [];
    game.rejoinPlayer(p, { send: (...packet) => packets.push(packet), ip: "127.0.0.1" });
    assert.deepEqual(packets.find(packet => packet[0] === "A" && packet[1].cave)?.[1].cave, BOSS_CAVE);
});

test("owner console recreates natural guardians with confinement after clear", t => {
    const game = setup(t, true);
    const owner = player(game, 6000, 6000);
    owner.name = "CaveOwner";
    const console = new AdminConsole({ games: new Map([[game.key, game]]), accounts: {}, moderation: {}, build: {}, dataDir: "/tmp", log: () => {} });
    for (const [index, name] of [[6, "moostafa"], [8, "moofie"]]) {
        console.execute("clear " + name + " " + game.key);
        const lines = console.execute("boss " + name + " spawn");
        assert.ok(lines.every(line => !line.startsWith("error:")), lines.join("\\n"));
        const natural = game.ais.filter(ai => ai.active && ai.index === index && !ai.despawnOnDeath);
        assert.equal(natural.length, 1);
        assert.deepEqual(natural[0].homeBounds, BOSS_CAVE.interior);
    }
});

test("body separation cannot push either player into cave stone", t => {
    const game = setup(t);
    const first = player(game, 1330, 3500), second = player(game, 1350, 3500);
    game.object_manager.checkCollision(first, second, 1);
    assertOutsideWalls(first);
    assertOutsideWalls(second);
    assert.ok(second.x <= 1365.001);
});

test("a legitimate spawn pad inside the cave preserves its respawn point", t => {
    const game = setup(t);
    const p = player(game, 2000, 3400);
    p.wood = p.stone = 1000;
    const pad = itemByName("spawn pad");
    p.buildItem(pad);
    const placed = game.game_objects.find(o => o.active && o.owner === p && o.spawnPoint);
    assert.ok(placed);
    const { x, y } = placed;
    p.spawn(false);
    assert.equal(p.x, x);
    assert.equal(p.y, y);
    assert.equal(placed.active, false);
    assertOutsideWalls(p);
});

test("arrows pass through the open entrance and still damage a target", t => {
    const game = setup(t);
    const owner = player(game, 2600, 5300), target = player(game, 2600, 4700);
    const arrow = game.projectile_manager.addProjectile(2600, 5250, -Math.PI / 2, 2000, 1.6, 0, owner, null, 0);
    for (let tick = 0; tick < 50 && arrow.active; tick++) arrow.update(16);
    assert.ok(target.health < 100);
    assert.equal(arrow.active, false);
});
