import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const base = process.env.GAME_URL || "http://127.0.0.1:3000";
const shots = new URL("../verification-shots/", import.meta.url).pathname;
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
const errors = [];
const badResponses = [];

function watch(page, label) {
  page.setDefaultTimeout(90000);
  page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${label}: ${message.text()}`); });
  page.on("response", (response) => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });
}

async function pos(page) {
  return page.evaluate(() => window.__gameProbe?.());
}

async function moveBy(page, dx, dy) {
  if (Math.abs(dx) > 12) {
    const key = dx > 0 ? "KeyD" : "KeyA";
    await page.keyboard.down(key);
    await page.waitForTimeout(Math.min(1400, Math.abs(dx) / 270 * 1000));
    await page.keyboard.up(key);
  }
  if (Math.abs(dy) > 12) {
    const key = dy > 0 ? "KeyS" : "KeyW";
    await page.keyboard.down(key);
    await page.waitForTimeout(Math.min(1400, Math.abs(dy) / 270 * 1000));
    await page.keyboard.up(key);
  }
}

async function moveTo(page, target, tolerance = 65) {
  for (let i = 0; i < 6; i++) {
    const current = await pos(page);
    if (!current) throw new Error("Probe unavailable");
    const dx = target.x - current.x;
    const dy = target.y - current.z;
    if (Math.hypot(dx, dy) <= tolerance) return;
    await moveBy(page, dx, dy);
    await page.waitForTimeout(180);
  }
}

async function aimAt(page, from, target) {
  const dx = target.x - from.x;
  const dy = target.y - from.z;
  const length = Math.max(1, Math.hypot(dx, dy));
  await page.mouse.move(640 + dx / length * 220, 400 + dy / length * 220);
}

const contextA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const a = await contextA.newPage();
watch(a, "A");
await a.goto(base, { waitUntil: "domcontentloaded", timeout: 90000 });
await a.waitForFunction(() => window.__GAME_READY__ === true);
await a.screenshot({ path: `${shots}/01-title.png` });
await a.getByLabel("Nome do jogador").fill("Lampião Teste");
await a.getByRole("button", { name: /ENTRAR NA SALA/ }).click();
await a.locator(".status-panel").waitFor({ timeout: 10000 });
await a.waitForTimeout(600);

// The ranged branch is locked until its level-three choice, and the shop
// communicates authoritative gold requirements instead of faking a purchase.
if (!(await a.locator(".hotbar-slot").nth(2).isDisabled())) throw new Error("Slingshot started unlocked");
await a.getByTestId("shop-button").click();
await a.getByTestId("shop-panel").waitFor();
if (await a.getByTestId("shop-panel").getByText("100", { exact: true }).count() < 1) throw new Error("Shop price missing");
await a.screenshot({ path: `${shots}/02-shop.png` });
await a.getByTestId("shop-item-strawHat").click();
await a.waitForFunction(() => document.querySelector(".notice")?.textContent?.includes("Faltam 100"), null, { timeout: 5000 });
await a.keyboard.press("KeyB");
await a.getByTestId("shop-panel").waitFor({ state: "hidden" });

const beforeW = await pos(a);
await a.keyboard.down("KeyW");
await a.waitForTimeout(350);
await a.keyboard.up("KeyW");
const afterW = await pos(a);
if (!beforeW || !afterW || afterW.z >= beforeW.z - 5) throw new Error(`W mapping failed: ${JSON.stringify({ beforeW, afterW })}`);
const beforeD = await pos(a);
await a.keyboard.down("KeyD");
await a.waitForTimeout(350);
await a.keyboard.up("KeyD");
const afterD = await pos(a);
if (!beforeD || !afterD || afterD.x <= beforeD.x + 5) throw new Error(`D mapping failed: ${JSON.stringify({ beforeD, afterD })}`);
await a.screenshot({ path: `${shots}/02-gameplay.png` });

// Gather from the deterministic starter tree west of the map center.
await moveTo(a, { x: 3200 - 260, y: 3200 - 90 }, 30);
let gatherPos = await pos(a);
await aimAt(a, gatherPos, { x: 3200 - 185, y: 3200 - 90 });
const woodBefore = await a.locator(".resource-grid > div").first().locator("b").textContent();
await a.keyboard.down("Space");
await a.waitForTimeout(1200);
await a.keyboard.up("Space");
await a.waitForTimeout(300);
const woodAfter = await a.locator(".resource-grid > div").first().locator("b").textContent();
if (!(Number(woodAfter) > Number(woodBefore))) throw new Error(`Gathering failed: ${woodBefore} -> ${woodAfter}`);

// Building must be server-validated; a fresh player cannot afford a mill.
await a.getByRole("button", { name: /MOINHO/ }).click();
await a.waitForTimeout(350);
const notice = await a.locator(".notice").textContent().catch(() => "");
if (!/Recursos insuficientes|será posicionado/.test(notice || "")) throw new Error("Build feedback missing");

await a.getByRole("button", { name: "Pausar" }).click();
await a.getByText("JOGO PAUSADO").waitFor();
await a.screenshot({ path: `${shots}/03-paused.png` });
await a.getByRole("button", { name: /CONTINUAR/ }).click();
await a.getByRole("button", { name: "Silenciar" }).click();
await a.getByRole("button", { name: "Ativar som" }).waitFor();
await a.getByRole("button", { name: "Ativar som" }).click();

const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const b = await contextB.newPage();
watch(b, "B");
await b.goto(base, { waitUntil: "domcontentloaded", timeout: 90000 });
await b.waitForFunction(() => window.__GAME_READY__ === true);
await b.getByLabel("Nome do jogador").fill("Volante Teste");
await b.getByRole("button", { name: /ENTRAR NA SALA/ }).click();
await b.locator(".status-panel").waitFor({ timeout: 10000 });
await a.waitForFunction(() => {
  const text = document.querySelector(".leaderboard")?.textContent ?? "";
  return text.includes("Volante Teste") && text.includes("Lampião Teste");
}, null, { timeout: 15000 });
const board = await a.locator(".leaderboard").textContent();
if (!board?.includes("Volante Teste") || !board.includes("Lampião Teste")) throw new Error(`Shared leaderboard failed: ${board}`);
await a.screenshot({ path: `${shots}/04-two-players.png` });

// Bring B to A and exercise real server-authoritative PvP to death.
const targetA = await pos(a);
await moveTo(b, { x: targetA.x, y: targetA.z }, 72);
const posB = await pos(b);
const currentA = await pos(a);
await aimAt(b, posB, { x: currentA.x, y: currentA.z });
await b.keyboard.down("Space");
await b.waitForTimeout(4200);
await b.keyboard.up("Space");
await a.getByText("VOCÊ CAIU NO SERTÃO").waitFor({ timeout: 8000 });
await a.screenshot({ path: `${shots}/05-death.png` });
await a.getByRole("button", { name: /VOLTAR AO SERTÃO/ }).click();
await a.locator(".status-panel").waitFor();
await a.waitForFunction(() => Number(document.querySelector(".health-row b")?.textContent) === 100, null, { timeout: 10000 });
if (await a.getByText("VOCÊ CAIU NO SERTÃO").count()) throw new Error("Respawn did not clear death state");

const health = await a.locator(".health-row b").textContent();
console.log(JSON.stringify({
  ok: true,
  direction: true,
  wood: [Number(woodBefore), Number(woodAfter)],
  multiplayer: true,
  pvpDeathRespawn: true,
  healthAfterRespawn: health,
  consoleErrors: errors,
  badResponses,
}, null, 2));
if (errors.length || badResponses.length) throw new Error("Browser console or HTTP errors detected");
await browser.close();
