/**
 * Telegram approve loop.
 *
 * This is the human gate. The pipeline detects and ranks; a person decides.
 * Design constraint from the user's situation: they're at an in-person
 * internship, so the interaction has to survive being a 15-second glance at a
 * phone. One card per job, two buttons, no typing.
 *
 * Deliberately NOT auto-submitting. Applying is outward-facing and effectively
 * irreversible — a bad application can't be recalled and burns that company.
 */

import { getJson, postJson } from "./util/http.js";

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

function token() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return t;
}
function chatId() {
  const c = process.env.TELEGRAM_CHAT_ID;
  if (!c)
    throw new Error(
      "TELEGRAM_CHAT_ID not set (send /start to the bot, then re-run)",
    );
  return c;
}

/** Telegram's MarkdownV2 escapes an aggressive set; miss one and the send 400s. */
export function esc(s = "") {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

export async function send(text, { keyboard, disablePreview = true } = {}) {
  const body = {
    chat_id: chatId(),
    text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: disablePreview,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };

  const res = await postJson(API(token(), "sendMessage"), body, {
    timeout: 20_000,
  });
  if (res.status !== "ok" || res.data?.ok === false) {
    throw new Error(
      `telegram send: ${res.data?.description || res.error || res.httpStatus}`,
    );
  }
  return res.data.result;
}

/**
 * One job card. Everything needed to decide without opening the link:
 * fit, why, sponsorship, freshness, location.
 */
export function renderCard(job) {
  const s = job.llmScore || {};
  const co = job.companyName || job.companyToken;
  const sp = job.sponsorship || {};

  const ageMs = job.claimedLagMs;
  const age =
    ageMs == null
      ? "age unknown"
      : ageMs < 3600_000
        ? `${Math.round(ageMs / 60000)}m old`
        : ageMs < 86400_000
          ? `${(ageMs / 3600_000).toFixed(1)}h old`
          : `${(ageMs / 86400_000).toFixed(1)}d old`;

  const sponsor =
    sp.status === "strong"
      ? `sponsors \\(${sp.h1bApprovals} H\\-1B\\)`
      : sp.status === "cap_exempt"
        ? "cap\\-exempt \\(no lottery\\)"
        : sp.status === "yes"
          ? `sponsored before \\(${sp.h1bApprovals}\\)`
          : "no H\\-1B record";

  const phx = job.screen?.location?.phoenix ? " 📍PHX" : "";
  const loc = (job.locations || [])[0] || "location unknown";

  return [
    `*${esc(String(s.fit ?? "?"))}* · ${esc(String(s.verdict ?? ""))} · _${esc(String(s.family ?? job.screen?.roleFamily ?? ""))}_`,
    `*${esc(job.title)}*`,
    `${esc(co)} — ${esc(loc)}${phx}`,
    `${esc(age)} · ${sponsor}`,
    s.reasons?.[0] ? `\n_${esc(String(s.reasons[0]).slice(0, 180))}_` : "",
    `\n[open posting](${job.applyUrl})`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** callback_data caps at 64 bytes; a Mongo ObjectId hex is 24, so this fits. */
export function decisionKeyboard(jobId) {
  return [
    [
      { text: "✅ Apply", callback_data: `a:${jobId}` },
      { text: "⏭ Skip", callback_data: `s:${jobId}` },
    ],
  ];
}

export async function getUpdates(offset, timeoutSec = 25) {
  const url = `${API(token(), "getUpdates")}?timeout=${timeoutSec}${offset ? `&offset=${offset}` : ""}`;
  // Long-poll: the socket must outlive the server-side wait or it aborts early.
  const res = await getJson(url, { timeout: (timeoutSec + 10) * 1000 });
  if (res.status !== "ok") {
    // 409 means another process is already long-polling this bot token. Telegram
    // allows exactly one getUpdates consumer, and when there are two they split
    // the updates between them at random — so roughly half the button presses
    // vanish into whichever process is not writing to the database. It looks
    // identical to "the buttons do not work", so it is named explicitly.
    if (res.httpStatus === 409)
      throw new Error(
        "telegram getUpdates: 409 Conflict — another process is polling this " +
          "bot. Only one may. Stop the other loop (or any stray script calling " +
          "getUpdates) and retry.",
      );
    throw new Error(`telegram getUpdates: ${res.error || res.httpStatus}`);
  }
  return res.data?.result || [];
}

/** Clears the button's spinner. Without this the client shows a stuck loading state. */
export async function answerCallback(id, text = "") {
  await postJson(
    API(token(), "answerCallbackQuery"),
    { callback_query_id: id, text, show_alert: false },
    { timeout: 15_000 },
  );
}

/** Rewrite the card in place so a decided job visibly leaves the queue. */
export async function editCard(messageId, text) {
  await postJson(
    API(token(), "editMessageText"),
    {
      chat_id: chatId(),
      message_id: messageId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true,
    },
    { timeout: 15_000 },
  );
}

export async function whoAmI() {
  const res = await getJson(API(token(), "getMe"), { timeout: 15_000 });
  return res.data?.result || null;
}
