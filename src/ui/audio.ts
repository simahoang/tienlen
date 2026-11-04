/**
 * Tick tối thiểu cho 10 giây cuối. AudioContext chỉ tạo sau gesture đầu tiên
 * (không autoplay); mute mặc định tắt tiếng? Không: mặc định bật, nhưng im lặng
 * cho tới khi có gesture.
 */
export class Ticker {
  private context: AudioContext | null = null;
  private muted = false;

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  toggle(): boolean {
    this.muted = !this.muted;
    if (!this.muted) this.unlock();
    return this.muted;
  }

  unlock(): void {
    if (this.muted) return;
    if (typeof AudioContext === 'undefined') return;
    try {
      if (this.context === null) {
        this.context = new AudioContext();
      }
      void this.context.resume().catch(() => undefined);
    } catch {
      this.context = null;
    }
  }

  tick(): void {
    const context = this.context;
    if (this.muted || context === null || context.state !== 'running') return;
    try {
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.06);
    } catch {
      // Audio bị khoá/đóng: bỏ qua tick, không làm hỏng lượt chơi.
    }
  }
}
