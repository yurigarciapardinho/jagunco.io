import {
  Assets,
  Container,
  Graphics,
  Sprite,
  Spritesheet,
  Text,
  Texture,
  TilingSprite,
} from "pixi.js";
import { MAP_SIZE, type AnimalKind, type ObjectKind } from "@contracts/game";

export const COLORS = {
  sand: 0xcfb175,
  sandDark: 0xb8955e,
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
  bodyArt: Sprite;
  bodyScale: number;
  weapon: Container;
  weaponArt: Sprite;
  slash: Sprite;
  hands: Sprite[];
  hp: Graphics;
  label: Text;
  targetX: number;
  targetY: number;
  targetAim: number;
  swing: number;
  serverSwing: number;
  attackTime: number;
  weaponIndex: number;
  walk: number;
  hit: number;
  lastHp: number;
}

export interface ObjectView {
  root: Container;
  art: Container;
  hp: Graphics;
  kind: ObjectKind;
  spinner?: Container;
  hit: number;
  phase: number;
}

export interface AnimalView {
  root: Container;
  body: Container;
  bodyArt: Sprite;
  bodyScale: number;
  hp: Graphics;
  targetX: number;
  targetY: number;
  targetAim: number;
  walk: number;
  hit: number;
}

let atlas: Spritesheet | null = null;
let loading: Promise<void> | null = null;

export function loadArt(): Promise<void> {
  if (atlas) return Promise.resolve();
  if (!loading) {
    loading = Promise.all([
      Assets.load<Spritesheet>("/art/jagunco-atlas.json"),
      Assets.load<Texture>("/art/caatinga-ground.png"),
    ]).then(([sheet]) => {
      atlas = sheet;
    });
  }
  return loading;
}

function art(name: string): Sprite {
  if (!atlas) throw new Error("O atlas visual ainda não foi carregado.");
  return new Sprite(atlas.textures[name]);
}

const labelStyle = {
  fontFamily: "Barlow Condensed, Arial, sans-serif",
  fontSize: 15,
  fontWeight: "bold" as const,
  fill: COLORS.cream,
  stroke: { color: COLORS.ink, width: 4 },
  align: "center" as const,
};

export function createGround(): Container {
  const ground = new Container();
  const terrain = new TilingSprite({
    texture: Assets.get<Texture>("/art/caatinga-ground.png"),
    width: MAP_SIZE,
    height: MAP_SIZE,
  });
  terrain.tileScale.set(1.15);
  ground.addChild(terrain);

  const tracks = new Graphics();
  tracks.moveTo(-100, MAP_SIZE * 0.69).bezierCurveTo(
    MAP_SIZE * 0.25, MAP_SIZE * 0.57,
    MAP_SIZE * 0.61, MAP_SIZE * 0.48,
    MAP_SIZE + 100, MAP_SIZE * 0.31,
  ).stroke({ color: 0x9f8358, width: 34, alpha: 0.12 });
  tracks.moveTo(-100, MAP_SIZE * 0.69 + 42).bezierCurveTo(
    MAP_SIZE * 0.25, MAP_SIZE * 0.57 + 42,
    MAP_SIZE * 0.61, MAP_SIZE * 0.48 + 42,
    MAP_SIZE + 100, MAP_SIZE * 0.31 + 42,
  ).stroke({ color: 0xead39d, width: 5, alpha: 0.13 });
  ground.addChild(tracks);

  const border = new Graphics();
  border.rect(-90, -90, MAP_SIZE + 180, 90).fill(0x594632);
  border.rect(-90, MAP_SIZE, MAP_SIZE + 180, 90).fill(0x594632);
  border.rect(-90, 0, 90, MAP_SIZE).fill(0x594632);
  border.rect(MAP_SIZE, 0, 90, MAP_SIZE).fill(0x594632);
  border.rect(0, 0, MAP_SIZE, MAP_SIZE).stroke({ color: 0x806341, width: 12 });
  ground.addChild(border);
  return ground;
}

export function createPlayer(name: string, local: boolean, variant = 0): PlayerView {
  const root = new Container();
  const shadow = new Graphics().ellipse(-2, 21, 34, 15).fill({ color: 0x35271d, alpha: 0.25 });
  root.addChild(shadow);

  const body = new Container();
  const bodyArt = art(local ? "player_local" : ["player_rust", "player_gold", "player_blue"][variant % 3]);
  bodyArt.anchor.set(0.5);
  bodyArt.scale.set(0.72);
  const handBack = art("hand");
  handBack.anchor.set(0.5);
  handBack.scale.set(0.78);
  handBack.position.set(5, -25);
  const handFront = art("hand");
  handFront.anchor.set(0.5);
  handFront.scale.set(0.78);
  handFront.position.set(26, 22);

  const weapon = new Container();
  weapon.position.set(15, 20);
  const weaponArt = art("weapon_machete");
  weaponArt.anchor.set(0.1, 0.5);
  weaponArt.scale.set(0.66);
  weapon.addChild(weaponArt);

  const slash = art("slash");
  slash.anchor.set(0.5);
  slash.position.set(48, 0);
  slash.scale.set(0.75);
  slash.visible = false;

  body.addChild(handBack, bodyArt, weapon, handFront, slash);
  root.addChild(body);
  const hp = new Graphics();
  hp.position.set(-30, -59);
  root.addChild(hp);
  const label = new Text({ text: name, style: labelStyle, resolution: 2 });
  label.anchor.set(0.5);
  label.position.set(0, -79);
  root.addChild(label);
  redrawHp(hp, 100, 100, 60);
  return {
    root, body, bodyArt, bodyScale: 0.72, weapon, weaponArt, slash,
    hands: [handBack, handFront], hp, label, targetX: 0, targetY: 0,
    targetAim: 0, swing: 0, serverSwing: 0, attackTime: 1,
    weaponIndex: 0, walk: variant * 0.7, hit: 0, lastHp: 100,
  };
}

export function setPlayerWeapon(view: PlayerView, index: number): void {
  if (view.weaponIndex === index) return;
  view.weaponIndex = index;
  view.weaponArt.texture = atlas!.textures[["weapon_machete", "weapon_spear", "weapon_slingshot"][index] ?? "weapon_machete"];
  view.weaponArt.scale.set(index === 1 ? 0.74 : 0.66);
}

export function triggerAttack(view: PlayerView): void {
  view.attackTime = 0;
}

export function animatePlayer(view: PlayerView, dt: number, speed: number): void {
  const moving = speed > 12;
  view.walk += dt * (moving ? 11 : 2.2);
  const bob = moving ? Math.abs(Math.sin(view.walk)) * 2.2 : Math.sin(view.walk) * 0.55;
  view.bodyArt.y = -bob;
  const breathe = 1 + Math.sin(view.walk * (moving ? 2 : 1)) * (moving ? 0.016 : 0.007);
  view.bodyArt.scale.set(view.bodyScale * breathe);
  view.hands[0]!.y = -25 + (moving ? Math.sin(view.walk) * 3 : 0);

  if (view.attackTime < 1) {
    const duration = view.weaponIndex === 1 ? 0.46 : view.weaponIndex === 2 ? 0.38 : 0.34;
    view.attackTime = Math.min(1, view.attackTime + dt / duration);
    const t = view.attackTime;
    let angle: number;
    if (t < 0.2) angle = -0.58 * (t / 0.2);
    else if (t < 0.58) {
      const u = (t - 0.2) / 0.38;
      angle = -0.58 + 1.62 * (1 - (1 - u) * (1 - u));
    } else angle = 1.04 * (1 - (t - 0.58) / 0.42);
    view.weapon.rotation = angle;
    view.weapon.x = 15 + Math.sin(t * Math.PI) * 11;
    view.slash.visible = view.weaponIndex !== 2 && t > 0.26 && t < 0.64;
    view.slash.alpha = Math.sin((t - 0.26) / 0.38 * Math.PI) * 0.85;
    view.slash.rotation = -0.5 + t * 1.8;
  } else {
    view.weapon.rotation += (0 - view.weapon.rotation) * Math.min(1, dt * 20);
    view.weapon.x += (15 - view.weapon.x) * Math.min(1, dt * 20);
    view.slash.visible = false;
  }

  view.hit = Math.max(0, view.hit - dt * 7);
  view.bodyArt.tint = view.hit > 0 ? 0xffb49d : 0xffffff;
}

export function redrawHp(g: Graphics, value: number, max: number, width: number): void {
  g.clear();
  if (value >= max) return;
  g.roundRect(0, 0, width, 8, 3).fill({ color: COLORS.ink, alpha: 0.82 });
  const ratio = Math.max(0, value / max);
  g.roundRect(2, 2, Math.max(0, (width - 4) * ratio), 4, 2).fill(ratio > 0.35 ? 0x82b84e : 0xe04f3f);
}

function shadow(width: number, height: number): Graphics {
  return new Graphics().ellipse(0, 10, width, height).fill({ color: 0x3d2d20, alpha: 0.2 });
}

export function createObject(kind: ObjectKind, radius: number): ObjectView {
  const root = new Container();
  root.addChild(shadow(radius * 0.85, radius * 0.3));
  const container = new Container();
  let spinner: Container | undefined;

  if (kind === "mill") {
    const tower = art("mill_tower");
    tower.anchor.set(0.5);
    tower.width = radius * 1.45;
    tower.height = radius * 1.75;
    tower.y = -10;
    spinner = new Container();
    spinner.position.set(0, -radius * 0.55);
    const blades = art("mill_blades");
    blades.anchor.set(0.5);
    blades.width = blades.height = radius * 1.9;
    spinner.addChild(blades);
    container.addChild(tower, spinner);
  } else {
    const sprite = art(kind);
    sprite.anchor.set(0.5);
    if (kind === "tree") {
      sprite.width = sprite.height = radius * 3.3;
      sprite.y = -radius * 0.48;
    } else if (kind === "bush") {
      sprite.width = sprite.height = radius * 2.25;
      sprite.y = -radius * 0.2;
    } else if (kind === "rock" || kind === "gold") {
      sprite.width = sprite.height = radius * 2.15;
      sprite.y = -radius * 0.15;
    } else {
      sprite.width = radius * 2.3;
      sprite.height = radius * 1.65;
      sprite.y = -radius * 0.12;
    }
    container.addChild(sprite);
  }

  root.addChild(container);
  const hp = new Graphics();
  hp.position.set(-radius, -radius * 1.75 - 15);
  root.addChild(hp);
  return { root, art: container, hp, kind, spinner, hit: 0, phase: (radius * 0.37) % 6.28 };
}

export function animateObject(view: ObjectView, dt: number, elapsed: number): void {
  if (view.spinner) view.spinner.rotation += dt * 0.62;
  view.hit = Math.max(0, view.hit - dt * 6);
  const impact = Math.sin(view.hit * Math.PI) * view.hit;
  view.art.scale.set(1 + impact * 0.08, 1 - impact * 0.06);
  if (view.kind === "tree" || view.kind === "bush") {
    view.art.rotation = Math.sin(elapsed * 0.8 + view.phase) * 0.008 + impact * 0.035;
  } else view.art.rotation = impact * 0.04;
  view.art.tint = view.hit > 0.15 ? 0xffd2a4 : 0xffffff;
}

export function createProjectile(): Sprite {
  const sprite = art("projectile");
  sprite.anchor.set(0.5);
  sprite.scale.set(0.55);
  return sprite;
}

export function createAnimal(kind: AnimalKind): AnimalView {
  const root = new Container();
  root.addChild(shadow(35, 13));
  const body = new Container();
  const bodyArt = art(kind);
  bodyArt.anchor.set(0.5);
  const scale = kind === "boar" ? 0.57 : 0.5;
  bodyArt.scale.set(scale);
  body.addChild(bodyArt);
  root.addChild(body);
  const hp = new Graphics();
  hp.position.set(-30, -52);
  root.addChild(hp);
  return {
    root, body, bodyArt, bodyScale: scale, hp, targetX: 0, targetY: 0,
    targetAim: 0, walk: 0, hit: 0,
  };
}

export function animateAnimal(view: AnimalView, dt: number, speed: number): void {
  view.walk += dt * (speed > 10 ? 10 : 2);
  view.bodyArt.y = speed > 10 ? -Math.abs(Math.sin(view.walk)) * 2.5 : Math.sin(view.walk) * 0.5;
  view.bodyArt.scale.set(view.bodyScale * (1 + Math.sin(view.walk * 2) * (speed > 10 ? 0.025 : 0.006)));
  view.hit = Math.max(0, view.hit - dt * 7);
  view.bodyArt.tint = view.hit > 0 ? 0xffa68e : 0xffffff;
}
