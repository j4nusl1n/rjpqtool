const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
function uuidv4() {
  return crypto.randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;
const DOMAIN = process.env.DOMAIN || 'localhost';
const GRACE_PERIOD_MS = 30_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const STALE_ROOM_MINUTES = 30;
const ADMIN_TOKEN = crypto.randomBytes(24).toString('hex');

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const a = Buffer.from(token);
    const b = Buffer.from(ADMIN_TOKEN);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// --- In-memory state ---

// roomId -> Set<ws>
const roomConnections = new Map();
// playerId -> { timeout, roomId }
const disconnectTimers = new Map();

// --- Static files ---

app.use(express.static(path.join(__dirname, 'public')));

// --- HTTP API ---

app.post('/api/rooms', (_req, res) => {
  const roomId = db.generateRoomId();
  db.createRoom(roomId);
  res.json({ room_id: roomId });
});

app.get('/api/rooms/:id', (req, res) => {
  const roomId = req.params.id;
  if (!db.roomExists(roomId)) {
    return res.status(404).json({ error: 'room_not_found' });
  }
  const state = db.getRoomState(roomId);
  const playerCount = state.players.length;
  res.json({ room_id: roomId, player_count: playerCount, full: playerCount >= 4 });
});

// --- WebSocket ---

function broadcast(roomId, message, excludeWs) {
  const conns = roomConnections.get(roomId);
  if (!conns) return;
  const data = JSON.stringify(message);
  for (const ws of conns) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function broadcastAll(roomId, message) {
  broadcast(roomId, message, null);
}

function sendTo(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function addToRoom(roomId, ws) {
  if (!roomConnections.has(roomId)) {
    roomConnections.set(roomId, new Set());
  }
  roomConnections.get(roomId).add(ws);
}

function removeFromRoom(roomId, ws) {
  const conns = roomConnections.get(roomId);
  if (conns) {
    conns.delete(ws);
    if (conns.size === 0) {
      roomConnections.delete(roomId);
    }
  }
}

function handleJoinRoom(ws, data) {
  const { room_id, session_token } = data;

  if (!room_id || !db.roomExists(room_id)) {
    return sendTo(ws, { type: 'error', code: 'room_not_found', message: '房間不存在' });
  }

  // Try reconnection with session token
  if (session_token) {
    const result = db.rejoinRoom(session_token, room_id);
    if (result.success) {
      const player = result.player;

      // Cancel disconnect timer if active
      const timer = disconnectTimers.get(player.player_id);
      if (timer) {
        clearTimeout(timer.timeout);
        disconnectTimers.delete(player.player_id);
      }

      ws.playerId = player.player_id;
      ws.roomId = room_id;
      ws.sessionToken = session_token;

      addToRoom(room_id, ws);

      ws.isAdmin = verifyAdminToken(data.admin_token);

      const state = db.getRoomState(room_id);
      return sendTo(ws, {
        type: 'room_state',
        ...state,
        wrong_markers: db.getWrongMarkers(room_id),
        player_id: player.player_id,
        session_token,
        is_admin: ws.isAdmin,
      });
    }
  }

  // New join
  const playerId = uuidv4();
  const newSessionToken = uuidv4();

  const result = db.joinRoom(room_id, playerId, newSessionToken);
  if (!result.success) {
    return sendTo(ws, { type: 'error', code: result.reason, message: result.reason === 'room_full' ? '房間已滿' : '無法加入房間' });
  }

  ws.playerId = playerId;
  ws.roomId = room_id;
  ws.sessionToken = newSessionToken;
  ws.isAdmin = verifyAdminToken(data.admin_token);

  addToRoom(room_id, ws);

  const state = db.getRoomState(room_id);
  sendTo(ws, {
    type: 'room_state',
    ...state,
    wrong_markers: db.getWrongMarkers(room_id),
    player_id: playerId,
    session_token: newSessionToken,
    is_admin: ws.isAdmin,
  });

  broadcast(room_id, { type: 'player_joined', player_id: playerId }, ws);
}

function handleSelectColor(ws, data) {
  if (!ws.playerId || !ws.roomId) return;

  const { color } = data;
  if (!['red', 'blue', 'green', 'yellow'].includes(color)) return;

  const result = db.selectColor(ws.roomId, ws.playerId, color);
  if (!result.success) {
    return sendTo(ws, { type: 'error', code: 'color_taken', message: '該顏色已被選擇' });
  }

  broadcastAll(ws.roomId, { type: 'color_update', player_id: ws.playerId, color });
}

function handleDeselectColor(ws) {
  if (!ws.playerId || !ws.roomId) return;

  const player = db.getPlayer(ws.playerId);
  if (!player || !player.color) return;

  db.deselectColor(ws.roomId, ws.playerId);
  broadcastAll(ws.roomId, { type: 'color_update', player_id: ws.playerId, color: null });
}

function handleClickCell(ws, data) {
  if (!ws.playerId || !ws.roomId) return;

  const player = db.getPlayer(ws.playerId);
  if (!player || !player.color) {
    return sendTo(ws, { type: 'error', code: 'not_colored', message: '請先選擇顏色' });
  }

  const { row, col } = data;
  if (typeof row !== 'number' || typeof col !== 'number') return;
  if (row < 1 || row > 10 || col < 2 || col > 5) return;

  const result = db.clickCell(ws.roomId, row, col, ws.playerId, player.color);
  if (result && result.error === 'color_in_row') {
    return sendTo(ws, { type: 'error', code: 'color_in_row', message: '同一列已有相同顏色' });
  }
  if (result) {
    const autoFill = result.auto_fill;
    delete result.auto_fill;
    if (autoFill) {
      broadcastAll(ws.roomId, { type: 'cells_update', cells: [result, autoFill] });
    } else {
      broadcastAll(ws.roomId, { type: 'cell_update', ...result });
    }
  }
}

function handleToggleWrong(ws, data) {
  if (!ws.playerId || !ws.roomId) return;

  var player = db.getPlayer(ws.playerId);
  if (!player || !player.color) {
    return sendTo(ws, { type: 'error', code: 'not_colored', message: '請先選擇顏色' });
  }

  var row = data.row;
  var col = data.col;
  if (typeof row !== 'number' || typeof col !== 'number') return;
  if (row < 1 || row > 10 || col < 2 || col > 5) return;

  var result = db.toggleWrongMarker(ws.roomId, row, col, player.color);
  if (result) {
    broadcastAll(ws.roomId, { type: 'wrong_update', row: result.row, col: result.col, marker_color: result.marker_color, wrong: result.wrong });
  }
}

function handleResetBoard(ws) {
  if (!ws.playerId || !ws.roomId) return;
  if (!ws.isAdmin) {
    return sendTo(ws, { type: 'error', code: 'not_admin', message: '你沒有管理員權限' });
  }

  db.resetBoard(ws.roomId);
  broadcastAll(ws.roomId, { type: 'board_reset', room_id: ws.roomId });
}

function handleClearMyCells(ws) {
  if (!ws.playerId || !ws.roomId) return;

  const player = db.getPlayer(ws.playerId);
  if (!player || !player.color) return;

  const clearedCells = db.clearMyCells(ws.roomId, ws.playerId, player.color);
  if (clearedCells.length > 0) {
    broadcastAll(ws.roomId, {
      type: 'board_clear_update',
      cleared_cells: clearedCells.map(c => [c.row, c.col]),
    });
  }
}

function handleKickPlayer(ws, data) {
  if (!ws.playerId || !ws.roomId) return;
  if (!ws.isAdmin) {
    return sendTo(ws, { type: 'error', code: 'not_admin', message: '你沒有管理員權限' });
  }

  var targetId = data.target_player_id;
  if (!targetId || targetId === ws.playerId) return;

  var result = db.kickPlayer(ws.roomId, targetId);
  if (!result.success) return;

  // Cancel any disconnect timer for the kicked player
  var timer = disconnectTimers.get(targetId);
  if (timer) {
    clearTimeout(timer.timeout);
    disconnectTimers.delete(targetId);
  }

  // Find and close the kicked player's WebSocket
  var conns = roomConnections.get(ws.roomId);
  if (conns) {
    for (var conn of conns) {
      if (conn.playerId === targetId) {
        sendTo(conn, { type: 'kicked', message: '你已被管理員踢出房間' });
        removeFromRoom(ws.roomId, conn);
        conn.playerId = null;
        conn.roomId = null;
        conn.sessionToken = null;
        conn.close();
        break;
      }
    }
  }

  // Broadcast player removal and cell clearing
  if (result.cleared_cells.length > 0) {
    broadcastAll(ws.roomId, {
      type: 'board_clear_update',
      cleared_cells: result.cleared_cells.map(function(c) { return [c.row, c.col]; }),
    });
  }
  broadcastAll(ws.roomId, { type: 'player_left', player_id: targetId });
}

function handleDisconnect(ws) {
  if (!ws.playerId || !ws.roomId) return;

  removeFromRoom(ws.roomId, ws);

  const roomId = ws.roomId;
  const playerId = ws.playerId;

  // Start grace period
  const timeout = setTimeout(() => {
    disconnectTimers.delete(playerId);
    db.removePlayer(playerId);
    broadcast(roomId, { type: 'player_left', player_id: playerId });
  }, GRACE_PERIOD_MS);

  disconnectTimers.set(playerId, { timeout, roomId });
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join_room':
        handleJoinRoom(ws, msg);
        break;
      case 'select_color':
        handleSelectColor(ws, msg);
        break;
      case 'deselect_color':
        handleDeselectColor(ws);
        break;
      case 'click_cell':
        handleClickCell(ws, msg);
        break;
      case 'clear_my_cells':
        handleClearMyCells(ws);
        break;
      case 'toggle_wrong':
        handleToggleWrong(ws, msg);
        break;
      case 'reset_board':
        handleResetBoard(ws);
        break;
      case 'kick_player':
        handleKickPlayer(ws, msg);
        break;
    }
  });

  ws.on('close', () => handleDisconnect(ws));
});

// --- Room cleanup ---

setInterval(() => {
  try {
    db.cleanupStaleRooms(STALE_ROOM_MINUTES);
  } catch (e) {
    console.error('Room cleanup error:', e.message);
  }
}, CLEANUP_INTERVAL_MS);

// --- Start (async due to sql.js init) ---

db.initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`rjpqtool v1.3.0 - Server running on http://${DOMAIN}:${PORT}`);
    console.log('Admin URL (one-time use, token will be stripped from browser URL):');
    console.log('  http://' + DOMAIN + ':' + PORT + '/?admin=' + ADMIN_TOKEN);
  });
}).catch(e => {
  console.error('Failed to initialize database:', e);
  process.exit(1);
});
