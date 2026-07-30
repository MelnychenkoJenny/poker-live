const { Table, makeRoomCode } = require('./table');

const rooms = new Map(); // code -> Table

function createRoom(options, onUpdate) {
  let code;
  do {
    code = makeRoomCode();
  } while (rooms.has(code));
  const table = new Table(code, options, () => onUpdate(code));
  rooms.set(code, table);
  return table;
}

function getRoom(code) {
  return rooms.get((code || '').toUpperCase().trim()) || null;
}

// clean up rooms nobody has touched in a while (Render free instances can run for days)
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000; // 12h
  for (const [code, table] of rooms) {
    if (table.lastActivityAt < cutoff) rooms.delete(code);
  }
}, 60 * 60 * 1000).unref();

module.exports = { createRoom, getRoom, rooms };
