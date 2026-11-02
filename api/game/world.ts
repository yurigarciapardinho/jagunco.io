import {
  AOI_X,
  AOI_Y,
  BUILDINGS,
  MAP_SIZE,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  SNAPSHOT_EVERY,
  TICK_RATE,
  WEAPONS,
  UPGRADES,
  shopItem,
  upgradeChoices,
  angleDelta,
  clamp,
  xpForLevel,
  type AnimalKind,
  type AnimalNet,
  type GameEvent,
  type InputState,
  type LeaderNet,
  type ObjectKind,
  type ObjectNet,
  type PlayerNet,
  type PrivateNet,
  type ProjectileNet,
  type ResourceKind,
  type ShopItemId,
  type UpgradeId,
} from "../../contracts/game";

const DT = 1 / TICK_RATE;
const CENTER = MAP_SIZE / 2;
const MAX_PLAYERS = 40;

export interface ServerPlayer extends PlayerNet {
  input: InputState;
  wood: number;
  food: number;
  stone: number;
  gold: number;
  xp: number;
  nextXp: number;
  upgradePoints: number;
  damageMult: number;
  speedMult: number;
  gatherMult: number;
  unlockedWeapons: number[];
  upgrades: UpgradeId[];
  ownedItems: ShopItemId[];
  cooldown: number;
  healCooldown: number;
  spikeCooldown: number;
  spawnShield: number;
  buildSeq: number;
  privateDirty: boolean;
  events: GameEvent[];
}

interface ServerObject extends ObjectNet {
  version: number;
  natural: boolean;
  respawnAt: number;
}

interface ServerAnimal extends AnimalNet {
  think: number;
  targetX: number;
  targetY: number;
  cooldown: number;
  aggro: number;
}

interface ServerProjectile extends ProjectileNet {
  vx: number;
  vy: number;
  life: number;
  damage: number;
}

interface Point {
  x: number;
  y: number;
}

export class SpatialHash<T extends Point> {
  private cells = new Map<string, T[]>();

  constructor(private readonly cellSize = 320) {}

  clear(): void {
    this.cells.clear();
  }

  insert(item: T): void {
    const key = this.key(Math.floor(item.x / this.cellSize), Math.floor(item.y / this.cellSize));
    const cell = this.cells.get(key);
    if (cell) cell.push(item);
    else this.cells.set(key, [item]);
  }

  query(x: number, y: number, rx: number, ry = rx): T[] {
    const out: T[] = [];
    const x0 = Math.floor((x - rx) / this.cellSize);
    const x1 = Math.floor((x + rx) / this.cellSize);
    const y0 = Math.floor((y - ry) / this.cellSize);
    const y1 = Math.floor((y + ry) / this.cellSize);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = this.cells.get(this.key(cx, cy));
        if (cell) out.push(...cell);
      }
    }
    return out;
  }

  private key(x: number, y: number): string {
    return `${x},${y}`;
  }
}

export interface Snapshot {
  tick: number;
  ack: number;
  players: PlayerNet[];
  objects: ObjectNet[];
  animals: AnimalNet[];
  projectiles: ProjectileNet[];
  removedObjects: number[];
  hiddenPlayers: number[];
  hiddenAnimals: number[];
}

function defaultInput(): InputState {
  return { seq: 0, mx: 0, my: 0, aim: 0, attack: false, build: 0, weapon: 0, heal: false };
}

function cleanName(value: string): string {
  const cleaned = value.replace(/[\x00-\x1f\x7f<>]/g, "").trim().slice(0, 16);
  return cleaned || "Jagunço";
}

function q(value: number): number {
  return Math.round(value * 10) / 10;
}

function dist2(a: Point, b: Point): number {
  const x = a.x - b.x;
  const y = a.y - b.y;
  return x * x + y * y;
}

export class World {
  readonly seed: number;
  readonly players = new Map<number, ServerPlayer>();
  readonly objects = new Map<number, ServerObject>();
  readonly animals = new Map<number, ServerAnimal>();
  readonly projectiles = new Map<number, ServerProjectile>();
  readonly objectGrid = new SpatialHash<ServerObject>(320);
  readonly playerGrid = new SpatialHash<ServerPlayer>(320);
  readonly animalGrid = new SpatialHash<ServerAnimal>(320);
  tick = 0;
  private nextId = 1;
  private random: () => number;
  private events: GameEvent[] = [];
  private knownPlayers = new Map<number, Set<number>>();
  private knownAnimals = new Map<number, Set<number>>();

  constructor(seed = 0x4a414755) {
    this.seed = seed >>> 0;
    let state = this.seed || 1;
    this.random = () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.generate();
  }

  get full(): boolean {
    return this.players.size >= MAX_PLAYERS;
  }

  get online(): number {
    return this.players.size;
  }

  join(name: string): ServerPlayer | null {
    if (this.full) return null;
    const id = this.nextId++;
    const spawn = this.findSpawn();
    const player: ServerPlayer = {
      id,
      name: cleanName(name),
      x: spawn.x,
      y: spawn.y,
      aim: 0,
      hp: 100,
      maxHp: 100,
      weapon: 0,
      level: 1,
      score: 0,
      kills: 0,
      alive: true,
      swing: 0,
      flash: 0,
      input: defaultInput(),
      wood: 0,
      food: 20,
      stone: 0,
      gold: 0,
      xp: 0,
      nextXp: xpForLevel(1),
      upgradePoints: 0,
      damageMult: 1,
      speedMult: 1,
      gatherMult: 1,
      unlockedWeapons: [0],
      upgrades: [],
      ownedItems: [],
      equippedHat: null,
      equippedAccessory: null,
      cooldown: 0,
      healCooldown: 0,
      spikeCooldown: 0,
      spawnShield: 0,
      buildSeq: -1,
      privateDirty: true,
      events: [],
    };
    this.players.set(id, player);
    this.knownPlayers.set(id, new Set());
    this.knownAnimals.set(id, new Set());
    this.rebuildDynamicGrids();
    return player;
  }

  leave(id: number): void {
    this.players.delete(id);
    this.knownPlayers.delete(id);
    this.knownAnimals.delete(id);
    for (const projectile of this.projectiles.values()) {
      if (projectile.owner === id) this.projectiles.delete(projectile.id);
    }
    this.rebuildDynamicGrids();
  }

  setInput(id: number, input: InputState): void {
    const player = this.players.get(id);
    if (!player || !player.alive || input.seq <= player.input.seq || input.seq > player.input.seq + 120) return;
    const previousWeapon = player.input.weapon;
    player.input = {
      seq: Math.floor(input.seq),
      mx: clamp(Number.isFinite(input.mx) ? input.mx : 0, -1, 1),
      my: clamp(Number.isFinite(input.my) ? input.my : 0, -1, 1),
      aim: Number.isFinite(input.aim) ? input.aim : player.aim,
      attack: input.attack === true,
      build: Number.isInteger(input.build) ? clamp(input.build, 0, BUILDINGS.length - 1) : 0,
      weapon: Number.isInteger(input.weapon) ? clamp(input.weapon, 0, WEAPONS.length - 1) : previousWeapon,
      heal: input.heal === true,
    };
    if (player.input.weapon !== previousWeapon && player.unlockedWeapons.includes(player.input.weapon)) {
      player.weapon = player.input.weapon;
    }
  }

  upgrade(id: number, kind: UpgradeId): void {
    const p = this.players.get(id);
    if (!p || !p.alive || p.upgradePoints < 1 || !upgradeChoices(p.level).includes(kind)) return;
    if ((kind === "spear" || kind === "slingshot") && p.upgrades.includes(kind)) return;
    const capped = (kind === "damage" && p.damageMult >= 1.6)
      || (kind === "speed" && p.speedMult >= 1.45)
      || (kind === "gather" && p.gatherMult >= 1.75)
      || (kind === "vitality" && p.upgrades.includes("vitality"));
    if (capped) return;
    p.upgradePoints--;
    p.upgrades.push(kind);
    if (kind === "spear") p.unlockedWeapons.push(1);
    else if (kind === "slingshot") p.unlockedWeapons.push(2);
    else if (kind === "damage") p.damageMult = Math.min(1.6, p.damageMult + 0.15);
    else if (kind === "speed") p.speedMult = Math.min(1.45, p.speedMult + 0.1);
    else if (kind === "gather") p.gatherMult = Math.min(1.75, p.gatherMult + 0.2);
    else if (kind === "vitality") this.recalculateMaxHp(p);
    p.privateDirty = true;
    p.events.push({ t: "notice", text: `${UPGRADES[kind].name}: escolha aplicada.` });
  }

  buy(id: number, itemId: ShopItemId): void {
    const p = this.players.get(id);
    const item = shopItem(itemId);
    if (!p || !p.alive || !item) return;
    if (p.ownedItems.includes(itemId)) {
      this.equip(id, itemId);
      return;
    }
    if (p.gold < item.price) {
      p.events.push({ t: "notice", text: `Faltam ${item.price - Math.floor(p.gold)} de ouro para ${item.name}.` });
      return;
    }
    p.gold -= item.price;
    p.ownedItems.push(itemId);
    this.equip(id, itemId);
    p.events.push({ t: "notice", text: `${item.name} comprado e equipado.` });
  }

  equip(id: number, itemId: ShopItemId): void {
    const p = this.players.get(id);
    const item = shopItem(itemId);
    if (!p || !p.alive || !item || !p.ownedItems.includes(itemId)) return;
    if (item.slot === "hat") p.equippedHat = itemId;
    else p.equippedAccessory = itemId;
    this.recalculateMaxHp(p);
    p.privateDirty = true;
  }

  respawn(id: number): void {
    const p = this.players.get(id);
    if (!p || p.alive) return;
    const spawn = this.findSpawn();
    p.x = spawn.x;
    p.y = spawn.y;
    this.recalculateMaxHp(p);
    p.hp = p.maxHp;
    p.alive = true;
    p.input = defaultInput();
    p.cooldown = 0;
    p.healCooldown = 0;
    p.spawnShield = 2.5;
    p.wood = Math.floor(p.wood * 0.65);
    p.food = Math.max(20, Math.floor(p.food * 0.65));
    p.stone = Math.floor(p.stone * 0.65);
    p.gold = Math.floor(p.gold * 0.65);
    p.privateDirty = true;
    p.events.push({ t: "notice", text: "De volta ao sertão com proteção breve. Reúna recursos e monte sua defesa." });
    this.rebuildDynamicGrids();
  }

  privateNet(p: ServerPlayer): PrivateNet {
    return {
      wood: Math.floor(p.wood), food: Math.floor(p.food), stone: Math.floor(p.stone), gold: Math.floor(p.gold),
      xp: Math.floor(p.xp), nextXp: p.nextXp, level: p.level, upgradePoints: p.upgradePoints,
      damageMult: this.statMultiplier(p, "damage"), speedMult: this.statMultiplier(p, "speed"),
      gatherMult: this.statMultiplier(p, "gather"), unlockedWeapons: [...p.unlockedWeapons],
      upgrades: [...p.upgrades], ownedItems: [...p.ownedItems],
      equippedHat: p.equippedHat, equippedAccessory: p.equippedAccessory,
    };
  }

  leaderboard(): LeaderNet[] {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score || b.kills - a.kills)
      .slice(0, 8)
      .map((p) => ({ id: p.id, name: p.name, score: Math.floor(p.score), kills: p.kills }));
  }

  drainEvents(id: number): GameEvent[] {
    const p = this.players.get(id);
    if (!p) return [];
    const nearby = this.events.filter((event) => {
      if (event.t === "death" || event.t === "level" || event.t === "notice") return true;
      return Math.abs(event.x - p.x) <= AOI_X && Math.abs(event.y - p.y) <= AOI_Y;
    });
    const own = p.events.splice(0);
    return own.concat(nearby);
  }

  step(): void {
    this.tick++;
    this.events = [];
    for (const p of this.players.values()) {
      p.swing = Math.max(0, p.swing - DT * 4.5);
      p.flash = Math.max(0, p.flash - DT * 6);
      p.cooldown = Math.max(0, p.cooldown - DT);
      p.healCooldown = Math.max(0, p.healCooldown - DT);
      p.spikeCooldown = Math.max(0, p.spikeCooldown - DT);
      p.spawnShield = Math.max(0, p.spawnShield - DT);
      if (!p.alive) continue;
      const regen = p.equippedAccessory ? shopItem(p.equippedAccessory)?.regen ?? 0 : 0;
      if (regen && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + regen * DT);
      this.movePlayer(p);
      this.useBuilding(p);
      if (p.input.attack && p.cooldown <= 0) this.attack(p);
      if (p.input.heal && p.healCooldown <= 0) this.heal(p);
    }
    this.stepAnimals();
    this.stepProjectiles();
    this.stepObjects();
    this.rebuildDynamicGrids();
  }

  snapshot(id: number, knownObjects: Map<number, number>): Snapshot {
    const p = this.players.get(id);
    if (!p) throw new Error("Player not found");
    const visiblePlayers = this.playerGrid.query(p.x, p.y, AOI_X, AOI_Y)
      .filter((other) => Math.abs(other.x - p.x) <= AOI_X && Math.abs(other.y - p.y) <= AOI_Y);
    const visibleAnimals = this.animalGrid.query(p.x, p.y, AOI_X, AOI_Y)
      .filter((animal) => Math.abs(animal.x - p.x) <= AOI_X && Math.abs(animal.y - p.y) <= AOI_Y);
    const visibleObjects = this.objectGrid.query(p.x, p.y, AOI_X + 100, AOI_Y + 100)
      .filter((object) => object.hp > 0 && Math.abs(object.x - p.x) <= AOI_X + 100 && Math.abs(object.y - p.y) <= AOI_Y + 100);
    const visibleProjectiles = [...this.projectiles.values()]
      .filter((projectile) => Math.abs(projectile.x - p.x) <= AOI_X && Math.abs(projectile.y - p.y) <= AOI_Y);

    const knownP = this.knownPlayers.get(id)!;
    const knownA = this.knownAnimals.get(id)!;
    const nextP = new Set(visiblePlayers.map((other) => other.id));
    const nextA = new Set(visibleAnimals.map((animal) => animal.id));
    const hiddenPlayers = [...knownP].filter((other) => !nextP.has(other));
    const hiddenAnimals = [...knownA].filter((animal) => !nextA.has(animal));
    this.knownPlayers.set(id, nextP);
    this.knownAnimals.set(id, nextA);

    const nextO = new Set(visibleObjects.map((object) => object.id));
    const removedObjects = [...knownObjects.keys()].filter((object) => !nextO.has(object));
    const objects = visibleObjects.filter((object) => knownObjects.get(object.id) !== object.version).map((object) => ({
      id: object.id, kind: object.kind, x: q(object.x), y: q(object.y), r: object.r,
      hp: Math.ceil(object.hp), maxHp: object.maxHp, owner: object.owner, flash: object.flash,
    }));
    for (const object of visibleObjects) {
      if (knownObjects.get(object.id) !== object.version) knownObjects.set(object.id, object.version);
    }
    for (const object of removedObjects) knownObjects.delete(object);

    return {
      tick: this.tick,
      ack: p.input.seq,
      players: visiblePlayers.map((other) => ({
        id: other.id, name: other.name, x: q(other.x), y: q(other.y), aim: other.aim,
        hp: Math.ceil(other.hp), maxHp: other.maxHp, weapon: other.weapon, level: other.level,
        score: Math.floor(other.score), kills: other.kills, alive: other.alive,
        swing: other.swing, flash: other.flash,
        equippedHat: other.equippedHat, equippedAccessory: other.equippedAccessory,
      })),
      objects,
      animals: visibleAnimals.map((animal) => ({
        id: animal.id, kind: animal.kind, x: q(animal.x), y: q(animal.y), aim: animal.aim,
        hp: Math.ceil(animal.hp), maxHp: animal.maxHp, state: animal.state, flash: animal.flash,
      })),
      projectiles: visibleProjectiles.map((projectile) => ({
        id: projectile.id, x: q(projectile.x), y: q(projectile.y), aim: projectile.aim, owner: projectile.owner,
      })),
      removedObjects,
      hiddenPlayers,
      hiddenAnimals,
    };
  }

  private movePlayer(p: ServerPlayer): void {
    let mx = p.input.mx;
    let my = p.input.my;
    const length = Math.hypot(mx, my);
    if (length > 1) { mx /= length; my /= length; }
    p.aim = p.input.aim;
    const speed = PLAYER_SPEED * this.statMultiplier(p, "speed");
    p.x = clamp(p.x + mx * speed * DT, PLAYER_RADIUS, MAP_SIZE - PLAYER_RADIUS);
    p.y = clamp(p.y + my * speed * DT, PLAYER_RADIUS, MAP_SIZE - PLAYER_RADIUS);
    const nearby = this.objectGrid.query(p.x, p.y, 150);
    for (const object of nearby) {
      if (object.hp <= 0) continue;
      if (object.kind === "spike") {
        if (object.owner !== p.id && p.spikeCooldown <= 0 && dist2(p, object) < (PLAYER_RADIUS + object.r) ** 2) {
          p.spikeCooldown = 0.8;
          const owner = object.owner ? this.players.get(object.owner) ?? null : null;
          this.hitPlayer(owner, p, 14);
        }
        continue;
      }
      const dx = p.x - object.x;
      const dy = p.y - object.y;
      const distance = Math.hypot(dx, dy);
      const minDistance = PLAYER_RADIUS + object.r * (object.natural ? 0.78 : 0.88);
      if (distance < minDistance) {
        const nx = distance > 0.001 ? dx / distance : 1;
        const ny = distance > 0.001 ? dy / distance : 0;
        p.x = object.x + nx * minDistance;
        p.y = object.y + ny * minDistance;
      }
    }
  }

  private attack(p: ServerPlayer): void {
    const weapon = WEAPONS[p.weapon];
    p.cooldown = weapon.cooldown;
    p.swing = 1;
    if (p.weapon === 2) {
      const id = this.nextId++;
      const speed = 760;
      this.projectiles.set(id, {
        id, x: p.x + Math.cos(p.aim) * 44, y: p.y + Math.sin(p.aim) * 44,
        aim: p.aim, owner: p.id, vx: Math.cos(p.aim) * speed, vy: Math.sin(p.aim) * speed,
        life: weapon.range / speed, damage: weapon.damage * this.statMultiplier(p, "damage"),
      });
      return;
    }

    let hits = 0;
    const inArc = (target: Point, radius: number): boolean => {
      const dx = target.x - p.x;
      const dy = target.y - p.y;
      const distance = Math.hypot(dx, dy);
      return distance <= weapon.range + radius && Math.abs(angleDelta(Math.atan2(dy, dx), p.aim)) <= 1.05;
    };
    for (const object of this.objectGrid.query(p.x, p.y, weapon.range + 100)) {
      if (object.hp <= 0 || !inArc(object, object.r)) continue;
      this.hitObject(p, object, weapon.damage * this.statMultiplier(p, "damage"), weapon.gather);
      if (++hits >= 3) break;
    }
    for (const animal of this.animalGrid.query(p.x, p.y, weapon.range + 60)) {
      if (animal.hp > 0 && inArc(animal, 30)) this.hitAnimal(p, animal, weapon.damage * this.statMultiplier(p, "damage"));
    }
    for (const other of this.playerGrid.query(p.x, p.y, weapon.range + 60)) {
      if (other.id !== p.id && other.alive && inArc(other, PLAYER_RADIUS)) this.hitPlayer(p, other, weapon.damage * this.statMultiplier(p, "damage"));
    }
  }

  private heal(p: ServerPlayer): void {
    if (p.food < 10 || p.hp >= p.maxHp) return;
    p.food -= 10;
    p.hp = Math.min(p.maxHp, p.hp + 35);
    p.healCooldown = 0.7;
    p.privateDirty = true;
    p.events.push({ t: "notice", text: "Você comeu e recuperou 35 de vida." });
  }

  private useBuilding(p: ServerPlayer): void {
    const selected = p.input.build;
    if (!selected || p.buildSeq === p.input.seq) return;
    p.buildSeq = p.input.seq;
    const spec = BUILDINGS[selected];
    if (!spec) return;
    const owned = [...this.objects.values()].filter((o) => o.owner === p.id && o.kind === spec.kind && o.hp > 0).length;
    if (owned >= spec.limit) {
      p.events.push({ t: "notice", text: `Limite de ${spec.limit} construções deste tipo.` });
      return;
    }
    if (p.wood < spec.cost.wood || p.stone < spec.cost.stone) {
      p.events.push({ t: "notice", text: `Recursos insuficientes: ${spec.cost.wood} madeira e ${spec.cost.stone} pedra.` });
      return;
    }
    const x = clamp(p.x + Math.cos(p.aim) * 105, spec.r, MAP_SIZE - spec.r);
    const y = clamp(p.y + Math.sin(p.aim) * 105, spec.r, MAP_SIZE - spec.r);
    const blocked = this.objectGrid.query(x, y, 150).some((o) => o.hp > 0 && Math.hypot(o.x - x, o.y - y) < o.r + spec.r + 12)
      || [...this.players.values()].some((other) => other.alive && Math.hypot(other.x - x, other.y - y) < PLAYER_RADIUS + spec.r);
    if (blocked) {
      p.events.push({ t: "notice", text: "Espaço ocupado. Afaste-se e tente novamente." });
      return;
    }
    p.wood -= spec.cost.wood;
    p.stone -= spec.cost.stone;
    p.privateDirty = true;
    const id = this.nextId++;
    const object: ServerObject = {
      id, kind: spec.kind, x, y, r: spec.r, hp: spec.hp, maxHp: spec.hp,
      owner: p.id, flash: 0, version: 2, natural: false, respawnAt: 0,
    };
    this.objects.set(id, object);
    this.objectGrid.insert(object);
    this.events.push({ t: "build", x, y, kind: spec.kind });
  }

  private hitObject(p: ServerPlayer, object: ServerObject, damage: number, gather: number): void {
    object.hp -= damage;
    object.flash = 1;
    object.version++;
    const resource = this.resourceFor(object.kind);
    if (resource) {
      const amount = Math.max(1, Math.round((object.kind === "gold" ? 2 : 5) * this.statMultiplier(p, "gather") * gather));
      p[resource] += amount;
      this.reward(p, object.kind === "gold" ? 4 : 2, object.kind === "gold" ? 5 : 2);
      this.events.push({ t: "gather", x: object.x, y: object.y, resource, value: amount });
    }
    this.events.push({ t: "hit", x: object.x, y: object.y, value: Math.round(damage), kind: object.kind });
    if (object.hp <= 0) {
      object.hp = 0;
      object.version++;
      if (object.natural) object.respawnAt = this.tick + TICK_RATE * (16 + this.random() * 12);
      if (!object.natural && object.owner) {
        const owner = this.players.get(object.owner);
        if (owner) this.reward(p, 10, 15);
      }
    }
  }

  private hitAnimal(p: ServerPlayer, animal: ServerAnimal, damage: number): void {
    animal.hp -= damage;
    animal.flash = 1;
    animal.aggro = animal.kind === "boar" ? 7 : 4;
    animal.state = 2;
    if (animal.kind === "goat") {
      const dx = animal.x - p.x;
      const dy = animal.y - p.y;
      const length = Math.hypot(dx, dy) || 1;
      animal.targetX = clamp(animal.x + (dx / length) * 850, 30, MAP_SIZE - 30);
      animal.targetY = clamp(animal.y + (dy / length) * 850, 30, MAP_SIZE - 30);
    } else {
      animal.targetX = p.x;
      animal.targetY = p.y;
    }
    this.events.push({ t: "hit", x: animal.x, y: animal.y, value: Math.round(damage), kind: animal.kind });
    if (animal.hp <= 0) {
      p.food += animal.kind === "boar" ? 45 : 25;
      p.gold += animal.kind === "boar" ? 8 : 3;
      this.reward(p, animal.kind === "boar" ? 45 : 20, animal.kind === "boar" ? 65 : 30);
      this.animals.delete(animal.id);
      p.privateDirty = true;
    }
  }

  private hitPlayer(attacker: ServerPlayer | null, target: ServerPlayer, damage: number): void {
    if (!target.alive || target.spawnShield > 0) return;
    target.hp -= damage;
    target.flash = 1;
    this.events.push({ t: "hit", x: target.x, y: target.y, value: Math.round(damage), kind: "player" });
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.input = defaultInput();
      if (attacker) {
        attacker.kills++;
        this.reward(attacker, 100 + target.level * 20, 100 + target.level * 25);
      }
      this.events.push({ t: "death", id: target.id, by: attacker?.id });
      target.events.push({ t: "notice", text: `${attacker?.name ?? "O sertão"} derrubou você. Respawne para voltar à disputa.` });
    }
  }

  private stepAnimals(): void {
    for (const animal of [...this.animals.values()]) {
      animal.flash = Math.max(0, animal.flash - DT * 6);
      animal.cooldown = Math.max(0, animal.cooldown - DT);
      animal.think -= DT;
      animal.aggro = Math.max(0, animal.aggro - DT);
      let target: ServerPlayer | undefined;
      if (animal.kind === "boar") {
        let best = animal.aggro > 0 ? 900 * 900 : 360 * 360;
        for (const p of this.playerGrid.query(animal.x, animal.y, 900)) {
          if (!p.alive) continue;
          const d = dist2(animal, p);
          if (d < best) { best = d; target = p; }
        }
      } else if (animal.aggro <= 0) {
        let best = 175 * 175;
        for (const p of this.playerGrid.query(animal.x, animal.y, 175)) {
          if (!p.alive) continue;
          const d = dist2(animal, p);
          if (d < best) { best = d; target = p; }
        }
        if (target) {
          const dx = animal.x - target.x;
          const dy = animal.y - target.y;
          const length = Math.hypot(dx, dy) || 1;
          animal.aggro = 2.4;
          animal.targetX = clamp(animal.x + (dx / length) * 650, 30, MAP_SIZE - 30);
          animal.targetY = clamp(animal.y + (dy / length) * 650, 30, MAP_SIZE - 30);
          target = undefined;
        }
      }
      if (animal.kind === "goat" && animal.aggro > 0) animal.state = 2;
      if (target) {
        animal.state = 2;
        animal.targetX = target.x;
        animal.targetY = target.y;
        animal.aim = Math.atan2(target.y - animal.y, target.x - animal.x);
        const distance = Math.sqrt(dist2(animal, target));
        if (distance < 65 && animal.cooldown <= 0) {
          animal.cooldown = 1.15;
          this.hitPlayer(null, target, 16);
        }
      } else if (animal.think <= 0 && (animal.kind === "boar" || animal.aggro <= 0)) {
        animal.state = animal.kind === "goat" && animal.flash > 0 ? 2 : 1;
        animal.think = 1.8 + this.random() * 3.5;
        animal.aim = this.random() * Math.PI * 2;
        animal.targetX = clamp(animal.x + Math.cos(animal.aim) * (100 + this.random() * 240), 30, MAP_SIZE - 30);
        animal.targetY = clamp(animal.y + Math.sin(animal.aim) * (100 + this.random() * 240), 30, MAP_SIZE - 30);
      }
      const dx = animal.targetX - animal.x;
      const dy = animal.targetY - animal.y;
      const distance = Math.hypot(dx, dy);
      const stop = target && distance < 55;
      if (distance > 8 && !stop) {
        const speed = animal.kind === "boar" ? (target ? 190 : 75) : (animal.state === 2 ? 225 : 65);
        animal.aim = Math.atan2(dy, dx);
        animal.x = clamp(animal.x + (dx / distance) * speed * DT, 25, MAP_SIZE - 25);
        animal.y = clamp(animal.y + (dy / distance) * speed * DT, 25, MAP_SIZE - 25);
      }
    }
  }

  private stepProjectiles(): void {
    for (const projectile of [...this.projectiles.values()]) {
      const owner = this.players.get(projectile.owner);
      if (!owner) { this.projectiles.delete(projectile.id); continue; }
      let hit = false;
      for (let sub = 0; sub < 3 && !hit; sub++) {
        projectile.x += projectile.vx * DT / 3;
        projectile.y += projectile.vy * DT / 3;
        projectile.life -= DT / 3;
        for (const other of this.playerGrid.query(projectile.x, projectile.y, 70)) {
          if (other.id !== owner.id && other.alive && dist2(projectile, other) < (PLAYER_RADIUS + 8) ** 2) {
            this.hitPlayer(owner, other, projectile.damage);
            hit = true;
            break;
          }
        }
        if (!hit) for (const animal of this.animalGrid.query(projectile.x, projectile.y, 70)) {
          if (dist2(projectile, animal) < 38 ** 2) {
            this.hitAnimal(owner, animal, projectile.damage);
            hit = true;
            break;
          }
        }
        if (!hit) for (const object of this.objectGrid.query(projectile.x, projectile.y, 90)) {
          if (object.hp > 0 && dist2(projectile, object) < (object.r + 8) ** 2) {
            this.hitObject(owner, object, projectile.damage, WEAPONS[2].gather);
            hit = true;
            break;
          }
        }
      }
      if (hit || projectile.life <= 0 || projectile.x < 0 || projectile.y < 0 || projectile.x > MAP_SIZE || projectile.y > MAP_SIZE) {
        this.projectiles.delete(projectile.id);
      }
    }
  }

  private stepObjects(): void {
    for (const object of this.objects.values()) {
      object.flash = Math.max(0, (object.flash ?? 0) - DT * 6);
      if (object.natural && object.hp <= 0 && object.respawnAt > 0 && this.tick >= object.respawnAt) {
        object.hp = object.maxHp;
        object.respawnAt = 0;
        object.version++;
      }
      if (object.kind === "mill" && object.hp > 0 && object.owner && this.tick % (TICK_RATE * 5) === 0) {
        const owner = this.players.get(object.owner);
        if (owner) {
          owner.gold += 2;
          owner.score += 2;
          owner.privateDirty = true;
        }
      }
    }
    if (this.tick % (TICK_RATE * 10) === 0 && this.animals.size < 22) {
      this.spawnAnimal(this.random() < 0.62 ? "goat" : "boar");
    }
  }

  private reward(p: ServerPlayer, xp: number, score: number): void {
    p.xp += xp;
    p.score += score;
    while (p.xp >= p.nextXp && p.level < 20) {
      p.xp -= p.nextXp;
      p.level++;
      p.upgradePoints++;
      p.nextXp = xpForLevel(p.level);
      this.recalculateMaxHp(p);
      p.hp = Math.min(p.maxHp, p.hp + 20);
      this.events.push({ t: "level", id: p.id, level: p.level });
      p.events.push({ t: "notice", text: `Nível ${p.level}! Escolha uma melhoria no painel.` });
    }
    p.privateDirty = true;
  }

  private statMultiplier(p: ServerPlayer, stat: "damage" | "speed" | "gather"): number {
    const base = stat === "damage" ? p.damageMult : stat === "speed" ? p.speedMult : p.gatherMult;
    let multiplier = base;
    for (const itemId of [p.equippedHat, p.equippedAccessory]) {
      if (!itemId) continue;
      const item = shopItem(itemId);
      const bonus = item?.[stat];
      if (typeof bonus === "number") multiplier *= bonus;
    }
    return multiplier;
  }

  private recalculateMaxHp(p: ServerPlayer): void {
    const previous = p.maxHp;
    const hatHp = p.equippedHat ? shopItem(p.equippedHat)?.maxHp ?? 0 : 0;
    const vitality = p.upgrades.includes("vitality") ? 20 : 0;
    p.maxHp = 100 + Math.min(60, (p.level - 1) * 3) + vitality + hatHp;
    p.hp = Math.min(p.maxHp, p.hp + Math.max(0, p.maxHp - previous));
  }

  private resourceFor(kind: ObjectKind): ResourceKind | null {
    if (kind === "tree") return "wood";
    if (kind === "bush") return "food";
    if (kind === "rock") return "stone";
    if (kind === "gold") return "gold";
    return null;
  }

  private rebuildDynamicGrids(): void {
    this.playerGrid.clear();
    this.animalGrid.clear();
    for (const p of this.players.values()) if (p.alive) this.playerGrid.insert(p);
    for (const animal of this.animals.values()) this.animalGrid.insert(animal);
  }

  private generate(): void {
    const addObjects = (kind: ObjectKind, count: number, r: number, hp: number): void => {
      for (let i = 0; i < count; i++) {
        let x = 0;
        let y = 0;
        for (let tries = 0; tries < 20; tries++) {
          x = 100 + this.random() * (MAP_SIZE - 200);
          y = 100 + this.random() * (MAP_SIZE - 200);
          if (Math.hypot(x - CENTER, y - CENTER) > 430) break;
        }
        const id = this.nextId++;
        const object: ServerObject = {
          id, kind, x, y, r: r * (0.85 + this.random() * 0.3), hp, maxHp: hp,
          flash: 0, version: 1, natural: true, respawnAt: 0,
        };
        this.objects.set(id, object);
        this.objectGrid.insert(object);
      }
    };
    addObjects("tree", 105, 55, 180);
    addObjects("bush", 42, 40, 90);
    addObjects("rock", 48, 45, 240);
    addObjects("gold", 14, 42, 280);
    // A small, readable starting cluster teaches gathering within the first seconds.
    const starters: Array<[ObjectKind, number, number, number, number]> = [
      ["tree", CENTER - 185, CENTER - 90, 55, 180],
      ["bush", CENTER + 170, CENTER - 105, 40, 90],
      ["rock", CENTER + 190, CENTER + 145, 45, 240],
      ["tree", CENTER - 160, CENTER + 190, 55, 180],
    ];
    for (const [kind, x, y, r, hp] of starters) {
      const id = this.nextId++;
      const object: ServerObject = { id, kind, x, y, r, hp, maxHp: hp, flash: 0, version: 1, natural: true, respawnAt: 0 };
      this.objects.set(id, object);
      this.objectGrid.insert(object);
    }
    for (let i = 0; i < 14; i++) this.spawnAnimal("goat");
    for (let i = 0; i < 8; i++) this.spawnAnimal("boar");
  }

  private spawnAnimal(kind: AnimalKind): void {
    const id = this.nextId++;
    let x = 200 + this.random() * (MAP_SIZE - 400);
    let y = 200 + this.random() * (MAP_SIZE - 400);
    if (Math.hypot(x - CENTER, y - CENTER) < 550) {
      x = clamp(x + 700, 100, MAP_SIZE - 100);
      y = clamp(y + 500, 100, MAP_SIZE - 100);
    }
    const hp = kind === "boar" ? 150 : 80;
    this.animals.set(id, {
      id, kind, x, y, aim: this.random() * Math.PI * 2, hp, maxHp: hp,
      state: 0, flash: 0, think: this.random() * 2, targetX: x, targetY: y, cooldown: 0, aggro: 0,
    });
  }

  private findSpawn(): Point {
    for (let tries = 0; tries < 30; tries++) {
      const angle = this.random() * Math.PI * 2;
      const radius = 40 + this.random() * 250;
      const point = { x: CENTER + Math.cos(angle) * radius, y: CENTER + Math.sin(angle) * radius };
      const blocked = this.objectGrid.query(point.x, point.y, 130).some((o) => o.hp > 0 && dist2(point, o) < (o.r + PLAYER_RADIUS + 20) ** 2);
      if (!blocked) return point;
    }
    return { x: CENTER, y: CENTER };
  }
}

export const WORLD_MAX_PLAYERS = MAX_PLAYERS;
export const WORLD_SNAPSHOT_EVERY = SNAPSHOT_EVERY;
