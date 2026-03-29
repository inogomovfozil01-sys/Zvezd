"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const TelegramBot = require("node-telegram-bot-api");

dotenv.config();

const REQUIRED_ENV = ["BOT_TOKEN", "ADMIN_ID", "CHANNEL_ID", "BOT_USERNAME", "VOTE_URL"];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const ADMIN_ID = Number(process.env.ADMIN_ID);
const CHANNEL_ID = process.env.CHANNEL_ID;
const BOT_USERNAME = process.env.BOT_USERNAME;
const VOTE_URL = process.env.VOTE_URL;

if (!Number.isInteger(ADMIN_ID)) {
  throw new Error("ADMIN_ID must be a valid integer.");
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const ADMIN_FLOW = {
  IDLE: "idle",
  WAIT_END_AT: "wait_end_at",
  WAIT_PRIZE: "wait_prize",
  WAIT_CONFIRM: "wait_confirm"
};

const GIVEAWAY_STATUS = {
  NONE: "none",
  COLLECTING: "collecting",
  VOTING: "voting",
  FINISHED: "finished"
};

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(STATE_FILE)) {
    saveState(createDefaultState());
  }
}

function createDefaultState() {
  return {
    adminFlow: {
      step: ADMIN_FLOW.IDLE,
      draft: null
    },
    giveaway: {
      status: GIVEAWAY_STATUS.NONE,
      createdAt: null,
      endAtText: "",
      pollEndAtText: "",
      prizeStars: 0,
      participantsLimit: 10,
      participants: [],
      announcementMessageId: null,
      pollMessageId: null,
      pollId: null,
      pollOptions: [],
      winner: null
    }
  };
}

function loadState() {
  ensureStorage();
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  ensureStorage();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();
let finishVotingTimer = null;

function resetAdminFlow() {
  state.adminFlow = {
    step: ADMIN_FLOW.IDLE,
    draft: null
  };
}

function resetGiveaway() {
  state.giveaway = {
    status: GIVEAWAY_STATUS.NONE,
    createdAt: null,
    endAtText: "",
    pollEndAtText: "",
    prizeStars: 0,
    participantsLimit: 10,
    participants: [],
    announcementMessageId: null,
    pollMessageId: null,
    pollId: null,
    pollOptions: [],
    winner: null
  };
}

function clearFinishVotingTimer() {
  if (finishVotingTimer) {
    clearTimeout(finishVotingTimer);
    finishVotingTimer = null;
  }
}

function parseDateInput(value) {
  const trimmed = String(value).trim();
  const match = trimmed.match(
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/
  );

  if (!match) {
    return null;
  }

  const [, dayRaw, monthRaw, yearRaw, hourRaw = "0", minuteRaw = "0"] = match;
  const day = Number(dayRaw);
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }

  return date;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isAdmin(chatId) {
  return Number(chatId) === ADMIN_ID;
}

function getAdminKeyboard() {
  if (state.giveaway.status === GIVEAWAY_STATUS.COLLECTING) {
    return {
      reply_markup: {
        inline_keyboard: [[{ text: "Запустить", callback_data: "admin_launch_vote" }]]
      },
      parse_mode: "HTML"
    };
  }

  return {
    reply_markup: {
      inline_keyboard: [[{ text: "Создать розыгрыш", callback_data: "admin_create_giveaway" }]]
    },
    parse_mode: "HTML"
  };
}

function getParticipantButton() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "Участвую", callback_data: "join_giveaway" }]]
    },
    parse_mode: "HTML"
  };
}

function getParticipantTag(user) {
  if (user.username) {
    return `@${user.username}`;
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || `ID ${user.id}`;
}

function getMentionLink(user) {
  const title = getParticipantTag(user);
  return `<a href="tg://user?id=${user.id}">${escapeHtml(title)}</a>`;
}

function buildAnnouncementText() {
  return [
    "<b>Дорогие друзья, объявляем новый розыгрыш!</b>",
    "",
    "<b>Количество мест:</b> 10",
    `<b>Приз:</b> ${escapeHtml(state.giveaway.prizeStars)} ⭐`,
    `<b>Завершение розыгрыша:</b> ${escapeHtml(state.giveaway.endAtText)}`,
    "",
    "Чтобы принять участие:",
    `1. Перейдите в бота ${escapeHtml(BOT_USERNAME)}`,
    "2. Нажмите <b>/start</b>",
    "3. Нажмите кнопку <b>Участвую</b>",
    "",
    "<i>После набора 10 участников мы откроем голосование и объявим победителя.</i>"
  ].join("\n");
}

function buildAdminDraftText(draft) {
  return [
    "<b>Проверь данные розыгрыша</b>",
    "",
    `<b>Когда завершится розыгрыш:</b> ${escapeHtml(draft.endAtText)}`,
    `<b>Приз:</b> ${escapeHtml(draft.prizeStars)} ⭐`,
    "",
    "Если всё верно, подтверди запуск анонса."
  ].join("\n");
}

function buildVotingText(participants) {
  const lines = [
    "<b>Дорогие друзья, стартует голосование!</b>",
    "",
    "Ниже участники текущего розыгрыша. Вы можете проголосовать за того, кого хотите поддержать.",
    "",
    "<b>Участники:</b>"
  ];

  participants.forEach((participant, index) => {
    lines.push(`${index + 1}. ${escapeHtml(participant.displayName)}`);
  });

  lines.push("");
  lines.push(`Голосовать: <a href="${escapeHtml(VOTE_URL)}">${escapeHtml(VOTE_URL)}</a>`);
  lines.push(`Бот: ${escapeHtml(BOT_USERNAME)}`);
  lines.push(`<b>Администратор:</b> <code>${ADMIN_ID}</code>`);
  lines.push(`<b>Окончание голосования:</b> ${escapeHtml(state.giveaway.endAtText)}`);

  return lines.join("\n");
}

function buildWinnerText(winner) {
  return [
    "<b>Розыгрыш завершен!</b>",
    "",
    `<b>Победитель:</b> ${winner}`,
    `<b>Приз:</b> ${escapeHtml(state.giveaway.prizeStars)} ⭐`,
    "",
    "Спасибо всем, кто участвовал и голосовал. Следите за новыми розыгрышами в канале."
  ].join("\n");
}

function buildNoGiveawayText() {
  return [
    "🎁 <b>Сейчас активного набора нет.</b>",
    "",
    "Следите за нашим каналом. Как только стартует новый розыгрыш, мы сразу опубликуем объявление."
  ].join("\n");
}

function buildCollectingText() {
  return [
    "✨ <b>Привет!</b>",
    "",
    "Хочешь участвовать в розыгрыше? Нажимай на кнопку ниже и занимай место среди участников."
  ].join("\n");
}

function buildVotingStartedText() {
  return [
    "🗳 <b>Сейчас идет розыгрыш.</b>",
    "",
    "Набор уже завершен, а голосование запущено. Следите за результатами в канале."
  ].join("\n");
}

function buildJoinedText() {
  return [
    "✅ <b>Заявка принята.</b>",
    "",
    "Ты нажал на кнопку участия. Я сообщу тебе, когда тебя добавят в голосование."
  ].join("\n");
}

function buildAlreadyJoinedText() {
  return [
    "✅ <b>Ты уже в списке участников.</b>",
    "",
    "Дождись старта голосования, мы отдельно напишем тебе в личные сообщения."
  ].join("\n");
}

async function sendAdminHome(chatId) {
  return bot.sendMessage(
    chatId,
    "Привет, бро. Ниже кнопка для управления розыгрышем.",
    getAdminKeyboard()
  );
}

async function startGiveawayAnnouncement(chatId) {
  state.giveaway.status = GIVEAWAY_STATUS.COLLECTING;
  state.giveaway.createdAt = new Date().toISOString();
  state.giveaway.endAtText = state.adminFlow.draft.endAtText;
  state.giveaway.pollEndAtText = state.adminFlow.draft.endAtText;
  state.giveaway.prizeStars = state.adminFlow.draft.prizeStars;
  saveState(state);

  const sent = await bot.sendMessage(CHANNEL_ID, buildAnnouncementText(), { parse_mode: "HTML" });
  state.giveaway.announcementMessageId = sent.message_id;
  resetAdminFlow();
  saveState(state);

  await bot.sendMessage(chatId, "Розыгрыш опубликован. Теперь идет набор участников.", getAdminKeyboard());
}

async function notifyParticipantsVotingStarted() {
  const tasks = state.giveaway.participants.map((participant) =>
    bot
      .sendMessage(
        participant.id,
        [
          "📢 <b>Ты участвуешь в розыгрыше.</b>",
          "",
          "Просим пока не менять свой username до завершения голосования, чтобы участникам было проще тебя узнать."
        ].join("\n"),
        { parse_mode: "HTML" }
      )
      .catch(() => null)
  );

  await Promise.all(tasks);
}

async function launchVoting(chatId) {
  if (state.giveaway.status !== GIVEAWAY_STATUS.COLLECTING) {
    await bot.sendMessage(chatId, "Сейчас нет активного набора, который можно запустить.");
    return;
  }

  if (state.giveaway.participants.length < state.giveaway.participantsLimit) {
    await bot.sendMessage(
      chatId,
      `Пока недостаточно участников. Сейчас: ${state.giveaway.participants.length}/${state.giveaway.participantsLimit}.`
    );
    return;
  }

  const options = state.giveaway.participants.map((participant) => participant.pollLabel);
  const pollText = buildVotingText(state.giveaway.participants);
  const poll = await bot.sendPoll(CHANNEL_ID, "Выберите участника розыгрыша", options, {
    is_anonymous: false,
    allows_multiple_answers: false
  });

  await bot.sendMessage(CHANNEL_ID, pollText, { parse_mode: "HTML", disable_web_page_preview: true });
  await notifyParticipantsVotingStarted();

  state.giveaway.status = GIVEAWAY_STATUS.VOTING;
  state.giveaway.pollMessageId = poll.message_id;
  state.giveaway.pollId = poll.poll.id;
  state.giveaway.pollOptions = options;
  saveState(state);
  scheduleVotingFinish();

  await bot.sendMessage(chatId, "Голосование запущено и опубликовано в канале.");
}

function getWinnerFromPoll(poll) {
  let winnerIndex = 0;
  let maxVotes = -1;

  poll.options.forEach((option, index) => {
    if (option.voter_count > maxVotes) {
      maxVotes = option.voter_count;
      winnerIndex = index;
    }
  });

  return state.giveaway.participants[winnerIndex];
}

async function finalizeVotingResult(poll) {
  if (
    state.giveaway.status !== GIVEAWAY_STATUS.VOTING ||
    !state.giveaway.pollId ||
    poll.id !== state.giveaway.pollId
  ) {
    return;
  }

  const winner = getWinnerFromPoll(poll);
  if (!winner) {
    return;
  }

  clearFinishVotingTimer();

  const winnerMention = getMentionLink(winner.user);
  await bot.sendMessage(CHANNEL_ID, buildWinnerText(winnerMention), { parse_mode: "HTML" });

  const adminKeyboard = {
    inline_keyboard: [[{ text: "Открыть чат победителя", url: `tg://user?id=${winner.id}` }]]
  };

  await bot.sendMessage(
    ADMIN_ID,
    [
      "<b>Розыгрыш завершен.</b>",
      "",
      `<b>Победитель:</b> ${winnerMention}`,
      `<b>Голоса:</b> ${poll.options[winner.index].voter_count}`
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: adminKeyboard
    }
  );

  state.giveaway.status = GIVEAWAY_STATUS.FINISHED;
  state.giveaway.winner = {
    id: winner.id,
    displayName: winner.displayName
  };
  saveState(state);

  resetGiveaway();
  saveState(state);
}

async function stopPollAndFinalize() {
  if (state.giveaway.status !== GIVEAWAY_STATUS.VOTING || !state.giveaway.pollMessageId) {
    return;
  }

  const poll = await bot.stopPoll(CHANNEL_ID, state.giveaway.pollMessageId).catch(() => null);
  if (poll) {
    await finalizeVotingResult(poll);
  }
}

function scheduleVotingFinish() {
  clearFinishVotingTimer();

  if (state.giveaway.status !== GIVEAWAY_STATUS.VOTING) {
    return;
  }

  const finishAt = parseDateInput(state.giveaway.pollEndAtText);
  if (!finishAt) {
    return;
  }

  const delay = finishAt.getTime() - Date.now();
  if (delay <= 0) {
    stopPollAndFinalize().catch(() => null);
    return;
  }

  finishVotingTimer = setTimeout(() => {
    stopPollAndFinalize().catch(() => null);
  }, delay);
}

async function handleAdminMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (text === "/start") {
    resetAdminFlow();
    saveState(state);
    await sendAdminHome(chatId);
    return;
  }

  if (state.adminFlow.step === ADMIN_FLOW.WAIT_END_AT) {
    const parsedDate = parseDateInput(text);
    if (!parsedDate || parsedDate.getTime() <= Date.now()) {
      await bot.sendMessage(
        chatId,
        "Отправь дату в формате `30.03.2026 20:00`, и она должна быть в будущем.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    state.adminFlow.step = ADMIN_FLOW.WAIT_PRIZE;
    state.adminFlow.draft = { endAtText: text, prizeStars: 0 };
    saveState(state);
    await bot.sendMessage(chatId, "Напиши, на сколько звезд будет розыгрыш. Например: 500");
    return;
  }

  if (state.adminFlow.step === ADMIN_FLOW.WAIT_PRIZE) {
    const stars = Number(text.replace(/[^\d]/g, ""));
    if (!Number.isFinite(stars) || stars <= 0) {
      await bot.sendMessage(chatId, "Нужно отправить число звезд, например: 500");
      return;
    }

    state.adminFlow.step = ADMIN_FLOW.WAIT_CONFIRM;
    state.adminFlow.draft.prizeStars = stars;
    saveState(state);

    await bot.sendMessage(chatId, buildAdminDraftText(state.adminFlow.draft), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Подтвердить", callback_data: "admin_confirm_giveaway" }],
          [{ text: "Отмена", callback_data: "admin_cancel_giveaway" }]
        ]
      }
    });
  }
}

async function handleUserStart(chatId) {
  if (state.giveaway.status === GIVEAWAY_STATUS.COLLECTING) {
    await bot.sendMessage(chatId, buildCollectingText(), getParticipantButton());
    return;
  }

  if (state.giveaway.status === GIVEAWAY_STATUS.VOTING) {
    await bot.sendMessage(chatId, buildVotingStartedText(), { parse_mode: "HTML" });
    return;
  }

  await bot.sendMessage(chatId, buildNoGiveawayText(), { parse_mode: "HTML" });
}

async function registerParticipant(query) {
  const chatId = query.message.chat.id;
  const user = query.from;

  if (state.giveaway.status !== GIVEAWAY_STATUS.COLLECTING) {
    await bot.answerCallbackQuery(query.id, { text: "Сейчас нет активного набора." });
    await bot.sendMessage(chatId, buildNoGiveawayText(), { parse_mode: "HTML" });
    return;
  }

  const existing = state.giveaway.participants.find((participant) => participant.id === user.id);
  if (existing) {
    await bot.answerCallbackQuery(query.id, { text: "Ты уже участвуешь." });
    await bot.editMessageText(buildAlreadyJoinedText(), {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "HTML"
    }).catch(() => null);
    return;
  }

  if (state.giveaway.participants.length >= state.giveaway.participantsLimit) {
    await bot.answerCallbackQuery(query.id, { text: "Набор уже завершен." });
    await bot.sendMessage(chatId, buildVotingStartedText(), { parse_mode: "HTML" });
    return;
  }

  const displayName = getParticipantTag(user);
  const pollLabel = user.username
    ? `@${user.username}`.slice(0, 99)
    : displayName.slice(0, 99);

  state.giveaway.participants.push({
    id: user.id,
    index: state.giveaway.participants.length,
    displayName,
    pollLabel,
    user: {
      id: user.id,
      username: user.username || "",
      first_name: user.first_name || "",
      last_name: user.last_name || ""
    }
  });
  saveState(state);

  await bot.answerCallbackQuery(query.id, { text: "Ты добавлен в список участников." });
  await bot.editMessageText(buildJoinedText(), {
    chat_id: chatId,
    message_id: query.message.message_id,
    parse_mode: "HTML"
  }).catch(() => null);

  await bot.sendMessage(
    ADMIN_ID,
    `Новый участник: ${displayName}\nСобрано: ${state.giveaway.participants.length}/${state.giveaway.participantsLimit}`,
    { parse_mode: "HTML" }
  ).catch(() => null);

  if (state.giveaway.participants.length === state.giveaway.participantsLimit) {
    await bot.sendMessage(
      ADMIN_ID,
      "Собрано 10 участников. Запускаю голосование автоматически.",
      getAdminKeyboard()
    ).catch(() => null);

    await launchVoting(ADMIN_ID);
  }
}

bot.onText(/^\/start$/, async (msg) => {
  if (isAdmin(msg.chat.id)) {
    await handleAdminMessage(msg);
    return;
  }

  await handleUserStart(msg.chat.id);
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) {
    return;
  }

  if (!isAdmin(msg.chat.id)) {
    return;
  }

  await handleAdminMessage(msg);
});

bot.on("callback_query", async (query) => {
  const action = query.data;
  const chatId = query.message.chat.id;

  if (action === "admin_create_giveaway" && isAdmin(chatId)) {
    if (state.giveaway.status === GIVEAWAY_STATUS.COLLECTING || state.giveaway.status === GIVEAWAY_STATUS.VOTING) {
      await bot.answerCallbackQuery(query.id, { text: "Сначала заверши текущий розыгрыш." });
      return;
    }

    resetGiveaway();
    state.adminFlow = { step: ADMIN_FLOW.WAIT_END_AT, draft: null };
    saveState(state);

    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, "Напиши, когда закончится набор участников. Например: 30.03.2026 20:00");
    return;
  }

  if (action === "admin_confirm_giveaway" && isAdmin(chatId)) {
    if (state.adminFlow.step !== ADMIN_FLOW.WAIT_CONFIRM || !state.adminFlow.draft) {
      await bot.answerCallbackQuery(query.id, { text: "Черновик розыгрыша не найден." });
      return;
    }

    await bot.answerCallbackQuery(query.id, { text: "Публикую..." });
    await startGiveawayAnnouncement(chatId);
    return;
  }

  if (action === "admin_cancel_giveaway" && isAdmin(chatId)) {
    resetAdminFlow();
    saveState(state);
    await bot.answerCallbackQuery(query.id, { text: "Создание отменено." });
    await sendAdminHome(chatId);
    return;
  }

  if (action === "admin_launch_vote" && isAdmin(chatId)) {
    await bot.answerCallbackQuery(query.id, { text: "Проверяю участников..." });
    await launchVoting(chatId);
    return;
  }

  if (action === "join_giveaway") {
    await registerParticipant(query);
  }
});

bot.on("poll", async (poll) => {
  if (!poll.is_closed) {
    return;
  }

  await finalizeVotingResult(poll);
});

bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message);
});

scheduleVotingFinish();

console.log("Bot is running...");
