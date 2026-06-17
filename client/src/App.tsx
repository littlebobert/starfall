import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { io, Socket } from "socket.io-client";
import {
  ClientRoomState,
  CombatCommand,
  CONSUMABLES,
  canPurchaseConsumable,
  BATTLE_END_LOG_MARKER,
  CRITICAL_STRIKE_LOG_MARKER,
  crewAssignmentsEqual,
  DEFAULT_SHIP_CLASS_ID,
  DEFAULT_TARGET_SYSTEM,
  formatShipClassSummary,
  getCriticalStrikeChance,
  getAssignedCrewCount,
  getCrewAtStation,
  getShipClass,
  getSuffocationTurnsRemaining,
  getUpgradeCost,
  getUpgradeRefund,
  getUpgradeHpBonus,
  HULL_PUNCTURE_LOG_MARKER,
  MAX_UPGRADE_LEVEL,
  MAX_CONSUMABLE_STOCK,
  MAX_CREW_PER_STATION,
  PLAYER_IDS,
  PlayerId,
  PlayerStats,
  RecentGame,
  sanitizeCrewAssignments,
  Ship,
  SHIP_CLASSES,
  ShipClassId,
  SUFFOCATION_TURNS,
  STARTING_BREACH_SEALS,
  STARTING_SHIELD_BRACES,
  SYSTEM_DEFINITIONS,
  SystemId,
  type ConsumableId
} from "../../shared/game";

interface Ack {
  ok: boolean;
  error?: string;
  roomCode?: string;
}

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface ServerToClientEvents {
  roomState: (state: ClientRoomState) => void;
  recentGames: (games: RecentGame[]) => void;
  playerStats: (stats: PlayerStats) => void;
}

interface ClientToServerEvents {
  createRoom: (
    payload: { playerName: string; deviceId: string },
    ack: (response: Ack) => void
  ) => void;
  joinRoom: (
    payload: { roomCode: string; playerName: string; deviceId: string },
    ack: (response: Ack) => void
  ) => void;
  syncPlayerStats: (
    payload: { deviceId: string; playerName?: string },
    ack: (response: Ack) => void
  ) => void;
  startGame: (payload: { roomCode: string }, ack: (response: Ack) => void) => void;
  rematch: (payload: { roomCode: string }, ack: (response: Ack) => void) => void;
  selectShipClass: (
    payload: { roomCode: string; shipClassId: ShipClassId },
    ack: (response: Ack) => void
  ) => void;
  submitCrewDeployment: (
    payload: { roomCode: string; crewAssignments: Record<SystemId, number> },
    ack: (response: Ack) => void
  ) => void;
  submitCommand: (
    payload: { roomCode: string; command: CombatCommand },
    ack: (response: Ack) => void
  ) => void;
  sendChat: (payload: { roomCode: string; text: string }, ack: (response: Ack) => void) => void;
  savePushSubscription: (
    payload: { roomCode: string; subscription: PushSubscriptionJSON },
    ack: (response: Ack) => void
  ) => void;
  leaveRoom: (payload: { roomCode: string }, ack: (response: Ack) => void) => void;
  purchaseUpgrade: (
    payload: { roomCode: string; systemId: SystemId },
    ack: (response: Ack) => void
  ) => void;
  purchaseConsumable: (
    payload: { roomCode: string; consumableId: ConsumableId },
    ack: (response: Ack) => void
  ) => void;
  refundUpgrade: (
    payload: { roomCode: string; systemId: SystemId },
    ack: (response: Ack) => void
  ) => void;
}

type NotificationStatus = "unsupported" | "default" | "denied" | "syncing" | "enabled" | "error";

const socketUrl =
  import.meta.env.VITE_SOCKET_URL ??
  (import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:3001` : undefined);

const DEVICE_ID_STORAGE_KEY = "starfall-device-id";

function getOrCreateDeviceId(): string {
  const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);

  if (existing) {
    return existing;
  }

  const deviceId = crypto.randomUUID();
  window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
  return deviceId;
}

function syncPlayerStats(playerName?: string) {
  socket.emit(
    "syncPlayerStats",
    {
      deviceId: getOrCreateDeviceId(),
      playerName: playerName?.trim() || undefined
    },
    () => undefined
  );
}

function playerHasUpgradeProgress(room: ClientRoomState, playerId: PlayerId): boolean {
  const player = room.players[playerId];

  if (!player) {
    return false;
  }

  if (player.credits > 0) {
    return true;
  }

  if (player.shieldBraces > STARTING_SHIELD_BRACES || player.breachSeals > STARTING_BREACH_SEALS) {
    return true;
  }

  return Object.values(player.systemUpgrades).some((level) => level > 1);
}

const systemIds = SYSTEM_DEFINITIONS.map((system) => system.id);
const socket: ClientSocket = io(socketUrl);
const systemVisuals: Record<SystemId, { gridArea: string; icon: string }> = {
  engines: { gridArea: "engines", icon: "Drive" },
  shields: { gridArea: "shields", icon: "Ward" },
  weapons: { gridArea: "weapons", icon: "Guns" },
  sensors: { gridArea: "sensors", icon: "Scan" },
  lifeSupport: { gridArea: "lifeSupport", icon: "O2" }
};

export default function App() {
  const [room, setRoom] = useState<ClientRoomState>();
  const [playerName, setPlayerName] = useState(
    () => window.localStorage.getItem("starfall-player-name") ?? ""
  );
  const [joinCode, setJoinCode] = useState(
    () =>
      new URLSearchParams(window.location.search).get("room") ??
      window.localStorage.getItem("starfall-room-code") ??
      ""
  );
  const [error, setError] = useState<string>();
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [recentGames, setRecentGames] = useState<RecentGame[]>([]);
  const [playerStats, setPlayerStats] = useState<PlayerStats>();
  const [workSafeMode, setWorkSafeMode] = useState(
    () => window.localStorage.getItem("starfall-work-safe") === "true"
  );
  const [commandType, setCommandType] = useState<CombatCommand["type"]>("fire");
  const [targetSystem, setTargetSystem] = useState<SystemId>(DEFAULT_TARGET_SYSTEM);
  const [repairSystem, setRepairSystem] = useState<SystemId>(DEFAULT_TARGET_SYSTEM);
  const [crewAssignmentsDraft, setCrewAssignmentsDraft] = useState<Record<SystemId, number>>(() =>
    SYSTEM_DEFINITIONS.reduce(
      (assignments, system) => {
        assignments[system.id] = 0;
        return assignments;
      },
      {} as Record<SystemId, number>
    )
  );
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>(getInitialNotificationStatus);
  const [notificationError, setNotificationError] = useState<string>();
  const lastSyncedNotificationKey = useRef<string | undefined>(undefined);
  const autoJoinAttemptedKey = useRef<string | undefined>(undefined);
  const leavingRoomRef = useRef(false);

  useEffect(() => {
    function handleConnect() {
      setIsConnected(true);
      setError(undefined);
      syncPlayerStats(playerName);
    }

    function handleDisconnect() {
      setIsConnected(false);
    }

    function handleConnectError(error: Error) {
      setIsConnected(false);
      setError(`Could not reach the game server at ${socketUrl ?? window.location.origin}: ${error.message}`);
    }

    function handleRoomState(nextRoom: ClientRoomState) {
      if (leavingRoomRef.current) {
        return;
      }

      setRoom(nextRoom);
      setJoinCode(nextRoom.code);
      window.history.replaceState(null, "", `?room=${nextRoom.code}`);
      window.localStorage.setItem("starfall-room-code", nextRoom.code);
    }

    function handleRecentGames(nextRecentGames: RecentGame[]) {
      setRecentGames(nextRecentGames);
    }

    function handlePlayerStats(nextPlayerStats: PlayerStats) {
      setPlayerStats(nextPlayerStats);
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("roomState", handleRoomState);
    socket.on("recentGames", handleRecentGames);
    socket.on("playerStats", handlePlayerStats);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("roomState", handleRoomState);
      socket.off("recentGames", handleRecentGames);
      socket.off("playerStats", handlePlayerStats);
    };
  }, []);

  useEffect(() => {
    if (!isConnected || room) {
      return;
    }

    syncPlayerStats(playerName);
  }, [isConnected, playerName, room]);

  useEffect(() => {
    if (!isConnected || room || !joinCode || !playerName.trim()) {
      return;
    }

    const autoJoinKey = `${joinCode}:${playerName.trim()}`;
    if (autoJoinAttemptedKey.current === autoJoinKey) {
      return;
    }

    autoJoinAttemptedKey.current = autoJoinKey;
    socket.emit("joinRoom", {
      roomCode: joinCode,
      playerName: playerName.trim(),
      deviceId: getOrCreateDeviceId()
    }, (response) => {
      if (!response.ok) {
        window.localStorage.removeItem("starfall-room-code");
      }
    });
  }, [isConnected, joinCode, playerName, room]);

  useEffect(() => {
    function handleServiceWorkerMessage(event: MessageEvent) {
      if (event.data?.type !== "starfall-open-room" || !event.data.roomCode) {
        return;
      }

      const nextRoomCode = String(event.data.roomCode).toUpperCase();
      setJoinCode(nextRoomCode);
      window.localStorage.setItem("starfall-room-code", nextRoomCode);

      if (!room && playerName.trim()) {
        socket.emit(
          "joinRoom",
          {
            roomCode: nextRoomCode,
            playerName: playerName.trim(),
            deviceId: getOrCreateDeviceId()
          },
          handleAck
        );
      }
    }

    navigator.serviceWorker?.addEventListener("message", handleServiceWorkerMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", handleServiceWorkerMessage);
  }, [playerName, room]);

  useEffect(() => {
    if (!room?.code || !room.you || getInitialNotificationStatus() !== "enabled") {
      return;
    }

    const syncKey = `${room.code}:${room.you}`;
    if (lastSyncedNotificationKey.current === syncKey) {
      return;
    }

    lastSyncedNotificationKey.current = syncKey;
    syncPushSubscription(room.code);
  }, [room?.code, room?.you]);

  const you = room?.you;
  const opponent = you ? (you === "captainA" ? "captainB" : "captainA") : undefined;
  const isSpectator = Boolean(room?.spectatorId && !you);
  const isYourTurn = Boolean(room?.phase === "combat" && you && room.activePlayer === you);
  const yourShip = you ? room?.ships[you] : undefined;
  const redeployReady = Boolean(
    yourShip &&
      sanitizeCrewAssignments(yourShip, crewAssignmentsDraft) &&
      !crewAssignmentsEqual(crewAssignmentsDraft, yourShip.crewAssignments)
  );

  useEffect(() => {
    if (!room || !you || !room.ships[you]) {
      return;
    }

    if (room.phase === "deploy") {
      setCrewAssignmentsDraft({ ...room.ships[you].crewAssignments });
      return;
    }

    if (room.phase === "combat" && room.activePlayer === you) {
      setCrewAssignmentsDraft({ ...room.ships[you].crewAssignments });
    }
  }, [room?.phase, room?.turn, room?.activePlayer, you, room?.ships]);

  function rememberName() {
    const normalizedName = playerName.trim() || "Captain";
    window.localStorage.setItem("starfall-player-name", normalizedName);
    return normalizedName;
  }

  function handleAck(response: Ack) {
    if (!response.ok) {
      setError(response.error ?? "Something went wrong.");
      return;
    }

    setError(undefined);
    if (response.roomCode) {
      window.history.replaceState(null, "", `?room=${response.roomCode}`);
      window.localStorage.setItem("starfall-room-code", response.roomCode);
    }
  }

  function createRoom(event: FormEvent) {
    event.preventDefault();
    socket.emit(
      "createRoom",
      { playerName: rememberName(), deviceId: getOrCreateDeviceId() },
      handleAck
    );
  }

  function joinRoom(event: FormEvent) {
    event.preventDefault();
    socket.emit(
      "joinRoom",
      { roomCode: joinCode, playerName: rememberName(), deviceId: getOrCreateDeviceId() },
      handleAck
    );
  }

  function startGame() {
    if (!room || !room.you) {
      return;
    }

    socket.emit("startGame", { roomCode: room.code }, handleAck);
  }

  function rematch() {
    if (!room || !room.you) {
      return;
    }

    socket.emit("rematch", { roomCode: room.code }, handleAck);
  }

  function purchaseUpgrade(systemId: SystemId) {
    if (!room || !room.you) {
      return;
    }

    socket.emit("purchaseUpgrade", { roomCode: room.code, systemId }, handleAck);
  }

  function purchaseConsumable(consumableId: ConsumableId) {
    if (!room || !room.you) {
      return;
    }

    socket.emit("purchaseConsumable", { roomCode: room.code, consumableId }, handleAck);
  }

  function refundUpgrade(systemId: SystemId) {
    if (!room || !room.you) {
      return;
    }

    socket.emit("refundUpgrade", { roomCode: room.code, systemId }, handleAck);
  }

  function selectShipClass(shipClassId: ShipClassId) {
    if (!room || !room.you) {
      return;
    }

    socket.emit("selectShipClass", { roomCode: room.code, shipClassId }, handleAck);
  }

  function submitCrewDeployment() {
    if (!room || !room.you) {
      return;
    }

    socket.emit(
      "submitCrewDeployment",
      { roomCode: room.code, crewAssignments: crewAssignmentsDraft },
      handleAck
    );
  }

  function submitCommand() {
    if (!room || !isYourTurn) {
      return;
    }

    const command: CombatCommand =
      commandType === "fire"
        ? { type: "fire", targetSystem }
        : commandType === "repair"
          ? { type: "repair", repairSystem }
          : commandType === "jam"
              ? { type: "jam" }
              : commandType === "evasive"
                ? { type: "evasive" }
                : commandType === "patch"
                  ? { type: "patch" }
                  : commandType === "redeploy"
                    ? { type: "redeploy", crewAssignments: crewAssignmentsDraft }
                    : { type: "brace" };

    socket.emit("submitCommand", { roomCode: room.code, command }, handleAck);
  }

  function leaveRoom() {
    if (!room) {
      return;
    }

    const shouldConfirm =
      room.phase !== "lobby" || Boolean(room.you && playerHasUpgradeProgress(room, room.you));

    if (shouldConfirm) {
      const confirmed = window.confirm(
        "Leave this room? Your salvage credits, ship upgrades, and purchased supplies will be reset. Your games and matches won on this device are saved."
      );

      if (!confirmed) {
        return;
      }
    }

    socket.emit("leaveRoom", { roomCode: room.code }, (response) => {
      leavingRoomRef.current = false;

      if (!response.ok) {
        setError(response.error ?? "Could not leave the room.");
      }
    });
    leavingRoomRef.current = true;
    setRoom(undefined);
    setJoinCode("");
    autoJoinAttemptedKey.current = undefined;
    window.localStorage.removeItem("starfall-room-code");
    window.history.replaceState(null, "", window.location.pathname);
  }

  function toggleWorkSafeMode() {
    setWorkSafeMode((current) => {
      const next = !current;
      window.localStorage.setItem("starfall-work-safe", String(next));
      return next;
    });
  }

  async function enableNotifications() {
    if (!room) {
      return;
    }

    try {
      setNotificationError(undefined);

      if (getInitialNotificationStatus() === "unsupported") {
        setNotificationStatus("unsupported");
        return;
      }

      const permission =
        Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;

      if (permission === "denied") {
        setNotificationStatus("denied");
        return;
      }

      if (permission === "granted") {
        await syncPushSubscription(room.code);
      }
    } catch (error) {
      setNotificationStatus("error");
      setNotificationError(error instanceof Error ? error.message : "Could not enable notifications.");
    }
  }

  async function syncPushSubscription(roomCode: string) {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setNotificationStatus("unsupported");
      return;
    }

    setNotificationStatus("syncing");
    const registration = await navigator.serviceWorker.register("/service-worker.js");
    const { publicKey } = (await fetch(`${socketUrl ?? ""}/api/push/public-key`).then((response) =>
      response.json()
    )) as {
      publicKey: string;
    };
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }

    await savePushSubscription(roomCode, subscription.toJSON());
    setNotificationStatus("enabled");
  }

  function savePushSubscription(roomCode: string, subscription: PushSubscriptionJSON) {
    return new Promise<void>((resolve, reject) => {
      socket.emit("savePushSubscription", { roomCode, subscription }, (response: Ack) => {
        if (response.ok) {
          resolve();
          return;
        }

        reject(new Error(response.error ?? "Server rejected notification setup."));
      });
    });
  }

  return (
    <main className={workSafeMode ? "app-shell work-safe" : "app-shell"}>
      <header className="hero">
        <p className="eyebrow">{workSafeMode ? "Operations Review" : "Starfall Commander"}</p>
        <h1>{workSafeMode ? "Room activity dashboard" : "Turn-based tactical starship combat"}</h1>
        {!room ? (
          <p>
            {workSafeMode
              ? "Create or join a room, coordinate actions, and review recent outcomes."
              : "Create a room, send the code to another captain, and fight by breaching hull, knocking out weapons, shields, engines, sensors, and life support."}
          </p>
        ) : null}
        <button type="button" className="secondary mode-toggle" onClick={toggleWorkSafeMode}>
          {workSafeMode ? "Game view" : "Work-safe view"}
        </button>
        <div className={`connection ${isConnected ? "online" : "offline"}`}>
          {isConnected ? "Connected to command net" : "Reconnecting to command net"}
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {!room ? (
        <section className="landing-layout">
          <div className="panel landing-grid">
            <form onSubmit={createRoom} className="stack">
              <h2>Create a Room</h2>
              <label>
                Captain name
                <input
                  value={playerName}
                  onChange={(event) => setPlayerName(event.target.value)}
                  placeholder="Captain Vale"
                />
              </label>
              <button type="submit">Create room</button>
            </form>

            <form onSubmit={joinRoom} className="stack">
              <h2>Join a Room</h2>
              <label>
                Room code
                <input
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                  placeholder="A"
                />
              </label>
              <label>
                Captain name
                <input
                  value={playerName}
                  onChange={(event) => setPlayerName(event.target.value)}
                  placeholder="Captain Rook"
                />
              </label>
              <button type="submit">Join room</button>
            </form>
          </div>
          <div className="landing-sidebar">
            <PlayerRecord stats={playerStats} />
            <RecentGames games={recentGames} />
          </div>
        </section>
      ) : (
        <div className={room.phase === "finished" ? "game-layout game-layout-postgame" : "game-layout"}>
          <RoomHeader
            room={room}
            onLeave={leaveRoom}
            notificationStatus={notificationStatus}
            notificationError={notificationError}
            onEnableNotifications={enableNotifications}
          />

          {room.phase === "lobby" ? (
            <Lobby room={room} onStart={startGame} onSelectShipClass={selectShipClass} />
          ) : room.phase === "deploy" ? (
            <section className="combat-grid">
              <div className="ship-column">
                {you ? (
                  <ShipPanel
                    title="Your Ship"
                    playerId={you}
                    room={room}
                    interactionHint="Assign crew to each station, then confirm deployment."
                  />
                ) : room.ships.captainA ? (
                  <ShipPanel title="Captain A Ship" playerId="captainA" room={room} spectator />
                ) : null}
                {opponent ? (
                  <ShipPanel
                    title="Enemy Ship"
                    playerId={opponent}
                    room={room}
                    interactionHint="Enemy crew assignments stay hidden until combat."
                    enemy
                  />
                ) : isSpectator && room.ships.captainB ? (
                  <ShipPanel title="Captain B Ship" playerId="captainB" room={room} spectator enemy />
                ) : null}
              </div>

              <DeployPanel
                room={room}
                crewAssignments={crewAssignmentsDraft}
                setCrewAssignments={setCrewAssignmentsDraft}
                onSubmit={submitCrewDeployment}
              />
            </section>
          ) : (
            <section className="combat-grid">
              <div className="ship-column">
                {you ? (
                  <ShipPanel
                    title="Your Ship"
                    playerId={you}
                    room={room}
                    selectedSystem={commandType === "repair" ? repairSystem : undefined}
                    onSelectSystem={
                      !isYourTurn
                        ? undefined
                        : (systemId) => {
                            setCommandType("repair");
                            setRepairSystem(systemId);
                          }
                    }
                    interactionHint="Click one of your rooms to set a repair order."
                  />
                ) : room.ships.captainA ? (
                  <ShipPanel title="Captain A Ship" playerId="captainA" room={room} spectator />
                ) : null}
                {opponent ? (
                  <ShipPanel
                    title="Enemy Ship"
                    playerId={opponent}
                    room={room}
                    selectedSystem={commandType === "fire" ? targetSystem : undefined}
                    onSelectSystem={
                      !isYourTurn
                        ? undefined
                        : (systemId) => {
                            setCommandType("fire");
                            setTargetSystem(systemId);
                          }
                    }
                    interactionHint="Click an enemy room to set a fire order."
                    enemy
                  />
                ) : isSpectator && room.ships.captainB ? (
                  <ShipPanel title="Captain B Ship" playerId="captainB" room={room} spectator enemy />
                ) : null}
              </div>

              <aside
                className={
                  room.phase === "finished"
                    ? "panel command-panel command-panel-postgame"
                    : "panel command-panel"
                }
              >
                <h2>Turn {room.turn}</h2>
                {room.phase === "finished" ? (
                  <VictoryBanner
                    room={room}
                    onRematch={rematch}
                    onPurchaseUpgrade={purchaseUpgrade}
                    onPurchaseConsumable={purchaseConsumable}
                    onRefundUpgrade={refundUpgrade}
                  />
                ) : isSpectator ? (
                  <SpectatorPanel room={room} />
                ) : (
                  <div className="command-panel-combat">
                    <div className="command-panel-scroll">
                      <p className="muted">
                        {isYourTurn
                          ? "Your turn. Choose one action; it resolves immediately."
                          : "Waiting for the other captain. You will see their action resolve here."}
                      </p>
                      <CommandControls
                        commandType={commandType}
                        setCommandType={setCommandType}
                        targetSystem={targetSystem}
                        setTargetSystem={setTargetSystem}
                        repairSystem={repairSystem}
                        setRepairSystem={setRepairSystem}
                        crewAssignments={crewAssignmentsDraft}
                        setCrewAssignments={setCrewAssignmentsDraft}
                        yourShip={yourShip}
                        yourPlayer={room.you ? room.players[room.you] : undefined}
                        disabled={!isYourTurn}
                      />
                    </div>
                    <button
                      type="button"
                      className="command-action"
                      onClick={submitCommand}
                      disabled={!isYourTurn || (commandType === "redeploy" && !redeployReady)}
                    >
                      {!isYourTurn
                        ? "Waiting"
                        : commandType === "redeploy"
                          ? redeployReady
                            ? "Confirm redeploy"
                            : "Adjust crew to redeploy"
                          : "Take action"}
                    </button>
                  </div>
                )}
                <TurnStatus room={room} />
              </aside>
            </section>
          )}

          <BattleLog entries={room.log} />
          <ChatPanel room={room} />
        </div>
      )}
    </main>
  );
}

function RoomHeader({
  room,
  onLeave,
  notificationStatus,
  notificationError,
  onEnableNotifications
}: {
  room: ClientRoomState;
  onLeave: () => void;
  notificationStatus: NotificationStatus;
  notificationError?: string;
  onEnableNotifications: () => void;
}) {
  return (
    <section className="room-header panel">
      <div>
        <p className="eyebrow">Room Code</p>
        <h2>{room.code}</h2>
        <p className="muted">Share this code or the current URL with another player.</p>
      </div>
      <SpectatorList room={room} />
      <div className="room-actions">
        <NotificationControl
          status={notificationStatus}
          error={notificationError}
          onEnable={onEnableNotifications}
        />
        <button type="button" className="secondary" onClick={onLeave}>
          Leave room
        </button>
      </div>
    </section>
  );
}

function SpectatorList({ room }: { room: ClientRoomState }) {
  const spectators = Object.values(room.spectators).filter((spectator) => spectator.connected);

  return (
    <div className="spectator-list">
      <span>Watching</span>
      {spectators.length > 0 ? (
        <strong>{spectators.map((spectator) => spectator.name).join(", ")}</strong>
      ) : (
        <strong>No spectators</strong>
      )}
    </div>
  );
}

function NotificationControl({
  status,
  error,
  onEnable
}: {
  status: NotificationStatus;
  error?: string;
  onEnable: () => void;
}) {
  if (status === "unsupported") {
    return <span className="notification-status muted">Notifications unavailable</span>;
  }

  if (status === "denied") {
    return <span className="notification-status muted">Notifications blocked in browser settings</span>;
  }

  if (status === "enabled") {
    return <span className="notification-status enabled">Notifications enabled</span>;
  }

  if (status === "syncing") {
    return <span className="notification-status muted">Enabling notifications...</span>;
  }

  return (
    <div className="notification-action">
      <button type="button" className="secondary" onClick={onEnable}>
        Enable notifications
      </button>
      {status === "error" ? <small>{error ?? "Could not enable notifications."}</small> : null}
    </div>
  );
}

function PlayerRecord({ stats }: { stats?: PlayerStats }) {
  return (
    <section className="panel player-record">
      <h2>Your Record</h2>
      {!stats ? (
        <p className="muted">Loading captain stats for this device...</p>
      ) : (
        <>
          <p className="muted">Tracked on this browser. Upgrades still reset when you leave a room.</p>
          <div className="record-grid">
            <div className="record-stat">
              <span>Games won</span>
              <strong>
                {stats.gamesWon}/{stats.gamesPlayed}
              </strong>
            </div>
            <div className="record-stat">
              <span>Matches won</span>
              <strong>
                {stats.matchesWon}/{stats.matchesPlayed}
              </strong>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function RecentGames({ games }: { games: RecentGame[] }) {
  return (
    <section className="panel recent-games">
      <h2>Recent Games</h2>
      {games.length === 0 ? (
        <p className="muted">No completed games yet.</p>
      ) : (
        <ul>
          {games.map((game) => (
            <li key={game.id}>
              <strong>{game.winnerName}</strong> beat {game.loserName} in {game.rounds}{" "}
              {game.rounds === 1 ? "round" : "rounds"}.
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Lobby({
  room,
  onStart,
  onSelectShipClass
}: {
  room: ClientRoomState;
  onStart: () => void;
  onSelectShipClass: (shipClassId: ShipClassId) => void;
}) {
  const hasTwoPlayers = PLAYER_IDS.every((id) => room.players[id]?.connected);
  const canStart = hasTwoPlayers && Boolean(room.you);

  return (
    <section className="panel lobby">
      <div>
        <h2>Awaiting Captains</h2>
        <p className="muted">Pick your ship, then begin crew deployment once both captains are connected.</p>
      </div>
      <div className="seat-grid">
        {PLAYER_IDS.map((playerId) => (
          <PlayerSeat key={playerId} room={room} playerId={playerId} />
        ))}
      </div>

      {room.you ? (
        <ShipClassPicker
          selectedClassId={room.players[room.you]?.shipClassId ?? DEFAULT_SHIP_CLASS_ID}
          onSelect={onSelectShipClass}
        />
      ) : (
        <div className="ship-class-grid">
          {PLAYER_IDS.map((playerId) => {
            const player = room.players[playerId];
            const classId = player?.shipClassId ?? DEFAULT_SHIP_CLASS_ID;
            const shipClass = getShipClass(classId);

            return (
              <div key={playerId} className="ship-class-card readonly">
                <span>{playerId === "captainA" ? "Captain A" : "Captain B"}</span>
                <strong>{player?.name ?? "Open seat"}</strong>
                <p>{shipClass.name}</p>
                <small>{formatShipClassSummary(classId)}</small>
              </div>
            );
          })}
        </div>
      )}

      <button onClick={onStart} disabled={!canStart}>
        {canStart ? "Begin crew deployment" : hasTwoPlayers ? "Spectators cannot start deployment" : "Waiting for second captain"}
      </button>
    </section>
  );
}

function DeployPanel({
  room,
  crewAssignments,
  setCrewAssignments,
  onSubmit
}: {
  room: ClientRoomState;
  crewAssignments: Record<SystemId, number>;
  setCrewAssignments: (value: Record<SystemId, number>) => void;
  onSubmit: () => void;
}) {
  const yourShip = room.you ? room.ships[room.you] : undefined;
  const assignedCrew = SYSTEM_DEFINITIONS.reduce(
    (total, system) => total + (crewAssignments[system.id] ?? 0),
    0
  );
  const deploymentReady = Boolean(yourShip && sanitizeCrewAssignments(yourShip, crewAssignments));
  const youConfirmed = Boolean(room.you && room.players[room.you]?.crewDeployed);

  function adjustCrewAssignment(systemId: SystemId, delta: number) {
    if (!yourShip) {
      return;
    }

    const current = crewAssignments[systemId] ?? 0;
    const next = current + delta;

    if (next < 0 || next > MAX_CREW_PER_STATION) {
      return;
    }

    if (delta > 0 && assignedCrew >= yourShip.crewTotal) {
      return;
    }

    setCrewAssignments({
      ...crewAssignments,
      [systemId]: next
    });
  }

  return (
    <aside className="panel command-panel deploy-panel">
      <h2>Deploy Crew</h2>
      <p className="muted">Station your crew before combat. Both captains must confirm to begin.</p>

      <div className="ready-grid">
        {PLAYER_IDS.map((playerId) => {
          const playerName =
            room.players[playerId]?.name ?? (playerId === "captainA" ? "Captain A" : "Captain B");

          return (
            <div
              key={playerId}
              className={room.players[playerId]?.crewDeployed ? "ready-pill ready" : "ready-pill"}
            >
              {playerName}: {room.players[playerId]?.crewDeployed ? "Confirmed" : "Deploying"}
            </div>
          );
        })}
      </div>

      {room.you && yourShip ? (
        <>
          <CrewAssignmentEditor
            ship={yourShip}
            assignments={crewAssignments}
            assignedCrew={assignedCrew}
            onAdjust={adjustCrewAssignment}
            disabled={false}
          />
          <button type="button" onClick={onSubmit} disabled={!deploymentReady}>
            {youConfirmed ? "Update deployment" : "Confirm deployment"}
          </button>
        </>
      ) : (
        <p className="muted">Spectators can watch both captains prepare their crews.</p>
      )}
    </aside>
  );
}

function ShipClassPicker({
  selectedClassId,
  onSelect
}: {
  selectedClassId: ShipClassId;
  onSelect: (shipClassId: ShipClassId) => void;
}) {
  return (
    <div className="ship-class-picker">
      <p className="eyebrow">Choose your ship</p>
      <div className="ship-class-grid">
        {SHIP_CLASSES.map((shipClass) => {
          const isSelected = shipClass.id === selectedClassId;

          return (
            <button
              key={shipClass.id}
              type="button"
              className={isSelected ? "ship-class-card selected" : "ship-class-card"}
              onClick={() => onSelect(shipClass.id)}
            >
              <strong>{shipClass.name}</strong>
              <p>{shipClass.tagline}</p>
              <small>{formatShipClassSummary(shipClass.id)}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SpectatorPanel({ room }: { room: ClientRoomState }) {
  return (
    <div className="spectator-panel">
      <p className="eyebrow">Spectator Mode</p>
      <p className="muted">
        You are watching this battle. Captains take one action at a time, and each action resolves immediately.
      </p>
    </div>
  );
}

function PlayerSeat({ room, playerId }: { room: ClientRoomState; playerId: PlayerId }) {
  const player = room.players[playerId];
  const shipClass = getShipClass(player?.shipClassId ?? DEFAULT_SHIP_CLASS_ID);

  return (
    <div className="seat">
      <span>{playerId === "captainA" ? "Captain A" : "Captain B"}</span>
      <strong>{player?.name ?? "Open seat"}</strong>
      <p className="muted">{player ? shipClass.name : "Waiting for captain"}</p>
      <small className={player?.connected ? "online-text" : "muted"}>
        {player?.connected ? "Connected" : player ? "Disconnected" : "Waiting"}
      </small>
    </div>
  );
}

function ShipPanel({
  title,
  playerId,
  room,
  selectedSystem,
  onSelectSystem,
  interactionHint,
  enemy = false,
  spectator = false
}: {
  title: string;
  playerId: PlayerId;
  room: ClientRoomState;
  selectedSystem?: SystemId;
  onSelectSystem?: (systemId: SystemId) => void;
  interactionHint?: string;
  enemy?: boolean;
  spectator?: boolean;
}) {
  const ship = room.ships[playerId];

  if (!ship) {
    return null;
  }

  const suffocationTurns = getSuffocationTurnsRemaining(ship, room.turn);

  return (
    <section className="panel ship-panel">
      <div className="ship-heading">
        <div>
          <p className="eyebrow">{title}</p>
          <h2>{ship.name}</h2>
          <p className="muted">{getShipClass(ship.classId).tagline}</p>
          <p className="muted">{room.players[playerId]?.name ?? "Unknown captain"}</p>
          {suffocationTurns ? (
            <p className="suffocation-alert">
              Crew suffocating — {suffocationTurns} turn{suffocationTurns === 1 ? "" : "s"} until loss
            </p>
          ) : null}
        </div>
        <div className="ship-heading-stats">
          {!enemy ? (
            <div className="ship-stat">
              <span>Crew</span>
              <strong>
                {getAssignedCrewCount(ship)}/{ship.crewTotal}
              </strong>
            </div>
          ) : null}
          <div className="ship-stat">
            <span>Hull</span>
            <strong>
              {ship.hull}/{ship.maxHull}
            </strong>
          </div>
        </div>
      </div>

      <Meter label="Hull" value={ship.hull} max={ship.maxHull} />
      <Meter label="Shields" value={ship.shield} max={ship.maxShield} />

      <ShipMap
        ship={ship}
        selectedSystem={selectedSystem}
        onSelectSystem={onSelectSystem}
        interactionHint={spectator ? "Spectator view: systems update as captains trade fire." : interactionHint}
        enemy={enemy}
        showCrew={!enemy}
      />

      <div className="systems-list">
        {systemIds.map((systemId) => (
          <SystemRow key={systemId} ship={ship} systemId={systemId} />
        ))}
      </div>
    </section>
  );
}

function ShipMap({
  ship,
  selectedSystem,
  onSelectSystem,
  interactionHint,
  enemy,
  showCrew = true
}: {
  ship: Ship;
  selectedSystem?: SystemId;
  onSelectSystem?: (systemId: SystemId) => void;
  interactionHint?: string;
  enemy: boolean;
  showCrew?: boolean;
}) {
  return (
    <div className={enemy ? "ship-map enemy-map" : "ship-map"}>
      <div className="ship-nose" />
      <div className="ship-engine-glow" />
      {systemIds.map((systemId) => {
        const system = ship.systems[systemId];
        const visual = systemVisuals[systemId];
        const integrity = Math.round((system.hp / system.maxHp) * 100);
        const isSelected = selectedSystem === systemId;
        const isInteractive = Boolean(onSelectSystem);
        const crewCount = getCrewAtStation(ship, systemId);

        return (
          <button
            key={systemId}
            type="button"
            className={`ship-room ${system.hp === 0 ? "offline" : ""} ${isSelected ? "selected" : ""}`}
            style={{ "--integrity": `${integrity}%`, gridArea: visual.gridArea } as CSSProperties}
            title={system.description}
            onClick={() => {
              if (isInteractive) {
                onSelectSystem?.(systemId);
              }
            }}
            aria-disabled={!isInteractive}
          >
            {showCrew && crewCount > 0 ? (
              <span className="crew-pips" aria-label={`${crewCount} crew stationed here`}>
                {Array.from({ length: crewCount }, (_, index) => (
                  <span key={index} className="crew-pip" />
                ))}
              </span>
            ) : null}
            <span>{visual.icon}</span>
            <strong>{system.name}</strong>
            <small>
              {system.hp}/{system.maxHp}
            </small>
          </button>
        );
      })}
      <p className="map-hint">{interactionHint}</p>
    </div>
  );
}

function SystemRow({ ship, systemId }: { ship: Ship; systemId: SystemId }) {
  const system = ship.systems[systemId];
  return (
    <div className={`system-row ${system.hp === 0 ? "offline" : ""}`}>
      <div>
        <strong>{system.name}</strong>
        <small>{system.description}</small>
      </div>
      <Meter label={`${system.hp}/${system.maxHp}`} value={system.hp} max={system.maxHp} compact />
    </div>
  );
}

function Meter({
  label,
  value,
  max,
  compact = false
}: {
  label: string;
  value: number;
  max: number;
  compact?: boolean;
}) {
  const percent = Math.round((value / max) * 100);
  return (
    <div className={compact ? "meter compact" : "meter"}>
      <div className="meter-label">
        <span>{label}</span>
        {!compact ? <span>{percent}%</span> : null}
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function CommandControls({
  commandType,
  setCommandType,
  targetSystem,
  setTargetSystem,
  repairSystem,
  setRepairSystem,
  crewAssignments,
  setCrewAssignments,
  yourShip,
  yourPlayer,
  disabled
}: {
  commandType: CombatCommand["type"];
  setCommandType: (value: CombatCommand["type"]) => void;
  targetSystem: SystemId;
  setTargetSystem: (value: SystemId) => void;
  repairSystem: SystemId;
  setRepairSystem: (value: SystemId) => void;
  crewAssignments: Record<SystemId, number>;
  setCrewAssignments: (value: Record<SystemId, number>) => void;
  yourShip?: Ship;
  yourPlayer?: NonNullable<ClientRoomState["players"][PlayerId]>;
  disabled: boolean;
}) {
  const assignedCrew = SYSTEM_DEFINITIONS.reduce(
    (total, system) => total + (crewAssignments[system.id] ?? 0),
    0
  );
  const suffocating = Boolean(yourShip?.oxygenDeadlineTurn !== undefined && yourShip.hull > 0);
  const shieldBraces = yourPlayer?.shieldBraces ?? 0;
  const breachSeals = yourPlayer?.breachSeals ?? 0;

  function adjustCrewAssignment(systemId: SystemId, delta: number) {
    if (!yourShip) {
      return;
    }

    const current = crewAssignments[systemId] ?? 0;
    const next = current + delta;

    if (next < 0 || next > MAX_CREW_PER_STATION) {
      return;
    }

    if (delta > 0 && assignedCrew >= yourShip.crewTotal) {
      return;
    }

    setCrewAssignments({
      ...crewAssignments,
      [systemId]: next
    });
  }

  return (
    <div className="stack">
      {yourPlayer ? (
        <div className="consumable-stock">
          <span>Shield braces: {shieldBraces}</span>
          <span>Breach seals: {breachSeals}</span>
        </div>
      ) : null}

      <label>
        Command
        <select
          value={commandType}
          onChange={(event) => setCommandType(event.target.value as CombatCommand["type"])}
          disabled={disabled}
        >
          <option value="fire">Fire on a system</option>
          <option value="repair">Repair a system</option>
          <option value="redeploy">Redeploy crew</option>
          <option value="brace">Brace shields</option>
          <option value="jam">Jam enemy sensors</option>
          <option value="evasive">Evasive maneuvers</option>
          <option value="patch">Emergency hull patch</option>
        </select>
      </label>

      {commandType === "fire" ? (
        <SystemSelect
          label="Target enemy system"
          value={targetSystem}
          onChange={setTargetSystem}
          disabled={disabled}
        />
      ) : null}

      {commandType === "fire" && yourShip ? (
        <p className="command-help command-help-crit">
          Critical strike chance: {getCriticalStrikeChance(yourShip)}%
        </p>
      ) : null}

      {commandType === "fire" ? (
        <p className="command-help">
          Accurate weapons fire can land a critical strike for +3 hull and +2 system damage, or a hull puncture
          that vents atmosphere. Sensors raise crit chance; healthy weapons add a little more. Life support loss or
          a puncture gives the crew {SUFFOCATION_TURNS} turns before suffocation.
        </p>
      ) : null}

      {commandType === "repair" ? (
        <SystemSelect
          label="Repair your system"
          value={repairSystem}
          onChange={setRepairSystem}
          disabled={disabled}
        />
      ) : null}

      {commandType === "redeploy" && yourShip ? (
        <CrewAssignmentEditor
          ship={yourShip}
          assignments={crewAssignments}
          assignedCrew={assignedCrew}
          onAdjust={adjustCrewAssignment}
          disabled={disabled}
        />
      ) : null}

      {commandType === "redeploy" ? (
        <p className="command-help">
          Reassign crew between stations. Uses your turn. Crew still performs upkeep before the redeploy resolves.
        </p>
      ) : null}

      {commandType === "repair" ? (
        <p className="command-help">
          Restores system health only. Repairing life support stops suffocation. Works on offline systems, but crew
          stationed there are lost permanently when a room goes to 0.
        </p>
      ) : null}

      {commandType === "jam" ? (
        <p className="command-help">
          Damages enemy Sensors before firing resolves. Lower enemy sensors make their future shots less accurate.
        </p>
      ) : null}

      {commandType === "evasive" ? (
        <p className="command-help">
          Improves Engines and adds a small shield boost. Better engines make incoming shots harder to land.
        </p>
      ) : null}

      {commandType === "brace" ? (
        <p className="command-help">
          Spends 1 shield brace charge to reinforce shields. Buy more in the post-battle shop.
          {shieldBraces <= 0 ? " You are out of brace charges." : ""}
        </p>
      ) : null}

      {commandType === "patch" ? (
        <p className="command-help">
          Restores 3 hull directly. If the crew is suffocating, spends 1 breach seal kit to stop atmosphere loss.
          Buy more in the post-battle shop.
          {suffocating && breachSeals <= 0 ? " You are out of breach seal kits." : ""}
        </p>
      ) : null}
    </div>
  );
}

function CrewAssignmentEditor({
  ship,
  assignments,
  assignedCrew,
  onAdjust,
  disabled
}: {
  ship: Ship;
  assignments: Record<SystemId, number>;
  assignedCrew: number;
  onAdjust: (systemId: SystemId, delta: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="crew-assignment-editor">
      <div className="crew-assignment-header">
        <span className="eyebrow">Crew stations</span>
        <strong>
          {assignedCrew}/{ship.crewTotal}
        </strong>
      </div>
      {SYSTEM_DEFINITIONS.map((system) => {
        const count = assignments[system.id] ?? 0;

        return (
          <div key={system.id} className="crew-assignment-row">
            <span>{system.name}</span>
            <div className="crew-assignment-controls">
              <button
                type="button"
                className="secondary crew-stepper"
                disabled={disabled || count <= 0}
                onClick={() => onAdjust(system.id, -1)}
              >
                -
              </button>
              <strong>{count}</strong>
              <button
                type="button"
                className="secondary crew-stepper"
                disabled={disabled || assignedCrew >= ship.crewTotal || count >= MAX_CREW_PER_STATION}
                onClick={() => onAdjust(system.id, 1)}
              >
                +
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SystemSelect({
  label,
  value,
  onChange,
  disabled
}: {
  label: string;
  value: SystemId;
  onChange: (value: SystemId) => void;
  disabled: boolean;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value as SystemId)} disabled={disabled}>
        {SYSTEM_DEFINITIONS.map((system) => (
          <option key={system.id} value={system.id}>
            {system.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function TurnStatus({ room }: { room: ClientRoomState }) {
  return (
    <div className="ready-grid">
      {PLAYER_IDS.map((playerId) => {
        const playerName =
          room.players[playerId]?.name ?? (playerId === "captainA" ? "Captain A" : "Captain B");

        return (
          <div key={playerId} className={room.activePlayer === playerId ? "ready-pill ready" : "ready-pill"}>
            {playerName}:{" "}
            {room.phase === "finished"
              ? "Done"
              : room.activePlayer === playerId
                ? "Acting"
                : "Waiting"}
          </div>
        );
      })}
    </div>
  );
}

function VictoryBanner({
  room,
  onRematch,
  onPurchaseUpgrade,
  onPurchaseConsumable,
  onRefundUpgrade
}: {
  room: ClientRoomState;
  onRematch: () => void;
  onPurchaseUpgrade: (systemId: SystemId) => void;
  onPurchaseConsumable: (consumableId: ConsumableId) => void;
  onRefundUpgrade: (systemId: SystemId) => void;
}) {
  const yourPlayer = room.you ? room.players[room.you] : undefined;
  const opponentId = room.you ? (room.you === "captainA" ? "captainB" : "captainA") : undefined;
  const opponentPlayer = opponentId ? room.players[opponentId] : undefined;
  const shopLocked = Boolean(yourPlayer?.rematchReady);

  function renderShop() {
    if (!yourPlayer) {
      return null;
    }

    return (
      <>
        <div className="upgrade-shop-scroll">
          <UpgradeShop
            player={yourPlayer}
            shopLocked={shopLocked}
            onPurchaseUpgrade={onPurchaseUpgrade}
            onPurchaseConsumable={onPurchaseConsumable}
            onRefundUpgrade={onRefundUpgrade}
          />
        </div>
        {yourPlayer.rematchReady ? (
          <p className="muted rematch-status">
            {opponentPlayer?.rematchReady
              ? "Both captains ready. Deploying for the next battle..."
              : "Ready for the next battle. Waiting for the other captain to finish shopping."}
          </p>
        ) : (
          <button type="button" className="victory-action" onClick={onRematch}>
            Done shopping
          </button>
        )}
      </>
    );
  }

  if (!room.winner) {
    return (
      <div className="victory victory-postgame">
        <div className="victory-summary">
          <p className="muted">Both ships are disabled. The sector claims another pair of wrecks.</p>
        </div>
        {yourPlayer ? renderShop() : <p className="muted">Waiting for a captain to start a rematch.</p>}
      </div>
    );
  }

  const winnerName = room.players[room.winner]?.name ?? room.winner;
  const isYou = room.winner === room.you;

  return (
    <div className="victory victory-postgame">
      <div className="victory-summary">
        <h3>{isYou ? "Victory" : "Defeat"}</h3>
        <p>{winnerName} controls the field. Spend salvage credits on system upgrades before the next sortie.</p>
      </div>
      {yourPlayer ? renderShop() : <p className="muted">Waiting for a captain to start a rematch.</p>}
    </div>
  );
}

function UpgradeShop({
  player,
  shopLocked = false,
  onPurchaseUpgrade,
  onPurchaseConsumable,
  onRefundUpgrade
}: {
  player: NonNullable<ClientRoomState["players"][PlayerId]>;
  shopLocked?: boolean;
  onPurchaseUpgrade: (systemId: SystemId) => void;
  onPurchaseConsumable: (consumableId: ConsumableId) => void;
  onRefundUpgrade: (systemId: SystemId) => void;
}) {
  return (
    <div className="upgrade-shop">
      <div className="upgrade-shop-header">
        <p className="eyebrow">Salvage credits</p>
        <strong className="credit-balance">{player.credits}</strong>
      </div>

      <div className="consumable-shop">
        <p className="eyebrow">Supplies</p>
        <div className="upgrade-grid">
          {CONSUMABLES.map((item) => {
            const stock = item.id === "shieldBrace" ? player.shieldBraces : player.breachSeals;
            const canBuy = canPurchaseConsumable(player, item.id);

            return (
              <div key={item.id} className="upgrade-row consumable-row">
                <div>
                  <strong>{item.name}</strong>
                  <p className="muted">
                    {item.description} Stock: {stock}/{MAX_CONSUMABLE_STOCK}
                  </p>
                </div>
                <button type="button" disabled={!canBuy || shopLocked} onClick={() => onPurchaseConsumable(item.id)}>
                  Buy ({item.cost})
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <p className="muted">Upgrade ship systems to level {MAX_UPGRADE_LEVEL}. Each level adds +1 max HP.</p>
      <div className="upgrade-grid">
        {SYSTEM_DEFINITIONS.map((system) => {
          const level = player.systemUpgrades[system.id] ?? 1;
          const cost = getUpgradeCost(level);
          const refund = getUpgradeRefund(level);
          const canAfford = cost !== undefined && player.credits >= cost;

          return (
            <div key={system.id} className="upgrade-row">
              <div>
                <strong>{system.name}</strong>
                <p className="muted">
                  Level {level}
                  {level > 1 ? ` (+${getUpgradeHpBonus(level)} HP)` : ""}
                </p>
              </div>
              <div className="upgrade-levels" aria-label={`${system.name} level ${level}`}>
                {Array.from({ length: MAX_UPGRADE_LEVEL }, (_, index) => (
                  <span
                    key={index}
                    className={index < level ? "upgrade-pip active" : "upgrade-pip"}
                  />
                ))}
              </div>
              <div className="upgrade-actions">
                {refund !== undefined ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={shopLocked}
                    onClick={() => onRefundUpgrade(system.id)}
                  >
                    Refund ({refund})
                  </button>
                ) : null}
                {cost !== undefined ? (
                  <button type="button" disabled={!canAfford || shopLocked} onClick={() => onPurchaseUpgrade(system.id)}>
                    Upgrade ({cost})
                  </button>
                ) : (
                  <span className="upgrade-max">Max</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BattleLog({ entries }: { entries: string[] }) {
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }

    list.scrollTop = 0;
  }, [entries.length, entries[entries.length - 1]]);

  return (
    <section className="panel battle-log">
      <h2>Battle Log</h2>
      <ol ref={listRef}>
        {entries
          .slice()
          .reverse()
          .map((entry, index) => (
            <li
              key={`${entry}-${index}`}
              className={
                entry.includes(BATTLE_END_LOG_MARKER)
                  ? "battle-end"
                  : entry.includes(CRITICAL_STRIKE_LOG_MARKER) || entry.includes(HULL_PUNCTURE_LOG_MARKER)
                    ? "critical"
                    : entry.includes("suffocat")
                      ? "suffocation"
                      : undefined
              }
            >
              {entry}
            </li>
          ))}
      </ol>
    </section>
  );
}

function formatChatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function ChatPanel({ room }: { room: ClientRoomState }) {
  const [message, setMessage] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, [room.chat]);

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();

    if (!text) {
      return;
    }

    socket.emit("sendChat", { roomCode: room.code, text }, (response) => {
      if (response.ok) {
        setMessage("");
      }
    });
  }

  return (
    <section className="panel chat-panel">
      <h2>Comms</h2>
      <div className="chat-messages" ref={messagesRef}>
        {room.chat.length === 0 ? (
          <p className="muted">No messages yet.</p>
        ) : (
          room.chat.slice(-8).map((chatMessage) => (
            <div key={chatMessage.id} className="chat-message">
              <div className="chat-message-meta">
                <strong>{chatMessage.author}</strong>
                {chatMessage.createdAt ? (
                  <time dateTime={new Date(chatMessage.createdAt).toISOString()}>
                    {formatChatTimestamp(chatMessage.createdAt)}
                  </time>
                ) : null}
              </div>
              <span>{chatMessage.text}</span>
            </div>
          ))
        )}
      </div>
      <form onSubmit={sendMessage} className="chat-form">
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Send a quick message"
          maxLength={280}
        />
        <button type="submit">Send</button>
      </form>
    </section>
  );
}

function getInitialNotificationStatus(): NotificationStatus {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "unsupported";
  }

  if (Notification.permission === "granted") {
    return "enabled";
  }

  if (Notification.permission === "denied") {
    return "denied";
  }

  return "default";
}

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`.replaceAll("-", "+").replaceAll("_", "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }

  return outputArray.buffer;
}
