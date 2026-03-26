// --- State ---
let ws;
let myPlayerId = null;
let myColor = null;
let sessionToken = null;
let roomId = null;
let reconnectAttempt = 0;
let isAdmin = false;
let adminToken = sessionStorage.getItem('admin_token');

// --- Helpers ---
function sessionKey() { return 'session_' + roomId; }

// --- DOM ---
const roomIdDisplay = document.getElementById('room-id-display');
const btnCopy = document.getElementById('btn-copy');
const playerList = document.getElementById('player-list');
const boardBody = document.getElementById('board-body');
const btnClear = document.getElementById('btn-clear');
const connStatus = document.getElementById('connection-status');
const errorBanner = document.getElementById('error-banner');
const colorBtns = document.querySelectorAll('.color-btn');
const mySequenceEl = document.getElementById('my-sequence');
const btnResetBoard = document.getElementById('btn-reset-board');
const btnPip = document.getElementById('btn-pip');
const pipCanvas = document.getElementById('pip-canvas');
const pipVideo = document.getElementById('pip-video');
let pipActive = false;
let pipStream = null;

// Track board cell ownership: boardCells[row] = { color, player_id } per col
// key: "row,col" -> { color, player_id }
let boardCells = {};

// Pending deselect state (double-click to deselect own cell)
let pendingDeselect = null;
let pendingDeselectTimer = null;

// Wrong markers: "row,col" -> Set of marker colors
let wrongMarkers = {};

// Long-press state for mobile wrong marker
let longPressTimer = null;
let longPressTarget = null;
let longPressFired = false;

// --- Init ---
(function init() {
  const params = new URLSearchParams(window.location.search);
  roomId = params.get('id');
  if (!roomId) {
    window.location.href = '/';
    return;
  }

  roomIdDisplay.textContent = roomId;
  document.title = '房間 ' + roomId;

  // Restore session token from sessionStorage
  sessionToken = sessionStorage.getItem(sessionKey());

  buildBoard();
  setupEventListeners();
  connect();
  showTutorialIfNeeded();
})();

function buildBoard() {
  boardBody.innerHTML = '';
  // Header row
  var headerTr = document.createElement('tr');
  var emptyTd = document.createElement('td');
  emptyTd.className = 'label-cell';
  headerTr.appendChild(emptyTd);
  for (var c = 1; c <= 4; c++) {
    var th = document.createElement('td');
    th.className = 'label-cell';
    th.textContent = c;
    headerTr.appendChild(th);
  }
  boardBody.appendChild(headerTr);
  // Data rows
  for (let row = 10; row >= 1; row--) {
    const tr = document.createElement('tr');
    const labelTd = document.createElement('td');
    labelTd.className = 'label-cell';
    labelTd.textContent = row;
    tr.appendChild(labelTd);
    for (let col = 2; col <= 5; col++) {
      const td = document.createElement('td');
      td.className = 'clickable';
      td.dataset.row = row;
      td.dataset.col = col;
      tr.appendChild(td);
    }
    boardBody.appendChild(tr);
  }
}

function setupEventListeners() {
  // Color selection
  colorBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (color === myColor) {
          ws.send(JSON.stringify({ type: 'deselect_color' }));
        } else {
          ws.send(JSON.stringify({ type: 'select_color', color }));
        }
      }
    });
  });

  // Board clicks
  boardBody.addEventListener('click', (e) => {
    const td = e.target.closest('td.clickable');
    if (!td) return;
    const row = parseInt(td.dataset.row);
    const col = parseInt(td.dataset.col);
    const cellKey = row + ',' + col;
    const cell = boardCells[cellKey];
    const isMyCell = myColor && cell && cell.color === myColor;

    if (isMyCell) {
      if (pendingDeselect && pendingDeselect.row === row && pendingDeselect.col === col) {
        // Second click on same cell — confirm deselect
        clearPendingDeselect();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'click_cell', row, col }));
        }
      } else {
        // First click on own cell — arm pending deselect
        clearPendingDeselect();
        pendingDeselect = { row, col };
        td.classList.add('pending-deselect');
        pendingDeselectTimer = setTimeout(clearPendingDeselect, 1000);
      }
    } else {
      // Empty or other player's cell — clear pending and send normally
      clearPendingDeselect();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'click_cell', row, col }));
      }
    }
  });

  // Wrong marker — desktop right-click
  boardBody.addEventListener('contextmenu', function(e) {
    var td = e.target.closest('td.clickable');
    if (!td) return;
    e.preventDefault();
    var row = parseInt(td.dataset.row);
    var col = parseInt(td.dataset.col);
    var cellKey = row + ',' + col;
    var cell = boardCells[cellKey];
    // Only mark empty cells, must have color selected
    if (!cell || !cell.color) {
      if (myColor && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'toggle_wrong', row: row, col: col }));
      }
    }
  });

  // Wrong marker — mobile long-press
  boardBody.addEventListener('touchstart', function(e) {
    var td = e.target.closest('td.clickable');
    if (!td) return;
    longPressFired = false;
    longPressTarget = { row: parseInt(td.dataset.row), col: parseInt(td.dataset.col) };
    longPressTimer = setTimeout(function() {
      if (!longPressTarget) return;
      var cellKey = longPressTarget.row + ',' + longPressTarget.col;
      var cell = boardCells[cellKey];
      if (!cell || !cell.color) {
        if (myColor && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'toggle_wrong', row: longPressTarget.row, col: longPressTarget.col }));
        }
      }
      longPressFired = true;
      longPressTarget = null;
    }, 500);
  }, { passive: true });

  boardBody.addEventListener('touchend', function(e) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressTarget = null;
    if (longPressFired) {
      e.preventDefault();
      longPressFired = false;
    }
  });

  boardBody.addEventListener('touchmove', function() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressTarget = null;
  });

  boardBody.addEventListener('touchcancel', function() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressTarget = null;
  });

  // Clear button
  btnClear.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'clear_my_cells' }));
    }
  });

  // Admin reset board
  btnResetBoard.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'reset_board' }));
    }
  });

  // Copy link
  btnCopy.addEventListener('click', () => {
    // Build a clean URL without admin token
    var copyParams = new URLSearchParams(window.location.search);
    copyParams.delete('admin');
    var url = window.location.origin + window.location.pathname + '?' + copyParams.toString();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() {
        btnCopy.textContent = '✓ 已複製';
        setTimeout(function() { btnCopy.textContent = '📋 複製連結'; }, 1500);
      });
    } else {
      // Fallback for non-secure contexts (HTTP)
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      btnCopy.textContent = '✓ 已複製';
      setTimeout(function() { btnCopy.textContent = '📋 複製連結'; }, 1500);
    }
  });
}

// --- WebSocket ---

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + window.location.host);

  ws.addEventListener('open', () => {
    connStatus.hidden = true;
    reconnectAttempt = 0;
    var joinMsg = {
      type: 'join_room',
      room_id: roomId,
      session_token: sessionToken,
    };
    if (adminToken) joinMsg.admin_token = adminToken;
    ws.send(JSON.stringify(joinMsg));
  });

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    connStatus.hidden = false;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 10000);
  reconnectAttempt++;
  setTimeout(connect, delay);
}

// --- Message handlers ---

function handleMessage(msg) {
  switch (msg.type) {
    case 'room_state':
      handleRoomState(msg);
      break;
    case 'color_update':
      handleColorUpdate(msg);
      break;
    case 'cell_update':
      handleCellUpdate(msg);
      break;
    case 'cells_update':
      handleCellsUpdate(msg);
      break;
    case 'board_clear_update':
      handleBoardClear(msg);
      break;
    case 'board_reset':
      handleBoardReset();
      break;
    case 'wrong_update':
      handleWrongUpdate(msg);
      break;
    case 'player_joined':
      handlePlayerJoined(msg);
      break;
    case 'player_left':
      handlePlayerLeft(msg);
      break;
    case 'kicked':
      handleKicked(msg);
      break;
    case 'error':
      handleError(msg);
      break;
  }
}

// Players tracked locally for rendering
let players = [];

function handleRoomState(msg) {
  myPlayerId = msg.player_id;
  sessionToken = msg.session_token;
  sessionStorage.setItem(sessionKey(), sessionToken);

  isAdmin = !!msg.is_admin;
  btnResetBoard.style.display = isAdmin ? '' : 'none';

  players = msg.players;

  // Find my color
  const me = players.find(p => p.player_id === myPlayerId);
  myColor = me ? me.color : null;

  renderPlayers();
  renderColorPicker();
  updateClearButton();

  // Render board
  boardCells = {};
  wrongMarkers = {};
  clearBoardColors();
  clearAllWrongMarkers();
  for (const cell of msg.board) {
    if (cell.color) {
      boardCells[cell.row + ',' + cell.col] = { color: cell.color };
      setCellColor(cell.row, cell.col, cell.color);
    }
  }
  // Render wrong markers from server state
  if (msg.wrong_markers) {
    for (var i = 0; i < msg.wrong_markers.length; i++) {
      var wm = msg.wrong_markers[i];
      var wmKey = wm.row + ',' + wm.col;
      if (!wrongMarkers[wmKey]) wrongMarkers[wmKey] = {};
      wrongMarkers[wmKey][wm.marker_color] = true;
    }
    for (var key in wrongMarkers) {
      var parts = key.split(',');
      renderWrongMarkers(parseInt(parts[0]), parseInt(parts[1]));
    }
  }
  renderMySequence();
  if (pipActive) drawBoardToCanvas();
}

function handleColorUpdate(msg) {
  const p = players.find(p => p.player_id === msg.player_id);
  if (p) {
    p.color = msg.color;
  } else {
    players.push({ player_id: msg.player_id, color: msg.color });
  }

  if (msg.player_id === myPlayerId) {
    myColor = msg.color;
    updateClearButton();
  }

  renderPlayers();
  renderColorPicker();
  renderMySequence();
}

function handleCellUpdate(msg) {
  if (pendingDeselect && pendingDeselect.row === msg.row && pendingDeselect.col === msg.col) {
    clearPendingDeselect();
  }
  setCellColor(msg.row, msg.col, msg.color);
  var cellKey = msg.row + ',' + msg.col;
  if (msg.color) {
    boardCells[cellKey] = { color: msg.color };
    // Cell got filled — clear wrong markers
    if (wrongMarkers[cellKey]) {
      delete wrongMarkers[cellKey];
      renderWrongMarkers(msg.row, msg.col);
    }
  } else {
    delete boardCells[cellKey];
  }
  renderMySequence();
  if (pipActive) drawBoardToCanvas();
}

function handleCellsUpdate(msg) {
  for (const cell of msg.cells) {
    if (pendingDeselect && pendingDeselect.row === cell.row && pendingDeselect.col === cell.col) {
      clearPendingDeselect();
    }
    setCellColor(cell.row, cell.col, cell.color);
    var cellKey = cell.row + ',' + cell.col;
    if (cell.color) {
      boardCells[cellKey] = { color: cell.color };
      if (wrongMarkers[cellKey]) {
        delete wrongMarkers[cellKey];
        renderWrongMarkers(cell.row, cell.col);
      }
    } else {
      delete boardCells[cellKey];
    }
  }
  renderMySequence();
  if (pipActive) drawBoardToCanvas();
}

function handleBoardClear(msg) {
  for (const [row, col] of msg.cleared_cells) {
    setCellColor(row, col, null);
    delete boardCells[row + ',' + col];
  }
  renderMySequence();
  if (pipActive) drawBoardToCanvas();
}

function handleBoardReset() {
  boardCells = {};
  wrongMarkers = {};
  clearBoardColors();
  clearAllWrongMarkers();
  renderMySequence();
  if (pipActive) drawBoardToCanvas();
}

function handlePlayerJoined(msg) {
  if (!players.find(p => p.player_id === msg.player_id)) {
    players.push({ player_id: msg.player_id, color: null });
  }
  renderPlayers();
}

function handlePlayerLeft(msg) {
  const idx = players.findIndex(p => p.player_id === msg.player_id);
  if (idx !== -1) players.splice(idx, 1);
  renderPlayers();
  renderColorPicker();
}

function handleKicked(msg) {
  // Clear session so reconnect won't rejoin
  sessionStorage.removeItem(sessionKey());
  sessionToken = null;
  // Close WebSocket to prevent auto-reconnect
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  showError(msg.message + '，即將返回首頁…', 2500);
}

let errorBannerTimer = null;

function showError(text, redirectAfterMs) {
  errorBanner.textContent = text;
  errorBanner.hidden = false;
  if (errorBannerTimer) clearTimeout(errorBannerTimer);
  if (redirectAfterMs) {
    errorBannerTimer = setTimeout(function() { window.location.href = '/'; }, redirectAfterMs);
  } else {
    errorBannerTimer = setTimeout(function() { errorBanner.hidden = true; }, 2500);
  }
}

function handleError(msg) {
  if (msg.code === 'room_full' || msg.code === 'room_not_found') {
    showError(msg.message + '，即將返回首頁…', 2500);
    return;
  }
  showError(msg.message);
  console.warn('Server error:', msg.code, msg.message);
}

// --- Rendering ---

function renderPlayers() {
  playerList.innerHTML = '';
  for (const p of players) {
    const tag = document.createElement('span');
    tag.className = 'player-tag' + (p.player_id === myPlayerId ? ' me' : '');

    const dot = document.createElement('span');
    dot.className = 'dot';
    if (p.color) dot.style.background = getColorHex(p.color);
    tag.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = p.player_id === myPlayerId ? '你' : '玩家';
    tag.appendChild(label);

    if (isAdmin && p.player_id !== myPlayerId) {
      var kickBtn = document.createElement('button');
      kickBtn.className = 'btn-kick';
      kickBtn.textContent = '✕';
      kickBtn.title = '踢出玩家';
      kickBtn.dataset.playerId = p.player_id;
      kickBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var targetId = this.dataset.playerId;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'kick_player', target_player_id: targetId }));
        }
      });
      tag.appendChild(kickBtn);
    }

    playerList.appendChild(tag);
  }
}

function renderColorPicker() {
  const takenColors = new Set(
    players.filter(p => p.color && p.player_id !== myPlayerId).map(p => p.color)
  );

  colorBtns.forEach(btn => {
    const color = btn.dataset.color;
    btn.disabled = takenColors.has(color);
    btn.classList.toggle('selected', color === myColor);
  });
}

function updateClearButton() {
  btnClear.disabled = !myColor;
  btnClear.className = 'btn btn-clear';
  if (myColor) {
    btnClear.classList.add('active-' + myColor);
  }
}

function renderMySequence() {
  if (!myColor) {
    mySequenceEl.textContent = '';
    return;
  }
  var chars = [];
  for (var row = 1; row <= 10; row++) {
    var found = false;
    for (var col = 2; col <= 5; col++) {
      var cell = boardCells[row + ',' + col];
      if (cell && cell.color === myColor) {
        chars.push(String(col - 1));
        found = true;
        break;
      }
    }
    if (!found) chars.push('?');
    if (row === 5) chars.push(' ');
  }
  mySequenceEl.textContent = chars.join('');
}

function setCellColor(row, col, color) {
  const td = boardBody.querySelector(`td[data-row="${row}"][data-col="${col}"]`);
  if (!td) return;
  td.style.backgroundColor = color ? getColorHex(color) : '';
}

function clearBoardColors() {
  boardBody.querySelectorAll('td.clickable').forEach(td => {
    td.style.backgroundColor = '';
  });
}

function getColorHex(color) {
  const map = { red: '#e74c3c', blue: '#3498db', green: '#2ecc71', yellow: '#f1c40f' };
  return map[color] || '#555';
}

// --- Pending deselect helpers ---

function clearPendingDeselect() {
  if (pendingDeselect) {
    const td = boardBody.querySelector('td[data-row="' + pendingDeselect.row + '"][data-col="' + pendingDeselect.col + '"]');
    if (td) td.classList.remove('pending-deselect');
    pendingDeselect = null;
  }
  if (pendingDeselectTimer) {
    clearTimeout(pendingDeselectTimer);
    pendingDeselectTimer = null;
  }
}

// --- Wrong markers ---

function handleWrongUpdate(msg) {
  var cellKey = msg.row + ',' + msg.col;
  if (msg.wrong) {
    if (!wrongMarkers[cellKey]) wrongMarkers[cellKey] = {};
    wrongMarkers[cellKey][msg.marker_color] = true;
  } else {
    if (wrongMarkers[cellKey]) {
      delete wrongMarkers[cellKey][msg.marker_color];
      if (Object.keys(wrongMarkers[cellKey]).length === 0) {
        delete wrongMarkers[cellKey];
      }
    }
  }
  renderWrongMarkers(msg.row, msg.col);
  if (pipActive) drawBoardToCanvas();
}

var markerPositions = ['pos-tl', 'pos-tr', 'pos-bl', 'pos-br'];
var markerColorOrder = ['red', 'blue', 'green', 'yellow'];

function renderWrongMarkers(row, col) {
  var td = boardBody.querySelector('td[data-row="' + row + '"][data-col="' + col + '"]');
  if (!td) return;
  // Remove existing markers
  var existing = td.querySelectorAll('.wrong-mark');
  for (var i = 0; i < existing.length; i++) {
    existing[i].remove();
  }
  var cellKey = row + ',' + col;
  var markers = wrongMarkers[cellKey];
  if (!markers) return;
  // Sort by color order for consistent positioning
  var colors = [];
  for (var j = 0; j < markerColorOrder.length; j++) {
    if (markers[markerColorOrder[j]]) colors.push(markerColorOrder[j]);
  }
  for (var k = 0; k < colors.length && k < 4; k++) {
    var span = document.createElement('span');
    span.className = 'wrong-mark ' + markerPositions[k];
    span.textContent = '✕';
    span.style.color = getColorHex(colors[k]);
    td.appendChild(span);
  }
}

function clearAllWrongMarkers() {
  var marks = boardBody.querySelectorAll('.wrong-mark');
  for (var i = 0; i < marks.length; i++) {
    marks[i].remove();
  }
}

// --- Tutorial ---

function showTutorialIfNeeded() {
  if (localStorage.getItem('skip_tutorial') === '1') return;
  document.getElementById('tutorial-modal').style.display = 'flex';
}

function closeTutorial() {
  document.getElementById('tutorial-modal').style.display = 'none';
  if (document.getElementById('tutorial-skip-cb').checked) {
    localStorage.setItem('skip_tutorial', '1');
  }
}

// --- Picture-in-Picture ---

function initPip() {
  if (!document.pictureInPictureEnabled) return;
  btnPip.style.display = '';

  btnPip.addEventListener('click', function() {
    if (pipActive) {
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture();
      }
      return;
    }
    drawBoardToCanvas();
    pipStream = pipCanvas.captureStream(0); // 0 fps = manual frame push
    pipVideo.srcObject = pipStream;
    pipVideo.play().then(function() {
      return pipVideo.requestPictureInPicture();
    }).then(function() {
      pipActive = true;
      btnPip.textContent = '關閉子母畫面';
    }).catch(function(err) {
      console.warn('PiP failed:', err);
    });
  });

  pipVideo.addEventListener('leavepictureinpicture', function() {
    pipActive = false;
    pipStream = null;
    btnPip.textContent = '子母畫面模式';
    pipVideo.srcObject = null;
  });
}

function drawBoardToCanvas() {
  var ctx = pipCanvas.getContext('2d');
  var W = pipCanvas.width;   // 320
  var H = pipCanvas.height;  // 480

  var cols = 5;   // 1 label + 4 data
  var rows = 11;  // 1 header + 10 data
  var cellW = Math.floor(W / cols);
  var cellH = Math.floor(H / rows);
  var gap = 2;

  // Background
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

  ctx.font = 'bold ' + Math.floor(cellH * 0.45) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Header row: empty + col numbers 1-4
  for (var c = 0; c < cols; c++) {
    var x = c * cellW;
    ctx.fillStyle = '#16213e';
    ctx.fillRect(x + gap, gap, cellW - gap * 2, cellH - gap * 2);
    if (c > 0) {
      ctx.fillStyle = '#888';
      ctx.fillText(String(c), x + cellW / 2, cellH / 2);
    }
  }

  // Data rows (row 10 at top, row 1 at bottom)
  for (var r = 0; r < 10; r++) {
    var rowNum = 10 - r;
    var y = (r + 1) * cellH;

    // Label column
    ctx.fillStyle = '#16213e';
    ctx.fillRect(gap, y + gap, cellW - gap * 2, cellH - gap * 2);
    ctx.fillStyle = '#888';
    ctx.fillText(String(rowNum), cellW / 2, y + cellH / 2);

    // Data columns
    for (var dc = 0; dc < 4; dc++) {
      var col = dc + 2; // col 2-5 in data model
      var cx = (dc + 1) * cellW;
      var cell = boardCells[rowNum + ',' + col];
      ctx.fillStyle = (cell && cell.color) ? getColorHex(cell.color) : '#16213e';
      ctx.fillRect(cx + gap, y + gap, cellW - gap * 2, cellH - gap * 2);

      // Draw wrong markers on empty cells
      var wmKey = rowNum + ',' + col;
      var wm = wrongMarkers[wmKey];
      if (wm && (!cell || !cell.color)) {
        var wmColors = [];
        for (var mi = 0; mi < markerColorOrder.length; mi++) {
          if (wm[markerColorOrder[mi]]) wmColors.push(markerColorOrder[mi]);
        }
        var wmSize = Math.floor(cellH * 0.25);
        ctx.font = 'bold ' + wmSize + 'px sans-serif';
        var wmPositions = [
          [cx + gap + wmSize / 2 + 1, y + gap + wmSize / 2 + 1],
          [cx + cellW - gap - wmSize / 2 - 1, y + gap + wmSize / 2 + 1],
          [cx + gap + wmSize / 2 + 1, y + cellH - gap - wmSize / 2 - 1],
          [cx + cellW - gap - wmSize / 2 - 1, y + cellH - gap - wmSize / 2 - 1]
        ];
        for (var wi = 0; wi < wmColors.length && wi < 4; wi++) {
          ctx.fillStyle = getColorHex(wmColors[wi]);
          ctx.fillText('✕', wmPositions[wi][0], wmPositions[wi][1]);
        }
        // Restore font for label rendering
        ctx.font = 'bold ' + Math.floor(cellH * 0.45) + 'px sans-serif';
      }
    }
  }

  // Request a new frame on the stream
  if (pipActive && pipStream) {
    try {
      var tracks = pipStream.getVideoTracks();
      if (tracks[0] && tracks[0].requestFrame) {
        tracks[0].requestFrame();
      }
    } catch (e) {}
  }
}

initPip();
