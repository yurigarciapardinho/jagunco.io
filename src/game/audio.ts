/**
 * audio.ts — Web Audio synthesized SFX + simple adaptive music + mute toggle (remembered in localStorage).
 * No audio asset files at all — everything is synthesized at runtime.
 */

export type SfxId = "move" | "hit" | "pickup" | "ui" | "explosion" | "win" | "lose";

const MUTE_KEY = "game.muted";

// localStorage can throw (storage disabled, private mode, third-party storage blocked
// inside a preview iframe) — a game must never fail to start because of that.
function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeMuted(v: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, v ? "1" : "0");
  } catch {
    // not persisted this session; the in-memory flag still works
  }
}

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicOsc: OscillatorNode | null = null;
  private disposed = false;
  muted = false;

  // browsers require a first user interaction before the AudioContext can start
  private readonly unlock = () => {
    this.ensureCtx();
    this.detachUnlock();
  };

  constructor() {
    this.muted = readMuted();
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
  }

  private detachUnlock(): void {
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
  }

  /**
   * Release everything: unlock listeners, the music oscillator and the AudioContext.
   * Call it from your teardown path (stopGame) next to input.dispose() — otherwise React
   * StrictMode's double mount / HMR leaks one AudioContext per mount, and Chrome caps a
   * page at about six of them.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachUnlock();
    this.stopMusic();
    this.master?.disconnect();
    this.master = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    writeMuted(this.muted);
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  sfx(id: SfxId): void {
    if (this.disposed || this.muted) return; // muted: no context is created either
    const ctx = this.ensureCtx();
    if (!this.master) return;
    const t = ctx.currentTime;
    const spec: Record<SfxId, [type: OscillatorType, f0: number, f1: number, dur: number, gain: number]> = {
      move: ["triangle", 220, 180, 0.08, 0.15],
      hit: ["square", 160, 60, 0.12, 0.3],
      pickup: ["sine", 660, 990, 0.12, 0.25],
      ui: ["sine", 440, 520, 0.05, 0.15],
      explosion: ["sawtooth", 120, 30, 0.4, 0.4],
      win: ["sine", 523, 1046, 0.5, 0.3],
      lose: ["sawtooth", 220, 55, 0.6, 0.3],
    };
    const [type, f0, f1, dur, g] = spec[id];
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    env.gain.setValueAtTime(g, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
  }

  /** Minimal adaptive background pulse (replace with a full score). */
  startMusic(): void {
    if (this.disposed) return;
    const ctx = this.ensureCtx();
    if (this.musicOsc) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 55; // A1 sustained bass
    gain.gain.value = 0.06;
    osc.connect(gain).connect(this.master!);
    osc.start();
    this.musicOsc = osc;
  }

  stopMusic(): void {
    this.musicOsc?.stop();
    this.musicOsc = null;
  }
}
