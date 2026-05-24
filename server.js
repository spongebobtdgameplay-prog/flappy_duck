const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); 
const fs = require('fs'); // Added to check folder structures dynamically

const app = express();
const server = http.createServer(app);

// Allow any frontend website origin to securely connect via WebSockets
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// FIXED PATH LOGIC: Systematically checks the root directory, sub-directories, and sub-folders to find your index.html file
app.get('/', (req, res) => {
  let rootPath = path.join(__dirname, 'index.html');
  let publicPath = path.join(__dirname, 'public', 'index.html');
  let srcPath = path.join(__dirname, 'src', 'index.html');

  if (fs.existsSync(rootPath)) {
    res.sendFile(rootPath);
  } else if (fs.existsSync(publicPath)) {
    res.sendFile(publicPath);
  } else if (fs.existsSync(srcPath)) {
    res.sendFile(srcPath);
  } else {
    // Fallback: search the entire deployment container for any instance of index.html
    const findFile = (dir) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory() && !file.includes('node_modules')) {
          const found = findFile(fullPath);
          if (found) return found;
        } else if (file === 'index.html') {
          return fullPath;
        }
      }
      return null;
    };
    
    const dynamicPath = findFile(__dirname);
    if (dynamicPath) {
      res.sendFile(dynamicPath);
    } else {
      res.status(404).send("Error: index.html file could not be found anywhere inside your repository files.");
    }
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
    socket.emit('current-players', players);
    socket.broadcast.emit('player-joined', players[socket.id]);
  });

  // 2. Handle real-time position updates
  socket.on('update-position', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].score = data.score;
      players[socket.id].isDead = data.isDead;
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

// Binds to 0.0.0.0 and forces port resolution to match Railway's internal proxy settings
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
