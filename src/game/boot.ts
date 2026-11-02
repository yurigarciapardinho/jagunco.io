import { Application, Container, Graphics, Text } from "pixi.js";
import {
  BUILDINGS,
  MAP_SIZE,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  WEAPONS,
  clamp,
  type GameEvent,
  type InputState,
  type ObjectNet,
} from "@contracts/game";
import { GameLoop } from "./engine";
import { Input } from "./input";
import { AudioSystem } from "./audio";
import { GameConnection } from "./network";
import { initialHud, applyPrivate, type HudState } from "./hud";
import {
  COLORS,
  createAnimal,
  createGround,
  createObject,
  createPlayer,
  redrawHp,
  type AnimalView,
  type ObjectView,
  type PlayerView,
} from "./art";

declare global {
  interface Window {
    __gameProbe?: () => { x: number; y: number; z: number };
    __GAME_READY__?: boolean;
  }
}

export interface GameController {
  join(name?: string): void;
  setName(name: string): void;
  respawn(): void;
  upgrade(kind: "damage" | "speed" | "gather"): void;
  selectWeapon(index: number): void;
  selectBuild(index: number): void;
  heal(): void;
  setAttack(active: boolean): void;
  togglePause(): void;
  toggleMute(): void;
}

interface Session {
  dispose(): void;
}

interface PendingInput {
  input: InputState;
  dt: number;
}

interface Particle {
  view: Container;
  life: number;
  maxLife: number;
  vx: number;
  vy: number;
}

let session: Session | null = null;

function savedName(): string {
  try { return localStorage.getItem("jagunco.name")?.slice(0, 16) || "Jagunço"; } catch { return "Jagunço"; }
}

export function startGame(canvas: HTMLCanvasElement, onHud: (state: HudState) => void = () => {}): GameController {
  stopGame();

  const audio = new AudioSystem();
  const input = new Input(canvas);
  const app = new Application();
  const world = new Container();
  const objectLayer = new Container();
  const animalLayer = new Container();
  const playerLayer = new Container();
  const projectileLayer = new Container();
  const fxLayer = new Container();
  world.addChild(createGround(), objectLayer, animalLayer, projectileLayer, playerLayer, fxLayer);

  const players = new Map<number, PlayerView>();
  const objects = new Map<number, ObjectView>();
  const animals = new Map<number, AnimalView>();
  const projectiles = new Map<number, Graphics>();
  const particles: Particle[] = [];
  const pending: PendingInput[] = [];

  let disposed = false;
  let initialized = false;
  let hud: HudState = { ...initialHud, name: savedName(), muted: audio.muted };
  let hudClock = 0;
  let noticeClock = 0;
  let localId = 0;
  let seq = 0;
  let sendClock = 0;
  let selectedWeapon = 0;
  let selectedBuild = 0;
  let healRequested = false;
  let attackHeld = false;
  let aim = 0;
  let mouseX = window.innerWidth / 2 + 100;
  let mouseY = window.innerHeight / 2;
  let cameraX = MAP_SIZE / 2;
  let cameraY = MAP_SIZE / 2;
  let predicted = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
  let hasServerPosition = false;
  let shake = 0;
  let elapsed = 0;
  let lastSnapshotTick = 0;
  let renderDiagnosticSent = false;

  const emit = (): void => {
    onHud({ ...hud, leaders: [...hud.leaders] });
  };
  const setNotice = (text: string): void => {
    hud.notice = text;
    noticeClock = 4;
    emit();
  };

  const spawnBurst = (x: number, y: number, color: number, text?: string): void => {
    if (particles.length > 90) return;
    const group = new Container();
    group.position.set(x, y);
    for (let i = 0; i < 5; i++) {
      const bit = new Graphics().circle(0, 0, 3 + (i % 2)).fill(color);
      bit.position.set(Math.cos(i * 1.256) * 10, Math.sin(i * 1.256) * 10);
      group.addChild(bit);
    }
    if (text) {
      const label = new Text({ text, style: { fontFamily: "Arial", fontSize: 18, fontWeight: "bold", fill: color, stroke: { color: COLORS.ink, width: 4 } } });
      label.anchor.set(0.5);
      label.y = -30;
      group.addChild(label);
    }
    fxLayer.addChild(group);
    particles.push({ view: group, life: 0.75, maxLife: 0.75, vx: 0, vy: -24 });
  };

  const handleEvents = (events: GameEvent[]): void => {
    for (const event of events) {
      if (event.t === "gather") {
        const color = event.resource === "wood" ? 0x6f8f47 : event.resource === "food" ? 0xc45b3f : event.resource === "stone" ? 0xa7a398 : COLORS.gold;
        spawnBurst(event.x, event.y, color, `+${event.value}`);
        audio.sfx("pickup");
      } else if (event.t === "hit") {
        spawnBurst(event.x, event.y, 0xffd27a, `${event.value}`);
        audio.sfx("hit");
        shake = Math.min(8, shake + 2);
      } else if (event.t === "build") {
        spawnBurst(event.x, event.y, COLORS.cream, "CONSTRUÍDO");
        audio.sfx("ui");
      } else if (event.t === "level") {
        if (event.id === localId) {
          setNotice(`Nível ${event.level} alcançado — escolha sua melhoria!`);
          audio.sfx("win");
        }
      } else if (event.t === "death") {
        if (event.id === localId) {
          const killer = players.get(event.by ?? -1)?.label.text;
          hud.deathBy = killer ? `Derrubado por ${killer}` : "O sertão venceu desta vez";
          hud.phase = "dead";
          audio.sfx("lose");
          emit();
        }
      } else if (event.t === "notice") setNotice(event.text);
    }
  };

  const connection = new GameConnection({
    welcome: (data) => {
      if (disposed) return;
      localId = data.id;
      hud.phase = "playing";
      hud.deathBy = "";
      setNotice("Colete madeira, comida e pedra. Use o ataque para reunir recursos e se defender.");
      audio.startMusic();
      emit();
    },
    snapshot: (data) => {
      if (disposed) return;
      lastSnapshotTick = data.tick;
      const seenPlayers = new Set<number>();
      for (const p of data.players) {
        seenPlayers.add(p.id);
        let view = players.get(p.id);
        if (!view) {
          view = createPlayer(p.name, p.id === localId);
          view.root.position.set(p.x, p.y);
          view.targetX = p.x;
          view.targetY = p.y;
          players.set(p.id, view);
          playerLayer.addChild(view.root);
        }
        view.targetX = p.x;
        view.targetY = p.y;
        view.targetAim = p.aim;
        view.swing = p.swing;
        if (view.lastHp !== p.hp) {
          redrawHp(view.hp, p.hp, p.maxHp, 56);
          view.lastHp = p.hp;
        }
        if (p.id === localId) {
          hud.hp = p.hp;
          hud.maxHp = p.maxHp;
          hud.score = p.score;
          hud.kills = p.kills;
          hud.weapon = p.weapon;
          if (!p.alive && hud.phase === "playing") {
            hud.phase = "dead";
            emit();
          }
          if (!hasServerPosition) {
            predicted = { x: p.x, y: p.y };
            hasServerPosition = true;
          } else if (p.alive) {
            while (pending.length && pending[0].input.seq <= data.ack) pending.shift();
            let x = p.x;
            let y = p.y;
            for (const item of pending) {
              const length = Math.max(1, Math.hypot(item.input.mx, item.input.my));
              x += item.input.mx / length * PLAYER_SPEED * hud.speedMult * item.dt;
              y += item.input.my / length * PLAYER_SPEED * hud.speedMult * item.dt;
            }
            if (Math.hypot(predicted.x - x, predicted.y - y) > 240) predicted = { x, y };
            else {
              predicted.x += (x - predicted.x) * 0.28;
              predicted.y += (y - predicted.y) * 0.28;
            }
          }
        }
      }
      for (const id of data.hiddenPlayers) {
        const view = players.get(id);
        if (view) { view.root.destroy({ children: true }); players.delete(id); }
      }
      for (const [id, view] of players) {
        if (!seenPlayers.has(id) && data.hiddenPlayers.includes(id)) view.root.visible = false;
        else view.root.visible = true;
      }

      for (const o of data.objects) {
        let view = objects.get(o.id);
        if (!view) {
          view = createObject(o.kind, o.r);
          view.root.position.set(o.x, o.y);
          objects.set(o.id, view);
          objectLayer.addChild(view.root);
        }
        redrawHp(view.hp, o.hp, o.maxHp, o.r * 2);
        view.root.alpha = o.flash ? 0.72 : 1;
      }
      for (const id of data.removedObjects) {
        const view = objects.get(id);
        if (view) { view.root.destroy({ children: true }); objects.delete(id); }
      }

      const seenAnimals = new Set<number>();
      for (const a of data.animals) {
        seenAnimals.add(a.id);
        let view = animals.get(a.id);
        if (!view) {
          view = createAnimal(a.kind);
          view.root.position.set(a.x, a.y);
          animals.set(a.id, view);
          animalLayer.addChild(view.root);
        }
        view.targetX = a.x;
        view.targetY = a.y;
        view.targetAim = a.aim;
        redrawHp(view.hp, a.hp, a.maxHp, 56);
      }
      for (const id of data.hiddenAnimals) {
        const view = animals.get(id);
        if (view) { view.root.destroy({ children: true }); animals.delete(id); }
      }
      for (const [id, view] of animals) if (!seenAnimals.has(id)) {
        view.root.destroy({ children: true });
        animals.delete(id);
      }

      const seenProjectiles = new Set<number>();
      for (const p of data.projectiles) {
        seenProjectiles.add(p.id);
        let view = projectiles.get(p.id);
        if (!view) {
          view = new Graphics().circle(0, 0, 7).fill(0x54534c).circle(-2, -2, 2).fill(0xb9b5a4);
          projectiles.set(p.id, view);
          projectileLayer.addChild(view);
        }
        view.position.set(p.x, p.y);
      }
      for (const [id, view] of projectiles) if (!seenProjectiles.has(id)) {
        view.destroy();
        projectiles.delete(id);
      }
      // A snapshot is also a render tick. This keeps the world visible in
      // embedded previews that throttle requestAnimationFrame in the background.
      if (initialized) render();
    },
    private: (data) => { applyPrivate(hud, data); },
    events: handleEvents,
    leaders: (leaders) => { hud.leaders = leaders; },
    pong: (ping) => { hud.ping = ping; },
    disconnected: (reason) => {
      if (disposed || hud.phase === "title") return;
      hud.phase = "error";
      setNotice(reason);
      emit();
    },
  });

  const join = (name?: string): void => {
    if (hud.phase === "connecting") return;
    const clean = (name ?? hud.name).trim().slice(0, 16) || "Jagunço";
    hud.name = clean;
    try { localStorage.setItem("jagunco.name", clean); } catch { /* storage is optional */ }
    for (const view of players.values()) view.root.destroy({ children: true });
    players.clear();
    pending.length = 0;
    hasServerPosition = false;
    selectedBuild = 0;
    hud = { ...hud, ...initialHud, name: clean, phase: "connecting", muted: audio.muted, leaders: [] };
    connection.connect(clean);
    emit();
  };

  const applyPrediction = (mx: number, my: number, dt: number): void => {
    const length = Math.max(1, Math.hypot(mx, my));
    predicted.x = clamp(predicted.x + mx / length * PLAYER_SPEED * hud.speedMult * dt, PLAYER_RADIUS, MAP_SIZE - PLAYER_RADIUS);
    predicted.y = clamp(predicted.y + my / length * PLAYER_SPEED * hud.speedMult * dt, PLAYER_RADIUS, MAP_SIZE - PLAYER_RADIUS);
    for (const object of objects.values()) {
      if (object.kind === "spike") continue;
      const dx = predicted.x - object.root.x;
      const dy = predicted.y - object.root.y;
      const distance = Math.hypot(dx, dy);
      const radius = object.kind === "tree" ? 46 : object.kind === "bush" ? 34 : 42;
      const minimum = PLAYER_RADIUS + radius;
      if (distance < minimum && distance > 0.001) {
        predicted.x = object.root.x + dx / distance * minimum;
        predicted.y = object.root.y + dy / distance * minimum;
      }
    }
  };

  const stopServerInput = (): void => {
    if (!hasServerPosition) return;
    seq++;
    connection.send(["i", { seq, mx: 0, my: 0, aim, attack: false, build: 0, weapon: selectedWeapon, heal: false }]);
    pending.length = 0;
  };

  const update = (dt: number): void => {
    elapsed += dt;
    if (input.consumeAction("Escape") && (hud.phase === "playing" || hud.paused)) {
      hud.paused = !hud.paused;
      if (hud.paused) stopServerInput();
      emit();
    }
    if (input.consumeAction("KeyM")) {
      hud.muted = audio.toggleMute();
      emit();
    }
    if (hud.phase === "title" && input.consumeAction("Space")) join();
    else if (hud.phase === "dead" && input.consumeAction("Space")) {
      connection.send(["r"]);
      hud.phase = "playing";
      hasServerPosition = false;
      pending.length = 0;
      emit();
    } else if (hud.phase === "playing") {
      // Space is a held attack during play; consume its edge so it cannot respawn us later.
      input.consumeAction("Space");
    }
    if (input.consumeAction("Digit1")) selectedWeapon = 0;
    if (input.consumeAction("Digit2")) selectedWeapon = 1;
    if (input.consumeAction("Digit3")) selectedWeapon = 2;
    if (input.consumeAction("KeyZ")) selectedBuild = 1;
    if (input.consumeAction("KeyX")) selectedBuild = 2;
    if (input.consumeAction("KeyC")) selectedBuild = 3;
    if (input.consumeAction("KeyQ")) healRequested = true;

    const canMove = hud.phase === "playing" && !hud.paused && hasServerPosition;
    if (canMove) {
      const look = input.consumeLook();
      if (Math.abs(look.yaw) > 0.0001) aim += look.yaw;
      else aim = Math.atan2(mouseY - window.innerHeight / 2, mouseX - window.innerWidth / 2);
      seq++;
      const current: InputState = {
        seq, mx: input.moveX, my: -input.moveZ, aim,
        attack: attackHeld || input.isDown("Space") || input.isDown("KeyE"),
        build: selectedBuild, weapon: selectedWeapon, heal: healRequested,
      };
      pending.push({ input: current, dt });
      if (pending.length > 120) pending.shift();
      applyPrediction(current.mx, current.my, dt);
      sendClock += dt;
      if (sendClock >= 1 / 30) {
        sendClock %= 1 / 30;
        connection.send(["i", current]);
        selectedBuild = 0;
        healRequested = false;
      }
    } else {
      selectedBuild = 0;
      healRequested = false;
    }

    for (const view of objects.values()) view.root.alpha = Math.min(1, view.root.alpha + dt * 2.5);
    const localView = players.get(localId);
    if (localView) localView.targetAim = aim;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      p.view.y += p.vy * dt;
      p.view.alpha = Math.max(0, p.life / p.maxLife);
      if (p.life <= 0) {
        p.view.destroy({ children: true });
        particles.splice(i, 1);
      }
    }
    shake = Math.max(0, shake - dt * 18);
    noticeClock -= dt;
    if (noticeClock <= 0 && hud.notice) hud.notice = "";
    hudClock += dt;
    if (hudClock >= 0.12) {
      hudClock = 0;
      emit();
    }
  };

  const render = (): void => {
    if (!initialized || disposed) return;
    for (const [id, view] of players) {
      if (id === localId && hasServerPosition) view.root.position.set(predicted.x, predicted.y);
      else {
        view.root.x += (view.targetX - view.root.x) * 0.18;
        view.root.y += (view.targetY - view.root.y) * 0.18;
      }
      view.body.rotation = view.targetAim;
      const weapon = view.body.children[1];
      if (weapon) weapon.rotation = -view.swing * 0.85;
    }
    for (const view of animals.values()) {
      view.root.x += (view.targetX - view.root.x) * 0.15;
      view.root.y += (view.targetY - view.root.y) * 0.15;
      view.body.rotation = view.targetAim;
    }
    if (hasServerPosition) {
      cameraX += (predicted.x - cameraX) * 0.12;
      cameraY += (predicted.y - cameraY) * 0.12;
    } else {
      cameraX = MAP_SIZE / 2 + Math.cos(elapsed * 0.1) * 120;
      cameraY = MAP_SIZE / 2 + Math.sin(elapsed * 0.12) * 90;
    }
    const scale = clamp(Math.min(window.innerWidth / 1180, window.innerHeight / 760), 0.64, 1.12);
    world.scale.set(scale);
    const sx = shake > 0 ? Math.sin(elapsed * 91) * shake : 0;
    const sy = shake > 0 ? Math.cos(elapsed * 77) * shake : 0;
    world.position.set(window.innerWidth / 2 - cameraX * scale + sx, window.innerHeight / 2 - cameraY * scale + sy);
    app.render();
    if (hasServerPosition && !renderDiagnosticSent) {
      renderDiagnosticSent = true;
      void fetch("/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msg: "jagunco-render",
          ctx: { tick: lastSnapshotTick, players: players.size, objects: objects.size, cameraX, cameraY },
        }),
      }).catch(() => undefined);
    }
    window.__GAME_READY__ = true;
  };

  const loop = new GameLoop({ update, render });
  const onPointerMove = (event: PointerEvent): void => { mouseX = event.clientX; mouseY = event.clientY; };
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button === 0 && !(event.target as HTMLElement).closest("button, input")) attackHeld = true;
  };
  const onPointerUp = (): void => { attackHeld = false; };
  window.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);

  void app.init({
    canvas,
    resizeTo: window,
    background: "#d9c083",
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  }).then(() => {
    if (disposed) { app.destroy(); return; }
    app.stop();
    app.stage.addChild(world);
    initialized = true;
    loop.start();
  }).catch(() => {
    if (!disposed) {
      hud.phase = "error";
      setNotice("Não foi possível iniciar o WebGL 2 neste navegador.");
    }
  });

  const controller: GameController = {
    join,
    setName: (name) => { hud.name = name; emit(); },
    respawn: () => {
      connection.send(["r"]);
      hud.phase = "playing";
      hud.paused = false;
      hasServerPosition = false;
      pending.length = 0;
      emit();
    },
    upgrade: (kind) => connection.send(["u", kind]),
    selectWeapon: (index) => { selectedWeapon = clamp(index, 0, WEAPONS.length - 1); },
    selectBuild: (index) => {
      selectedBuild = hud.build === index ? 0 : clamp(index, 0, BUILDINGS.length - 1);
      hud.build = selectedBuild;
      setNotice(selectedBuild ? `${BUILDINGS[selectedBuild]?.name} será posicionado à sua frente.` : "Construção cancelada.");
    },
    heal: () => { healRequested = true; },
    setAttack: (active) => { attackHeld = active; },
    togglePause: () => {
      if (hud.phase === "playing") {
        hud.paused = !hud.paused;
        if (hud.paused) stopServerInput();
        emit();
      }
    },
    toggleMute: () => { hud.muted = audio.toggleMute(); emit(); },
  };

  window.__gameProbe = () => ({ x: predicted.x, y: 0, z: predicted.y });
  session = {
    dispose: () => {
      disposed = true;
      loop.stop();
      connection.close();
      input.dispose();
      audio.dispose();
      window.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      for (const p of particles) p.view.destroy({ children: true });
      if (initialized) app.destroy(false, { children: true, texture: true, textureSource: true });
      delete window.__gameProbe;
      window.__GAME_READY__ = false;
    },
  };
  return controller;
}

export function stopGame(): void {
  session?.dispose();
  session = null;
}
