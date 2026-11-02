import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { performance } from "node:perf_hooks";
import { decode, encode } from "@msgpack/msgpack";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  MAX_INPUT_BYTES,
  PROTOCOL_VERSION,
  SNAPSHOT_EVERY,
  TICK_RATE,
  type ClientMessage,
  type InputState,
  type ServerMessage,
} from "../../contracts/game";
import { World } from "./world";

export interface UpgradeServer {
  on(event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
}

interface Connection {
  socket: WebSocket | null;
  token: string | null;
  id: number | null;
  joined: boolean;
  knownObjects: Map<number, number>;
  tokens: number;
  tokenAt: number;
  strikes: number;
  lastInputSeq: number;
  lastSeen: number;
  queue: ServerMessage[];
  queuedSnapshot: boolean;
}

const GAME_PATH = "/api/game/ws";
const STEP_MS = 1000 / TICK_RATE;
const HTTP_SESSION_IDLE_MS = 20_000;
const HTTP_QUEUE_LIMIT = 240;

function isInput(value: unknown): value is InputState {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<InputState>;
  return Number.isSafeInteger(input.seq) && input.seq! >= 0
    && typeof input.mx === "number" && Number.isFinite(input.mx)
    && typeof input.my === "number" && Number.isFinite(input.my)
    && typeof input.aim === "number" && Number.isFinite(input.aim)
    && typeof input.attack === "boolean" && typeof input.heal === "boolean"
    && Number.isInteger(input.build) && Number.isInteger(input.weapon);
}

export class GameServer {
  readonly world = new World();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });
  private readonly connections = new Set<Connection>();
  private readonly httpConnections = new Map<string, Connection>();
  private readonly timer: NodeJS.Timeout;
  private httpServer: UpgradeServer | null = null;
  private last = performance.now();
  private accumulator = 0;

  constructor(httpServer?: UpgradeServer) {
    this.wss.on("connection", (socket) => this.onConnection(socket));
    this.timer = setInterval(() => this.run(), STEP_MS);
    this.timer.unref();
    if (httpServer) this.attach(httpServer);
  }

  attach(httpServer: UpgradeServer): void {
    if (this.httpServer === httpServer) return;
    if (this.httpServer) this.httpServer.off("upgrade", this.onUpgrade);
    this.httpServer = httpServer;
    httpServer.on("upgrade", this.onUpgrade);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.httpServer?.off("upgrade", this.onUpgrade);
    this.httpServer = null;
    for (const connection of this.connections) connection.socket?.close(1001, "Servidor encerrado");
    this.connections.clear();
    this.httpConnections.clear();
    this.wss.close();
  }

  joinHttp(name: string): { token: string; messages: ServerMessage[] } {
    const token = randomUUID();
    const connection = this.createConnection(null, token);
    this.httpConnections.set(token, connection);
    this.handleMessage(connection, ["j", name]);
    return { token, messages: this.drainHttp(connection) };
  }

  syncHttp(token: string, messages: ClientMessage[]): { messages: ServerMessage[] } | null {
    const connection = this.httpConnections.get(token);
    if (!connection) return null;
    connection.lastSeen = Date.now();
    for (const message of messages.slice(0, 12)) this.handleMessage(connection, message);
    return { messages: this.drainHttp(connection) };
  }

  leaveHttp(token: string): void {
    const connection = this.httpConnections.get(token);
    if (connection) this.onClose(connection);
  }

  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== GAME_PATH) return;
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit("connection", ws, request));
  };

  private createConnection(socket: WebSocket | null, token: string | null = null): Connection {
    const connection: Connection = {
      socket,
      token,
      id: null,
      joined: false,
      knownObjects: new Map(),
      tokens: 80,
      tokenAt: performance.now(),
      strikes: 0,
      lastInputSeq: -1,
      lastSeen: Date.now(),
      queue: [],
      queuedSnapshot: false,
    };
    this.connections.add(connection);
    return connection;
  }

  private onConnection(socket: WebSocket): void {
    const connection = this.createConnection(socket);
    socket.on("message", (data) => this.onMessage(connection, data));
    socket.on("close", () => this.onClose(connection));
    socket.on("error", () => this.onClose(connection));
  }

  private onClose(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    if (connection.token) this.httpConnections.delete(connection.token);
    if (connection.id !== null) this.world.leave(connection.id);
    connection.queue.length = 0;
  }

  private onMessage(connection: Connection, data: RawData): void {
    let message: ClientMessage;
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      message = decode(bytes) as ClientMessage;
    } catch {
      this.punish(connection);
      return;
    }
    this.handleMessage(connection, message);
  }

  private handleMessage(connection: Connection, message: ClientMessage): void {
    if (!this.connections.has(connection) || !this.allow(connection)) return;
    if (!Array.isArray(message) || typeof message[0] !== "string") {
      this.punish(connection);
      return;
    }
    switch (message[0]) {
      case "j": {
        if (connection.joined || typeof message[1] !== "string" || message[1].length > 32) return;
        const player = this.world.join(message[1]);
        if (!player) {
          this.send(connection, ["d", "A sala está cheia. Tente novamente em instantes."]);
          connection.socket?.close(1013, "Sala cheia");
          return;
        }
        connection.id = player.id;
        connection.joined = true;
        this.send(connection, ["w", {
          version: PROTOCOL_VERSION, id: player.id, tick: this.world.tick,
          mapSize: 6400, seed: this.world.seed,
        }]);
        this.send(connection, ["p", this.world.privateNet(player)]);
        this.sendSnapshot(connection);
        this.send(connection, ["l", this.world.leaderboard()]);
        break;
      }
      case "i": {
        if (!connection.joined || !isInput(message[1])) {
          this.punish(connection);
          break;
        }
        // HTTP responses can arrive out of order. Old inputs are harmless duplicates,
        // not abuse; only a newer sequence may change the authoritative input.
        if (message[1].seq > connection.lastInputSeq) {
          connection.lastInputSeq = message[1].seq;
          this.world.setInput(connection.id!, message[1]);
        }
        break;
      }
      case "u":
        if (connection.joined && (message[1] === "damage" || message[1] === "speed" || message[1] === "gather")) {
          this.world.upgrade(connection.id!, message[1]);
        }
        break;
      case "r":
        if (connection.joined) this.world.respawn(connection.id!);
        break;
      case "p":
        if (typeof message[1] === "number") this.send(connection, ["o", message[1]]);
        break;
      default:
        this.punish(connection);
    }
  }

  private allow(connection: Connection): boolean {
    const now = performance.now();
    connection.tokens = Math.min(80, connection.tokens + (now - connection.tokenAt) * 0.04);
    connection.tokenAt = now;
    if (connection.tokens < 1) {
      this.punish(connection);
      return false;
    }
    connection.tokens--;
    return true;
  }

  private punish(connection: Connection): void {
    if (++connection.strikes < 5) return;
    if (connection.socket) connection.socket.close(1008, "Protocolo inválido");
    else this.onClose(connection);
  }

  private send(connection: Connection, message: ServerMessage): void {
    if (connection.socket) {
      if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(encode(message));
      return;
    }
    if (message[0] === "s") connection.queuedSnapshot = true;
    connection.queue.push(message);
    if (connection.queue.length > HTTP_QUEUE_LIMIT) this.onClose(connection);
  }

  private drainHttp(connection: Connection): ServerMessage[] {
    connection.queuedSnapshot = false;
    return connection.queue.splice(0, connection.queue.length);
  }

  private run(): void {
    const now = performance.now();
    this.accumulator += Math.min(250, now - this.last);
    this.last = now;
    let steps = 0;
    while (this.accumulator >= STEP_MS && steps < 5) {
      this.world.step();
      this.accumulator -= STEP_MS;
      steps++;
      for (const connection of this.connections) {
        if (!connection.joined) continue;
        const events = this.world.drainEvents(connection.id!);
        if (events.length) this.send(connection, ["e", events]);
      }
      if (this.world.tick % SNAPSHOT_EVERY === 0) {
        for (const connection of this.connections) if (connection.joined) this.sendSnapshot(connection);
      }
      if (this.world.tick % TICK_RATE === 0) {
        const board = this.world.leaderboard();
        const expired = Date.now() - HTTP_SESSION_IDLE_MS;
        for (const connection of [...this.connections]) {
          if (!connection.socket && connection.lastSeen < expired) {
            this.onClose(connection);
            continue;
          }
          if (connection.joined) this.send(connection, ["l", board]);
        }
      }
    }
    if (steps === 5) this.accumulator = 0;
  }

  private sendSnapshot(connection: Connection): void {
    if (connection.id === null) return;
    // Do not advance per-viewer object versions until the previous HTTP snapshot
    // has actually been collected by that viewer.
    if (!connection.socket && connection.queuedSnapshot) return;
    const player = this.world.players.get(connection.id);
    if (!player) return;
    this.send(connection, ["s", this.world.snapshot(connection.id, connection.knownObjects)]);
    if (player.privateDirty) {
      this.send(connection, ["p", this.world.privateNet(player)]);
      player.privateDirty = false;
    }
  }
}

export const gameServer = new GameServer();

export function attachGameServer(server: UpgradeServer): GameServer {
  gameServer.attach(server);
  return gameServer;
}
