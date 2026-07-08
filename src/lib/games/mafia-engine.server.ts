/** Pure mafia night/day resolution — no Telegram deps. */

export type MafiaRole =
  | "citizen"
  | "commissar"
  | "doctor"
  | "putana"
  | "bodyguard"
  | "kamikaze"
  | "don"
  | "mafia"
  | "maniac";

export type NightActionType = "kill" | "heal" | "block" | "check" | "protect";

export interface MafiaPlayer {
  id: number;
  name: string;
  role: MafiaRole;
  alive: boolean;
  maniacShield?: boolean;
  wasDon?: boolean;
}

export interface NightAction {
  userId: number;
  type: NightActionType;
  targetId: number;
  at: number;
}

export interface NightInput {
  players: MafiaPlayer[];
  actions: NightAction[];
  /** Resolved mafia kill target after AFK rules (null = no shot). */
  mafiaTargetId: number | null;
  mafiaAttackerIds: number[];
}

export interface NightDeath {
  userId: number;
  reason: "mafia" | "maniac" | "commissar" | "kamikaze_revenge" | "bodyguard";
  attackers?: number[];
}

export interface NightResult {
  players: MafiaPlayer[];
  deaths: NightDeath[];
  /** Public morning lines (only events that should appear in group chat). */
  morningLines: string[];
  /** Private DM results: userId -> message */
  privateChecks: Record<number, string>;
  mafiaFailedKill: boolean;
}

export interface WinResult {
  winner: "town" | "mafia" | "maniac" | "draw" | null;
}

export const ROLE_LABEL: Record<MafiaRole, string> = {
  citizen: "Мирный житель",
  commissar: "Комиссар",
  doctor: "Доктор",
  putana: "Путана",
  bodyguard: "Телохранитель",
  kamikaze: "Камикадзе",
  don: "Дон Мафии",
  mafia: "Мафиози",
  maniac: "Маньяк",
};

export function isMafiaRole(role: MafiaRole): boolean {
  return role === "don" || role === "mafia";
}

export function isEvilRole(role: MafiaRole): boolean {
  return isMafiaRole(role) || role === "maniac";
}

export function playerById(players: MafiaPlayer[], id: number): MafiaPlayer | undefined {
  return players.find((p) => p.id === id);
}

/** Mafia night target: Don choice wins if both voted; lone voter's choice if other AFK; null if both AFK. */
export function resolveMafiaNightTarget(
  players: MafiaPlayer[],
  mafiaVotes: Record<string, number>,
): { targetId: number | null; attackerIds: number[] } {
  const alive = players.filter((p) => p.alive);
  const don = alive.find((p) => p.role === "don");
  const mafiosi = alive.filter((p) => p.role === "mafia");
  const donVote = don ? mafiaVotes[String(don.id)] : undefined;
  const mafiaVote = mafiosi.map((m) => mafiaVotes[String(m.id)]).find((v) => v !== undefined);

  if (donVote !== undefined) {
    const attackers = [don!.id, ...mafiosi.map((m) => m.id).filter((id) => mafiaVotes[String(id)] === donVote)];
    return { targetId: donVote, attackerIds: [...new Set(attackers)] };
  }
  if (mafiaVote !== undefined) {
    const voters = mafiosi.filter((m) => mafiaVotes[String(m.id)] === mafiaVote).map((m) => m.id);
    return { targetId: mafiaVote, attackerIds: voters.length ? voters : mafiosi.map((m) => m.id) };
  }
  return { targetId: null, attackerIds: [] };
}

export function resolveNight(input: NightInput): NightResult {
  const players = input.players.map((p) => ({ ...p }));
  const byId = (id: number) => playerById(players, id);

  const blocked = new Set<number>();
  const protectedByPutana = new Set<number>();
  const protectedByDoctor = new Set<number>();
  let bodyguardTarget: number | null = null;
  let bodyguardId: number | null = null;

  const sortedActions = [...input.actions].sort((a, b) => a.at - b.at);

  // 1. Putana — first block wins on putana-vs-putana
  for (const act of sortedActions) {
    const actor = byId(act.userId);
    if (!actor?.alive || actor.role !== "putana" || act.type !== "block") continue;
    if (blocked.has(actor.id)) continue;
    blocked.add(act.targetId);
    protectedByPutana.add(act.targetId);
  }

  // 2. Doctor & bodyguard
  for (const act of sortedActions) {
    const actor = byId(act.userId);
    if (!actor?.alive || blocked.has(actor.id)) continue;
    if (act.type === "heal" && actor.role === "doctor") {
      protectedByDoctor.add(act.targetId);
    }
    if (act.type === "protect" && actor.role === "bodyguard") {
      bodyguardTarget = act.targetId;
      bodyguardId = actor.id;
    }
  }

  // 3. Collect attacks
  const attacks = new Map<number, number[]>();

  if (input.mafiaTargetId) {
    attacks.set(input.mafiaTargetId, [...(attacks.get(input.mafiaTargetId) ?? []), ...input.mafiaAttackerIds]);
  }

  for (const act of sortedActions) {
    const actor = byId(act.userId);
    if (!actor?.alive || blocked.has(actor.id) || act.type !== "kill") continue;
    if (actor.role === "maniac" || actor.role === "commissar") {
      const list = attacks.get(act.targetId) ?? [];
      list.push(actor.id);
      attacks.set(act.targetId, list);
    }
  }

  const deaths: NightDeath[] = [];
  const morningLines: string[] = [];
  const privateChecks: Record<number, string> = {};
  let mafiaFailedKill = false;
  const deadTonight = new Set<number>();

  const markDead = (id: number, reason: NightDeath["reason"], attackers?: number[]) => {
    if (deadTonight.has(id)) return;
    const p = byId(id);
    if (!p?.alive) return;
    p.alive = false;
    deadTonight.add(id);
    deaths.push({ userId: id, reason, attackers });
  };

  for (const [targetId, attackerIds] of attacks) {
    const target = byId(targetId);
    if (!target?.alive) continue;

    if (protectedByPutana.has(targetId)) continue;

    if (protectedByDoctor.has(targetId)) {
      morningLines.push(
        `🚑 На <b>${target.name}</b> было совершено нападение, но Доктор спас его!`,
      );
      continue;
    }

    if (target.role === "maniac" && target.maniacShield) {
      const onlyMafia = attackerIds.every((aid) => {
        const a = byId(aid);
        return a && isMafiaRole(a.role);
      });
      if (onlyMafia && attackerIds.length > 0) {
        target.maniacShield = false;
        mafiaFailedKill = true;
        continue;
      }
    }

    if (bodyguardTarget === targetId && bodyguardId && byId(bodyguardId)?.alive) {
      const bg = byId(bodyguardId)!;
      markDead(bodyguardId, "bodyguard");
      morningLines.push(
        `💀 <b>${bg.name} (Телохранитель)</b> — героически погиб, защищая свою цель.`,
      );
      continue;
    }

    markDead(targetId, attackerIds.some((a) => byId(a)?.role === "commissar") ? "commissar" : attackerIds.some((a) => byId(a)?.role === "maniac") ? "maniac" : "mafia", attackerIds);

    if (target.role === "kamikaze") {
      morningLines.push(
        `💀 <b>${target.name} (Камикадзе)</b> — был убит, но активировал пояс смертника!`,
      );
      for (const aid of attackerIds) {
        const atk = byId(aid);
        if (atk?.alive) {
          markDead(aid, "kamikaze_revenge", [targetId]);
          morningLines.push(`🔥 В огне взрыва погиб: <b>${atk.name} (${ROLE_LABEL[atk.role]})</b>!`);
        }
      }
    } else {
      const killers = new Set(attackerIds.map((a) => byId(a)?.role).filter(Boolean));
      if (killers.has("commissar")) {
        morningLines.push(
          `💀 <b>${target.name} (${ROLE_LABEL[target.role]})</b> — ликвидирован точным выстрелом правосудия.`,
        );
      } else if (killers.has("maniac")) {
        morningLines.push(
          `💀 <b>${target.name} (${ROLE_LABEL[target.role]})</b> — ночью в его дом ворвался Маньяк.`,
        );
      } else {
        morningLines.push(
          `💀 <b>${target.name} (${ROLE_LABEL[target.role]})</b> — найден мёртвым. Мафия оставляет кровавые следы.`,
        );
      }
    }
  }

  // Private checks (DM only)
  for (const act of sortedActions) {
    const actor = byId(act.userId);
    if (!actor?.alive || blocked.has(actor.id) || act.type !== "check") continue;
    const checkTarget = byId(act.targetId);
    if (!checkTarget) continue;
    if (actor.role === "commissar") {
      const status = isMafiaRole(checkTarget.role) ? "Мафия" : "Мирный";
      privateChecks[actor.id] = `${checkTarget.name}: ${status}`;
    } else if (actor.role === "don") {
      const status =
        checkTarget.role === "commissar" ? "Это Комиссар!" : "Это не Комиссар.";
      privateChecks[actor.id] = `${checkTarget.name}: ${status}`;
    }
  }

  // Promote mafia to don if don died
  const donAlive = players.some((p) => p.alive && p.role === "don");
  if (!donAlive) {
    const promoted = players.find((p) => p.alive && p.role === "mafia");
    if (promoted) promoted.role = "don";
  }

  return { players, deaths, morningLines, privateChecks, mafiaFailedKill };
}

export function formatMorningReport(lines: string[]): string {
  if (!lines.length) {
    return "🔔 <b>Утро в городе!</b>\n✨ Никто не умер. Все граждане живы.";
  }
  return `🔔 <b>Утро в городе! Итоги прошедшей ночи:</b>\n${lines.join("\n")}\n\nОбсуждение открыто!`;
}

export function checkWin(players: MafiaPlayer[]): WinResult {
  const alive = players.filter((p) => p.alive);
  if (alive.length === 0) return { winner: "draw" };

  const mafia = alive.filter((p) => isMafiaRole(p.role));
  const maniac = alive.find((p) => p.role === "maniac");

  if (mafia.length === 0 && !maniac) return { winner: "town" };

  if (maniac && alive.length <= 2) return { winner: "maniac" };

  if (!maniac && mafia.length > 0 && mafia.length >= alive.length - mafia.length) {
    return { winner: "mafia" };
  }

  return { winner: null };
}

/** Role distribution by player count (6–12). */
export function assignMafiaRoles(count: number): MafiaRole[] {
  const base: MafiaRole[] = ["don", "mafia", "commissar", "doctor", "kamikaze", "citizen"];
  if (count <= 6) return base.slice(0, count);
  const extra: MafiaRole[] = [];
  if (count >= 7) extra.push("putana");
  if (count >= 8) extra.push("bodyguard");
  if (count >= 9) extra.push("maniac");
  if (count >= 10) extra.push("citizen");
  if (count >= 11) extra.push("mafia");
  if (count >= 12) extra.push("citizen");
  const roles = [...base, ...extra];
  while (roles.length < count) roles.push("citizen");
  return roles.slice(0, count);
}

export function shuffleRoles(players: { id: number; name: string; alive: boolean }[]): MafiaPlayer[] {
  const roles = assignMafiaRoles(players.length).sort(() => Math.random() - 0.5);
  return players.map((p, i) => ({
    ...p,
    role: roles[i],
    maniacShield: roles[i] === "maniac",
  }));
}

export interface VoteTally {
  eliminatedId: number | null;
  tie: boolean;
  topIds: number[];
}

export function tallyVotes(
  votes: Record<string, number | "skip">,
  runoffCandidates?: number[],
): VoteTally {
  const tally = new Map<number, number>();
  const pool = runoffCandidates ? new Set(runoffCandidates) : null;
  for (const target of Object.values(votes)) {
    if (target === "skip") continue;
    if (pool && !pool.has(target)) continue;
    tally.set(target, (tally.get(target) ?? 0) + 1);
  }
  let max = 0;
  const topIds: number[] = [];
  for (const [id, c] of tally) {
    if (c > max) {
      max = c;
      topIds.length = 0;
      topIds.push(id);
    } else if (c === max) topIds.push(id);
  }
  if (max === 0 || topIds.length !== 1) {
    return { eliminatedId: null, tie: topIds.length > 1, topIds };
  }
  return { eliminatedId: topIds[0], tie: false, topIds };
}
