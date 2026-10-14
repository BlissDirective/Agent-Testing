// Browser side of a call: streams the mic to the server and plays the
// assistant's audio, dropping queued audio the moment the user interrupts.

const SAMPLE_RATE = 16000;

const button = document.querySelector("#call");
const statusEl = document.querySelector("#status");
const log = document.querySelector("#log");

let call = null;

button.addEventListener("click", () => (call ? call.hangUp() : startCall()));

async function startCall() {
  button.disabled = true;
  setStatus("Connecting…");
  try {
    call = await connect();
    button.textContent = "End call";
  } catch (error) {
    setStatus(`Could not start: ${error.message}`);
    call = null;
  } finally {
    button.disabled = false;
  }
}

async function connect() {
  // Echo cancellation keeps the assistant from hearing (and interrupting) itself.
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const audio = new AudioContext({ sampleRate: SAMPLE_RATE });
  await audio.audioWorklet.addModule("mic-worklet.js");

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/call`);
  socket.binaryType = "arraybuffer";

  const capture = new AudioWorkletNode(audio, "mic-capture");
  audio.createMediaStreamSource(mic).connect(capture);
  capture.port.onmessage = ({ data }) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  };

  const player = new Player(audio);
  let assistantLine = null;

  socket.onmessage = ({ data }) => {
    if (data instanceof ArrayBuffer) {
      player.play(data);
      return;
    }
    const message = JSON.parse(data);
    switch (message.type) {
      case "listening":
        setStatus("Connected. Start talking.");
        break;
      case "transcript":
        if (message.role === "assistant") addLine("Assistant", message.transcript); // scripted speech
        else if (message.transcriptType === "final") addLine("You", message.transcript);
        else setStatus(`Hearing: ${message.transcript}`);
        break;
      case "model-output":
        assistantLine ??= addLine("Assistant", "");
        assistantLine.textContent += message.output;
        break;
      case "speech-update":
        if (message.role === "assistant") {
          setStatus(message.status === "started" ? "Assistant speaking…" : "Listening…");
          if (message.status === "stopped") assistantLine = null;
        }
        break;
      case "user-interrupted":
        player.stop();
        assistantLine = null;
        break;
      case "tool-call":
        addLine("Tool", `${message.name}(${JSON.stringify(message.input)})`);
        break;
      case "status-update":
        if (message.status === "ended") setStatus(`Call ended (${message.endedReason}).`);
        break;
      case "error":
        addLine("Error", message.message);
        break;
    }
  };

  const cleanup = () => {
    mic.getTracks().forEach((track) => track.stop());
    audio.close();
    call = null;
    button.textContent = "Start call";
  };
  socket.onclose = cleanup;

  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("WebSocket connection failed"));
  });

  return {
    hangUp() {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "end-call" }));
      else cleanup();
    },
  };
}

/** Plays PCM chunks back to back, and can drop everything queued at once. */
class Player {
  constructor(audio) {
    this.audio = audio;
    this.nextStart = 0;
    this.sources = new Set();
  }

  play(buffer) {
    const pcm = new Int16Array(buffer);
    const clip = this.audio.createBuffer(1, pcm.length, SAMPLE_RATE);
    const samples = clip.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;

    const source = this.audio.createBufferSource();
    source.buffer = clip;
    source.connect(this.audio.destination);
    this.nextStart = Math.max(this.nextStart, this.audio.currentTime);
    source.start(this.nextStart);
    this.nextStart += clip.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  stop() {
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.nextStart = this.audio.currentTime;
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function addLine(who, text) {
  const line = document.createElement("p");
  const label = document.createElement("strong");
  label.textContent = `${who}: `;
  const body = document.createElement("span");
  body.textContent = text;
  line.append(label, body);
  log.append(line);
  line.scrollIntoView({ block: "end" });
  return body;
}
