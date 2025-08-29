export class TTSPlayer {
  private audio: HTMLAudioElement;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private mime: string = 'audio/mpeg';
  private initialized = false;

  constructor(audio: HTMLAudioElement) {
    this.audio = audio;
  }

  init(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (!('MediaSource' in window)) {
        return reject(new Error('MediaSource not supported'));
      }
      this.mediaSource = new MediaSource();
      this.audio.src = URL.createObjectURL(this.mediaSource);
      this.mediaSource.addEventListener('sourceopen', () => {
        try {
          if (!this.mediaSource) return reject(new Error('No mediaSource'));
          this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mime);
          this.sourceBuffer.mode = 'sequence';
          this.sourceBuffer.addEventListener('updateend', () => this.drain());
          this.initialized = true;
          resolve();
        } catch (e) {
          reject(e as any);
        }
      });
    });
  }

  private drain() {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    const next = this.queue.shift();
    if (next) {
      try {
        this.sourceBuffer.appendBuffer(next as BufferSource);
      } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
    }
  }

  async pushChunk(chunk: Uint8Array) {
    // Re-initialize if ended or not initialized
    if (!this.initialized || !this.mediaSource || this.mediaSource.readyState === 'ended') {
      await this.reset();
    }
    if (!this.sourceBuffer) return;
    if (this.sourceBuffer.updating || this.queue.length > 0) {
      this.queue.push(chunk);
    } else {
      try {
        this.sourceBuffer.appendBuffer(chunk as BufferSource);
      } catch {
        this.queue.push(chunk);
      }
    }
  }

  end() {
    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        try { this.mediaSource.endOfStream(); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
      }
    } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
    // Mark uninitialized so next chunk recreates pipeline
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.initialized = false;
    this.queue = [];
  }

  private async reset() {
    this.end();
    await this.init();
  }
}