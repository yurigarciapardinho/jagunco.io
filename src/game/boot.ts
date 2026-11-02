/**
 * boot.ts — minimal bootstrap scene (placeholder only — **replace it wholesale with your game**).
 * Purpose: prove the build/render/input pipeline works, and give scripts/verify-game.mjs a direction probe.
 *
 * Contract with the React shell (src/pages/Home.tsx):
 *   startGame(canvas)  mounts renderer + loop onto an existing <canvas>
 *   stopGame()         tears everything down (loop, renderer, listeners, probe)
 * Calling startGame twice is safe: the previous session is stopped first, so React
 * StrictMode's double mount in dev never leaves two renderers alive.
 *
 * engine/state/input/audio/storage/config/types in this directory are reusable base components —
 * take what you need; this file itself should stay as simple as possible.
 */

import * as THREE from "three";
import { GameLoop } from "./engine";
import { Input } from "./input";

declare global {
  interface Window {
    /** Player-coordinate probe — scripts/verify-game.mjs asserts direction mapping through it. Keep it when you replace this file. */
    __gameProbe?: () => { x: number; y: number; z: number };
    /** Readiness signal — the self-check waits for it before screenshotting/asserting. */
    __GAME_READY__?: boolean;
  }
}

let session: { dispose: () => void } | null = null;

export function startGame(canvas: HTMLCanvasElement): void {
  stopGame();

  const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e12);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.position.set(0, 2, 5);
  camera.lookAt(0, 0.5, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(4, 8, 3);
  scene.add(sun);

  const floorGeo = new THREE.PlaneGeometry(30, 30);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x22303c });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const moverGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
  const moverMat = new THREE.MeshStandardMaterial({ color: 0x8df0c1 });
  const mover = new THREE.Mesh(moverGeo, moverMat);
  mover.position.y = 0.3;
  scene.add(mover);

  const input = new Input(canvas);
  let yaw = 0;
  const SPEED = 4;

  const loop = new GameLoop({
    update: (dt) => {
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      mover.position.x += (input.moveX * cos - input.moveZ * sin) * SPEED * dt;
      mover.position.z += (-input.moveX * sin - input.moveZ * cos) * SPEED * dt;
      mover.rotation.y += dt;
      yaw += input.consumeLook().yaw;
    },
    render: () => {
      camera.position.set(
        mover.position.x + 5 * Math.sin(yaw),
        mover.position.y + 2.5,
        mover.position.z + 5 * Math.cos(yaw),
      );
      camera.lookAt(mover.position.x, mover.position.y + 0.5, mover.position.z);
      renderer.render(scene, camera);
      window.__GAME_READY__ = true; // first rendered frame = the page is playable
    },
  });
  loop.start();

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  };
  window.addEventListener("resize", onResize);

  // self-check probe: scripts/verify-game.mjs uses it for direction assertions (keep it the same way when replacing this file)
  window.__gameProbe = () => ({ x: mover.position.x, y: mover.position.y, z: mover.position.z });

  session = {
    dispose: () => {
      loop.stop();
      window.removeEventListener("resize", onResize);
      input.dispose();
      floorGeo.dispose();
      floorMat.dispose();
      moverGeo.dispose();
      moverMat.dispose();
      renderer.dispose();
      delete window.__gameProbe;
      window.__GAME_READY__ = false;
    },
  };
}

export function stopGame(): void {
  session?.dispose();
  session = null;
}
