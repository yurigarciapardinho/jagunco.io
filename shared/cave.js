// Shared terrain data and continuous circle/rectangle collision geometry.
const EPS = 1e-6;
const rect = (x, y, width, height) => ({ x, y, width, height });
const BOSS_CAVE = {
    id: "treasure-cave", revision: 1, name: "Gruta do Tesouro",
    bounds: rect(1400, 2600, 2400, 2400),
    interior: rect(1520, 2720, 2160, 2160),
    reserved: rect(1400, 2600, 2400, 2800),
    entrance: rect(2390, 4880, 420, 120),
    approach: rect(2390, 5000, 420, 400),
    buildRestricted: rect(2350, 4760, 500, 640),
    walls: [
        rect(1400, 2600, 2400, 120), rect(1400, 2720, 120, 2280),
        rect(3680, 2720, 120, 2280), rect(1520, 4880, 870, 120),
        rect(2810, 4880, 870, 120)
    ],
    spawns: {
        moostafa: { x: 2180, y: 3900 },
        moofie: { x: 3020, y: 3900 },
        treasure: { x: 2592, y: 3168 }
    }
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function intersectsDisk(x, y, radius, box) {
    const dx = x - clamp(x, box.x, box.x + box.width);
    const dy = y - clamp(y, box.y, box.y + box.height);
    return dx * dx + dy * dy <= radius * radius;
}
function penetration(x, y, radius, box) {
    const cx = clamp(x, box.x, box.x + box.width);
    const cy = clamp(y, box.y, box.y + box.height);
    const dx = x - cx, dy = y - cy;
    const distance = Math.hypot(dx, dy);
    if (distance > EPS) {
        if (distance >= radius - EPS) return null;
        return { nx: dx / distance, ny: dy / distance, depth: radius - distance };
    }
    const faces = [
        { nx: -1, ny: 0, depth: x - box.x + radius },
        { nx: 1, ny: 0, depth: box.x + box.width - x + radius },
        { nx: 0, ny: -1, depth: y - box.y + radius },
        { nx: 0, ny: 1, depth: box.y + box.height - y + radius }
    ];
    return faces.reduce((a, b) => a.depth <= b.depth ? a : b);
}
// Earliest contact with the rounded Minkowski boundary, including true circular
// corners rather than square expansion artifacts at the cave entrance.
function sweepDisk(x, y, dx, dy, radius, box) {
    if (penetration(x, y, radius, box)) return { t: 0, nx: 0, ny: 0 };
    let best = null;
    const take = (t, nx, ny) => {
        if (t < -EPS || t > 1 + EPS || dx * nx + dy * ny >= -EPS) return;
        t = clamp(t, 0, 1);
        if (!best || t < best.t) best = { t, nx, ny };
    };
    if (dx > EPS) {
        const t = (box.x - radius - x) / dx, cy = y + dy * t;
        if (cy >= box.y - EPS && cy <= box.y + box.height + EPS) take(t, -1, 0);
    } else if (dx < -EPS) {
        const t = (box.x + box.width + radius - x) / dx, cy = y + dy * t;
        if (cy >= box.y - EPS && cy <= box.y + box.height + EPS) take(t, 1, 0);
    }
    if (dy > EPS) {
        const t = (box.y - radius - y) / dy, cx = x + dx * t;
        if (cx >= box.x - EPS && cx <= box.x + box.width + EPS) take(t, 0, -1);
    } else if (dy < -EPS) {
        const t = (box.y + box.height + radius - y) / dy, cx = x + dx * t;
        if (cx >= box.x - EPS && cx <= box.x + box.width + EPS) take(t, 0, 1);
    }
    const a = dx * dx + dy * dy;
    if (a > EPS && radius > 0) {
        for (const [cx, cy, sx, sy] of [
            [box.x, box.y, -1, -1], [box.x + box.width, box.y, 1, -1],
            [box.x, box.y + box.height, -1, 1], [box.x + box.width, box.y + box.height, 1, 1]
        ]) {
            const ox = x - cx, oy = y - cy;
            const b = 2 * (ox * dx + oy * dy), c = ox * ox + oy * oy - radius * radius;
            const discriminant = b * b - 4 * a * c;
            if (discriminant < 0) continue;
            const t = (-b - Math.sqrt(discriminant)) / (2 * a);
            const hx = x + dx * t, hy = y + dy * t;
            if ((hx - cx) * sx < -EPS || (hy - cy) * sy < -EPS) continue;
            take(t, (hx - cx) / radius, (hy - cy) / radius);
        }
    }
    return best;
}
function traceTerrain(cave, x1, y1, x2, y2, radius = 0) {
    if (!cave) return null;
    const b = cave.bounds;
    if (Math.max(x1, x2) + radius < b.x || Math.min(x1, x2) - radius > b.x + b.width ||
        Math.max(y1, y2) + radius < b.y || Math.min(y1, y2) - radius > b.y + b.height) return null;
    let hit = null;
    for (const wall of cave.walls) {
        const contact = sweepDisk(x1, y1, x2 - x1, y2 - y1, radius, wall);
        if (contact && (!hit || contact.t < hit.t)) hit = contact;
    }
    return hit ? { ...hit, x: x1 + (x2 - x1) * hit.t, y: y1 + (y2 - y1) * hit.t } : null;
}
function resolveMotion(cave, entity, previousX, previousY) {
    if (!cave) return false;
    let x = previousX, y = previousY;
    const targetX = entity.x, targetY = entity.y, radius = entity.scale || 0;
    const b = cave.bounds;
    if (Math.max(previousX, targetX) + radius < b.x || Math.min(previousX, targetX) - radius > b.x + b.width ||
        Math.max(previousY, targetY) + radius < b.y || Math.min(previousY, targetY) - radius > b.y + b.height) return false;
    let blocked = false;
    // Resolve invalid stationary positions (e.g. an explicit administrative teleport).
    for (let i = 0; i < 8; i++) {
        let overlap = null;
        for (const wall of cave.walls) {
            overlap = penetration(x, y, radius, wall);
            if (overlap) break;
        }
        if (!overlap) break;
        x += overlap.nx * (overlap.depth + EPS);
        y += overlap.ny * (overlap.depth + EPS);
        blocked = true;
    }
    let dx = targetX - previousX, dy = targetY - previousY;
    for (let i = 0; i < 8 && Math.hypot(dx, dy) > EPS; i++) {
        const hit = traceTerrain(cave, x, y, x + dx, y + dy, radius);
        if (!hit) { x += dx; y += dy; dx = dy = 0; break; }
        blocked = true;
        const t = Math.max(0, hit.t - EPS / Math.max(1, Math.hypot(dx, dy)));
        x += dx * t; y += dy * t;
        dx *= 1 - t; dy *= 1 - t;
        const into = dx * hit.nx + dy * hit.ny;
        if (into < 0) { dx -= hit.nx * into; dy -= hit.ny * into; }
        const velocity = (entity.xVel || 0) * hit.nx + (entity.yVel || 0) * hit.ny;
        if (velocity < 0) {
            entity.xVel = (entity.xVel || 0) - hit.nx * velocity;
            entity.yVel = (entity.yVel || 0) - hit.ny * velocity;
        }
    }
    entity.x = x;
    entity.y = y;
    return blocked;
}
function outsideReserved(cave, x, y, radius) {
    if (!cave || !intersectsDisk(x, y, radius, cave.reserved)) return { x, y };
    const b = cave.reserved, margin = radius + 1;
    const candidates = [
        { x: b.x - margin, y }, { x: b.x + b.width + margin, y },
        { x, y: b.y - margin }, { x, y: b.y + b.height + margin }
    ];
    return candidates.reduce((a, b) =>
        Math.hypot(a.x - x, a.y - y) <= Math.hypot(b.x - x, b.y - y) ? a : b);
}
function confine(entity, bounds) {
    if (!bounds || entity.spawnCounter || !entity.active) return;
    const inset = entity.scale + 8;
    const x = clamp(entity.x, bounds.x + inset, bounds.x + bounds.width - inset);
    const y = clamp(entity.y, bounds.y + inset, bounds.y + bounds.height - inset);
    if (x !== entity.x) entity.xVel = 0;
    if (y !== entity.y) entity.yVel = 0;
    entity.x = x; entity.y = y;
}
module.exports = { BOSS_CAVE, intersectsDisk, penetration, sweepDisk, traceTerrain, resolveMotion, outsideReserved, confine };
