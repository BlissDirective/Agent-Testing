// 2x sample-rate conversion between 8 kHz (phone audio from Asterisk) and
// 16 kHz (the voice agent's PCM), using a windowed-sinc low-pass FIR so the
// conversion doesn't alias. Streaming: keeps filter history across chunks.
//
// Why not ask Asterisk for 16 kHz directly? Asterisk 20's External Media sends
// slin16 on a dynamic RTP payload type but doesn't map that payload type back
// on receive, so audio sent to it is dropped. 8 kHz slin uses static payload
// type 10 and works both ways (verified in this repo's live tests).

const TAPS = 31;
/** Cutoff as a fraction of the 16 kHz rate: 3.6 kHz, under the 4 kHz Nyquist of 8 kHz. */
const CUTOFF = 3600 / 16000;

const kernel = (() => {
  const k = new Float64Array(TAPS);
  const mid = (TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * CUTOFF : Math.sin(2 * Math.PI * CUTOFF * x) / (Math.PI * x);
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1));
    k[i] = sinc * blackman;
    sum += k[i]!;
  }
  for (let i = 0; i < TAPS; i++) k[i]! /= sum; // unity gain at DC
  return k;
})();

function clamp16(value: number): number {
  return value > 32767 ? 32767 : value < -32768 ? -32768 : Math.round(value);
}

/** Streaming FIR over 16 kHz samples. */
class Fir {
  private history = new Float64Array(TAPS - 1);

  /** Filter `input` (16 kHz), returning every `step`-th output, scaled by `gain`. */
  run(input: Float64Array, step: number, gain: number): Float64Array {
    const buffer = new Float64Array(this.history.length + input.length);
    buffer.set(this.history);
    buffer.set(input, this.history.length);
    const out = new Float64Array(Math.ceil(input.length / step));
    for (let n = 0, o = 0; n < input.length; n += step, o++) {
      let acc = 0;
      for (let k = 0; k < TAPS; k++) acc += kernel[k]! * buffer[n + TAPS - 1 - k]!;
      out[o] = acc * gain;
    }
    this.history = buffer.slice(buffer.length - (TAPS - 1));
    return out;
  }
}

/** 8 kHz -> 16 kHz: zero-stuff, then low-pass (gain 2 restores the level). */
export class Upsampler {
  private readonly fir = new Fir();

  process(input: Int16Array): Int16Array {
    const stuffed = new Float64Array(input.length * 2);
    for (let i = 0; i < input.length; i++) stuffed[i * 2] = input[i]!;
    const filtered = this.fir.run(stuffed, 1, 2);
    return Int16Array.from(filtered, clamp16);
  }
}

/** 16 kHz -> 8 kHz: low-pass, then keep every other sample. */
export class Downsampler {
  private readonly fir = new Fir();
  private odd: number | null = null; // carry a sample when chunks have odd lengths

  process(input: Int16Array): Int16Array {
    let samples = Float64Array.from(input);
    if (this.odd !== null) {
      const joined = new Float64Array(samples.length + 1);
      joined[0] = this.odd;
      joined.set(samples, 1);
      samples = joined;
      this.odd = null;
    }
    if (samples.length % 2) {
      this.odd = samples[samples.length - 1]!;
      samples = samples.subarray(0, samples.length - 1);
    }
    return Int16Array.from(this.fir.run(samples, 2, 1), clamp16);
  }
}

/** Little-endian PCM bytes <-> samples. */
export function bytesToSamples(bytes: Buffer): Int16Array {
  const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
  const copy = Buffer.from(even); // aligned copy
  return new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2);
}

export function samplesToBytes(samples: Int16Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}
