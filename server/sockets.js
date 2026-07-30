const { createRoom, getRoom } = require('./rooms');

function broadcastRoom(io, code) {
  const table = getRoom(code);
  if (!table) return;
  const room = io.sockets.adapter.rooms.get(code);
  if (!room) return;
  for (const socketId of room) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    socket.emit('room_state', table.toJSON(socket.data.playerId || null));
  }
}

function attachSockets(io) {
  const onUpdate = (code) => broadcastRoom(io, code);

  io.on('connection', (socket) => {
    socket.data = { roomCode: null, playerId: null, isAdmin: false };

    const requireTable = () => {
      const table = getRoom(socket.data.roomCode);
      if (!table) throw new Error('Room not found');
      return table;
    };

    socket.on('create_room', (opts = {}, ack) => {
      try {
        const table = createRoom(
          {
            smallBlind: Number(opts.smallBlind) || 5,
            bigBlind: Number(opts.bigBlind) || 10,
            timerSeconds: Number(opts.timerSeconds) || 30,
            defaultBuyIn: Number(opts.defaultBuyIn) || 1000,
          },
          onUpdate
        );
        socket.join(table.code);
        socket.data.roomCode = table.code;
        socket.data.isAdmin = true;
        ack && ack({ ok: true, code: table.code, adminToken: table.adminToken, table: table.toJSON(null) });
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
      }
    });

    socket.on('admin_auth', (data = {}, ack) => {
      try {
        const table = getRoom(data.code);
        if (!table) throw new Error('Room not found');
        if (table.adminToken !== data.adminToken) throw new Error('Invalid admin token');
        socket.join(table.code);
        socket.data.roomCode = table.code;
        socket.data.isAdmin = true;
        ack && ack({ ok: true, table: table.toJSON(null) });
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
      }
    });

    socket.on('join_room', (data = {}, ack) => {
      try {
        const table = getRoom(data.code);
        if (!table) throw new Error('Room not found');

        let player = data.playerId ? table.getPlayer(data.playerId) : null;
        if (player) {
          player.connected = true;
          if (data.name) player.name = data.name;
        } else {
          player = table.addPlayer((data.name || 'Player').slice(0, 24));
        }

        socket.join(table.code);
        socket.data.roomCode = table.code;
        socket.data.playerId = player.id;
        table.touch();

        ack && ack({ ok: true, playerId: player.id, table: table.toJSON(player.id) });
        broadcastRoom(io, table.code);
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
      }
    });

    socket.on('take_seat', (data = {}, ack) => {
      try {
        const table = requireTable();
        if (!socket.data.playerId) throw new Error('Join first');
        table.takeSeat(socket.data.playerId, Number(data.seatIndex));
        ack && ack({ ok: true });
        broadcastRoom(io, table.code);
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
        socket.emit('error_message', e.message);
      }
    });

    socket.on('player:action', (data = {}, ack) => {
      try {
        const table = requireTable();
        if (!socket.data.playerId) throw new Error('Join first');
        table.handleAction(socket.data.playerId, data.type, data.amount);
        ack && ack({ ok: true });
        broadcastRoom(io, table.code);
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
        socket.emit('error_message', e.message);
      }
    });

    const adminAction = (event, fn) => {
      socket.on(event, (data = {}, ack) => {
        try {
          if (!socket.data.isAdmin) throw new Error('Not authorized');
          const table = requireTable();
          fn(table, data);
          ack && ack({ ok: true });
          broadcastRoom(io, table.code);
        } catch (e) {
          ack && ack({ ok: false, error: e.message });
          socket.emit('error_message', e.message);
        }
      });
    };

    adminAction('admin:start_hand', (table) => table.startHand());
    adminAction('admin:reveal_next', (table) => table.revealNext());
    adminAction('admin:start_showdown', (table) => table.startShowdown());
    adminAction('admin:award_pot', (table, data) =>
      table.awardPot(Number(data.potIndex), (data.winnerSeats || []).map(Number))
    );
    adminAction('admin:set_blinds', (table, data) => table.setBlinds(Number(data.sb), Number(data.bb)));
    adminAction('admin:set_level_minutes', (table, data) => table.setLevelMinutes(Number(data.minutes)));
    adminAction('admin:set_timer_seconds', (table, data) => table.setTimerSeconds(Number(data.seconds)));
    adminAction('admin:set_default_buyin', (table, data) => table.setDefaultBuyIn(Number(data.amount)));
    adminAction('admin:adjust_chips', (table, data) => table.adjustChips(data.playerId, Number(data.delta)));
    adminAction('admin:seat_player', (table, data) =>
      table.adminSeatPlayer(data.playerId, Number(data.seatIndex), Number(data.chips))
    );
    adminAction('admin:kick', (table, data) => table.kickPlayer(data.playerId));
    adminAction('admin:set_sitting_out', (table, data) => table.setSittingOut(data.playerId, !!data.sittingOut));

    socket.on('disconnect', () => {
      if (socket.data.playerId && socket.data.roomCode) {
        const table = getRoom(socket.data.roomCode);
        if (table) {
          const player = table.getPlayer(socket.data.playerId);
          if (player) {
            player.connected = false;
            broadcastRoom(io, table.code);
          }
        }
      }
    });
  });
}

module.exports = { attachSockets };
