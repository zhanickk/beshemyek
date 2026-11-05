import type { SupabaseClient } from "@supabase/supabase-js";
import { pickRandomMembers } from "@/lib/economy.server";
import predictionsRaw from "@/data/predictions.txt?raw";

export type PredictionMember = {
  telegram_user_id: number;
  username: string | null;
  display_name: string | null;
};

type ParsedTemplate = {
  body: string;
  slots: number;
};

const SLOT_RE = /\{user(\d+)?\}/g;

function mergeRawLines(lines: string[]): string[] {
  const merged: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const parts = [lines[i]];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      const prev = parts[parts.length - 1];
      if (next.startsWith("@") || next === "." || next === ",") {
        parts.push(next);
        i += 1;
      } else if (!/[.!?…]$/.test(prev) && next.length <= 2) {
        parts.push(next);
        i += 1;
      } else {
        break;
      }
    }
    merged.push(parts.join(" ").replace(/\s+/g, " ").trim());
  }
  return merged;
}

function normalizeSlots(body: string): { body: string; slots: number } {
  let slotIdx = 0;
  const withPlaceholders = body.replace(/@(\w+)/g, () => {
    slotIdx += 1;
    return slotIdx === 1 ? "{user}" : `{user${slotIdx}}`;
  });
  const explicitSlots = [...withPlaceholders.matchAll(SLOT_RE)].map((m) =>
    m[1] ? Number(m[1]) : 1,
  );
  const slots = explicitSlots.length ? Math.max(...explicitSlots) : 0;
  return { body: withPlaceholders, slots };
}

function parseTemplates(raw: string): ParsedTemplate[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return mergeRawLines(lines).map((body) => normalizeSlots(body));
}

const TEMPLATES = parseTemplates(predictionsRaw);
const PERSONAL_TEMPLATES = TEMPLATES.filter((t) => t.slots === 0);
const SLOT_TEMPLATES = TEMPLATES.filter((t) => t.slots > 0);

function pickOne<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function memberLabel(m: PredictionMember): string {
  return m.display_name || (m.username ? `@${m.username}` : `#${m.telegram_user_id}`);
}

function renderTemplate(body: string, members: PredictionMember[]): string {
  return body.replace(SLOT_RE, (_, num) => {
    const idx = num ? Number(num) - 1 : 0;
    const member = members[idx];
    return member ? memberLabel(member) : "кто-то";
  });
}

async function resolveSlotMembers(
  admin: SupabaseClient,
  chatId: string,
  count: number,
  preferred: PredictionMember[],
  excludeIds: Set<number>,
): Promise<PredictionMember[]> {
  const picked: PredictionMember[] = [];
  const used = new Set<number>(excludeIds);

  for (const member of preferred) {
    if (picked.length >= count) break;
    if (used.has(member.telegram_user_id)) continue;
    picked.push(member);
    used.add(member.telegram_user_id);
  }

  if (picked.length >= count) return picked;

  const random = await pickRandomMembers(admin, chatId, count * 3);
  for (const member of random) {
    if (picked.length >= count) break;
    if (used.has(member.telegram_user_id)) continue;
    picked.push(member);
    used.add(member.telegram_user_id);
  }

  return picked;
}

export type BeshemekPredictionRequest = {
  admin: SupabaseClient;
  chatId: string | null;
  invoker: PredictionMember;
  targets?: PredictionMember[];
};

export async function generateBeshemekPrediction(
  req: BeshemekPredictionRequest,
): Promise<{ intro: string; text: string }> {
  const subject = req.targets?.[0] ?? req.invoker;
  const subjectName = memberLabel(subject);
  const preferred = [...(req.targets ?? []), req.invoker];
  const excludeBots = new Set<number>();

  const canUseSlots = !!req.chatId && SLOT_TEMPLATES.length > 0;
  const pool =
    canUseSlots && Math.random() < 0.35
      ? SLOT_TEMPLATES
      : PERSONAL_TEMPLATES.length
        ? PERSONAL_TEMPLATES
        : TEMPLATES;

  for (let attempt = 0; attempt < 10; attempt++) {
    const template = pickOne(pool);
    if (template.slots > 0 && req.chatId) {
      const members = await resolveSlotMembers(
        req.admin,
        req.chatId,
        template.slots,
        preferred,
        excludeBots,
      );
      if (members.length < template.slots) continue;
      return {
        intro: "🔮 <b>Предсказание от Бешемека:</b>",
        text: renderTemplate(template.body, members),
      };
    }

    return {
      intro: `🔮 <b>Предсказание от Бешемека для ${subjectName}:</b>`,
      text: template.body,
    };
  }

  const fallback = pickOne(PERSONAL_TEMPLATES.length ? PERSONAL_TEMPLATES : TEMPLATES);
  return {
    intro: `🔮 <b>Предсказание от Бешемека для ${subjectName}:</b>`,
    text: fallback.body,
  };
}

export function predictionMemberFromTg(user: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}): PredictionMember {
  const display = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return {
    telegram_user_id: user.id,
    username: user.username ?? null,
    display_name: display || null,
  };
}

export async function resolvePredictionTargets(
  admin: SupabaseClient,
  chatId: string,
  replyUser?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
    is_bot?: boolean;
  } | null,
  commandRest?: string,
): Promise<PredictionMember[]> {
  const seen = new Set<number>();
  const targets: PredictionMember[] = [];

  const push = (member: PredictionMember) => {
    if (seen.has(member.telegram_user_id)) return;
    seen.add(member.telegram_user_id);
    targets.push(member);
  };

  if (replyUser && !replyUser.is_bot) push(predictionMemberFromTg(replyUser));

  const mentions = [...(commandRest ?? "").matchAll(/@([A-Za-z0-9_]{4,})/g)].map((m) => m[1]);
  for (const username of mentions) {
    const { data } = await admin
      .from("chat_members")
      .select("telegram_user_id, username, display_name")
      .eq("chat_id", chatId)
      .eq("username", username)
      .maybeSingle();
    if (data) push(data);
  }

  return targets;
}
