// Build-time adapter: use the actual client renderer, outside the public app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import contract from "../shared/control-contract.js";
import { AI_TYPES } from "../server/src/moomoo/modules/aiManager.js";
import configModule from "../shared/config.js";
import itemsModule from "../shared/config/items.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = configModule.config || configModule;
const items = itemsModule.items || itemsModule;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "jagunco-renderer-"));
const out = path.join(ROOT, "dist/control-assets");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let child, browser;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const official = path.join(temp, "official");
  fs.cpSync(path.join(ROOT, "dist/official"), official, { recursive: true });
  const name = fs
    .readdirSync(path.join(official, "assets"))
    .find(n => /^index-[\w-]+\.js$/.test(n) && !n.includes("d71d2980"));
  if (!name)
    throw new Error("Cliente precisa ser construído antes da exportação");
  const file = path.join(official, "assets", name),
    original = fs.readFileSync(file, "utf8");
  const resource = "function n2(e){const t=e.y>=E.mapScale-E.snowBiomeTop?2:";
  const item = "function Ql(e,t){let n=zr[e.id];";
  for (const anchor of [resource, item]) {
    if (original.split(anchor).length !== 2)
      throw new Error("Anchor do renderer mudou: " + anchor);
  }
  fs.appendFileSync(
    file,
    `\nObject.defineProperty(globalThis,"__JAGUNCO_RENDERER_EXPORT__",{value:Object.freeze({resource:e=>n2(e),item:id=>Ql(N.list[id]),clearResources:()=>{for(const k of Object.keys(qs))delete qs[k]}})});\n`
  );
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const dataDir = path.join(temp, "data");
  fs.mkdirSync(dataDir);
  const env = {
    ...process.env,
    NODE_ENV: "development",
    APP_PURPOSE: "asset-export",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    PROTOCOL_OUTPUT_DIR: path.join(temp, "protocol"),
    OFFICIAL_CLIENT_DIR: official,
    APP_SECRET: randomBytes(32).toString("hex"),
    OWNER_EMAIL: "",
  };
  for (const key of [
    "DATABASE_URL",
    "DATABASE_URL_FILE",
    "APP_SECRET_FILE",
    "CONTROL_SOCKET",
    "CONTROL_SECRET",
    "CONTROL_SECRET_FILE",
    "MIGRATION_DATABASE_URL",
    "MIGRATION_DATABASE_URL_FILE",
  ])
    delete env[key];
  const log = fs.openSync(path.join(temp, "server.log"), "w");
  child = spawn(process.execPath, [path.join(ROOT, "dist/boot.js")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", log, log],
  });
  const base = "http://127.0.0.1:" + port;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/ping")).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null)
      throw new Error("Processo de exportação encerrou antes da prontidão");
    await wait(100);
  }
  if (!ready) throw new Error("Exportação sem prontidão");
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  await page.goto(base);
  await page.waitForFunction(() => !!globalThis.__JAGUNCO_RENDERER_EXPORT__);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const definitions = [];
  for (const [type, scales] of [
    [0, config.treeScales],
    [1, config.bushScales],
    [2, config.rockScales],
    [3, config.rockScales],
  ]) {
    for (const scale of scales)
      for (const biome of [0, 1, 2])
        for (const variant of [0, 1]) {
          if (type === 0 && biome === 2) continue;
          definitions.push({
            key: `resource-${type}-${scale}-${biome}-${variant}`,
            resource: {
              type,
              scale,
              sid: variant,
              y: biome === 2 ? config.mapScale - 50 : biome === 1 ? 50 : 4000,
            },
          });
        }
  }
  for (const item of items.list)
    if (!item.consume)
      definitions.push({ key: "building-" + item.id, item: item.id });
  const sprites = [];
  for (const definition of definitions) {
    const rendered = await page.evaluate(def => {
      const renderer = globalThis.__JAGUNCO_RENDERER_EXPORT__;
      renderer.clearResources();
      const canvas = def.resource
        ? renderer.resource(def.resource)
        : renderer.item(def.item);
      const data = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]) painted++;
      return {
        width: canvas.width,
        height: canvas.height,
        painted,
        url: canvas.toDataURL("image/png"),
      };
    }, definition);
    if (rendered.painted < 100 || rendered.width < 8 || rendered.height < 8)
      throw new Error("Sprite vazio: " + definition.key);
    const bytes = Buffer.from(rendered.url.split(",")[1], "base64");
    const name = definition.key + ".png";
    fs.writeFileSync(path.join(out, name), bytes);
    sprites.push({
      ...definition,
      file: name,
      width: rendered.width,
      height: rendered.height,
      painted: rendered.painted,
      sha256: sha(bytes),
    });
  }
  const animals = [];
  for (const a of AI_TYPES) {
    const name = a.src + ".png",
      source = path.join(ROOT, "dist/public/img/animals", name);
    if (!fs.existsSync(source))
      throw new Error("Asset de animal ausente: " + name);
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(path.join(out, name), bytes);
    animals.push({
      id: a.id,
      name: a.name || a.src,
      src: name,
      scale: a.scale,
      spriteMlt: a.spriteMlt || 1,
      sha256: sha(bytes),
      killScore: a.killScore,
      drop: a.drop,
    });
  }
  // JSON is the UI contract; validation remains authoritative in the game.
  fs.writeFileSync(
    path.join(out, "catalog.json"),
    JSON.stringify(
      {
        ...contract.catalog(),
        animals,
        terrain: JSON.parse(
          fs.readFileSync(path.join(ROOT, "art/source/palette.json"), "utf8")
        ).terrain,
      },
      null,
      2
    ) + "\n"
  );
  const notice = fs.readFileSync(path.join(ROOT, "dist/legal/LICENSE"));
  fs.mkdirSync(path.join(out, "legal"), { recursive: true });
  fs.writeFileSync(path.join(out, "legal/LICENSE"), notice);
  const notices = [{ file: "legal/LICENSE", sha256: sha(notice) }];
  const manifest = {
    schemaVersion: 1,
    notices,
    renderer: "official-client-canvas",
    clientBundleSha256: sha(original),
    catalogSha256: sha(fs.readFileSync(path.join(out, "catalog.json"))),
    animals,
    sprites,
  };
  fs.writeFileSync(
    path.join(out, "renderer-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
  console.log(
    JSON.stringify({
      sprites: sprites.length,
      renderer: manifest.renderer,
      clientBundleSha256: manifest.clientBundleSha256,
      output: "dist/control-assets",
    })
  );
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => child.once("exit", resolve)),
      wait(5000),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
