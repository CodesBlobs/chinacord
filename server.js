const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOM_LIMIT = 8;
const USER_STALE_MS = 30000;
const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: [
      "turn:free.expressturn.com:3478?transport=udp",
      "turn:free.expressturn.com:3478?transport=tcp",
    ],
    username: "000000002090462309",
    credential: "YkFRm4S7BRDwr0lCloMVCC6nxi4=",
  },
];

const rooms = new Map();
const sessions = new Map();
const sseClients = new Map();

function now() {
  return Date.now();
}

function createRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function createUserId() {
  return `user-${crypto.randomUUID()}`;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    muted: Boolean(user.muted),
    joinedAt: user.joinedAt,
    lastSeen: user.lastSeen,
  };
}

function serializeRoom(room) {
  return {
    id: room.id,
    users: Array.from(room.users.values())
      .map(publicUser)
      .sort((a, b) => a.joinedAt - b.joinedAt),
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getSession(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return null;
  }

  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  const room = rooms.get(session.roomId);
  if (!room || !room.users.has(session.userId)) {
    sessions.delete(token);
    return null;
  }

  session.lastSeen = now();
  const user = room.users.get(session.userId);
  user.lastSeen = now();

  return { token, ...session };
}

function getClientSet(userId) {
  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  return sseClients.get(userId);
}

function emitToUser(userId, event) {
  const clients = sseClients.get(userId);
  if (!clients) {
    return;
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function emitRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }
  const snapshot = serializeRoom(room);
  for (const user of room.users.values()) {
    emitToUser(user.id, { type: "room-state", room: snapshot });
  }
}

function removeUserFromRoom(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  room.users.delete(userId);
  for (const [token, session] of sessions.entries()) {
    if (session.roomId === roomId && session.userId === userId) {
      sessions.delete(token);
    }
  }

  if (room.users.size === 0) {
    rooms.delete(roomId);
    return;
  }

  emitRoomState(roomId);
}

function cleanupStaleUsers() {
  const cutoff = now() - USER_STALE_MS;

  for (const [roomId, room] of rooms.entries()) {
    let changed = false;

    for (const user of Array.from(room.users.values())) {
      if (user.lastSeen < cutoff) {
        room.users.delete(user.id);
        changed = true;
      }
    }

    for (const [token, session] of sessions.entries()) {
      if (session.roomId !== roomId) {
        continue;
      }
      if (!room.users.has(session.userId)) {
        sessions.delete(token);
      }
    }

    if (room.users.size === 0) {
      rooms.delete(roomId);
      continue;
    }

    if (changed) {
      emitRoomState(roomId);
    }
  }
}

function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(filePath);
    const contentType =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "application/javascript; charset=utf-8"
            : "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/config" && req.method === "GET") {
    sendJson(res, 200, {
      iceServers: DEFAULT_ICE_SERVERS,
    });
    return;
  }

  if (pathname === "/api/rooms" && req.method === "POST") {
    const body = await readBody(req);
    const displayName = String(body.displayName || "").trim().slice(0, 24);
    if (!displayName) {
      sendJson(res, 400, { error: "Display name is required." });
      return;
    }

    const roomId = createRoomId();
    const user = {
      id: createUserId(),
      name: displayName,
      muted: false,
      joinedAt: now(),
      lastSeen: now(),
    };

    rooms.set(roomId, {
      id: roomId,
      createdAt: now(),
      users: new Map([[user.id, user]]),
    });

    const token = crypto.randomUUID();
    sessions.set(token, { roomId, userId: user.id, lastSeen: now() });

    sendJson(res, 200, {
      token,
      room: serializeRoom(rooms.get(roomId)),
      self: publicUser(user),
    });
    return;
  }

  if (pathname === "/api/join" && req.method === "POST") {
    const body = await readBody(req);
    const roomId = String(body.roomId || "").trim().toUpperCase();
    const displayName = String(body.displayName || "").trim().slice(0, 24);

    if (!displayName) {
      sendJson(res, 400, { error: "Display name is required." });
      return;
    }
    if (!roomId) {
      sendJson(res, 400, { error: "Room code is required." });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      sendJson(res, 404, { error: "That room does not exist." });
      return;
    }
    if (room.users.size >= ROOM_LIMIT) {
      sendJson(res, 409, { error: "That room is full." });
      return;
    }

    const user = {
      id: createUserId(),
      name: displayName,
      muted: false,
      joinedAt: now(),
      lastSeen: now(),
    };

    room.users.set(user.id, user);
    const token = crypto.randomUUID();
    sessions.set(token, { roomId, userId: user.id, lastSeen: now() });

    emitRoomState(roomId);

    sendJson(res, 200, {
      token,
      room: serializeRoom(room),
      self: publicUser(user),
    });
    return;
  }

  if (pathname === "/api/events" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const session = token ? sessions.get(token) : null;

    if (!session) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const room = rooms.get(session.roomId);
    if (!room) {
      sendJson(res, 404, { error: "Room not found." });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const clients = getClientSet(session.userId);
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: "room-state", room: serializeRoom(room) })}\n\n`);

    const keepalive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(keepalive);
      clients.delete(res);
    });
    return;
  }

  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const room = rooms.get(session.roomId);
  const user = room?.users.get(session.userId);
  if (!room || !user) {
    sendJson(res, 404, { error: "Room or user not found." });
    return;
  }

  if (pathname === "/api/heartbeat" && req.method === "POST") {
    sendJson(res, 200, { room: serializeRoom(room) });
    return;
  }

  if (pathname === "/api/leave" && req.method === "POST") {
    removeUserFromRoom(session.roomId, session.userId);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/mute" && req.method === "POST") {
    const body = await readBody(req);
    user.muted = Boolean(body.muted);
    user.lastSeen = now();
    emitRoomState(session.roomId);
    sendJson(res, 200, { room: serializeRoom(room) });
    return;
  }

  if (pathname === "/api/signal" && req.method === "POST") {
    const body = await readBody(req);
    const targetUserId = String(body.targetUserId || "").trim();
    if (!room.users.has(targetUserId)) {
      sendJson(res, 404, { error: "Target user not found." });
      return;
    }

    emitToUser(targetUserId, {
      type: "signal",
      roomId: session.roomId,
      fromUserId: session.userId,
      toUserId: targetUserId,
      signal: body.signal,
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error." });
  }
});

setInterval(cleanupStaleUsers, 5000);

server.listen(PORT, () => {
  console.log(`DropZone Voice listening on http://localhost:${PORT}`);
});
