// Runs on the audio thread: converts mic samples to 16-bit PCM and posts
// 20 ms frames to the page.

class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(Math.round(sampleRate / 50)); // 20 ms
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.frame[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCapture);
