export const PROTOCOL_VERSION = 1;
export const TICK_RATE = 30;
export const SNAPSHOT_EVERY = 2;
export const MAP_SIZE = 6400;
export const PLAYER_RADIUS = 28;
export const PLAYER_SPEED = 270;
export const AOI_X = 1500;
export const AOI_Y = 1100;
export const MAX_INPUT_BYTES = 2048;

export type ResourceKind = "wood" | "food" | "stone" | "gold";
export type ObjectKind = "tree" | "bush" | "rock" | "gold" | "wall" | "spike" | "mill";
export type AnimalKind = "goat" | "boar";

export interface InputState {
  seq: number;
  mx: number;
  my: number;
  aim: number;
  attack: boolean;
  build: number;
  weapon: number;
  heal: boolean;
}

export interface PlayerNet {
  id: number;
  name: string;
  x: number;
  y: number;
  px?: number;
  py?: number;
  aim: number;
  hp: number;
  maxHp: number;
  weapon: number;
  level: number;
  score: number;
  kills: number;
  alive: boolean;
  swing: number;
  flash: number;
}

export interface ObjectNet {
  id: number;
  kind: ObjectKind;
  x: number;
  y: number;
  r: number;
  hp: number;
  maxHp: number;
  owner?: number;
  flash?: number;
}

export interface AnimalNet {
  id: number;
  kind: AnimalKind;
  x: number;
  y: number;
  aim: number;
  hp: number;
  maxHp: number;
  state: number;
  flash: number;
}

export interface ProjectileNet {
  id: number;
  x: number;
  y: number;
  aim: number;
  owner: number;
}

export interface PrivateNet {
  wood: number;
  food: number;
  stone: number;
  gold: number;
  xp: number;
  nextXp: number;
  level: number;
  upgradePoints: number;
  damageMult: number;
  speedMult: number;
  gatherMult: number;
}

export interface LeaderNet {
  id: number;
  name: string;
  score: number;
  kills: number;
}

export type GameEvent =
  | { t: "hit"; x: number; y: number; value: number; kind: string }
  | { t: "gather"; x: number; y: number; resource: ResourceKind; value: number }
  | { t: "death"; id: number; by?: number }
  | { t: "level"; id: number; level: number }
  | { t: "build"; x: number; y: number; kind: ObjectKind }
  | { t: "notice"; text: string };

export type ClientMessage =
  | ["j", string]
  | ["i", InputState]
  | ["u", "damage" | "speed" | "gather"]
  | ["r"]
  | ["p", number];

export type ServerMessage =
  | ["w", { version: number; id: number; tick: number; mapSize: number; seed: number }]
  | ["s", {
      tick: number;
      ack: number;
      players: PlayerNet[];
      objects: ObjectNet[];
      animals: AnimalNet[];
      projectiles: ProjectileNet[];
      removedObjects: number[];
      hiddenPlayers: number[];
      hiddenAnimals: number[];
    }]
  | ["p", PrivateNet]
  | ["e", GameEvent[]]
  | ["l", LeaderNet[]]
  | ["d", string]
  | ["o", number];

export const BUILDINGS = [
  null,
  { kind: "wall" as const, name: "Cerca de espinho", cost: { wood: 25, stone: 5 }, r: 46, hp: 350, limit: 24 },
  { kind: "spike" as const, name: "Arame farpado", cost: { wood: 10, stone: 20 }, r: 38, hp: 180, limit: 12 },
  { kind: "mill" as const, name: "Moinho de vento", cost: { wood: 45, stone: 20 }, r: 52, hp: 260, limit: 3 },
] as const;

export const WEAPONS = [
  { name: "Facão de mato", unlock: 1, range: 92, damage: 22, cooldown: 0.42, gather: 1 },
  { name: "Lança de vaqueiro", unlock: 2, range: 132, damage: 34, cooldown: 0.62, gather: 0.8 },
  { name: "Estilingue", unlock: 3, range: 620, damage: 24, cooldown: 0.78, gather: 0.6 },
] as const;

export function xpForLevel(level: number): number {
  return Math.round(70 * Math.pow(1.45, Math.max(0, level - 1)));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
