import {
  createRoom,
  getConfig,
  getRooms,
  heartbeat,
  joinRoom,
  leaveRoom,
  sendChat,
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
  cameraStream: null,
  screenStream: null,
  activeVideoTrack: null,
  analyser: null,
  meterFrame: null,
  gainPercent: 100,
  muted: false,
  micTestHidden: false,
  heartbeatTimer: null,
  audioElements: new Map(),
  peerStates: new Map(),
  chatScrollPinned: true,
  rooms: [],
  roomsRefreshTimer: null,
  videoElements: new Map(),
  talkingUsers: new Map(),
  remoteTalkDetectors: new Map(),
  remoteAudioContext: null,
};

const landingScreen = document.querySelector("#landing-screen");
const roomScreen = document.querySelector("#room-screen");
const createNameInput = document.querySelector("#create-name");
const joinNameInput = document.querySelector("#join-name");
const createRoomButton = document.querySelector("#create-room-button");
const landingError = document.querySelector("#landing-error");
const roomList = document.querySelector("#room-list");
const roomTitle = document.querySelector("#room-title");
const roomSubtitle = document.querySelector("#room-subtitle");
const copyRoomButton = document.querySelector("#copy-room-button");
const toggleMicTestButton = document.querySelector("#toggle-mic-test-button");
const leaveRoomButton = document.querySelector("#leave-room-button");
const connectMicButton = document.querySelector("#connect-mic-button");
const muteButton = document.querySelector("#mute-button");
const cameraButton = document.querySelector("#camera-button");
const screenShareButton = document.querySelector("#screen-share-button");
const connectionStatus = document.querySelector("#connection-status");
const micTestCard = document.querySelector("#mic-test-card");
const closeMicTestButton = document.querySelector("#close-mic-test-button");
const micTestStatus = document.querySelector("#mic-test-status");
const micMeterFill = document.querySelector("#mic-meter-fill");
const gainSlider = document.querySelector("#gain-slider");
const gainValue = document.querySelector("#gain-value");
const usersCount = document.querySelector("#users-count");
const usersList = document.querySelector("#users-list");
const chatLog = document.querySelector("#chat-log");
const chatInput = document.querySelector("#chat-input");
const sendChatButton = document.querySelector("#send-chat-button");
const localVideo = document.querySelector("#local-video");
const localVideoStatus = document.querySelector("#local-video-status");
const remoteVideoGrid = document.querySelector("#remote-video-grid");
const remoteAudioRoot = document.querySelector("#remote-audio-root");

function formatChatTime(timestamp) {
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function renderChat() {
  if (!chatLog || !state.room) {
    return;
  }

  const shouldStickToBottom =
    chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 72;

  chatLog.innerHTML = "";
  const messages = Array.isArray(state.room.messages) ? state.room.messages : [];

  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "chat-empty muted-text";
    empty.textContent = "No messages yet. Say hi.";
    chatLog.append(empty);
  } else {
    for (const message of messages) {
      const entry = document.createElement("article");
      entry.className = "chat-message";

      const header = document.createElement("div");
      header.className = "chat-message-header";

      const author = document.createElement("span");
      author.className = "chat-author";
      author.textContent = message.userId === state.self?.id ? `${message.userName} (You)` : message.userName;

      const time = document.createElement("span");
      time.className = "chat-time muted-text";
      time.textContent = formatChatTime(message.createdAt);

      header.append(author, time);

      const body = document.createElement("p");
      body.className = "chat-text";
      body.textContent = message.text;

      entry.append(header, body);
      chatLog.append(entry);
    }
  }

  if (shouldStickToBottom) {
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

function render() {
  const inRoom = Boolean(state.room && state.self);
  landingScreen.classList.toggle("hidden", inRoom);
  roomScreen.classList.toggle("hidden", !inRoom);

  if (!inRoom) {
    return;
  }

  roomTitle.textContent = state.room.name ? `${state.room.name} · ${state.room.id}` : state.room.id;
  roomSubtitle.textContent = `${state.room.users.length} player${state.room.users.length === 1 ? "" : "s"} in voice.`;
  usersCount.textContent = `${state.room.users.length} user${state.room.users.length === 1 ? "" : "s"}`;
  const sharingScreen = Boolean(state.screenStream && state.activeVideoTrack);
  const videoEnabled = Boolean(state.activeVideoTrack);
  connectionStatus.textContent = state.localStream
    ? state.muted
      ? "Mic connected, currently muted."
      : "Mic connected and transmitting."
    : "Mic offline.";
  if (videoEnabled) {
    connectionStatus.textContent += sharingScreen
      ? " Screen sharing is live."
      : " Camera video is live.";
  }
  connectMicButton.textContent = state.localStream ? "Reconnect Mic" : "Connect Mic";
  muteButton.textContent = state.muted ? "Unmute" : "Mute";
  cameraButton.textContent = videoEnabled && !sharingScreen ? "Stop Camera" : "Start Camera";
  screenShareButton.textContent = sharingScreen ? "Stop Sharing" : "Share Screen";
  gainValue.textContent = `${state.gainPercent}%`;
  micTestCard.classList.toggle("hidden", state.micTestHidden);
  toggleMicTestButton.textContent = state.micTestHidden ? "Show mic test" : "Hide mic test";
  micTestStatus.textContent = state.localStream
    ? "Speak into your mic and watch the meter react."
    : "Connect your mic to start testing.";

  usersList.innerHTML = "";
  for (const user of state.room.users) {
    const talking = isUserTalking(user.id);
    const card = document.createElement("article");
    card.className = "user-card";

    const row = document.createElement("div");
    row.className = "user-row";

    const name = document.createElement("div");
    name.className = "user-name";
    const nameDot = document.createElement("span");
    nameDot.className = `talk-dot ${talking ? "talking" : "silent"}`;
    const nameText = document.createElement("span");
    nameText.textContent = `${user.name}${user.id === state.self.id ? " (You)" : ""}`;
    name.append(nameDot, nameText);

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

    const activity = document.createElement("p");
    activity.className = `muted-text talking-indicator ${talking ? "talking" : "silent"}`;
    activity.textContent = user.muted
      ? "Muted"
      : talking
        ? "Talking now"
        : "Not talking";

    card.append(row, meta, activity);
    usersList.append(card);
  }

  refreshRemoteVideoLabels();
  renderLocalVideoPreview();
  renderChat();
}

function setLandingError(message) {
  landingError.textContent = message || "";
}

function getUserById(userId) {
  return state.room?.users?.find((user) => user.id === userId) || null;
}

function getUserDisplayName(userId) {
  const user = getUserById(userId);
  return user?.name || "Participant";
}

function isUserTalking(userId) {
  const user = getUserById(userId);
  if (user?.muted) {
    return false;
  }
  return Boolean(state.talkingUsers.get(userId));
}

function updateTalkingState(userId, isTalking) {
  const next = Boolean(isTalking);
  const prev = Boolean(state.talkingUsers.get(userId));
  if (prev === next) {
    return;
  }
  state.talkingUsers.set(userId, next);
  render();
}

function refreshRemoteVideoLabels() {
  for (const [userId, video] of state.videoElements.entries()) {
    const card = video.closest(".remote-video-card");
    const label = card?.querySelector(".remote-video-label");
    const dot = label?.querySelector(".talk-dot");
    const text = label?.querySelector(".remote-video-name");
    if (!label || !dot || !text) {
      continue;
    }

    dot.classList.toggle("talking", isUserTalking(userId));
    dot.classList.toggle("silent", !isUserTalking(userId));
    text.textContent = getUserDisplayName(userId);
  }
}

function renderRoomList() {
  if (!roomList) {
    return;
  }

  roomList.innerHTML = "";

  if (!state.rooms.length) {
    const empty = document.createElement("p");
    empty.className = "muted-text";
    empty.textContent = "No rooms available right now.";
    roomList.append(empty);
    return;
  }

  for (const room of state.rooms) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "room-list-item";

    const title = room.name ? `${room.name} · ${room.id}` : room.id;
    const userLabel = `${room.users} user${room.users === 1 ? "" : "s"}`;

    button.innerHTML = `
      <span class="room-list-title"></span>
      <span class="room-list-meta"></span>
    `;
    button.querySelector(".room-list-title").textContent = title;
    button.querySelector(".room-list-meta").textContent = userLabel;

    button.addEventListener("click", async () => {
      try {
        setLandingError("");
        const payload = await joinRoom(room.id, joinNameInput.value);
        await enterRoom(payload);
      } catch (error) {
        setLandingError(error.message);
      }
    });

    roomList.append(button);
  }
}

async function refreshRooms() {
  try {
    const payload = await getRooms();
    state.rooms = Array.isArray(payload.rooms) ? payload.rooms : [];
    renderRoomList();
  } catch (error) {
    state.rooms = [
      {
        id: "SPEDRAJ",
        name: "Egghead",
        users: 0,
        createdAt: Date.now(),
      },
    ];
    renderRoomList();
    if (error?.message && error.message !== "Unauthorized") {
      console.warn("Room list fetch failed", error);
    }
  }
}

function startRoomsPolling() {
  stopRoomsPolling();
  state.roomsRefreshTimer = setInterval(() => {
    if (state.room) {
      return;
    }
    refreshRooms().catch(() => {});
  }, 5000);
}

function stopRoomsPolling() {
  if (state.roomsRefreshTimer) {
    clearInterval(state.roomsRefreshTimer);
    state.roomsRefreshTimer = null;
  }
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
      removeRemoteVideo(userId);
      stopRemoteTalkDetector(userId);
      state.talkingUsers.delete(userId);
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
  stopRemoteTalkDetector(userId);
  state.talkingUsers.delete(userId);
}

function stopRemoteTalkDetector(userId) {
  const detector = state.remoteTalkDetectors.get(userId);
  if (!detector) {
    return;
  }

  if (detector.frame) {
    cancelAnimationFrame(detector.frame);
  }

  try {
    detector.source.disconnect();
  } catch {
    // ignore
  }

  state.remoteTalkDetectors.delete(userId);
}

function ensureRemoteTalkDetector(userId, stream) {
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stopRemoteTalkDetector(userId);
    updateTalkingState(userId, false);
    return;
  }

  const existing = state.remoteTalkDetectors.get(userId);
  if (existing && existing.trackId === track.id) {
    return;
  }

  stopRemoteTalkDetector(userId);

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }

  if (!state.remoteAudioContext) {
    state.remoteAudioContext = new AudioContextClass();
  }

  if (state.remoteAudioContext.state === "suspended") {
    state.remoteAudioContext.resume().catch(() => {});
  }

  const source = state.remoteAudioContext.createMediaStreamSource(stream);
  const analyser = state.remoteAudioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.86;
  source.connect(analyser);

  const sample = new Uint8Array(analyser.fftSize);
  const detector = {
    trackId: track.id,
    source,
    analyser,
    frame: null,
  };

  const tick = () => {
    analyser.getByteTimeDomainData(sample);
    let sumSquares = 0;
    for (const value of sample) {
      const normalized = (value - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / sample.length);
    const talking = rms > 0.035;
    updateTalkingState(userId, talking);
    detector.frame = requestAnimationFrame(tick);
  };

  detector.frame = requestAnimationFrame(tick);
  state.remoteTalkDetectors.set(userId, detector);
}

function removeRemoteVideo(userId) {
  const video = state.videoElements.get(userId);
  if (!video) {
    return;
  }
  video.srcObject = null;
  video.closest(".remote-video-card")?.remove();
  state.videoElements.delete(userId);
}

function renderLocalVideoPreview() {
  if (!localVideo || !localVideoStatus) {
    return;
  }

  if (state.activeVideoTrack) {
    localVideo.classList.remove("hidden");
    localVideoStatus.classList.add("hidden");
    const stream = new MediaStream([state.activeVideoTrack]);
    localVideo.srcObject = stream;
    return;
  }

  localVideo.srcObject = null;
  localVideo.classList.add("hidden");
  localVideoStatus.classList.remove("hidden");
  localVideoStatus.textContent = "Camera and screen share are off.";
}

function ensureRemoteVideo(userId, stream) {
  if (!remoteVideoGrid) {
    return;
  }

  const hasVideo = stream.getVideoTracks().length > 0;
  if (!hasVideo) {
    removeRemoteVideo(userId);
    return;
  }

  let video = state.videoElements.get(userId);
  const labelText = getUserDisplayName(userId);
  const talking = isUserTalking(userId);
  if (!video) {
    const card = document.createElement("article");
    card.className = "remote-video-card panel";
    card.dataset.userId = userId;

    const label = document.createElement("p");
    label.className = "muted-text remote-video-label";
    label.innerHTML = `<span class="talk-dot ${talking ? "talking" : "silent"}"></span><span class="remote-video-name"></span>`;
    label.querySelector(".remote-video-name").textContent = labelText;

    video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.className = "remote-video";

    card.append(label, video);
    remoteVideoGrid.append(card);
    state.videoElements.set(userId, video);
  } else {
    const card = video.closest(".remote-video-card");
    const label = card?.querySelector(".remote-video-label");
    const text = label?.querySelector(".remote-video-name");
    const dot = label?.querySelector(".talk-dot");
    if (text) {
      text.textContent = labelText;
    }
    if (dot) {
      dot.classList.toggle("talking", talking);
      dot.classList.toggle("silent", !talking);
    }
  }

  video.srcObject = stream;
}

function getActiveVideoTrack() {
  return state.activeVideoTrack;
}

async function syncOutgoingVideoTrack() {
  if (!state.voiceMesh) {
    renderLocalVideoPreview();
    return;
  }
  await state.voiceMesh.setVideoTrack(getActiveVideoTrack());
  renderLocalVideoPreview();
}

function stopCameraTrack() {
  const track = state.cameraStream?.getVideoTracks()[0] || null;
  track?.stop();
  state.cameraStream = null;
}

function stopScreenTrack() {
  const track = state.screenStream?.getVideoTracks()[0] || null;
  track?.stop();
  state.screenStream = null;
}

async function startCamera() {
  const cameraStream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });

  const nextTrack = cameraStream.getVideoTracks()[0] || null;
  if (!nextTrack) {
    throw new Error("No camera track available.");
  }

  stopCameraTrack();
  state.cameraStream = cameraStream;
  state.activeVideoTrack = nextTrack;
  nextTrack.onended = () => {
    if (state.activeVideoTrack?.id === nextTrack.id) {
      state.activeVideoTrack = null;
      syncOutgoingVideoTrack().catch(() => {});
      render();
    }
    state.cameraStream = null;
  };

  await syncOutgoingVideoTrack();
  render();
}

async function stopCamera() {
  const activeId = state.cameraStream?.getVideoTracks()[0]?.id;
  if (activeId && state.activeVideoTrack?.id === activeId) {
    state.activeVideoTrack = null;
  }
  stopCameraTrack();
  await syncOutgoingVideoTrack();
  render();
}

async function startScreenShare() {
  const screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });

  const nextTrack = screenStream.getVideoTracks()[0] || null;
  if (!nextTrack) {
    throw new Error("No screen track available.");
  }

  stopScreenTrack();
  state.screenStream = screenStream;
  state.activeVideoTrack = nextTrack;
  nextTrack.onended = () => {
    if (state.activeVideoTrack?.id === nextTrack.id) {
      const fallbackTrack = state.cameraStream?.getVideoTracks()[0] || null;
      state.activeVideoTrack = fallbackTrack;
      syncOutgoingVideoTrack().catch(() => {});
      render();
    }
    state.screenStream = null;
  };

  await syncOutgoingVideoTrack();
  render();
}

async function stopScreenShare() {
  const activeId = state.screenStream?.getVideoTracks()[0]?.id;
  if (activeId && state.activeVideoTrack?.id === activeId) {
    state.activeVideoTrack = state.cameraStream?.getVideoTracks()[0] || null;
  }
  stopScreenTrack();
  await syncOutgoingVideoTrack();
  render();
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
  audio.play().catch((error) => {
    if (error.name === "NotAllowedError") {
      console.warn("Audio playback blocked by browser. User interaction required.");
      connectionStatus.textContent = "Audio playback blocked. Click anywhere to enable sound.";
    }
  });
  ensureRemoteTalkDetector(userId, stream);
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
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
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
    const talking = !state.muted && Boolean(state.localStream) && level > 10;
    if (state.self?.id) {
      updateTalkingState(state.self.id, talking);
    }
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

  if (state.self?.id) {
    updateTalkingState(state.self.id, false);
  }
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
  stopRoomsPolling();
  state.token = payload.token;
  state.self = payload.self;
  state.room = payload.room;
  state.peerStates.clear();
  state.voiceMesh = new VoiceMesh({
    selfId: state.self.id,
    iceServers: state.iceServers,
    getLocalStream: ensureMic,
    getExtraTracks: async () => {
      const track = getActiveVideoTrack();
      return track ? [track] : [];
    },
    sendSignal: (targetUserId, signal) => sendSignal(state.token, targetUserId, signal),
    onRemoteStream: (peerId, stream) => {
      ensureRemoteAudio(peerId, stream);
      ensureRemoteVideo(peerId, stream);
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

  chatInput?.focus();
}

function teardownRoom(reason) {
  state.events?.close();
  state.events = null;
  state.voiceMesh?.closeAll();
  state.voiceMesh = null;
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
  startRoomsPolling();
  stopScreenTrack();
  stopCameraTrack();
  state.activeVideoTrack = null;
  teardownMic();

  for (const userId of Array.from(state.audioElements.keys())) {
    removeRemoteAudio(userId);
  }

  for (const userId of Array.from(state.videoElements.keys())) {
    removeRemoteVideo(userId);
  }

  for (const userId of Array.from(state.remoteTalkDetectors.keys())) {
    stopRemoteTalkDetector(userId);
  }

  if (state.remoteAudioContext) {
    state.remoteAudioContext.close().catch(() => {});
    state.remoteAudioContext = null;
  }

  if (localVideo) {
    localVideo.srcObject = null;
  }

  state.room = null;
  state.self = null;
  state.token = null;
  state.peerStates.clear();
  state.talkingUsers.clear();
  state.chatScrollPinned = true;
  history.replaceState(null, "", location.pathname);
  setLandingError(reason || "");
  refreshRooms().catch(() => {});
  render();
}

async function handleSendChat() {
  if (!state.token || !chatInput) {
    return;
  }

  const text = chatInput.value.trim();
  if (!text) {
    return;
  }

  chatInput.value = "";
  try {
    const payload = await sendChat(state.token, text);
    updateRoomState(payload.room);
  } catch (error) {
    connectionStatus.textContent = error.message;
  }
}

async function handleCreateRoom() {
  try {
    setLandingError("");
    const payload = await createRoom(createNameInput.value);
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

async function handleToggleCamera() {
  try {
    if (state.cameraStream && state.activeVideoTrack === state.cameraStream.getVideoTracks()[0]) {
      await stopCamera();
      return;
    }
    await startCamera();
  } catch (error) {
    connectionStatus.textContent = `Camera unavailable: ${error.message}`;
  }
}

async function handleToggleScreenShare() {
  try {
    const isSharing =
      state.screenStream && state.activeVideoTrack === state.screenStream.getVideoTracks()[0];
    if (isSharing) {
      await stopScreenShare();
      return;
    }
    await startScreenShare();
  } catch (error) {
    connectionStatus.textContent = `Screen share unavailable: ${error.message}`;
  }
}

createRoomButton.addEventListener("click", handleCreateRoom);

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
cameraButton.addEventListener("click", handleToggleCamera);
screenShareButton.addEventListener("click", handleToggleScreenShare);

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

sendChatButton?.addEventListener("click", () => {
  handleSendChat();
});

chatInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleSendChat();
  }
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
}

async function bootstrap() {
  document.addEventListener("click", () => {
    if (state.audioContext && state.audioContext.state === "suspended") {
      state.audioContext.resume().catch(() => {});
    }
    if (state.remoteAudioContext && state.remoteAudioContext.state === "suspended") {
      state.remoteAudioContext.resume().catch(() => {});
    }
    // Try to play all remote audio elements that might be paused
    for (const audio of state.audioElements.values()) {
      if (audio.paused) {
        audio.play().catch(() => {});
      }
    }
  }, { once: false });

  try {
    const config = await getConfig();
    if (Array.isArray(config.iceServers) && config.iceServers.length > 0) {
      state.iceServers = config.iceServers;
    }
  } catch {
    // Fall back to the built-in STUN server if config loading fails.
  }

  tryAutoJoinFromHash();
  startRoomsPolling();
  await refreshRooms();
  render();
}

bootstrap();
