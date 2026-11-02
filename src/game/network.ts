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
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly handlers: NetworkHandlers) {}

  connect(name: string): void {
    this.close(false);
    this.intentionalClose = false;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/game/ws`);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      this.send(["j", name]);
      this.pingTimer = setInterval(() => this.send(["p", performance.now()]), 3000);
      this.send(["p", performance.now()]);
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = decode(new Uint8Array(event.data as ArrayBuffer)) as ServerMessage;
        this.dispatch(message);
      } catch {
        this.handlers.disconnected("O servidor enviou uma resposta inválida.");
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.clearPing();
      if (!this.intentionalClose) this.handlers.disconnected("A conexão com a sala foi encerrada.");
    });
    socket.addEventListener("error", () => {
      // close follows with the user-facing state; avoiding duplicate notices here.
    });
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encode(message));
  }

  close(notify = false): void {
    this.intentionalClose = !notify;
    this.clearPing();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Saindo");
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
        this.handlers.welcome(message[1]);
        break;
      case "s": this.handlers.snapshot(message[1]); break;
      case "p": this.handlers.private(message[1]); break;
      case "e": this.handlers.events(message[1]); break;
      case "l": this.handlers.leaders(message[1]); break;
      case "d": this.handlers.disconnected(message[1]); break;
      case "o": this.handlers.pong(Math.max(0, Math.round(performance.now() - message[1]))); break;
    }
  }
}
