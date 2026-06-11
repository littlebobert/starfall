import express from "express";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server, Socket } from "socket.io";
import webpush from "web-push";
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

interface SavePushSubscriptionPayload extends RoomPayload {
  subscription?: webpush.PushSubscription;
}

interface SocketData {
  roomCode?: string;
  playerId?: PlayerId;
  spectatorId?: string;
  playerName?: string;
}

interface ClientToServerEvents {
  createRoom: (payload: CreateRoomPayload, ack?: (response: ClientAck) => void) => void;
  joinRoom: (payload: JoinRoomPayload, ack?: (response: ClientAck) => void) => void;
  startGame: (payload: RoomPayload, ack?: (response: ClientAck) => void) => void;
  submitCommand: (payload: SubmitCommandPayload, ack?: (response: ClientAck) => void) => void;
  savePushSubscription: (
    payload: SavePushSubscriptionPayload,
    ack?: (response: ClientAck) => void
  ) => void;
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
const generatedVapidKeys =
  process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? undefined : webpush.generateVAPIDKeys();
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? generatedVapidKeys?.publicKey ?? "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY ?? generatedVapidKeys?.privateKey ?? "";
const vapidSubject = process.env.VAPID_SUBJECT ?? "mailto:starfall@example.com";

const rooms = new Map<string, RoomState>();
const pushSubscriptions = new Map<string, Map<PlayerId, Map<string, webpush.PushSubscription>>>();

webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

if (generatedVapidKeys) {
  console.warn("Using generated VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY on Heroku for stability.");
}

const app = express();
app.set("trust proxy", true);
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

app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (process.env.NODE_ENV !== "production" && origin && devOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }

  next();
});

app.get("/health", (_request, response) => {
  response.json({ ok: true, rooms: rooms.size });
});

app.get("/api/push/public-key", (_request, response) => {
  response.json({ publicKey: vapidPublicKey });
});

app.use(express.static(clientDistPath, { index: false }));
app.use((request, response, next) => {
  if (request.method !== "GET" || request.path.startsWith("/socket.io")) {
    next();
    return;
  }

  response.type("html").send(renderIndexHtml(request));
});

io.on("connection", (socket) => {
  socket.on("createRoom", async (payload: CreateRoomPayload, ack?: (response: ClientAck) => void) => {
    const roomCode = createRoomCode();
    if (!roomCode) {
      ack?.({ ok: false, error: "All single-letter room codes are in use. Try again later." });
      return;
    }

    const playerName = normalizePlayerName(payload.playerName);
    const room = createRoom(roomCode);

    room.players.captainA = {
      id: "captainA",
      name: playerName,
      connected: true
    };
    room.log.push(`${playerName} took command of Captain A.`);
    rooms.set(roomCode, room);

    await joinPlayerSocketToRoom(socket, roomCode, "captainA", playerName);
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
    const rejoinPlayerId = findDisconnectedSeat(room, playerName);
    const openPlayerId = room.phase === "lobby" ? findOpenCaptainSeat(room) : undefined;
    const playerId = rejoinPlayerId ?? openPlayerId;

    if (playerId) {
      room.players[playerId] = {
        id: playerId,
        name: playerName,
        connected: true
      };
      room.log.push(`${playerName} joined as ${playerId === "captainA" ? "Captain A" : "Captain B"}.`);

      await joinPlayerSocketToRoom(socket, roomCode, playerId, playerName);
      ack?.({ ok: true, roomCode });
      await emitRoom(roomCode);
      return;
    }

    const spectatorId = createSpectatorId();
    room.spectators[spectatorId] = {
      id: spectatorId,
      name: playerName,
      connected: true
    };
    room.log = [...room.log, `${playerName} is watching the battle.`].slice(-30);

    await joinSpectatorSocketToRoom(socket, roomCode, spectatorId, playerName);
    ack?.({ ok: true, roomCode });
    await emitRoom(roomCode);
  });

  socket.on("startGame", async (payload: RoomPayload, ack?: (response: ClientAck) => void) => {
    const room = getSocketRoom(socket, payload.roomCode);

    if (!room) {
      ack?.({ ok: false, error: "Join a room before starting." });
      return;
    }

    if (!socket.data.playerId) {
      ack?.({ ok: false, error: "Spectators cannot start combat." });
      return;
    }

    if (!canStartCombat(room)) {
      ack?.({ ok: false, error: "Two connected captains are required." });
      return;
    }

    const startedRoom = startCombat(room);
    rooms.set(room.code, startedRoom);
    ack?.({ ok: true, roomCode: room.code });
    await emitRoom(room.code);
    await notifyPlayers(startedRoom, PLAYER_IDS, {
      title: "Combat started",
      body: `Room ${room.code} is live. Choose your opening orders.`
    });
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
      const resolvedRoom = resolveTurn(room);
      rooms.set(room.code, resolvedRoom);
      ack?.({ ok: true, roomCode: room.code });
      await emitRoom(room.code);
      await notifyTurnResult(resolvedRoom);
      return;
    }

    ack?.({ ok: true, roomCode: room.code });
    await emitRoom(room.code);
    await notifyWaitingPlayers(room, playerId);
  });

  socket.on(
    "savePushSubscription",
    async (payload: SavePushSubscriptionPayload, ack?: (response: ClientAck) => void) => {
      const room = getSocketRoom(socket, payload.roomCode);
      const playerId = socket.data.playerId;

      if (!room || !playerId) {
        ack?.({ ok: false, error: "Join a room before enabling notifications." });
        return;
      }

      if (!payload.subscription?.endpoint) {
        ack?.({ ok: false, error: "Browser did not provide a valid push subscription." });
        return;
      }

      storePushSubscription(room.code, playerId, payload.subscription);
      ack?.({ ok: true, roomCode: room.code });
    }
  );

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
    const spectatorId = socket.data.spectatorId;
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

    if (roomCode && room && spectatorId && room.spectators[spectatorId]) {
      const spectatorName = room.spectators[spectatorId].name;
      delete room.spectators[spectatorId];
      room.log = [...room.log, `${spectatorName} stopped watching.`].slice(-30);
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
  playerName: string
) {
  await leaveCurrentRoom(socket);
  socket.data.roomCode = roomCode;
  socket.data.playerName = playerName;
  await socket.join(roomCode);
}

async function joinPlayerSocketToRoom(
  socket: StarfallSocket,
  roomCode: string,
  playerId: PlayerId,
  playerName: string
) {
  await joinSocketToRoom(socket, roomCode, playerName);
  socket.data.playerId = playerId;
}

async function joinSpectatorSocketToRoom(
  socket: StarfallSocket,
  roomCode: string,
  spectatorId: string,
  playerName: string
) {
  await joinSocketToRoom(socket, roomCode, playerName);
  socket.data.spectatorId = spectatorId;
}

async function leaveCurrentRoom(socket: StarfallSocket) {
  const roomCode = socket.data.roomCode;
  const playerId = socket.data.playerId;
  const spectatorId = socket.data.spectatorId;
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

  if (room && spectatorId && room.spectators[spectatorId]) {
    const spectatorName = room.spectators[spectatorId].name;
    delete room.spectators[spectatorId];
    room.log = [...room.log, `${spectatorName} stopped watching.`].slice(-30);
  }

  if (roomCode) {
    await socket.leave(roomCode);
  }

  socket.data.roomCode = undefined;
  socket.data.playerId = undefined;
  socket.data.spectatorId = undefined;
  socket.data.playerName = undefined;
}

async function emitRoom(roomCode: string) {
  const room = rooms.get(roomCode);
  if (!room) {
    return;
  }

  const sockets = await io.in(roomCode).fetchSockets();
  for (const socket of sockets) {
    socket.emit("roomState", serializeRoom(room, socket.data.playerId, socket.data.spectatorId));
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

function findDisconnectedSeat(room: RoomState, playerName: string): PlayerId | undefined {
  return PLAYER_IDS.find((playerId) => {
    const player = room.players[playerId];
    return player && !player.connected && player.name.toLowerCase() === playerName.toLowerCase();
  });
}

function findOpenCaptainSeat(room: RoomState): PlayerId | undefined {
  return PLAYER_IDS.find((playerId) => !room.players[playerId]);
}

function createSpectatorId(): string {
  return `spectator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createRoomCode(): string | undefined {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code = "";

  if (rooms.size >= alphabet.length) {
    return undefined;
  }

  do {
    code = alphabet[Math.floor(Math.random() * alphabet.length)];
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

function renderIndexHtml(request: express.Request): string {
  const indexPath = path.join(clientDistPath, "index.html");
  const origin = process.env.PUBLIC_APP_URL ?? `${request.protocol}://${request.get("host")}`;
  const previewUrl = `${origin}/starfall-link-preview.png`;

  return readFileSync(indexPath, "utf8").replaceAll("/starfall-link-preview.png", previewUrl);
}

function storePushSubscription(
  roomCode: string,
  playerId: PlayerId,
  subscription: webpush.PushSubscription
) {
  const roomSubscriptions = pushSubscriptions.get(roomCode) ?? new Map<PlayerId, Map<string, webpush.PushSubscription>>();
  const playerSubscriptions = roomSubscriptions.get(playerId) ?? new Map<string, webpush.PushSubscription>();

  playerSubscriptions.set(subscription.endpoint, subscription);
  roomSubscriptions.set(playerId, playerSubscriptions);
  pushSubscriptions.set(roomCode, roomSubscriptions);
}

async function notifyWaitingPlayers(room: RoomState, submittedBy: PlayerId) {
  const waitingPlayers = PLAYER_IDS.filter((playerId) => !room.pendingCommands[playerId]);
  const submittedName = room.players[submittedBy]?.name ?? "The other captain";

  await notifyPlayers(room, waitingPlayers, {
    title: "Your orders are needed",
    body: `${submittedName} has locked in orders for turn ${room.turn}.`,
    tag: `starfall-${room.code}-turn-${room.turn}-waiting`
  });
}

async function notifyTurnResult(room: RoomState) {
  if (room.phase === "finished") {
    const winnerName = room.winner ? room.players[room.winner]?.name ?? "A captain" : "No one";
    await notifyPlayers(room, PLAYER_IDS, {
      title: "Battle ended",
      body: `${winnerName} controls the field in room ${room.code}.`,
      tag: `starfall-${room.code}-finished`
    });
    return;
  }

  await notifyPlayers(room, PLAYER_IDS, {
    title: `Turn ${room.turn} ready`,
    body: `Review the battle log and choose your next orders in room ${room.code}.`,
    tag: `starfall-${room.code}-turn-${room.turn}`
  });
}

async function notifyPlayers(
  room: RoomState,
  playerIds: PlayerId[],
  notification: { title: string; body: string; tag?: string }
) {
  await Promise.all(playerIds.map((playerId) => notifyPlayer(room, playerId, notification)));
}

async function notifyPlayer(
  room: RoomState,
  playerId: PlayerId,
  notification: { title: string; body: string; tag?: string }
) {
  const playerSubscriptions = pushSubscriptions.get(room.code)?.get(playerId);
  if (!playerSubscriptions?.size) {
    return;
  }

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    tag: notification.tag ?? `starfall-${room.code}`,
    url: `/?room=${room.code}`
  });

  await Promise.all(
    Array.from(playerSubscriptions.entries()).map(async ([endpoint, subscription]) => {
      try {
        await webpush.sendNotification(subscription, payload);
      } catch (error) {
        if (isExpiredPushSubscription(error)) {
          playerSubscriptions.delete(endpoint);
          return;
        }

        console.warn("Failed to send push notification", error);
      }
    })
  );
}

function isExpiredPushSubscription(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return false;
  }

  const statusCode = Number((error as { statusCode?: number }).statusCode);
  return statusCode === 404 || statusCode === 410;
}
