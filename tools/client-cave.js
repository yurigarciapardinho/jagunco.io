// Geometry comes from the authoritative catalog, including after reconnect.
let jaguncoCave = null;

function drawJaguncoCave(ctx, cameraX, cameraY, width, height) {
    const cave = jaguncoCave;
    if (!cave) return;
    const b = cave.reserved;
    if (b.x + b.width < cameraX || b.x > cameraX + width ||
        b.y + b.height < cameraY || b.y > cameraY + height) return;
    ctx.save();
    ctx.globalAlpha = 1;
    const rect = (box, color) => {
        ctx.fillStyle = color;
        ctx.fillRect(box.x - cameraX, box.y - cameraY, box.width, box.height);
    };
    rect(cave.bounds, "#625951");
    rect(cave.interior, "#74695d");
    rect(cave.approach, "#74695d");
    rect(cave.entrance, "#74695d");
    for (const wall of cave.walls) {
        rect(wall, "#302e2c");
        // Contained stonework never changes or obscures the collision footprint.
        for (let row = 0, y = wall.y + 7; y < wall.y + wall.height - 7; y += 54, row++) {
            for (let x = wall.x + 7; x < wall.x + wall.width - 7; x += 94) {
                rect({
                    x, y,
                    width: Math.min(87, wall.x + wall.width - 7 - x),
                    height: Math.min(47, wall.y + wall.height - 7 - y)
                }, row % 2 ? "#57534e" : "#625e57");
            }
        }
    }
    ctx.restore();
}
