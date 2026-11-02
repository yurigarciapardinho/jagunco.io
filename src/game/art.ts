import { Container, Graphics, Text } from "pixi.js";
import { MAP_SIZE, type AnimalKind, type ObjectKind } from "@contracts/game";

export const COLORS = {
  sand: 0xd9c083,
  sandDark: 0xc4a868,
  ink: 0x2b2118,
  cream: 0xfff1c7,
  leather: 0x70452d,
  leatherDark: 0x3c2a20,
  red: 0xb84335,
  teal: 0x287a70,
  leaf: 0x4f743d,
  leafLight: 0x6f8f47,
  rock: 0x77756b,
  gold: 0xe3ac32,
};

export interface PlayerView {
  root: Container;
  body: Container;
  hp: Graphics;
  label: Text;
  targetX: number;
  targetY: number;
  targetAim: number;
  swing: number;
  lastHp: number;
}

export interface ObjectView {
  root: Container;
  hp: Graphics;
  kind: ObjectKind;
}

export interface AnimalView {
  root: Container;
  body: Container;
  hp: Graphics;
  targetX: number;
  targetY: number;
  targetAim: number;
}

const labelStyle = {
  fontFamily: "Arial, sans-serif",
  fontSize: 13,
  fontWeight: "bold" as const,
  fill: COLORS.cream,
  stroke: { color: COLORS.ink, width: 4 },
  align: "center" as const,
};

export function createGround(): Container {
  const ground = new Container();
  const base = new Graphics().rect(0, 0, MAP_SIZE, MAP_SIZE).fill(COLORS.sand);
  base.rect(-80, -80, MAP_SIZE + 160, 80).fill(0x66513a);
  base.rect(-80, MAP_SIZE, MAP_SIZE + 160, 80).fill(0x66513a);
  base.rect(-80, 0, 80, MAP_SIZE).fill(0x66513a);
  base.rect(MAP_SIZE, 0, 80, MAP_SIZE).fill(0x66513a);
  ground.addChild(base);

  let seed = 0x1a2b3c4d;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const patches = new Graphics();
  for (let i = 0; i < 260; i++) {
    const x = random() * MAP_SIZE;
    const y = random() * MAP_SIZE;
    const r = 10 + random() * 36;
    patches.ellipse(x, y, r * 1.8, r).fill({ color: COLORS.sandDark, alpha: 0.18 + random() * 0.12 });
  }
  ground.addChild(patches);
  const tufts = new Graphics();
  for (let i = 0; i < 420; i++) {
    const x = 30 + random() * (MAP_SIZE - 60);
    const y = 30 + random() * (MAP_SIZE - 60);
    const h = 4 + random() * 7;
    tufts.moveTo(x - 4, y + 3).lineTo(x, y - h).lineTo(x + 1, y + 3)
      .moveTo(x + 1, y + 3).lineTo(x + 6, y - h * 0.6)
      .stroke({ color: 0x8b8a4c, width: 2, alpha: 0.45 });
  }
  ground.addChild(tufts);
  return ground;
}

export function createPlayer(name: string, local: boolean): PlayerView {
  const root = new Container();
  const shadow = new Graphics().ellipse(0, 19, 30, 14).fill({ color: 0x3a2d20, alpha: 0.24 });
  root.addChild(shadow);
  const body = new Container();
  const shirt = local ? COLORS.teal : COLORS.red;
  body.addChild(new Graphics()
    .circle(0, 0, 28).fill(COLORS.leatherDark)
    .circle(0, 0, 24).fill(shirt)
    .circle(8, -8, 11).fill(0xd8a66d)
    .rect(-24, -7, 48, 8).fill(COLORS.leather)
    .roundRect(-17, -28, 34, 24, 7).fill(COLORS.leather)
    .rect(-17, -19, 34, 5).fill(COLORS.gold)
    .moveTo(-12, -28).lineTo(-6, -35).lineTo(0, -28).stroke({ color: COLORS.cream, width: 3 }));
  const weapon = new Graphics()
    .roundRect(19, -4, 47, 8, 3).fill(0x5a3825)
    .poly([58, -9, 79, -3, 63, 6]).fill(0xd9ddd0)
    .moveTo(62, -6).lineTo(73, -3).stroke({ color: 0xffffff, width: 2, alpha: 0.7 });
  weapon.pivot.set(20, 0);
  weapon.position.set(20, 0);
  body.addChild(weapon);
  root.addChild(body);
  const hp = new Graphics();
  hp.position.set(-28, -57);
  root.addChild(hp);
  const label = new Text({ text: name, style: labelStyle });
  label.anchor.set(0.5);
  label.position.set(0, -76);
  root.addChild(label);
  redrawHp(hp, 100, 100, 56);
  return { root, body, hp, label, targetX: 0, targetY: 0, targetAim: 0, swing: 0, lastHp: 100 };
}

export function redrawHp(g: Graphics, value: number, max: number, width: number): void {
  g.clear();
  if (value >= max) return;
  g.roundRect(0, 0, width, 7, 3).fill({ color: COLORS.ink, alpha: 0.75 });
  const ratio = Math.max(0, value / max);
  g.roundRect(2, 2, Math.max(0, (width - 4) * ratio), 3, 2).fill(ratio > 0.35 ? 0x76b947 : 0xe04f3f);
}

export function createObject(kind: ObjectKind, radius: number): ObjectView {
  const root = new Container();
  const g = new Graphics().ellipse(0, radius * 0.55, radius * 0.85, radius * 0.35).fill({ color: 0x493722, alpha: 0.2 });
  root.addChild(g);
  const art = new Graphics();
  if (kind === "tree") {
    art.roundRect(-9, -4, 18, radius * 0.95, 6).fill(0x674329)
      .circle(-radius * 0.38, -radius * 0.25, radius * 0.58).fill(COLORS.leaf)
      .circle(radius * 0.35, -radius * 0.32, radius * 0.62).fill(COLORS.leafLight)
      .circle(0, -radius * 0.7, radius * 0.65).fill(0x587f42)
      .circle(-12, -radius * 0.82, radius * 0.23).fill({ color: 0x91a95d, alpha: 0.65 });
  } else if (kind === "bush") {
    art.circle(-18, 0, radius * 0.58).fill(COLORS.leaf)
      .circle(18, 0, radius * 0.58).fill(COLORS.leafLight)
      .circle(0, -18, radius * 0.68).fill(0x668342);
    for (const [x, y] of [[-18, -12], [12, -25], [22, 2], [-4, 8]]) art.circle(x, y, 4).fill(0xc45b3f);
  } else if (kind === "rock" || kind === "gold") {
    const fill = kind === "gold" ? COLORS.gold : COLORS.rock;
    art.poly([-radius, radius * 0.35, -radius * 0.72, -radius * 0.55, -radius * 0.15, -radius,
      radius * 0.62, -radius * 0.65, radius, radius * 0.3, radius * 0.45, radius * 0.65, -radius * 0.55, radius * 0.65]).fill(fill)
      .poly([-radius * 0.55, -radius * 0.45, -radius * 0.12, -radius * 0.78, radius * 0.35, -radius * 0.55, 0, -radius * 0.2])
      .fill({ color: kind === "gold" ? 0xffd867 : 0xa7a398, alpha: 0.75 });
  } else if (kind === "wall") {
    art.roundRect(-radius, -15, radius * 2, 30, 5).fill(0x69422a)
      .rect(-radius + 8, -radius * 0.65, 12, radius * 1.1).fill(0x4e3425)
      .rect(radius - 20, -radius * 0.65, 12, radius * 1.1).fill(0x4e3425)
      .moveTo(-radius, -5).lineTo(radius, -5).stroke({ color: 0xb78a50, width: 4 });
  } else if (kind === "spike") {
    for (let i = -2; i <= 2; i++) {
      art.moveTo(i * 15 - 12, 20).lineTo(i * 15, -30).lineTo(i * 15 + 12, 20).stroke({ color: 0x5a5a51, width: 5 });
    }
    art.moveTo(-radius, 12).lineTo(radius, -12).stroke({ color: 0x3e3d38, width: 4 });
  } else if (kind === "mill") {
    art.poly([-24, 38, -15, -25, 15, -25, 24, 38]).fill(0x7a5131)
      .circle(0, -22, 8).fill(COLORS.leatherDark);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      art.moveTo(0, -22).lineTo(Math.cos(a) * 48, -22 + Math.sin(a) * 48).stroke({ color: 0x4b3527, width: 6 });
      art.circle(Math.cos(a) * 42, -22 + Math.sin(a) * 42, 9).fill(COLORS.cream);
    }
  }
  root.addChild(art);
  const hp = new Graphics();
  hp.position.set(-radius, -radius - 22);
  root.addChild(hp);
  return { root, hp, kind };
}

export function createAnimal(kind: AnimalKind): AnimalView {
  const root = new Container();
  root.addChild(new Graphics().ellipse(0, 18, 32, 12).fill({ color: 0x3a2d20, alpha: 0.22 }));
  const body = new Container();
  const g = new Graphics();
  if (kind === "goat") {
    g.ellipse(0, 0, 30, 21).fill(0xe8dfca)
      .circle(23, -8, 15).fill(0xf5ecd8)
      .moveTo(22, -20).lineTo(16, -34).lineTo(28, -23).stroke({ color: 0x68513b, width: 4 })
      .moveTo(31, -19).lineTo(36, -31).lineTo(38, -17).stroke({ color: 0x68513b, width: 4 })
      .circle(29, -10, 2.5).fill(COLORS.ink);
  } else {
    g.ellipse(0, 0, 34, 23).fill(0x574234)
      .circle(25, -4, 17).fill(0x654a38)
      .ellipse(37, 2, 10, 7).fill(0xb2866b)
      .poly([20, -17, 26, -31, 31, -15]).fill(0x3c2d25)
      .circle(30, -8, 2.5).fill(0xf0c84b);
  }
  body.addChild(g);
  root.addChild(body);
  const hp = new Graphics();
  hp.position.set(-28, -48);
  root.addChild(hp);
  return { root, body, hp, targetX: 0, targetY: 0, targetAim: 0 };
}
