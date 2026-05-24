const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow any frontend website origin to securely connect via WebSockets
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

let players = {};

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // 1. Handle new player joining
  socket.on('join-game', (data) => {
    players[socket.id] = {
      id: socket.id,
      x: data.x || 100,
      y: data.y || 200,
      name: data.name || 'Duck',
      score: 0,
      isDead: false
    };
    // Sync current player list to the new player
    socket.emit('current-players', players);
    // Tell everyone else a new player joined
    socket.broadcast.emit('player-joined', players[socket.id]);
  });

  // 2. Handle real-time position updates
  socket.on('update-position', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].score = data.score;
      players[socket.id].isDead = data.isDead;
      
      // Broadcast movement to all other connected clients
      socket.broadcast.emit('player-moved', players[socket.id]);
    }
  });

  // 3. Handle player disconnections clean-up
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete players[socket.id];
    io.emit('player-disconnected', socket.id);
  });
});

// Use environment port for production hosting, fallback to 3000 for local testing
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
