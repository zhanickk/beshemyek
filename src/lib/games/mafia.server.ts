import type { SupabaseClient } from "@supabase/supabase-js";
import { telegram, inlineKeyboard, buildDeepLink } from "@/lib/telegram.server";
import { truncateBtn } from "@/lib/keyboards.server";
import { awardCoins, spendCoins } from "@/lib/economy.server";
import {
  createSession,
  getBlockingSession,
  getSessionByShortCode,
  packCallback,
  updateSessionState,
  finishSession,
  type GameCtx,
  type GameSession,
} from "./engine.server";
import {
  type MafiaPlayer,
  type MafiaRole,
  type NightAction,
  ROLE_LABEL,
  shuffleRoles,
  resolveMafiaNightTarget,
  resolveNight,
  formatMorningReport,
  checkWin,
  tallyVotes,
  isMafiaRole,
  formatPlayerTag,
} from "./mafia-engine.server";
import { isSessionDue } from "@/lib/timers.server";

const LOBBY_MS = 90 * 1000;
const LOBBY_REMINDER_59_MS = 31 * 1000;
const LOBBY_REMINDER_29_MS = 61 * 1000;
const NIGHT_MS = 80 * 1000;
const DAY_DISCUSS_MS = 75 * 1000;
const DAY_VOTE_MS = 60 * 1000;
const RUNOFF_MS = 30 * 1000;
const KAMIKAZE_MS = 20 * 1000;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 16;

const WIN_REWARD = 25;
const SURVIVOR_BONUS = 10;
const PARTICIPATION = 5;

const ROLE_EMOJI: Record<MafiaRole, string> = {
  citizen: "👤",
  commissar: "🕵️",
  doctor: "💊",
  putana: "💋",
  bodyguard: "🛡",
  kamikaze: "💥",
  don: "🎩",
  mafia: "🔪",
  maniac: "🔪",
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

type MafiaPhase =
  | "lobby"
  | "night"
  | "day_discuss"
  | "day_vote"
  | "day_runoff"
  | "kamikaze_choice"
  | "finished";

interface MafiaState {
  phase: MafiaPhase;
  players: MafiaPlayer[];
  round: number;
  phaseDeadlineAt: string;
  lobbyMessageId?: number;
  lobbyStartedAt?: string;
  lobbyRemindersSent?: { at59?: boolean; at29?: boolean };
  lobbyReminderMessageIds?: { at59?: number; at29?: number };
  votePromptMessageId?: number;
  nightActions: {
    mafiaVotes: Record<string, number>;
    checks: Record<string, number>;
    heals: Record<string, number>;
    blocks: Record<string, { targetId: number; at: number }>;
    protects: Record<string, number>;
    kills: Record<string, { targetId: number; at: number }>;
    doctorLastSaveId?: number;
  };
  dayVotes: Record<string, number | "skip">;
  runoffCandidates?: number[];
  pendingKamikazeId?: number;
  winner?: string;
}

function serialState(state: MafiaState): Record<string, unknown> {
  return state as unknown as Record<string, unknown>;
}

function formatPlayerList(players: MafiaPlayer[]): string {
  if (!players.length) return "—";
  return players.map((p, i) => `${i + 1}. ${formatPlayerTag(p)}`).join("\n");
}

// ── lobby ────────────────────────────────────────────────────────────────

function renderLobby(players: MafiaPlayer[]): string {
  return `Ведётся набор в игру\n\nЗарегистрировались::\n${formatPlayerList(players)}\n\nИтого ${players.length} чел.`;
}

async function lobbyKeyboard(shortCode: string) {
  const joinUrl = await buildDeepLink(`jm_${shortCode}`);
  const joinBtn = joinUrl
    ? { text: "✅ Зайти в игру", url: joinUrl }
    : { text: "✅ Зайти в игру", callback_data: packCallback(shortCode, "join") };
  return inlineKeyboard([
    [joinBtn],
    [{ text: "🚪 Выйти", callback_data: packCallback(shortCode, "leave") }],
  ]);
}

async function refreshLobby(ctx: GameCtx, session: GameSession, state: MafiaState) {
  if (!state.lobbyMessageId) return;
  await telegram.editMessageText(
    ctx.telegramChatId,
    state.lobbyMessageId,
    renderLobby(state.players),
    { reply_markup: await lobbyKeyboard(session.short_code) },
  );
}

async function joinMafiaPlayer(
  ctx: GameCtx,
  session: GameSession,
  state: MafiaState,
  user: { id: number; name: string; username?: string | null },
): Promise<"ok" | "full" | "already" | "started"> {
  if (state.phase !== "lobby") return "started";
  if (state.players.some((p) => p.id === user.id)) return "already";
  if (state.players.length >= MAX_PLAYERS) return "full";
  const updated: MafiaPlayer[] = [
    ...state.players,
    {
      id: user.id,
      name: user.name,
      username: user.username ?? null,
      role: "citizen",
      alive: true,
    },
  ];
  const newState = { ...state, players: updated };
  await updateSessionState(ctx.admin, session.id, serialState(newState));
  try {
    await telegram.sendMessage(user.id, "✅ Ты в игре.");
  } catch {
    // no-op
  }
  await refreshLobby(ctx, session, newState);
  return "ok";
}

async function leaveMafiaPlayer(
  ctx: GameCtx,
  session: GameSession,
  state: MafiaState,
  userId: number,
): Promise<"ok" | "not_in" | "started"> {
  if (state.phase !== "lobby") return "started";
  if (!state.players.some((p) => p.id === userId)) return "not_in";
  const newState = { ...state, players: state.players.filter((p) => p.id !== userId) };
  await updateSessionState(ctx.admin, session.id, serialState(newState));
  try {
    await telegram.sendMessage(userId, "❌ Ты не в игре.");
  } catch {
    // no-op
  }
  await refreshLobby(ctx, session, newState);
  return "ok";
}

export async function joinMafiaFromDm(
  admin: SupabaseClient,
  shortCode: string,
  user: { id: number; name: string; username?: string | null },
) {
  const session = await getSessionByShortCode(admin, shortCode);
  if (!session || session.type !== "mafia") {
    await telegram.sendMessage(user.id, "Игра не найдена или уже закончилась.");
    return;
  }
  const { data: chatRow } = await admin
    .from("chats")
    .select("telegram_chat_id")
    .eq("id", session.chat_id)
    .maybeSingle();
  const ctx: GameCtx = {
    admin,
    chatId: session.chat_id,
    telegramChatId: chatRow?.telegram_chat_id ?? 0,
    lang: "ru",
  };
  const state = session.state as MafiaState;
  const result = await joinMafiaPlayer(ctx, session, state, user);
  if (result === "already") {
    await telegram.sendMessage(user.id, "Ты уже в игре.");
  } else if (result === "full") {
    await telegram.sendMessage(user.id, "Лобби заполнено.");
  } else if (result === "started") {
    await resendMafiaRole(admin, session, user.id);
  }
}

export async function startMafiaLobby(ctx: GameCtx, invoker: { id: number; name: string }) {
  const existing = await getBlockingSession(ctx.admin, ctx.chatId, "mafia");
  if (existing) return { alreadyActive: true as const };

  const players: MafiaPlayer[] = [];
  const lobbyStartedAt = new Date().toISOString();
  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "mafia",
    {
      phase: "lobby",
      players,
      round: 0,
      phaseDeadlineAt: new Date(Date.now() + LOBBY_MS).toISOString(),
      lobbyStartedAt,
      nightActions: emptyNightActions(),
      dayVotes: {},
      lobbyRemindersSent: {},
      lobbyReminderMessageIds: {},
    } satisfies MafiaState,
    invoker.id,
    "waiting",
  );

  const sent: any = await telegram.sendMessage(ctx.telegramChatId, renderLobby(players), {
    reply_markup: await lobbyKeyboard(session.short_code),
  });
  const lobbyMessageId = sent?.result?.message_id;
  if (lobbyMessageId) {
    await updateSessionState(ctx.admin, session.id, { ...session.state, lobbyMessageId });
  }
  scheduleMafiaLobbyTimers(ctx, session.id, session.short_code);
  return { session };
}

function emptyNightActions(): MafiaState["nightActions"] {
  return { mafiaVotes: {}, checks: {}, heals: {}, blocks: {}, protects: {}, kills: {} };
}

function roleIntro(player: MafiaPlayer, teammates: MafiaPlayer[]): string {
  const label = `${ROLE_EMOJI[player.role]} <b>${ROLE_LABEL[player.role]}</b>`;
  const team = teammates.map((t) => formatPlayerTag(t)).join("\n") || "—";
  switch (player.role) {
    case "don":
      return `${label}\nТы глава мафии. Голосуй за жертву и проверяй, кто Комиссар.\nПодельники:\n${team}`;
    case "mafia":
      if (!teammates.length) {
        return `${label}\nТы мафия. Выбирай жертву ночью.`;
      }
      return `${label}\nСогласуй с Доном цель на ночь.\nКоманда:\n${team}`;
    case "commissar":
      return `${label}\nПроверяй игроков или стреляй в подозреваемых — одно действие за ночь.`;
    case "doctor":
      return `${label}\nЛечи одного игрока от нападения (не того же два раза подряд).`;
    case "putana":
      return `${label}\nЗаблокируй игрока — он не сходит с места, а твоя цель под защитой.`;
    case "bodyguard":
      return `${label}\nПрикрой одного игрока — при нападении умрёшь вместо него.`;
    case "kamikaze":
      return `${label}\nПассивная роль. Если тебя убьют ночью — взорвёшь нападавших. Днём на казни можешь забрать кого-то с собой.`;
    case "maniac":
      return `${label}\nОдиночка. Убивай по ночам. Первая атака мафии на тебя не сработает.`;
    default:
      return `${label}\nВычисляй мафию и голосуй днём.`;
  }
}

async function sendRoleWithActions(ctx: GameCtx, session: GameSession, player: MafiaPlayer) {
  const state = session.state as MafiaState;
  const alive = state.players.filter((p) => p.alive);
  const others = alive.filter((p) => p.id !== player.id);
  const mafiaTeam = state.players.filter((p) => isMafiaRole(p.role) && p.id !== player.id);

  try {
    await telegram.sendMessage(player.id, roleIntro(player, mafiaTeam));
    const rows = buildNightButtons(session, player, others);
    if (rows.length) {
      await telegram.sendMessage(player.id, "Выбери действие:", {
        reply_markup: inlineKeyboard(rows),
      });
    }
    return true;
  } catch {
    return false;
  }
}

function buildNightButtons(
  session: GameSession,
  player: MafiaPlayer,
  targets: MafiaPlayer[],
): Array<Array<{ text: string; callback_data: string }>> {
  const sc = session.short_code;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  const NIGHT_LABEL: Record<string, string> = {
    kill: "Убить",
    check: "Проверить",
    save: "Лечить",
    block: "Блок",
    protect: "Прикрыть",
  };

  const targetRows = (action: string) =>
    targets.map((t) => [
      {
        text: truncateBtn(`${NIGHT_LABEL[action] ?? action}: ${t.name}`),
        callback_data: packCallback(sc, action, String(t.id)),
      },
    ]);

  switch (player.role) {
    case "don":
      rows.push(...targetRows("kill"));
      rows.push(...targetRows("check"));
      break;
    case "mafia":
      rows.push(...targetRows("kill"));
      break;
    case "commissar":
      rows.push(...targetRows("check"));
      rows.push(...targetRows("kill"));
      break;
    case "doctor":
      rows.push(...targetRows("save"));
      rows.push([{ text: "Пропустить", callback_data: packCallback(sc, "save", "0") }]);
      break;
    case "putana":
      rows.push(...targetRows("block"));
      break;
    case "bodyguard":
      rows.push(...targetRows("protect"));
      break;
    case "maniac":
      rows.push(...targetRows("kill"));
      break;
    default:
      break;
  }
  return rows;
}

export async function resendMafiaRole(
  admin: SupabaseClient,
  session: GameSession,
  telegramUserId: number,
) {
  const state = session.state as MafiaState;
  const player = state.players.find((p) => p.id === telegramUserId);
  if (!player?.alive) return;
  const { data: chatRow } = await admin
    .from("chats")
    .select("telegram_chat_id")
    .eq("id", session.chat_id)
    .maybeSingle();
  const ctx: GameCtx = {
    admin,
    chatId: session.chat_id,
    telegramChatId: chatRow?.telegram_chat_id ?? 0,
    lang: "ru",
  };
  if (state.phase === "night") {
    await sendRoleWithActions(ctx, session, player);
  } else {
    await telegram.sendMessage(
      telegramUserId,
      `Твоя роль: ${ROLE_EMOJI[player.role]} <b>${ROLE_LABEL[player.role]}</b>`,
    );
  }
}

// ── night / day flow ─────────────────────────────────────────────────────

async function beginNight(ctx: GameCtx, session: GameSession, players: MafiaPlayer[], round: number) {
  let baseState = session.state as MafiaState;
  if (round === 1) {
    const { data: fresh } = await ctx.admin
      .from("game_sessions")
      .select("state")
      .eq("id", session.id)
      .maybeSingle();
    if (fresh?.state) baseState = fresh.state as MafiaState;
  }

  const withRoles = round === 1 ? shuffleRoles(players) : players;
  const state: MafiaState = {
    ...baseState,
    phase: "night",
    players: withRoles,
    round,
    nightActions: emptyNightActions(),
    dayVotes: {},
    phaseDeadlineAt: new Date(Date.now() + NIGHT_MS).toISOString(),
  };
  await updateSessionState(ctx.admin, session.id, serialState(state), "active");

  if (round === 1) {
    await clearLobbyReminders(ctx, baseState);
    if (baseState.lobbyMessageId) {
      await telegram.deleteMessage(ctx.telegramChatId, baseState.lobbyMessageId);
    }
  }

  const gameSession = { ...session, state } as GameSession;
  for (const p of withRoles.filter((x) => x.alive)) {
    await sendRoleWithActions(ctx, gameSession, p);
  }

  await telegram.sendMessage(
    ctx.telegramChatId,
    `🌙 <b>Ночь ${round}.</b> Город засыпает. Роли в личке (${NIGHT_MS / 1000}с).`,
  );
}

function collectNightActions(state: MafiaState): NightAction[] {
  const na = state.nightActions;
  const actions: NightAction[] = [];
  const push = (userId: number, type: NightAction["type"], targetId: number, at: number) => {
    actions.push({ userId, type, targetId, at });
  };
  for (const [uid, targetId] of Object.entries(na.checks)) {
    push(Number(uid), "check", targetId, 0);
  }
  for (const [uid, targetId] of Object.entries(na.heals)) {
    if (targetId !== 0) push(Number(uid), "heal", targetId, 0);
  }
  for (const [uid, block] of Object.entries(na.blocks)) {
    push(Number(uid), "block", block.targetId, block.at);
  }
  for (const [uid, targetId] of Object.entries(na.protects)) {
    push(Number(uid), "protect", targetId, 0);
  }
  for (const [uid, kill] of Object.entries(na.kills)) {
    push(Number(uid), "kill", kill.targetId, kill.at);
  }
  return actions;
}

async function resolveNightPhase(ctx: GameCtx, session: GameSession) {
  const state = session.state as MafiaState;
  const { targetId, attackerIds } = resolveMafiaNightTarget(state.players, state.nightActions.mafiaVotes);

  const result = resolveNight({
    players: state.players,
    actions: collectNightActions(state),
    mafiaTargetId: targetId,
    mafiaAttackerIds: attackerIds,
  });

  for (const [userId, msg] of Object.entries(result.privateChecks)) {
    try {
      await telegram.sendMessage(Number(userId), `🕵️ ${msg}`);
    } catch {
      // no-op
    }
  }
  if (result.mafiaFailedKill) {
    for (const p of state.players.filter((x) => x.alive && isMafiaRole(x.role))) {
      try {
        await telegram.sendMessage(
          p.id,
          "Ваша цель оказалась слишком крепкой — убийство не удалось.",
        );
      } catch {
        // no-op
      }
    }
  }

  await telegram.sendMessage(ctx.telegramChatId, formatMorningReport(result.morningLines));

  const doc = state.players.find((p) => p.role === "doctor");
  const healTarget = doc ? state.nightActions.heals[String(doc.id)] : undefined;
  const state2: MafiaState = {
    ...state,
    players: result.players,
    nightActions: {
      ...emptyNightActions(),
      doctorLastSaveId:
        healTarget && healTarget !== 0 ? healTarget : state.nightActions.doctorLastSaveId,
    },
    phase: "day_discuss",
    phaseDeadlineAt: new Date(Date.now() + DAY_DISCUSS_MS).toISOString(),
  };

  const win = checkWin(state2.players);
  if (win.winner) {
    await endGame(ctx, session, state2, win.winner);
    return;
  }

  await updateSessionState(ctx.admin, session.id, serialState(state2));
  const alive = state2.players.filter((p) => p.alive);
  await telegram.sendMessage(
    ctx.telegramChatId,
    `💬 <b>День.</b> Обсуждение ${DAY_DISCUSS_MS / 1000}с, потом голосование.\nЖивые (${alive.length}):\n${alive.map((p) => formatPlayerTag(p)).join("\n")}`,
  );
}

async function beginVote(ctx: GameCtx, session: GameSession, runoff?: number[]) {
  const state = session.state as MafiaState;
  const alive = state.players.filter((p) => p.alive);
  const isRunoff = runoff && runoff.length > 0;
  const state2: MafiaState = {
    ...state,
    phase: isRunoff ? "day_runoff" : "day_vote",
    dayVotes: {},
    runoffCandidates: runoff,
    phaseDeadlineAt: new Date(Date.now() + (isRunoff ? RUNOFF_MS : DAY_VOTE_MS)).toISOString(),
  };
  await updateSessionState(ctx.admin, session.id, serialState(state2));

  const candidates = isRunoff ? alive.filter((p) => runoff!.includes(p.id)) : alive;
  const rows = candidates.map((p) => [
    { text: truncateBtn(p.name), callback_data: packCallback(session.short_code, "vote", String(p.id)) },
  ]);
  rows.push([
    { text: "Пропустить", callback_data: packCallback(session.short_code, "vote", "skip") },
  ]);
  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    isRunoff
      ? `🗳 <b>Второй тур!</b> (${RUNOFF_MS / 1000}с)\n${candidates.map((p) => formatPlayerTag(p)).join("\n")}`
      : `🗳 <b>Голосование!</b> (${DAY_VOTE_MS / 1000}с)`,
    { reply_markup: inlineKeyboard(rows) },
  );
  const votePromptMessageId = sent?.result?.message_id;
  if (votePromptMessageId) {
    await updateSessionState(ctx.admin, session.id, serialState({ ...state2, votePromptMessageId }));
  }
}

async function beginKamikazeChoice(ctx: GameCtx, session: GameSession, kamikazeId: number) {
  const state = session.state as MafiaState;
  const alive = state.players.filter((p) => p.alive && p.id !== kamikazeId);
  const state2: MafiaState = {
    ...state,
    phase: "kamikaze_choice",
    pendingKamikazeId: kamikazeId,
    phaseDeadlineAt: new Date(Date.now() + KAMIKAZE_MS).toISOString(),
  };
  await updateSessionState(ctx.admin, session.id, serialState(state2));

  const rows = alive.map((p) => [
    { text: truncateBtn(p.name), callback_data: packCallback(session.short_code, "kboom", String(p.id)) },
  ]);
  try {
    await telegram.sendMessage(
      kamikazeId,
      `💥 Тебя вывели на эшафот! У тебя ${KAMIKAZE_MS / 1000}с — жми, кого забрать с собой:`,
      { reply_markup: inlineKeyboard(rows) },
    );
  } catch {
    // fall through to timeout
  }
  await telegram.sendMessage(
    ctx.telegramChatId,
    `💥 <b>Камикадзе на эшафоте!</b> У него ${KAMIKAZE_MS / 1000}с, чтобы решить — взять кого-то с собой или нет.`,
  );
}

async function resolveKamikazeTimeout(ctx: GameCtx, session: GameSession) {
  const state = session.state as MafiaState;
  const kid = state.pendingKamikazeId;
  if (!kid) return;
  const players = state.players.map((p) => (p.id === kid ? { ...p, alive: false } : p));
  await telegram.sendMessage(
    ctx.telegramChatId,
    "💥 Камикадзе не успел замкнуть провода. Он погибает один.",
  );
  await afterElimination(ctx, session, { ...state, players, phase: "day_discuss" }, null);
}

async function afterElimination(
  ctx: GameCtx,
  session: GameSession,
  state: MafiaState,
  eliminated: MafiaPlayer | null,
) {
  const win = checkWin(state.players);
  if (win.winner) {
    await endGame(ctx, session, state, win.winner);
    return;
  }
  await beginNight(ctx, session, state.players, (state.round ?? 1) + 1);
}

async function clearVotePrompt(ctx: GameCtx, state: MafiaState) {
  if (!state.votePromptMessageId) return;
  await telegram.deleteMessage(ctx.telegramChatId, state.votePromptMessageId);
}

async function resolveVote(ctx: GameCtx, session: GameSession) {
  const state = session.state as MafiaState;
  await clearVotePrompt(ctx, state);
  const { eliminatedId, tie, topIds } = tallyVotes(state.dayVotes, state.runoffCandidates);

  if (tie && state.phase === "day_vote" && topIds.length >= 2) {
    const names = topIds
      .slice(0, 2)
      .map((id) => state.players.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => formatPlayerTag(p!))
      .join("\n");
    await telegram.sendMessage(
      ctx.telegramChatId,
      `Город не смог договориться. Второй тур:\n${names}`,
    );
    await beginVote(ctx, session, topIds.slice(0, 2));
    return;
  }

  if (tie) {
    await telegram.sendMessage(ctx.telegramChatId, "Суд Линча сорван — никто не казнён.");
    await beginNight(ctx, session, state.players, (state.round ?? 1) + 1);
    return;
  }

  let players = state.players;
  const eliminated = eliminatedId ? players.find((p) => p.id === eliminatedId) : undefined;

  if (eliminated) {
    if (eliminated.role === "kamikaze") {
      await beginKamikazeChoice(ctx, session, eliminated.id);
      return;
    }
    players = players.map((p) => (p.id === eliminatedId ? { ...p, alive: false } : p));
    await telegram.sendMessage(
      ctx.telegramChatId,
      `⚖️ Казнён:\n${formatPlayerTag(eliminated)} — ${ROLE_EMOJI[eliminated.role]} ${ROLE_LABEL[eliminated.role]}.`,
    );
  } else {
    await telegram.sendMessage(ctx.telegramChatId, "Сегодня никого не изгнали.");
  }

  await afterElimination(ctx, session, { ...state, players }, eliminated ?? null);
}

async function endGame(
  ctx: GameCtx,
  session: GameSession,
  state: MafiaState,
  winner: "town" | "mafia" | "maniac" | "draw",
) {
  const labels = {
    town: "👤 Мирный город",
    mafia: "🔪 Мафия",
    maniac: "🗡 Маньяк",
    draw: "☠️ Смерть",
  };
  await finishSession(ctx.admin, session.id, serialState({ ...state, phase: "finished", winner }));
  for (const p of state.players) {
    const isWinner =
      winner === "draw"
        ? false
        : winner === "town"
          ? !isMafiaRole(p.role) && p.role !== "maniac"
          : winner === "mafia"
            ? isMafiaRole(p.role)
            : p.role === "maniac";
    let coins = PARTICIPATION;
    if (isWinner) coins += WIN_REWARD;
    if (isWinner && p.alive) coins += SURVIVOR_BONUS;
    await awardCoins(ctx.admin, ctx.chatId, p.id, coins, "game_win", { game: "mafia", winner });
  }
  const roster = state.players
    .map(
      (p) =>
        `${p.alive ? "🟢" : "⚰️"} ${formatPlayerTag(p)} — ${ROLE_EMOJI[p.role]} ${ROLE_LABEL[p.role]}`,
    )
    .join("\n");
  await telegram.sendMessage(
    ctx.telegramChatId,
    `🏁 <b>Игра окончена!</b> Победа: <b>${labels[winner]}</b>!\n\n${roster}\n\nПобедители получили БешКоины 🪙`,
  );
}

// ── callbacks ────────────────────────────────────────────────────────────

export async function handleMafiaCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  payload: string,
  callbackQueryId: string,
  fromUser: { id: number; name: string; username?: string | null },
) {
  const state = session.state as MafiaState;

  if (action === "join") {
    const result = await joinMafiaPlayer(ctx, session, state, fromUser);
    if (result === "started") {
      await telegram.answerCallbackQuery(callbackQueryId, "Игра уже началась.", true);
      return;
    }
    if (result === "already") {
      await telegram.answerCallbackQuery(callbackQueryId, "Ты уже в игре!");
      return;
    }
    if (result === "full") {
      await telegram.answerCallbackQuery(callbackQueryId, "Лобби заполнено.", true);
      return;
    }
    await telegram.answerCallbackQuery(callbackQueryId, "Ты в игре!");
    return;
  }

  if (action === "leave") {
    const result = await leaveMafiaPlayer(ctx, session, state, fromUser.id);
    if (result === "started") {
      await telegram.answerCallbackQuery(callbackQueryId, "Из начавшейся игры уже не выйти.", true);
      return;
    }
    if (result === "not_in") {
      await telegram.answerCallbackQuery(callbackQueryId, "Тебя нет в списке.");
      return;
    }
    await telegram.answerCallbackQuery(callbackQueryId, "Вышел из лобби.");
    return;
  }

  if (action === "startnow") {
    await telegram.answerCallbackQuery(callbackQueryId, "Набор закончится автоматически.", true);
    return;
  }

  if (action === "kboom") {
    if (state.phase !== "kamikaze_choice" || state.pendingKamikazeId !== fromUser.id) {
      await telegram.answerCallbackQuery(callbackQueryId, "Сейчас не твоё действие.", true);
      return;
    }
    const targetId = Number(payload);
    const players = state.players.map((p) => {
      if (p.id === fromUser.id || p.id === targetId) return { ...p, alive: false };
      return p;
    });
    const target = state.players.find((p) => p.id === targetId);
    const kamikaze = state.players.find((p) => p.id === fromUser.id);
    await telegram.answerCallbackQuery(callbackQueryId, "💥 Бабах!");
    await telegram.sendMessage(
      ctx.telegramChatId,
      `💥 <b>КАМИКАДЗЕ ЗАБИРАЕТ ЖЕРТВУ!</b>\n${kamikaze ? formatPlayerTag(kamikaze) : "—"} взорвался вместе с ${target ? formatPlayerTag(target) : "—"} (${ROLE_LABEL[target?.role ?? "citizen"]})!`,
    );
    const win = checkWin(players);
    if (win.winner) {
      await endGame(ctx, session, { ...state, players }, win.winner);
      return;
    }
    await beginNight(ctx, session, players, (state.round ?? 1) + 1);
    return;
  }

  if (["kill", "save", "check", "block", "protect"].includes(action)) {
    if (state.phase !== "night") {
      await telegram.answerCallbackQuery(callbackQueryId, "Сейчас не ночь.", true);
      return;
    }
    const actor = state.players.find((p) => p.id === fromUser.id);
    if (!actor?.alive) {
      await telegram.answerCallbackQuery(callbackQueryId, "Ты не в игре.", true);
      return;
    }
    const targetId = Number(payload);
    const na = { ...state.nightActions };
    const now = Date.now();

    if (action === "kill") {
      if (!isMafiaRole(actor.role) && actor.role !== "commissar" && actor.role !== "maniac") {
        await telegram.answerCallbackQuery(callbackQueryId, "Это не твоё действие.", true);
        return;
      }
      if (isMafiaRole(actor.role)) {
        na.mafiaVotes = { ...na.mafiaVotes, [String(fromUser.id)]: targetId };
      } else {
        na.kills = { ...na.kills, [String(fromUser.id)]: { targetId, at: now } };
      }
      const target = state.players.find((p) => p.id === targetId);
      await telegram.answerCallbackQuery(callbackQueryId, `Выбор: ${target?.name ?? "?"}`);
    } else if (action === "save") {
      if (actor.role !== "doctor") {
        await telegram.answerCallbackQuery(callbackQueryId, "Это не твоё действие.", true);
        return;
      }
      if (targetId !== 0 && na.doctorLastSaveId === targetId) {
        await telegram.answerCallbackQuery(callbackQueryId, "Нельзя лечить того же два раза подряд.", true);
        return;
      }
      na.heals = { ...na.heals, [String(fromUser.id)]: targetId };
      await telegram.answerCallbackQuery(callbackQueryId, targetId === 0 ? "Пропуск." : "Лечишь.");
    } else if (action === "check") {
      if (actor.role !== "commissar" && actor.role !== "don") {
        await telegram.answerCallbackQuery(callbackQueryId, "Это не твоё действие.", true);
        return;
      }
      na.checks = { ...na.checks, [String(fromUser.id)]: targetId };
      await telegram.answerCallbackQuery(callbackQueryId, "Проверяешь…");
    } else if (action === "block") {
      if (actor.role !== "putana") {
        await telegram.answerCallbackQuery(callbackQueryId, "Это не твоё действие.", true);
        return;
      }
      na.blocks = { ...na.blocks, [String(fromUser.id)]: { targetId, at: now } };
      await telegram.answerCallbackQuery(callbackQueryId, "Заблокировала.");
    } else if (action === "protect") {
      if (actor.role !== "bodyguard") {
        await telegram.answerCallbackQuery(callbackQueryId, "Это не твоё действие.", true);
        return;
      }
      na.protects = { ...na.protects, [String(fromUser.id)]: targetId };
      await telegram.answerCallbackQuery(callbackQueryId, "Прикрываешь.");
    }

    await updateSessionState(ctx.admin, session.id, serialState({ ...state, nightActions: na }));
    return;
  }

  if (action === "vote") {
    if (state.phase !== "day_vote" && state.phase !== "day_runoff") {
      await telegram.answerCallbackQuery(callbackQueryId, "Голосование не идёт.", true);
      return;
    }
    const voter = state.players.find((p) => p.id === fromUser.id);
    if (!voter?.alive) {
      await telegram.answerCallbackQuery(callbackQueryId, "Голосуют только живые.", true);
      return;
    }
    const choice: number | "skip" = payload === "skip" ? "skip" : Number(payload);
    const dayVotes = { ...state.dayVotes, [String(fromUser.id)]: choice };
    const newState = { ...state, dayVotes };
    await updateSessionState(ctx.admin, session.id, serialState(newState));
    await telegram.answerCallbackQuery(callbackQueryId, choice === "skip" ? "Воздержался." : "Голос учтён.");

    const targetLabel =
      choice === "skip"
        ? "пропуск"
        : formatPlayerTag(state.players.find((p) => p.id === choice) ?? { id: choice, name: "?", username: null });
    await telegram.sendMessage(
      ctx.telegramChatId,
      `${formatPlayerTag(voter)} проголосовал за ${targetLabel}`,
    );

    const aliveCount = state.players.filter((p) => p.alive).length;
    if (Object.keys(dayVotes).length >= aliveCount) {
      await resolveVote(ctx, { ...session, state: newState } as GameSession);
    }
    return;
  }
}

export async function applyMafiaImmunityPurchase(
  admin: SupabaseClient,
  chatId: string,
  telegramUserId: number,
): Promise<boolean> {
  const ok = await spendCoins(admin, chatId, telegramUserId, 60, { item: "mafia_immunity" });
  return ok;
}

export async function tickMafia(admin: SupabaseClient) {
  const { data: sessions } = await admin
    .from("game_sessions")
    .select("*, chats!inner(telegram_chat_id)")
    .eq("type", "mafia")
    .in("status", ["waiting", "active"]);

  for (const session of sessions ?? []) {
    try {
      await tickMafiaSession(admin, session);
    } catch (e) {
      console.error(`mafia tick failed for session ${session.id}`, e);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function clearLobbyReminders(ctx: GameCtx, state: MafiaState) {
  const ids = state.lobbyReminderMessageIds;
  if (!ids) return;
  for (const mid of [ids.at59, ids.at29]) {
    if (mid) await telegram.deleteMessage(ctx.telegramChatId, mid);
  }
}

async function fireLobbyReminder(
  ctx: GameCtx,
  sessionId: string,
  shortCode: string,
  kind: "at59" | "at29",
) {
  const { data: row } = await ctx.admin
    .from("game_sessions")
    .select("state")
    .eq("id", sessionId)
    .eq("type", "mafia")
    .in("status", ["waiting", "active"])
    .maybeSingle();
  if (!row || (row.state as MafiaState).phase !== "lobby") return;

  const state = row.state as MafiaState;
  const sent = state.lobbyRemindersSent ?? {};
  if (kind === "at59" && sent.at59) return;
  if (kind === "at29" && sent.at29) return;

  const kb = await lobbyKeyboard(shortCode);
  const text = kind === "at59" ? "⏱ Осталось 59 сек" : "⏱ Осталось 29 сек";
  const res: any = await telegram.sendMessage(ctx.telegramChatId, text, { reply_markup: kb });
  const messageId = res?.result?.message_id as number | undefined;

  await updateSessionState(ctx.admin, sessionId, serialState({
    ...state,
    lobbyRemindersSent: { ...sent, [kind]: true },
    lobbyReminderMessageIds: {
      ...state.lobbyReminderMessageIds,
      [kind]: messageId,
    },
  }));
}

async function fireLobbyEnd(ctx: GameCtx, sessionId: string) {
  const { data: row } = await ctx.admin
    .from("game_sessions")
    .select("*, chats!inner(telegram_chat_id)")
    .eq("id", sessionId)
    .eq("type", "mafia")
    .in("status", ["waiting", "active"])
    .maybeSingle();
  if (!row || (row.state as MafiaState).phase !== "lobby") return;
  await tickMafiaSession(ctx.admin, row);
}

function scheduleMafiaLobbyTimers(ctx: GameCtx, sessionId: string, shortCode: string) {
  const work = (async () => {
    await sleep(LOBBY_REMINDER_59_MS);
    await fireLobbyReminder(ctx, sessionId, shortCode, "at59");
    await sleep(LOBBY_REMINDER_29_MS - LOBBY_REMINDER_59_MS);
    await fireLobbyReminder(ctx, sessionId, shortCode, "at29");
    await sleep(LOBBY_MS - LOBBY_REMINDER_29_MS);
    await fireLobbyEnd(ctx, sessionId);
  })().catch((e) => console.error("mafia lobby timers failed", e));

  if (ctx.waitUntil) ctx.waitUntil(work);
  else void work;
}

async function maybeSendLobbyReminders(
  ctx: GameCtx,
  session: GameSession,
  state: MafiaState,
): Promise<MafiaState> {
  if (!state.lobbyStartedAt) return state;
  const started = new Date(state.lobbyStartedAt).getTime();
  const now = Date.now();

  if (now >= started + LOBBY_REMINDER_59_MS) {
    await fireLobbyReminder(ctx, session.id, session.short_code, "at59");
  }
  if (now >= started + LOBBY_REMINDER_29_MS) {
    await fireLobbyReminder(ctx, session.id, session.short_code, "at29");
  }

  const { data: fresh } = await ctx.admin
    .from("game_sessions")
    .select("state")
    .eq("id", session.id)
    .maybeSingle();
  return (fresh?.state as MafiaState | undefined) ?? state;
}

async function cancelInsufficientLobby(
  admin: SupabaseClient,
  ctx: GameCtx,
  session: GameSession,
  state: MafiaState,
) {
  const { data: fresh } = await admin
    .from("game_sessions")
    .select("state")
    .eq("id", session.id)
    .maybeSingle();
  const latest = (fresh?.state as MafiaState | undefined) ?? state;

  await clearLobbyReminders(ctx, latest);
  if (latest.lobbyMessageId) {
    await telegram.deleteMessage(ctx.telegramChatId, latest.lobbyMessageId);
  }
  await finishSession(admin, session.id, latest as unknown as Record<string, unknown>);
  await telegram.sendMessage(ctx.telegramChatId, "Недостаточно игроков для начала игры...");
}

export async function tickMafiaSession(admin: SupabaseClient, session: any) {
  const ctx: GameCtx = {
    admin,
    chatId: session.chat_id,
    telegramChatId: session.chats.telegram_chat_id,
    lang: "ru",
  };
  const gameSession = session as GameSession;
  const phase = session.state.phase as MafiaPhase;

  if (phase === "lobby") {
    let state = session.state as MafiaState;
    state = await maybeSendLobbyReminders(ctx, gameSession, state);
    if (!isSessionDue(state)) return;

    if (state.players.length >= MIN_PLAYERS) {
      await beginNight(ctx, gameSession, state.players, 1);
    } else {
      await cancelInsufficientLobby(admin, ctx, gameSession, state);
    }
    return;
  }

  if (!isSessionDue(session.state)) return;

  if (phase === "night") {
    await resolveNightPhase(ctx, gameSession);
  } else if (phase === "day_discuss") {
    await beginVote(ctx, gameSession);
  } else if (phase === "day_vote" || phase === "day_runoff") {
    await resolveVote(ctx, gameSession);
  } else if (phase === "kamikaze_choice") {
    await resolveKamikazeTimeout(ctx, gameSession);
  }
}
