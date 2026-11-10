#!/usr/bin/env node
// Built-app regression: authoritative admin state and complete client reconnection.
// Uses synthetic accounts and a loopback TCP proxy to drop a real WebSocket without
// weakening tickets, frame signatures, the code seal, validation or rate limits.
// Chromium: npm run build && CHROME_PATH=/path/to/chrome npm run verify:admin
// Camoufox: Node >=22.15, CAMOUFOX_MODULE=/path/to/camoufox/dist/index.js,
//           SERVER_NODE=/path/to/node20 node scripts/verify-admin-session.mjs --camoufox
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = process.argv.includes("--camoufox") ? "camoufox" : "chromium";
const OUT = path.join(ROOT, "verification-shots");
const OWNER = "SessionOwner";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-admin-session-"));
const SECRET = randomBytes(32).toString("hex");
const results = [], pageErrors = [], httpErrors = [];
const sockets = new Set(), webSockets = new Set();
const watched = new WeakSet();
let browser, server, serverLog = "", proxy, base;
let currentCase = "setup";
const stage = value => console.log(JSON.stringify({ engine: ENGINE, stage: value }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const defaults = { godlike: 0, god: 0, aura: 0, boss: 0, invisible: 0, size: 1, power: 1, speed: 1, health: 1 };

async function until(fn, label, timeout = 15000, interval = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const value = await fn();
        if (value) return value;
        await delay(interval);
    }
    throw new Error("Timeout: " + label);
}
async function check(name, run) {
    currentCase = name;
    const evidence = await run();
    results.push({ name, pass: true, evidence });
    console.log(JSON.stringify({ engine: ENGINE, name, pass: true, evidence }));
}
async function freePort() {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
}
async function consoleCommand(command) {
    const token = fs.readFileSync(path.join(DATA, "admin.token"), "utf8").trim();
    const response = await fetch(base + "/admin/console", {
        method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ command })
    });
    assert.equal(response.status, 200);
    const { lines } = await response.json();
    assert.ok(!lines.some(line => /^error:/.test(line)), "console command rejected: " + command);
    return lines;
}
async function ownerLine() {
    return (await consoleCommand("players")).find(line => line.includes(" " + OWNER + " "));
}
function sid(line) { return Number(/^#(\d+)/.exec(line)[1]); }
function watch(page) {
    if (watched.has(page)) return;
    watched.add(page);
    page.on("pageerror", error => pageErrors.push({ case: currentCase, message: error.message }));
    page.on("response", response => {
        if (response.status() >= 400) httpErrors.push({ case: currentCase, status: response.status(), path: new URL(response.url()).pathname });
    });
}
async function open(page) {
    if (!await page.locator("#adminMenu").isVisible()) await page.locator("#adminButton").click();
    await page.locator("#adminMenu").waitFor({ state: "visible" });
}
const row = (page, label) => page.locator("#adminHolder .adminRow").filter({
    has: page.locator(".adminLabel").filter({ hasText: new RegExp("^" + label + "$") })
});
async function power(page, key, label, on) {
    await open(page);
    const button = row(page, label).locator(".adminBtn");
    if ((await button.textContent()) !== (on ? "Ativado" : "Ativar")) await button.click();
    await until(async () => (await button.textContent()) === (on ? "Ativado" : "Ativar"), "confirmed power " + key);
    await delay(220); // A is limited to 5 requests/s by the first-party protocol.
}
async function multiplier(page, key, label, value) {
    await open(page);
    const select = row(page, label).locator("select");
    await select.click();
    await page.keyboard.press(String(value)); // native select typeahead, never a synthetic change event
    await page.keyboard.press("Enter");
    await until(async () => (await select.inputValue()) === String(value), "confirmed multiplier " + key);
    await delay(220);
}
async function panelState(page) {
    await open(page);
    return page.locator("#adminHolder").evaluate(holder => {
        const powers = Object.fromEntries(Array.from(holder.querySelectorAll("[data-admin-power]"),
            button => [button.dataset.adminPower, button.classList.contains("on") ? 1 : 0]));
        const multipliers = Object.fromEntries(Array.from(holder.querySelectorAll("[data-admin-multiplier]"),
            select => [select.dataset.adminMultiplier, Number(select.value)]));
        return { ...powers, ...multipliers };
    });
}
async function inventoryView(page) {
    return page.evaluate(() => ({
        resources: ["woodDisplay", "foodDisplay", "stoneDisplay", "scoreDisplay"].map(id => document.getElementById(id).textContent),
        bar: Array.from(document.querySelectorAll("#actionBar > *")).filter(element => element.style.display !== "none").map(element => element.id),
        age: document.getElementById("ageText").textContent
    }));
}
async function join(context, page = null) {
    page ||= await context.newPage();
    watch(page);
    stage("page-navigation");
    await page.goto(base);
    stage("page-loaded");
    await page.locator("#enterGame").click();
    stage("enter-clicked");
    await page.locator("body.hud").waitFor();
    await page.locator("#adminButton").waitFor({ state: "visible" });
    await until(async () => /alive.*\(admin\)/.test(await ownerLine()), "signed-in owner joined");
    return page;
}

try {
    assert.ok(fs.existsSync(path.join(ROOT, "dist/boot.js")), "run npm run build first");
    fs.mkdirSync(OUT, { recursive: true });
    process.env.APP_SECRET = SECRET;
    const store = new AccountStore(DATA, { persistence: new FilePersistence({ dataDir: DATA }) });
    await store.ready();
    const seeds = {};
    for (const name of [OWNER, "SessionControl"]) {
        const account = store.accountForEmail(name.toLowerCase() + "@example.test");
        store.claimName(account, name);
        account.role = "admin";
        seeds[name] = { id: account.id, email: account.email, token: store.issueToken(account) };
    }
    store.save();
    await store.closePersistence();

    const backendPort = await freePort();
    proxy = net.createServer(client => {
        const upstream = net.connect(backendPort, "127.0.0.1");
        const pair = { client, upstream };
        sockets.add(pair);
        client.once("data", chunk => {
            if (/upgrade:\s*websocket/i.test(chunk.toString("utf8"))) webSockets.add(pair);
            upstream.write(chunk);
            client.pipe(upstream);
        });
        upstream.pipe(client);
        for (const socket of [client, upstream]) {
            socket.on("error", () => { client.destroy(); upstream.destroy(); });
            socket.on("close", () => {
                sockets.delete(pair); webSockets.delete(pair);
                client.destroy(); upstream.destroy();
            });
        }
    });
    await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
    base = "http://127.0.0.1:" + proxy.address().port;
    const env = { ...process.env, APP_SECRET: SECRET, DATA_DIR: DATA, HOST: "127.0.0.1", PORT: String(backendPort) };
    delete env.DATABASE_URL;
    delete env.NODE_ENV;
    async function startServer() {
        server = spawn(process.env.SERVER_NODE || process.execPath, [path.join(ROOT, "dist/boot.js")], {
            cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"]
        });
        server.stdout.on("data", data => { serverLog += data; });
        server.stderr.on("data", data => { serverLog += data; });
        await until(async () => {
            if (server.exitCode !== null) throw new Error("built server exited");
            try { return (await fetch(base + "/ping", { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
        }, "built server readiness", 30000);
    }
    async function stopServer() {
        if (server && server.exitCode === null && server.signalCode === null) {
            const exited = new Promise(resolve => server.once("exit", resolve));
            server.kill("SIGTERM");
            const timer = setTimeout(() => server.kill("SIGKILL"), 10000);
            await exited;
            clearTimeout(timer);
        }
    }
    stage("server-starting");
    await startServer();
    stage("server-ready");
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
    stage("browser-ready");
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(seed => {
        localStorage.setItem("moo_dev_frvr_token", seed.token);
        localStorage.setItem("moo_local_frvr_session", JSON.stringify(seed));
    }, seeds[OWNER]);
    let page = await join(context);
    await consoleCommand("tp " + OWNER + " 5000 3000");
    const originalSid = sid(await ownerLine());
    await check("built-health-and-admin-acknowledgement", async () => {
        assert.equal((await fetch(base + "/s/LC/ping")).status, 200);
        await power(page, "godlike", "Godlike", true);
        await power(page, "god", "Imortal", false);
        assert.equal((await panelState(page)).godlike, 0);
        assert.equal((await panelState(page)).aura, 1);
        await power(page, "god", "Imortal", true);
        // The real world can damage the player while immortality is disabled.
        // Health multipliers preserve that ratio; establish full health once
        // before testing them rather than assuming the random world was idle.
        await consoleCommand("heal " + OWNER);
        const baseline = await ownerLine();
        assert.ok(baseline.includes("hp 100/100"), "full-health fixture: " + baseline);
        await power(page, "boss", "Chefe", true);
        await power(page, "invisible", "Invisível", true);
        for (const [key, label, value] of [["size", "Tamanho", 2], ["power", "Poder", 5], ["speed", "Velocidade", 2], ["health", "Vida", 5]]) {
            await multiplier(page, key, label, value);
        }
        const authoritative = await until(async () => {
            const line = await ownerLine();
            return line.includes("hp 500/500") && line;
        }, "authoritative health multiplier");
        assert.ok(authoritative.includes("hp 500/500"), authoritative);
        const state = await panelState(page);
        await page.locator(".adminClose").click();
        assert.equal(await page.locator("#adminMenu").isVisible(), false);
        assert.deepEqual(await panelState(page), state);
        return state;
    });
    await check("stocked-inventory-and-console-attributes", async () => {
        for (const label of ["Madeira", "Comida", "Pedra", "Ouro"]) {
            await page.locator("#adminHolder .adminBtn").filter({ hasText: "+10 mil " + label }).click();
            await delay(220);
        }
        await until(async () => (await page.locator("#scoreDisplay").textContent()) === "10000", "gold HUD");
        await consoleCommand("weapon " + OWNER + " great axe ruby");
        await consoleCommand("item " + OWNER + " stone wall");
        await consoleCommand("age " + OWNER + " 8");
        await consoleCommand("hat " + OWNER + " 7 equip");
        await consoleCommand("accessory " + OWNER + " 3 equip");
        await until(async () => (await page.locator("#ageText").textContent()) === "AGE 8", "age HUD");
        await consoleCommand("size " + OWNER + " 4.5");
        await until(async () => (await row(page, "Tamanho").locator("select").inputValue()) === "4.5", "console multiplier");
        await consoleCommand("size " + OWNER + " 2");
        return inventoryView(page);
    });
    const expectedInventory = await inventoryView(page);
    const expectedPanel = await panelState(page);
    async function assertPreserved() {
        assert.equal(sid(await ownerLine()), originalSid);
        assert.ok((await ownerLine()).includes("hp 500/500"));
        assert.deepEqual(await inventoryView(page), expectedInventory);
        assert.deepEqual(await panelState(page), expectedPanel);
    }
    await check("five-reloads-preserve-complete-visible-state", async () => {
        for (let i = 0; i < 5; i++) {
            page = await join(context, page);
            await assertPreserved();
        }
        return { reloads: 5, sid: originalSid };
    });
    await check("second-tab-takeover-preserves-state", async () => {
        const old = page;
        page = await join(context);
        await old.close();
        await assertPreserved();
        assert.equal((await consoleCommand("players")).filter(line => line.includes(" " + OWNER + " ")).length, 1);
        return { sid: originalSid, players: 1 };
    });
    await check("real-websocket-drop-resumes-within-grace", async () => {
        assert.ok(webSockets.size > 0);
        for (const pair of [...webSockets]) { pair.client.destroy(); pair.upstream.destroy(); }
        await until(async () => !await page.locator("#adminButton").isVisible(), "disconnected admin menu");
        assert.ok(await ownerLine(), "player stays in the world during grace");
        page = await join(context, page);
        await assertPreserved();
        return { sid: originalSid, retained: true };
    });
    await page.screenshot({ path: path.join(OUT, "admin-session-" + ENGINE + ".png") });
    await check("live-role-revocation-and-promotion", async () => {
        await consoleCommand("role sessionowner mod");
        await page.locator("#adminButton").waitFor({ state: "hidden" });
        assert.equal(await page.locator("#adminMenu").isVisible(), false);
        const line = await ownerLine();
        assert.match(line, /hp [0-9.]+\/100 /, "new base max health: " + line);
        const response = await fetch(base + "/api/mod/role", {
            method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json" },
            body: JSON.stringify({ auth: seeds.SessionControl.token, name: "SESSIONOWNER", role: "admin" })
        });
        assert.equal(response.status, 403, "public API cannot grant roles");
        assert.equal(await page.locator("#adminButton").isVisible(), false);
        await consoleCommand("role SESSIONOWNER admin");
        await page.locator("#adminButton").waitFor({ state: "visible" });
        assert.deepEqual(await panelState(page), defaults);
        assert.deepEqual(await inventoryView(page), expectedInventory);
        return { hiddenOnRevocation: true, clearedPowers: true, inventoryPreserved: true };
    });
    await check("death-and-new-life-reset-powers", async () => {
        await power(page, "godlike", "Godlike", true);
        await multiplier(page, "size", "Tamanho", 2);
        await multiplier(page, "health", "Vida", 5);
        await consoleCommand("kill " + OWNER);
        await page.locator("#adminButton").waitFor({ state: "hidden" });
        await page.locator("#enterGame").waitFor({ state: "visible" });
        await page.locator("#enterGame").click();
        await page.locator("#adminButton").waitFor({ state: "visible" });
        assert.deepEqual(await panelState(page), defaults);
        const line = await ownerLine();
        assert.match(line, /hp [0-9.]+\/100 /, "new base max health: " + line);
        return { roleRetained: true, powersReset: true };
    });
    await check("real-thirty-second-grace-expiry-starts-new-life", async () => {
        await power(page, "godlike", "Godlike", true);
        await page.close();
        await until(async () => !await ownerLine(), "real grace expiry", 38000, 200);
        page = await join(context);
        assert.deepEqual(await panelState(page), defaults);
        assert.equal(await page.locator("#scoreDisplay").textContent(), "0");
        return { expiredPlayerRemoved: true, freshPowers: true };
    });
    await check("real-process-restart-keeps-role-and-resets-powers", async () => {
        await power(page, "godlike", "Godlike", true);
        await stopServer();
        await startServer();
        page = await join(context, page);
        assert.deepEqual(await panelState(page), defaults);
        assert.equal(await page.locator("#scoreDisplay").textContent(), "0");
        return { accountRole: "admin", newLife: true };
    });
    await check("guest-panel-hidden-and-client-diagnostics", async () => {
        const guest = await browser.newContext();
        const guestPage = await guest.newPage();
        watch(guestPage);
        await guestPage.goto(base);
        await guestPage.locator("#nameInput").fill("SessionGuest");
        await guestPage.locator("#enterGame").click();
        await guestPage.locator("body.hud").waitFor();
        assert.equal(await guestPage.locator("#adminButton").isVisible(), false);
        await guest.close();
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(httpErrors, []);
        return { pageErrors: 0, httpErrors: 0, browser: browser.version() };
    });
    await stopServer();
} catch (error) {
    results.push({ name: currentCase, pass: false, error: error.message });
    console.error(error.stack);
    process.exitCode = 1;
} finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null && server.signalCode === null) {
        const exited = new Promise(resolve => server.once("exit", resolve));
        server.kill("SIGTERM");
        const timer = setTimeout(() => server.kill("SIGKILL"), 10000);
        await exited;
        clearTimeout(timer);
    }
    for (const pair of sockets) { pair.client.destroy(); pair.upstream.destroy(); }
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "admin-session-" + ENGINE + ".json"), JSON.stringify({ results, pageErrors, httpErrors }, null, 2));
    fs.writeFileSync(path.join(OUT, "admin-session-" + ENGINE + ".log"), serverLog);
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(JSON.stringify({ engine: ENGINE, passed: results.filter(row => row.pass).length, failed: results.filter(row => !row.pass).length }));
}
