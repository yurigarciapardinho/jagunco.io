#!/usr/bin/env node
// VERIFY MOBILE / TOUCH
// Proves the rebuilt touch module (dist/official/assets/index-d71d2980.js, nipplejs
// bundled as ESM) works the way the official client uses it:
//
//   1. module contract  — in Chromium, import the built chunk from the server and drive
//      a synthetic pointer drag through a test zone: default export, create({zone}),
//      on("start"/"move"/"end", (evt, data)) with data.force and data.angle.radian.
//   2. real game        — boot dist/boot.js on a scratch port (3400) with a temp
//      DATA_DIR and a test APP_SECRET, open the page with a mobile/touch profile, join
//      as guest, then drag on the left and right halves with real touch input (CDP):
//      the movement and attack joysticks must appear in their zones, the module request
//      must be a 200, input frames must reach the server socket, and the console must
//      stay clean.
//
// Usage: npm run build && node scripts/verify-mobile.mjs
// Exit code 0 = every assertion passed.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "verification-shots");
fs.mkdirSync(SHOTS, { recursive: true });

// Prefer the assigned port 3400, but the workspace is shared: if another process owns
// it, fall back to an ephemeral port instead of testing against someone else's server.
function freePort(preferred) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => {
            const any = net.createServer();
            any.listen(0, "127.0.0.1", () => {
                const port = any.address().port;
                any.close(() => resolve(port));
            });
        });
        probe.listen(preferred, "127.0.0.1", () => probe.close(() => resolve(preferred)));
    });
}
const PORT = await freePort(Number(process.env.VERIFY_PORT ?? 3400));
const BASE = `http://127.0.0.1:${PORT}`;

const failures = [];
const check = (ok, label) => {
    console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}`);
    if (!ok) failures.push(label);
};

// ---------------------------------------------------------------- server
if (!fs.existsSync(path.join(ROOT, "dist/boot.js")) || !fs.existsSync(path.join(ROOT, "dist/official/assets/index-d71d2980.js"))) {
    console.error("VERIFY FAIL: dist/ is incomplete - run `npm run build` first");
    process.exit(1);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-mobile-"));
const server = spawn(process.execPath, [path.join(ROOT, "dist/boot.js")], {
    cwd: ROOT,
    env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        DATA_DIR: dataDir,
        APP_SECRET: "verify-mobile-test-secret"
        // no NODE_ENV=production: that mode requires a MySQL DATABASE_URL; the
        // scratch DATA_DIR uses the development JSON storage instead.
    },
    stdio: ["ignore", "pipe", "pipe"]
});
const serverLog = [];
let serverExit = null;
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));
server.on("exit", (code, signal) => { serverExit = { code, signal }; });

async function waitForServer() {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (serverExit) break;
        try {
            const res = await fetch(BASE + "/", { signal: AbortSignal.timeout(2000) });
            if (res.ok) return;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("server did not come up on " + BASE + "\n" + serverLog.join(""));
}

function assertServerAlive(phase) {
    if (serverExit) {
        throw new Error(`server exited during ${phase} (code ${serverExit.code}, signal ${serverExit.signal})\n`
            + serverLog.slice(-40).join(""));
    }
}

let browser;
async function launch() {
    const candidates = [process.env.CHROME_PATH, process.env.CHROMIUM_PATH, "/usr/bin/chromium"].filter(Boolean);
    try {
        return await chromium.launch({ headless: true });
    } catch { /* fall back to system chromium */ }
    for (const exe of candidates) {
        try {
            return await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox"] });
        } catch { /* next candidate */ }
    }
    throw new Error("no chromium available");
}

// ---------------------------------------------------------------- browser helpers
const consoleErrors = [];
const badResponses = [];
let touchModuleStatus = null;

function watch(page, label) {
    page.setDefaultTimeout(60000);
    page.on("pageerror", (error) => consoleErrors.push(`${label}: pageerror: ${error.message}`));
    page.on("console", (message) => {
        const url = message.location()?.url || "";
        // headless chromium itself probes chrome-extension://invalid/ - not the game
        if (message.type() === "error" && !url.startsWith("chrome-extension://")) {
            consoleErrors.push(`${label}: console: ${message.text()} @ ${url}`);
        }
    });
    page.on("response", (response) => {
        if (response.url().includes("index-d71d2980")) touchModuleStatus = response.status();
        if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
    });
}

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ---------------------------------------------------------------- part 1: module contract
async function verifyModuleContract(context) {
    console.log("== module contract (browser, synthetic pointer drag) ==");
    const page = await context.newPage();
    watch(page, "module");
    // Same-origin blank page so the dynamic import of the chunk is allowed.
    await page.route(`${BASE}/touch-test`, (route) => route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>touch test</title><body></body>"
    }));
    await page.goto(`${BASE}/touch-test`);
    const result = await page.evaluate(async () => {
        const zone = document.createElement("div");
        zone.id = "test-zone";
        Object.assign(zone.style, { position: "fixed", left: "0px", top: "0px", width: "300px", height: "300px" });
        document.body.appendChild(zone);

        const mod = await import("/assets/index-d71d2980.js");
        const out = { hasDefault: !!mod.default, createType: typeof mod.default?.create, events: [], domJoystick: false, errors: [] };
        if (out.createType !== "function") return out;

        const manager = mod.default.create({ zone });
        const events = [];
        manager.on("start", (evt, data) => events.push({ type: evt.type, hasData: !!data }));
        manager.on("move", (evt, data) => events.push({ type: evt.type, force: data?.force, radian: data?.angle?.radian }));
        manager.on("end", (evt, data) => events.push({ type: evt.type, hasData: !!data }));
        out.idsType = Array.isArray(manager.ids) ? "array" : typeof manager.ids;
        out.idsBefore = manager.ids.length;

        const fire = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {
            pointerId: 7, clientX: x, clientY: y, pageX: x, pageY: y,
            buttons: 1, bubbles: true, cancelable: true, isPrimary: true
        }));
        fire(zone, "pointerdown", 150, 150);
        out.idsDuring = manager.ids.length;
        fire(document, "pointermove", 195, 150); // ~45px right: near full force on the default 100px pad
        fire(document, "pointermove", 105, 150); // back across the center
        fire(document, "pointerup", 105, 150);
        out.idsAfter = manager.ids.length;

        out.events = events;
        out.domJoystick = !!zone.querySelector(".joystick");
        return out;
    });

    check(result.hasDefault, "module has a default export");
    check(result.createType === "function", "default export has create()");
    const start = result.events.find((e) => e.type === "start");
    const moves = result.events.filter((e) => e.type === "move");
    const end = result.events.find((e) => e.type === "end");
    check(!!start && start.hasData, "start fired with (evt, data)");
    check(moves.length >= 2, `move fired (${moves.length}x)`);
    const strong = moves.find((e) => typeof e.force === "number" && e.force >= 0.25);
    check(!!strong, `move data.force usable (max ${Math.max(...moves.map((e) => e.force ?? 0)).toFixed(2)})`);
    check(moves.every((e) => typeof e.radian === "number" && Number.isFinite(e.radian)), "move data.angle.radian is a number");
    const right = strong && Math.abs(((strong.radian % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) < 0.4
        || strong && Math.abs(Math.abs(strong.radian) - 2 * Math.PI) < 0.4;
    check(!!right, `dragging right reports radian ~0 / right (got ${strong?.radian?.toFixed(2)})`);
    check(!!end, "end fired");
    check(result.domJoystick, "nipplejs rendered the joystick element inside the zone");
    check(result.idsType === "array" && result.idsBefore === 0 && result.idsDuring === 1 && result.idsAfter === 0,
        `manager.ids tracks the active touch (before/during/after: ${result.idsBefore}/${result.idsDuring}/${result.idsAfter})`);
    await page.close();
}

// ---------------------------------------------------------------- part 2: real game
async function verifyGame(context) {
    console.log("== real game (mobile profile, CDP touch) ==");
    const page = await context.newPage();
    watch(page, "game");
    // Count WebSocket frames the client sends; joystick input must produce frames.
    // Counted through Playwright's protocol events, NOT by patching WebSocket in the
    // page: the client's anti-tamper reports hooked sockets (SOCKET_HOOKED -> kick).
    let sentFrames = 0;
    page.on("websocket", (ws) => ws.on("framesent", () => { sentFrames++; }));
    const sentNow = async () => sentFrames;

    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#enterGame", { state: "visible" });
    await page.fill("#nameInput", "TouchTester");
    await page.click("#enterGame");
    // in game when the menu hides and the HUD shows
    await page.waitForFunction(() => document.body.classList.contains("inGame"), null, { timeout: 60000 });
    assertServerAlive("join");
    check(true, "joined the game as guest (mobile profile)");
    await page.waitForTimeout(1500);

    const cdp = await context.newCDPSession(page);
    // touchEnd must carry an EMPTY touchPoints list: sending the point again keeps the
    // touch pressed and the stick never releases.
    const touch = async (type, id, x, y) => cdp.send("Input.dispatchTouchEvent", {
        type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y, id }]
    });

    // Death / disconnect pops the main menu back over the zones (hostile animals roam
    // a fresh server), which would break the touch checks; respawn instead of flaking.
    const menuState = () => page.evaluate(() => ({
        inGame: document.body.classList.contains("inGame"),
        menu: getComputedStyle(document.getElementById("mainMenu")).display,
        notice: document.getElementById("menuNotice")?.textContent || ""
    }));
    const ensureInGame = async (phase) => {
        if (await page.evaluate(() => document.body.classList.contains("inGame"))) return;
        const state = await menuState();
        console.log(`  (respawning before ${phase}: menu=${state.menu} notice="${state.notice}")`);
        await page.click("#enterGame");
        await page.waitForFunction(() => document.body.classList.contains("inGame"), null, { timeout: 30000 });
        await page.waitForTimeout(800);
    };

    // ---- right half first: aim / attack stick (attacking does not move the player,
    // so this check can't walk the player into a hostile animal before the next one)
    const beforeRight = await sentNow();
    await touch("touchStart", 2, 680, 260);
    await page.waitForTimeout(400);
    const rightJoystick = await page.evaluate(() => {
        const zone = document.getElementById("touch-controls-right");
        if (zone?.querySelector(".joystick")) return true;
        const at = document.elementFromPoint(680, 260);
        console.error(`right stick missing: elementFromPoint=${at ? at.id || at.className || at.tagName : "none"}, zone children=${zone?.children.length}`);
        return false;
    });
    check(rightJoystick, "right touch spawns the aim/attack joystick in #touch-controls-right");
    for (let i = 1; i <= 8; i++) {
        await touch("touchMove", 2, 680, 260 - i * 6); // drag up -> aim/attack up
        await page.waitForTimeout(60);
    }
    await page.waitForTimeout(400);
    const duringRight = await sentNow();
    await page.screenshot({ path: path.join(SHOTS, "mobile-right-stick.png") });
    await touch("touchEnd", 2, 680, 212);
    check(duringRight > beforeRight, `aim/attack stick sends input frames (${beforeRight} -> ${duringRight})`);
    if (!rightJoystick) console.error("  menu state at failure:", await menuState());

    // ---- left half: movement stick
    await ensureInGame("movement stick");
    const before = await sentNow();
    await touch("touchStart", 1, 160, 260);
    await page.waitForTimeout(400);
    const leftJoystick = await page.evaluate(() => {
        const zone = document.getElementById("touch-controls-left");
        return !!zone?.querySelector(".joystick");
    });
    check(leftJoystick, "left touch spawns the movement joystick in #touch-controls-left");
    await page.screenshot({ path: path.join(SHOTS, "mobile-left-stick.png") });
    for (let i = 1; i <= 8; i++) {
        await touch("touchMove", 1, 160 + i * 6, 260); // drag right -> move right
        await page.waitForTimeout(60);
    }
    await page.waitForTimeout(400);
    const duringLeft = await sentNow();
    await touch("touchEnd", 1, 208, 260);
    check(duringLeft > before, `movement stick sends input frames (${before} -> ${duringLeft})`);
    if (!leftJoystick) console.error("  menu state at failure:", await menuState());

    // ---- module delivery + hygiene
    assertServerAlive("touch checks");
    check(touchModuleStatus === 200, `/assets/index-d71d2980.js served with HTTP ${touchModuleStatus ?? "never requested"}`);
    await page.waitForTimeout(500);
    await page.close();
}

// ---------------------------------------------------------------- run
try {
    await waitForServer();
    console.log(`server up on ${BASE} (DATA_DIR=${dataDir})`);
    browser = await launch();
    const context = await browser.newContext({
        viewport: { width: 844, height: 390 },
        isMobile: true,
        hasTouch: true,
        userAgent: MOBILE_UA,
        deviceScaleFactor: 2
    });
    await verifyModuleContract(context);
    await verifyGame(context);
    const gameErrors = consoleErrors.filter((e) => e.startsWith("game:"));
    check(gameErrors.length === 0, `no console/page errors while playing${gameErrors.length ? ":\n    " + gameErrors.join("\n    ") : ""}`);
    check(badResponses.length === 0, `no HTTP >= 400 responses${badResponses.length ? ":\n    " + badResponses.join("\n    ") : ""}`);
} catch (error) {
    console.error("VERIFY ERROR:", error.message);
    console.error("--- server log tail ---\n" + serverLog.slice(-30).join(""));
    failures.push(error.message);
} finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) {
    console.error(`\nVERIFY FAIL (${failures.length}):`);
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
}
console.log("\nVERIFY OK: touch module serves, joysticks work, movement and aim/attack send input, console clean");
