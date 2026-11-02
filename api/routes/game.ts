import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ClientMessage } from "../../contracts/game";
import { gameServer } from "../game/server";

const jsonLimit = bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.body(null, 413) });

export const gameHttpRoutes = new Hono();

gameHttpRoutes.post("/join", jsonLimit, async (c) => {
  const body = await c.req.json().catch(() => null) as { name?: unknown } | null;
  if (!body || typeof body.name !== "string" || body.name.length > 32) {
    return c.json({ error: "Nome inválido" }, 400);
  }
  const name = body.name.trim().slice(0, 16) || "Jagunço";
  return c.json(gameServer.joinHttp(name));
});

gameHttpRoutes.post("/sync", jsonLimit, async (c) => {
  const body = await c.req.json().catch(() => null) as { token?: unknown; messages?: unknown } | null;
  if (!body || typeof body.token !== "string" || !Array.isArray(body.messages) || body.messages.length > 12) {
    return c.json({ error: "Sincronização inválida" }, 400);
  }
  const result = gameServer.syncHttp(body.token, body.messages as ClientMessage[]);
  if (!result) return c.json({ error: "Sessão expirada" }, 401);
  return c.json(result);
});

gameHttpRoutes.post("/leave", jsonLimit, async (c) => {
  const body = await c.req.json().catch(() => null) as { token?: unknown } | null;
  if (body && typeof body.token === "string") gameServer.leaveHttp(body.token);
  return c.body(null, 204);
});
