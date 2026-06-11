import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { io, Socket } from "socket.io-client";
import {
  ClientRoomState,
  CombatCommand,
  DivertTarget,
  PLAYER_IDS,
  PlayerId,
  Ship,
  SYSTEM_DEFINITIONS,
  SystemId
} from "../../shared/game";

interface Ack {
  ok: boolean;
  error?: string;
  roomCode?: string;
}

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface ServerToClientEvents {
  roomState: (state: ClientRoomState) => void;
}

interface ClientToServerEvents {
  createRoom: (payload: { playerName: string }, ack: (response: Ack) => void) => void;
  joinRoom: (payload: { roomCode: string; playerName: string }, ack: (response: Ack) => void) => void;
  startGame: (payload: { roomCode: string }, ack: (response: Ack) => void) => void;
  submitCommand: (
    payload: { roomCode: string; command: CombatCommand },
    ack: (response: Ack) => void
  ) => void;
  savePushSubscription: (
    payload: { roomCode: string; subscription: PushSubscriptionJSON },
    ack: (response: Ack) => void
  ) => void;
  leaveRoom: (payload: { roomCode: string }, ack: (response: Ack) => void) => void;
}

type NotificationStatus = "unsupported" | "default" | "denied" | "syncing" | "enabled" | "error";

const socketUrl =
  import.meta.env.VITE_SOCKET_URL ??
  (import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:3001` : undefined);

const systemIds = SYSTEM_DEFINITIONS.map((system) => system.id);
const socket: ClientSocket = io(socketUrl);
const systemVisuals: Record<SystemId, { gridArea: string; icon: string }> = {
  reactor: { gridArea: "reactor", icon: "Core" },
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
  const [joinCode, setJoinCode] = useState(() => new URLSearchParams(window.location.search).get("room") ?? "");
  const [error, setError] = useState<string>();
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [commandType, setCommandType] = useState<CombatCommand["type"]>("fire");
  const [targetSystem, setTargetSystem] = useState<SystemId>("reactor");
  const [repairSystem, setRepairSystem] = useState<SystemId>("reactor");
  const [divertTarget, setDivertTarget] = useState<DivertTarget>("shields");
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>(getInitialNotificationStatus);
  const [notificationError, setNotificationError] = useState<string>();
  const lastSyncedNotificationKey = useRef<string | undefined>(undefined);

  useEffect(() => {
    function handleConnect() {
      setIsConnected(true);
      setError(undefined);
    }

    function handleDisconnect() {
      setIsConnected(false);
    }

    function handleConnectError(error: Error) {
      setIsConnected(false);
      setError(`Could not reach the game server at ${socketUrl ?? window.location.origin}: ${error.message}`);
    }

    function handleRoomState(nextRoom: ClientRoomState) {
      setRoom(nextRoom);
      setJoinCode(nextRoom.code);
      window.history.replaceState(null, "", `?room=${nextRoom.code}`);
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("roomState", handleRoomState);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("roomState", handleRoomState);
    };
  }, []);

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
  const youLockedIn = you ? room?.lockedIn[you] : false;

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
    }
  }

  function createRoom(event: FormEvent) {
    event.preventDefault();
    socket.emit("createRoom", { playerName: rememberName() }, handleAck);
  }

  function joinRoom(event: FormEvent) {
    event.preventDefault();
    socket.emit("joinRoom", { roomCode: joinCode, playerName: rememberName() }, handleAck);
  }

  function startGame() {
    if (!room || !room.you) {
      return;
    }

    socket.emit("startGame", { roomCode: room.code }, handleAck);
  }

  function submitCommand() {
    if (!room) {
      return;
    }

    const command: CombatCommand =
      commandType === "fire"
        ? { type: "fire", targetSystem }
        : commandType === "repair"
          ? { type: "repair", repairSystem }
          : commandType === "divert"
            ? { type: "divert", divertTarget }
            : { type: "brace" };

    socket.emit("submitCommand", { roomCode: room.code, command }, handleAck);
  }

  function leaveRoom() {
    if (!room) {
      return;
    }

    socket.emit("leaveRoom", { roomCode: room.code }, handleAck);
    setRoom(undefined);
    window.history.replaceState(null, "", window.location.pathname);
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
    <main className="app-shell">
      <header className="hero">
        <p className="eyebrow">Starfall Commander</p>
        <h1>Turn-based tactical starship combat</h1>
        <p>
          Create a room, send the code to another captain, and fight by disabling reactors, weapons,
          shields, engines, sensors, and life support.
        </p>
        <div className={`connection ${isConnected ? "online" : "offline"}`}>
          {isConnected ? "Connected to command net" : "Reconnecting to command net"}
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {!room ? (
        <section className="panel landing-grid">
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
                placeholder="A7K9Q"
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
        </section>
      ) : (
        <div className="game-layout">
          <RoomHeader
            room={room}
            onLeave={leaveRoom}
            notificationStatus={notificationStatus}
            notificationError={notificationError}
            onEnableNotifications={enableNotifications}
          />

          {room.phase === "lobby" ? (
            <Lobby room={room} onStart={startGame} />
          ) : (
            <section className="combat-grid">
              <div className="ship-column">
                {you ? (
                  <ShipPanel
                    title="Your Ship"
                    playerId={you}
                    room={room}
                    selectedSystem={commandType === "repair" ? repairSystem : undefined}
                    onSelectSystem={commandType === "repair" ? setRepairSystem : undefined}
                    interactionHint="Switch to repair, then click one of your rooms."
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
                    onSelectSystem={commandType === "fire" ? setTargetSystem : undefined}
                    interactionHint="Switch to fire, then click an enemy room to target it."
                    enemy
                  />
                ) : isSpectator && room.ships.captainB ? (
                  <ShipPanel title="Captain B Ship" playerId="captainB" room={room} spectator enemy />
                ) : null}
              </div>

              <aside className="panel command-panel">
                <h2>Turn {room.turn}</h2>
                {room.phase === "finished" ? (
                  <VictoryBanner room={room} />
                ) : isSpectator ? (
                  <SpectatorPanel room={room} />
                ) : (
                  <>
                    <p className="muted">
                      {youLockedIn
                        ? "Orders locked. Waiting for the other captain."
                        : "Choose one command, then lock in. Turns resolve when both captains are ready."}
                    </p>
                    <CommandControls
                      commandType={commandType}
                      setCommandType={setCommandType}
                      targetSystem={targetSystem}
                      setTargetSystem={setTargetSystem}
                      repairSystem={repairSystem}
                      setRepairSystem={setRepairSystem}
                      divertTarget={divertTarget}
                      setDivertTarget={setDivertTarget}
                      disabled={Boolean(youLockedIn)}
                    />
                    <button onClick={submitCommand} disabled={Boolean(youLockedIn)}>
                      {youLockedIn ? "Orders locked" : "Lock in orders"}
                    </button>
                  </>
                )}
                <ReadyStatus room={room} />
              </aside>
            </section>
          )}

          <BattleLog entries={room.log} />
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
    return <span className="notification-status enabled">Turn notifications on</span>;
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

function Lobby({ room, onStart }: { room: ClientRoomState; onStart: () => void }) {
  const hasTwoPlayers = PLAYER_IDS.every((id) => room.players[id]?.connected);
  const canStart = hasTwoPlayers && Boolean(room.you);

  return (
    <section className="panel lobby">
      <div>
        <h2>Awaiting Captains</h2>
        <p className="muted">Both seats must be connected before combat can begin.</p>
      </div>
      <div className="seat-grid">
        {PLAYER_IDS.map((playerId) => (
          <PlayerSeat key={playerId} room={room} playerId={playerId} />
        ))}
      </div>
      <button onClick={onStart} disabled={!canStart}>
        {canStart ? "Start combat" : hasTwoPlayers ? "Spectators cannot start combat" : "Waiting for second captain"}
      </button>
    </section>
  );
}

function SpectatorPanel({ room }: { room: ClientRoomState }) {
  return (
    <div className="spectator-panel">
      <p className="eyebrow">Spectator Mode</p>
      <p className="muted">
        You are watching this battle. Captains lock in orders, and turns resolve when both are ready.
      </p>
    </div>
  );
}

function PlayerSeat({ room, playerId }: { room: ClientRoomState; playerId: PlayerId }) {
  const player = room.players[playerId];
  return (
    <div className="seat">
      <span>{playerId === "captainA" ? "Captain A" : "Captain B"}</span>
      <strong>{player?.name ?? "Open seat"}</strong>
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

  return (
    <section className="panel ship-panel">
      <div className="ship-heading">
        <div>
          <p className="eyebrow">{title}</p>
          <h2>{ship.name}</h2>
          <p className="muted">{room.players[playerId]?.name ?? "Unknown captain"}</p>
        </div>
        <div className="ship-stat">
          <span>Hull</span>
          <strong>
            {ship.hull}/{ship.maxHull}
          </strong>
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
  enemy
}: {
  ship: Ship;
  selectedSystem?: SystemId;
  onSelectSystem?: (systemId: SystemId) => void;
  interactionHint?: string;
  enemy: boolean;
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

        return (
          <button
            key={systemId}
            type="button"
            className={`ship-room ${system.hp === 0 ? "offline" : ""} ${isSelected ? "selected" : ""}`}
            style={{ "--integrity": `${integrity}%`, gridArea: visual.gridArea } as CSSProperties}
            onClick={() => {
              if (isInteractive) {
                onSelectSystem?.(systemId);
              }
            }}
            aria-disabled={!isInteractive}
          >
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
  divertTarget,
  setDivertTarget,
  disabled
}: {
  commandType: CombatCommand["type"];
  setCommandType: (value: CombatCommand["type"]) => void;
  targetSystem: SystemId;
  setTargetSystem: (value: SystemId) => void;
  repairSystem: SystemId;
  setRepairSystem: (value: SystemId) => void;
  divertTarget: DivertTarget;
  setDivertTarget: (value: DivertTarget) => void;
  disabled: boolean;
}) {
  return (
    <div className="stack">
      <label>
        Command
        <select
          value={commandType}
          onChange={(event) => setCommandType(event.target.value as CombatCommand["type"])}
          disabled={disabled}
        >
          <option value="fire">Fire on a system</option>
          <option value="repair">Repair a system</option>
          <option value="brace">Brace shields</option>
          <option value="divert">Divert reactor power</option>
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

      {commandType === "repair" ? (
        <SystemSelect
          label="Repair your system"
          value={repairSystem}
          onChange={setRepairSystem}
          disabled={disabled}
        />
      ) : null}

      {commandType === "divert" ? (
        <label>
          Power target
          <select
            value={divertTarget}
            onChange={(event) => setDivertTarget(event.target.value as DivertTarget)}
            disabled={disabled}
          >
            <option value="shields">Shields</option>
            <option value="engines">Engines</option>
            <option value="weapons">Weapons</option>
          </select>
        </label>
      ) : null}
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

function ReadyStatus({ room }: { room: ClientRoomState }) {
  return (
    <div className="ready-grid">
      {PLAYER_IDS.map((playerId) => (
        <div key={playerId} className={room.lockedIn[playerId] ? "ready-pill ready" : "ready-pill"}>
          {playerId === "captainA" ? "Captain A" : "Captain B"}:{" "}
          {room.lockedIn[playerId] ? "Orders locked" : "Choosing"}
        </div>
      ))}
    </div>
  );
}

function VictoryBanner({ room }: { room: ClientRoomState }) {
  if (!room.winner) {
    return <p className="muted">Both ships are disabled. The sector claims another pair of wrecks.</p>;
  }

  const winnerName = room.players[room.winner]?.name ?? room.winner;
  const isYou = room.winner === room.you;

  return (
    <div className="victory">
      <h3>{isYou ? "Victory" : "Defeat"}</h3>
      <p>{winnerName} controls the field. The losing ship can be salvaged, ransomed, or stripped later.</p>
    </div>
  );
}

function BattleLog({ entries }: { entries: string[] }) {
  return (
    <section className="panel battle-log">
      <h2>Battle Log</h2>
      <ol>
        {entries
          .slice()
          .reverse()
          .map((entry, index) => (
            <li key={`${entry}-${index}`}>{entry}</li>
          ))}
      </ol>
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
