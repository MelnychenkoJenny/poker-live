const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { attachSockets } = require('./sockets');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

attachSockets(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Poker Live running on port ${PORT}`);
});
