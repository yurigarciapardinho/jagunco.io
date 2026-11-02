import { describe, expect, it } from "vitest";
import { BUILDINGS, type InputState } from "../../contracts/game";
import { World, type ServerPlayer } from "./world";

function input(seq: number, patch: Partial<InputState> = {}): InputState {
  return { seq, mx: 0, my: 0, aim: 0, attack: false, build: 0, weapon: 0, heal: false, ...patch };
}

function joined(world: World, name = "Teste"): ServerPlayer {
  const player = world.join(name);
  if (!player) throw new Error("Room unexpectedly full");
  return player;
}

describe("World authoritative rules", () => {
  it("charges costs and places a building only once per input sequence", () => {
    const world = new World(42);
    const p = joined(world);
    p.wood = 100;
    p.stone = 100;
    world.setInput(p.id, input(1, { build: 1 }));
    world.step();
    world.step();
    const walls = [...world.objects.values()].filter((o) => o.kind === "wall" && o.owner === p.id);
    expect(walls).toHaveLength(1);
    expect(p.wood).toBe(100 - BUILDINGS[1].cost.wood);
    expect(p.stone).toBe(100 - BUILDINGS[1].cost.stone);
    expect(walls[0].hp).toBe(BUILDINGS[1].hp);
  });

  it("offers a level-two branch and unlocks only the chosen weapon", () => {
    const world = new World(42);
    const p = joined(world);
    p.level = 2;
    p.upgradePoints = 1;
    world.upgrade(p.id, "slingshot");
    expect(p.upgradePoints).toBe(1);
    world.upgrade(p.id, "spear");
    world.upgrade(p.id, "spear");
    expect(p.unlockedWeapons).toEqual([0, 1]);
    expect(p.upgradePoints).toBe(0);
    world.setInput(p.id, input(1, { weapon: 1 }));
    expect(p.weapon).toBe(1);
  });

  it("consumes food and restores health with a cooldown", () => {
    const world = new World(42);
    const p = joined(world);
    p.hp = 50;
    p.food = 20;
    world.setInput(p.id, input(1, { heal: true }));
    world.step();
    world.step();
    expect(p.hp).toBe(85);
    expect(p.food).toBe(10);
  });

  it("unlocks the ranged weapon by level and creates a server projectile", () => {
    const world = new World(42);
    const p = joined(world);
    p.level = 3;
    p.upgradePoints = 1;
    world.upgrade(p.id, "slingshot");
    world.setInput(p.id, input(1, { weapon: 2, attack: true }));
    world.step();
    expect(p.weapon).toBe(2);
    expect(world.projectiles.size).toBe(1);
    expect([...world.projectiles.values()][0].owner).toBe(p.id);
  });

  it("awards a PvP kill and respawns the defeated player", () => {
    const world = new World(42);
    const attacker = joined(world, "Atacante");
    const target = joined(world, "Alvo");
    attacker.x = 3200;
    attacker.y = 3200;
    target.x = 3250;
    target.y = 3200;
    world.setInput(attacker.id, input(1, { attack: true, aim: 0 }));
    for (let i = 0; i < 90 && target.alive; i++) world.step();
    expect(target.alive).toBe(false);
    expect(attacker.kills).toBe(1);
    expect(attacker.score).toBeGreaterThan(0);
    world.respawn(target.id);
    expect(target.alive).toBe(true);
    expect(target.hp).toBe(target.maxHp);
    target.x = 3250;
    target.y = 3200;
    attacker.x = 3200;
    attacker.y = 3200;
    world.setInput(attacker.id, input(attacker.input.seq + 1, { attack: false, aim: 0 }));
    world.step();
    attacker.cooldown = 0;
    world.setInput(attacker.id, input(attacker.input.seq + 1, { attack: true, aim: 0 }));
    world.step();
    expect(target.hp).toBe(target.maxHp);
  });


  it("charges gold once, equips the purchase and applies its real bonus", () => {
    const world = new World(42);
    const p = joined(world);
    world.buy(p.id, "strawHat");
    expect(p.ownedItems).toHaveLength(0);
    p.gold = 100;
    world.buy(p.id, "strawHat");
    expect(p.gold).toBe(0);
    expect(p.equippedHat).toBe("strawHat");
    expect(world.privateNet(p).gatherMult).toBeCloseTo(1.2);
    world.buy(p.id, "strawHat");
    expect(p.gold).toBe(0);
    p.gold = 180;
    world.buy(p.id, "boots");
    expect(p.equippedAccessory).toBe("boots");
    expect(world.privateNet(p).speedMult).toBeCloseTo(1.12);
    expect(p.gold).toBe(0);
  });

  it("keeps unlocks and owned equipment through respawn", () => {
    const world = new World(42);
    const p = joined(world);
    p.level = 2;
    p.upgradePoints = 1;
    world.upgrade(p.id, "spear");
    p.gold = 250;
    world.buy(p.id, "leatherHat");
    p.alive = false;
    world.respawn(p.id);
    expect(p.unlockedWeapons).toContain(1);
    expect(p.ownedItems).toContain("leatherHat");
    expect(p.equippedHat).toBe("leatherHat");
    expect(p.maxHp).toBe(128);
  });
  it("sends static objects once per spectator and removes them outside AOI", () => {
    const world = new World(42);
    const p = joined(world);
    const known = new Map<number, number>();
    const first = world.snapshot(p.id, known);
    expect(first.objects.length).toBeGreaterThan(0);
    const second = world.snapshot(p.id, known);
    expect(second.objects).toHaveLength(0);
    p.x = 50;
    p.y = 50;
    world.step();
    const moved = world.snapshot(p.id, known);
    expect(moved.removedObjects.length).toBeGreaterThan(0);
  });

  it("does not make an unhurt goat flee just because a player is nearby", () => {
    const world = new World(42);
    const p = joined(world);
    const goat = [...world.animals.values()].find((animal) => animal.kind === "goat")!;
    goat.x = p.x + 100;
    goat.y = p.y;
    goat.think = 10;
    goat.targetX = goat.x;
    goat.targetY = goat.y;
    for (let i = 0; i < 30; i++) world.step();
    expect(goat.aggro).toBe(0);
    expect(goat.state).not.toBe(2);
    expect(goat.hp).toBe(goat.maxHp);
  });

  it("makes a struck goat flee away from its attacker for a limited window", () => {
    const world = new World(42);
    const p = joined(world);
    const goat = [...world.animals.values()].find((animal) => animal.kind === "goat")!;
    p.x = goat.x - 70;
    p.y = goat.y;
    const before = Math.hypot(goat.x - p.x, goat.y - p.y);
    world.setInput(p.id, input(1, { attack: true, aim: 0 }));
    world.step();
    expect(goat.hp).toBeLessThan(goat.maxHp);
    expect(goat.aggro).toBeGreaterThan(0);
    world.setInput(p.id, input(2));
    for (let i = 0; i < 30; i++) world.step();
    const after = Math.hypot(goat.x - p.x, goat.y - p.y);
    expect(after).toBeGreaterThan(before + 60);
    for (let i = 0; i < 35; i++) world.step();
    expect(goat.aggro).toBe(0);
  });

  it("makes enemy spikes solid, damaging and knock the player away", () => {
    const world = new World(42);
    const owner = joined(world, "Dono");
    const target = joined(world, "Alvo");
    const spike = {
      id: 90000, kind: "spike" as const, x: target.x + 45, y: target.y,
      r: 38, hp: 180, maxHp: 180, owner: owner.id, flash: 0,
      version: 2, natural: false, respawnAt: 0,
    };
    world.objects.set(spike.id, spike);
    world.objectGrid.insert(spike);
    const startX = target.x;
    world.setInput(target.id, input(1, { mx: 1 }));
    world.step();
    expect(target.hp).toBe(target.maxHp - 20);
    expect(target.x).toBeLessThan(startX - 50);
    expect(target.x).toBeLessThan(spike.x - 60);
    world.step();
    expect(target.hp).toBe(target.maxHp - 20);
  });

  it("makes a nearby boar pursue and injure the player", () => {
    const world = new World(42);
    const p = joined(world);
    const boar = [...world.animals.values()].find((animal) => animal.kind === "boar")!;
    p.x = 3200;
    p.y = 3200;
    boar.x = 3500;
    boar.y = 3200;
    const before = Math.hypot(boar.x - p.x, boar.y - p.y);
    for (let i = 0; i < 75; i++) world.step();
    const after = Math.hypot(boar.x - p.x, boar.y - p.y);
    expect(after).toBeLessThan(before - 100);
    expect(p.hp).toBeLessThan(p.maxHp);
  });
});
