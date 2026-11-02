// PROJECTILES
// Acceptance coverage (briefing §6.2, §11 item 9):
//   - swept collision: a fast projectile cannot tunnel through a target in one tick;
//   - owner/team immunity, shield block, Blockades reduction;
//   - range exhaustion clamps the final position;
//   - structures: solid ones block the shot, only projDmg ones take damage,
//     ignoreCollision structures (platform/pit trap) are flown over;
//   - Turret Gear fires at the nearest valid target and respects Emp/team.

import test from "node:test";
import assert from "node:assert/strict";
import {
    makeGame, clearWorld, clearAnimals, addPlayer, place, placeObject,
    itemByName, hatById, accessoryById
} from "../../testing/harness.test.js";

const ARROW = 0; // items.projectiles[0]: dmg 25, speed 1.6, range 1000, layer 0

function setup(t) {
    const game = makeGame(t);
    clearWorld(game);
    clearAnimals(game);
    return game;
}

function fire(game, owner, indx = ARROW, x = 4000, y = 4000, dir = 0) {
    const proj = game.projectile_manager.addProjectile(x, y, dir, 1000, 1.6, indx, owner, null, 0);
    proj.update(0.001); // arm bookkeeping without moving
    proj.skipMov = true; // keep the standing-start sweep for the measured tick
    return proj;
}

test("no tunneling: one 800-unit tick is swept and hits a mid-path target", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const target = addPlayer(game, { name: "target" });
    place(target, 4700, 4000); // 700 units ahead, NOT overlapping the spawn point

    const proj = fire(game, owner);
    proj.update(500); // single long tick: point moves 0 (skipMov), sweep covers 800

    assert.equal(proj.x, 4000, "the projectile point never reached the target");
    assert.equal(target.health, 75, "the swept segment still hit: arrow dmg 25");
    assert.equal(proj.active, false, "projectile dies on impact");
    assert.ok(Math.abs(target.xVel - 0.3) < 1e-9, "impact knockback along the shot");
});

test("owner and teammates are never hit; the shot continues to the enemy", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const mate = addPlayer(game, { name: "mate" });
    const enemy = addPlayer(game, { name: "enemy" });
    owner.team = mate.team = "CLAN";
    place(owner, 4400, 4000);  // directly in the path
    place(mate, 4600, 4000);   // also in the path
    place(enemy, 4800, 4000);  // behind them

    const proj = fire(game, owner);
    proj.update(500);
    assert.equal(owner.health, 100, "owner immune");
    assert.equal(mate.health, 100, "teammate immune");
    assert.equal(enemy.health, 75, "nearest valid target hit");
    assert.equal(proj.active, false);
});

test("shield blocks projectile damage inside its angle, but not the knockback", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const target = addPlayer(game, { name: "target" });
    target.weaponIndex = 11; // wooden shield
    place(target, 4700, 4000);
    target.dir = Math.PI;    // facing the incoming arrow

    const proj = fire(game, owner);
    proj.update(500);
    assert.equal(target.health, 100, "shielded: no damage");
    assert.ok(target.xVel > 0, "shield still absorbs the knockback impulse");

    const proj2 = fire(game, owner);
    target.dir = 0; // turned away
    target.xVel = 0;
    proj2.update(500);
    assert.equal(target.health, 75, "unshielded angle takes full damage");
});

test("Blockades reduce projectile damage by 25%", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const target = addPlayer(game, { name: "target" });
    target.tail = accessoryById(15); // Blockades
    place(target, 4700, 4000);

    const proj = fire(game, owner);
    proj.update(500);
    assert.equal(target.health, 100 - 25 * 0.75, "projectile damage reduced");
});

test("range exhaustion deactivates the projectile at exactly its range", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    place(owner, 9000, 9000); // far away, not in the path

    const proj = fire(game, owner);
    proj.skipMov = false; // let it fly
    proj.update(2000);    // would travel 3200, range is 1000
    assert.equal(proj.active, false, "dead at max range");
    assert.ok(Math.abs(proj.x - 5000) < 1e-6 && Math.abs(proj.y - 4000) < 1e-6,
        `clamped at start + range (${proj.x}, ${proj.y})`);
});

test("projDmg structures take arrow damage and are destroyed; the owner slot is released", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const wallData = itemByName("wood wall"); // projDmg, health 380
    const wall = placeObject(game, wallData, 4300, 4000, 0, owner);
    owner.itemCounts[wallData.group.id] = 1;

    const proj = fire(game, owner);
    proj.update(500);
    assert.equal(wall.health, 380 - 25, "arrow damages the wall");
    assert.equal(proj.active, false, "arrow stops on the wall");

    let shots = 1;
    while (wall.active && shots < 30) {
        fire(game, owner).update(500);
        shots++;
    }
    assert.equal(wall.active, false, "wall destroyed after enough arrows");
    assert.equal(shots, Math.ceil(380 / 25), "destruction takes exactly ceil(health/dmg) arrows");
    assert.equal(owner.itemCounts[wallData.group.id], 0, "group slot released on destruction");
});

test("solid structures block the shot; only projDmg ones take damage", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    const wall = placeObject(game, itemByName("stone wall"), 4300, 4000, 0, owner); // no projDmg
    const enemy = addPlayer(game, { name: "enemy" });
    place(enemy, 4600, 4000);

    const proj = fire(game, owner);
    proj.update(500);
    assert.equal(proj.active, false, "arrow stopped by the stone wall");
    assert.equal(wall.health, 900, "non-projDmg structure takes no projectile damage");
    assert.equal(enemy.health, 100, "nothing passes through");
});

test("ignoreCollision structures (platform, pit trap) let arrows fly over", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    placeObject(game, itemByName("platform"), 4300, 4000, 0, owner);
    placeObject(game, itemByName("pit trap"), 4450, 4000, 0, owner);
    const enemy = addPlayer(game, { name: "enemy" });
    place(enemy, 4600, 4000);

    const proj = fire(game, owner);
    proj.update(500);
    assert.equal(enemy.health, 75, "arrow flies over platform and trap");
});

test("Turret Gear fires at the nearest valid enemy and respects rate/EMP/team", (t) => {
    const game = setup(t);
    const owner = addPlayer(game, { name: "owner" });
    owner.skin = hatById(53); // Turret Gear: proj 1, range 700, rate 2500
    place(owner, 5000, 5000);
    const near = addPlayer(game, { name: "near" });
    const far = addPlayer(game, { name: "far" });
    place(near, 5400, 5000);
    place(far, 5600, 5300); // farther than near

    const shots = () => game.projectiles.filter(p => p.active && p.owner === owner).length;
    owner.shootTurret();
    assert.equal(shots(), 1, "shot fired");
    assert.equal(owner.shootCount, 2500, "rate armed");
    const proj = game.projectiles.find(p => p.active && p.owner === owner);
    assert.ok(Math.abs(proj.dir) < 0.01, "aimed at the nearest enemy (east)");

    // no valid target
    const game2 = setup(t);
    const owner2 = addPlayer(game2, { name: "owner2" });
    owner2.skin = hatById(53);
    place(owner2, 5000, 5000);
    const emp = addPlayer(game2, { name: "emp" });
    emp.skin = { antiTurret: 1 };
    place(emp, 5400, 5000);
    owner2.shootTurret();
    assert.equal(game2.projectiles.filter(p => p.active).length, 0, "EMP Helmet target skipped");
    assert.equal(owner2.shootCount, 250, "idle re-check interval");

    const mate = addPlayer(game2, { name: "mate" });
    mate.team = owner2.team = "CLAN";
    place(mate, 5500, 5000);
    owner2.shootTurret();
    assert.equal(game2.projectiles.filter(p => p.active).length, 0, "teammate skipped");
});
