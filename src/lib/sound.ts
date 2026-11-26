class ArenaSoundEngine {
  private ctx: AudioContext | null = null;
  private muted = false;

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(mute: boolean): void {
    this.muted = mute;
  }

  private getCtx(): AudioContext | null {
    if (this.muted || typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private tone(
    freq: number,
    endFreq: number,
    durationSec: number,
    type: OscillatorType = 'sine',
    volume = 0.12,
    delaySec = 0,
  ): void {
    const ctx = this.getCtx();
    if (!ctx) return;
    const now = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), now + durationSec);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationSec + 0.02);
  }

  public playKick(): void {
    this.tone(190, 82, 0.12, 'triangle', 0.16);
  }

  public playThrow(): void {
    this.tone(280, 560, 0.14, 'sine', 0.1);
  }

  public playSlap(): void {
    this.tone(420, 140, 0.09, 'square', 0.09);
  }

  public playShieldOn(): void {
    this.tone(523, 784, 0.16, 'sine', 0.11);
    this.tone(784, 1046, 0.18, 'triangle', 0.08, 0.07);
  }

  public playShieldBlock(): void {
    this.tone(880, 620, 0.12, 'triangle', 0.12);
  }

  public playHit(): void {
    this.tone(310, 175, 0.11, 'sine', 0.12);
  }

  public playPop(): void {
    const ctx = this.getCtx();
    if (!ctx) return;
    // Crisp balloon burst noise + pitch drop
    const bufferSize = Math.floor(ctx.sampleRate * 0.14);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.22));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1100, ctx.currentTime);
    filter.Q.setValueAtTime(0.9, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.28, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start();

    this.tone(240, 65, 0.13, 'triangle', 0.18);
  }

  public playRespawn(): void {
    this.tone(392, 587, 0.12, 'sine', 0.1);
    this.tone(587, 784, 0.14, 'sine', 0.1, 0.09);
  }

  public playCountdownTick(finalGo = false): void {
    if (finalGo) {
      this.tone(523, 784, 0.22, 'triangle', 0.16);
      this.tone(784, 1046, 0.28, 'triangle', 0.15, 0.09);
    } else {
      this.tone(440, 440, 0.12, 'sine', 0.12);
    }
  }

  public playVictory(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((n, idx) => {
      this.tone(n, n * 1.01, 0.24, 'triangle', 0.12, idx * 0.11);
    });
  }
}

export const soundEngine = new ArenaSoundEngine();
