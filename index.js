"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

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
const DATABASE_URL = process.env.DATABASE_URL || "";
const STORAGE_MODE = DATABASE_URL ? "postgres" : "file";

if (!Number.isInteger(ADMIN_ID)) {
  throw new Error("ADMIN_ID must be a valid integer.");
}

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const STATE_ROW_KEY = "main";

const ADMIN_FLOW = {
  IDLE: "idle",
  WAIT_END_AT: "wait_end_at",
  WAIT_PRIZE: "wait_prize",
  WAIT_CONFIRM: "wait_confirm"
};

const GIVEAWAY_STATUS = {
  NONE: "none",
  COLLECTING: "collecting",
  VOTING: "voting"
};

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

function sanitizeState(rawState) {
  const defaultState = createDefaultState();

  return {
    adminFlow: {
      ...defaultState.adminFlow,
      ...(rawState && rawState.adminFlow ? rawState.adminFlow : {})
    },
    giveaway: {
      ...defaultState.giveaway,
      ...(rawState && rawState.giveaway ? rawState.giveaway : {})
    }
  };
}

function ensureFileStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(createDefaultState(), null, 2));
  }
}

function createStorage() {
  if (STORAGE_MODE === "postgres") {
    const pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false }
    });

    return {
      mode: "postgres",
      async init() {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS bot_state (
            state_key TEXT PRIMARY KEY,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        await pool.query(
          `
            INSERT INTO bot_state (state_key, payload)
            VALUES ($1, $2::jsonb)
            ON CONFLICT (state_key) DO NOTHING
          `,
          [STATE_ROW_KEY, JSON.stringify(createDefaultState())]
        );
      },
      async load() {
        const result = await pool.query(
          "SELECT payload FROM bot_state WHERE state_key = $1 LIMIT 1",
          [STATE_ROW_KEY]
        );

        if (!result.rows.length) {
          const defaultState = createDefaultState();
          await this.save(defaultState);
          return defaultState;
        }

        return sanitizeState(result.rows[0].payload);
      },
      async save(state) {
        await pool.query(
          `
            INSERT INTO bot_state (state_key, payload, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (state_key)
            DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
          `,
          [STATE_ROW_KEY, JSON.stringify(state)]
        );
      }
    };
  }

  return {
    mode: "file",
    async init() {
      ensureFileStorage();
    },
    async load() {
      ensureFileStorage();
      return sanitizeState(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
    },
    async save(state) {
      ensureFileStorage();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function sanitizeTelegramPath(value) {
  if (!value) {
    return value;
  }

  return String(value).replace(/\/bot[^/]+\//, "/bot<hidden>/");
}

function formatError(error, context = "") {
  if (!error) {
    return context ? `${context}: Unknown error` : "Unknown error";
  }

  const parts = [];

  if (context) {
    parts.push(context);
  }

  if (error.code) {
    parts.push(`code=${error.code}`);
  }

  const response = error.response && typeof error.response === "object" ? error.response : null;
  const body = response && response.body && typeof response.body === "object" ? response.body : null;

  if (response && response.statusCode) {
    parts.push(`status=${response.statusCode}`);
  }

  if (body && body.error_code) {
    parts.push(`telegram_code=${body.error_code}`);
  }

  if (body && body.description) {
    parts.push(body.description);
  } else if (error.message) {
    parts.push(error.message);
  }

  if (error.options && error.options.path) {
    parts.push(`path=${sanitizeTelegramPath(error.options.path)}`);
  }

  return parts.join(" | ");
}

async function main() {
  const storage = createStorage();
  await storage.init();

  let state = await storage.load();
  let finishVotingTimer = null;

  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

  async function saveState() {
    await storage.save(state);
  }

  function isAdmin(chatId) {
    return Number(chatId) === ADMIN_ID;
  }

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
    await saveState();

    const sent = await bot.sendMessage(CHANNEL_ID, buildAnnouncementText(), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "Перейти в бота", url: "https://t.me/zvezdbest_bot" }]]
      }
    });
    state.giveaway.announcementMessageId = sent.message_id;
    resetAdminFlow();
    await saveState();

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
        reply_markup: {
          inline_keyboard: [[{ text: "Открыть чат победителя", url: `tg://user?id=${winner.id}` }]]
        }
      }
    );

    resetGiveaway();
    await saveState();
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
    let poll;

    try {
      poll = await bot.sendPoll(CHANNEL_ID, "Выберите участника розыгрыша", options, {
        is_anonymous: false,
        allows_multiple_answers: false
      });
    } catch (error) {
      console.error(
        formatError(error, `sendPoll failed (channel=${CHANNEL_ID}, options=${options.length})`)
      );
      await bot.sendMessage(
        chatId,
        "Не удалось запустить голосование. Проверь права бота в канале и подробности в логе."
      ).catch(() => null);
      return;
    }

    await bot.sendMessage(CHANNEL_ID, buildVotingText(state.giveaway.participants), {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
    await notifyParticipantsVotingStarted();

    state.giveaway.status = GIVEAWAY_STATUS.VOTING;
    state.giveaway.pollMessageId = poll.message_id;
    state.giveaway.pollId = poll.poll.id;
    state.giveaway.pollOptions = options;
    await saveState();
    scheduleVotingFinish();

    await bot.sendMessage(chatId, "Голосование запущено и опубликовано в канале.");
  }
  async function handleAdminMessage(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();

    if (text === "/start") {
      resetAdminFlow();
      await saveState();
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
      await saveState();
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
      await saveState();

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
    const pollLabel = user.username ? `@${user.username}`.slice(0, 99) : displayName.slice(0, 99);

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
    await saveState();

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
    try {
      if (isAdmin(msg.chat.id)) {
        await handleAdminMessage(msg);
        return;
      }

      await handleUserStart(msg.chat.id);
    } catch (error) {
      console.error(formatError(error, "Start handler error"));
    }
  });

  bot.on("message", async (msg) => {
    try {
      if (!msg.text || msg.text.startsWith("/")) {
        return;
      }

      if (!isAdmin(msg.chat.id)) {
        return;
      }

      await handleAdminMessage(msg);
    } catch (error) {
      console.error(formatError(error, "Message handler error"));
    }
  });

  bot.on("callback_query", async (query) => {
    try {
      const action = query.data;
      const chatId = query.message.chat.id;

      if (action === "admin_create_giveaway" && isAdmin(chatId)) {
        if (state.giveaway.status === GIVEAWAY_STATUS.COLLECTING || state.giveaway.status === GIVEAWAY_STATUS.VOTING) {
          await bot.answerCallbackQuery(query.id, { text: "Сначала заверши текущий розыгрыш." });
          return;
        }

        resetGiveaway();
        state.adminFlow = { step: ADMIN_FLOW.WAIT_END_AT, draft: null };
        await saveState();

        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, "Напиши, когда закончится розыгрыш. Например: 30.03.2026 20:00");
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
        await saveState();
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
    } catch (error) {
      console.error(formatError(error, "Callback handler error"));
    }
  });

  bot.on("poll", async (poll) => {
    try {
      if (!poll.is_closed) {
        return;
      }

      await finalizeVotingResult(poll);
    } catch (error) {
      console.error(formatError(error, "Poll handler error"));
    }
  });

  bot.on("polling_error", (error) => {
    console.error(formatError(error, "Polling error"));
  });

  scheduleVotingFinish();

  console.log(`Bot is running with ${storage.mode} storage...`);
}

main().catch((error) => {
  console.error(formatError(error, "Fatal startup error"));
  process.exit(1);
});
