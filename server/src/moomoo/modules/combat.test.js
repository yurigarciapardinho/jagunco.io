// COMBAT / PROGRESSION / DEATH
// Acceptance coverage (briefing §6.1, §6.2, §11 items 8, 10, 11, 12, 16):
//   - melee range / arc / cooldown / damage / knockback / hit slow;
//   - shield angle; steal weapon;
//   - upgrade picks validate age/group/prerequisite server-side (packet "H");
//   - weapon variants: XP thresholds, damage, poison, lifesteal, members-only emerald;
//   - store: single charge, validation, equip, effect, kept after death (packet "c");
//   - kill rewards (age, goldSteal, kScrM, Skull/Troll/Super Cape), death and respawn;
//   - Shame anti-autoheal.

import test from "node:test";
import assert from "node:assert/strict";
import {
    makeGame, clearWorld, clearAnimals, addPlayer, place, makeCtx, attachAnticheat,
    itemByName, hatById, accessoryById, packetsOf, items, config
} from "../../testing/harness.test.js";
import { handlePacket } from "../../network/packets.js";

function setup(t) {
    const game = makeGame(t);
    clearWorld(game);
    clearAnimals(game);
    return game;
}

function duel(game) {
    const attacker = addPlayer(game, { name: "attacker" });
    const target = addPlayer(game, { name: "target" });
    place(attacker, 5000, 3000, 0);
    place(target, 5100, 3000); // in front, 100 away (hammer reaches 65 + 63)
    return { attacker, target };
}

// ---------------------------------------------------------------- melee

test("melee hit lands inside range and arc with exact damage and knockback", (t) => {
    const game = setup(t);
    const { attacker, target } = duel(game); // tool hammer: dmg 25

    attacker.gather();
    assert.equal(target.health, 75, "hammer deals its table damage");
    assert.ok(Math.abs(target.xVel - 0.3) < 1e-9, `knockback 0.3*weightM (got ${target.xVel})`);
    assert.ok(Math.abs(target.yVel) < 1e-9, "knockback along the hit direction only");
});

test("melee misses outside the arc and outside the range", (t) => {
    const game = setup(t);
    const { attacker, target } = duel(game);

    place(target, 4900, 3000); // behind the attacker
    attacker.gather();
    assert.equal(target.health, 100, "target behind the swing arc is not hit");

    place(target, 5200, 3000); // in front but 200 away (> 65 + 63)
    attacker.gather();
    assert.equal(target.health, 100, "target beyond weapon range is not hit");

    place(target, 5030, 3095); // diagonal inside range (37) but at ~72.5° (> gatherAngle ~69.3°)
    attacker.gather();
    assert.equal(target.health, 100, "diagonal outside gatherAngle is not hit");
});

test("attack cooldown: one swing per weapon speed, with hit slow applied", (t) => {
    const game = setup(t);
    const ctx = makeCtx(game);
    const { attacker, target } = duel(game);

    handlePacket(ctx, attacker, "F", [1, 0]); // real input path: mouse down aims east and queues a hit
    attacker.update(16);  // swing 1
    assert.equal(target.health, 75, "first swing lands");
    assert.ok(attacker.slowMult < 1, "attacking slows the attacker");
    assert.ok(attacker.reloads[0] > 0, "reload armed with the weapon speed");

    attacker.update(16);  // still reloading
    assert.equal(target.health, 75, "no second hit during cooldown");

    attacker.update(400); // hammer speed 300 -> the reload drains on this tick...
    assert.equal(target.health, 75, "the draining tick still does not swing");
    attacker.update(16);  // ...and the next tick swings
    assert.equal(target.health, 50, "second swing lands after the cooldown");
});

test("wooden shield blocks melee only inside its facing angle", (t) => {
    const game = setup(t);
    const { attacker, target } = duel(game);
    target.weaponIndex = 11; // wooden shield: shield 0.2
    target.dir = Math.PI;    // facing the attacker

    attacker.gather();
    assert.equal(target.health, 95, "shielded hit deals 25*0.2");

    target.dir = 0; // facing away
    attacker.gather();
    assert.equal(target.health, 70, "unshielded angle takes full damage");
});

test("mc grabby steals gold up to what the victim actually has", (t) => {
    const game = setup(t);
    const { attacker, target } = duel(game);
    attacker.weaponIndex = 14; // steal 250, dmg 0
    target.points = 100;
    const before = attacker.points;

    attacker.gather();
    assert.equal(target.points, 0, "steal is capped by the victim's gold");
    assert.equal(attacker.points, before + 100, "stolen gold lands on the attacker");
    assert.equal(target.health, 100, "mc grabby deals no damage");
});

// ---------------------------------------------------------------- progression

test("earnXP levels age, grants upgrade points and stops at maxAge", (t) => {
    const game = setup(t);
    const player = addPlayer(game);

    player.earnXP(300); // maxXP 300
    assert.equal(player.age, 2, "age up at maxXP");
    assert.equal(player.XP, 0, "XP resets on age up");
    assert.equal(player.maxXP, 360, "maxXP scales by 1.2");
    assert.equal(player.upgradePoints, 1, "one upgrade point per age");
    assert.ok(packetsOf(player, "U").length >= 1, "client notified of the upgrade point");
    assert.ok(packetsOf(player, "T").length >= 1, "client notified of the age");

    player.age = config.maxAge;
    player.XP = 0;
    player.earnXP(500);
    assert.equal(player.XP, 0, "no XP past maxAge");
    assert.equal(player.age, config.maxAge);
});

test("upgrade packet validates age and prerequisite server-side", (t) => {
    const game = setup(t);
    const ctx = makeCtx(game);

    // wrong age is silently rejected
    const p1 = addPlayer(game, { name: "p1" });
    attachAnticheat(p1);
    p1.upgradePoints = 1;
    p1.upgrAge = 2;
    handlePacket(ctx, p1, "H", [2]); // great axe: age 8
    assert.equal(p1.weapons[0], 0, "weapon of a different age is not granted");
    assert.equal(p1.upgradePoints, 1, "rejected pick keeps the point");
    assert.equal(p1.anticheat.strikes, 0, "a legal-but-locked pick is not an anticheat strike");

    // correct age grants and advances the tree
    handlePacket(ctx, p1, "H", [3]); // short sword: age 2
    assert.equal(p1.weapons[0], 3, "short sword granted");
    assert.equal(p1.weaponIndex, 3, "active slot follows the upgrade");
    assert.equal(p1.upgradePoints, 0);
    assert.equal(p1.upgrAge, 3, "next age of the tree");

    // prerequisite: katana (age 8, pre short sword)
    const p2 = addPlayer(game, { name: "p2" });
    p2.upgradePoints = 1;
    p2.upgrAge = 8;
    handlePacket(ctx, p2, "H", [4]);
    assert.equal(p2.weapons[0], 0, "katana requires the short sword first");
    p2.weapons[0] = 3;
    handlePacket(ctx, p2, "H", [4]);
    assert.equal(p2.weapons[0], 4, "katana granted once the prerequisite is owned");

    // item picks replace within the same group
    const p3 = addPlayer(game, { name: "p3" });
    p3.upgradePoints = 1;
    p3.upgrAge = 3;
    handlePacket(ctx, p3, "H", [items.weapons.length + 1]); // cookie (age 3, food group)
    assert.equal(p3.items[0], 1, "cookie replaces the apple in the food group");
    assert.equal(p3.items.length, 4, "no duplicate group entry");

    // non-integer index is an anticheat strike
    const p4 = addPlayer(game, { name: "p4" });
    const ac = attachAnticheat(p4);
    p4.upgradePoints = 1;
    handlePacket(ctx, p4, "H", [2.5]);
    assert.ok(ac.strikes > 0, "malformed upgrade index is punished");

    // no points -> nothing happens
    const p5 = addPlayer(game, { name: "p5" });
    p5.upgradePoints = 0;
    handlePacket(ctx, p5, "H", [3]);
    assert.equal(p5.weapons[0], 0, "no upgrade without points");
});

test("weapon variants: XP thresholds, damage multiplier, poison, members-only emerald", (t) => {
    const game = setup(t);
    const { attacker, target } = duel(game);

    // thresholds on the real table
    attacker.weaponXP[0] = 2999;
    assert.equal(attacker.variant().id, 0, "below 3000 XP: base variant");
    attacker.weaponXP[0] = 3000;
    assert.equal(attacker.variant().id, 1, "gold at 3000 XP");
    attacker.weaponXP[0] = 7000;
    assert.equal(attacker.variant().id, 2, "diamond at 7000 XP");
    attacker.weaponXP[0] = 12000;
    assert.equal(attacker.variant().id, 3, "ruby at 12000 XP");

    // gold damage is measured, not just unlocked
    attacker.weaponXP[0] = 3000;
    attacker.gather();
    assert.equal(target.health, 72.5, "gold variant deals 25*1.1");

    // ruby poisons (5 x 5 ticks)
    target.health = 100;
    target.xVel = 0;
    attacker.weaponXP[0] = 12000;
    attacker.gather();
    assert.equal(target.health, 70.5, "ruby deals 25*1.18");
    assert.equal(target.dmgOverTime.dmg, 5, "ruby applies poison");
    assert.equal(target.dmgOverTime.time, 5, "poison duration");
    place(target, 9000, 9000);
    target.update(1000);
    assert.equal(target.health, 65.5, "poison tick measured");

    // emerald is members-only: guests fall back to ruby, members get lifesteal
    attacker.weaponXP[0] = 30000;
    attacker.isMember = false;
    assert.equal(attacker.variant().id, 3, "guest with 30000 XP stays at ruby");
    attacker.isMember = true;
    assert.equal(attacker.variant().id, 4, "member reaches emerald");

    attacker.health = 50;
    target.health = 100;
    place(target, 5100, 3000);
    attacker.gather();
    assert.equal(target.health, 70.5, "emerald deals 25*1.18");
    assert.ok(Math.abs(attacker.health - (50 + 25 * 1.18 * 0.15)) < 1e-9, "emerald lifesteal heals 15% of damage");
});

// ---------------------------------------------------------------- store

test("store: buy charges once, validates funds, equips, effect applies, kept after death", (t) => {
    const game = setup(t);
    const ctx = makeCtx(game);
    const player = addPlayer(game);

    player.points = 500;
    handlePacket(ctx, player, "c", [1, 2, 0]); // Straw Hat, 500 gold
    assert.equal(player.points, 0, "price charged");
    assert.equal(player.skins[2], 1, "hat owned");

    handlePacket(ctx, player, "c", [1, 2, 0]); // buying again
    assert.equal(player.points, 0, "second buy is free (already owned)");

    player.points = 100;
    handlePacket(ctx, player, "c", [1, 27, 0]); // Scavenger Gear, 15000
    assert.equal(player.points, 100, "unaffordable hat rejected");
    assert.equal(player.skins[27], undefined);

    handlePacket(ctx, player, "c", [1, 45, 0]); // Shame! is dontSell
    assert.equal(player.skins[45], undefined, "dontSell hat cannot be bought");

    handlePacket(ctx, player, "c", [0, 2, 0]); // equip
    assert.equal(player.skinIndex, 2, "equipped index");
    assert.equal(player.skin.id, 2, "equipped object");

    // effect of an equipped hat is measured (Soldier Helmet: dmgMult 0.75)
    player.points = 4000;
    handlePacket(ctx, player, "c", [1, 6, 0]);
    handlePacket(ctx, player, "c", [0, 6, 0]);
    player.changeHealth(-25, null);
    assert.equal(player.health, 100 - 25 * 0.75, "Soldier Helmet reduces damage taken");

    handlePacket(ctx, player, "c", [0, 0, 0]); // unequip
    assert.equal(player.skin, null, "unequip clears the hat");

    // possession and equipment survive death (spawn keeps skins/skin)
    handlePacket(ctx, player, "c", [0, 6, 0]);
    player.changeHealth(-9999, null);
    assert.equal(player.alive, false);
    player.spawn(true);
    assert.equal(player.skins[6], 1, "bought hat kept after death");
    assert.equal(player.skin && player.skin.id, 6, "hat still equipped after respawn");
});

// ---------------------------------------------------------------- death & rewards

test("kill pays age*100, increments kills, kills the victim and notifies", (t) => {
    const game = setup(t);
    const killer = addPlayer(game, { name: "killer" });
    const victim = addPlayer(game, { name: "victim" });
    victim.age = 5;
    const points0 = killer.points;

    victim.changeHealth(-9999, killer);
    assert.equal(victim.alive, false, "victim died");
    assert.equal(killer.kills, 1, "kill counted");
    assert.equal(killer.points, points0 + 500, "reward is victim age * 100");
    assert.ok(packetsOf(victim, "P").length === 1, "death packet sent to the victim");

    victim.spawn(true); // respawn
    assert.equal(victim.alive, true);
    assert.equal(victim.health, 100, "respawn at full health");
    assert.equal(victim.age, 1, "age resets on respawn");
    assert.equal(victim.wood, 100, "moofoll resources restored");
});

test("kill reward modifiers: Thief Gear, Scavenger, Skull Cape, Troll Cape", (t) => {
    const game = setup(t);
    const killer = addPlayer(game, { name: "killer" });
    const victim = addPlayer(game, { name: "victim" });
    victim.age = 5;

    killer.skin = hatById(52); // Thief Gear: steal half the victim's gold
    victim.points = 1000;
    const p0 = killer.points;
    victim.kill(killer);
    assert.equal(killer.points - p0, 500, "goldSteal pays half the victim's gold");

    killer.skin = hatById(27); // Scavenger Gear: 2x kill score
    victim.alive = true;
    victim.health = 100;
    const p1 = killer.points;
    victim.kill(killer);
    assert.equal(killer.points - p1, 1000, "kScrM doubles the age reward");

    killer.skin = null;
    killer.tail = accessoryById(4); // Skull Cape: 3x for killing the kill leader
    victim.iconIndex = 1;
    victim.alive = true;
    const p2 = killer.points;
    victim.kill(killer);
    assert.equal(killer.points - p2, 1500, "skull cape triples the kill-leader bounty");

    killer.tail = accessoryById(7); // Troll Cape: 2x for spike kills
    victim.iconIndex = 0;
    victim.alive = true;
    const p3 = killer.points;
    victim.kill(killer, { group: { name: "spikes" } }, null);
    assert.equal(killer.points - p3, 1000, "troll cape doubles spike kills");
});

test("Super Cape: after a kill, +5% damage for the buff window", (t) => {
    const game = setup(t);
    const killer = addPlayer(game, { name: "killer" });
    const victim = addPlayer(game, { name: "victim" });
    const bystander = addPlayer(game, { name: "bystander" });
    place(killer, 5000, 3000, 0);
    place(bystander, 5100, 3000);
    killer.tail = accessoryById(1); // Super Cape

    victim.changeHealth(-9999, killer);
    assert.ok(killer.superUntil > Date.now(), "super window armed by the kill");

    killer.gather();
    assert.ok(Math.abs(bystander.health - (100 - 25 * 1.05)) < 1e-9, "super cape damage bonus measured");
});

test("Shame: instant heal spam within 120 ms of damage triggers the 30 s Shame! state", (t) => {
    const game = setup(t);
    const player = addPlayer(game);
    player.health = 50;
    const apple = itemByName("apple");

    for (let i = 0; i < 8; i++) {
        player.hitTime = Date.now(); // simulate being hit right before eating
        player.buildItem(apple);
    }
    assert.equal(player.shameTimer, 30000, "8 fast heals arm the shame timer");
    assert.equal(player.displaySkin(), 45, "Shame! hat overrides the displayed hat");

    player.health = 50;
    player.hitTime = 0; // calm heal, but still shamed
    player.buildItem(apple);
    assert.equal(player.health, 50, "healing is blocked while shamed");

    player.update(31000); // shame decays in the update loop
    assert.equal(player.shameTimer, 0, "shame expires");
    player.buildItem(apple);
    assert.equal(player.health, 70, "healing works again afterwards");
});
