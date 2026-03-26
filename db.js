const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'rjpqtool.db');

let db;

// sql.js requires async init, but after that all operations are synchronous
async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_id       TEXT PRIMARY KEY,
      created_at    DATETIME DEFAULT (datetime('now')),
      last_activity DATETIME DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      player_id     TEXT PRIMARY KEY,
      room_id       TEXT REFERENCES rooms(room_id),
      color         TEXT,
      session_token TEXT,
      joined_at     DATETIME DEFAULT (datetime('now'))
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_token)');
  db.run('CREATE INDEX IF NOT EXISTS idx_rooms_activity ON rooms(last_activity)');

  db.run(`
    CREATE TABLE IF NOT EXISTS board_state (
      room_id   TEXT REFERENCES rooms(room_id),
      row       INTEGER,
      col       INTEGER,
      color     TEXT,
      player_id TEXT REFERENCES players(player_id),
      PRIMARY KEY (room_id, row, col)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS wrong_markers (
      room_id      TEXT,
      row          INTEGER,
      col          INTEGER,
      marker_color TEXT,
      PRIMARY KEY (room_id, row, col, marker_color)
    )
  `);

  // Auto-save periodically (dirty flag avoids unnecessary writes)
  setInterval(saveIfDirty, 10_000);

  return db;
}

let dirty = false;

function markDirty() {
  dirty = true;
}

function saveIfDirty() {
  if (!dirty) return;
  save();
}

function save() {
  if (!db) return;
  dirty = false;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// --- Helper: query one row ---
function getOne(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

// --- Helper: query all rows ---
function getAll(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// --- Helper: run statement ---
function run(sql, params) {
  db.run(sql, params);
}

// --- "Transactions" ---
// sql.js is synchronous + Node is single-threaded, so wrapping in
// BEGIN/COMMIT gives us the same atomicity as better-sqlite3 transactions.

function createRoom(roomId) {
  db.run('BEGIN');
  try {
    run('INSERT INTO rooms (room_id) VALUES (?)', [roomId]);
    for (let row = 1; row <= 10; row++) {
      for (let col = 2; col <= 5; col++) {
        run('INSERT INTO board_state (room_id, row, col) VALUES (?, ?, ?)', [roomId, row, col]);
      }
    }
    db.run('COMMIT');
    save(); // room creation is infrequent, save immediately
    return { success: true, room_id: roomId };
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function joinRoom(roomId, playerId, sessionToken) {
  db.run('BEGIN');
  try {
    const room = getOne('SELECT * FROM rooms WHERE room_id = ?', [roomId]);
    if (!room) {
      db.run('ROLLBACK');
      return { success: false, reason: 'room_not_found' };
    }

    const countRow = getOne('SELECT COUNT(*) as count FROM players WHERE room_id = ?', [roomId]);
    if (countRow.count >= 4) {
      db.run('ROLLBACK');
      return { success: false, reason: 'room_full' };
    }

    run('INSERT INTO players (player_id, room_id, session_token) VALUES (?, ?, ?)', [playerId, roomId, sessionToken]);
    run("UPDATE rooms SET last_activity = datetime('now') WHERE room_id = ?", [roomId]);
    db.run('COMMIT');
    markDirty();
    return { success: true };
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function rejoinRoom(sessionToken, roomId) {
  const player = getOne('SELECT * FROM players WHERE session_token = ? AND room_id = ?', [sessionToken, roomId]);
  if (!player) return { success: false };
  run("UPDATE rooms SET last_activity = datetime('now') WHERE room_id = ?", [roomId]);
  markDirty();
  return { success: true, player };
}

function selectColor(roomId, playerId, color) {
  db.run('BEGIN');
  try {
    const taken = getOne('SELECT 1 as x FROM players WHERE room_id = ? AND color = ? AND player_id != ?', [roomId, color, playerId]);
    if (taken) {
      db.run('ROLLBACK');
      return { success: false };
    }

    run('UPDATE players SET color = ? WHERE room_id = ? AND player_id = ?', [color, roomId, playerId]);
    run("UPDATE rooms SET last_activity = datetime('now') WHERE room_id = ?", [roomId]);
    db.run('COMMIT');
    markDirty();
    return { success: true };
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function deselectColor(roomId, playerId) {
  run('UPDATE players SET color = NULL WHERE room_id = ? AND player_id = ?', [roomId, playerId]);
  run("UPDATE rooms SET last_activity = datetime('now') WHERE room_id = ?", [roomId]);
  markDirty();
}

function toggleWrongMarker(roomId, row, col, markerColor) {
  db.run('BEGIN');
  try {
    var cell = getOne('SELECT color FROM board_state WHERE room_id = ? AND row = ? AND col = ?', [roomId, row, col]);
    if (!cell || cell.color) {
      // Can only mark empty cells
      db.run('ROLLBACK');
      return null;
    }
    var existing = getOne('SELECT 1 as x FROM wrong_markers WHERE room_id = ? AND row = ? AND col = ? AND marker_color = ?', [roomId, row, col, markerColor]);
    if (existing) {
      run('DELETE FROM wrong_markers WHERE room_id = ? AND row = ? AND col = ? AND marker_color = ?', [roomId, row, col, markerColor]);
      run("UPDATE rooms SET last_activity = datetime('now') WHERE room_id = ?", [roomId]);
      db.run('COMMIT');
      markDirty();
      return { row: row, col: col, marker_color: markerColor, wrong: 0 };
    } else {
      run('INSERT INTO wrong_markers (room_id, row, col, marker_color) VALUES (?, ?, ?, ?)', [roomId, row, col, markerColor]);
      run("UPDATE rooms SET last_activity = datetime('now') WHERE room_id = ?", [roomId]);
      db.run('COMMIT');
      markDirty();
      return { row: row, col: col, marker_color: markerColor, wrong: 1 };
    }
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function getWrongMarkers(roomId) {
  return getAll('SELECT row, col, marker_color FROM wrong_markers WHERE room_id = ?', [roomId]);
}

function clickCell(roomId, row, col, playerId, color) {
  db.run('BEGIN');
  try {
    const cell = getOne('SELECT color, player_id FROM board_state WHERE room_id = ? AND row = ? AND col = ?', [roomId, row, col]);
    if (!cell) {
      db.run('ROLLBACK');
      return null;
    }

    run("UPDATE rooms SET last_activity = datetime('now') WHERE room_id = ?", [roomId]);

    if (cell.color === null) {
      // Check: same color already exists in this row
      var dup = getOne('SELECT 1 as x FROM board_state WHERE room_id = ? AND row = ? AND color = ?', [roomId, row, color]);
      if (dup) {
        db.run('ROLLBACK');
        return { error: 'color_in_row' };
      }
      // Clear wrong markers on this cell (it's being filled)
      run('DELETE FROM wrong_markers WHERE room_id = ? AND row = ? AND col = ?', [roomId, row, col]);
      run('UPDATE board_state SET color = ?, player_id = ? WHERE room_id = ? AND row = ? AND col = ?', [color, playerId, roomId, row, col]);

      // Auto-fill: if 3 of 4 cells in this row now have colors, fill the last one
      var autoFill = null;
      var rowCells = getAll('SELECT col, color FROM board_state WHERE room_id = ? AND row = ?', [roomId, row]);
      var filled = [];
      var emptyCol = null;
      for (var i = 0; i < rowCells.length; i++) {
        if (rowCells[i].color) {
          filled.push(rowCells[i].color);
        } else {
          emptyCol = rowCells[i].col;
        }
      }
      if (filled.length === 3 && emptyCol !== null) {
        var allColors = ['red', 'blue', 'green', 'yellow'];
        var missingColor = null;
        for (var j = 0; j < allColors.length; j++) {
          if (filled.indexOf(allColors[j]) === -1) {
            missingColor = allColors[j];
            break;
          }
        }
        if (missingColor) {
          // Find the player who owns this color (if any)
          var owner = getOne('SELECT player_id FROM players WHERE room_id = ? AND color = ?', [roomId, missingColor]);
          var ownerId = owner ? owner.player_id : null;
          run('DELETE FROM wrong_markers WHERE room_id = ? AND row = ? AND col = ?', [roomId, row, emptyCol]);
          run('UPDATE board_state SET color = ?, player_id = ? WHERE room_id = ? AND row = ? AND col = ?', [missingColor, ownerId, roomId, row, emptyCol]);
          autoFill = { row: row, col: emptyCol, color: missingColor, player_id: ownerId };
        }
      }

      db.run('COMMIT');
      markDirty();
      return { row, col, color, player_id: playerId, auto_fill: autoFill };
    } else if (cell.color === color) {
      // Same color (own or orphaned from previous session): clear it
      run('UPDATE board_state SET color = NULL, player_id = NULL WHERE room_id = ? AND row = ? AND col = ?', [roomId, row, col]);
      db.run('COMMIT');
      markDirty();
      return { row, col, color: null, player_id: null };
    } else {
      // Different color: do nothing
      db.run('ROLLBACK');
      return null;
    }
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function clearMyCells(roomId, playerId, color) {
  db.run('BEGIN');
  try {
    const cells = getAll('SELECT row, col FROM board_state WHERE room_id = ? AND color = ?', [roomId, color]);
    run('UPDATE board_state SET color = NULL, player_id = NULL WHERE room_id = ? AND color = ?', [roomId, color]);
    run("UPDATE rooms SET last_activity = datetime('now') WHERE room_id = ?", [roomId]);
    db.run('COMMIT');
    markDirty();
    return cells;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function resetBoard(roomId) {
  db.run('BEGIN');
  try {
    run('UPDATE board_state SET color = NULL, player_id = NULL WHERE room_id = ?', [roomId]);
    run('DELETE FROM wrong_markers WHERE room_id = ?', [roomId]);
    run("UPDATE rooms SET last_activity = datetime('now') WHERE room_id = ?", [roomId]);
    db.run('COMMIT');
    markDirty();
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function cleanupStaleRooms(minutes) {
  db.run('BEGIN');
  try {
    const stale = getAll("SELECT room_id FROM rooms WHERE last_activity < datetime('now', ? || ' minutes') LIMIT 10", ['-' + minutes]);
    for (const { room_id } of stale) {
      run('DELETE FROM wrong_markers WHERE room_id = ?', [room_id]);
      run('DELETE FROM board_state WHERE room_id = ?', [room_id]);
      run('DELETE FROM players WHERE room_id = ?', [room_id]);
      run('DELETE FROM rooms WHERE room_id = ?', [room_id]);
    }
    db.run('COMMIT');
    if (stale.length > 0) markDirty();
    return stale.length;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function getRoomState(roomId) {
  const board = getAll('SELECT row, col, color, player_id FROM board_state WHERE room_id = ?', [roomId]);
  const players = getAll('SELECT player_id, color FROM players WHERE room_id = ?', [roomId]);
  return { board, players };
}

function roomExists(roomId) {
  return !!getOne('SELECT 1 as x FROM rooms WHERE room_id = ?', [roomId]);
}

function getPlayer(playerId) {
  return getOne('SELECT * FROM players WHERE player_id = ?', [playerId]);
}

function removePlayer(playerId) {
  run('UPDATE players SET color = NULL WHERE player_id = ?', [playerId]);
  run('DELETE FROM players WHERE player_id = ?', [playerId]);
  markDirty();
}

function kickPlayer(roomId, playerId) {
  db.run('BEGIN');
  try {
    var player = getOne('SELECT color FROM players WHERE player_id = ? AND room_id = ?', [playerId, roomId]);
    if (!player) {
      db.run('ROLLBACK');
      return { success: false, reason: 'player_not_found' };
    }
    var clearedCells = [];
    if (player.color) {
      clearedCells = getAll('SELECT row, col FROM board_state WHERE room_id = ? AND color = ?', [roomId, player.color]);
      run('UPDATE board_state SET color = NULL, player_id = NULL WHERE room_id = ? AND color = ?', [roomId, player.color]);
      run('DELETE FROM wrong_markers WHERE room_id = ? AND marker_color = ?', [roomId, player.color]);
    }
    run('DELETE FROM players WHERE player_id = ?', [playerId]);
    run("UPDATE rooms SET last_activity = datetime('now') WHERE room_id = ?", [roomId]);
    db.run('COMMIT');
    markDirty();
    return { success: true, color: player.color, cleared_cells: clearedCells };
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

function generateRoomId() {
  for (let i = 0; i < 100; i++) {
    const id = String(Math.floor(100000 + Math.random() * 900000));
    if (!getOne('SELECT 1 as x FROM rooms WHERE room_id = ?', [id])) return id;
  }
  throw new Error('Failed to generate unique room ID');
}

module.exports = {
  initDb,
  createRoom,
  joinRoom,
  rejoinRoom,
  selectColor,
  deselectColor,
  clickCell,
  clearMyCells,
  resetBoard,
  toggleWrongMarker,
  getWrongMarkers,
  cleanupStaleRooms,
  getRoomState,
  roomExists,
  getPlayer,
  removePlayer,
  kickPlayer,
  generateRoomId,
  close: () => { save(); db.close(); },
};
