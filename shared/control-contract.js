// Canonical authoring contract. Consumed by the game and exported by its build.
const config = require("./config.js");
const items = require("./config/items.js");
const { intersectsDisk } = require("./cave.js");
const VERSION = 1;
const kinds = { tree: 0, bush: 1, cactus: 1, stone: 2, gold: 3 };
const biomeAt = y =>
  y <= config.snowBiomeTop
    ? 1
    : y >= config.mapScale - config.snowBiomeTop
      ? 2
      : 0;
const rules = {
  gather: { min: 1, max: 5, default: 1, label: "Coleta de recursos" },
  animalReward: { min: 1, max: 5, default: 1, label: "Recompensa de animais" },
};
function validateRules(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("rules_invalid");
  if (Object.keys(input).some(k => !rules[k]))
    throw new Error("rule_unsupported");
  return Object.fromEntries(
    Object.entries(rules).map(([k, spec]) => {
      const n = input[k] ?? spec.default;
      if (!Number.isFinite(n) || n < spec.min || n > spec.max)
        throw new Error("rule_range:" + k);
      return [k, n];
    })
  );
}
function resourceScale(kind) {
  return kind === "tree"
    ? config.treeScales
    : kind === "bush" || kind === "cactus"
      ? config.bushScales
      : config.rockScales;
}
function catalog() {
  return {
    apiVersion: VERSION,
    mapVersion: VERSION,
    width: config.mapScale,
    height: config.mapScale,
    snow: config.snowBiomeTop,
    riverWidth: config.riverWidth,
    cave: config.bossCave,
    maxObjects: 10000,
    maxPlayerSpawns: 16,
    playerScale: config.playerScale,
    rules,
    resources: Object.entries(kinds).map(([kind, type]) => ({
      kind,
      type,
      scales: resourceScale(kind),
      biomes:
        kind === "cactus"
          ? [2]
          : kind === "tree" || kind === "bush"
            ? [0, 1]
            : [0, 1, 2],
    })),
    buildings: items.list
      .filter(i => !i.consume)
      .map(i => ({
        id: i.id,
        name: i.name,
        scale: i.scale,
        colDiv: i.colDiv || 1,
        ignoreCollision: !!i.ignoreCollision,
        health: i.health,
        dmg: i.dmg || 0,
        group: i.group?.name,
      })),
  };
}
function validateMap(input) {
  const errors = [],
    warn = [];
  const fail = (id, code) => {
    if (errors.length < 100) errors.push({ id, code });
  };
  if (
    !input ||
    input.version !== VERSION ||
    input.width !== config.mapScale ||
    input.height !== config.mapScale ||
    !Array.isArray(input.objects) ||
    input.objects.length > 10000 ||
    (input.encounters !== undefined && !Array.isArray(input.encounters)) ||
    (input.spawns !== undefined && !Array.isArray(input.spawns))
  )
    return { valid: false, errors: [{ code: "map_schema" }], warnings: [] };
  const ids = new Set(),
    cells = new Map(),
    objects = [];
  for (const raw of input.objects) {
    const id = raw?.id;
    if (
      typeof id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
      ids.has(id)
    ) {
      fail(id, "object_id");
      continue;
    }
    ids.add(id);
    const { kind, x, y } = raw;
    const building =
      kind === "building"
        ? items.list.find(i => i.id === raw.item && !i.consume)
        : null;
    const scale = building ? building.scale : raw.scale;
    if (
      (!building && kinds[kind] === undefined) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(scale) ||
      x < scale ||
      y < scale ||
      x > config.mapScale - scale ||
      y > config.mapScale - scale
    ) {
      fail(id, "bounds_or_kind");
      continue;
    }
    if (!building && !resourceScale(kind).includes(scale)) {
      fail(id, "resource_scale");
      continue;
    }
    const biome = biomeAt(y);
    if (
      (kind === "cactus" && biome !== 2) ||
      ((kind === "tree" || kind === "bush") && biome === 2)
    ) {
      fail(id, "biome");
      continue;
    }
    const radius =
      scale *
      (building
        ? building.colDiv || 1
        : kind === "stone" || kind === "gold"
          ? 1
          : 0.6);
    if (intersectsDisk(x, y, scale, config.bossCave.reserved)) {
      fail(id, "cave_protected");
      continue;
    }
    if (
      ((building && building.id !== 18) ||
        kind === "tree" ||
        kind === "bush" ||
        kind === "cactus") &&
      Math.abs(y - config.mapScale / 2) < config.riverWidth / 2 + radius
    ) {
      fail(id, "river");
      continue;
    }
    const cellX = Math.floor(x / 512),
      cellY = Math.floor(y / 512);
    for (let a = cellX - 2; a <= cellX + 2; a++)
      for (let b = cellY - 2; b <= cellY + 2; b++)
        for (const other of cells.get(a + ":" + b) || []) {
          if (Math.hypot(x - other.x, y - other.y) < radius + other.radius)
            fail(id, "overlap:" + other.id);
        }
    const key = cellX + ":" + cellY;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ id, x, y, radius });
    objects.push({
      id,
      kind,
      x,
      y,
      scale,
      dir: Number.isFinite(raw.dir)
        ? ((raw.dir % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
        : 0,
      ...(building ? { item: building.id } : {}),
    });
  }
  const encounters = [],
    spawns = [];
  for (const e of input.spawns || []) {
    if (
      spawns.length >= 16 ||
      typeof e?.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(e.id) ||
      ids.has(e.id) ||
      !Number.isFinite(e.x) ||
      !Number.isFinite(e.y) ||
      e.x < 100 ||
      e.y < 100 ||
      e.x > config.mapScale - 100 ||
      e.y > config.mapScale - 100 ||
      intersectsDisk(e.x, e.y, 100, config.bossCave.reserved) ||
      objects.some(o => Math.hypot(o.x - e.x, o.y - e.y) < o.scale + 100)
    ) {
      fail(e?.id, "player_spawn");
      continue;
    }
    ids.add(e.id);
    spawns.push({ id: e.id, x: e.x, y: e.y });
  }
  for (const e of input.encounters || []) {
    if (
      typeof e?.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(e.id) ||
      ids.has(e.id)
    ) {
      fail(e?.id, "encounter_id");
      continue;
    }
    ids.add(e.id);
    if (
      encounters.length >= 100 ||
      !Number.isInteger(e.index) ||
      ![0, 1, 2, 3, 4, 5, 9, 10, 12].includes(e.index) ||
      !Number.isFinite(e.x) ||
      !Number.isFinite(e.y) ||
      e.x < 250 ||
      e.y < 250 ||
      e.x > config.mapScale - 250 ||
      e.y > config.mapScale - 250 ||
      intersectsDisk(e.x, e.y, 250, config.bossCave.reserved) ||
      objects.some(o => Math.hypot(o.x - e.x, o.y - e.y) < o.scale + 120)
    ) {
      fail(e.id, "encounter_position");
      continue;
    }
    encounters.push({
      id: String(e.id || "encounter-" + encounters.length).slice(0, 64),
      index: e.index,
      x: e.x,
      y: e.y,
    });
  }
  if (objects.length > 3000) warn.push({ code: "dense_map_requires_preview" });
  if (!objects.length) warn.push({ code: "empty_resources" });
  warn.push({ code: "playable_preview_required" });
  return {
    valid: !errors.length,
    errors,
    warnings: warn,
    map: {
      version: VERSION,
      width: config.mapScale,
      height: config.mapScale,
      objects,
      encounters,
      spawns,
    },
  };
}
module.exports = {
  VERSION,
  catalog,
  validateMap,
  validateRules,
  biomeAt,
  kinds,
};
