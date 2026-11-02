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

  it("applies upgrades and consumes a real upgrade point", () => {
    const world = new World(42);
    const p = joined(world);
    p.upgradePoints = 1;
    world.upgrade(p.id, "damage");
    world.upgrade(p.id, "damage");
    expect(p.damageMult).toBeCloseTo(1.15);
    expect(p.upgradePoints).toBe(0);
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
});
