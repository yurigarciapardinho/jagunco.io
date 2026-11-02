import type { LeaderNet, PrivateNet } from "@contracts/game";

export type GamePhase = "title" | "connecting" | "playing" | "dead" | "error";

export interface HudState {
  phase: GamePhase;
  name: string;
  hp: number;
  maxHp: number;
  score: number;
  kills: number;
  level: number;
  xp: number;
  nextXp: number;
  upgradePoints: number;
  wood: number;
  food: number;
  stone: number;
  gold: number;
  damageMult: number;
  speedMult: number;
  gatherMult: number;
  weapon: number;
  build: number;
  leaders: LeaderNet[];
  notice: string;
  deathBy: string;
  ping: number;
  paused: boolean;
  muted: boolean;
}

export const initialHud: HudState = {
  phase: "title",
  name: "Jagunço",
  hp: 100,
  maxHp: 100,
  score: 0,
  kills: 0,
  level: 1,
  xp: 0,
  nextXp: 70,
  upgradePoints: 0,
  wood: 0,
  food: 20,
  stone: 0,
  gold: 0,
  damageMult: 1,
  speedMult: 1,
  gatherMult: 1,
  weapon: 0,
  build: 0,
  leaders: [],
  notice: "",
  deathBy: "",
  ping: 0,
  paused: false,
  muted: false,
};

export function applyPrivate(hud: HudState, data: PrivateNet): void {
  hud.wood = data.wood;
  hud.food = data.food;
  hud.stone = data.stone;
  hud.gold = data.gold;
  hud.level = data.level;
  hud.xp = data.xp;
  hud.nextXp = data.nextXp;
  hud.upgradePoints = data.upgradePoints;
  hud.damageMult = data.damageMult;
  hud.speedMult = data.speedMult;
  hud.gatherMult = data.gatherMult;
}
