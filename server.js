const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

function FindIndexHtml(StartDir) {
  const Queue = [StartDir];

  while (Queue.length > 0) {
    const CurrentDir = Queue.shift();

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
        Queue.push(FullPath);
      }
    }
  }

  return null;
}

const CandidatePaths = [
  path.join(__dirname, "index.html"),
  path.join(__dirname, "public", "index.html"),
  path.join(__dirname, "src", "index.html")
];

app.get("/", (req, res) => {
  for (const FilePath of CandidatePaths) {
    if (fs.existsSync(FilePath)) {
      return res.sendFile(FilePath);
    }
  }

  const FoundPath = FindIndexHtml(__dirname);
  if (FoundPath) {
    return res.sendFile(FoundPath);
  }

  res.status(404).send("Error: index.html file could not be found.");
});

let Players = {};

function NormalizeName(Name) {
  if (typeof Name !== "string") return "Duck";
  const Clean = Name.trim();
  if (!Clean) return "Duck";
  return Clean.slice(0, 10);
}

function CreatePlayer(SocketId, Data = {}) {
  return {
    id: SocketId,
    x: typeof Data.x === "number" ? Data.x : 100,
    y: typeof Data.y === "number" ? Data.y : 200,
    name: NormalizeName(Data.name),
    score: typeof Data.score === "number" ? Data.score : 0,
    isDead: typeof Data.isDead === "boolean" ? Data.isDead : false
  };
}

function SnapshotPlayer(Player) {
  return {
    id: Player.id,
    x: Player.x,
    y: Player.y,
    name: Player.name,
    score: Player.score,
    isDead: Player.isDead
  };
}

function SnapshotAllPlayers() {
  const Out = {};

  for (const Id in Players) {
    Out[Id] = SnapshotPlayer(Players[Id]);
  }

  return Out;
}

function UpsertPlayer(SocketId, Data = {}) {
  if (!Players[SocketId]) {
    Players[SocketId] = CreatePlayer(SocketId, Data);
    return Players[SocketId];
  }

  if (typeof Data.x === "number") Players[SocketId].x = Data.x;
  if (typeof Data.y === "number") Players[SocketId].y = Data.y;
  if (typeof Data.score === "number") Players[SocketId].score = Data.score;
  if (typeof Data.isDead === "boolean") Players[SocketId].isDead = Data.isDead;
  if (typeof Data.name === "string") Players[SocketId].name = NormalizeName(Data.name);

  return Players[SocketId];
}

io.on("connection", (socket) => {
  socket.on("join-game", (Data = {}) => {
    const IsNew = !Players[socket.id];
    const Player = UpsertPlayer(socket.id, Data);

    socket.emit("current-players", SnapshotAllPlayers());

    if (IsNew) {
      socket.broadcast.emit("player-joined", SnapshotPlayer(Player));
    } else {
      io.emit("player-state", SnapshotPlayer(Player));
    }
  });

  socket.on("update-position", (Data = {}) => {
    const Player = UpsertPlayer(socket.id, Data);
    io.emit("player-state", SnapshotPlayer(Player));
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
