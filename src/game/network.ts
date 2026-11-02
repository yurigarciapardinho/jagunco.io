import { decode, encode } from "@msgpack/msgpack";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type GameEvent,
  type LeaderNet,
  type PrivateNet,
  type ServerMessage,
} from "@contracts/game";
type Snapshot = Extract<ServerMessage, ["s", unknown]>[1];

interface Welcome {
  version: number;
  id: number;
  tick: number;
  mapSize: number;
  seed: number;
}

interface HttpJoinResponse {
  token: string;
  messages: ServerMessage[];
}

interface HttpSyncResponse {
  messages: ServerMessage[];
}

export interface NetworkHandlers {
  welcome(data: Welcome): void;
  snapshot(data: Snapshot): void;
  private(data: PrivateNet): void;
  events(events: GameEvent[]): void;
  leaders(leaders: LeaderNet[]): void;
  pong(ping: number): void;
  disconnected(reason: string): void;
}

export class GameConnection {
  private socket: WebSocket | null = null;
  private intentionalClose = false;
  private receivedWelcome = false;
  private serverRejected = false;
  private generation = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private httpTimer: ReturnType<typeof setInterval> | null = null;
  private httpToken: string | null = null;
  private httpQueue: ClientMessage[] = [];
  private httpInFlight = false;
  private diagnosticReports = 0;

  constructor(private readonly handlers: NetworkHandlers) {}

  connect(name: string): void {
    this.close(false);
    this.intentionalClose = false;
    this.receivedWelcome = false;
    this.serverRejected = false;
    this.diagnosticReports = 0;
    const generation = this.generation;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/game/ws`);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (generation !== this.generation) return;
      this.send(["j", name]);
      this.startPing();
    });
    socket.addEventListener("message", (event) => {
      if (generation !== this.generation) return;
      try {
        const message = decode(new Uint8Array(event.data as ArrayBuffer)) as ServerMessage;
        this.dispatch(message);
      } catch {
        this.handlers.disconnected("O servidor enviou uma resposta inválida.");
      }
    });
    socket.addEventListener("close", () => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.clearPing();
      if (this.intentionalClose) return;
      if (!this.receivedWelcome && !this.serverRejected) {
        // Some preview gateways relay the request as plain HTTP instead of
        // performing the WS upgrade. Rejoin through the same authoritative server.
        void this.connectHttp(name, generation);
      } else {
        this.handlers.disconnected("A conexão com a sala foi encerrada.");
      }
    });
    socket.addEventListener("error", () => {
      // close follows with the user-facing state; avoiding duplicate notices here.
    });
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encode(message));
      return;
    }
    if (!this.httpToken) return;
    // If latency makes requests overlap, keep the newest movement rather than
    // growing a backlog of stale inputs. Discrete actions remain queued.
    if (message[0] === "i" && this.httpQueue.length > 8) {
      for (let i = this.httpQueue.length - 1; i >= 0; i--) {
        if (this.httpQueue[i][0] === "i") {
          this.httpQueue.splice(i, 1);
          break;
        }
      }
    }
    this.httpQueue.push(message);
  }

  close(notify = false): void {
    this.generation++;
    this.intentionalClose = !notify;
    this.clearPing();
    if (this.httpTimer) clearInterval(this.httpTimer);
    this.httpTimer = null;
    const token = this.httpToken;
    this.httpToken = null;
    this.httpQueue.length = 0;
    this.httpInFlight = false;
    if (token) void this.leaveHttp(token);
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Saindo");
  }

  private async connectHttp(name: string, generation: number): Promise<void> {
    this.socket = null;
    try {
      const response = await fetch("/api/game/http/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error("join failed");
      const data = await response.json() as HttpJoinResponse;
      if (generation !== this.generation || this.intentionalClose) {
        if (data.token) void this.leaveHttp(data.token);
        return;
      }
      this.httpToken = data.token;
      this.reportMessages("join", data.messages);
      this.startPing();
      this.httpTimer = setInterval(() => void this.syncHttp(generation), 70);
      for (const message of data.messages) this.dispatch(message);
    } catch {
      if (generation !== this.generation || this.intentionalClose) return;
      this.close(false);
      this.handlers.disconnected("Não foi possível conectar à sala.");
    }
  }

  private async syncHttp(generation: number): Promise<void> {
    const token = this.httpToken;
    if (!token || this.httpInFlight || generation !== this.generation) return;
    this.httpInFlight = true;
    const messages = this.httpQueue.splice(0, 12);
    try {
      const response = await fetch("/api/game/http/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, messages }),
      });
      if (!response.ok) throw new Error("sync failed");
      const data = await response.json() as HttpSyncResponse;
      if (generation !== this.generation || this.intentionalClose) return;
      this.reportMessages("sync", data.messages);
      for (const message of data.messages) this.dispatch(message);
    } catch {
      if (generation !== this.generation || this.intentionalClose) return;
      this.close(false);
      this.handlers.disconnected("A conexão com a sala foi encerrada.");
    } finally {
      if (generation === this.generation) this.httpInFlight = false;
    }
  }

  private async leaveHttp(token: string): Promise<void> {
    try {
      await fetch("/api/game/http/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        keepalive: true,
      });
    } catch {
      // The server also expires idle HTTP sessions.
    }
  }

  private reportMessages(stage: "join" | "sync", messages: ServerMessage[]): void {
    if (this.diagnosticReports >= 3) return;
    this.diagnosticReports++;
    const snapshots = messages.flatMap((message) => message[0] === "s" ? [{
      players: message[1].players.length,
      objects: message[1].objects.length,
      animals: message[1].animals.length,
    }] : []);
    void fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg: "jagunco-network",
        ctx: { stage, types: messages.map((message) => message[0]), snapshots },
      }),
    }).catch(() => undefined);
  }

  private startPing(): void {
    this.clearPing();
    this.send(["p", performance.now()]);
    this.pingTimer = setInterval(() => this.send(["p", performance.now()]), 3000);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private dispatch(message: ServerMessage): void {
    switch (message[0]) {
      case "w":
        if (message[1].version !== PROTOCOL_VERSION) {
          this.handlers.disconnected("Versão do protocolo incompatível. Atualize a página.");
          this.close();
          return;
        }
        this.receivedWelcome = true;
        this.handlers.welcome(message[1]);
        break;
      case "s": this.handlers.snapshot(message[1]); break;
      case "p": this.handlers.private(message[1]); break;
      case "e": this.handlers.events(message[1]); break;
      case "l": this.handlers.leaders(message[1]); break;
      case "d":
        this.serverRejected = true;
        this.handlers.disconnected(message[1]);
        break;
      case "o": this.handlers.pong(Math.max(0, Math.round(performance.now() - message[1]))); break;
    }
  }
}
