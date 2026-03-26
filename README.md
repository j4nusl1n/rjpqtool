# rjpqtool - 多人互動方塊房間工具

A real-time multiplayer grid room tool. Up to 4 players join a shared room, pick a color, and mark cells on a 10×4 board — all synced instantly via WebSocket.

## Features

- **Room system** — Create or join rooms with a 6-digit code, share the link
- **Color selection** — 4 colors (red/blue/green/yellow), mutually exclusive per room
- **10×4 grid board** — Click to fill with your color; click your own cell twice to clear it (first click highlights it, second click within 1 second confirms)
- **One color per row** — Each color can only appear once per row; the 4th cell auto-fills when 3 are placed
- **Wrong marker** — Right-click (desktop) or long-press (mobile) an empty cell to mark it with a colored ✕ indicating "not my color", helping other players eliminate possibilities; multiple players can mark the same cell; markers auto-clear when the cell is filled
- **Sequence display** — Shows your selected columns as a string (e.g., `142?4 ?3???`)
- **Clear button** — Remove all your color's cells at once
- **Picture-in-Picture** — Float the board in a PiP overlay while switching tabs (Chrome/Edge/Safari 13.1+)
- **Reconnection** — 30-second grace period preserves your color and state on disconnect
- **Persistence** — SQLite database survives server restarts
- **Tutorial modal** — Shown on first room entry with game instructions; dismissible with optional "don't show again" (saved to `localStorage`)
- **Mobile-friendly** — Responsive design with touch-friendly cell sizes

## Quick Start

```bash
npm install
npm start
```

Server runs on `http://localhost:3001` by default. Override with environment variables:

```bash
PORT=8080 DOMAIN=example.com npm start
```

| Variable | Default     | Description                                      |
|----------|-------------|--------------------------------------------------|
| `PORT`   | `3001`      | Port to listen on                                |
| `DOMAIN` | `localhost` | Hostname used in the admin URL printed at startup |

## How to Use

1. Open the app and click **建立房間** to create a room, or enter a 6-digit code to join
2. Share the room link with other players
3. Select a color
4. Click cells on the board to mark them with your color
5. To clear a cell, click it once (highlights) then click again within 1 second to confirm
6. Right-click (desktop) or long-press (mobile) an empty cell to mark it as "not my color" — all players will see the marker
7. Your sequence string updates live as you fill rows

## Tech Stack

- **Backend:** Node.js + Express + WebSocket (`ws`) + SQLite (`sql.js`)
- **Frontend:** Vanilla HTML/CSS/JS, no build step
- **Database:** `rjpqtool.db` (auto-created, auto-saved)

## Project Structure

```
server.js        # Express HTTP API + WebSocket server
db.js            # SQLite layer (all transactions)
public/
  index.html     # Entry screen (create/join room)
  room.html      # Room screen (board + controls)
  style.css      # Styles
  app.js         # Frontend WebSocket client
```
