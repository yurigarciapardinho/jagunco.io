#!/usr/bin/env node
// Built-app cave acceptance through native browser input and the owner's console.
// Synthetic accounts, loopback server and signed normal joins; no protocol bypass.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { AccountStore } from "../server/src/api/store.js";
import { FilePersistence } from "../server/src/persistence/fileDriver.js";
import { items } from "../server/src/moomoo/modules/items.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = process.argv.includes("--camoufox") ? "camoufox" : "chromium";
const OUT = path.join(ROOT, "verification-shots");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-cave-"));
const SECRET = randomBytes(32).toString("hex");
const OWNER = "CaveOwner", GUEST = "CaveGuest", MOBILE = "CaveMobile";
const errors = [], badResponses = [], results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, server, base, serverLog = "", currentCase = "setup";

async function until(fn, label, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await fn();
        if (value) return value;
        await delay(120);
    }
    throw new Error("Timeout: " + label);
}
async function check(name, run) {
    currentCase = name;
    const evidence = await run();
    results.push({ name, pass: true, evidence });
    console.log(JSON.stringify({ engine: ENGINE, name, pass: true, evidence }));
}
async function command(command) {
    const token = fs.readFileSync(path.join(DATA, "admin.token"), "utf8").trim();
    const response = await fetch(base + "/admin/console", {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ command })
    });
    assert.equal(response.status, 200);
    const { lines } = await response.json();
    assert.ok(!lines.some(line => /^error:/i.test(line)), command + ": " + lines.join("; "));
    return lines;
}
async function position(name) {
    const [line] = await command("where " + name);
    const [, x, y] = /is at (-?[\d.]+), (-?[\d.]+)/.exec(line);
    return { x: Number(x), y: Number(y) };
}
async function animal(name) {
    const lines = await command("boss " + name + " status");
    const match = /at (-?[\d.]+), (-?[\d.]+) hp ([\d.]+)\/([\d.]+)/.exec(lines[0]);
    return match ? { x: +match[1], y: +match[2], health: +match[3], maxHealth: +match[4] } : { waiting: true };
}
async function playerLine(name) {
    return (await command("players")).find(line => line.includes(" " + name + " "));
}
function watch(page) {
    page.on("pageerror", error => errors.push({ case: currentCase, message: error.message }));
    page.on("response", response => {
        if (response.status() >= 400) badResponses.push({ case: currentCase, status: response.status(), path: new URL(response.url()).pathname });
    });
}
async function join(context, name, page) {
    page ||= await context.newPage();
    watch(page);
    await page.goto(base);
    if (!(await page.locator("#nameInput").inputValue())) await page.locator("#nameInput").fill(name);
    const enter = page.locator("#enterGame");
    if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await enter.tap();
    else await enter.click();
    try { await page.locator("body.hud").waitFor(); }
    catch (error) {
        console.error(JSON.stringify(await page.evaluate(() => ({ name: document.getElementById("nameInput")?.value, notice: document.getElementById("menuNotice")?.textContent, menu: document.getElementById("menuDialog")?.innerText, loading: document.getElementById("loadingText")?.textContent, button: document.getElementById("enterGame")?.outerHTML, body: document.body.className }))));
        await page.screenshot({ path: path.join(OUT, "cave-" + ENGINE + "-join-failure.png") });
        throw error;
    }
    await until(async () => /alive/.test(await playerLine(name)), "joined " + name);
    return page;
}
async function hold(page, key, predicate, label, timeout = 8000) {
    await page.keyboard.down(key);
    try { return await until(predicate, label, timeout); }
    finally { await page.keyboard.up(key); }
}
async function screenshot(page, name) {
    await delay(350);
    await page.screenshot({ path: path.join(OUT, "cave-" + ENGINE + "-" + name + ".png") });
}

try {
    assert.ok(fs.existsSync(path.join(ROOT, "dist/boot.js")), "run npm run build first");
    fs.mkdirSync(OUT, { recursive: true });
    process.env.APP_SECRET = SECRET;
    const store = new AccountStore(DATA, { persistence: new FilePersistence({ dataDir: DATA }) });
    await store.ready();
    const seeds = {};
    for (const name of [OWNER, GUEST, MOBILE]) {
        const account = store.accountForEmail(name.toLowerCase() + "@example.test");
        assert.equal(store.claimName(account, name).status, 200, "allowed synthetic name: " + name);
        account.role = name === OWNER ? "admin" : null;
        seeds[name] = { id: account.id, email: account.email, token: store.issueToken(account) };
    }
    store.save();
    await store.closePersistence();
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    base = "http://127.0.0.1:" + port;
    const env = { ...process.env, APP_SECRET: SECRET, DATA_DIR: DATA, HOST: "127.0.0.1", PORT: String(port) };
    delete env.NODE_ENV;
    delete env.DATABASE_URL;
    server = spawn(process.env.SERVER_NODE || process.execPath, [path.join(ROOT, "dist/boot.js")], {
        cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"]
    });
    server.stdout.on("data", data => { serverLog += data; });
    server.stderr.on("data", data => { serverLog += data; });
    await until(async () => {
        if (server.exitCode !== null) throw new Error("built server exited");
        try { return (await fetch(base + "/ping", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, "built server ready", 30000);
    if (ENGINE === "camoufox") {
        assert.ok(process.env.CAMOUFOX_MODULE, "set CAMOUFOX_MODULE to the isolated QA installation");
        const { Camoufox } = await import(process.env.CAMOUFOX_MODULE);
        browser = await Camoufox({ headless: true, os: "linux", canvas_noise: false });
    } else {
        browser = await chromium.launch({
            headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
            args: ["--no-sandbox"]
        });
    }
    async function contextFor(name, options = {}) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
        await context.addInitScript(seed => {
            localStorage.setItem("moo_dev_frvr_token", seed.token);
            localStorage.setItem("moo_local_frvr_session", JSON.stringify(seed));
        }, seeds[name]);
        return context;
    }
    const ownerContext = await contextFor(OWNER);
    const owner = await join(ownerContext, OWNER);
    const guestContext = await contextFor(GUEST);
    const guest = await join(guestContext, GUEST);
    await command("me " + OWNER);
    const gameKey = /\[([^\]]+)\]/.exec(await playerLine(OWNER))[1];
    assert.equal(/\[([^\]]+)\]/.exec(await playerLine(GUEST))[1], gameKey, "the controlled participants share one server");
    await command("god " + OWNER + " on");
    await command("god " + GUEST + " on");
    await command("tp " + OWNER + " 2600 5150");
    await command("tp " + GUEST + " 6000 4000");

    await check("one-natural-trio-and-open-entrance", async () => {
        const lines = await command("animals " + gameKey);
        for (const label of ["MOOSTAFA", "MOOFIE", "Treasure"]) {
            assert.ok(lines[0].includes(label + " x1"), lines[0]);
        }
        await command("invisible " + OWNER + " on");
        await hold(owner, "w", async () => (await position(OWNER)).y < 4760, "walk through southern opening");
        const inside = await position(OWNER);
        await hold(owner, "s", async () => (await position(OWNER)).y > 5100, "retreat through southern opening");
        const outside = await position(OWNER);
        await screenshot(owner, "entrance");
        return { inside, outside, counts: lines[0] };
    });
    await check("fast-native-input-cannot-cross-west-wall", async () => {
        await command("tp " + OWNER + " 1300 3500");
        await command("speed " + OWNER + " 5");
        await owner.keyboard.down("d");
        await delay(1600);
        await owner.keyboard.up("d");
        const p = await position(OWNER);
        assert.ok(p.x <= 1366 && p.x >= 1290, JSON.stringify(p));
        await command("speed " + OWNER + " 1");
        await screenshot(owner, "west-wall");
        return p;
    });
    await check("guardians-follow-but-remain-inside", async () => {
        await command("tp " + OWNER + " 6000 4000");
        await command("boss moostafa reset");
        await command("boss moofie reset");
        // Provoke through a real melee hit: a natural idle wander must not make
        // acquisition timing decide whether the confinement scenario is exercised.
        const guardianHealth = (await animal("moostafa")).health;
        let provoked = false;
        for (let attempt = 0; attempt < 3 && !provoked; attempt++) {
            const guardian = await animal("moostafa");
            await command("tp " + GUEST + " " + (guardian.x + 150) + " " + guardian.y);
            await delay(350);
            await guest.mouse.move(440, 450);
            await guest.mouse.down();
            await delay(400);
            await guest.mouse.up();
            provoked = (await animal("moostafa")).health < guardianHealth;
        }
        assert.ok(provoked, "native attack provokes MOOSTAFA before the retreat");
        await command("speed " + GUEST + " 2");
        let horizontal = null;
        await guest.keyboard.down("s");
        try {
            await until(async () => {
                const p = await position(GUEST);
                const key = p.x < 2530 ? "d" : p.x > 2670 ? "a" : null;
                if (key !== horizontal) {
                    if (horizontal) await guest.keyboard.up(horizontal);
                    if (key) await guest.keyboard.down(key);
                    horizontal = key;
                }
                return p.y > 5300;
            }, "lure steers through the opening", 15000);
        } finally {
            await guest.keyboard.up("s");
            if (horizontal) await guest.keyboard.up(horizontal);
        }
        await command("speed " + GUEST + " 1");
        await delay(3000);
        const moostafa = await animal("moostafa"), moofie = await animal("moofie");
        assert.ok(moostafa.y <= 4793 && moofie.y <= 4783);
        assert.ok(moostafa.y > 4200 || moofie.y > 4200, "at least one guardian followed the lure");
        await screenshot(guest, "guardians");
        return { lure: await position(GUEST), moostafa, moofie };
    });
    await check("treasure-is-attackable-with-living-guardians", async () => {
        await command("tp " + GUEST + " 6000 4000");
        await command("boss treasure reset");
        await command("tp " + OWNER + " 2752 3168");
        const before = await animal("treasure");
        await delay(500);
        await owner.mouse.move(440, 450);
        await owner.mouse.down();
        await delay(400);
        await owner.mouse.up();
        const after = await until(async () => {
            const a = await animal("treasure");
            return a.health < before.health && a;
        }, "Treasure damage while guardians are alive");
        assert.ok(!(await animal("moostafa")).waiting && !(await animal("moofie")).waiting);
        await screenshot(owner, "treasure");
        await command("boss treasure hp 1");
        await command("damage " + OWNER + " 100");
        await owner.mouse.down();
        await delay(700);
        await owner.mouse.up();
        await until(async () => (await animal("treasure")).waiting, "Treasure defeated");
        const gold = Number((await owner.locator("#scoreDisplay").textContent()).replace(/[^\d]/g, ""));
        assert.equal(gold, 5000);
        await command("damage " + OWNER + " 1");
        return { before, after, gold, guardiansAlive: true };
    });
    await check("entrance-building-has-no-cost-and-ordinary-build-works", async () => {
        await command("give " + OWNER + " wood 1000");
        await until(async () => (await owner.locator("#woodDisplay").textContent()) === "1000", "authoritative wood acknowledgement");
        await command("item " + OWNER + " wood wall");
        const wall = items.list.find(item => item.name === "wood wall");
        const bar = owner.locator("#actionBarItem" + (items.weapons.length + wall.id));
        await command("tp " + OWNER + " 2600 5150");
        const before = await owner.locator("#woodDisplay").textContent();
        await bar.click();
        await owner.mouse.move(640, 250);
        await owner.mouse.down();
        await delay(250);
        await owner.mouse.up();
        assert.equal(await owner.locator("#woodDisplay").textContent(), before);
        await owner.locator("#actionBarItem0").click();
        await command("tp " + OWNER + " 2000 3400");
        await delay(350);
        await bar.click();
        await owner.mouse.move(840, 450);
        await owner.mouse.down();
        await delay(250);
        await owner.mouse.up();
        await until(async () => (await owner.locator("#woodDisplay").textContent()) !== before, "ordinary building spends wood");
        await owner.locator("#actionBarItem0").click();
        return { entranceWood: before, outsideWood: await owner.locator("#woodDisplay").textContent() };
    });
    await check("reconnect-inside-preserves-player-and-cave", async () => {
        await command("tp " + OWNER + " 2600 3500");
        await delay(400);
        const before = await playerLine(OWNER);
        const sid = /^#\d+/.exec(before)[0];
        await join(ownerContext, OWNER, owner);
        await delay(600);
        assert.equal(/^#\d+/.exec(await playerLine(OWNER))[0], sid);
        assert.equal(await owner.locator("#scoreDisplay").textContent(), "5000");
        const p = await position(OWNER);
        assert.ok(Math.abs(p.x - 2600) < 5 && Math.abs(p.y - 3500) < 5);
        await screenshot(owner, "reconnect");
        return { sid, position: p, gold: 5000 };
    });

    await guestContext.close();
    if (ENGINE === "chromium") await check("mobile-touch-entry-wall-and-orientation", async () => {
        const context = await contextFor(MOBILE, {
            viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
            userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        });
        const page = await join(context, MOBILE);
        await command("god " + MOBILE + " on");
        await command("invisible " + MOBILE + " on");
        await command("tp " + MOBILE + " 2600 5150");
        const cdp = await context.newCDPSession(page);
        const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", {
            type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 }]
        });
        await delay(400);
        await touch("touchStart", 160, 260);
        await touch("touchMove", 160, 205);
        try { await until(async () => (await position(MOBILE)).y < 4800, "touch enters cave"); }
        finally { await touch("touchEnd", 160, 205); }
        const inside = await position(MOBILE);
        await screenshot(page, "mobile-entrance");
        await command("tp " + MOBILE + " 1300 3500");
        await touch("touchStart", 160, 260);
        await touch("touchMove", 215, 260);
        await delay(1800);
        await touch("touchEnd", 215, 260);
        const wall = await position(MOBILE);
        assert.ok(wall.x <= 1366 && wall.x >= 1290);
        await command("tp " + MOBILE + " 2600 4600");
        await page.setViewportSize({ width: 390, height: 844 });
        await delay(500);
        assert.ok(await page.locator("#touch-controls-left").isVisible());
        assert.ok(await page.locator("#touch-controls-right").isVisible());
        await screenshot(page, "mobile-portrait");
        await context.close();
        return { inside, wall, portrait: { width: 390, height: 844 } };
    });
    await check("browser-and-delivery-hygiene", async () => {
        assert.deepEqual(errors, []);
        assert.deepEqual(badResponses, []);
        assert.equal(server.exitCode, null);
        return { pageErrors: 0, httpFailures: 0 };
    });
} catch (error) {
    results.push({ name: currentCase, pass: false, message: error.message });
    console.error(error.stack);
    console.error(serverLog.slice(-3000));
    process.exitCode = 1;
} finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null && server.signalCode === null) {
        const exited = new Promise(resolve => server.once("exit", resolve));
        server.kill("SIGTERM");
        const timer = setTimeout(() => server.kill("SIGKILL"), 8000);
        await exited;
        clearTimeout(timer);
    }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "cave-" + ENGINE + "-results.json"), JSON.stringify({ engine: ENGINE, results, errors, badResponses }, null, 2));
    fs.rmSync(DATA, { recursive: true, force: true });
}
