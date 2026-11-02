import WebSocket from "ws";
import { encode } from "@msgpack/msgpack";

const url = process.env.GAME_WS_URL || "ws://127.0.0.1:3000/api/game/ws";

function openClient() {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve) => socket.once("message", (data) => resolve(data)));
}

function nextClose(socket) {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

const valid = await openClient();
const welcome = nextMessage(valid);
valid.send(encode(["j", "Protocolo Teste"]));
await welcome;
for (let i = 0; i < 5; i++) valid.send(encode(["invalid", i]));
const invalidCode = await nextClose(valid);
if (invalidCode !== 1008) throw new Error(`Invalid packets: expected 1008, got ${invalidCode}`);

const flooded = await openClient();
const joined = nextMessage(flooded);
flooded.send(encode(["j", "Flood Teste"]));
await joined;
const floodInput = { seq: 1, mx: 0, my: 0, aim: 0, attack: false, build: 0, weapon: 0, heal: false };
for (let i = 0; i < 120; i++) flooded.send(encode(["i", { ...floodInput, seq: i + 1 }]));
const floodCode = await nextClose(flooded);
if (floodCode !== 1008) throw new Error(`Flood: expected 1008, got ${floodCode}`);

const oversized = await openClient();
const oversizedClose = nextClose(oversized);
oversized.send(new Uint8Array(4096));
const oversizedCode = await oversizedClose;
if (oversizedCode !== 1009) throw new Error(`Oversize: expected 1009, got ${oversizedCode}`);

console.log(JSON.stringify({ ok: true, invalidPackets: invalidCode, floodLimited: floodCode, oversizedPayload: oversizedCode }));
