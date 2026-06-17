import express from "express";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server, Socket } from "socket.io";
import webpush from "web-push";
import {
  appendToBattleLog,
  beginDeploy,
  canRematch,
  canStartCombat,
  ChatMessage,
  ClientRoomState,
  CombatCommand,
  createDefaultPlayerState,
  createRoom,
  DEFAULT_SHIP_CLASS_ID,
  ensurePlayerProgress,
  finalizeSessionMatch,
  isShipClassId,
  isValidDeviceId,
  isConsumableId,
  launchCombat,
  bothCrewDeployed,
  markRematchReady,
  PlayerId,
  PLAYER_IDS,
  PlayerStats,
  purchaseSystemUpgrade,
  purchaseConsumableCharge,
  refundSystemUpgrade,
  RecentGame,
  recordSessionGameWin,
  resetPlayerProgress,
  resolvePlayerTurn,
  RoomState,
  selectShipClass,
  serializeRoom,
  submitCrewDeployment,
  SystemId,
  SYSTEM_DEFINITIONS
} from "../shared/game";
import {
  getPlayerStats,
  recordGameResult,
  recordMatchResult
} from "./playerStatsStore";

interface ClientAck {
  ok: boolean;
  error?: string;
  roomCode?: string;
}

interface CreateRoomPayload {
  playerName?: string;
  deviceId?: string;
}

interface JoinRoomPayload {
  roomCode?: string;
  playerName?: string;
  deviceId?: string;
}

interface SyncPlayerStatsPayload {
  deviceId?: string;
  playerName?: string;
}

interface RoomPayload {
  roomCode?: string;
}

interface SelectShipClassPayload extends RoomPayload {
  shipClassId?: string;
}

interface SubmitCrewDeploymentPayload extends RoomPayload {
  crewAssignments?: Partial<Record<string, number>>;
}

interface SubmitCommandPayload extends RoomPayload {
  command?: CombatCommand;
}

interface SendChatPayload extends RoomPayload {
  text?: string;
}

interface SavePushSubscriptionPayload extends RoomPayload {
  subscription?: webpush.PushSubscription;
}

interface PurchaseUpgradePayload extends RoomPayload {
  systemId?: SystemId;
}

interface PurchaseConsumablePayload extends RoomPayload {
  consumableId?: string;
}

interface SocketData {
  roomCode?: string;
  playerId?: PlayerId;
  spectatorId?: string;
  playerName?: string;
  deviceId?: string;
}

interface ClientToServerEvents {
  createRoom: (payload: CreateRoomPayload, ack?: (response: ClientAck) => void) => void;
  joinRoom: (payload: JoinRoomPayload, ack?: (response: ClientAck) => void) => void;
  startGame: (payload: RoomPayload, ack?: (response: ClientAck) => void) => void;
  rematch: (payload: RoomPayload, ack?: (response: ClientAck) => void) => void;
  selectShipClass: (payload: SelectShipClassPayload, ack?: (response: ClientAck) => void) => void;
  submitCrewDeployment: (payload: SubmitCrewDeploymentPayload, ack?: (response: ClientAck) => void) => void;
  submitCommand: (payload: SubmitCommandPayload, ack?: (response: ClientAck) => void) => void;
  sendChat: (payload: SendChatPayload, ack?: (response: ClientAck) => void) => void;
  savePushSubscription: (
    payload: SavePushSubscriptionPayload,
    ack?: (response: ClientAck) => void
  ) => void;
  leaveRoom: (payload: RoomPayload, ack?: (response: ClientAck) => void) => void;
  purchaseUpgrade: (payload: PurchaseUpgradePayload, ack?: (response: ClientAck) => void) => void;
  refundUpgrade: (payload: PurchaseUpgradePayload, ack?: (response: ClientAck) => void) => void;
  purchaseConsumable: (payload: PurchaseConsumablePayload, ack?: (response: ClientAck) => void) => void;
  syncPlayerStats: (payload: SyncPlayerStatsPayload, ack?: (response: ClientAck) => void) => void;
}

interface ServerToClientEvents {
  roomState: (state: ClientRoomState) => void;
  recentGames: (games: RecentGame[]) => void;
  playerStats: (stats: PlayerStats) => void;
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
const recentGames: RecentGame[] = [];

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
  socket.emit("recentGames", recentGames);

  socket.on("syncPlayerStats", (payload: SyncPlayerStatsPayload, ack?: (response: ClientAck) => void) => {
    const deviceId = normalizeDeviceId(payload.deviceId);

    if (!deviceId) {
      ack?.({ ok: false, error: "Could not identify this device." });
      return;
    }

    socket.data.deviceId = deviceId;
    const stats = getPlayerStats(deviceId, normalizePlayerName(payload.playerName));
    socket.emit("playerStats", stats);
    ack?.({ ok: true });
  });

  socket.on("createRoom", async (payload: CreateRoomPayload, ack?: (response: ClientAck) => void) => {
    const roomCode = createRoomCode();
    if (!roomCode) {
      ack?.({ ok: false, error: "All single-letter room codes are in use. Try again later." });
      return;
    }

    const playerName = normalizePlayerName(payload.playerName);
    const deviceId = normalizeDeviceId(payload.deviceId);

    if (!deviceId) {
      ack?.({ ok: false, error: "Could not identify this device." });
      return;
    }

    const room = createRoom(roomCode);

    room.players.captainA = createDefaultPlayerState("captainA", playerName, true, DEFAULT_SHIP_CLASS_ID, deviceId);
    room.log.push(`${playerName} took command of Captain A.`);
    rooms.set(roomCode, room);

    await joinPlayerSocketToRoom(socket, roomCode, "captainA", playerName, deviceId);
    ack?.({ ok: true, roomCode });
    await emitRoom(roomCode);
    emitPlayerStats(socket, deviceId, playerName);
  });

  socket.on("joinRoom", async (payload: JoinRoomPayload, ack?: (response: ClientAck) => void) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = roomCode ? rooms.get(roomCode) : undefined;

    if (!room || !roomCode) {
      ack?.({ ok: false, error: "Room not found." });
      return;
    }

    const playerName = normalizePlayerName(payload.playerName);
    const deviceId = normalizeDeviceId(payload.deviceId);

    if (!deviceId) {
      ack?.({ ok: false, error: "Could not identify this device." });
      return;
    }

    const rejoinPlayerId = findDisconnectedSeat(room, playerName);
    const openPlayerId = room.phase === "lobby" ? findOpenCaptainSeat(room) : undefined;
    const playerId = rejoinPlayerId ?? openPlayerId;

    if (playerId) {
      const existingPlayer = room.players[playerId];
      room.players[playerId] = existingPlayer
        ? ensurePlayerProgress({ ...existingPlayer, name: playerName, connected: true, deviceId })
        : createDefaultPlayerState(playerId, playerName, true, DEFAULT_SHIP_CLASS_ID, deviceId);
      room.log.push(`${playerName} joined as ${playerId === "captainA" ? "Captain A" : "Captain B"}.`);

      await joinPlayerSocketToRoom(socket, roomCode, playerId, playerName, deviceId);
      ack?.({ ok: true, roomCode });
      await emitRoom(roomCode);
      emitPlayerStats(socket, deviceId, playerName);
      return;
    }

    const spectatorId = createSpectatorId();
    room.spectators[spectatorId] = {
      id: spectatorId,
      name: playerName,
      connected: true
    };
    room.log = appendToBattleLog(room.log, `${playerName} is watching the battle.`);

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

    const startedRoom = beginDeploy(room);
    rooms.set(room.code, startedRoom);
    ack?.({ ok: true, roomCode: room.code });
    await emitRoom(room.code);
  });

  socket.on("selectShipClass", async (payload: SelectShipClassPayload, ack?: (response: ClientAck) => void) => {
    const room = getSocketRoom(socket, payload.roomCode);
    const playerId = socket.data.playerId;
    const shipClassId = payload.shipClassId?.trim();

    if (!room || !playerId) {
      ack?.({ ok: false, error: "Join a room before selecting a ship." });
      return;
    }

    if (room.phase !== "lobby") {
      ack?.({ ok: false, error: "Ships can only be changed before combat begins." });
      return;
    }

    if (!shipClassId || !isShipClassId(shipClassId)) {
      ack?.({ ok: false, error: "Choose a valid ship class." });
      return;
    }

    const updatedRoom = selectShipClass(room, playerId, shipClassId);
    rooms.set(room.code, updatedRoom);
    ack?.({ ok: true, roomCode: room.code });
    await emitRoom(room.code);
  });

  socket.on(
    "submitCrewDeployment",
    async (payload: SubmitCrewDeploymentPayload, ack?: (response: ClientAck) => void) => {
      const room = getSocketRoom(socket, payload.roomCode);
      const playerId = socket.data.playerId;

      if (!room || !playerId) {
        ack?.({ ok: false, error: "Join a room before deploying crew." });
        return;
      }

      if (room.phase !== "deploy") {
        ack?.({ ok: false, error: "Crew can only be deployed before combat begins." });
        return;
      }

      const updatedRoom = submitCrewDeployment(room, playerId, payload.crewAssignments);
      if (updatedRoom === room) {
        ack?.({ ok: false, error: "Assign every crew member before confirming deployment." });
        return;
      }

      let nextRoom = updatedRoom;
      if (bothCrewDeployed(updatedRoom)) {
        nextRoom = launchCombat(updatedRoom);
      }

      rooms.set(room.code, nextRoom);
      ack?.({ ok: true, roomCode: room.code });
      await emitRoom(room.code);

      if (nextRoom.phase === "combat") {
        await notifyActivePlayer(nextRoom, {
          title: "Your turn",
          body: `Combat started in room ${room.code}. Choose the opening action.`
        });
      }
    }
  );

  socket.on("rematch", async (payload: RoomPayload, ack?: (response: ClientAck) => void) => {
    const room = getSocketRoom(socket, payload.roomCode);
    const playerId = socket.data.playerId;

    if (!room) {
      ack?.({ ok: false, error: "Join a room before starting a rematch." });
      return;
    }

    if (!playerId) {
      ack?.({ ok: false, error: "Spectators cannot start a rematch." });
      return;
    }

    if (room.phase !== "finished") {
      ack?.({ ok: false, error: "The battle is still in progress." });
      return;
    }

    if (!canRematch(room)) {
      ack?.({ ok: false, error: "Both connected captains are required for a rematch." });
      return;
    }

    const rematchedRoom = markRematchReady(room, playerId);
    if (rematchedRoom === room) {
      if (room.players[playerId]?.rematchReady) {
        ack?.({ ok: true, roomCode: room.code });
        return;
      }

      ack?.({ ok: false, error: "Could not mark ready for rematch." });
      return;
    }

    rooms.set(room.code, rematchedRoom);
    ack?.({ ok: true, roomCode: room.code });
    await emitRoom(room.code);
  });

  socket.on(
    "purchaseUpgrade",
    async (payload: PurchaseUpgradePayload, ack?: (response: ClientAck) => void) => {
      const room = getSocketRoom(socket, payload.roomCode);
      const playerId = socket.data.playerId;
      const systemId = payload.systemId;

      if (!room || !playerId) {
        ack?.({ ok: false, error: "Join a room before purchasing upgrades." });
        return;
      }

      if (room.phase !== "finished") {
        ack?.({ ok: false, error: "Upgrades can only be purchased after a battle." });
        return;
      }

      if (room.players[playerId]?.rematchReady) {
        ack?.({ ok: false, error: "You already marked ready for the next battle." });
        return;
      }

      if (!systemId || !SYSTEM_DEFINITIONS.some((system) => system.id === systemId)) {
        ack?.({ ok: false, error: "Choose a valid system to upgrade." });
        return;
      }

      const updatedRoom = purchaseSystemUpgrade(room, playerId, systemId);
      if (updatedRoom === room) {
        ack?.({ ok: false, error: "Not enough credits or system is already max level." });
        return;
      }

      rooms.set(room.code, updatedRoom);
      ack?.({ ok: true, roomCode: room.code });
      await emitRoom(room.code);
    }
  );

  socket.on(
    "refundUpgrade",
    async (payload: PurchaseUpgradePayload, ack?: (response: ClientAck) => void) => {
      const room = getSocketRoom(socket, payload.roomCode);
      const playerId = socket.data.playerId;
      const systemId = payload.systemId;

      if (!room || !playerId) {
        ack?.({ ok: false, error: "Join a room before refunding upgrades." });
        return;
      }

      if (room.phase !== "finished") {
        ack?.({ ok: false, error: "Upgrades can only be refunded after a battle." });
        return;
      }

      if (room.players[playerId]?.rematchReady) {
        ack?.({ ok: false, error: "You already marked ready for the next battle." });
        return;
      }

      if (!systemId || !SYSTEM_DEFINITIONS.some((system) => system.id === systemId)) {
        ack?.({ ok: false, error: "Choose a valid system to refund." });
        return;
      }

      const updatedRoom = refundSystemUpgrade(room, playerId, systemId);
      if (updatedRoom === room) {
        ack?.({ ok: false, error: "That system has no upgrade to refund." });
        return;
      }

      rooms.set(room.code, updatedRoom);
      ack?.({ ok: true, roomCode: room.code });
      await emitRoom(room.code);
    }
  );

  socket.on(
    "purchaseConsumable",
    async (payload: PurchaseConsumablePayload, ack?: (response: ClientAck) => void) => {
      const room = getSocketRoom(socket, payload.roomCode);
      const playerId = socket.data.playerId;
      const consumableId = payload.consumableId?.trim();

      if (!room || !playerId) {
        ack?.({ ok: false, error: "Join a room before purchasing supplies." });
        return;
      }

      if (room.phase !== "finished") {
        ack?.({ ok: false, error: "Supplies can only be purchased after a battle." });
        return;
      }

      if (room.players[playerId]?.rematchReady) {
        ack?.({ ok: false, error: "You already marked ready for the next battle." });
        return;
      }

      if (!consumableId || !isConsumableId(consumableId)) {
        ack?.({ ok: false, error: "Choose a valid supply to purchase." });
        return;
      }

      const updatedRoom = purchaseConsumableCharge(room, playerId, consumableId);
      if (updatedRoom === room) {
        ack?.({ ok: false, error: "Not enough credits or supply stock is full." });
        return;
      }

      rooms.set(room.code, updatedRoom);
      ack?.({ ok: true, roomCode: room.code });
      await emitRoom(room.code);
    }
  );

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

    if (room.activePlayer !== playerId) {
      ack?.({ ok: false, error: "It is not your turn yet." });
      return;
    }

    const resolvedRoom = resolvePlayerTurn(room, playerId, payload.command ?? { type: "brace" });
    rooms.set(room.code, resolvedRoom);
    recordRecentGame(room, resolvedRoom);
    ack?.({ ok: true, roomCode: room.code });
    await emitRoom(room.code);
    await notifyTurnResult(resolvedRoom);
  });

  socket.on("sendChat", async (payload: SendChatPayload, ack?: (response: ClientAck) => void) => {
    const room = getSocketRoom(socket, payload.roomCode);
    const text = payload.text?.trim();

    if (!room) {
      ack?.({ ok: false, error: "Join a room before chatting." });
      return;
    }

    if (!text) {
      ack?.({ ok: false, error: "Message cannot be empty." });
      return;
    }

    const message = createChatMessage(socket, text);
    room.chat = [...room.chat, message].slice(-50);
    ack?.({ ok: true, roomCode: room.code });
    await emitRoom(room.code);
    await notifyChatMessage(room, socket, message);
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
    const deviceId = socket.data.deviceId;
    await leaveCurrentRoom(socket, { explicitLeave: true });
    ack?.({ ok: true });

    if (deviceId) {
      emitPlayerStats(socket, deviceId);
    }

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
      room.log = appendToBattleLog(
        room.log,
        `${room.players[playerId]?.name ?? "A captain"} disconnected. They can rejoin with the room code.`
      );
      await emitRoom(roomCode);
    }

    if (roomCode && room && spectatorId && room.spectators[spectatorId]) {
      const spectatorName = room.spectators[spectatorId].name;
      delete room.spectators[spectatorId];
      room.log = appendToBattleLog(room.log, `${spectatorName} stopped watching.`);
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
  await leaveCurrentRoom(socket, { explicitLeave: true });
  socket.data.roomCode = roomCode;
  socket.data.playerName = playerName;
  await socket.join(roomCode);
}

async function joinPlayerSocketToRoom(
  socket: StarfallSocket,
  roomCode: string,
  playerId: PlayerId,
  playerName: string,
  deviceId?: string
) {
  await joinSocketToRoom(socket, roomCode, playerName);
  socket.data.playerId = playerId;

  if (deviceId) {
    socket.data.deviceId = deviceId;
  }
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

async function leaveCurrentRoom(socket: StarfallSocket, options?: { explicitLeave?: boolean }) {
  const roomCode = socket.data.roomCode;
  const playerId = socket.data.playerId;
  const spectatorId = socket.data.spectatorId;
  let room = roomCode ? rooms.get(roomCode) : undefined;

  if (room && playerId && room.players[playerId]) {
    const winsA = room.sessionGameWins?.captainA ?? 0;
    const winsB = room.sessionGameWins?.captainB ?? 0;
    const { room: roomAfterMatch, matchResult } = finalizeSessionMatch(room);

    if (matchResult) {
      recordMatchResult(matchResult);
      roomAfterMatch.log = appendToBattleLog(
        roomAfterMatch.log,
        `${matchResult.winnerName} wins the room match ${winsA}-${winsB} before departure.`
      );
      await notifyPlayerStats([matchResult.winnerDeviceId, matchResult.loserDeviceId]);
    }

    room = roomAfterMatch;
    rooms.set(room.code, room);

    const playerName = room.players[playerId]?.name ?? "A captain";

    if (options?.explicitLeave) {
      delete room.players[playerId];
      room.log = appendToBattleLog(room.log, `${playerName} left the room.`);
    } else {
      room.players[playerId] = resetPlayerProgress({
        ...room.players[playerId]!,
        connected: false
      });
    }
  }

  if (room && spectatorId && room.spectators[spectatorId]) {
    const spectatorName = room.spectators[spectatorId].name;
    delete room.spectators[spectatorId];
    room.log = appendToBattleLog(room.log, `${spectatorName} stopped watching.`);
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

function createChatMessage(socket: StarfallSocket, text: string): ChatMessage {
  const playerId = socket.data.playerId;
  return {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    author: socket.data.playerName ?? "Anonymous",
    role: playerId ?? "spectator",
    text: text.slice(0, 280),
    createdAt: Date.now()
  };
}

function recordRecentGame(previousRoom: RoomState, resolvedRoom: RoomState) {
  if (previousRoom.phase === "finished" || resolvedRoom.phase !== "finished" || !resolvedRoom.winner) {
    return;
  }

  const winner = resolvedRoom.winner;
  const loser = winner === "captainA" ? "captainB" : "captainA";
  const game: RecentGame = {
    id: `game-${resolvedRoom.code}-${Date.now()}`,
    roomCode: resolvedRoom.code,
    winnerName: resolvedRoom.players[winner]?.name ?? labelForPlayer(winner),
    loserName: resolvedRoom.players[loser]?.name ?? labelForPlayer(loser),
    rounds: previousRoom.turn,
    completedAt: Date.now()
  };

  recentGames.unshift(game);
  recentGames.splice(8);
  io.emit("recentGames", recentGames);

  const nextRoom = recordSessionGameWin(resolvedRoom, winner);
  rooms.set(nextRoom.code, nextRoom);

  const winnerDeviceId = nextRoom.players[winner]?.deviceId;
  const loserDeviceId = nextRoom.players[loser]?.deviceId;

  if (winnerDeviceId && loserDeviceId) {
    recordGameResult(
      winnerDeviceId,
      loserDeviceId,
      nextRoom.players[winner]?.name ?? labelForPlayer(winner),
      nextRoom.players[loser]?.name ?? labelForPlayer(loser)
    );
    void notifyPlayerStats([winnerDeviceId, loserDeviceId]);
  }
}

function normalizeDeviceId(deviceId?: string): string | undefined {
  const normalized = deviceId?.trim().toLowerCase();

  if (!normalized || !isValidDeviceId(normalized)) {
    return undefined;
  }

  return normalized;
}

function emitPlayerStats(socket: StarfallSocket, deviceId: string, playerName?: string) {
  socket.emit("playerStats", getPlayerStats(deviceId, playerName));
}

async function notifyPlayerStats(deviceIds: string[]) {
  const uniqueDeviceIds = [...new Set(deviceIds)];
  const sockets = await io.fetchSockets();

  for (const socket of sockets) {
    const deviceId = socket.data.deviceId;

    if (deviceId && uniqueDeviceIds.includes(deviceId)) {
      socket.emit("playerStats", getPlayerStats(deviceId, socket.data.playerName));
    }
  }
}

function labelForPlayer(playerId: PlayerId): string {
  return playerId === "captainA" ? "Captain A" : "Captain B";
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

async function notifyChatMessage(room: RoomState, sender: StarfallSocket, message: ChatMessage) {
  const recipients = PLAYER_IDS.filter((playerId) => {
    if (sender.data.playerId === playerId) {
      return false;
    }

    return room.players[playerId]?.connected;
  });

  if (recipients.length === 0) {
    return;
  }

  await notifyPlayers(room, recipients, {
    title: `Comms in room ${room.code}`,
    body: `${message.author}: ${message.text}`,
    tag: `starfall-${room.code}-chat-${message.id}`
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

  await notifyActivePlayer(room, {
    title: `Turn ${room.turn}: your action`,
    body: `Review the last action and choose your next move in room ${room.code}.`,
    tag: `starfall-${room.code}-turn-${room.turn}`
  });
}

async function notifyActivePlayer(
  room: RoomState,
  notification: { title: string; body: string; tag?: string }
) {
  if (!room.activePlayer) {
    return;
  }

  await notifyPlayer(room, room.activePlayer, notification);
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
