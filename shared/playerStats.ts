import { PlayerId, RoomState } from "./game";

export interface PlayerStats {
  deviceId: string;
  gamesPlayed: number;
  gamesWon: number;
  matchesPlayed: number;
  matchesWon: number;
  lastName?: string;
  updatedAt: number;
}

export interface SessionMatchResult {
  winnerDeviceId: string;
  loserDeviceId: string;
  winnerName: string;
  loserName: string;
}

const DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidDeviceId(value: string): boolean {
  return DEVICE_ID_PATTERN.test(value);
}

export function createEmptyPlayerStats(deviceId: string, lastName?: string): PlayerStats {
  return {
    deviceId,
    gamesPlayed: 0,
    gamesWon: 0,
    matchesPlayed: 0,
    matchesWon: 0,
    lastName,
    updatedAt: Date.now()
  };
}

export function recordSessionGameWin(room: RoomState, winnerId: PlayerId): RoomState {
  return {
    ...room,
    sessionGameWins: {
      ...room.sessionGameWins,
      [winnerId]: (room.sessionGameWins?.[winnerId] ?? 0) + 1
    }
  };
}

export function finalizeSessionMatch(room: RoomState): {
  room: RoomState;
  matchResult?: SessionMatchResult;
} {
  const winsA = room.sessionGameWins?.captainA ?? 0;
  const winsB = room.sessionGameWins?.captainB ?? 0;

  if (winsA + winsB === 0) {
    return { room };
  }

  const playerA = room.players.captainA;
  const playerB = room.players.captainB;
  const nextRoom: RoomState = {
    ...room,
    sessionGameWins: {}
  };

  if (!playerA?.deviceId || !playerB?.deviceId) {
    return { room: nextRoom };
  }

  if (winsA === winsB) {
    return { room: nextRoom };
  }

  const winnerId: PlayerId = winsA > winsB ? "captainA" : "captainB";
  const loserId = winnerId === "captainA" ? "captainB" : "captainA";
  const winner = room.players[winnerId];
  const loser = room.players[loserId];

  if (!winner?.deviceId || !loser?.deviceId) {
    return { room: nextRoom };
  }

  return {
    room: nextRoom,
    matchResult: {
      winnerDeviceId: winner.deviceId,
      loserDeviceId: loser.deviceId,
      winnerName: winner.name,
      loserName: loser.name
    }
  };
}
