const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

let players = {};

function safePlayer(p) {
  return {
    id: p.id,
    x: p.x,
    y: p.y,
    name: p.name,
    score: p.score,
    isDead: p.isDead
  };
}

io.on("connection", (socket) => {
  players[socket.id] = {
    id: socket.id,
    x: 100,
    y: 200,
    name: "Duck",
    score: 0,
    isDead: false
  };

  socket.emit("init", players);

  socket.on("join-game", (data) => {
    if (!players[socket.id]) return;

    players[socket.id].name = data.name || "Duck";
    players[socket.id].x = data.x ?? 100;
    players[socket.id].y = data.y ?? 200;

    io.emit("state", safePlayer(players[socket.id]));
  });

  socket.on("update", (data) => {
    const p = players[socket.id];
    if (!p) return;

    p.x = data.x;
    p.y = data.y;
    p.score = data.score;
    p.isDead = data.isDead;

    io.emit("state", safePlayer(p));
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("remove", socket.id);
  });
});

server.listen(8080, () => console.log("server running"));
