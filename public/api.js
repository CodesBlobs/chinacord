async function request(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

export function createRoom(displayName) {
  return request("/api/rooms", {
    method: "POST",
    body: { displayName },
  });
}

export function getConfig() {
  return request("/api/config");
}

export function joinRoom(roomId, displayName) {
  return request("/api/join", {
    method: "POST",
    body: { roomId, displayName },
  });
}

export function heartbeat(token) {
  return request("/api/heartbeat", {
    method: "POST",
    token,
  });
}

export function leaveRoom(token) {
  return request("/api/leave", {
    method: "POST",
    token,
  });
}

export function setMuted(token, muted) {
  return request("/api/mute", {
    method: "POST",
    token,
    body: { muted },
  });
}

export function sendSignal(token, targetUserId, signal) {
  return request("/api/signal", {
    method: "POST",
    token,
    body: { targetUserId, signal },
  });
}

export function subscribeToEvents(token, handlers) {
  const eventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);

  eventSource.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "room-state") {
      handlers.onRoomState?.(payload.room);
      return;
    }
    if (payload.type === "signal") {
      handlers.onSignal?.(payload);
    }
  };

  eventSource.onerror = () => {
    handlers.onError?.(new Error("Realtime connection lost."));
  };

  return {
    close() {
      eventSource.close();
    },
  };
}
