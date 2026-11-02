#!/usr/bin/env node
// JAGUNCO RENDERER PATCH (presentation only)
// Re-skins the terrain / biome colors of the official client bundle with the
// sertanejo palette from art/source/palette.json. This module is imported by
// tools/build-official-client.mjs (integration done by the build owner):
//
//   import { applyJaguncoRendererPatch } from "./jagunco-renderer-patch.mjs";
//   bundle = applyJaguncoRendererPatch(bundle);   // before patchBundle() writes it
//
// What it does NOT touch: geometry, scale, hitboxes, spawn rules, game logic,
// the health/team green (#8ecc51) or damage red (#cc5151) gameplay signalling.
// Every replacement is verified against an exact match count, like patchBundle,
// so a client update that removes a color fails loudly instead of silently
// shipping a half-reskinned renderer.
//
// Ground texture note: the official renderer is a custom WebGL batcher
// (client-official/source/index-*.js, `of()` -> getContext("webgl")) whose
// fillStyle only accepts flat color strings - there is no CanvasPattern path,
// so /art/caatinga-ground.png cannot be injected safely without rewriting the
// batcher. That texture is used by the PixiJS client instead
// (src/game/art.ts:84,109). We therefore derive flat biome colors from the same
// palette the texture is built from.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PALETTE_PATH = path.join(ROOT, "art", "source", "palette.json");

export function jaguncoRendererPatches(palettePath = PALETTE_PATH) {
    const terrain = JSON.parse(fs.readFileSync(palettePath, "utf8")).terrain;
    const q = (hex) => `"${hex}"`;
    return [
        // -- biomes (full-screen ground fills + grass/snow decoration) --------
        { name: "grass biome -> dry caatinga", from: q("#b6db66"), to: q(terrain.grass), count: 3 },
        { name: "sand biome + riverbanks -> warm sertao sand", from: q("#dbc666"), to: q(terrain.sand), count: 4 },
        { name: "snow biome -> parchment (top band)", from: /P\.fillStyle="#fff",P\.fillRect\(0,0,fe,pe\)/, to: `P.fillStyle="${terrain.snow}",P.fillRect(0,0,fe,pe)`, count: 1 },
        { name: "snow biome -> parchment (split band)", from: /P\.fillStyle="#fff",P\.fillRect\(0,0,fe,E\.snowBiomeTop-l\)/, to: `P.fillStyle="${terrain.snow}",P.fillRect(0,0,fe,E.snowBiomeTop-l)`, count: 1 },
        { name: "snow tufts -> warm off-white", from: q("#e3f1f4"), to: q(terrain.snowTuft), count: 2 },
        { name: "grass tufts (dark) -> caatinga", from: q("#9ebf57"), to: q(terrain.tuftDark), count: 2 },
        { name: "grass tufts (light) -> caatinga", from: q("#b4db62"), to: q(terrain.tuftLight), count: 2 },
        { name: "tree canopy -> caatinga green", from: q("#89a54c"), to: q(terrain.treeCanopy), count: 3 },
        { name: "tree canopy highlight", from: q("#a5c65b"), to: q(terrain.treeCanopyLight), count: 1 },
        // -- river (Sao Francisco teal) ---------------------------------------
        { name: "river water", from: q("#91b2db"), to: q(terrain.river), count: 2 },
        { name: "river deep water", from: q("#7b9fd0"), to: q(terrain.riverDeep), count: 1 },
        { name: "river shallows", from: q("#cfe2f5"), to: q(terrain.riverShallow), count: 1 },
        { name: "river fill", from: q("#9cbcd8"), to: q(terrain.riverFill), count: 1 },
        { name: "river highlight", from: q("#b8d6ee"), to: q(terrain.riverHighlight), count: 1 },
        { name: "river pebble shadow -> warm", from: q("#5d6d78"), to: q(terrain.pebbleShadow), count: 1 },
        { name: "river pebbles -> warm stone", from: '"#8f9aa0","#9a9686","#7f8b92"', to: terrain.pebbles.map(q).join(","), count: 1 },
        // -- rocks / ores (world objects, icons are separate PNGs) ------------
        { name: "rock ramp 1", from: q("#7d776c"), to: q(terrain.rockDeep), count: 1 },
        { name: "rock ramp 2", from: q("#5a554c"), to: q(terrain.rockShadow), count: 1 },
        { name: "rock ramp 3", from: q("#8f897d"), to: q(terrain.rockMid), count: 1 },
        { name: "rock ramp 4", from: q("#a39d90"), to: q(terrain.rockLight), count: 1 },
        { name: "rock ramp 5", from: q("#a9a291"), to: q(terrain.rockWarm), count: 1 },
        { name: "rock inner shadow", from: q("#606060"), to: q(terrain.rockInner), count: 1 },
        { name: "gold ore -> straw gold", from: q("#e0c655"), to: q(terrain.goldOre), count: 1 },
        { name: "gold ore light", from: q("#ebdca3"), to: q(terrain.goldOreLight), count: 1 },
        { name: "rock ore", from: q("#938d77"), to: q(terrain.rockOre), count: 1 },
        { name: "rock ore light", from: q("#b2ab90"), to: q(terrain.rockOreLight), count: 1 },
        { name: "stone resource gray -> warm stone", from: q("#939393"), to: q(terrain.stoneWall), count: 6 },
        { name: "stone wall inner", from: q("#bcbcbc"), to: q(terrain.stoneWallInner), count: 3 },
        // -- constructions (procedural fills only; hitboxes unchanged) --------
        { name: "wood wall -> aged leather wood", from: q("#a5974c"), to: q(terrain.woodWall), count: 6 },
        { name: "wood wall inner", from: q("#c9b758"), to: q(terrain.woodWallInner), count: 3 },
        { name: "castle wall -> warm adobe stone", from: q("#83898e"), to: q(terrain.castleWall), count: 1 },
        { name: "castle wall inner", from: q("#9da4aa"), to: q(terrain.castleWallInner), count: 1 },
    ];
}

// Same contract as patchBundle() in tools/build-official-client.mjs: every patch
// must match exactly `count` times or the client changed and this needs a look.
export function applyJaguncoRendererPatch(source, palettePath = PALETTE_PATH, log = console.log) {
    let out = source;
    for (const patch of jaguncoRendererPatches(palettePath)) {
        const re = patch.from instanceof RegExp
            ? new RegExp(patch.from.source, patch.from.flags.includes("g") ? patch.from.flags : patch.from.flags + "g")
            : null;
        const matches = re ? (out.match(re) || []).length : out.split(patch.from).length - 1;
        if (matches !== patch.count) {
            throw new Error(`jagunco renderer patch "${patch.name}" matched ${matches}x (expected ${patch.count}). Client bundle changed - update tools/jagunco-renderer-patch.mjs.`);
        }
        out = re ? out.replace(re, patch.to) : out.split(patch.from).join(patch.to);
        log(`  jagunco renderer: ${patch.name} (${matches}x)`);
    }
    return out;
}

// Manual check: node tools/jagunco-renderer-patch.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const bundle = fs.readdirSync(path.join(ROOT, "client-official", "source")).find((f) => /^index-[\w]+\.js$/.test(f));
    const src = fs.readFileSync(path.join(ROOT, "client-official", "source", bundle), "utf8");
    applyJaguncoRendererPatch(src);
    console.log("all renderer patches match the current bundle");
}
