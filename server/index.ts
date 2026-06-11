import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server, Socket } from "socket.io";
import {
  canStartCombat,
  ClientRoomState,
  CombatCommand,
  createRoom,
  PlayerId,
  PLAYER_IDS,
  resolveTurn,
  RoomState,
  serializeRoom,
  startCombat
} from "../shared/game";

interface ClientAck {
  ok: boolean;
  error?: string;
  roomCode?: string;
}

interface CreateRoomPayload {
  playerName?: string;
}

interface JoinRoomPayload {
  roomCode?: string;
  playerName?: string;
}

interface RoomPayload {
  roomCode?: string;
}

interface SubmitCommandPayload extends RoomPayload {
  command?: CombatCommand;
}

interface SocketData {
  roomCode?: string;
  playerId?: PlayerId;
  playerName?: string;
}

interface ClientToServerEvents {
  createRoom: (payload: CreateRoomPayload, ack?: (response: ClientAck) => void) => void;
  joinRoom: (payload: JoinRoomPayload, ack?: (response: ClientAck) => void) => void;
  startGame: (payload: RoomPayload, ack?: (response: ClientAck) => void) => void;
  submitCommand: (payload: SubmitCommandPayload, ack?: (response: ClientAck) => void) => void;
  leaveRoom: (payload: RoomPayload, ack?: (response: ClientAck) => void) => void;
}

interface ServerToClientEvents {
  roomState: (state: ClientRoomState) => void;
}

interface InterServerEvents {}

type StarfallSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, "../client");
const port = Number(process.env.PORT ?? 3001);

const rooms = new Map<string, RoomState>();

const app = express();
const httpServer = createServer(app);
const devOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];
const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
  httpServer,
  {
    cors: {
      origin: process.env.NODE_ENV === "production" ? false : devOrigins
    }
  }
);

app.get("/health", (_request, response) => {
  response.json({ ok: true, rooms: rooms.size });
});

app.use(express.static(clientDistPath));
app.use((request, response, next) => {
  if (request.method !== "GET" || request.path.startsWith("/socket.io")) {
    next();
    return;
  }

  response.sendFile(path.join(clientDistPath, "index.html"));
});

io.on("connection", (socket) => {
  socket.on("createRoom", async (payload: CreateRoomPayload, ack?: (response: ClientAck) => void) => {
    const roomCode = createRoomCode();
    const playerName = normalizePlayerName(payload.playerName);
    const room = createRoom(roomCode);

    room.players.captainA = {
      id: "captainA",
      name: playerName,
      connected: true
    };
    room.log.push(`${playerName} took command of Captain A.`);
    rooms.set(roomCode, room);

    await joinSocketToRoom(socket, roomCode, "captainA", playerName);
    ack?.({ ok: true, roomCode });
    await emitRoom(roomCode);
  });

  socket.on("joinRoom", async (payload: JoinRoomPayload, ack?: (response: ClientAck) => void) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = roomCode ? rooms.get(roomCode) : undefined;

    if (!room || !roomCode) {
      ack?.({ ok: false, error: "Room not found." });
      return;
    }

    const playerName = normalizePlayerName(payload.playerName);
    const playerId = findJoinableSeat(room, playerName);

    if (!playerId) {
      ack?.({ ok: false, error: "Room is full or already in progress." });
      return;
    }

    room.players[playerId] = {
      id: playerId,
      name: playerName,
      connected: true
    };
    room.log.push(`${playerName} joined as ${playerId === "captainA" ? "Captain A" : "Captain B"}.`);

    await joinSocketToRoom(socket, roomCode, playerId, playerName);
    ack?.({ ok: true, roomCode });
    await emitRoom(roomCode);
  });

  socket.on("startGame", async (payload: RoomPayload, ack?: (response: ClientAck) => void) => {
    const room = getSocketRoom(socket, payload.roomCode);

    if (!room) {
      ack?.({ ok: false, error: "Join a room before starting." });
      return;
    }

    if (!canStartCombat(room)) {
      ack?.({ ok: false, error: "Two connected captains are required." });
      return;
    }

    rooms.set(room.code, startCombat(room));
    ack?.({ ok: true, roomCode: room.code });
    await emitRoom(room.code);
  });

  socket.on("submitCommand", async (payload: SubmitCommandPayload, ack?: (response: ClientAck) => void) => {
    const room = getSocketRoom(socket, payload.roomCode);
    const playerId = socket.data.playerId;

    if (!room || !playerId) {
      ack?.({ ok: false, error: "Join a room before issuing commands." });
      return;
    }

    if (room.phase !== "combat") {
      ack?.({ ok: false, error: "Combat has not started." });
      return;
    }

    room.pendingCommands[playerId] = payload.command;
    room.log = [
      ...room.log,
      `${room.players[playerId]?.name ?? "A captain"} locked in orders for turn ${room.turn}.`
    ].slice(-30);

    if (PLAYER_IDS.every((id) => room.pendingCommands[id])) {
      rooms.set(room.code, resolveTurn(room));
    }

    ack?.({ ok: true, roomCode: room.code });
    await emitRoom(room.code);
  });

  socket.on("leaveRoom", async (_payload: RoomPayload, ack?: (response: ClientAck) => void) => {
    const roomCode = socket.data.roomCode;
    await leaveCurrentRoom(socket);
    ack?.({ ok: true, roomCode });

    if (roomCode) {
      await emitRoom(roomCode);
    }
  });

  socket.on("disconnect", async () => {
    const roomCode = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = roomCode ? rooms.get(roomCode) : undefined;

    if (roomCode && room && playerId && room.players[playerId]) {
      room.players[playerId] = {
        ...room.players[playerId],
        connected: false
      };
      room.log = [
        ...room.log,
        `${room.players[playerId]?.name ?? "A captain"} disconnected. They can rejoin with the room code.`
      ].slice(-30);
      await emitRoom(roomCode);
    }
  });
});

httpServer.listen(port, () => {
  console.log(`Starfall Commander prototype listening on ${port}`);
});

async function joinSocketToRoom(
  socket: StarfallSocket,
  roomCode: string,
  playerId: PlayerId,
  playerName: string
) {
  await leaveCurrentRoom(socket);
  socket.data.roomCode = roomCode;
  socket.data.playerId = playerId;
  socket.data.playerName = playerName;
  await socket.join(roomCode);
}

async function leaveCurrentRoom(socket: StarfallSocket) {
  const roomCode = socket.data.roomCode;
  const playerId = socket.data.playerId;
  const room = roomCode ? rooms.get(roomCode) : undefined;

  if (room && playerId && room.players[playerId]) {
    room.players[playerId] = {
      ...room.players[playerId],
      connected: false
    };
    room.log = [
      ...room.log,
      `${room.players[playerId]?.name ?? "A captain"} left the room.`
    ].slice(-30);
  }

  if (roomCode) {
    await socket.leave(roomCode);
  }

  socket.data.roomCode = undefined;
  socket.data.playerId = undefined;
  socket.data.playerName = undefined;
}

async function emitRoom(roomCode: string) {
  const room = rooms.get(roomCode);
  if (!room) {
    return;
  }

  const sockets = await io.in(roomCode).fetchSockets();
  for (const socket of sockets) {
    socket.emit("roomState", serializeRoom(room, socket.data.playerId));
  }
}

function getSocketRoom(
  socket: StarfallSocket,
  roomCode?: string
): RoomState | undefined {
  const normalizedRoomCode = normalizeRoomCode(roomCode) ?? socket.data.roomCode;
  if (!normalizedRoomCode || normalizedRoomCode !== socket.data.roomCode) {
    return undefined;
  }

  return rooms.get(normalizedRoomCode);
}

function findJoinableSeat(room: RoomState, playerName: string): PlayerId | undefined {
  const disconnectedMatch = PLAYER_IDS.find((playerId) => {
    const player = room.players[playerId];
    return player && !player.connected && player.name.toLowerCase() === playerName.toLowerCase();
  });

  if (disconnectedMatch) {
    return disconnectedMatch;
  }

  if (room.phase !== "lobby") {
    return undefined;
  }

  return PLAYER_IDS.find((playerId) => !room.players[playerId]);
}

function createRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));

  return code;
}

function normalizeRoomCode(roomCode?: string): string | undefined {
  const normalized = roomCode?.trim().toUpperCase();
  return normalized || undefined;
}

function normalizePlayerName(playerName?: string): string {
  const normalized = playerName?.trim();
  return normalized || `Captain ${Math.floor(Math.random() * 900 + 100)}`;
}
