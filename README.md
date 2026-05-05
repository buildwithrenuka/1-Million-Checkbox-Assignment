# One Million Checkboxes

A realtime demo: a shared board of 1,000,000 checkboxes backed by Redis and kept in sync over WebSocket.

## Summary

- Backend: Express + WebSocket server that stores checkbox state in Redis as a compact bitfield.
- Frontend: Single-file `index.html` that renders a virtual-scrolling grid and connects to the server over WebSocket.
- Auth: Minimal JWT-based auth with `POST /auth/register` and `POST /auth/login` (users stored in Redis hash).
- Realtime sync: Servers publish updates to a Redis channel; every server subscribes and fans updates to its connected clients.

## Features

- Compact server-side storage: Redis string used as a bitfield (`checkboxes` key).
- Efficient frontend: virtual scrolling, only visible cells rendered.
- Per-user rate limiting: simple Redis counter with 1 second TTL to avoid abuse.
- Stateless-ish servers: multiple instances can run and keep in sync via Redis pub/sub.

## Prerequisites

- Node.js (v16+ recommended)
- Redis server accessible (local or remote)

## Setup

1. Install dependencies

```bash
npm install
```

2. Environment variables (optional)

- `PORT` - HTTP port (default `3000`)
- `REDIS_URL` - Redis connection URL (e.g. `redis://localhost:6379`). If omitted, default client will connect to localhost.
- `JWT_SECRET` - Secret used to sign JWTs (default development secret present in code; change for production)
- `TOTAL_CHECKBOXES` - Number of checkboxes (default `1000000`)

3. Start the server

```bash
node index.js
```

Open `index.html` in a browser (or serve it from a static server) and use the UI to login/register and view the board. The UI expects the backend at `http://localhost:3000` by default.

## API

- `POST /auth/register` — body `{ email, password }` (creates account, stores bcrypt hash in Redis hash `users`).
- `POST /auth/login` — body `{ email, password }` (returns `{ token }` on success — a JWT).
- `GET /state` — returns an array of booleans (length = `TOTAL_CHECKBOXES`) representing the whole board state.

## WebSocket protocol

- Connect to `ws://<host>:<port>?token=<jwt>` (token from login).
- Messages FROM server to client:
  - `{ type: "UPDATE", index: <number>, value: <boolean> }` — a single checkbox changed.
  - `{ type: "USERS", count: <number> }` — connected user count.
  - `{ type: "RATE_LIMIT", message: "..." }` — rate limit warning.
- Messages FROM client to server:
  - `{ index: <integer> }` — request to toggle checkbox at `index`.

Notes:
- The server authenticates the token and rejects connections without a valid token.
- When a client toggles a checkbox, the server flips the bit in Redis and `PUBLISH`es an update on the `checkbox_updates` channel. Every server instance subscribed to that channel forwards the update to its connected clients.

## Data layout

- Redis key `checkboxes` — a string used as a compact bitfield: bit `i` represents checkbox `i`.
- Redis channel `checkbox_updates` — published messages are `{ index, value }` JSON objects.
- Redis hash `users` — stores `email => passwordHash` for simple auth.

## Important implementation notes

- toggle operation reads a single byte containing the target bit, XORs the bit, writes the new byte back with `SETRANGE`, and publishes the change. This is not a strict compare-and-set (CAS) but is acceptable for this demo — worst case is a short flicker under extreme races.
- Rate limiting is implemented using `INCR` + `EXPIRE` per-user key with a 1-second TTL and allows a configurable number of events per second (`MAX_EVENTS_PER_SECOND` in `index.js`).
- Frontend keeps a mirrored bit-array (`Uint8Array`) and updates only DOM cells that are visible. It loads the full boolean array from `GET /state` on startup.

## Development tips

- To change the number of checkboxes for testing, set `TOTAL_CHECKBOXES` env var before starting.
- Use a development Redis instance (e.g., via Docker: `docker run -p 6379:6379 redis`) if you don't have Redis installed locally.

## Security & production notes

- Replace the default `JWT_SECRET` with a secure, random secret in production.
- Consider using Lua scripts or Redis transactions if you need strict atomic toggles under heavy concurrent writes.
- Harden auth, password policies, and session handling for a production deployment.
- Add HTTPS and proper CORS configuration when serving the frontend from a different origin.

## Files of interest

- `index.js` — main server: Express routes, Redis clients, WebSocket handling, toggle logic.
- `routes/authRoutes.js` — registration and login endpoints.
- `index.html` — frontend single file with virtual scrolling and WebSocket client.

## License

MIT (or adjust as needed)
