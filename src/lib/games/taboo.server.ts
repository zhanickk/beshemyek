import type { SupabaseClient } from "@supabase/supabase-js";
import { telegram, inlineKeyboard, buildDeepLink } from "@/lib/telegram.server";
import { truncateBtn } from "@/lib/keyboards.server";
import { awardCoins } from "@/lib/economy.server";
import {
  createSession,
  getBlockingSession,
  packCallback,
  updateSessionState,
  finishSession,
  type GameCtx,
  type GameSession,
} from "./engine.server";
import { containsWord, pickTabooWord, pickMineSuggestions } from "./words";
import { isSessionDue } from "@/lib/timers.server";

const LOBBY_MS = 60 * 1000;
const MINE_SETUP_MS = 45 * 1000;
const ROUND_MS = 2 * 60 * 1000;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 7;

const SCORE_FULL = 10;
const PENALTY_PER_MINE = 3;
const MINER_HIT_BONUS = 5;
const MINER_SURVIVE_BONUS = 2;
const WINNER_BONUS = 15;

const TABOO_INTRO =
  "Представь... Тебе известно секретное слово. Основная задача — объяснить его партнёру. Ты собрался с мыслями и готов начать.\n" +
  "Но вот беда! Остальные игроки уже заминировали твоё объяснение — каждый придумал слово-мину, которое тебе нельзя произносить. Что это за слова? Ни ты, ни угадывающий не знаете. Раздумывать некогда. Поехали!";

type TabooPhase = "lobby" | "setup_mines" | "playing" | "round_end";

interface TabooPlayer {
  id: number;
  name: string;
  wasExplainer: boolean;
  wasGuesser: boolean;
  score: number;
}

interface TabooMine {
  userId: number;
  name: string;
  word: string | null;
  detonated: boolean;
  suggestions: string[];
}

interface TabooExplosion {
  minerId: number;
  at: string;
  beforeGuess: boolean;
}

interface TabooRound {
  roundNum: number;
  word: string;
  explainerId: number;
  explainerName: string;
  guesserId: number;
  guesserName: string;
  mines: TabooMine[];
  explosions: TabooExplosion[];
  guessedAt: string | null;
  winnerId: number | null;
}

interface TabooState {
  phase: TabooPhase;
  phaseDeadlineAt: string;
  lobbyMessageId?: number;
  roundMessageId?: number;
  players: TabooPlayer[];
  usedWords: string[];
  round: TabooRound | null;
  showIntro?: boolean;
}

function serialState(state: TabooState): Record<string, unknown> {
  return state as unknown as Record<string, unknown>;
}

function playerName(players: TabooPlayer[], id: number): string {
  return players.find((p) => p.id === id)?.name ?? `#${id}`;
}

function renderLobby(players: TabooPlayer[]): string {
  const list = players.length
    ? players.map((p, i) => `${i + 1}. ${p.name}`).join("\n")
    : "<i>пока никого</i>";
  const need = Math.max(0, MIN_PLAYERS - players.length);
  const status =
    players.length >= MIN_PLAYERS
      ? `Собралось ${players.length}/${MAX_PLAYERS} — через минуту стартуем!`
      : `Нужно ещё минимум ${need} (всего ${MIN_PLAYERS}–${MAX_PLAYERS} игроков).`;
  return `🚫 <b>Табу — сбор игроков</b>\n\n<b>В игре (${players.length}/${MAX_PLAYERS}):</b>\n${list}\n\n${status}\nЖми «✅ Я в игре».`;
}

function lobbyKeyboard(shortCode: string) {
  return inlineKeyboard([
    [
      { text: "✅ Я в игре", callback_data: packCallback(shortCode, "join") },
      { text: "🚪 Выйти", callback_data: packCallback(shortCode, "leave") },
    ],
    [{ text: "▶️ Начать сейчас", callback_data: packCallback(shortCode, "startnow") }],
  ]);
}

function mineSetupKeyboard(shortCode: string, suggestions: string[]) {
  const rows = suggestions.map((word, i) => [
    { text: truncateBtn(word), callback_data: packCallback(shortCode, "mine", String(i)) },
  ]);
  return inlineKeyboard(rows);
}

function renderPlayingMessage(round: TabooRound, explosions: number): string {
  const boomLine = explosions > 0 ? `\n💥 Взрывов: ${explosions}` : "";
  return (
    `🚫 <b>Раунд ${round.roundNum} идёт!</b>\n` +
    `🗣 ${round.explainerName} объясняет → 🎯 ${round.guesserName} угадывает\n` +
    `⏱ 2 минуты · чат заминирован 💣${boomLine}`
  );
}

function playingKeyboard(shortCode: string, mines: TabooMine[]) {
  const active = mines.filter((m) => !m.detonated);
  if (!active.length) return undefined;
  const rows = active.map((m) => [
    {
      text: truncateBtn(m.name),
      callback_data: packCallback(shortCode, "boom"),
    },
  ]);
  return inlineKeyboard(rows);
}

async function refreshRoundMessage(ctx: GameCtx, session: GameSession, state: TabooState) {
  if (!state.roundMessageId || !state.round) return;
  const explosions = state.round.explosions.length;
  await telegram.editMessageText(
    ctx.telegramChatId,
    state.roundMessageId,
    renderPlayingMessage(state.round, explosions),
    { reply_markup: playingKeyboard(session.short_code, state.round.mines) },
  );
}

async function refreshLobby(ctx: GameCtx, session: GameSession, state: TabooState) {
  if (!state.lobbyMessageId) return;
  await telegram.editMessageText(
    ctx.telegramChatId,
    state.lobbyMessageId,
    renderLobby(state.players),
    { reply_markup: lobbyKeyboard(session.short_code) },
  );
}

function pickRoles(players: TabooPlayer[]): {
  explainer: TabooPlayer;
  guesser: TabooPlayer;
  miners: TabooPlayer[];
} {
  const needExplainer = players.filter((p) => !p.wasExplainer);
  const needGuesser = players.filter((p) => !p.wasGuesser);
  const explainerPool = needExplainer.length ? needExplainer : players;
  const explainer = explainerPool[Math.floor(Math.random() * explainerPool.length)];
  const guesserCandidates = (needGuesser.length ? needGuesser : players).filter(
    (p) => p.id !== explainer.id,
  );
  const guesser =
    guesserCandidates[Math.floor(Math.random() * guesserCandidates.length)] ??
    players.find((p) => p.id !== explainer.id)!;
  const miners = players.filter((p) => p.id !== explainer.id && p.id !== guesser.id);
  return { explainer, guesser, miners };
}

function allRolesDone(players: TabooPlayer[]): boolean {
  return players.every((p) => p.wasExplainer && p.wasGuesser);
}

async function dmExplainerAndMiners(
  ctx: GameCtx,
  session: GameSession,
  round: TabooRound,
  miners: TabooPlayer[],
) {
  try {
    await telegram.sendMessage(
      round.explainerId,
      `🚫 <b>Табу — ты Объясняющий</b>\nСекретное слово: <b>${round.word}</b>\nОбъясни его ${round.guesserName} в группе, не называя само слово.`,
      {
        reply_markup: inlineKeyboard([
          [{ text: "📋 Показать слово", callback_data: packCallback(session.short_code, "word") }],
        ]),
      },
    );
  } catch {
    const link = await buildDeepLink(`taboo_${session.short_code}`);
    await telegram.sendMessage(
      ctx.telegramChatId,
      `${round.explainerName}, не смог написать в личку 😅 ${link ? `Открой: ${link}` : "Напиши мне /start в личке."}`,
    );
  }

  for (const miner of miners) {
    const suggestions = pickMineSuggestions(round.word);
    try {
      await telegram.sendMessage(
        miner.id,
        `💣 <b>Табу — ты Минёр</b>\nСекретное слово: <b>${round.word}</b>\nВыбери слово-ловушку кнопкой или напиши своё 👇`,
        { reply_markup: mineSetupKeyboard(session.short_code, suggestions) },
      );
    } catch {
      // miner can use deep link
    }
    const mine = round.mines.find((m) => m.userId === miner.id);
    if (mine) mine.suggestions = suggestions;
  }
}

async function beginPlaying(ctx: GameCtx, session: GameSession, state: TabooState) {
  const round = state.round!;
  const newState: TabooState = {
    ...state,
    phase: "playing",
    phaseDeadlineAt: new Date(Date.now() + ROUND_MS).toISOString(),
  };
  await updateSessionState(ctx.admin, session.id, serialState(newState));

  for (const mine of round.mines) {
    if (!mine.word) continue;
    try {
      await telegram.sendMessage(mine.userId, `💣 Мина «${mine.word}» заряжена! Жми кнопку, если сработала.`, {
        reply_markup: inlineKeyboard([
          [{ text: "💣 Взорвать мину!", callback_data: packCallback(session.short_code, "boom") }],
        ]),
      });
    } catch {
      // no-op
    }
  }

  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    renderPlayingMessage(round, 0),
    { reply_markup: playingKeyboard(session.short_code, round.mines) },
  );
  const roundMessageId = sent?.result?.message_id;
  if (roundMessageId) {
    await updateSessionState(ctx.admin, session.id, serialState({ ...newState, roundMessageId }));
  }
}

async function beginRound(ctx: GameCtx, session: GameSession, state: TabooState, roundNum: number) {
  const word = pickTabooWord(state.usedWords);
  const { explainer, guesser, miners } = pickRoles(state.players);
  const round: TabooRound = {
    roundNum,
    word,
    explainerId: explainer.id,
    explainerName: explainer.name,
    guesserId: guesser.id,
    guesserName: guesser.name,
    mines: miners.map((m) => ({
      userId: m.id,
      name: m.name,
      word: null,
      detonated: false,
      suggestions: pickMineSuggestions(word),
    })),
    explosions: [],
    guessedAt: null,
    winnerId: null,
  };

  const newState: TabooState = {
    ...state,
    phase: "setup_mines",
    phaseDeadlineAt: new Date(Date.now() + MINE_SETUP_MS).toISOString(),
    usedWords: [...state.usedWords, word],
    round,
    showIntro: roundNum === 1 ? false : state.showIntro,
  };
  await updateSessionState(ctx.admin, session.id, serialState(newState), "active");

  if (roundNum === 1) {
    await telegram.sendMessage(ctx.telegramChatId, TABOO_INTRO);
  }

  await dmExplainerAndMiners(ctx, session, round, miners);

  await telegram.sendMessage(
    ctx.telegramChatId,
    `🎯 <b>Раунд ${roundNum}</b>\nРоли:\n🗣 Объясняющий — ${explainer.name}\n🎯 Угадывающий — ${guesser.name}\n💣 Минёры — ${miners.map((m) => m.name).join(", ") || "—"}\n\nМинёры — выберите мину кнопками в личке бота (${MINE_SETUP_MS / 1000} сек).`,
  );
}

function pendingMines(round: TabooRound): TabooMine[] {
  return round.mines.filter((m) => !m.word);
}

async function tryAdvanceMines(ctx: GameCtx, session: GameSession, state: TabooState) {
  if (state.phase !== "setup_mines" || !state.round) return;
  if (pendingMines(state.round).length > 0) return;
  await beginPlaying(ctx, session, state);
}

async function revealRound(ctx: GameCtx, session: GameSession, state: TabooState) {
  const round = state.round!;
  const lines = round.mines.map((m) => {
    const boom = m.detonated ? " 💥" : "";
    const w = m.word ?? "(не прислал)";
    return `• ${m.name} → «${w}»${boom}`;
  });
  await telegram.sendMessage(
    ctx.telegramChatId,
    `📋 <b>Разбор раунда ${round.roundNum}</b>\nСлово было: <b>${round.word}</b>\n\n<b>Мины:</b>\n${lines.join("\n")}`,
  );
}

async function scoreRound(ctx: GameCtx, state: TabooState): Promise<TabooState> {
  const round = state.round!;
  const players = [...state.players];
  const bump = (id: number, pts: number) => {
    const p = players.find((x) => x.id === id);
    if (p) p.score += pts;
  };

  const explosionsBeforeGuess = round.explosions.filter((e) => e.beforeGuess);

  if (round.guessedAt && round.winnerId) {
    const penalty = explosionsBeforeGuess.length * PENALTY_PER_MINE;
    const explainerCoins = Math.max(0, SCORE_FULL - penalty);
    const guesserCoins = Math.max(0, SCORE_FULL - penalty);
    bump(round.explainerId, explainerCoins);
    bump(round.winnerId, guesserCoins);
    await awardCoins(ctx.admin, ctx.chatId, round.explainerId, explainerCoins, "game_win", {
      game: "taboo_explainer",
      round: round.roundNum,
    });
    await awardCoins(ctx.admin, ctx.chatId, round.winnerId, guesserCoins, "game_win", {
      game: "taboo_guesser",
      round: round.roundNum,
    });
    for (const exp of explosionsBeforeGuess) {
      bump(exp.minerId, MINER_HIT_BONUS);
      await awardCoins(ctx.admin, ctx.chatId, exp.minerId, MINER_HIT_BONUS, "game_win", {
        game: "taboo_mine",
        round: round.roundNum,
      });
    }
    const hitNames = explosionsBeforeGuess
      .map((e) => playerName(players, e.minerId))
      .join(", ");
    await telegram.sendMessage(
      ctx.telegramChatId,
      `✅ <b>Угадано!</b> ${round.guesserName} взял(а) «${round.word}».\n` +
        (explosionsBeforeGuess.length
          ? `💥 Взрывов до угадывания: ${explosionsBeforeGuess.length} (−${penalty} к очкам пары). Минёры ${hitNames || "—"} +${MINER_HIT_BONUS} 🪙`
          : `Чистая победа — +${SCORE_FULL} 🪙 Объясняющему и Угадывающему!`),
    );
  } else {
    const survivors = round.mines.filter((m) => !m.detonated);
    for (const s of survivors) {
      bump(s.userId, MINER_SURVIVE_BONUS);
      await awardCoins(ctx.admin, ctx.chatId, s.userId, MINER_SURVIVE_BONUS, "game_win", {
        game: "taboo_mine_survive",
        round: round.roundNum,
      });
    }
    await telegram.sendMessage(
      ctx.telegramChatId,
      `⏰ Время вышло, слово не угадано.\n` +
        (survivors.length
          ? `Минёры без взрыва (${survivors.map((s) => s.name).join(", ")}) +${MINER_SURVIVE_BONUS} 🪙`
          : "Очки никому — все мины взорвались или не было минёров."),
    );
  }

  for (const p of players) {
    if (p.id === round.explainerId) p.wasExplainer = true;
    if (p.id === round.guesserId) p.wasGuesser = true;
  }

  return { ...state, players, round };
}

async function endRound(ctx: GameCtx, session: GameSession, state: TabooState) {
  if (state.roundMessageId) {
    await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.roundMessageId, undefined);
  }
  await revealRound(ctx, session, state);
  const scored = await scoreRound(ctx, state);

  if (allRolesDone(scored.players)) {
    await finishGame(ctx, session, scored);
    return;
  }

  const nextRound = (scored.round?.roundNum ?? 0) + 1;
  await beginRound(ctx, session, scored, nextRound);
}

async function finishGame(ctx: GameCtx, session: GameSession, state: TabooState) {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  if (top && top.score > 0) {
    await awardCoins(ctx.admin, ctx.chatId, top.id, WINNER_BONUS, "game_win", {
      game: "taboo_winner",
    });
    top.score += WINNER_BONUS;
  }
  const table = sorted
    .map((p, i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      const bonus = i === 0 && top?.score ? ` (+${WINNER_BONUS} 🪙 бонус)` : "";
      return `${medal} ${p.name} — ${p.score} очков${bonus}`;
    })
    .join("\n");

  await finishSession(ctx.admin, session.id, serialState({ ...state, phase: "round_end" }));
  if (state.lobbyMessageId) {
    await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.lobbyMessageId, undefined);
  }
  await telegram.sendMessage(ctx.telegramChatId, `🏁 <b>Табу окончено!</b>\n\n${table}`);
}

// ── public API ───────────────────────────────────────────────────────────

export async function startTaboo(ctx: GameCtx, invoker: { id: number; name: string }) {
  const existing = await getBlockingSession(ctx.admin, ctx.chatId, "taboo");
  if (existing) return { alreadyActive: true as const };

  const players: TabooPlayer[] = [
    { id: invoker.id, name: invoker.name, wasExplainer: false, wasGuesser: false, score: 0 },
  ];
  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "taboo",
    {
      phase: "lobby",
      phaseDeadlineAt: new Date(Date.now() + LOBBY_MS).toISOString(),
      players,
      usedWords: [] as string[],
      round: null,
    } satisfies TabooState,
    invoker.id,
    "waiting",
  );

  const sent: any = await telegram.sendMessage(ctx.telegramChatId, renderLobby(players), {
    reply_markup: lobbyKeyboard(session.short_code),
  });
  const lobbyMessageId = sent?.result?.message_id;
  if (lobbyMessageId) {
    await updateSessionState(ctx.admin, session.id, { ...session.state, lobbyMessageId });
  }
  return { session };
}

async function submitMinerWord(
  ctx: GameCtx,
  session: GameSession,
  state: TabooState,
  telegramUserId: number,
  word: string,
  notifyChatId?: number,
): Promise<boolean> {
  if (state.phase !== "setup_mines" || !state.round) return false;
  const mine = state.round.mines.find((m) => m.userId === telegramUserId && !m.word);
  if (!mine) return false;

  const mines = state.round.mines.map((m) =>
    m.userId === telegramUserId ? { ...m, word } : m,
  );
  const newRound = { ...state.round, mines };
  const newState = { ...state, round: newRound };
  await updateSessionState(ctx.admin, session.id, serialState(newState));

  const targetId = notifyChatId ?? telegramUserId;
  await telegram.sendMessage(targetId, `✅ Мина «${word}» заряжена. Жди старта раунда в группе 💣`);
  await tryAdvanceMines(ctx, session, newState);
  return true;
}

export async function handleTabooCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  payload: string,
  callbackQueryId: string,
  fromUser: { id: number; name: string },
) {
  const state = session.state as TabooState;

  if (action === "join") {
    if (state.phase !== "lobby") {
      await telegram.answerCallbackQuery(callbackQueryId, "Игра уже началась.", true);
      return;
    }
    if (state.players.some((p) => p.id === fromUser.id)) {
      await telegram.answerCallbackQuery(callbackQueryId, "Ты уже в игре!");
      return;
    }
    if (state.players.length >= MAX_PLAYERS) {
      await telegram.answerCallbackQuery(callbackQueryId, "Лобби заполнено.", true);
      return;
    }
    const updated = [
      ...state.players,
      {
        id: fromUser.id,
        name: fromUser.name,
        wasExplainer: false,
        wasGuesser: false,
        score: 0,
      },
    ];
    const newState = { ...state, players: updated };
    await updateSessionState(ctx.admin, session.id, serialState(newState));
    await telegram.answerCallbackQuery(callbackQueryId, "Ты в игре! 🚫");
    await refreshLobby(ctx, session, newState);
    return;
  }

  if (action === "startnow") {
    if (state.phase !== "lobby") {
      await telegram.answerCallbackQuery(callbackQueryId, "Игра уже началась.", true);
      return;
    }
    if (session.created_by && fromUser.id !== session.created_by) {
      await telegram.answerCallbackQuery(callbackQueryId, "Начать может только организатор.", true);
      return;
    }
    if (state.players.length < MIN_PLAYERS) {
      await telegram.answerCallbackQuery(
        callbackQueryId,
        `Нужно минимум ${MIN_PLAYERS} игроков.`,
        true,
      );
      return;
    }
    await telegram.answerCallbackQuery(callbackQueryId, "Погнали!");
    if (state.lobbyMessageId) {
      await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.lobbyMessageId, undefined);
    }
    await beginRound(ctx, session, state, 1);
    return;
  }

  if (action === "mine") {
    if (state.phase !== "setup_mines" || !state.round) {
      await telegram.answerCallbackQuery(callbackQueryId, "Сейчас не время для мин.", true);
      return;
    }
    const mine = state.round.mines.find((m) => m.userId === fromUser.id && !m.word);
    if (!mine) {
      await telegram.answerCallbackQuery(callbackQueryId, "Ты уже отправил мину или не минёр.", true);
      return;
    }
    const idx = Number(payload);
    const word = mine.suggestions?.[idx];
    if (!word) {
      await telegram.answerCallbackQuery(callbackQueryId, "Неверная кнопка.", true);
      return;
    }
    await telegram.answerCallbackQuery(callbackQueryId, `Мина: ${word}`);
    await submitMinerWord(ctx, session, state, fromUser.id, word, fromUser.id);
    return;
  }

  if (action === "leave") {
    if (state.phase !== "lobby") {
      await telegram.answerCallbackQuery(callbackQueryId, "Из начавшейся игры уже не выйти.", true);
      return;
    }
    if (!state.players.some((p) => p.id === fromUser.id)) {
      await telegram.answerCallbackQuery(callbackQueryId, "Тебя и так нет в лобби.");
      return;
    }
    const updated = state.players.filter((p) => p.id !== fromUser.id);
    const newState = { ...state, players: updated };
    await updateSessionState(ctx.admin, session.id, serialState(newState));
    await telegram.answerCallbackQuery(callbackQueryId, "Вышел из лобби.");
    await refreshLobby(ctx, session, newState);
    return;
  }

  if (action === "boom") {
    if (state.phase !== "playing" || !state.round) {
      await telegram.answerCallbackQuery(callbackQueryId, "Сейчас не время для мин.", true);
      return;
    }
    const mine = state.round.mines.find((m) => m.userId === fromUser.id);
    if (!mine) {
      await telegram.answerCallbackQuery(callbackQueryId, "Ты не минёр в этом раунде.", true);
      return;
    }
    if (mine.detonated) {
      await telegram.answerCallbackQuery(callbackQueryId, "Твоя мина уже сработала.", true);
      return;
    }
    const now = new Date().toISOString();
    const beforeGuess = !state.round.guessedAt;
    const mines = state.round.mines.map((m) =>
      m.userId === fromUser.id ? { ...m, detonated: true } : m,
    );
    const explosions = [
      ...state.round.explosions,
      { minerId: fromUser.id, at: now, beforeGuess },
    ];
    const newRound = { ...state.round, mines, explosions };
    const newState = { ...state, round: newRound };
    await updateSessionState(ctx.admin, session.id, serialState(newState));
    await telegram.answerCallbackQuery(callbackQueryId, "💥 Бабах!");
    await telegram.sendMessage(ctx.telegramChatId, "💥 <b>Мина сработала!</b>");
    await refreshRoundMessage(ctx, session, newState);
    return;
  }

  if (action === "word") {
    if (!state.round || state.round.explainerId !== fromUser.id) {
      await telegram.answerCallbackQuery(callbackQueryId, "Это не для тебя.", true);
      return;
    }
    await telegram.answerCallbackQuery(callbackQueryId, state.round.word);
    await telegram.sendMessage(fromUser.id, `🚫 Секретное слово: <b>${state.round.word}</b>`);
    return;
  }
}

export async function handleTabooMessage(
  ctx: GameCtx,
  session: GameSession,
  message: { from?: { id: number }; text?: string },
): Promise<boolean> {
  const state = session.state as TabooState;
  if (state.phase !== "playing" || !state.round || !message.text) return false;
  const fromId = message.from?.id;
  if (!fromId || fromId !== state.round.guesserId) return false;
  if (state.round.guessedAt) return false;
  if (!containsWord(message.text, state.round.word)) return false;

  const now = new Date().toISOString();
  const newRound: TabooRound = {
    ...state.round,
    guessedAt: now,
    winnerId: fromId,
  };
  await updateSessionState(ctx.admin, session.id, serialState({ ...state, round: newRound }));
  await endRound(ctx, session, { ...state, round: newRound });
  return true;
}

export async function handleTabooPrivateMessage(
  admin: SupabaseClient,
  telegramUserId: number,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.startsWith("/")) return false;

  const { data: sessions } = await admin
    .from("game_sessions")
    .select("*, chats!inner(telegram_chat_id)")
    .eq("type", "taboo")
    .eq("status", "active");

  for (const raw of sessions ?? []) {
    const state = raw.state as TabooState;
    if (state.phase !== "setup_mines" || !state.round) continue;
    const mine = state.round.mines.find((m) => m.userId === telegramUserId && !m.word);
    if (!mine) continue;

    const word = trimmed.split(/\s+/).slice(0, 4).join(" ");
    const ctx: GameCtx = {
      admin,
      chatId: raw.chat_id,
      telegramChatId: (raw as any).chats.telegram_chat_id,
      lang: "ru",
    };
    const session = raw as GameSession;
    if (await submitMinerWord(ctx, session, state, telegramUserId, word)) return true;
  }
  return false;
}

export async function resendTabooCard(
  admin: GameCtx["admin"],
  session: GameSession,
  telegramUserId: number,
) {
  const state = session.state as TabooState;
  const round = state.round;
  if (!round) {
    await telegram.sendMessage(telegramUserId, "Сейчас нет активного раунда Табу.");
    return;
  }
  if (round.explainerId === telegramUserId) {
    await telegram.sendMessage(
      telegramUserId,
      `🚫 Секретное слово: <b>${round.word}</b>\nОбъясни его ${round.guesserName} в группе.`,
      {
        reply_markup: inlineKeyboard([
          [{ text: "📋 Показать слово", callback_data: packCallback(session.short_code, "word") }],
        ]),
      },
    );
    return;
  }
  const mine = round.mines.find((m) => m.userId === telegramUserId);
  if (mine) {
    if (state.phase === "setup_mines" && !mine.word) {
      const suggestions = mine.suggestions?.length
        ? mine.suggestions
        : pickMineSuggestions(round.word);
      await telegram.sendMessage(
        telegramUserId,
        `💣 Секретное слово: <b>${round.word}</b>\nВыбери мину кнопкой или напиши своё.`,
        { reply_markup: mineSetupKeyboard(session.short_code, suggestions) },
      );
    } else if (state.phase === "playing" && !mine.detonated) {
      await telegram.sendMessage(telegramUserId, `💣 Мина заряжена! Следи за объяснением.`, {
        reply_markup: inlineKeyboard([
          [{ text: "💣 Взорвать мину!", callback_data: packCallback(session.short_code, "boom") }],
        ]),
      });
    }
    return;
  }
  if (round.guesserId === telegramUserId) {
    await telegram.sendMessage(
      telegramUserId,
      "🎯 Ты Угадывающий — слово не знаешь, слушай объяснение в группе и пиши варианты.",
    );
  }
}

export async function tickTabooSession(admin: SupabaseClient, session: any) {
  if (!isSessionDue(session.state)) return;

  const ctx: GameCtx = {
    admin,
    chatId: session.chat_id,
    telegramChatId: session.chats.telegram_chat_id,
    lang: "ru",
  };
  const state = session.state as TabooState;
  const gameSession = session as GameSession;

  if (state.phase === "lobby") {
    if (state.players.length >= MIN_PLAYERS) {
      if (state.lobbyMessageId) {
        await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.lobbyMessageId, undefined);
      }
      await beginRound(ctx, gameSession, state, 1);
    } else {
      await finishSession(admin, session.id, serialState(state));
      if (state.lobbyMessageId) {
        await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.lobbyMessageId, undefined);
      }
      await telegram.sendMessage(
        ctx.telegramChatId,
        `Недостаточно игроков для Табу (нужно ${MIN_PLAYERS}+) 🤷`,
      );
    }
    return;
  }

  if (state.phase === "setup_mines" && state.round) {
    const mines = state.round.mines.map((m) =>
      m.word ? m : { ...m, word: "(авто-мина)", suggestions: m.suggestions ?? [] },
    );
    const patched: TabooState = { ...state, round: { ...state.round, mines } };
    await updateSessionState(admin, session.id, serialState(patched));
    await beginPlaying(ctx, gameSession, patched);
    return;
  }

  if (state.phase === "playing" && state.round) {
    await endRound(ctx, gameSession, state);
  }
}

export async function tickTaboo(admin: SupabaseClient) {
  const { data: sessions } = await admin
    .from("game_sessions")
    .select("*, chats!inner(telegram_chat_id)")
    .eq("type", "taboo")
    .in("status", ["waiting", "active"]);

  for (const session of sessions ?? []) {
    try {
      await tickTabooSession(admin, session);
    } catch (e) {
      console.error(`taboo tick failed for session ${session.id}`, e);
    }
  }
}
