const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

function FindIndexHtml(StartDir) {
  const SearchQueue = [StartDir];

  while (SearchQueue.length > 0) {
    const CurrentDir = SearchQueue.shift();

    let Entries;
    try {
      Entries = fs.readdirSync(CurrentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const Entry of Entries) {
      const FullPath = path.join(CurrentDir, Entry.name);

      if (Entry.isFile() && Entry.name.toLowerCase() === "index.html") {
        return FullPath;
      }

      if (Entry.isDirectory() && Entry.name !== "node_modules" && Entry.name !== ".git") {
        SearchQueue.push(FullPath);
      }
    }
  }

  return null;
}

const RootIndexPath = path.join(__dirname, "index.html");
const PublicIndexPath = path.join(__dirname, "public", "index.html");
const SrcIndexPath = path.join(__dirname, "src", "index.html");
const DiscoveredIndexPath = FindIndexHtml(__dirname);

app.get("/", (req, res) => {
  if (fs.existsSync(RootIndexPath)) {
    return res.sendFile(RootIndexPath);
  }

  if (fs.existsSync(PublicIndexPath)) {
    return res.sendFile(PublicIndexPath);
  }

  if (fs.existsSync(SrcIndexPath)) {
    return res.sendFile(SrcIndexPath);
  }

  if (DiscoveredIndexPath) {
    return res.sendFile(DiscoveredIndexPath);
  }

  res.status(404).send("Error: index.html file could not be found.");
});

let Players = {};

function ClonePlayers() {
  const Snapshot = {};

  for (const Id in Players) {
    Snapshot[Id] = {
      id: Players[Id].id,
      x: Players[Id].x,
      y: Players[Id].y,
      name: Players[Id].name,
      score: Players[Id].score,
      isDead: Players[Id].isDead
    };
  }

  return Snapshot;
}

function NormalizeName(Name) {
  if (typeof Name !== "string") return "Duck";
  const Trimmed = Name.trim();
  if (!Trimmed) return "Duck";
  return Trimmed.slice(0, 10);
}

function CreatePlayer(SocketId, Data) {
  return {
    id: SocketId,
    x: typeof Data.x === "number" ? Data.x : 100,
    y: typeof Data.y === "number" ? Data.y : 200,
    name: NormalizeName(Data.name),
    score: typeof Data.score === "number" ? Data.score : 0,
    isDead: typeof Data.isDead === "boolean" ? Data.isDead : false
  };
}

function UpdatePlayer(SocketId, Data) {
  if (!Players[SocketId]) {
    Players[SocketId] = CreatePlayer(SocketId, Data);
    return;
  }

  if (typeof Data.x === "number") Players[SocketId].x = Data.x;
  if (typeof Data.y === "number") Players[SocketId].y = Data.y;
  if (typeof Data.score === "number") Players[SocketId].score = Data.score;
  if (typeof Data.isDead === "boolean") Players[SocketId].isDead = Data.isDead;

  if (typeof Data.name === "string") {
    const CleanName = NormalizeName(Data.name);
    if (CleanName) Players[SocketId].name = CleanName;
  }
}

function EmitPlayerState(SocketId, Target) {
  const Player = Players[SocketId];
  if (!Player) return;

  Target.emit("player-state", {
    id: Player.id,
    x: Player.x,
    y: Player.y,
    name: Player.name,
    score: Player.score,
    isDead: Player.isDead
  });
}

function BroadcastPlayerState(SocketId) {
  const Player = Players[SocketId];
  if (!Player) return;

  io.emit("player-state", {
    id: Player.id,
    x: Player.x,
    y: Player.y,
    name: Player.name,
    score: Player.score,
    isDead: Player.isDead
  });
}

io.on("connection", (socket) => {
  socket.on("join-game", (Data = {}) => {
    const IsNewPlayer = !Players[socket.id];
    Players[socket.id] = CreatePlayer(socket.id, Data);

    EmitPlayerState(socket.id, socket);
    socket.emit("current-players", ClonePlayers());

    if (IsNewPlayer) {
      socket.broadcast.emit("player-joined", {
        id: Players[socket.id].id,
        x: Players[socket.id].x,
        y: Players[socket.id].y,
        name: Players[socket.id].name,
        score: Players[socket.id].score,
        isDead: Players[socket.id].isDead
      });
    } else {
      socket.broadcast.emit("player-state", {
        id: Players[socket.id].id,
        x: Players[socket.id].x,
        y: Players[socket.id].y,
        name: Players[socket.id].name,
        score: Players[socket.id].score,
        isDead: Players[socket.id].isDead
      });
    }
  });

  socket.on("update-position", (Data = {}) => {
    UpdatePlayer(socket.id, Data);
    BroadcastPlayerState(socket.id);
  });

  socket.on("disconnect", () => {
    if (Players[socket.id]) {
      delete Players[socket.id];
      io.emit("player-disconnected", socket.id);
    }
  });
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
