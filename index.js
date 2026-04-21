const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* 🔑 ENV VARIABLES (REQUIRED ON RENDER) */
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_SECRET = process.env.LIVEKIT_API_SECRET;

if (!LIVEKIT_URL || !LIVEKIT_KEY || !LIVEKIT_SECRET) {
  console.error("❌ Missing LiveKit environment variables");
}

/* ===== MEMORY ===== */
let activeLives = [];
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { host: null, viewers: new Map() });
  }
  return rooms.get(roomId);
}

/* ===== WEBSOCKET SIGNALING ===== */
wss.on("connection", (ws) => {
  let currentRoom = null;
  let role = null;
  let myViewerId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case "host-join":
        currentRoom = msg.room;
        role = "host";
        const roomH = getRoom(currentRoom);
        roomH.host = ws;

        roomH.viewers.forEach((vws, vid) => {
          if (vws.readyState === 1) {
            ws.send(JSON.stringify({ type: "viewer-ready", viewerId: vid }));
          }
        });
        break;

      case "viewer-join":
        currentRoom = msg.room;
        role = "viewer";
        myViewerId = msg.viewerId;

        const roomV = getRoom(currentRoom);
        roomV.viewers.set(myViewerId, ws);

        if (roomV.host && roomV.host.readyState === 1) {
          roomV.host.send(JSON.stringify({ type: "viewer-ready", viewerId: myViewerId }));
        }
        break;

      case "offer":
        if (role !== "host") break;
        const roomO = rooms.get(currentRoom);
        if (!roomO) break;

        const vws = roomO.viewers.get(msg.viewerId);
        if (vws?.readyState === 1) vws.send(JSON.stringify(msg));
        break;

      case "answer":
        if (role !== "viewer") break;
        const roomA = rooms.get(currentRoom);
        if (!roomA) break;

        if (roomA.host?.readyState === 1) {
          roomA.host.send(JSON.stringify({ ...msg, viewerId: myViewerId }));
        }
        break;

      case "ice-candidate":
        const roomI = rooms.get(currentRoom);
        if (!roomI) break;

        if (role === "host") {
          const vw = roomI.viewers.get(msg.viewerId);
          if (vw?.readyState === 1) vw.send(JSON.stringify(msg));
        } else {
          if (roomI.host?.readyState === 1) {
            roomI.host.send(JSON.stringify({ ...msg, viewerId: myViewerId }));
          }
        }
        break;
    }
  });

  ws.on("close", () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;

    const room = rooms.get(currentRoom);

    if (role === "host") {
      room.host = null;
      room.viewers.forEach(vws => {
        if (vws.readyState === 1) {
          vws.send(JSON.stringify({ type: "host-left" }));
        }
      });
    } else if (myViewerId) {
      room.viewers.delete(myViewerId);
      if (room.host?.readyState === 1) {
        room.host.send(JSON.stringify({ type: "viewer-left", viewerId: myViewerId }));
      }
    }
  });
});

/* ===== ROUTES ===== */

// 🔍 Health check (VERY useful on Render)
app.get("/", (req, res) => {
  res.send("✅ SERVER WORKING");
});

// 🔥 TOKEN ENDPOINT (critical)
app.get("/token", async (req, res) => {
  try {
    if (!LIVEKIT_KEY || !LIVEKIT_SECRET) {
      return res.status(500).json({ error: "Missing LiveKit credentials" });
    }

    const roomName = req.query.room || "test-room";
    const identity = req.query.identity || `user_${Math.random().toString(36).slice(2)}`;

    const at = new AccessToken(LIVEKIT_KEY, LIVEKIT_SECRET, {
      identity,
      ttl: 3600,
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    res.json({
      token,
      url: LIVEKIT_URL,
      room: roomName,
      identity,
    });

  } catch (err) {
    console.error("❌ TOKEN ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ===== LIVE SYSTEM ===== */

app.post("/start-live", (req, res) => {
  const { room, user, thumbnail } = req.body;

  activeLives = activeLives.filter(l => l.room !== room);
  activeLives.push({
    room,
    user,
    thumbnail: thumbnail || null,
    startedAt: Date.now()
  });

  res.json({ success: true });
});

app.post("/end-live", (req, res) => {
  const { room } = req.body;
  activeLives = activeLives.filter(l => l.room !== room);
  res.json({ success: true });
});

app.get("/lives", (req, res) => res.json(activeLives));

/* ===== STATIC ===== */
app.use("/stream", express.static(path.join(__dirname, "../assets/videos")));
app.use("/thumb", express.static(path.join(__dirname, "../assets/images")));

/* ===== START SERVER ===== */
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});