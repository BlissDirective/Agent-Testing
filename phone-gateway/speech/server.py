"""Local speech server for the phone gateway: text-to-speech (Piper) and
speech-to-text (Whisper via faster-whisper), with models kept loaded so each
request is fast. Listens on localhost only.

  POST /tts   {"text": "...", "voice": "en_US-lessac-medium", "sampleRate": 16000, "speed": 1.0}
              -> audio/wav, mono 16-bit at sampleRate
  POST /stt   body: raw PCM s16le mono (Content-Type: audio/L16;rate=16000),
              optional X-Hints header (URL-encoded words to expect)
              -> {"text": "...", "confidence": 0.93}
  GET  /health

Run with speech/start.sh (installs nothing; see speech/setup.sh).
"""

import io
import json
import math
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel
from piper import PiperVoice, SynthesisConfig

HERE = Path(__file__).resolve().parent
MODELS = Path(os.environ.get("SPEECH_MODELS_DIR", HERE / "models"))
DEFAULT_VOICE = os.environ.get("PIPER_VOICE", "en_US-lessac-medium")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base.en")
PORT = int(os.environ.get("SPEECH_PORT", "8090"))
MAX_TEXT = 5000
MAX_AUDIO_BYTES = 16000 * 2 * 120  # two minutes at 16 kHz

voices: dict[str, PiperVoice] = {}
voices_lock = threading.Lock()
whisper_lock = threading.Lock()


def log(message: str) -> None:
    print(f"[speech] {message}", file=sys.stderr, flush=True)


def get_voice(name: str) -> PiperVoice:
    if not name.replace("_", "").replace("-", "").isalnum():
        raise ValueError(f"bad voice name: {name}")
    with voices_lock:
        if name not in voices:
            model = MODELS / f"{name}.onnx"
            if not model.exists():
                raise ValueError(f"voice not installed: {name} (see speech/setup.sh)")
            voices[name] = PiperVoice.load(model)
        return voices[name]


def resample(pcm: bytes, from_rate: int, to_rate: int) -> bytes:
    if from_rate == to_rate:
        return pcm
    result = subprocess.run(
        ["sox", "-t", "raw", "-r", str(from_rate), "-e", "signed", "-b", "16", "-c", "1", "-",
         "-t", "raw", "-r", str(to_rate), "-e", "signed", "-b", "16", "-c", "1", "-"],
        input=pcm, capture_output=True, check=True,
    )
    return result.stdout


def synthesize(text: str, voice_name: str, sample_rate: int, speed: float) -> bytes:
    voice = get_voice(voice_name)
    config = SynthesisConfig(length_scale=1.0 / speed)
    pcm = b"".join(chunk.audio_int16_bytes for chunk in voice.synthesize(text, syn_config=config))
    pcm = resample(pcm, voice.config.sample_rate, sample_rate)
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return out.getvalue()


def transcribe(pcm: bytes, sample_rate: int, hints: str = "") -> dict:
    if sample_rate != 16000:
        pcm = resample(pcm, sample_rate, 16000)
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    with whisper_lock:
        segments, _ = whisper.transcribe(
            audio, beam_size=1, language="en", vad_filter=False, initial_prompt=hints or None
        )
        segments = list(segments)
    text = "".join(s.text for s in segments).strip()
    if not segments:
        return {"text": "", "confidence": 0.0}
    # avg_logprob is per token; exp() gives a 0..1 score comparable across calls.
    confidence = sum(math.exp(s.avg_logprob) for s in segments) / len(segments)
    return {"text": text, "confidence": round(confidence, 3)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):  # quiet default logging
        pass

    def reply(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def reply_json(self, status: int, data: dict) -> None:
        self.reply(status, json.dumps(data).encode(), "application/json")

    def read_body(self, limit: int) -> bytes:
        length = int(self.headers.get("content-length", "0"))
        if length > limit:
            raise ValueError("body too large")
        return self.rfile.read(length)

    def do_GET(self):
        if self.path == "/health":
            installed = sorted(p.stem for p in MODELS.glob("*.onnx"))
            return self.reply_json(200, {"ok": True, "voices": installed, "whisper": WHISPER_MODEL})
        self.reply_json(404, {"error": "not found"})

    def do_POST(self):
        started = time.time()
        try:
            if self.path == "/tts":
                request = json.loads(self.read_body(100_000) or b"{}")
                text = str(request.get("text", "")).strip()
                if not text or len(text) > MAX_TEXT:
                    raise ValueError(f"text must be 1-{MAX_TEXT} characters")
                rate = int(request.get("sampleRate", 16000))
                if rate not in (8000, 16000):
                    raise ValueError("sampleRate must be 8000 or 16000")
                speed = float(request.get("speed", 1.0))
                if not 0.5 <= speed <= 2.0:
                    raise ValueError("speed must be between 0.5 and 2.0")
                wav = synthesize(text, str(request.get("voice") or DEFAULT_VOICE), rate, speed)
                log(f"tts {len(text)} chars in {time.time() - started:.2f}s")
                return self.reply(200, wav, "audio/wav")
            if self.path == "/stt":
                content_type = self.headers.get("content-type", "")
                rate = 16000
                for part in content_type.split(";"):
                    if part.strip().startswith("rate="):
                        rate = int(part.strip()[5:])
                hints = urllib.parse.unquote(self.headers.get("x-hints", ""))[:500]
                result = transcribe(self.read_body(MAX_AUDIO_BYTES), rate, hints)
                log(f"stt {result['text']!r} in {time.time() - started:.2f}s")
                return self.reply_json(200, result)
            self.reply_json(404, {"error": "not found"})
        except ValueError as error:
            self.reply_json(400, {"error": str(error)})
        except Exception as error:  # report, don't crash the server
            log(f"error: {error!r}")
            self.reply_json(500, {"error": "internal error"})


if __name__ == "__main__":
    os.environ.setdefault("HF_HOME", str(MODELS / "hf"))
    log(f"loading whisper {WHISPER_MODEL} and voice {DEFAULT_VOICE}...")
    whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", download_root=str(MODELS / "whisper"))
    get_voice(DEFAULT_VOICE)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"ready on http://127.0.0.1:{PORT}")
    server.serve_forever()
