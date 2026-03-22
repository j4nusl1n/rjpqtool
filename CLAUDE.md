# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A real-time multi-player interactive grid room tool (多人互動方塊房間工具). Up to 4 players can join a shared room and mark cells on a 5×10 grid board in real-time.

## Tech Stack

- **Backend:** Node.js + Express.js (static files + HTTP API) + `ws` (WebSocket server) + `sql.js` (synchronous SQLite in pure JS)
- **Frontend:** Vanilla HTML/CSS/JavaScript (no frameworks), native WebSocket API
- **Database:** SQLite via `sql.js` (synchronous after async init, no native compilation needed)
- **Node version:** Tested on Node 12+ (no `node:` import prefix, no `||=` syntax)

## Commands

```bash
npm install      # Install dependencies (express, ws, sql.js)
npm start        # Start server (default port 3001, override with PORT env)
```

## Architecture

### Backend Design

**`db.js`** — All database interactions. `sql.js` is synchronous after init + Node.js is single-threaded, so BEGIN/COMMIT transactions provide the same atomicity guarantees as `better-sqlite3`:
- `initDb()` — async init (loads WASM), must be called before any other function
- `createRoom(roomId)` — creates room + inserts 40 board cells (10 rows × 4 cols)
- `joinRoom(roomId, playerId, sessionToken)` — atomic count-then-insert (prevents >4 players)
- `selectColor(roomId, playerId, color)` — atomic check-then-update (prevents duplicate colors, supports color switching)
- `clickCell(roomId, row, col, playerId, color)` — reads cell first: empty→fill, own color→clear, other's→ignore. Enforces one-color-per-row constraint. Auto-fills the 4th cell when 3 of 4 cells in a row have different colors
- `clearMyCells(roomId, playerId, color)` — clears cells by color (not player_id), so orphaned cells from expired sessions can still be cleared
- `cleanupStaleRooms(minutes)` — batched cleanup of inactive rooms
- DB uses dirty-flag + 10-second interval saves (not per-operation) to avoid blocking the event loop

**`server.js`** — Express routes + WebSocket server. Manages per-room player sets in memory (for broadcasting), delegates all persistence to `db.js`.

### Database Schema

```sql
rooms       (room_id TEXT PK, created_at DATETIME, last_activity DATETIME)
players     (player_id TEXT PK, room_id TEXT FK, color TEXT, session_token TEXT, joined_at DATETIME)  -- idx on room_id, session_token
board_state (room_id TEXT FK, row INTEGER, col INTEGER, color TEXT, player_id TEXT FK, PK(room_id,row,col))
```

Board rows (40 cells: 10 rows × 4 clickable cols) are pre-inserted when a room is created.

### WebSocket Protocol

Client → Server: `join_room` (with optional `session_token` for reconnect), `select_color`, `click_cell`, `clear_my_cells`

Server → Client: `room_state` (full state + `player_id` + `session_token`), `color_update`, `cell_update`, `board_clear_update`, `player_joined`, `player_left`, `error` (generic: `color_taken`, `room_full`, `color_in_row`, etc.)

### Key Design Decisions

- **No optimistic updates:** All clients (including the sender) wait for server broadcast before updating the UI. Server state is authoritative.
- **Synchronous SQLite:** `sql.js` is synchronous after init. Combined with Node.js single-threading, BEGIN/COMMIT transactions eliminate race condition windows.
- **Grid layout:** Column 1 is a non-clickable label column showing row numbers 10→1; columns 2–5 are clickable. Header row labels columns 1–4.
- **One color per row:** Each color can only appear once per row. If 3 of 4 cells in a row are filled, the 4th is auto-filled with the remaining color.
- **Color-based ownership:** Cell clearing (click-to-toggle and clear button) matches by color, not `player_id`. This allows players to clear orphaned cells from expired sessions when they reselect the same color.
- **Identity binding:** `player_id` is server-generated and bound to the WebSocket connection object (`ws.playerId`). Client-supplied IDs in messages are ignored.
- **Disconnect grace period:** 30-second grace period before releasing color and broadcasting `player_left`. Reconnect with `session_token` to resume. Board marks are always preserved.
- **Room links:** Format is `/room.html?id=123456` (6-digit numeric code).
- **Sequence display:** Shows the current player's selected column per row as a string (e.g., `142?4 ?3???`), with `?` for unselected rows and a space separator after row 5.
