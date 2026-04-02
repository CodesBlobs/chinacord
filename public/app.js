import {
  createRoom,
  getConfig,
  heartbeat,
  joinRoom,
  leaveRoom,
  sendSignal,
  setMuted,
  subscribeToEvents,
} from "./api.js";
import { VoiceMesh } from "./webrtc.js";

const state = {
  token: null,
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  room: null,
  self: null,
  events: null,
  voiceMesh: null,
  rawMicStream: null,
  localStream: null,
  audioContext: null,
  micSource: null,
  micGainNode: null,
  micDestination: null,
  analyser: null,
  meterFrame: null,
  gainPercent: 100,
  muted: false,
  micTestHidden: false,
  heartbeatTimer: null,
  audioElements: new Map(),
  peerStates: new Map(),
};

const landingScreen = document.querySelector("#landing-screen");
const roomScreen = document.querySelector("#room-screen");
const createNameInput = document.querySelector("#create-name");
const joinNameInput = document.querySelector("#join-name");
const roomCodeInput = document.querySelector("#room-code");
const createRoomButton = document.querySelector("#create-room-button");
const joinRoomButton = document.querySelector("#join-room-button");
const landingError = document.querySelector("#landing-error");
const roomTitle = document.querySelector("#room-title");
const roomSubtitle = document.querySelector("#room-subtitle");
const copyRoomButton = document.querySelector("#copy-room-button");
const toggleMicTestButton = document.querySelector("#toggle-mic-test-button");
const leaveRoomButton = document.querySelector("#leave-room-button");
const connectMicButton = document.querySelector("#connect-mic-button");
const muteButton = document.querySelector("#mute-button");
const connectionStatus = document.querySelector("#connection-status");
const micTestCard = document.querySelector("#mic-test-card");
const closeMicTestButton = document.querySelector("#close-mic-test-button");
const micTestStatus = document.querySelector("#mic-test-status");
const micMeterFill = document.querySelector("#mic-meter-fill");
const gainSlider = document.querySelector("#gain-slider");
const gainValue = document.querySelector("#gain-value");
const usersCount = document.querySelector("#users-count");
const usersList = document.querySelector("#users-list");
const remoteAudioRoot = document.querySelector("#remote-audio-root");

function render() {
  const inRoom = Boolean(state.room && state.self);
  landingScreen.classList.toggle("hidden", inRoom);
  roomScreen.classList.toggle("hidden", !inRoom);

  if (!inRoom) {
    return;
  }

  roomTitle.textContent = state.room.id;
  roomSubtitle.textContent = `${state.room.users.length} player${state.room.users.length === 1 ? "" : "s"} in voice.`;
  usersCount.textContent = `${state.room.users.length} user${state.room.users.length === 1 ? "" : "s"}`;
  connectionStatus.textContent = state.localStream
    ? state.muted
      ? "Mic connected, currently muted."
      : "Mic connected and transmitting."
    : "Mic offline.";
  connectMicButton.textContent = state.localStream ? "Reconnect Mic" : "Connect Mic";
  muteButton.textContent = state.muted ? "Unmute" : "Mute";
  gainValue.textContent = `${state.gainPercent}%`;
  micTestCard.classList.toggle("hidden", state.micTestHidden);
  toggleMicTestButton.textContent = state.micTestHidden ? "Show mic test" : "Hide mic test";
  micTestStatus.textContent = state.localStream
    ? "Speak into your mic and watch the meter react."
    : "Connect your mic to start testing.";

  usersList.innerHTML = "";
  for (const user of state.room.users) {
    const card = document.createElement("article");
    card.className = "user-card";

    const row = document.createElement("div");
    row.className = "user-row";

    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = `${user.name}${user.id === state.self.id ? " (You)" : ""}`;

    const pill = document.createElement("span");
    const peerState = state.peerStates.get(user.id);
    const mutedLabel = user.muted ? "Muted" : "Live";
    const connectionLabel =
      user.id === state.self.id
        ? state.localStream
          ? "Ready"
          : "No mic"
        : peerState || "Connecting";
    pill.className = `pill ${user.muted ? "warn" : ""}`;
    pill.textContent = mutedLabel;

    row.append(name, pill);

    const meta = document.createElement("p");
    meta.className = "muted-text";
    meta.textContent =
      user.id === state.self.id ? connectionLabel : `Peer audio ${connectionLabel.toLowerCase()}`;

    card.append(row, meta);
    usersList.append(card);
  }
}

function setLandingError(message) {
  landingError.textContent = message || "";
}

function updateRoomState(nextRoom) {
  if (!nextRoom) {
    teardownRoom("The room was closed or you were disconnected.");
    return;
  }

  const previousUserIds = new Set((state.room?.users || []).map((user) => user.id));
  state.room = nextRoom;
  const currentUserIds = new Set(nextRoom.users.map((user) => user.id));

  for (const userId of previousUserIds) {
    if (!currentUserIds.has(userId)) {
      state.voiceMesh?.closePeer(userId);
      removeRemoteAudio(userId);
      state.peerStates.delete(userId);
    }
  }

  render();
}

function removeRemoteAudio(userId) {
  const audio = state.audioElements.get(userId);
  if (!audio) {
    return;
  }
  audio.srcObject = null;
  audio.remove();
  state.audioElements.delete(userId);
}

function ensureRemoteAudio(userId, stream) {
  let audio = state.audioElements.get(userId);
  if (!audio) {
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    remoteAudioRoot.append(audio);
    state.audioElements.set(userId, audio);
  }
  audio.srcObject = stream;
}

async function ensureMic() {
  if (state.localStream) {
    return state.localStream;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("This browser does not support audio processing.");
  }

  const rawStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  const audioContext = new AudioContextClass();
  const micSource = audioContext.createMediaStreamSource(rawStream);
  const gainNode = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();

  gainNode.gain.value = state.gainPercent / 100;
  micSource.connect(gainNode);
  gainNode.connect(destination);

  state.rawMicStream = rawStream;
  state.audioContext = audioContext;
  state.micSource = micSource;
  state.micGainNode = gainNode;
  state.micDestination = destination;
  state.localStream = destination.stream;
  state.localStream.getAudioTracks().forEach((track) => {
    track.enabled = !state.muted;
  });

  startMicMeter();

  for (const user of state.room.users) {
    if (user.id !== state.self.id) {
      await state.voiceMesh.attachLocalTracks(user.id);
    }
  }

  render();
  return state.localStream;
}

function stopMicMeter() {
  if (state.meterFrame) {
    cancelAnimationFrame(state.meterFrame);
    state.meterFrame = null;
  }
  if (state.micSource && state.analyser) {
    try {
      state.micSource.disconnect(state.analyser);
    } catch {
      // Ignore disconnect races.
    }
  }
  state.analyser = null;
  micMeterFill.style.width = "0%";
}

function startMicMeter() {
  stopMicMeter();

  if (!state.audioContext || !state.micSource) {
    return;
  }

  const analyser = state.audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.84;
  state.micSource.connect(analyser);
  state.analyser = analyser;

  const sample = new Uint8Array(analyser.fftSize);
  const tick = () => {
    analyser.getByteTimeDomainData(sample);
    let sumSquares = 0;
    for (const value of sample) {
      const normalized = (value - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const level = Math.min(100, Math.sqrt(sumSquares / sample.length) * 280);
    micMeterFill.style.width = `${level}%`;
    state.meterFrame = requestAnimationFrame(tick);
  };

  if (state.audioContext.state === "suspended") {
    state.audioContext.resume().catch(() => {});
  }
  tick();
}

function teardownMic() {
  stopMicMeter();
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.rawMicStream?.getTracks().forEach((track) => track.stop());
  state.micDestination?.stream.getTracks().forEach((track) => track.stop());
  state.audioContext?.close().catch(() => {});

  state.rawMicStream = null;
  state.localStream = null;
  state.audioContext = null;
  state.micSource = null;
  state.micGainNode = null;
  state.micDestination = null;
}

function startHeartbeat() {
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => {
    if (!state.room || !state.self || !state.token) {
      return;
    }
    heartbeat(state.token)
      .then((payload) => updateRoomState(payload.room))
      .catch(() => teardownRoom("Connection to the room was lost."));
  }, 5000);
}

async function enterRoom(payload) {
  state.token = payload.token;
  state.self = payload.self;
  state.room = payload.room;
  state.peerStates.clear();
  state.voiceMesh = new VoiceMesh({
    selfId: state.self.id,
    iceServers: state.iceServers,
    getLocalStream: ensureMic,
    sendSignal: (targetUserId, signal) => sendSignal(state.token, targetUserId, signal),
    onRemoteStream: (peerId, stream) => {
      ensureRemoteAudio(peerId, stream);
      state.peerStates.set(peerId, "connected");
      render();
    },
    onPeerState: (peerId, connectionState) => {
      state.peerStates.set(peerId, connectionState);
      render();
    },
  });

  state.events = subscribeToEvents(state.token, {
    onRoomState: (room) => {
      updateRoomState(room);
    },
    onSignal: async (message) => {
      if (message.toUserId !== state.self.id) {
        return;
      }
      try {
        await state.voiceMesh.handleSignal(message);
      } catch (error) {
        console.error("Signal handling failed", error);
      }
    },
    onError: () => {
      teardownRoom("Realtime connection to the server was lost.");
    },
  });

  startHeartbeat();
  history.replaceState(null, "", `#room=${state.room.id}`);
  render();

  try {
    await ensureMic();
  } catch (error) {
    connectionStatus.textContent = `Mic unavailable: ${error.message}`;
  }

  for (const user of state.room.users) {
    if (user.id !== state.self.id) {
      state.peerStates.set(user.id, "connecting");
      state.voiceMesh.createOffer(user.id).catch((error) => {
        console.error("Offer creation failed", error);
      });
    }
  }
}

function teardownRoom(reason) {
  state.events?.close();
  state.events = null;
  state.voiceMesh?.closeAll();
  state.voiceMesh = null;
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
  teardownMic();

  for (const userId of state.audioElements.keys()) {
    removeRemoteAudio(userId);
  }

  state.room = null;
  state.self = null;
  state.token = null;
  state.peerStates.clear();
  history.replaceState(null, "", location.pathname);
  setLandingError(reason || "");
  render();
}

async function handleCreateRoom() {
  try {
    setLandingError("");
    const payload = createRoom(createNameInput.value);
    await enterRoom(payload);
  } catch (error) {
    setLandingError(error.message);
  }
}

async function handleJoinRoom() {
  try {
    setLandingError("");
    const payload = joinRoom(roomCodeInput.value, joinNameInput.value);
    await enterRoom(payload);
  } catch (error) {
    setLandingError(error.message);
  }
}

async function handleLeaveRoom() {
  if (state.token) {
    try {
      await leaveRoom(state.token);
    } catch {
      // Ignore leave failures during shutdown.
    }
  }
  teardownRoom("");
}

createRoomButton.addEventListener("click", handleCreateRoom);
joinRoomButton.addEventListener("click", handleJoinRoom);

copyRoomButton.addEventListener("click", async () => {
  if (!state.room) {
    return;
  }
  await navigator.clipboard.writeText(state.room.id);
  copyRoomButton.textContent = "Copied";
  setTimeout(() => {
    copyRoomButton.textContent = "Copy code";
  }, 1200);
});

toggleMicTestButton.addEventListener("click", () => {
  state.micTestHidden = !state.micTestHidden;
  render();
});

closeMicTestButton.addEventListener("click", () => {
  state.micTestHidden = true;
  render();
});

leaveRoomButton.addEventListener("click", handleLeaveRoom);

connectMicButton.addEventListener("click", async () => {
  try {
    teardownMic();
    await ensureMic();
  } catch (error) {
    connectionStatus.textContent = `Mic unavailable: ${error.message}`;
  }
});

muteButton.addEventListener("click", () => {
  state.muted = !state.muted;
  state.localStream?.getAudioTracks().forEach((track) => {
    track.enabled = !state.muted;
  });
  if (state.token) {
    setMuted(state.token, state.muted)
      .then((payload) => {
        state.room = payload.room;
        render();
      })
      .catch((error) => {
        connectionStatus.textContent = error.message;
      });
  }
  render();
});

gainSlider.addEventListener("input", () => {
  state.gainPercent = Number(gainSlider.value);
  if (state.micGainNode) {
    state.micGainNode.gain.value = state.gainPercent / 100;
  }
  render();
});

window.addEventListener("beforeunload", () => {
  if (state.token) {
    fetch("/api/leave", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
      keepalive: true,
    }).catch(() => {});
  }
});

function tryAutoJoinFromHash() {
  const match = location.hash.match(/room=([A-Z0-9]+)/i);
  if (!match) {
    return;
  }
  roomCodeInput.value = match[1].toUpperCase();
}

async function bootstrap() {
  try {
    const config = await getConfig();
    if (Array.isArray(config.iceServers) && config.iceServers.length > 0) {
      state.iceServers = config.iceServers;
    }
  } catch {
    // Fall back to the built-in STUN server if config loading fails.
  }

  tryAutoJoinFromHash();
  render();
}

bootstrap();
