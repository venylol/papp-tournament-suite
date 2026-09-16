/* ==============================
   比赛签到助手（纯前端，本地保存）
   - Cloudflare 只负责托管静态文件
   - 签到数据保存在浏览器 LocalStorage
   ============================== */

(() => {
  "use strict";

  // ------------------------------------------------------------
  // Environment guards
  // ------------------------------------------------------------
  // The app is designed for browsers, but we also run regression tests in
  // Node.js (no DOM). In Node we only export the pure parsing/suspects
  // logic and skip all UI initialization.
  const IS_NODE =
    typeof module !== "undefined" &&
    !!module.exports &&
    (typeof window === "undefined" || typeof document === "undefined");

  const APP_VERSION = (() => {
    try {
      if (
        typeof document === "undefined" ||
        !document ||
        typeof document.querySelector !== "function"
      ) {
        return "dev";
      }
      const el = document.querySelector('meta[name="app-version"]');
      const v =
        el && typeof el.getAttribute === "function"
          ? el.getAttribute("content")
          : "";
      return (v && String(v).trim()) || "dev";
    } catch (_) {
      return "dev";
    }
  })();

  // ------------------------------
  // Polyfills (compatibility)
  // ------------------------------
  // Element.matches / Element.closest for older WebViews
  try {
    if (typeof Element !== "undefined") {
      if (!Element.prototype.matches) {
        Element.prototype.matches =
          Element.prototype.msMatchesSelector ||
          Element.prototype.webkitMatchesSelector ||
          function (selector) {
            const el = this;
            const nodes = (el.document || el.ownerDocument).querySelectorAll(
              selector,
            );
            for (let i = 0; i < nodes.length; i++) {
              if (nodes[i] === el) return true;
            }
            return false;
          };
      }
      if (!Element.prototype.closest) {
        Element.prototype.closest = function (selector) {
          let el = this;
          while (el && el.nodeType === 1) {
            if (el.matches(selector)) return el;
            el = el.parentElement || el.parentNode;
          }
          return null;
        };
      }
    }
  } catch (_) {
    // ignore polyfill errors
  }

  // ------------------------------
  // DOM helpers
  // ------------------------------
  // In Node.js tests there is no DOM; keep this helper safe.
  const $ = (sel, root) => {
    const base = root || (typeof document !== "undefined" ? document : null);
    if (!base || typeof base.querySelector !== "function") return null;
    return base.querySelector(sel);
  };

  // Robust node checks (avoid ReferenceError in some embedded WebViews)
  const isNode = (x) =>
    !!x && typeof x === "object" && typeof x.nodeType === "number";
  const isElement = (x) => isNode(x) && x.nodeType === 1;
  const isHTMLElement = (x) => isElement(x) && typeof x.style === "object";

  function on(el, type, handler, options) {
    if (!el) {
      console.warn("事件绑定失败：未找到元素", type);
      return;
    }
    el.addEventListener(type, handler, options);
  }

  function debounce(fn, delay = 120) {
    let t = null;
    return (...args) => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => {
        t = null;
        fn(...args);
      }, delay);
    };
  }

  function now() {
    return Date.now();
  }

  function pad2(n) {
    const s = String(Math.trunc(Number(n) || 0));
    return s.length >= 2 ? s : "0" + s;
  }

  function formatTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function formatShortTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // ------------------------------
  // Storage
  // ------------------------------
  const STORAGE_KEY = "reversi_checkin_local_state_v2";
  const STORAGE_VERSION = 2;
  const LEGACY_RANKING_STEP_IDS = Object.freeze([
    "prelim-standings",
    "overall-standings",
  ]);
  const COMPETITION_STEP_IDS = Object.freeze([
    "schedule",
    "import",
    "checkin",
    "score-helper",
    "final-registration",
  ]);
  const TOURNAMENT_STEP_IDS = Object.freeze([
    "score-helper",
    "final-registration",
  ]);
  const UNDO_SNACKBAR_DURATION = 4200;
  const INAPP_EXPORT_TIP_KEY = "checkin_assistant_inapp_export_tip_v1";
  let lastAutoSuspectHash = "";

  const DEFAULT_GROUP_RULES = Object.freeze([
    {
      id: "rule-open",
      group: "无差别组",
      keywords: ["无差别组", "无差别赛事", "公开组", "open"],
      enabled: true,
    },
    {
      id: "rule-youth",
      group: "青少年组",
      keywords: ["青少年组", "少年组", "youth"],
      enabled: true,
    },
    {
      id: "rule-newbie",
      group: "新人赛",
      keywords: ["新人赛", "新人组", "新手组", "newbie"],
      enabled: true,
    },
    {
      id: "rule-special",
      group: "特殊赛",
      keywords: ["特殊赛", "特别赛", "xot", "vint"],
      enabled: true,
    },
    {
      id: "rule-longterm",
      group: "长期名单",
      keywords: ["长期选手", "长期成员", "长期名单"],
      enabled: true,
    },
  ]);

  function cloneDefaultGroupRules() {
    return DEFAULT_GROUP_RULES.map((r) => ({
      id: String(r.id),
      group: String(r.group),
      keywords: Array.isArray(r.keywords) ? r.keywords.slice() : [],
      enabled: Boolean(r.enabled),
    }));
  }

  function normalizeGroupRuleKeywords(raw) {
    if (Array.isArray(raw)) {
      return raw
        .map((x) => normalizeWhitespace(x))
        .filter(Boolean)
        .slice(0, 24);
    }

    const text = normalizeWhitespace(String(raw || ""));
    if (!text) return [];
    return text
      .split(/[\n,，;；]/)
      .map((x) => normalizeWhitespace(x))
      .filter(Boolean)
      .slice(0, 24);
  }

  function sanitizeGroupRules(rawRules) {
    const list = Array.isArray(rawRules) ? rawRules : [];
    const out = [];
    const used = new Set();

    for (const item of list) {
      if (!item || typeof item !== "object") continue;

      const group = normalizeWhitespace(item.group);
      if (!group) continue;

      let id = normalizeWhitespace(item.id);
      if (!id) id = `rule-${Math.random().toString(16).slice(2, 10)}`;
      if (used.has(id)) continue;

      const keywords = normalizeGroupRuleKeywords(item.keywords);
      if (keywords.length === 0) continue;

      used.add(id);
      out.push({
        id,
        group,
        keywords,
        enabled: item.enabled !== false,
      });
    }

    return out.length ? out : cloneDefaultGroupRules();
  }

  function getActiveGroupRules() {
    const rules = sanitizeGroupRules(state && state.groupRules);
    return rules.filter((r) => r.enabled !== false);
  }

  function createDefaultSurveyState() {
    return {
      view: "", // '' | 'past' | 'id'
      accountInput: "",
      profile: null,
    };
  }

  function sanitizeSurveyProfile(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = normalizeWhitespace(raw.id);
    const name = normalizeWhitespace(raw.name);
    if (!id && !name) return null;
    const numeric = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const integer = (value) => {
      const n = numeric(value);
      return n === null ? null : Math.max(0, Math.trunc(n));
    };
    return {
      id,
      name,
      rating: numeric(raw.rating),
      high: numeric(raw.high),
      hiddenR: numeric(raw.hiddenR),
      played: integer(raw.played),
      win: integer(raw.win),
      loss: integer(raw.loss),
      draw: integer(raw.draw),
    };
  }

  function sanitizeSurveyState(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const view = source.view === "past" || source.view === "id" ? source.view : "";
    return {
      view,
      accountInput: normalizeWhitespace(source.accountInput || source.account || ""),
      profile: sanitizeSurveyProfile(source.profile),
    };
  }

  const EVENT_SCHEDULE_FIELDS = Object.freeze([
    { key: "registrationDeadline", label: "报名截至时间" },
    { key: "checkinStart", label: "签到开始时间" },
    { key: "checkinDeadline", label: "签到截至时间" },
    { key: "competitionStart", label: "比赛正式开始时间" },
  ]);

  function createDefaultEventSchedule() {
    return {
      registrationDeadline: "",
      checkinStart: "",
      checkinDeadline: "",
      competitionStart: "",
      wechatGroup: createDefaultWechatGroupSelection(),
    };
  }

  function createDefaultWechatGroupSelection() {
    return {
      queryIndex: "",
      username: "",
      displayName: "",
      roomId: null,
    };
  }

  function sanitizeWechatGroupSelection(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const username = normalizeWhitespace(
      source.username || source.roomUsername || source.room_username || source.queryIndex || "",
    );
    const queryIndex = normalizeWhitespace(source.queryIndex || username);
    const displayName = normalizeWhitespace(
      source.displayName ||
        source.display_name ||
        source.groupName ||
        source.group_name ||
        source.remark ||
        source.nick_name ||
        source.name ||
        "",
    );
    const roomIdNumber = Number(source.roomId ?? source.room_id);
    return {
      queryIndex,
      username,
      displayName,
      roomId: Number.isFinite(roomIdNumber) && roomIdNumber > 0 ? Math.trunc(roomIdNumber) : null,
    };
  }

  function normalizeEventScheduleValue(raw) {
    const value = String(raw ?? "").trim();
    if (!value) return "";
    const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?$/);
    return match ? match[1] : "";
  }

  function sanitizeScoreRoundTimestamp(raw) {
    const text = normalizeWhitespace(raw).replace("T", " ");
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return `${text}:00`;
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return "";
    return Number.isFinite(Date.parse(text.replace(" ", "T"))) ? text : "";
  }

  function sanitizeRoundWindowMinutes(raw) {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? Math.max(1, Math.trunc(value))
      : 0;
  }

  function sanitizeEventSchedule(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const safe = createDefaultEventSchedule();
    EVENT_SCHEDULE_FIELDS.forEach(({ key }) => {
      safe[key] = normalizeEventScheduleValue(source[key]);
    });
    safe.wechatGroup = sanitizeWechatGroupSelection(source.wechatGroup || source.chatIndex);
    return safe;
  }

  const AUTOMATIC_SEMIFINALS_MIN_PLAYERS = 8;

  function createDefaultTournamentParameters() {
    return {
      semifinalAndFinalMode: "auto",
      hasSemifinalAndFinal: false,
      brightwellConstant: 6,
    };
  }

  function sanitizeTournamentParameters(raw, players) {
    const source = raw && typeof raw === "object" ? raw : {};
    const rawConstant = source.brightwellConstant;
    const brightwellConstant =
      rawConstant === undefined || rawConstant === null || rawConstant === ""
        ? NaN
        : Number(rawConstant);
    const validModes = ["off", "auto", "on"];
    const semifinalAndFinalMode = validModes.includes(
      source.semifinalAndFinalMode,
    )
      ? source.semifinalAndFinalMode
      : typeof source.hasSemifinalAndFinal === "boolean"
        ? source.hasSemifinalAndFinal
          ? "on"
          : "off"
        : "auto";
    const checkedInPlayerCount = (Array.isArray(players) ? players : []).filter(
      (player) => player && player.checkedIn === true,
    ).length;
    return {
      semifinalAndFinalMode,
      hasSemifinalAndFinal: semifinalAndFinalMode === "on" ||
        (semifinalAndFinalMode === "auto" &&
          checkedInPlayerCount >= AUTOMATIC_SEMIFINALS_MIN_PLAYERS),
      skipSemifinal: source.skipSemifinal === true,
      brightwellConstant:
        Number.isFinite(brightwellConstant) && brightwellConstant >= 0
          ? brightwellConstant
          : 6,
    };
  }

  function createDefaultWechatRelaySync() {
    return {
      syncModeVersion: 3,
      enabled: false,
      ready: false,
      groupUsername: "",
      lastProcessedMessageId: "",
      lastProcessedCreateTime: 0,
      referenceMessageId: "",
      referenceCreateTime: 0,
      referenceGroupUsername: "",
      referenceDeadlineMs: 0,
      stopReason: "",
    };
  }

  function sanitizeWechatRelaySync(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const currentSyncMode = Number(source.syncModeVersion) === 3;
    const lastCreateTime = Number(source.lastProcessedCreateTime);
    const referenceCreateTime = Number(source.referenceCreateTime);
    const referenceDeadlineMs = Number(source.referenceDeadlineMs);
    return {
      syncModeVersion: 3,
      enabled: currentSyncMode && Boolean(source.enabled),
      ready: Boolean(source.ready),
      groupUsername: normalizeWhitespace(source.groupUsername).slice(0, 256),
      lastProcessedMessageId: String(source.lastProcessedMessageId || "").slice(0, 500),
      lastProcessedCreateTime:
        Number.isFinite(lastCreateTime) && lastCreateTime > 0
          ? Math.trunc(lastCreateTime)
          : 0,
      referenceMessageId: currentSyncMode
        ? String(source.referenceMessageId || "").slice(0, 500)
        : "",
      referenceCreateTime:
        currentSyncMode && Number.isFinite(referenceCreateTime) && referenceCreateTime > 0
          ? Math.trunc(referenceCreateTime)
          : 0,
      referenceGroupUsername: currentSyncMode
        ? normalizeWhitespace(source.referenceGroupUsername).slice(0, 256)
        : "",
      referenceDeadlineMs:
        currentSyncMode && Number.isFinite(referenceDeadlineMs) && referenceDeadlineMs > 0
          ? Math.trunc(referenceDeadlineMs)
          : 0,
      stopReason: source.stopReason === "deadline" ? "deadline" : "",
    };
  }

  function createDefaultWechatAutoCheckin() {
    return {
      version: 1,
      enabled: false,
      groupUsername: "",
      items: [],
    };
  }

  function sanitizeWechatAutoCheckin(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const validStatuses = new Set([
      "pending",
      "ignored",
      "solved",
      "auto-checked-in",
      "already-checked-in",
      "auto-ignored",
    ]);
    const seenIds = new Set();
    const items = [];
    for (const rawItem of Array.isArray(source.items) ? source.items : []) {
      const item = rawItem && typeof rawItem === "object" ? rawItem : {};
      const id = normalizeWhitespace(item.id).slice(0, 1200);
      const messageId = normalizeWhitespace(item.messageId).slice(0, 500);
      const kind = item.kind === "keyword"
        ? "keyword"
        : item.kind === "checkin"
          ? "checkin"
          : "";
      if (!id || !messageId || !kind || seenIds.has(id)) continue;
      seenIds.add(id);
      const createTime = Number(item.createTime);
      const resolvedAt = Number(item.resolvedAt);
      items.push({
        id,
        messageId,
        scopeKey: normalizeWhitespace(item.scopeKey).slice(0, 800),
        groupUsername: normalizeWhitespace(item.groupUsername).slice(0, 256),
        createTime:
          Number.isFinite(createTime) && createTime > 0 ? Math.trunc(createTime) : 0,
        senderUsername: normalizeWhitespace(item.senderUsername).slice(0, 256),
        senderGroupNick: normalizeWhitespace(item.senderGroupNick).slice(0, 256),
        senderDisplayName: normalizeWhitespace(item.senderDisplayName).slice(0, 256),
        content: String(item.content || "").slice(0, 4000),
        kind,
        pendingKind: item.pendingKind === "attendance-keyword"
          ? "attendance-keyword"
          : item.pendingKind === "unmapped-checkin"
            ? "unmapped-checkin"
            : "",
        keyword: normalizeWhitespace(item.keyword).slice(0, 80),
        playerId: mappingTextId(item.playerId),
        playerName: normalizeWhitespace(item.playerName).slice(0, 256),
        status: validStatuses.has(item.status) ? item.status : "pending",
        resolvedBy: item.resolvedBy === "human" || item.resolvedBy === "script"
          ? item.resolvedBy
          : "",
        resolvedAt:
          Number.isFinite(resolvedAt) && resolvedAt > 0 ? Math.trunc(resolvedAt) : 0,
      });
    }
    return {
      version: 1,
      enabled: Boolean(source.enabled),
      groupUsername: normalizeWhitespace(source.groupUsername).slice(0, 256),
      items,
    };
  }

  const initialState = () => ({
    version: STORAGE_VERSION,
    appMode: "competition", // The root app is the competition workspace; the portal owns workspace choice.
    step: "schedule", // schedule -> import -> checkin -> preliminary/final stages
    competitionName: "比赛签到表",
    eventSchedule: createDefaultEventSchedule(),
    tournamentParameters: createDefaultTournamentParameters(),
    ap: { enabled: false, status: "disabled" },
    wechatRelaySync: createDefaultWechatRelaySync(),
    wechatAutoCheckin: createDefaultWechatAutoCheckin(),
    nextPlayerId: 1,
    players: [],
    clubText: "",
    relayText: "",
    groupRules: cloneDefaultGroupRules(),
    scoreHelper: createDefaultScoreHelper(),
    playoffRegistration: createDefaultPlayoffRegistration(),
    standingsSnapshots: [],
    plannedWithdrawals: [],
    egAnalysis: createDefaultEgAnalysis(),
    mapping: createDefaultMapping(),
    survey: createDefaultSurveyState(),
    ui: {
      group: "all", // 'all' | groupName
      callMode: false, // 点名模式
      showTime: false, // 显示签到时间
      checkinView: "players", // 'players' | 'mapping'
      oqPollSeconds: 15,
    },
    savedAt: now(),
  });

  let state = initialState();
  // UI-only override so we can show "导入页 + 继续上次进度" without overwriting saved step.
  let viewStepOverride = null;
  let saveTimer = null;
  let lastSaveFailAt = 0;
  let lastLocalEditAt = 0;
  let wechatGroupOptions = [];
  let wechatRelayPollTimer = null;
  let wechatRelayPollInFlight = false;
  let latestWechatRelayMessage = null;
  let latestWechatRelayGroupUsername = "";
  let wechatRelayStatusText = "";
  let lastWechatRelayPollingErrorText = "";
  let wechatRelayReferenceAutoText = "";
  let wechatRelayReferenceStatusText = "";
  let pendingWechatRelayImport = null;
  let wechatAutoCheckinStatusText = "";
  let lastWechatAutoCheckinPollingErrorText = "";
  let mappingProcessYTimer = null;
  let mappingProcessYInFlight = null;
  let mappingProcessYPending = false;

  const LOCAL_SYNC_ENABLED =
    !IS_NODE &&
    (() => {
      try {
        const params = new URLSearchParams(window.location.search || "");
        if (params.get("localSync") === "1") return true;
        if (params.get("localSync") === "0") return false;
        const host = String(window.location.hostname || "").toLowerCase();
        return host === "127.0.0.1" || host === "localhost" || host === "::1";
      } catch (_) {
        return false;
      }
    })();

  const LOCAL_SYNC_STATE_URL = "/api/state";
  const LOCAL_SYNC_EVENTS_URL = "/api/events";
  const LOCAL_SYNC_USER_WRITE_GUARD_MS = 3000;
  const LOCAL_SYNC_CLIENT_ID =
    !IS_NODE && typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `client-${Math.random().toString(16).slice(2)}-${Date.now()}`;
  let localSyncApplyingRemote = false;
  let localSyncPushTimer = null;
  let localSyncPushInFlight = false;
  let localSyncPendingPush = false;
  let localSyncPendingSource = "human";
  let scheduledLocalSyncSource = "human";
  let localSyncLastRevision = -1;
  let localSyncLastErrorAt = 0;
  let localSyncPollTimer = null;
  let localSyncEventSource = null;
  let localSyncPendingScriptUntil = 0;
  let oqScorePollEnabled = false;
  let oqScorePollTimer = null;
  let oqScorePollInFlight = false;
  let oqScorePollNextAt = 0;
  let egAnalysisStatus = null;
  let egAnalysisPollTimer = null;
  let egAnalysisPollInFlight = false;
  let scoreStartInFlight = false;
  let scoreBatchInFlight = false;
  let scoreStageAdvanceInFlight = false;
  let scoreInputRevision = 0;
  const scoreInputRevisions = new Map();
  let pappCandidateSyncTimer = null;
  let pappCandidateSyncInFlight = false;
  let pappCandidateSyncPending = false;
  let pappCandidateSyncLastSnapshot = "";
  const PAPP_ROSTER_SYNC_MAX_ATTEMPTS = 3;
  const PAPP_ROSTER_SYNC_RETRY_DELAY_MS = 1000;

  async function preliminaryRoundCountForPlayerCount(playerCount, manualRoundCount) {
    const result = assertAdapterSuccess(
      await invokeTournamentAdapter("getRoundCount", {
        playerCount: playerCount,
        ...(manualRoundCount === undefined ? {} : { manualRoundCount: manualRoundCount }),
      }),
      "PAPP 预赛轮数计算失败",
    );
    if (result.source !== "papp-c" || !Number.isInteger(Number(result.roundCount))) {
      throw new Error("PAPP C 未返回有效预赛轮数");
    }
    return Number(result.roundCount);
  }

  function createDefaultEgAnalysis() {
    return {
      schema: "papp-eg-analysis-v1",
      updatedAt: "",
      scope: "preliminary-and-playoffs",
      roundLimit: 0,
      summaryFile: "",
      gameCount: 0,
      playerCount: 0,
      topPlayers: [],
      pairingLossByRound: {},
      engine: {},
    };
  }

  function createEmptyScoreRound(roundNumber) {
    return {
      round: Math.max(1, Math.trunc(Number(roundNumber) || 1)),
      stage: "preliminary",
      roundStartAt: "",
      roundStartSource: "",
      pairings: [],
      pending: [],
      manualPending: [],
      completed: [],
      oq: {
        lastPollAt: "",
        lastOk: null,
        lastError: "",
      },
      eg: {
        lastStartedAt: "",
        lastFinishedAt: "",
        lastError: "",
      },
    };
  }

  function createPappWorkfileId() {
    return `papp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function createDefaultScoreHelper(roundCount = 1) {
    const count = Math.max(1, Math.trunc(Number(roundCount) || 1));
    return {
      version: 2,
      pappWorkfileId: createPappWorkfileId(),
      preliminaryRoundCount: count,
      roundCount: count,
      roundCountSource: "default",
      autoRoundCountPlayerCount: null,
      activeRound: 1,
      rounds: Array.from({ length: count }, (_, i) => createEmptyScoreRound(i + 1)),
      updatedAt: null,
    };
  }

  function createDefaultPlayoffRegistration(preliminaryRoundCount = 1) {
    const count = Math.max(1, Math.trunc(Number(preliminaryRoundCount) || 1));
    return {
      version: 1,
      preliminaryRoundCount: count,
      activeStage: "semifinal",
      semifinalRoundStartAt: "",
      semifinalRoundStartSource: "",
      semifinalRoundEndAt: "",
      semifinalWindowMinutes: 0,
      semifinalPairings: [],
      placementRoundStartAt: "",
      placementRoundStartSource: "",
      placementRoundEndAt: "",
      placementWindowMinutes: 0,
      placementPairings: [],
      updatedAt: null,
    };
  }

  function standingsNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function sanitizeStandingsRows(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 256).map((item) => {
      const row = item && typeof item === "object" ? item : {};
      const rank = standingsNumber(row.rank);
      const preliminaryRank = standingsNumber(row.preliminaryRank);
      return {
        id: normalizeWhitespace(row.id || row.playerId).slice(0, 128),
        rank: rank === null ? null : Math.trunc(rank),
        preliminaryRank: preliminaryRank === null ? null : Math.trunc(preliminaryRank),
        displayName: normalizeWhitespace(row.displayName || row.name).slice(0, 256),
        account: normalizeWhitespace(row.account).slice(0, 128),
        totalPoints: standingsNumber(row.totalPoints),
        brightwell: standingsNumber(row.brightwell),
        totalDiscs: standingsNumber(row.totalDiscs),
      };
    }).filter((row) => row.id && row.displayName);
  }

  function sanitizeStandingsProgress(raw) {
    const progress = raw && typeof raw === "object" ? raw : {};
    const missingRounds = Array.isArray(progress.missingRounds)
      ? progress.missingRounds
        .map((round) => Math.trunc(Number(round)))
        .filter((round) => Number.isFinite(round) && round > 0)
      : [];
    const roundsWithPairings = standingsNumber(progress.roundsWithPairings);
    const expectedRounds = standingsNumber(progress.expectedRounds);
    const unresolvedPairings = standingsNumber(progress.unresolvedPairings);
    return {
      complete: typeof progress.complete === "boolean" ? progress.complete : null,
      expectedRounds: expectedRounds === null ? null : Math.trunc(expectedRounds),
      roundsWithPairings: roundsWithPairings === null ? null : Math.trunc(roundsWithPairings),
      unresolvedPairings: unresolvedPairings === null ? null : Math.trunc(unresolvedPairings),
      missingRounds: missingRounds.slice(0, 128),
    };
  }

  function sanitizeStandingsSnapshots(raw, pappWorkfileId) {
    if (!Array.isArray(raw)) return [];
    const expectedWorkfileId = normalizeWhitespace(pappWorkfileId);
    const snapshots = new Map();
    raw.slice(0, 129).forEach((item) => {
      const value = item && typeof item === "object" ? item : {};
      const kind = value.kind === "overall" ? "overall" : value.kind === "preliminary" ? "preliminary" : "";
      const round = Math.trunc(Number(value.round));
      const capturedAt = Number(value.capturedAt);
      const workfileId = normalizeWhitespace(value.pappWorkfileId);
      if (!kind || !Number.isFinite(round) || round < 1 || value.source !== "papp-c") return;
      if (expectedWorkfileId && workfileId && workfileId !== expectedWorkfileId) return;
      const standings = sanitizeStandingsRows(value.standings);
      if (!standings.length) return;
      const key = `${kind}:${round}`;
      snapshots.set(key, {
        kind,
        round,
        source: "papp-c",
        operation: normalizeWhitespace(value.operation).slice(0, 64),
        pappWorkfileId: workfileId || expectedWorkfileId,
        capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? Math.trunc(capturedAt) : 0,
        progress: sanitizeStandingsProgress(value.progress),
        standings,
      });
    });
    return Array.from(snapshots.values()).sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "preliminary" ? -1 : 1;
      return left.round - right.round;
    });
  }

  function sanitizePlannedWithdrawals(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const seenPlayerIds = new Set();
    const plans = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const playerId = Math.trunc(Number(item.playerId));
      const round = Math.trunc(Number(item.round));
      if (!Number.isFinite(playerId) || playerId < 1) continue;
      if (!Number.isFinite(round) || round < 1) continue;
      if (seenPlayerIds.has(playerId)) continue;
      seenPlayerIds.add(playerId);
      plans.push({
        playerId,
        playerName: normalizeWhitespace(item.playerName || ""),
        round,
        createdAt: Number.isFinite(Number(item.createdAt))
          ? Number(item.createdAt)
          : now(),
      });
    }
    return plans;
  }

  function safeLocalStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      console.warn("localStorage 写入失败：", e);
      return false;
    }
  }

  function safeLocalStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      console.warn("localStorage 读取失败：", e);
      return null;
    }
  }

  function safeLocalStorageRemove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.warn("localStorage 删除失败：", e);
      return false;
    }
  }

  function localSyncSource(value) {
    return value === "script" || value === "oq" ? value : "human";
  }

  function scheduleSave(options = {}) {
    scheduledLocalSyncSource = localSyncSource(options.source);
    ensureTournamentParametersState();
    const mappingSync = syncMappingRowsWithCheckinPlayers();
    if (mappingSync.addedCount && state.ui && state.ui.checkinView === "mapping") {
      renderMappingTable();
    }
    state.savedAt = now();
    if (scheduledLocalSyncSource === "human") lastLocalEditAt = state.savedAt;
    schedulePappCandidateSync();
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      const ok = safeLocalStorageSet(STORAGE_KEY, JSON.stringify(state));
      if (ok) updateAutosaveChip(state.savedAt);
      if (!ok) {
        const ts = now();
        if (ts - lastSaveFailAt > 8000) {
          lastSaveFailAt = ts;
          showSnackbar(
            "⚠️ 自动保存失败：可能是浏览器禁用/容量不足（仍可继续使用）",
            3500,
          );
        }
      }
      queueLocalSyncPush({ immediate: true, source: scheduledLocalSyncSource });
    }, 180);
  }

  // Flush pending autosave immediately.
  // Useful when the page is being backgrounded/closed (especially on mobile Safari).
  function flushSave(options = {}) {
    const source = localSyncSource(options.source || scheduledLocalSyncSource);
    ensureTournamentParametersState();
    const mappingSync = syncMappingRowsWithCheckinPlayers();
    if (mappingSync.addedCount && state.ui && state.ui.checkinView === "mapping") {
      renderMappingTable();
    }
    if (mappingSync.changed) schedulePappCandidateSync({ immediate: true });
    state.savedAt = now();
    if (source === "human") lastLocalEditAt = state.savedAt;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = null;
    if (safeLocalStorageSet(STORAGE_KEY, JSON.stringify(state))) {
      updateAutosaveChip(state.savedAt);
    }
    queueLocalSyncPush({ immediate: true, source });
  }

  function loadFromStorage() {
    const raw = safeLocalStorageGet(STORAGE_KEY);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;

      // Allow loading previous schema as long as version matches.
      if (parsed.version !== STORAGE_VERSION) return null;

      return sanitizeLoadedState(parsed);
    } catch (e) {
      console.warn("解析本地状态失败：", e);
      return null;
    }
  }

  function getSyncChipEl() {
    return typeof document !== "undefined"
      ? document.getElementById("sync-chip")
      : null;
  }

  function setLocalSyncStatus(kind, text) {
    const chip = getSyncChipEl();
    if (!chip) return;
    const k = kind || "idle";
    chip.classList.remove(
      "sync-chip--idle",
      "sync-chip--ok",
      "sync-chip--busy",
      "sync-chip--error",
    );
    chip.classList.add(`sync-chip--${k}`);
    chip.textContent = text || "本地同步：未连接";
  }

  function reportLocalSyncError(message, error) {
    const detail =
      error && error.message ? String(error.message) : String(error || "");
    const text = detail ? `${message}：${detail}` : message;
    console.error("[local-sync]", text, error || "");
    setLocalSyncStatus("error", "本地同步：错误");

    const ts = now();
    if (ts - localSyncLastErrorAt > 7000) {
      localSyncLastErrorAt = ts;
      showSnackbar(`本地同步错误：${message}`, 5200, "查看", () => {
        showAlert("本地同步错误", text);
      });
    }
  }

  function cloneStateForLocalSync(source = "human") {
    const copy = deepClone(state);
    if (!copy || typeof copy !== "object") return null;
    copy.tournamentParameters = sanitizeTournamentParameters(
      copy.tournamentParameters,
      copy.players,
    );
    copy.localSync = {
      clientId: LOCAL_SYNC_CLIENT_ID,
      source: localSyncSource(source),
      savedAt: now(),
    };
    return copy;
  }

  function updateLocalSyncPendingScriptStatus(result) {
    if (!result || typeof result !== "object") return;
    const hasPendingStatus = Object.prototype.hasOwnProperty.call(
      result,
      "scriptWritePending",
    );
    const pending = result.queued === true || result.scriptWritePending === true;
    if (pending) {
      const retryAfterMs = Math.max(0, Number(result.retryAfterMs) || 0);
      localSyncPendingScriptUntil = now() + retryAfterMs;
    } else if (hasPendingStatus) {
      localSyncPendingScriptUntil = 0;
    }
  }

  function queueLocalSyncPush(options = {}) {
    if (!LOCAL_SYNC_ENABLED || localSyncApplyingRemote) return;
    if (!state || Number(state.version) !== STORAGE_VERSION) return;

    const source = localSyncSource(options.source);
    if (localSyncPushTimer) window.clearTimeout(localSyncPushTimer);
    const delay = 0;
    localSyncPushTimer = window.setTimeout(() => {
      localSyncPushTimer = null;
      pushLocalSyncState(source);
    }, delay);
  }

  async function pushLocalSyncState(source = "human") {
    if (!LOCAL_SYNC_ENABLED || localSyncApplyingRemote) return true;
    if (localSyncPushInFlight) {
      localSyncPendingPush = true;
      localSyncPendingSource = localSyncSource(source);
      return false;
    }

    const normalizedSource = localSyncSource(source);
    const payload = cloneStateForLocalSync(normalizedSource);
    if (!payload) return false;

    localSyncPushInFlight = true;
    setLocalSyncStatus("busy", "本地同步：保存中");
    let saved = false;
    try {
      const response = await fetch(LOCAL_SYNC_STATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ source: normalizedSource, state: payload }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error(
          (result && (result.detail || result.error)) ||
            `HTTP ${response.status}`,
        );
      }
      updateLocalSyncPendingScriptStatus(result);
      localSyncLastRevision = Number(result.revision);
      setLocalSyncStatus(
        result.queued ? "busy" : "ok",
        result.queued ? "本地同步：等待用户写入空闲" : "本地同步：已保存",
      );
      saved = true;
    } catch (error) {
      reportLocalSyncError("写入共享状态失败", error);
    } finally {
      localSyncPushInFlight = false;
      if (localSyncPendingPush) {
        localSyncPendingPush = false;
        queueLocalSyncPush({ immediate: true, source: localSyncPendingSource });
      }
    }
    return saved;
  }

  async function persistCurrentStateToLocalService() {
    flushSave();
    if (!LOCAL_SYNC_ENABLED || localSyncApplyingRemote) return true;

    if (localSyncPushTimer) window.clearTimeout(localSyncPushTimer);
    localSyncPushTimer = null;
    while (localSyncPushInFlight) {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    if (localSyncPushTimer) window.clearTimeout(localSyncPushTimer);
    localSyncPushTimer = null;
    localSyncPendingPush = false;
    return await pushLocalSyncState(scheduledLocalSyncSource);
  }

  function applyRemoteState(remoteState, meta = {}) {
    const loaded = sanitizeLoadedState(remoteState);
    if (!loaded || !Array.isArray(loaded.players)) {
      throw new Error("共享状态无法通过前端校验");
    }

    if (now() - lastLocalEditAt < LOCAL_SYNC_USER_WRITE_GUARD_MS) {
      setLocalSyncStatus("busy", "本地同步：等待本地写入空闲");
      return false;
    }

    const hasRemotePlayers = Boolean(
      loaded && Array.isArray(loaded.players) && loaded.players.length > 0,
    );

    let mappingRowsChanged = false;
    let scorePairingsChanged = false;
    localSyncApplyingRemote = true;
    try {
      state = loaded;
      mappingRowsChanged = syncMappingRowsWithCheckinPlayers().changed;
      scorePairingsChanged = refreshScorePairingAccountsFromMapping();
      schedulePappCandidateSync({ immediate: true });
      if (!TOURNAMENT_STEP_IDS.includes(state.step)) {
        state.step = hasRemotePlayers ? "checkin" : state.step;
      }
      viewStepOverride = null;
      applyStateToUI();
      safeLocalStorageSet(STORAGE_KEY, JSON.stringify(state));
      updateAutosaveChip(state.savedAt);
      setLocalSyncStatus("ok", "本地同步：已载入");
      if (meta && meta.showToast) {
        showSnackbar("已从共享 JSON 载入最新签到状态", 2600);
      }
    } finally {
      localSyncApplyingRemote = false;
    }
    if (mappingRowsChanged || scorePairingsChanged) {
      scheduleSave({ source: scorePairingsChanged ? "oq" : "human" });
    }
    resumeWechatRelayPolling();
    return true;
  }

  async function fetchLocalSyncState(options = {}) {
    if (!LOCAL_SYNC_ENABLED) return;
    try {
      const response = await fetch(`${LOCAL_SYNC_STATE_URL}?t=${Date.now()}`, {
        method: "GET",
        cache: "no-store",
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error(
          (result && (result.detail || result.error)) ||
            `HTTP ${response.status}`,
        );
      }

      updateLocalSyncPendingScriptStatus(result);
      const revisionValue = Number(result.revision);
      if (
        Number.isFinite(revisionValue) &&
        revisionValue === localSyncLastRevision &&
        !options.force
      ) {
        setLocalSyncStatus("ok", "本地同步：已连接");
        return result;
      }

      if (!result.state) {
        if (Number.isFinite(revisionValue)) localSyncLastRevision = revisionValue;
        setLocalSyncStatus("ok", "本地同步：已连接");
        if (options.pushIfEmpty !== false) {
          queueLocalSyncPush({ immediate: true });
        }
        return result;
      }

      const applied = applyRemoteState(result.state, {
        showToast: Boolean(options.showToast),
      });
      if (applied && Number.isFinite(revisionValue)) {
        localSyncLastRevision = revisionValue;
      }
      return result;
    } catch (error) {
      reportLocalSyncError("读取共享状态失败", error);
      return null;
    }
  }

  function startLocalSync() {
    if (!LOCAL_SYNC_ENABLED) {
      setLocalSyncStatus("idle", "本地同步：未连接");
      return;
    }

    setLocalSyncStatus("busy", "本地同步：连接中");
    fetchLocalSyncState({ force: true, showToast: false, pushIfEmpty: true });

    if (typeof EventSource !== "undefined") {
      try {
        localSyncEventSource = new EventSource(LOCAL_SYNC_EVENTS_URL);
        localSyncEventSource.onopen = () => {
          setLocalSyncStatus("ok", "本地同步：已连接");
        };
        localSyncEventSource.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data || "{}");
            if (payload && payload.type === "error") {
              throw new Error(payload.error || "服务端文件监听错误");
            }
            if (payload && payload.type === "state") {
              const rev = Number(payload.revision);
              if (Number.isFinite(rev) && rev === localSyncLastRevision) {
                return;
              }
              fetchLocalSyncState({ force: true, showToast: true });
            }
          } catch (error) {
            reportLocalSyncError("处理同步事件失败", error);
          }
        };
        localSyncEventSource.onerror = () => {
          setLocalSyncStatus("error", "本地同步：监听断开");
        };
      } catch (error) {
        reportLocalSyncError("启动同步监听失败", error);
      }
    }

    localSyncPollTimer = window.setInterval(() => {
      fetchLocalSyncState({ force: false, showToast: false });
    }, 5000);
  }

  // ------------------------------
  // Undo helpers (删除/清空/批量操作)
  // - 目标：最小侵入、最小风险，尽量用“快照恢复”而不是复杂的差异回滚
  // - 说明：撤销只在当前页面生命周期内有效（刷新后不保证）
  // ------------------------------
  function deepClone(value) {
    // structuredClone is supported by most modern browsers; fall back to JSON clone.
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(value);
      } catch (_) {
        /* fall through */
      }
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return value;
    }
  }

  function captureUndoSnapshot() {
    return deepClone({ state, viewStepOverride });
  }

  function restoreUndoSnapshot(snapshot) {
    if (!snapshot || !snapshot.state) return;
    state = snapshot.state;
    viewStepOverride = snapshot.viewStepOverride || null;
    syncMappingRowsWithCheckinPlayers();
    schedulePappCandidateSync({ immediate: true });
    applyStateToUI();
    resumeWechatRelayPolling();
    // Flush immediately so undo survives pagehide on mobile Safari/WeChat.
    flushSave();
  }

  function clearStorageAndReset() {
    const snapshot = captureUndoSnapshot();
    stopWechatRelayPolling();
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = null;
    scheduledLocalSyncSource = "human";
    latestWechatRelayMessage = null;
    latestWechatRelayGroupUsername = "";
    wechatRelayStatusText = "";
    wechatRelayReferenceAutoText = "";
    wechatRelayReferenceStatusText = "";
    pendingWechatRelayImport = null;

    // Clear persisted storage first (so a refresh won't resurrect old state)
    safeLocalStorageRemove(STORAGE_KEY);

    state = initialState();
    state.step = "schedule";
    state.savedAt = now();
    lastLocalEditAt = state.savedAt;
    viewStepOverride = null;
    applyStateToUI(true);
    schedulePappCandidateSync({ immediate: true });
    queueLocalSyncPush({
      immediate: true,
      source: "human",
    });

    showUndoSnackbar("已清除本地进度", () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销清除", 2200);
    });
  }

  // ------------------------------
  // Sorting / parsing utilities
  // ------------------------------
  const nameCollator = (() => {
    // Some extremely old/embedded browsers may not have Intl.
    // Fall back to a safe string comparison to avoid crashing.
    const safeFallback = {
      compare: (a, b) => {
        const A = String(a ?? "");
        const B = String(b ?? "");
        if (A === B) return 0;
        return A < B ? -1 : 1;
      },
    };

    try {
      if (typeof Intl === "undefined" || typeof Intl.Collator !== "function") {
        return safeFallback;
      }

      try {
        return new Intl.Collator("zh-Hans-CN-u-co-pinyin", {
          numeric: true,
          sensitivity: "base",
        });
      } catch (e1) {
        try {
          return new Intl.Collator("zh-Hans-CN", {
            numeric: true,
            sensitivity: "base",
          });
        } catch (e2) {
          return new Intl.Collator(undefined, {
            numeric: true,
            sensitivity: "base",
          });
        }
      }
    } catch (e) {
      return safeFallback;
    }
  })();

  function normalizeWhitespace(str) {
    return (
      (str || "")
        .replace(/\uFEFF/g, "")
        // Normalize uncommon unicode spaces (NBSP / thin spaces / hangul filler etc.)
        // to reduce hidden-char duplicates from pasted text.
        .replace(
          /[\u00A0\u1680\u2000-\u200D\u202F\u205F\u2060-\u2063\u3000\u3164]/g,
          " ",
        )
        .replace(/[ \t\r\f\v]+/g, " ")
        .trim()
    );
  }

  function unwrapBrackets(str) {
    return (
      (str || "")
        .replace(/\[(.*?)\]/g, " $1 ")
        // Fullwidth / CJK brackets commonly seen in relays and chat apps
        .replace(/【(.*?)】/g, " $1 ")
        .replace(/「(.*?)」/g, " $1 ")
        .replace(/《(.*?)》/g, " $1 ")
        .replace(/（(.*?)）/g, " $1 ")
        .replace(/\((.*?)\)/g, " $1 ")
    );
  }

  function stripListIndex(str) {
    // Remove common list numbering prefixes.
    // Examples:
    //   "1. 张三" / "1．张三" / "1、张三" / "1)张三" / "1]张三"
    // Important: do NOT treat numeric names like "3.1415" as list numbering.
    // Therefore, for '.' / '．' we only strip when it is NOT followed by a digit.
    return (str || "")
      .replace(/^\s*(?:\d{1,3}|[０-９]{1,3})\s*[\.．](?![0-9０-９])\s*/, "")
      .replace(/^\s*(?:\d{1,3}|[０-９]{1,3})\s*[、\)\]）］]\s*/, "")
      .replace(/^\s*(?:\d{1,3}|[０-９]{1,3})\s*[-–—－]\s+/, "");
  }

  function normalizeKey(str) {
    return normalizeWhitespace(str).toLowerCase();
  }

  function normalizeMappingNameKey(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  }

  function mappingIdentityTokens(value) {
    return new Set(
      String(value || "")
        .toLowerCase()
        .match(/[a-z]+|\d+|[\u3400-\u9fff]/g) || [],
    );
  }

  function mappingGroupNickHasIdentityMismatch(row) {
    if (!row) return false;

    const nicknameTokens = mappingIdentityTokens(row.wechatNick);
    const identityTokens = new Set([
      ...mappingIdentityTokens(row.registrationNick),
      ...mappingIdentityTokens(row.oqAccount),
    ]);
    if (!nicknameTokens.size || !identityTokens.size) return false;
    return !Array.from(nicknameTokens).some((token) => identityTokens.has(token));
  }

  function isManualGroupNick(row) {
    return Boolean(row && row.wechatNickSource === "manual");
  }

  const MAPPING_GROUP_NICK_WARNING =
    "当前群昵称与报名姓名、OQ 账号均无共同词汇，请核对。";

  function wechatRelayPlayersMatch(left, right) {
    const leftAccount = normalizeKey(left && left.account);
    const rightAccount = normalizeKey(right && right.account);
    if (leftAccount && rightAccount) {
      if (leftAccount !== rightAccount) return false;
      const leftPlatform = normalizeKey(left && left.platform);
      const rightPlatform = normalizeKey(right && right.platform);
      return !leftPlatform || !rightPlatform || leftPlatform === rightPlatform;
    }

    const leftName = normalizeKey(left && (left.displayName || left.name));
    const rightName = normalizeKey(right && (right.displayName || right.name));
    return Boolean(leftName && rightName && leftName === rightName);
  }

  function wechatRelayRosterContainsCurrent(currentPlayers, incomingPlayers) {
    const current = Array.isArray(currentPlayers) ? currentPlayers : [];
    const incoming = Array.isArray(incomingPlayers) ? incomingPlayers : [];
    return current.every((player) =>
      incoming.some((candidate) => wechatRelayPlayersMatch(player, candidate)),
    );
  }

  function escapeHtml(unsafe) {
    return String(unsafe ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ------------------------------
  // State sanitization (robust restore)
  // ------------------------------
  function sanitizeLoadedState(parsed) {
    try {
      const safe = initialState();
      safe.version = STORAGE_VERSION;
      // AP belongs to the local service; retain its complete snapshot on UI saves.
      safe.ap = parsed.ap && typeof parsed.ap === "object" && !Array.isArray(parsed.ap)
        ? deepClone(parsed.ap) : { enabled: false, status: "disabled" };

      // The root page is always the competition workspace. The portal page owns
      // the choice between competition management and player investigation.
      safe.appMode = "competition";

      const savedStep = normalizeWhitespace(parsed && parsed.step);
      safe.step = COMPETITION_STEP_IDS.includes(savedStep)
        ? savedStep
        : LEGACY_RANKING_STEP_IDS.includes(savedStep)
          ? "score-helper"
          : "import";
      safe.competitionName =
        normalizeWhitespace(parsed.competitionName) || "比赛签到表";
      safe.eventSchedule = sanitizeEventSchedule(parsed.eventSchedule);
      safe.tournamentParameters = sanitizeTournamentParameters(
        parsed.tournamentParameters,
        parsed.players,
      );
      if (LEGACY_RANKING_STEP_IDS.includes(savedStep)) {
        safe.step = safe.tournamentParameters.hasSemifinalAndFinal
          ? "final-registration"
          : "score-helper";
      }
      if (!safe.tournamentParameters.hasSemifinalAndFinal && safe.step === "final-registration") {
        safe.step = "score-helper";
      }
      safe.wechatRelaySync = sanitizeWechatRelaySync(parsed.wechatRelaySync);
      safe.wechatAutoCheckin = sanitizeWechatAutoCheckin(parsed.wechatAutoCheckin);
      safe.clubText =
        typeof parsed.clubText === "string" ? parsed.clubText : "";
      safe.relayText =
        typeof parsed.relayText === "string" ? parsed.relayText : "";
      const hasCompetitionData =
        (Array.isArray(parsed.players) && parsed.players.length > 0) ||
        normalizeWhitespace(safe.clubText) ||
        normalizeWhitespace(safe.relayText);
      const hasScheduleData =
        EVENT_SCHEDULE_FIELDS.some(({ key }) => Boolean(safe.eventSchedule[key])) ||
        Boolean(safe.eventSchedule.wechatGroup.queryIndex);
      if (safe.step === "import" && !hasCompetitionData && !hasScheduleData) {
        // Migrate an untouched pre-schedule state to the new first page.
        safe.step = "schedule";
      }
      safe.groupRules = sanitizeGroupRules(parsed.groupRules);
      safe.scoreHelper = sanitizeScoreHelper(parsed.scoreHelper);
      safe.playoffRegistration = sanitizePlayoffRegistration(
        parsed.playoffRegistration,
        safe.scoreHelper.preliminaryRoundCount,
      );
      safe.standingsSnapshots = sanitizeStandingsSnapshots(
        parsed.standingsSnapshots,
        safe.scoreHelper.pappWorkfileId,
      );
      safe.plannedWithdrawals = sanitizePlannedWithdrawals(
        parsed.plannedWithdrawals,
      );
      safe.egAnalysis = sanitizeEgAnalysis(parsed.egAnalysis || parsed.egaAnalysis);
      const legacyFtdMapping =
        parsed && parsed.ftdPlayerAccountMapping && typeof parsed.ftdPlayerAccountMapping === "object"
          ? parsed.ftdPlayerAccountMapping
          : null;
      const mappingSource =
        parsed && parsed.mapping && typeof parsed.mapping === "object"
          ? parsed.mapping
          : parsed && parsed.playerMapping && typeof parsed.playerMapping === "object"
            ? parsed.playerMapping
            : legacyFtdMapping
              ? {
                  ...legacyFtdMapping,
                  groupNicks:
                    parsed && parsed.wechatGroupNicks && typeof parsed.wechatGroupNicks === "object"
                      ? parsed.wechatGroupNicks.groupNicks
                      : legacyFtdMapping.groupNicks,
                  groupName:
                    parsed && parsed.wechatGroupNicks && typeof parsed.wechatGroupNicks === "object"
                      ? parsed.wechatGroupNicks.groupName
                      : legacyFtdMapping.groupName,
                }
              : null;
      safe.mapping = sanitizeMapping(mappingSource);
      safe.survey = sanitizeSurveyState(parsed.survey);
      safe.savedAt = Number.isFinite(Number(parsed.savedAt))
        ? Number(parsed.savedAt)
        : now();

      // ui prefs (optional)
      const ui = parsed && typeof parsed.ui === "object" ? parsed.ui : {};
      safe.ui.group =
        typeof ui.group === "string" && ui.group ? ui.group : "all";
      safe.ui.callMode = Boolean(ui.callMode);
      safe.ui.showTime = Boolean(ui.showTime);
      safe.ui.checkinView = ui.checkinView === "mapping" ? "mapping" : "players";
      const oqPollSeconds = Number(ui.oqPollSeconds);
      safe.ui.oqPollSeconds = Number.isFinite(oqPollSeconds)
        ? Math.max(5, Math.trunc(oqPollSeconds))
        : 15;

      const rawPlayers = Array.isArray(parsed.players) ? parsed.players : [];
      const usedIds = new Set();
      let maxId = 0;

      for (const p of rawPlayers) {
        const obj = p && typeof p === "object" ? p : {};
        const displayName = normalizeWhitespace(obj.displayName || obj.name);
        if (!displayName) continue;

        let id = Number(obj.id);
        id = Number.isFinite(id) ? Math.trunc(id) : 0;

        const account = normalizeWhitespace(obj.account || "");
        const club = normalizeWhitespace(obj.club || "");
        const platform = normalizeWhitespace(obj.platform || "");
        const group = normalizeWhitespace(obj.group || "") || "未分组";

        const checkedIn = Boolean(obj.checkedIn);
        const checkedInAtRaw = Number(obj.checkedInAt);
        const checkedInAt =
          Number.isFinite(checkedInAtRaw) && checkedInAtRaw > 0
            ? checkedInAtRaw
            : null;

        const isNew = Boolean(obj.isNew);

        const player = {
          id: 0,
          displayName,
          account,
          club,
          platform,
          group,
          checkedIn,
          checkedInAt,
          isNew,
        };

        // Keep valid unique ids; mark others for reassignment
        if (id > 0 && !usedIds.has(id)) {
          player.id = id;
          usedIds.add(id);
          maxId = Math.max(maxId, id);
        } else {
          player.id = 0;
        }

        safe.players.push(player);
      }

      // Reassign invalid/duplicate ids (id=0)
      let nextId = maxId + 1;
      for (const p of safe.players) {
        if (p.id > 0) continue;
        while (usedIds.has(nextId)) nextId++;
        p.id = nextId++;
        usedIds.add(p.id);
      }

      // Always keep nextPlayerId safe (>= maxId + 1)
      const derivedNext =
        safe.players.reduce((m, p) => Math.max(m, p.id), 0) + 1;
      const parsedNext = Number(parsed.nextPlayerId);
      const parsedNextSafe =
        Number.isFinite(parsedNext) && parsedNext > 0
          ? Math.trunc(parsedNext)
          : 1;
      safe.nextPlayerId = Math.max(derivedNext, parsedNextSafe);

      // If "checkin" but no players, fall back to import to avoid blank checkin page.
      if (safe.step === "checkin" && safe.players.length === 0)
        safe.step = "import";
      if (TOURNAMENT_STEP_IDS.includes(safe.step) && safe.players.length === 0)
        safe.step = "import";

      // Ensure consistent ordering (group -> name)
      safe.players.sort(comparePlayersForList);

      // If selected group no longer exists, reset to 'all'
      if (
        safe.ui.group !== "all" &&
        !safe.players.some((p) => p.group === safe.ui.group)
      ) {
        safe.ui.group = "all";
      }

      return safe;
    } catch (e) {
      console.warn("恢复数据校验失败：", e);
      return null;
    }
  }

  function sanitizeEgAnalysis(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const rawPlayers = Array.isArray(source.topPlayers)
      ? source.topPlayers
      : Array.isArray(source.players)
        ? source.players
        : [];
    const readNumber = (...values) => {
      for (const value of values) {
        if (value === null || value === undefined || value === "") continue;
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
      return null;
    };
    const topPlayers = rawPlayers
      .map((rawPlayer) => {
        const player = rawPlayer && typeof rawPlayer === "object" ? rawPlayer : {};
        const name = normalizeWhitespace(player.name || player.displayName || "");
        const account = normalizeWhitespace(player.account || player.oqAccount || "");
        const rawGames = Array.isArray(player.games)
          ? player.games
          : Array.isArray(player.rounds)
            ? player.rounds
            : [];
        const games = rawGames.map((rawGame) => {
          const game = rawGame && typeof rawGame === "object" ? rawGame : {};
          const round = readNumber(game.round || game.roundNo);
          const table = readNumber(game.table || game.tableNo);
          const totalLoss = readNumber(game.totalLoss, game.loss);
          const averageLoss = readNumber(game.averageLoss, game.avgLoss);
          return {
            round: Number.isFinite(round) ? Math.trunc(round) : 0,
            table: Number.isFinite(table) ? Math.trunc(table) : 0,
            gameId: normalizeWhitespace(game.gameId || game.oqGameId || ""),
            totalLoss,
            averageLoss,
            nodeCount: Number.isFinite(Number(game.nodeCount))
              ? Math.max(0, Math.trunc(Number(game.nodeCount)))
              : 0,
            offlineFilled: game.offlineFilled === true,
          };
        });
        const plyGroups = {};
        const rawPlyGroups =
          player.plyGroups && typeof player.plyGroups === "object"
            ? player.plyGroups
            : {};
        Object.entries(rawPlyGroups).forEach(([groupKey, rawGroup]) => {
          const group = rawGroup && typeof rawGroup === "object" ? rawGroup : {};
          const averageLoss = readNumber(group.averageLoss, group.avgLoss);
          const count = readNumber(group.count);
          plyGroups[String(groupKey)] = {
            averageLoss,
            count: Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0,
          };
        });
        const averageLoss = readNumber(player.averageLoss, player.avgLoss);
        const totalLoss = readNumber(player.totalLoss, player.loss);
        const averageGameLoss = readNumber(
          player.averageGameLoss,
          player.gameAverageLoss,
          player.avgGameLoss,
        );
        if (!name && !account && !normalizeWhitespace(player.key || "")) return null;
        return {
          key: normalizeWhitespace(player.key || name || account),
          name,
          account,
          gameCount: Number.isFinite(Number(player.gameCount))
            ? Math.max(0, Math.trunc(Number(player.gameCount)))
            : games.length,
          nodeCount: Number.isFinite(Number(player.nodeCount))
            ? Math.max(0, Math.trunc(Number(player.nodeCount)))
            : 0,
          totalLoss: Number.isFinite(totalLoss) ? totalLoss : 0,
          averageLoss,
          averageGameLoss,
          games,
          plyGroups,
        };
      })
      .filter(Boolean);
    const roundLimit = readNumber(source.roundLimit);
    const gameCount = readNumber(source.gameCount);
    const playerCount = readNumber(source.playerCount);
    return {
      schema: normalizeWhitespace(source.schema || "papp-eg-analysis-v1"),
      updatedAt: normalizeWhitespace(source.updatedAt || source.finishedAt || ""),
      scope: "preliminary-and-playoffs",
      roundLimit: Number.isFinite(roundLimit) ? Math.max(0, Math.trunc(roundLimit)) : 0,
      summaryFile: normalizeWhitespace(source.summaryFile || ""),
      gameCount: Number.isFinite(gameCount) ? Math.max(0, Math.trunc(gameCount)) : 0,
      playerCount: Number.isFinite(playerCount)
        ? Math.max(0, Math.trunc(playerCount))
        : topPlayers.length,
      topPlayers,
      pairingLossByRound:
        source.pairingLossByRound && typeof source.pairingLossByRound === "object"
          ? { ...source.pairingLossByRound }
          : {},
      engine:
        source.engine && typeof source.engine === "object" ? { ...source.engine } : {},
    };
  }

  function sanitizeScoreItem(raw) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const sender = normalizeWhitespace(obj.sender || obj.senderName || "");
    const opponent = normalizeWhitespace(obj.opponent || obj.opponentName || "");
    const loserStoneRaw =
      obj.loserStoneCount != null
        ? Number(obj.loserStoneCount)
        : obj.loser_stone_count != null
          ? Number(obj.loser_stone_count)
          : obj.isDraw
            ? 32
            : Number(obj.opponentScore);
    const senderScoreRaw = Number(obj.senderScore);
    const opponentScoreRaw = Number(obj.opponentScore);
    const roundRaw = Number(obj.round);
    return {
      id:
        normalizeWhitespace(obj.id) ||
        `score-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      round: Number.isFinite(roundRaw) && roundRaw > 0 ? Math.trunc(roundRaw) : 1,
      sourceTime: normalizeWhitespace(obj.sourceTime || obj.time || ""),
      sender,
      wechatSender: normalizeWhitespace(obj.wechatSender || ""),
      senderAccount: normalizeWhitespace(obj.senderAccount || ""),
      opponent,
      black: normalizeWhitespace(obj.black || obj.blackName || ""),
      white: normalizeWhitespace(obj.white || obj.whiteName || ""),
      blackAccount: normalizeWhitespace(obj.blackAccount || ""),
      whiteAccount: normalizeWhitespace(obj.whiteAccount || ""),
      pendingKind: normalizeWhitespace(obj.pendingKind || ""),
      pendingTable: normalizeWhitespace(String(obj.pendingTable || obj.table || "")),
      oqGameId: normalizeWhitespace(obj.oqGameId || obj.gameId || ""),
      loserStoneCount: Number.isFinite(loserStoneRaw)
        ? Math.max(0, Math.trunc(loserStoneRaw))
        : null,
      verdict: normalizeWhitespace(obj.verdict || obj.status || ""),
      senderScore: Number.isFinite(senderScoreRaw)
        ? Math.max(0, Math.trunc(senderScoreRaw))
        : null,
      opponentScore: Number.isFinite(opponentScoreRaw)
        ? Math.max(0, Math.trunc(opponentScoreRaw))
        : null,
      resultText: normalizeWhitespace(obj.resultText || obj.summary || ""),
      reason: normalizeWhitespace(obj.reason || ""),
      reviewAction: normalizeWhitespace(obj.reviewAction || ""),
      pairingId: normalizeWhitespace(obj.pairingId || ""),
      accountMismatchText: normalizeWhitespace(obj.accountMismatchText || ""),
      resultKind: normalizeWhitespace(obj.resultKind || ""),
      resultSource: normalizeWhitespace(obj.resultSource || ""),
      lastEditedBy: normalizeWhitespace(obj.lastEditedBy || ""),
      lastEditedAt: Number.isFinite(Number(obj.lastEditedAt)) ? Number(obj.lastEditedAt) : null,
      oqFollowupDetected: obj.oqFollowupDetected === true,
      oqFollowupAt: normalizeWhitespace(obj.oqFollowupAt || ""),
      oqFollowupReason: normalizeWhitespace(obj.oqFollowupReason || ""),
      oqFollowup: obj.oqFollowup && typeof obj.oqFollowup === "object"
        ? deepClone(obj.oqFollowup)
        : null,
      oqFollowupCandidates: Array.isArray(obj.oqFollowupCandidates)
        ? deepClone(obj.oqFollowupCandidates.slice(0, 12))
        : [],
      oqPendingDetail: obj.oqPendingDetail && typeof obj.oqPendingDetail === "object"
        ? deepClone(obj.oqPendingDetail)
        : null,
      oqScoreMismatch: Array.isArray(obj.oqScoreMismatch)
        ? deepClone(obj.oqScoreMismatch.slice(0, 12))
        : [],
      resolvedByReferee: obj.resolvedByReferee === true,
      resolutionStatus: normalizeWhitespace(obj.resolutionStatus || ""),
      selectedSourceKey: normalizeWhitespace(obj.selectedSourceKey || ""),
      oqCandidates: Array.isArray(obj.oqCandidates)
        ? obj.oqCandidates.slice(0, 12).map((candidate) =>
            candidate && typeof candidate === "object"
              ? deepClone(candidate)
              : { value: String(candidate || "") },
          )
        : [],
      imagePath: normalizeWhitespace(obj.imagePath || obj.pngPath || obj.previewPath || ""),
      sourceMessageKey: normalizeWhitespace(obj.sourceMessageKey || ""),
      sourceLocalId: normalizeWhitespace(obj.sourceLocalId || obj.local_id || ""),
      ocrText: normalizeWhitespace(obj.ocrText || ""),
      confidence: normalizeWhitespace(obj.confidence || ""),
      registeredAt: Number.isFinite(Number(obj.registeredAt))
        ? Number(obj.registeredAt)
        : null,
      manualPendingAt: Number.isFinite(Number(obj.manualPendingAt))
        ? Number(obj.manualPendingAt)
        : null,
    };
  }

  function sanitizeScorePairing(raw, fallbackTable) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const tableRaw = Number(obj.table);
    const table =
      Number.isFinite(tableRaw) && tableRaw > 0
        ? Math.trunc(tableRaw)
        : Math.max(1, Math.trunc(Number(fallbackTable) || 1));
    const blackScore = scoreValue(obj.blackScore);
    const whiteScore = scoreValue(obj.whiteScore);
    const black = normalizeWhitespace(obj.black || obj.blackName || "");
    const white = normalizeWhitespace(obj.white || obj.whiteName || "");
    const requestedStatus = normalizeWhitespace(obj.status || "imported").toLowerCase();
    const pappReadbackAt = normalizeWhitespace(obj.pappReadbackAt || "");
    const hasValidBoardScore = blackScore !== null && whiteScore !== null &&
      blackScore + whiteScore === 64;
    const hasValidBoardResult = Boolean(black && white && hasValidBoardScore);
    const status = requestedStatus === "completed" &&
      (!pappReadbackAt || !hasValidBoardResult)
      ? hasValidBoardResult ? "ready" : "imported"
      : requestedStatus;
    return {
      id:
        normalizeWhitespace(obj.id || obj.pairingId) ||
        `pairing-${table}`,
      table,
      black,
      white,
      blackAccount: normalizeWhitespace(obj.blackAccount || ""),
      whiteAccount: normalizeWhitespace(obj.whiteAccount || ""),
      oqGameId: normalizeWhitespace(obj.oqGameId || obj.gameId || ""),
      status: ["imported", "pending", "ready", "completed", "bye", "dirty"].includes(status)
        ? status
        : "imported",
      blackScore,
      whiteScore,
      oqUpdatedAt: normalizeWhitespace(obj.oqUpdatedAt || ""),
      source: normalizeWhitespace(obj.source || ""),
      reporter: normalizeWhitespace(obj.reporter || ""),
      opponent: normalizeWhitespace(obj.opponent || ""),
      resultText: normalizeWhitespace(obj.resultText || ""),
      reason: normalizeWhitespace(obj.reason || ""),
      sourceMessageKey: normalizeWhitespace(obj.sourceMessageKey || ""),
      sourceLocalId: normalizeWhitespace(obj.sourceLocalId || ""),
      imagePath: normalizeWhitespace(obj.imagePath || ""),
      resultKind: normalizeWhitespace(obj.resultKind || ""),
      resultSource: normalizeWhitespace(obj.resultSource || ""),
      resultTime: normalizeWhitespace(obj.resultTime || ""),
      resultSortKey: Number.isFinite(Number(obj.resultSortKey)) ? Number(obj.resultSortKey) : null,
      completedAt: obj.completedAt == null ? null : obj.completedAt,
      pappReadbackAt,
      lastEditedBy: normalizeWhitespace(obj.lastEditedBy || ""),
      lastEditedAt: Number.isFinite(Number(obj.lastEditedAt)) ? Number(obj.lastEditedAt) : null,
      updatedAt: Number.isFinite(Number(obj.updatedAt)) ? Number(obj.updatedAt) : null,
      dirty: obj.dirty === true,
      userPending: obj.userPending === true,
      userEditedFields: obj.userEditedFields && typeof obj.userEditedFields === "object"
        ? deepClone(obj.userEditedFields)
        : {},
      oqAutoAudit: obj.oqAutoAudit && typeof obj.oqAutoAudit === "object"
        ? deepClone(obj.oqAutoAudit)
        : null,
      oqGameAvailable: obj.oqGameAvailable === true,
      oqGameAvailableAt: Number.isFinite(Number(obj.oqGameAvailableAt))
        ? Number(obj.oqGameAvailableAt)
        : null,
      oqGameAvailableAudit: obj.oqGameAvailableAudit && typeof obj.oqGameAvailableAudit === "object"
        ? deepClone(obj.oqGameAvailableAudit)
        : null,
      metadata:
        obj.metadata && typeof obj.metadata === "object"
          ? deepClone(obj.metadata)
          : {},
    };
  }

  function scoreValue(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 64 ? number : null;
  }

  function isBoardScorePairing(pairing) {
    const item = pairing && typeof pairing === "object" ? pairing : {};
    if (normalizeWhitespace(item.status).toLowerCase() === "bye" ||
        !normalizeWhitespace(item.black) || !normalizeWhitespace(item.white)) {
      return false;
    }
    const blackScore = scoreValue(item.blackScore);
    const whiteScore = scoreValue(item.whiteScore);
    return blackScore !== null && whiteScore !== null && blackScore + whiteScore === 64;
  }

  function isPappReadbackConfirmedPairing(pairing) {
    return normalizeWhitespace(pairing && pairing.status).toLowerCase() === "completed" &&
      Boolean(normalizeWhitespace(pairing && pairing.pappReadbackAt)) &&
      isBoardScorePairing(pairing);
  }

  function isLegacyScorePairing(pairing) {
    const item = pairing && typeof pairing === "object" ? pairing : {};
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    const papp = metadata.papp && typeof metadata.papp === "object" ? metadata.papp : {};
    const source = normalizeWhitespace(item.source || metadata.source || papp.source).toLowerCase();
    return source === "papp-adapter" || source === "papp-local" ||
      source === "papp-local-playoff";
  }

  function hasLegacyTournamentHistory(helper = ensureScoreHelper()) {
    const rounds = Array.isArray(helper && helper.rounds) ? helper.rounds : [];
    return rounds.some((round) => Array.isArray(round && round.pairings) &&
      round.pairings.some(isLegacyScorePairing));
  }

  async function complementBoardScore(value, side) {
    const result = assertAdapterSuccess(
      await invokeTournamentAdapter("validateScore", {
        blackScore: side === "black" ? value : null,
        whiteScore: side === "white" ? value : null,
      }),
      "PAPP C 比分校验失败",
    );
    return result.complete === true && result.scorePair
      ? result.scorePair
      : { blackScore: null, whiteScore: null };
  }

  function isScoreBatchCandidate(pairing) {
    return normalizeWhitespace(pairing && pairing.status).toLowerCase() === "ready" &&
      isBoardScorePairing(pairing);
  }

  function scoreParticipantKey(pairing, side) {
    const item = pairing && typeof pairing === "object" ? pairing : {};
    const account = normalizeWhitespace(item[`${side}Account`]).toLowerCase();
    const name = normalizeKey(item[side] || item[`${side}Name`]);
    return account ? `account:${account}` : name ? `name:${name}` : "";
  }

  function sameScorePairingIdentity(expected, observed) {
    const left = expected && typeof expected === "object" ? expected : {};
    const right = observed && typeof observed === "object" ? observed : {};
    const leftId = normalizeWhitespace(left.id || left.pairingId);
    const rightId = normalizeWhitespace(right.id || right.pairingId);
    if (leftId || rightId) return Boolean(leftId && rightId && leftId === rightId);
    const leftGame = normalizeWhitespace(left.oqGameId || left.gameId);
    const rightGame = normalizeWhitespace(right.oqGameId || right.gameId);
    if (leftGame || rightGame) return Boolean(leftGame && rightGame && leftGame === rightGame);
    const black = scoreParticipantKey(left, "black");
    const white = scoreParticipantKey(left, "white");
    return Boolean(black && white &&
      black === scoreParticipantKey(right, "black") &&
      white === scoreParticipantKey(right, "white"));
  }

  function sameScorePairingParticipants(expected, observed) {
    return Boolean(
      scoreParticipantKey(expected, "black") &&
      scoreParticipantKey(expected, "white") &&
      scoreParticipantKey(expected, "black") === scoreParticipantKey(observed, "black") &&
      scoreParticipantKey(expected, "white") === scoreParticipantKey(observed, "white"),
    );
  }

  function scorePairingScoresMatch(expected, observed) {
    const item = observed && typeof observed === "object" ? observed : {};
    return sameScorePairingIdentity(expected, item) &&
      sameScorePairingParticipants(expected, item) &&
      isBoardScorePairing(expected) &&
      isBoardScorePairing(item) &&
      scoreValue(expected.blackScore) === scoreValue(item.blackScore) &&
      scoreValue(expected.whiteScore) === scoreValue(item.whiteScore);
  }

  function scorePairingConfirmedByReadback(expected, observed) {
    return normalizeWhitespace(observed && observed.status).toLowerCase() === "completed" &&
      scorePairingScoresMatch(expected, observed);
  }

  function sanitizeScoreRound(raw, fallbackRound) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const roundRaw = Number(obj.round);
    const round =
      Number.isFinite(roundRaw) && roundRaw > 0
        ? Math.trunc(roundRaw)
        : fallbackRound;
    const pending = Array.isArray(obj.pending)
      ? obj.pending.map(sanitizeScoreItem)
      : [];
    const manualPending = Array.isArray(obj.manualPending)
      ? obj.manualPending.map(sanitizeScoreItem)
      : [];
    const completed = Array.isArray(obj.completed)
      ? obj.completed.map(sanitizeScoreItem)
      : [];
    pending.forEach((item) => {
      item.round = round;
    });
    manualPending.forEach((item) => {
      item.round = round;
    });
    completed.forEach((item) => {
      item.round = round;
    });
    const rawPairings = Array.isArray(obj.pairings)
      ? obj.pairings
      : Array.isArray(obj.ftdPairings)
        ? obj.ftdPairings
        : [];
    const pairings = rawPairings.map((item, index) =>
      sanitizeScorePairing(item, index + 1),
    );
    const oq = obj.oq && typeof obj.oq === "object" ? obj.oq : {};
    const eg = obj.eg && typeof obj.eg === "object" ? obj.eg : {};
    return {
      round,
      stage: "preliminary",
      roundStartAt: normalizeWhitespace(obj.roundStartAt || ""),
      roundStartSource: normalizeWhitespace(obj.roundStartSource || ""),
      pairings,
      pending,
      manualPending,
      completed,
      oq: {
        lastPollAt: normalizeWhitespace(oq.lastPollAt || ""),
        lastOk: typeof oq.lastOk === "boolean" ? oq.lastOk : null,
        lastError: normalizeWhitespace(oq.lastError || ""),
        queryErrors: oq.queryErrors && typeof oq.queryErrors === "object"
          ? deepClone(oq.queryErrors)
          : {},
        window: oq.window && typeof oq.window === "object"
          ? deepClone(oq.window)
          : null,
      },
      eg: {
        lastStartedAt: normalizeWhitespace(eg.lastStartedAt || ""),
        lastFinishedAt: normalizeWhitespace(eg.lastFinishedAt || ""),
        lastError: normalizeWhitespace(eg.lastError || ""),
      },
    };
  }

  function sanitizePlayoffRegistration(raw, fallbackPreliminaryRoundCount = 1) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const parsedRoundCount = Number(obj.preliminaryRoundCount);
    const preliminaryRoundCount = Math.max(
      1,
      Math.trunc(
        Number.isFinite(parsedRoundCount) && parsedRoundCount >= 1
          ? parsedRoundCount
          : fallbackPreliminaryRoundCount,
      ) || 1,
    );
    const semifinalPairings = Array.isArray(obj.semifinalPairings)
      ? obj.semifinalPairings.map((pairing, index) => sanitizeScorePairing(pairing, index + 1))
      : [];
    const placementPairings = Array.isArray(obj.placementPairings)
      ? obj.placementPairings.map((pairing, index) => sanitizeScorePairing(pairing, index + 1))
      : [];
    const requestedStage = normalizeWhitespace(obj.activeStage).toLowerCase();
    return {
      version: 1,
      preliminaryRoundCount,
      activeStage: requestedStage === "placement" ||
        (!requestedStage && placementPairings.length > 0)
        ? "placement"
        : "semifinal",
      semifinalRoundStartAt: sanitizeScoreRoundTimestamp(obj.semifinalRoundStartAt),
      semifinalRoundStartSource: normalizeWhitespace(obj.semifinalRoundStartSource),
      semifinalRoundEndAt: sanitizeScoreRoundTimestamp(obj.semifinalRoundEndAt),
      semifinalWindowMinutes: sanitizeRoundWindowMinutes(obj.semifinalWindowMinutes),
      semifinalPairings,
      placementRoundStartAt: sanitizeScoreRoundTimestamp(obj.placementRoundStartAt),
      placementRoundStartSource: normalizeWhitespace(obj.placementRoundStartSource),
      placementRoundEndAt: sanitizeScoreRoundTimestamp(obj.placementRoundEndAt),
      placementWindowMinutes: sanitizeRoundWindowMinutes(obj.placementWindowMinutes),
      placementPairings,
      updatedAt: Number.isFinite(Number(obj.updatedAt))
        ? Number(obj.updatedAt)
        : null,
    };
  }

  function sanitizeScoreHelper(raw) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const workfileId = normalizeWhitespace(obj.pappWorkfileId);
    const parsedPreliminary = Number(obj.preliminaryRoundCount);
    const parsedCount = Number(obj.roundCount);
    const sourceRounds = Array.isArray(obj.rounds) ? obj.rounds : [];
    const derivedCount = Number.isFinite(parsedPreliminary)
      ? parsedPreliminary
      : sourceRounds.length || parsedCount || 1;
    const roundCount = Math.max(1, Math.trunc(Number(derivedCount) || 1));
    const rounds = [];
    for (let i = 0; i < roundCount; i++) {
      rounds.push(sanitizeScoreRound(sourceRounds[i], i + 1));
    }
    const activeRaw = Number(obj.activeRound);
    const activeRound =
      Number.isFinite(activeRaw) && activeRaw >= 1 && activeRaw <= roundCount
        ? Math.trunc(activeRaw)
        : 1;
    return {
      version: 2,
      pappWorkfileId: /^[A-Za-z0-9_-]{1,128}$/.test(workfileId)
        ? workfileId
        : createPappWorkfileId(),
      preliminaryRoundCount: roundCount,
      roundCount,
      roundCountSource:
        obj.roundCountSource === "manual" || obj.roundCountSource === "auto"
          ? obj.roundCountSource
          : "default",
      autoRoundCountPlayerCount: Number.isFinite(
        Number(obj.autoRoundCountPlayerCount),
      )
        ? Math.max(0, Math.trunc(Number(obj.autoRoundCountPlayerCount)))
        : null,
      activeRound,
      rounds,
      updatedAt: Number.isFinite(Number(obj.updatedAt))
        ? Number(obj.updatedAt)
        : null,
    };
  }

  function createDefaultMapping() {
    return {
      version: 1,
      groupName: "",
      groupUsername: "",
      groupOverride: "",
      groupNicks: [],
      memberCount: 0,
      mappedCount: 0,
      refreshedAt: "",
      rows: [],
      excludedCheckinPlayerIds: [],
      oqValidation: {
        checkedAt: "",
        checkedCount: 0,
        okCount: 0,
        invalidCount: 0,
        wallMs: 0,
      },
      lastAppliedAt: "",
      updatedAt: null,
    };
  }

  function mappingRowId(rawId, index) {
    const candidate = rawId === null || rawId === undefined
      ? ""
      : normalizeWhitespace(String(rawId));
    return candidate || `mapping-${Date.now().toString(36)}-${index}-${Math.random().toString(16).slice(2, 8)}`;
  }

  function mappingTextId(value) {
    return value === null || value === undefined
      ? ""
      : normalizeWhitespace(String(value));
  }

  function mappingNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function mappingInteger(value) {
    const number = mappingNumber(value);
    return number === null ? null : Math.max(0, Math.trunc(number));
  }

  function sanitizeMappingCheck(raw) {
    const obj = raw && typeof raw === "object" ? raw : {};
    const profile = obj.profile && typeof obj.profile === "object" ? obj.profile : {};
    const status = normalizeWhitespace(obj.status).toLowerCase();
    const read = (...keys) => {
      for (const source of [obj, profile]) {
        for (const key of keys) {
          if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
            return source[key];
          }
        }
      }
      return null;
    };
    const win = mappingInteger(read("win"));
    const loss = mappingInteger(read("loss"));
    const draw = mappingInteger(read("draw"));
    const wld = [win, loss, draw];
    const wldTotal = wld.every((value) => value !== null)
      ? wld.reduce((sum, value) => sum + value, 0)
      : null;
    const played = mappingInteger(read("played")) ?? wldTotal;
    const n = mappingInteger(read("n", "N")) ?? wldTotal ?? played;
    const rating = mappingNumber(read("rating"));
    const high = mappingNumber(read("high"));
    const hiddenR = mappingNumber(read("hiddenR"));
    const maturity = mappingNumber(read("maturity"));
    const explicitQuestionMark =
      typeof obj.questionMark === "boolean"
        ? obj.questionMark
        : typeof obj.needsQuestionMark === "boolean"
          ? obj.needsQuestionMark
          : null;
    const profileStatus = normalizeWhitespace(obj.profileStatus || "").toLowerCase();
    return {
      account: normalizeWhitespace(obj.account),
      status: status === "ok" || status === "invalid" || status === "forced-ok" ? status : "",
      checkedAt: normalizeWhitespace(obj.checkedAt),
      mode: normalizeWhitespace(obj.mode),
      primaryMode: normalizeWhitespace(obj.primaryMode),
      fallbackUsed: Boolean(obj.fallbackUsed),
      elapsedMs: Number.isFinite(Number(obj.elapsedMs)) ? Number(obj.elapsedMs) : 0,
      totalGames: Number.isFinite(Number(obj.totalGames)) ? Math.max(0, Math.trunc(Number(obj.totalGames))) : 0,
      windowGames: Number.isFinite(Number(obj.windowGames)) ? Math.max(0, Math.trunc(Number(obj.windowGames))) : 0,
      error: normalizeWhitespace(obj.error),
      rating,
      high,
      hiddenR,
      played,
      n,
      win,
      loss,
      draw,
      maturity,
      profileStatus,
      profileError: normalizeWhitespace(obj.profileError),
      profileReady:
        obj.profileReady === true ||
        profileStatus === "ok" ||
        rating !== null ||
        high !== null ||
        hiddenR !== null ||
        n !== null,
      questionMark: explicitQuestionMark,
    };
  }

  function sanitizeMapping(raw) {
    const source = Array.isArray(raw)
      ? { rows: raw }
      : raw && typeof raw === "object"
        ? raw
        : {};
    const legacyNickPayload =
      source.wechatGroupNicks && typeof source.wechatGroupNicks === "object"
        ? source.wechatGroupNicks
        : {};

    const rawNicks = [];
    const appendNick = (value) => {
      const nick = normalizeWhitespace(value);
      if (nick && !rawNicks.some((item) => normalizeKey(item) === normalizeKey(nick))) {
        rawNicks.push(nick);
      }
    };
    for (const value of [
      ...(Array.isArray(source.groupNicks) ? source.groupNicks : []),
      ...(Array.isArray(legacyNickPayload.groupNicks) ? legacyNickPayload.groupNicks : []),
    ]) {
      if (value && typeof value === "object") appendNick(value.groupNick || value.group_nick);
      else appendNick(value);
    }
    for (const member of [
      ...(Array.isArray(source.members) ? source.members : []),
      ...(Array.isArray(legacyNickPayload.members) ? legacyNickPayload.members : []),
    ]) {
      if (member && typeof member === "object") appendNick(member.groupNick || member.group_nick);
    }

    const rawRows = Array.isArray(source.rows)
      ? source.rows
      : Array.isArray(source.mappings)
        ? source.mappings
        : Array.isArray(source.players)
          ? source.players
          : [];
    const usedIds = new Set();
    const rows = [];
    rawRows.forEach((item, index) => {
      const obj = item && typeof item === "object" ? item : {};
      const wechatNick = normalizeWhitespace(
        obj.wechatNick || obj.groupNick || obj.group_nick || obj["微信群昵称"],
      );
      const registrationNick = normalizeWhitespace(
        obj.registrationNick ||
          obj.signupNick ||
          obj.rosterName ||
          obj.ftdName ||
          obj.displayName ||
          obj.name ||
          obj["报名昵称"],
      );
      const oqAccount = normalizeWhitespace(
        obj.oqAccount || obj.account || obj.oq || obj["oq账号"],
      );
      const checkinPlayerId = mappingTextId(
        obj.checkinPlayerId || obj.candidatePlayerId,
      );
      if (!wechatNick && !registrationNick && !oqAccount && !checkinPlayerId) return;
      let id = mappingRowId(obj.id, index);
      while (usedIds.has(id)) id = mappingRowId("", index);
      usedIds.add(id);
      rows.push({
        id,
        wechatNick,
        wechatNickSource:
          obj.wechatNickSource === "auto" ||
          obj.wechatNickSource === "history" ||
          obj.wechatNickSource === "manual"
            ? obj.wechatNickSource
            : "",
        registrationNick,
        oqAccount,
        oqCheck: sanitizeMappingCheck(obj.oqCheck),
        checkinPlayerId,
        scriptLocked: obj.scriptLocked === true,
      });
    });

    const excludedCheckinPlayerIds = Array.isArray(source.excludedCheckinPlayerIds)
      ? Array.from(
          new Set(
            source.excludedCheckinPlayerIds
              .map((value) => mappingTextId(value))
              .filter(Boolean),
          ),
        )
      : [];

    const oqValidation = source.oqValidation && typeof source.oqValidation === "object"
      ? source.oqValidation
      : {};
    return {
      version: 1,
      groupName: normalizeWhitespace(source.groupName || source.group_name || legacyNickPayload.groupName),
      groupUsername: normalizeWhitespace(
        source.groupUsername || source.roomUsername || source.room_username ||
          legacyNickPayload.roomUsername || legacyNickPayload.room_username,
      ),
      groupOverride: normalizeWhitespace(
        source.groupOverride || source.group_override,
      ),
      groupNicks: rawNicks,
      memberCount: Number.isFinite(Number(source.memberCount || source.member_count || legacyNickPayload.memberCount))
        ? Math.max(0, Math.trunc(Number(source.memberCount || source.member_count || legacyNickPayload.memberCount)))
        : rawNicks.length,
      mappedCount: Number.isFinite(Number(source.mappedCount || source.mapped_count || legacyNickPayload.mappedCount))
        ? Math.max(0, Math.trunc(Number(source.mappedCount || source.mapped_count || legacyNickPayload.mappedCount)))
        : rawNicks.length,
      refreshedAt: normalizeWhitespace(source.refreshedAt || source.refreshed_at || legacyNickPayload.refreshedAt),
      rows,
      excludedCheckinPlayerIds,
      oqValidation: {
        checkedAt: normalizeWhitespace(oqValidation.checkedAt || oqValidation.checked_at),
        checkedCount: Number.isFinite(Number(oqValidation.checkedCount || oqValidation.checked_count))
          ? Math.max(0, Math.trunc(Number(oqValidation.checkedCount || oqValidation.checked_count)))
          : 0,
        okCount: Number.isFinite(Number(oqValidation.okCount || oqValidation.ok_count))
          ? Math.max(0, Math.trunc(Number(oqValidation.okCount || oqValidation.ok_count)))
          : 0,
        invalidCount: Number.isFinite(Number(oqValidation.invalidCount || oqValidation.invalid_count))
          ? Math.max(0, Math.trunc(Number(oqValidation.invalidCount || oqValidation.invalid_count)))
          : 0,
        wallMs: Number.isFinite(Number(oqValidation.wallMs)) ? Math.max(0, Number(oqValidation.wallMs)) : 0,
      },
      lastAppliedAt: normalizeWhitespace(source.lastAppliedAt || source.last_applied_at),
      updatedAt: Number.isFinite(Number(source.updatedAt || source.updated_at))
        ? Number(source.updatedAt || source.updated_at)
        : null,
    };
  }

  function comparePlayersForList(a, b) {
    const ga = normalizeWhitespace(a && a.group) || "未分组";
    const gb = normalizeWhitespace(b && b.group) || "未分组";
    const gcmp = nameCollator.compare(ga, gb);
    if (gcmp !== 0) return gcmp;

    // Prefer players with account first (helps dedupe readability)
    const ha = a && a.account ? 1 : 0;
    const hb = b && b.account ? 1 : 0;
    if (ha !== hb) return hb - ha;

    const na = normalizeWhitespace(a && a.displayName);
    const nb = normalizeWhitespace(b && b.displayName);
    return nameCollator.compare(na, nb);
  }

  // ------------------------------
  // Import parsing
  // ------------------------------
  const instructionKeywords = [
    "接龙",
    "接龍",
    "报名",
    "比赛",
    "截止",
    "签到",
    "点名",
    "开始",
    "格式",
    "昵称",
    "账号",
    "平台",
    "时间",
    "名单",
    "全部",
    "长期",
    "成员",
    "俱乐部",
    "赛事",
    "重要",
    "要求",
    "赛制",
    "详情",
    "查看",
    "文件",
    "正式版",
    "奖金",
    "红包",
    "发放",
    "裁判",
    "对局",
    "记录",
    "分数",
    "无问号",
    "以下",
    "vint",
    "xot",
    "5min",
    "注册",
    "房间",
    "点击",
    "http",
    "https",
  ];

  const standaloneNoiseLines = new Set([
    "oq",
    "othelloquest",
    "othello quest",
    "playok",
    "vint",
    "xot",
    "已签到",
    "等待中",
    "待签到",
    "签到",
    "取消签到",
    "已取消",
    "设为新人",
    "取消新人",
    "新人",
    "编辑",
    "删除",
    "无差别组",
    "青少年组",
    "新人赛",
    "新人组",
    "特殊赛",
    "长期名单",
    "长期成员",
  ]);

  function normalizeStandaloneNoiseLine(line) {
    let t = normalizeWhitespace(line);
    if (!t) return "";
    t = unwrapBrackets(t);
    t = stripListIndex(t);
    t = t.replace(/[|｜丨]/g, " ");
    t = t.replace(/[#:：]/g, " ");
    t = normalizeWhitespace(t.replace(/[，,。.;；]+$/g, ""));
    return t;
  }

  function isStandaloneUiOrPlatformNoiseLine(line) {
    const t = normalizeStandaloneNoiseLine(line);
    if (!t) return true;
    const lower = t.toLowerCase();
    if (standaloneNoiseLines.has(t) || standaloneNoiseLines.has(lower)) {
      return true;
    }
    if (/^(?:平台|platform)\s*(?:oq|othello\s*quest|othelloquest|playok|vint|xot)$/i.test(t)) {
      return true;
    }
    if (/^(?:状态|status)\s*(?:已签到|等待中|待签到)$/i.test(t)) {
      return true;
    }
    if (/^(?:组别|group)\s*(?:无差别组|青少年组|新人赛|新人组|特殊赛|长期名单|长期成员)$/i.test(t)) {
      return true;
    }
    return false;
  }

  function looksLikeGroupHeading(line) {
    const t = normalizeWhitespace(line);
    if (!t) return null;

    // Examples: "无差别组：" "新人赛：" "特殊赛：" "青少年组："
    // Also allow "xxx组" / "xxx赛" without colon.
    if (/^.{1,16}(组|赛)\s*[:：]?$/.test(t) && !/[a-z0-9_]/i.test(t)) {
      // Normalize: remove trailing colon
      return normalizeWhitespace(t.replace(/[:：]\s*$/, ""));
    }
    return null;
  }

  function detectGroupHeadingByRules(line, activeRules = null) {
    const t = normalizeWhitespace(line);
    if (!t) return null;

    // Simple headings are handled first.
    const simple = looksLikeGroupHeading(t);
    if (simple) {
      // Keep group naming consistent: map common aliases (e.g. “新人赛组” → “新人赛”) when
      // they match an existing rule keyword. If no rule matches, keep the original heading.
      const compactSimple = simple.toLowerCase().replace(/\s+/g, "");
      const rules = Array.isArray(activeRules)
        ? activeRules
        : getActiveGroupRules();
      for (const rule of rules) {
        const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
        for (const kw of keywords) {
          const needle = normalizeWhitespace(kw)
            .toLowerCase()
            .replace(/\s+/g, "");
          if (!needle) continue;
          if (
            compactSimple.includes(needle) ||
            needle.includes(compactSimple)
          ) {
            return normalizeWhitespace(rule.group) || simple;
          }
        }
      }
      return simple;
    }

    // Avoid turning numbered player rows into group headings.
    if (/^\s*(?:\d{1,3}|[０-９]{1,3})\s*[\.．、\)\]）］]/.test(t)) return null;

    // Heuristic context: title-like lines in relays.
    const headingLike =
      /[#【】\[\]「」《》]/.test(t) ||
      /接龙|接龍|报名|比賽|比赛|签到|点名|名单|组|赛/.test(t);
    if (!headingLike) return null;

    const compact = t.toLowerCase().replace(/\s+/g, "");
    const rules = Array.isArray(activeRules)
      ? activeRules
      : getActiveGroupRules();
    for (const rule of rules) {
      const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
      for (const kw of keywords) {
        const needle = normalizeWhitespace(kw)
          .toLowerCase()
          .replace(/\s+/g, "");
        if (!needle) continue;
        if (compact.includes(needle))
          return normalizeWhitespace(rule.group) || null;
      }
    }
    return null;
  }

  function looksLikeInstructionLine(rawLine) {
    const t = normalizeWhitespace(rawLine);
    if (!t) return true;
    if (isStandaloneUiOrPlatformNoiseLine(t)) return true;

    if (t.startsWith("#")) return true;
    if (/^如\s*[:：]/.test(t) || /^例如\s*[:：]/.test(t)) return true;
    if (/^(注|附)\s*[:：]/.test(t)) return true;
    // English "example" prefixes commonly used in some groups.
    if (/^(?:ex\.?|e\.g\.?|eg\.?|example)\s*/i.test(t)) return true;

    // Avoid over-filtering: some nicknames may contain punctuation.
    // Only treat as instruction when it looks like a full sentence.
    if (/[。！？；]/.test(t)) {
      const wordCount = t.split(/\s+/).filter(Boolean).length;
      if (t.length > 28 || wordCount > 6) return true;
    }

    const lower = t.toLowerCase();

    // Some users paste key-value style lines (common in Mainland CN chat apps):
    //   "昵称：张三 账号：abc 俱乐部：...")
    // These lines contain keywords like "昵称/账号/俱乐部" but are actually valid player records.
    // To avoid losing data, if it looks like a KV record (and not a format/example sentence),
    // try a quick parse and accept it when it yields a meaningful name + account/club.
    try {
      const kvHint = /(昵称|姓名|账号|俱乐部|平台|组别)\s*[:：]/.test(t);
      const maybeExample =
        /格式|示例|例如/.test(t) ||
        /^如\s*[:：]/.test(t) ||
        /^例如\s*[:：]/.test(t);
      const hasLink = /https?:\/\//i.test(t) || lower.includes("http");
      if (kvHint && !maybeExample && !hasLink) {
        const parsed = parseLineToFields(t, { group: "", platform: "oq" });
        if (parsed && parsed.displayName && (parsed.account || parsed.club)) {
          return false;
        }
      }
    } catch (_) {
      // ignore
    }

    for (const kw of instructionKeywords) {
      if (lower.includes(kw)) return true;
    }
    return false;
  }

  function isLongTermSectionStart(line) {
    const t = normalizeWhitespace(line);
    if (!t) return false;
    // Latest format example: "长期选手，长期俱乐部格式：" then "全部名单:" then lines...
    if (t.includes("长期选手") && t.includes("俱乐部") && t.includes("格式"))
      return true;
    // Common variants from manually edited relays.
    if (/^长期(?:人员)?名单\s*[:：]?$/.test(t)) return true;
    if (/^全部名单(?:[（(][^）)]*[）)])?\s*[:：]/.test(t)) return true;
    return false;
  }

  const NOT_PARTICIPATING_DASH_CHARS = "\\-‐‑‒–—―﹘﹣－−";
  const NOT_PARTICIPATING_LEADING_DASH_RE = new RegExp(
    `^(?:[${NOT_PARTICIPATING_DASH_CHARS}]\\s*){2,}`,
    "u",
  );
  const NOT_PARTICIPATING_TRAILING_DASH_RE = new RegExp(
    `\\s*(?:[${NOT_PARTICIPATING_DASH_CHARS}]\\s*){2,}\\s*[,，.。;；:：、]*\\s*$`,
    "u",
  );

  function stripNotParticipatingMark(line) {
    // Two or more dash-like marks indicate not participating this time.
    // Examples: "Wang Yiyu --", "Wang Yiyu ——", "Wang Yiyu －－".
    const t = normalizeWhitespace(line);
    if (!t) return { name: "", skip: true };

    const notJoinHint = /(不参加本次比赛|不参赛|不参加本场|弃赛)/;

    // Explanation lines like "--为不参加本次比赛" should not be treated as player names.
    if (NOT_PARTICIPATING_LEADING_DASH_RE.test(t) || notJoinHint.test(t)) {
      return { name: "", skip: true };
    }

    // If line ends with a dash marker, treat as not participating and skip.
    if (NOT_PARTICIPATING_TRAILING_DASH_RE.test(t)) {
      const name = normalizeWhitespace(
        t.replace(NOT_PARTICIPATING_TRAILING_DASH_RE, ""),
      );
      return { name, skip: true };
    }

    return { name: t, skip: false };
  }

  function cleanPlayerLine(rawLine) {
    let cleaned = normalizeWhitespace(rawLine);
    if (!cleaned) return "";

    cleaned = unwrapBrackets(cleaned);
    cleaned = stripListIndex(cleaned);

    // Common bullet prefixes
    cleaned = cleaned.replace(/^[>*•·\-–—\s]+/, "");
    cleaned = cleaned.replace(/^[.。．]\s*(?=[\u4e00-\u9fffA-Za-z])/, "");

    // Plus sign sometimes used as separator: "昵称+账号"
    cleaned = cleaned.replace(/\+/g, " ");

    // Normalize dash-like unicode chars to ASCII hyphen
    // so patterns like "name—account" can be parsed reliably.
    cleaned = cleaned.replace(/[‐‑‒–—―﹘﹣－]/g, "-");

    // Replace some separators
    cleaned = cleaned.replace(/[#:：]/g, " ");
    cleaned = cleaned.replace(/([\u4e00-\u9fff])[,，]\s*([A-Za-z0-9_])/g, "$1 $2");
    // Common column separators when copying from tables or chat messages
    cleaned = cleaned.replace(/[|｜丨]/g, " ");
    cleaned = cleaned.replace(/[\/／]/g, " ");
    cleaned = cleaned.replace(/↓|×/g, " ");

    cleaned = normalizeWhitespace(cleaned);

    // Remove common field labels (so lines like "昵称：张三 账号：abc 俱乐部：Zeb" can be parsed)
    try {
      const drop = new Set(["昵称", "姓名", "账号", "俱乐部", "平台", "组别"]);
      const tokens = cleaned
        .split(" ")
        .map((x) => normalizeWhitespace(x))
        .filter(Boolean)
        .filter((tok) => {
          if (drop.has(tok)) return false;
          const low = tok.toLowerCase();
          if (low === "id" || low === "club") return false;
          return true;
        });
      cleaned = normalizeWhitespace(tokens.join(" "));
    } catch (_) {
      // ignore
    }

    // Remove trailing punctuation
    cleaned = cleaned.replace(/[，,。.;；:：]+$/g, "");
    cleaned = normalizeWhitespace(cleaned);

    return cleaned;
  }

  function isDecorativeOnlyLine(line) {
    const t = normalizeWhitespace(line);
    if (!t) return true;
    return /^(?:[👇☝️👆⬇️⬆️↓↑↧↥]+|\/?\s*[👇☝️👆⬇️⬆️↓↑↧↥]+)$/u.test(t);
  }

  function isNonPlayerNoiseLine(line) {
    const t = normalizeWhitespace(line);
    if (!t) return true;
    if (isStandaloneUiOrPlatformNoiseLine(t)) return true;
    if (isDecorativeOnlyLine(t)) return true;
    if (/^[\[【]?(?:当前擂主|赛后抽奖|本次赞助|奖金追加)[\]】]?\s*[：:]/.test(t))
      return true;
    if (/接个龙先|避免找不到/.test(t)) return true;
    return false;
  }

  function looksLikeNumberedRelayLine(line) {
    return /^\s*(?:\d{1,3}|[０-９]{1,3})\s*[\.．、\)\]）］]/.test(
      String(line || ""),
    );
  }

  function splitCompositeJoinedNameCandidates(line, platform) {
    const t = normalizeWhitespace(line);
    if (!t) return [];
    if (!/[&＆]/.test(t)) return [];
    // Keep this conservative: only split when the whole line is a joined-name token.
    if (/\s/.test(t)) return [];

    const parts = t
      .split(/[&＆]/)
      .map((x) => normalizeWhitespace(x))
      .filter(Boolean);
    if (parts.length < 2 || parts.length > 3) return [];

    // Avoid splitting obvious handle/account styles.
    const plat = normalizeWhitespace(platform || "").toLowerCase();
    for (const part of parts) {
      if (!/^[A-Za-z\u4e00-\u9fff·•・'\-]{2,24}$/.test(part)) return [];
      if (/[0-9_]/.test(part)) return [];
      if (plat === "oq" && /^[A-Za-z]{1,2}$/.test(part)) return [];
    }

    const uniq = new Set(parts.map((x) => normalizeKey(x)));
    if (uniq.size < 2) return [];

    return parts;
  }

  function guessPlatformByGroup(group) {
    const g = normalizeWhitespace(group);
    if (!g) return "";
    const lower = g.toLowerCase();
    // Heuristic: 特殊赛 is typically vint in the provided format reference.
    if (g.includes("特殊") || lower.includes("vint") || lower.includes("xot"))
      return "vint";
    return "oq";
  }

  function tokenHasChinese(token) {
    return /[\u4e00-\u9fff]/.test(String(token || ""));
  }

  function tokenIsAsciiLike(token) {
    return /^[A-Za-z0-9_][A-Za-z0-9_\-]*$/.test(String(token || ""));
  }

  const NON_ACCOUNT_HINTS = [
    "人数不知",
    "人数未知",
    "待定",
    "暂定",
    "未知",
    "不参加",
    "弃赛",
    "报名",
    "接龙",
    "格式",
    "说明",
    "长期选手",
    "长期成员",
    "全部名单",
  ];

  function tokenLooksLikeRomanNameWord(token) {
    const t = String(token || "");
    if (/^[A-Z][a-z]{1,20}$/.test(t)) return true;
    if (/^[a-z]{2,20}$/.test(t)) return true;
    return false;
  }

  function looksLikeRomanizedFullNameTokens(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length < 2 || list.length > 4) return false;
    return list.every((t) => /^[A-Z][a-z]{1,20}$/.test(String(t || "")));
  }

  function isLongTermGroup(group) {
    const g = normalizeWhitespace(group);
    return !!g && g.includes("长期");
  }

  function tokenLooksLikeLooseRomanWord(token) {
    const t = String(token || "");
    return /^[A-Za-z]{2,24}$/.test(t);
  }

  // Common romanized Chinese surnames (single-token pinyin forms).
  // Used only for anomaly hints, to avoid over-flagging arbitrary English nicknames.
  const COMMON_PINYIN_SURNAMES = new Set([
    "an",
    "bai",
    "bao",
    "cai",
    "cao",
    "chang",
    "chen",
    "cheng",
    "chong",
    "chou",
    "chu",
    "cui",
    "dai",
    "deng",
    "di",
    "ding",
    "dong",
    "dou",
    "du",
    "duan",
    "fan",
    "fang",
    "fei",
    "feng",
    "fu",
    "gao",
    "gong",
    "gu",
    "guo",
    "han",
    "hao",
    "he",
    "hou",
    "hu",
    "hua",
    "huang",
    "ji",
    "jia",
    "jiang",
    "jin",
    "kang",
    "kong",
    "lai",
    "lan",
    "lang",
    "lei",
    "li",
    "lian",
    "liang",
    "liao",
    "lin",
    "liu",
    "long",
    "lou",
    "lu",
    "luo",
    "lv",
    "ma",
    "mao",
    "meng",
    "min",
    "mo",
    "mu",
    "ni",
    "ou",
    "pan",
    "pang",
    "pei",
    "peng",
    "qi",
    "qian",
    "qiao",
    "qin",
    "qiu",
    "qu",
    "ren",
    "shao",
    "shen",
    "shi",
    "song",
    "su",
    "sun",
    "tan",
    "tang",
    "tao",
    "tian",
    "wan",
    "wang",
    "wei",
    "wen",
    "wu",
    "xia",
    "xiao",
    "xie",
    "xin",
    "xing",
    "xiong",
    "xu",
    "xue",
    "yan",
    "yang",
    "yao",
    "ye",
    "yi",
    "yin",
    "ying",
    "you",
    "yu",
    "yuan",
    "zeng",
    "zha",
    "zhai",
    "zhan",
    "zhang",
    "zhao",
    "zhen",
    "zheng",
    "zhong",
    "zhou",
    "zhu",
    "zou",
    "zuo",
    // Common compound surnames
    "ouyang",
    "sima",
    "shangguan",
    "zhuge",
    "dongfang",
    "huangfu",
    "gongsun",
    "linghu",
    "situ",
    "sikong",
    "dugu",
    "nangong",
    "xiahou",
    "zhangsun",
    "murong",
    "gongyang",
    "wuma",
    "helian",
    "huyan",
    "yuchi",
  ]);

  function looksLikeRomanizedSurnameOnly(name) {
    const t = normalizeWhitespace(name || "");
    if (!t || t.includes(" ")) return false;
    if (!/^[A-Za-z]{2,12}$/.test(t)) return false;
    return COMMON_PINYIN_SURNAMES.has(t.toLowerCase());
  }

  function tokenLooksLikeLikelyPinyinWord(token) {
    const t = String(token || "").toLowerCase();
    if (!/^[a-z]{2,8}$/.test(t)) return false;
    // Include "v" for copied pinyin like "lv".
    if (!/[aeiouv]/.test(t)) return false;
    // Words ending with "...ry/...ly" are usually not pinyin syllables.
    if (/[^aeiouv]y$/.test(t) && !/(ay|ey|oy)$/.test(t)) return false;
    // Most pinyin syllables end with vowel / n / ng / r / v.
    // This keeps "Wang Xiao Ming" as name, while reducing false matches
    // for account-like words such as "Head".
    if (!/(?:ng|[aeiouvnr])$/.test(t)) return false;
    return true;
  }

  function looksLikeLikelyLowerPinyinTwoWordName(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length !== 2) return false;
    const a = String(list[0] || "");
    const b = String(list[1] || "");
    if (!/^[a-z]{2,8}$/.test(a) || !/^[a-z]{2,8}$/.test(b)) return false;
    if (a.length > 6 || b.length > 8) return false;
    return (
      tokenLooksLikeLikelyPinyinWord(a) && tokenLooksLikeLikelyPinyinWord(b)
    );
  }

  function looksLikeLikelyLowerPinyinThreeWordName(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length !== 3) return false;
    const a = String(list[0] || "");
    const b = String(list[1] || "");
    const c = String(list[2] || "");
    if (
      !/^[a-z]{2,8}$/.test(a) ||
      !/^[a-z]{2,8}$/.test(b) ||
      !/^[a-z]{2,8}$/.test(c)
    )
      return false;
    if (a.length > 6 || b.length > 6 || c.length > 8) return false;
    return (
      tokenLooksLikeLikelyPinyinWord(a) &&
      tokenLooksLikeLikelyPinyinWord(b) &&
      tokenLooksLikeLikelyPinyinWord(c)
    );
  }

  function looksLikeLooseRomanTwoWordName(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length !== 2) return false;
    return list.every(
      (t) => tokenLooksLikeLooseRomanWord(t) && !/[_0-9]/.test(String(t || "")),
    );
  }

  function looksLikeRomanizedThreeWordNameTokens(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length !== 3) return false;
    return list.every((t) => /^[A-Z][a-z]{1,20}$/.test(String(t || "")));
  }

  function looksLikeLooseRomanThreeWordName(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length !== 3) return false;
    return list.every(
      (t) => tokenLooksLikeLooseRomanWord(t) && !/[_0-9]/.test(String(t || "")),
    );
  }

  function tokenLooksLikeShortChineseNameWord(token) {
    return /^[\u4e00-\u9fff]{2,4}$/.test(String(token || ""));
  }

  function tokenLooksLikeAccount(token, platform) {
    const t = String(token || "");
    const trimmed = normalizeWhitespace(t);
    if (!trimmed) return 0;

    for (const hint of NON_ACCOUNT_HINTS) {
      if (trimmed.includes(hint)) return 0;
    }
    if (/^(?:none|null|n\/a|na|待定|未知|暂无|无)$/i.test(trimmed)) return 0;

    // Numeric-only (e.g. vint id)
    if (/^\d{3,12}$/.test(trimmed)) return 4;

    // Special case: some pasted data contains an account split into 2 short tokens,
    // and we intentionally merge them into one token (e.g. "Liao yi").
    // For OQ this is uncommon but can happen via copy/paste; treat it as a weak
    // account signal to avoid mis-parsing it as a club.
    if (trimmed.includes(" ")) {
      const parts = trimmed.split(" ").filter(Boolean);
      // Keep it conservative: only accept 2 parts and both must be ascii-like-ish.
      if (
        parts.length === 2 &&
        parts.every((p) => tokenIsAsciiLike(p) || /^\d{3,10}$/.test(p))
      ) {
        const joined = parts.join("");
        let score = 1;
        if (/[0-9]/.test(joined)) score += 2;
        if (/_/.test(joined)) score += 1;
        if (joined.length >= 4) score += 1;
        if (joined.length > 28) score -= 2;
        return Math.max(1, score);
      }
    }

    // Ascii-like handle
    if (tokenIsAsciiLike(trimmed)) {
      let score = 2;
      const hasStrongChars = /[0-9_]/.test(trimmed);
      if (/[0-9]/.test(trimmed)) score += 2;
      if (/_/.test(trimmed)) score += 1;
      if (trimmed.length >= 4) score += 1;
      if (platform === "oq" && !hasStrongChars) {
        if (/^[A-Z][a-z]{1,20}$/.test(trimmed)) score -= 2;
        else if (tokenLooksLikeRomanNameWord(trimmed)) score -= 1;
      }
      if (!hasStrongChars && trimmed.length <= 2) score -= 1;
      if (trimmed.length > 24) score -= 2;
      return score;
    }

    // For vint: allow Chinese / spaces as账号（部分平台昵称允许中文）
    if (platform === "vint") {
      // Avoid treating obvious instruction text as账号
      if (tokenLooksLikeShortChineseNameWord(trimmed)) return 0;
      if (trimmed.length >= 2 && trimmed.length <= 32) return 1;
    }

    return 0;
  }

  function tokensLookLikeClub(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length === 0) return 0;

    const joined = list.join(" ");
    const compact = joined.replace(/\s+/g, "").toLowerCase();
    if (
      [
        "redskin",
        "redskn",
        "htn",
        "zeb",
        "poqi",
        "poq",
        "断藤斋",
      ].includes(compact)
    )
      return 3;

    const hasCn = tokenHasChinese(joined);
    if (hasCn) return 3;

    // Short uppercase abbreviation like "HTN"
    if (list.length === 1 && /^[A-Z]{2,6}$/.test(list[0])) return 2;

    // Otherwise weak signal
    return 0;
  }

  function tokensLookLikeName(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    if (list.length === 0) return 0;

    const joined = list.join(" ");
    // Pure Chinese name or mixed
    if (tokenHasChinese(joined)) return 4;

    // Typical romanized name: Capitalized words
    let score = 0;
    for (const t of list) {
      if (/^[A-Z][a-z]{1,20}$/.test(t)) score += 2;
      else if (/^[A-Za-z]{2,20}$/.test(t)) score += 1;
      else if (tokenIsAsciiLike(t) && /[_0-9]/.test(t))
        score -= 2; // looks more like an id/handle
      else score += 0;
    }
    return score;
  }

  function splitChineseAndAccountIfPossible(oneToken) {
    const t = String(oneToken || "");
    // Chinese + account glued together: "王光轩wgxzwl"
    const m = t.match(
      /^([\u4e00-\u9fff]{1,10})([A-Za-z0-9_][A-Za-z0-9_\-]{2,})$/,
    );
    if (m) {
      return { displayName: m[1], account: m[2] };
    }
    return null;
  }

  function splitChineseAccountClubIfPossible(oneToken) {
    const t = String(oneToken || "");
    const m = t.match(
      /^([\u4e00-\u9fff]{1,10})([A-Za-z0-9_][A-Za-z0-9_\-]{2,})([\u4e00-\u9fff].*)$/,
    );
    if (!m) return null;
    return {
      displayName: normalizeWhitespace(m[1]),
      account: normalizeWhitespace(m[2]),
      club: normalizeWhitespace(m[3]),
    };
  }

  function splitSymbolNameAndAccountIfPossible(oneToken, platform) {
    const t = normalizeWhitespace(oneToken);
    if (!t || /\s/.test(t)) return null;
    const m = t.match(/^([^A-Za-z0-9_]{1,12})([A-Za-z0-9_][A-Za-z0-9_\-]{2,})$/u);
    if (!m) return null;
    const displayName = normalizeWhitespace(m[1]);
    const account = normalizeWhitespace(m[2]);
    if (!displayName || tokenHasChinese(displayName)) return null;
    if (tokenLooksLikeAccount(account, platform) < 2) return null;
    return { displayName, account };
  }

  function isNewcomerGroup(group) {
    const g = normalizeWhitespace(group);
    return g.includes("新人");
  }

  function isKnownNonParticipantRecord(fields, group) {
    if (!fields || !isNewcomerGroup(group)) return false;
    const name = normalizeWhitespace(fields.displayName);
    const account = normalizeWhitespace(fields.account);
    return name === "深红" && /^Eklos$/i.test(account);
  }

  function splitRomanNameAndAccountIfPossible(oneToken, platform) {
    // Common pasted pattern without spaces:
    // "zhangyujieT0Thuiyi" -> "zhangyujie" + "T0Thuiyi"
    // Keep strict to avoid over-splitting normal single-token nicknames.
    if (platform !== "oq") return null;

    const t = normalizeWhitespace(oneToken);
    if (!t) return null;
    if (!/^[A-Za-z0-9_]{7,36}$/.test(t)) return null;

    const m = t.match(/^([a-z]{4,18})([A-Z0-9][A-Za-z0-9_]{2,20})$/);
    if (!m) return null;

    const left = m[1];
    const right = m[2];

    const upperCount = (right.match(/[A-Z]/g) || []).length;
    const titleCaseRight = /^[A-Z][a-z]{4,20}$/.test(right);
    const leftLooksPinyinish =
      tokenLooksLikeLikelyPinyinWord(left) && /(?:zh|ch|sh|x|q|j)/.test(left);
    const strongHint =
      /[0-9_]/.test(right) ||
      upperCount >= 2 ||
      (titleCaseRight && leftLooksPinyinish);
    if (!strongHint) return null;
    const minAccScore =
      titleCaseRight &&
      leftLooksPinyinish &&
      !(/[0-9_]/.test(right) || upperCount >= 2)
        ? 1
        : 2;
    if (tokenLooksLikeAccount(right, platform) < minAccScore) return null;

    return { displayName: left, account: right };
  }

  function splitDashAccountInLastToken(tokens) {
    // Try: "... bofeng-rola" => name "... bofeng" + account "rola"
    if (!Array.isArray(tokens) || tokens.length === 0) return null;

    const last = tokens[tokens.length - 1];
    if (!last || typeof last !== "string") return null;
    if (!last.includes("-")) return null;

    // Only split on the last '-' (some handles might contain multiple)
    const idx = last.lastIndexOf("-");
    if (idx <= 0 || idx >= last.length - 1) return null;

    const left = last.slice(0, idx);
    const right = last.slice(idx + 1);

    // Heuristic: right looks like account (ascii-like)
    if (!tokenIsAsciiLike(right) && !/^\d{3,10}$/.test(right)) return null;

    // left should look like name part (letters only, no digits)
    if (/[0-9_]/.test(left)) return null;

    const nameTokens = tokens.slice(0, -1).concat([left]).filter(Boolean);
    const account = right;

    return { nameTokens, account };
  }

  function parseLineToFields(rawLine, { group, platform } = {}) {
    const cleaned = cleanPlayerLine(rawLine);
    if (!cleaned) return null;

    const g = normalizeWhitespace(group) || "未分组";
    const plat = normalizeWhitespace(platform) || guessPlatformByGroup(g) || "";

    // Tokenize
    let tokens = cleaned.split(/\s+/).filter(Boolean);

    if (isDecorativeOnlyLine(cleaned)) return null;

    if (
      isNewcomerGroup(g) &&
      plat === "oq" &&
      tokens.length === 2 &&
      tokenHasChinese(tokens[0]) &&
      (tokenHasChinese(tokens[1]) || /^\d{1,3}岁$/.test(tokens[1]))
    ) {
      return {
        displayName: tokens[0],
        account: tokens[1],
        club: "",
      };
    }

    if (
      plat === "oq" &&
      tokens.length === 3 &&
      /^[A-Z]{2,20}$/.test(tokens[0]) &&
      /^[A-Z]{2,20}$/.test(tokens[1]) &&
      tokenLooksLikeAccount(tokens[2], plat) >= 2
    ) {
      return {
        displayName: `${tokens[0]} ${tokens[1]}`,
        account: tokens[2],
        club: "",
      };
    }

    // OQ: duplicated token like "Liaoyi Liaoyi" usually means "昵称 + 账号" rather than a full name.
    if (plat === "oq" && tokens.length === 2) {
      const aKey = normalizeKey(tokens[0]);
      const bKey = normalizeKey(tokens[1]);
      if (aKey && bKey && aKey === bKey) {
        return {
          displayName: tokens[0],
          account: tokens[1],
          club: "",
        };
      }
    }

    // OQ: sometimes "中文名+数字" and账号尾巴被空格拆开 (e.g. "馒头926 wjp").
    if (plat === "oq" && tokens.length === 2) {
      const m = String(tokens[0] || "").match(
        /^([\u4e00-\u9fff]{1,10})(\d{2,6})$/,
      );
      const tail = String(tokens[1] || "");
      if (m && /^[a-z0-9_]{2,12}$/.test(tail) && /[a-z]/.test(tail)) {
        const mergedAcc = `${m[2]}${tail}`;
        const mergedScore = tokenLooksLikeAccount(mergedAcc, plat);
        const sepScore = tokenLooksLikeAccount(tail, plat);
        if (mergedScore >= 2 && mergedScore > sepScore) {
          return {
            displayName: m[1],
            account: mergedAcc,
            club: "",
          };
        }
      }
    }

    if (plat === "oq" && tokens.length === 2) {
      const m = String(tokens[0] || "").match(
        /^([\u4e00-\u9fff]{1,10})(\d{7,12})$/,
      );
      const tail = String(tokens[1] || "");
      if (m && tokenIsAsciiLike(tail)) {
        return {
          displayName: m[1],
          account: m[2],
          club: tail,
        };
      }
    }

    // Chinese name + glued account + optional club tail.
    // Example: "馒头926wjp Zeb" => 名称: 馒头, 账号: 926wjp, 俱乐部: Zeb
    if (tokens.length >= 2) {
      const firstCnSplit = splitChineseAndAccountIfPossible(tokens[0]);
      if (firstCnSplit && /[A-Za-z_]/.test(firstCnSplit.account)) {
        const splitAccScore = tokenLooksLikeAccount(firstCnSplit.account, plat);
        const nextTokenScore = tokenLooksLikeAccount(tokens[1], plat);
        if (splitAccScore >= 2 && splitAccScore >= nextTokenScore) {
          return {
            displayName: firstCnSplit.displayName,
            account: firstCnSplit.account,
            club: normalizeWhitespace(tokens.slice(1).join(" ")),
          };
        }
      }
    }

    // OQ + two romanized words is more likely a full name than "昵称 + 账号".
    // Example: "Lin Feng" / "Li Si" in 长期名单.
    if (
      plat === "oq" &&
      tokens.length === 2 &&
      looksLikeRomanizedFullNameTokens(tokens)
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // OQ + short pinyin-like two-word names are commonly surname+given-name,
    // and should not be aggressively split into name+account.
    if (
      plat === "oq" &&
      tokens.length === 2 &&
      looksLikeLooseRomanTwoWordName(tokens) &&
      String(tokens[0]).length <= 4 &&
      String(tokens[1]).length <= 6 &&
      tokenLooksLikeLikelyPinyinWord(tokens[0]) &&
      tokenLooksLikeLikelyPinyinWord(tokens[1])
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // OQ + two lowercase pinyin-like words (slightly longer) are still often姓名。
    // Example: "zhang qiang"
    if (plat === "oq" && looksLikeLikelyLowerPinyinTwoWordName(tokens)) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // OQ + three strict title-cased words may be a full romanized name.
    // Keep this conservative: only when all three words also look pinyin-like.
    // Example: "Wang De Hua" should not become "Wang De" + account "Hua".
    if (
      plat === "oq" &&
      tokens.length === 3 &&
      looksLikeRomanizedThreeWordNameTokens(tokens) &&
      tokens.every(tokenLooksLikeLikelyPinyinWord)
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // OQ + three lowercase pinyin-like words are also commonly full names.
    // Example: "wang de hua"
    if (plat === "oq" && looksLikeLikelyLowerPinyinThreeWordName(tokens)) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // Long-term lists often contain plain two-word romanized names (lower/upper mixed).
    // Be conservative here to avoid turning personal names into OQ accounts.
    if (
      plat === "oq" &&
      isLongTermGroup(g) &&
      looksLikeLooseRomanTwoWordName(tokens)
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // Long-term lists may also contain three-part romanized names.
    if (
      plat === "oq" &&
      isLongTermGroup(g) &&
      looksLikeLooseRomanThreeWordName(tokens)
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // vint 分组中若仅两段中文，常见是“姓名被空格切开”，不强行识别第二段为账号。
    if (
      plat === "vint" &&
      tokens.length === 2 &&
      tokenHasChinese(tokens[0]) &&
      tokenHasChinese(tokens[1]) &&
      tokenLooksLikeShortChineseNameWord(tokens[1])
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // vint 中常见“中文昵称 + 两段英文账号（含空格）”，避免误识别第二段为俱乐部。
    if (
      plat === "vint" &&
      tokens.length === 3 &&
      tokenHasChinese(tokens[0]) &&
      tokenLooksLikeLooseRomanWord(tokens[1]) &&
      tokenLooksLikeLooseRomanWord(tokens[2]) &&
      !/[_0-9]/.test(`${tokens[1]}${tokens[2]}`)
    ) {
      return {
        displayName: tokens[0],
        account: `${tokens[1]} ${tokens[2]}`,
        club: "",
      };
    }

    // Copy/paste variants may append a club token: "中文昵称 + 两段英文账号 + 俱乐部"
    // (Common when users copy a formatted line from chat/exported tables.)
    if (
      (plat === "vint" || plat === "oq") &&
      tokens.length === 4 &&
      tokenHasChinese(tokens[0]) &&
      tokenLooksLikeLooseRomanWord(tokens[1]) &&
      tokenLooksLikeLooseRomanWord(tokens[2]) &&
      !/[_0-9]/.test(`${tokens[1]}${tokens[2]}`) &&
      (tokenHasChinese(tokens[3]) || String(tokens[3] || "").includes("俱乐部"))
    ) {
      return {
        displayName: tokens[0],
        account: `${tokens[1]} ${tokens[2]}`,
        club: tokens[3],
      };
    }

    // Special case: single token like "张三abc123"
    if (tokens.length === 1) {
      const one = tokens[0];

      const cnAccountClub = splitChineseAccountClubIfPossible(one);
      if (cnAccountClub) {
        return cnAccountClub;
      }

      const symbolSplit = splitSymbolNameAndAccountIfPossible(one, plat);
      if (symbolSplit) {
        return {
          displayName: symbolSplit.displayName,
          account: symbolSplit.account,
          club: "",
        };
      }

      const cnSplit = splitChineseAndAccountIfPossible(one);
      if (cnSplit) {
        return {
          displayName: cnSplit.displayName,
          account: cnSplit.account,
          club: "",
        };
      }

      const romanSplit = splitRomanNameAndAccountIfPossible(one, plat);
      if (romanSplit) {
        return {
          displayName: romanSplit.displayName,
          account: romanSplit.account,
          club: "",
        };
      }

      // Single token with separator: "name-account" / "name+account" (plus already handled)
      const dashIdx = one.lastIndexOf("-");
      if (dashIdx > 0 && dashIdx < one.length - 1) {
        const left = one.slice(0, dashIdx);
        const right = one.slice(dashIdx + 1);
        if (tokenLooksLikeAccount(right, plat) >= 2) {
          return {
            displayName: left,
            account: right,
            club: "",
          };
        }
      }

      // Otherwise treat as name only
      return {
        displayName: one,
        account: "",
        club: "",
      };
    }

    // Special case: last token very short (like "yi") and previous is ascii => combine last two as account
    if (tokens.length >= 3) {
      const t1 = tokens[tokens.length - 1];
      const t2 = tokens[tokens.length - 2];
      if (
        String(t1).length <= 2 &&
        tokenIsAsciiLike(t2) &&
        tokenIsAsciiLike(t1)
      ) {
        // Combine as a single account token candidate (e.g. "Liao yi")
        tokens = tokens.slice(0, -2).concat([`${t2} ${t1}`]);
      }
    }

    // Attempt to split dash in last token (bofeng-rola)
    const dashSplit = splitDashAccountInLastToken(tokens);
    if (dashSplit && dashSplit.nameTokens && dashSplit.nameTokens.length >= 1) {
      // Replace tokens with nameTokens + [account]
      tokens = dashSplit.nameTokens.concat([dashSplit.account]);
    }

    // Choose best split index (i = account token position)
    let best = null;

    for (let i = 1; i <= tokens.length - 1; i++) {
      const nameTokens = tokens.slice(0, i);
      const accountToken = tokens[i];
      const clubTokens = tokens.slice(i + 1);

      const nameScore = tokensLookLikeName(nameTokens);
      const accScore = tokenLooksLikeAccount(accountToken, plat);
      const clubScore = tokensLookLikeClub(clubTokens);

      // Penalize if account token obviously looks like club abbreviation AND club tokens absent
      let penalty = 0;
      if (
        clubTokens.length === 0 &&
        /^[A-Z]{2,6}$/.test(String(accountToken || ""))
      )
        penalty += 2;

      const score = nameScore * 2 + accScore * 3 + clubScore * 2 - penalty;

      if (!best || score > best.score) {
        best = { i, score, nameTokens, accountToken, clubTokens, accScore };
      }
    }

    // If no reasonable account candidate found, treat as name only
    if (!best || best.accScore <= 0) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    // If platform is oq and account token contains Chinese, be conservative (likely a 2-part real name)
    if (
      plat === "oq" &&
      tokenHasChinese(best.accountToken) &&
      best.accScore <= 1
    ) {
      return {
        displayName: tokens.join(" "),
        account: "",
        club: "",
      };
    }

    const displayName = normalizeWhitespace(best.nameTokens.join(" "));
    const account = normalizeWhitespace(best.accountToken);
    const club = normalizeWhitespace(best.clubTokens.join(" "));

    return { displayName, account, club };
  }

  function makePlayer(
    fields,
    { isNew = false, group = "未分组", platform = "", id = null } = {},
  ) {
    const safeFields = fields || {};
    const idNum = Number(id);
    const safeId =
      Number.isFinite(idNum) && idNum > 0
        ? Math.trunc(idNum)
        : state.nextPlayerId++;
    return {
      id: safeId,
      displayName: normalizeWhitespace(safeFields.displayName || ""),
      account: normalizeWhitespace(safeFields.account || ""),
      club: normalizeWhitespace(safeFields.club || ""),
      platform: normalizeWhitespace(platform || safeFields.platform || ""),
      group: normalizeWhitespace(group || safeFields.group || "") || "未分组",
      checkedIn: false,
      checkedInAt: null,
      isNew: Boolean(isNew),
    };
  }

  function mergePlayers(existing, incoming) {
    // Merge "incoming" into "existing" with preference for richer fields.
    if (!existing || !incoming) return existing || incoming;

    // Prefer "more specific" group over fallback buckets like 未分组/长期成员/长期名单
    const lowPriorityGroups = new Set(["未分组", "长期成员", "长期名单"]);
    const eg = normalizeWhitespace(existing.group) || "未分组";
    const ig = normalizeWhitespace(incoming.group) || "";
    if (ig) {
      const egLow = lowPriorityGroups.has(eg);
      const igLow = lowPriorityGroups.has(ig);
      if ((!eg || egLow) && !igLow) {
        existing.group = ig;
      }
    }

    // Prefer non-empty platform
    if (!existing.platform && incoming.platform)
      existing.platform = incoming.platform;

    // Prefer having account
    if (!existing.account && incoming.account)
      existing.account = incoming.account;

    // Prefer having club
    if (!existing.club && incoming.club) existing.club = incoming.club;

    // Prefer longer/more informative displayName (avoid losing spaces)
    if (
      incoming.displayName &&
      incoming.displayName.length > existing.displayName.length
    ) {
      existing.displayName = incoming.displayName;
    }

    // checkedIn state: keep checked if either says checked; keep earliest time if both exist
    if (incoming.checkedIn && !existing.checkedIn) {
      existing.checkedIn = true;
      existing.checkedInAt =
        incoming.checkedInAt || existing.checkedInAt || now();
    } else if (incoming.checkedIn && existing.checkedIn) {
      const a = Number(existing.checkedInAt) || 0;
      const b = Number(incoming.checkedInAt) || 0;
      if (a === 0 && b > 0) existing.checkedInAt = b;
      else if (a > 0 && b > 0) existing.checkedInAt = Math.min(a, b);
    }

    existing.isNew = Boolean(existing.isNew || incoming.isNew);

    return existing;
  }

  function dedupeAndSortPlayers(list) {
    const players = Array.isArray(list) ? list : [];

    const byAcc = new Map(); // accKey -> player
    const byName = new Map(); // nameKey -> player
    const byAccName = new Map(); // accKey|nameKey -> player (dedupe repeats even under account conflicts)
    const conflictExtras = []; // keep conflicting records as separate players for suspect checks

    const put = (p) => {
      if (!p) return;

      const dn = normalizeWhitespace(p.displayName);
      if (!dn) return;

      const nameKey = normalizeKey(dn);
      const plat = normalizeWhitespace(p.platform || "");
      const acc = normalizeWhitespace(p.account || "");
      const accKey = acc ? `acc:${plat}|${normalizeKey(acc)}` : "";
      const accNameKey = accKey ? `${accKey}|${nameKey}` : "";

      // Merge priority:
      // 1) Same accKey => merge
      // 2) Same nameKey => merge (handles clubText -> relayText upgrade)
      // 3) Otherwise insert
      if (accNameKey && byAccName.has(accNameKey)) {
        mergePlayers(byAccName.get(accNameKey), p);
        return;
      }

      if (accKey && byAcc.has(accKey)) {
        const existingByAcc = byAcc.get(accKey);
        const existingByAccNameKey = normalizeKey(
          normalizeWhitespace(existingByAcc && existingByAcc.displayName),
        );
        const hasAccountConflictByName = Boolean(
          existingByAccNameKey && existingByAccNameKey !== nameKey,
        );
        if (hasAccountConflictByName) {
          const newP = p;
          conflictExtras.push(newP);
          // Map to latest conflicting record so exact repeats can still merge.
          byAcc.set(accKey, newP);
          if (accNameKey) byAccName.set(accNameKey, newP);
          return;
        }

        mergePlayers(existingByAcc, p);
        if (accNameKey) byAccName.set(accNameKey, existingByAcc);
        return;
      }

      if (byName.has(nameKey)) {
        const existing = byName.get(nameKey);
        const existingPlat = normalizeWhitespace(existing.platform || "");
        const existingAcc = normalizeWhitespace(existing.account || "");
        const existingAccKey = existingAcc
          ? `acc:${existingPlat}|${normalizeKey(existingAcc)}`
          : "";
        const hasNameConflictByAccount = Boolean(
          accKey && existingAccKey && accKey !== existingAccKey,
        );

        // Keep same-name but conflicting-account records as separate players,
        // so duplicate/suspect checks can surface this conflict to users.
        if (hasNameConflictByAccount) {
          const newP = p;
          conflictExtras.push(newP);
          if (accKey) byAcc.set(accKey, newP);
          if (accNameKey) byAccName.set(accNameKey, newP);
          return;
        }

        mergePlayers(existing, p);
        if (accKey) byAcc.set(accKey, existing);
        if (accNameKey) byAccName.set(accNameKey, existing);
        return;
      }

      // Insert new
      const newP = p;
      byName.set(nameKey, newP);
      if (accKey) byAcc.set(accKey, newP);
      if (accNameKey) byAccName.set(accNameKey, newP);
    };

    for (const p of players) put(p);

    const outRaw = Array.from(byName.values()).concat(conflictExtras);
    const out = [];
    const exactMap = new Map();

    // Final exact-pass dedupe keeps this function idempotent.
    // It also prevents preview/final-count drift when conflicting records
    // appear repeatedly in pasted source text.
    for (const p of outRaw) {
      const dn = normalizeWhitespace(p && p.displayName);
      if (!dn) continue;

      const key = [
        normalizeKey(dn),
        normalizeKey(p && p.platform),
        normalizeKey(p && p.account),
        normalizeKey(p && p.group) || "未分组",
      ].join("|");

      if (exactMap.has(key)) {
        mergePlayers(exactMap.get(key), p);
        continue;
      }

      exactMap.set(key, p);
      out.push(p);
    }

    out.sort(comparePlayersForList);
    return out;
  }

  function parseImportTextsDetailed(clubText, relayText) {
    const clubLines = String(clubText || "").split("\n");
    const relayLines = String(relayText || "").split("\n");
    const activeGroupRules = getActiveGroupRules();

    const allLines = clubLines.concat(relayLines);

    const report = {
      totalLines: allLines.length,
      kept: 0,
      ignored: 0,
      ignoredItems: [], // full list, per plan
      ignoredReasons: new Map(),
    };

    const collected = [];
    let tempId = 1;
    const makeTempPlayer = (fields, opts = {}) =>
      makePlayer(fields, { ...opts, id: tempId++ });

    function addIgnored(reason, rawLine, meta = {}) {
      report.ignored++;
      report.ignoredReasons.set(
        reason,
        (report.ignoredReasons.get(reason) || 0) + 1,
      );
      report.ignoredItems.push({
        line: normalizeWhitespace(rawLine),
        reason,
        source: meta.source || "",
        groupHint: normalizeWhitespace(meta.groupHint || "") || "",
      });
    }

    // 1) clubText: treat as "长期成员"
    const clubGroup = "长期成员";
    const clubPlatform = "oq";

    for (const raw of clubLines) {
      const t = normalizeWhitespace(raw);
      if (!t) continue;

      // club list is supposed to be a plain list; still ignore obvious instruction/title/group lines
      if (
        looksLikeInstructionLine(t) ||
        looksLikeGroupHeading(t) ||
        detectGroupHeadingByRules(t, activeGroupRules) ||
        isLongTermSectionStart(t)
      ) {
        addIgnored("俱乐部区：说明/标题行", raw, {
          source: "club",
          groupHint: clubGroup,
        });
        continue;
      }

      const mark = stripNotParticipatingMark(t);
      if (mark.skip) {
        addIgnored("俱乐部区：标记不参赛/说明行", raw, {
          source: "club",
          groupHint: clubGroup,
        });
        continue;
      }

      const fields = parseLineToFields(mark.name, {
        group: clubGroup,
        platform: clubPlatform,
      });
      if (!fields || !fields.displayName) {
        addIgnored("俱乐部区：无法解析", raw, {
          source: "club",
          groupHint: clubGroup,
        });
        continue;
      }

      collected.push(
        makeTempPlayer(fields, {
          isNew: false,
          group: clubGroup,
          platform: clubPlatform,
        }),
      );
      report.kept++;
    }

    // 2) relayText: support group headings + long-term section
    let currentGroup = "未分组";
    let inLongTerm = false;
    let currentPlatformHint = "";

    for (let i = 0; i < relayLines.length; i++) {
      const raw = String(relayLines[i] ?? "");
      const t = normalizeWhitespace(raw);
      if (!t) continue;

      const heading = detectGroupHeadingByRules(t, activeGroupRules);
      if (heading) {
        currentGroup = heading;
        inLongTerm = false;
        currentPlatformHint = guessPlatformByGroup(currentGroup) || "";
        addIgnored("段落标题/组别标题", raw, {
          source: "relay",
          groupHint: currentGroup,
        });
        continue;
      }

      if (isLongTermSectionStart(t)) {
        inLongTerm = true;
        currentGroup = "长期名单";
        currentPlatformHint = "oq";
        addIgnored("段落标题/说明", raw, {
          source: "relay",
          groupHint: currentGroup,
        });
        continue;
      }

      // Long-term list ends when we meet an obvious new group heading or another section marker.
      if (
        inLongTerm &&
        (detectGroupHeadingByRules(t, activeGroupRules) || t.startsWith("#"))
      ) {
        inLongTerm = false;
      }

      // Detect platform hints from surrounding instruction lines (vint / playok / pl账号).
      const lowerT = t.toLowerCase();
      if (
        lowerT.includes("playok") ||
        lowerT.includes("pl账号") ||
        lowerT.includes("pl 账号")
      ) {
        currentPlatformHint = "pl";
      } else if (lowerT.includes("vint") || lowerT.includes("xot")) {
        currentPlatformHint = "vint";
      }

      const groupHint = currentGroup || (inLongTerm ? "长期名单" : "未分组");
      const platform = currentPlatformHint || guessPlatformByGroup(groupHint);

      if (isNonPlayerNoiseLine(t)) {
        addIgnored("说明/公告行", raw, { source: "relay", groupHint });
        continue;
      }

      // Handle lines that explicitly mark "not participating"
      const nonJoin = stripNotParticipatingMark(t);
      if (nonJoin.skip) {
        addIgnored(
          inLongTerm ? "长期名单：标记不参赛/说明行" : "标记不参赛/说明行",
          raw,
          { source: "relay", groupHint },
        );
        continue;
      }

      const line = nonJoin.name;

      // Ignore obvious instruction lines
      if (isNonPlayerNoiseLine(line) || looksLikeInstructionLine(line)) {
        addIgnored("说明/公告行", raw, { source: "relay", groupHint });
        continue;
      }

      // Joined names like "zhanganping&zhangxiaoguo" -> split into multiple players.
      const splitCandidates = splitCompositeJoinedNameCandidates(
        cleanPlayerLine(line),
        platform,
      );
      if (splitCandidates.length > 1) {
        let added = 0;
        for (const candidate of splitCandidates) {
          const fields = parseLineToFields(candidate, {
            group: groupHint,
            platform,
          });
          if (!fields || !fields.displayName) continue;
          collected.push(
            makeTempPlayer(fields, {
              isNew: false,
              group: groupHint,
              platform,
            }),
          );
          report.kept++;
          added++;
        }
        if (added > 0) continue;
      }

      const fields = parseLineToFields(line, { group: groupHint, platform });
      if (!fields || !fields.displayName) {
        addIgnored(inLongTerm ? "长期名单：无法解析" : "无法解析", raw, {
          source: "relay",
          groupHint,
        });
        continue;
      }

      if (!fields.account && !fields.club && looksLikeNumberedRelayLine(raw)) {
        const nextRaw =
          i + 1 < relayLines.length ? String(relayLines[i + 1] ?? "") : "";
        const nextLine = normalizeWhitespace(nextRaw);
        const nextClean = cleanPlayerLine(nextLine);
        if (
          nextLine &&
          !looksLikeNumberedRelayLine(nextRaw) &&
          !detectGroupHeadingByRules(nextLine, activeGroupRules) &&
          !isLongTermSectionStart(nextLine) &&
          !isNonPlayerNoiseLine(nextLine) &&
          !looksLikeInstructionLine(nextLine) &&
          nextClean &&
          !/\s/.test(nextClean) &&
          tokenLooksLikeAccount(nextClean, platform) >= 3
        ) {
          fields.account = nextClean;
          i++;
        }
      }

      if (isKnownNonParticipantRecord(fields, groupHint)) {
        addIgnored("裁判/不参赛记录", raw, { source: "relay", groupHint });
        continue;
      }

      collected.push(
        makeTempPlayer(fields, { isNew: false, group: groupHint, platform }),
      );
      report.kept++;
    }

    // Deduplicate & sort
    const merged = dedupeAndSortPlayers(collected);

    return { players: merged, report };
  }

  function buildImportReportText(result) {
    const players =
      result && Array.isArray(result.players) ? result.players : [];
    const report =
      result && result.report
        ? result.report
        : { kept: 0, ignored: 0, ignoredItems: [], ignoredReasons: new Map() };

    const groupMap = new Map();
    for (const p of players) {
      const g = normalizeWhitespace(p.group) || "未分组";
      groupMap.set(g, (groupMap.get(g) || 0) + 1);
    }

    const lines = [];
    lines.push(`解析到选手：${players.length} 人`);
    if (groupMap.size) {
      const groupSummary = Array.from(groupMap.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([g, c]) => `${g}:${c}`)
        .join("  ");
      lines.push(`组别分布：${groupSummary}`);
    }
    lines.push(`忽略行数：${report.ignored} 行`);

    if (report.ignoredReasons && report.ignoredReasons.size) {
      lines.push("");
      lines.push("忽略原因统计：");
      const entries = Array.from(report.ignoredReasons.entries()).sort(
        (a, b) => b[1] - a[1],
      );
      for (const [k, v] of entries) {
        lines.push(`- ${k}: ${v}`);
      }
    }

    // IMPORTANT: print full ignored samples (no 10-line limit)
    if (report.ignoredItems && report.ignoredItems.length) {
      lines.push("");
      lines.push(
        `被忽略的行（共 ${report.ignoredItems.length} 行，已完整列出）：`,
      );
      for (const it of report.ignoredItems) {
        const tag = it.groupHint ? `【${it.groupHint}】` : "";
        const reason = it.reason ? `（${it.reason}）` : "";
        lines.push(`- ${tag}${it.line}${reason}`);
      }
    }

    return lines.join("\n");
  }

  // ------------------------------
  // Import correction preview (Plan #2)
  // ------------------------------

  function buildImportPreviewNode(parseResult) {
    const players = parseResult.players || [];
    const report = parseResult.report || {
      ignoredItems: [],
      ignoredReasons: new Map(),
    };

    const container = document.createElement("div");
    container.className = "import-preview";

    // Summary
    const groupMap = new Map();
    for (const p of players) {
      const g = normalizeWhitespace(p.group) || "未分组";
      groupMap.set(g, (groupMap.get(g) || 0) + 1);
    }

    const summary = document.createElement("div");
    summary.className = "import-summary";
    summary.innerHTML = `
      <div class="import-summary__title">解析到选手：${players.length} 人</div>
      <div class="import-summary__sub">忽略行数：${report.ignored || 0} 行</div>
    `;
    container.appendChild(summary);

    if (groupMap.size) {
      const groupLine = document.createElement("div");
      groupLine.className = "import-groups";

      const entries = Array.from(groupMap.entries()).sort(
        (a, b) => b[1] - a[1],
      );
      groupLine.textContent =
        "组别：" + entries.map(([g, c]) => `${g}(${c})`).join("  ");
      container.appendChild(groupLine);
    }

    // Ignored list (full)
    const ignored = Array.isArray(report.ignoredItems)
      ? report.ignoredItems
      : [];

    const details = document.createElement("details");
    details.className = "import-ignored";
    details.open = false;

    const sum = document.createElement("summary");
    sum.className = "import-ignored__summary";

    const sumLeft = document.createElement("div");
    sumLeft.className = "import-ignored__summary-left";

    const sumTitle = document.createElement("div");
    sumTitle.className = "import-ignored__title";
    sumTitle.textContent = `被忽略的行（${ignored.length} 行）`;

    const sumHint = document.createElement("div");
    sumHint.className = "import-ignored__hint";
    sumHint.textContent = "展开后可勾选“强制加入”";

    sumLeft.appendChild(sumTitle);
    sumLeft.appendChild(sumHint);

    // Chevron icon
    const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chev.setAttribute("aria-hidden", "true");
    chev.classList.add("ms-icon", "import-ignored__chev");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-expand-more");
    use.setAttribute("xlink:href", "#i-expand-more");
    chev.appendChild(use);

    sum.appendChild(sumLeft);
    sum.appendChild(chev);

    details.appendChild(sum);

    const ignoredWrap = document.createElement("div");
    ignoredWrap.className = "import-ignored__panel";

    if (ignored.length === 0) {
      const empty = document.createElement("div");
      empty.className = "import-empty";
      empty.textContent = "没有被忽略的行。";
      ignoredWrap.appendChild(empty);
    } else {
      ignored.forEach((it, idx) => {
        const row = document.createElement("label");
        row.className = "ignored-row";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.ignoredIndex = String(idx);

        const reasonText = String(it.reason || "");
        if (reasonText.includes("标题")) {
          cb.disabled = true;
          cb.title = "标题行不建议强制加入";
          row.classList.add("ignored-row--disabled");
        }

        const box = document.createElement("span");
        box.className = "ignored-row__box";
        box.setAttribute("aria-hidden", "true");

        const text = document.createElement("div");
        text.className = "ignored-row__text";

        const line = escapeHtml(it.line || "");
        const reason = escapeHtml(it.reason || "");
        const groupHint = escapeHtml(it.groupHint || "未分组");

        const groupChip = groupHint
          ? `<span class="chip-small import-group">${groupHint}</span>`
          : "";

        text.innerHTML = `
          <div class="ignored-row__main">${groupChip}<span class="ignored-row__line">${line}</span></div>
          <div class="ignored-row__reason">${reason ? "原因：" + reason : ""}</div>
        `;

        row.appendChild(cb);
        row.appendChild(box);
        row.appendChild(text);

        ignoredWrap.appendChild(row);
      });
    }

    details.appendChild(ignoredWrap);
    container.appendChild(details);

    // Manual add
    const manual = document.createElement("div");
    manual.className = "import-manual";

    const manualTitle = document.createElement("div");
    manualTitle.className = "import-manual__title";
    manualTitle.textContent = "手动补充（每行一人，可写：昵称 账号 俱乐部）";
    manual.appendChild(manualTitle);

    const manualGroupRow = document.createElement("div");
    manualGroupRow.className = "import-manual__row";

    const groupLabel = document.createElement("span");
    groupLabel.className = "import-manual__label";
    groupLabel.textContent = "补充归入组别：";

    const sel = document.createElement("select");
    sel.className = "input import-manual__select";
    sel.id = "import-manual-group";

    const groups = Array.from(
      new Set(players.map((p) => normalizeWhitespace(p.group) || "未分组")),
    );
    const options = [
      "未分组",
      ...groups.filter((g) => g && g !== "未分组"),
    ].slice(0, 50);

    for (const g of options) {
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      sel.appendChild(opt);
    }

    manualGroupRow.appendChild(groupLabel);
    manualGroupRow.appendChild(sel);
    manual.appendChild(manualGroupRow);

    const ta = document.createElement("textarea");
    ta.id = "import-manual-text";
    ta.className = "textarea import-manual__textarea";
    ta.placeholder = "例如：\n夜洛 Nightspoke 神秘猫猫教\n王光轩 wgxzwl";
    manual.appendChild(ta);

    container.appendChild(manual);

    return container;
  }

  function applyImportWithCorrections(parseResult, previewRoot) {
    const basePlayers = Array.isArray(parseResult.players)
      ? parseResult.players.slice()
      : [];
    const report = parseResult.report || {};
    const ignored = Array.isArray(report.ignoredItems)
      ? report.ignoredItems
      : [];

    const chosen = [];
    let tempId =
      basePlayers.reduce((m, p) => Math.max(m, Number((p && p.id) || 0)), 0) +
      1;
    const makeTempPlayer = (fields, opts = {}) =>
      makePlayer(fields, { ...opts, id: tempId++ });

    // Forced include ignored lines
    if (previewRoot) {
      const checkboxes = previewRoot.querySelectorAll(
        'input[type="checkbox"][data-ignored-index]',
      );
      checkboxes.forEach((cb) => {
        if (!cb.checked) return;
        const idx = Number(cb.dataset.ignoredIndex);
        if (!Number.isFinite(idx) || idx < 0 || idx >= ignored.length) return;

        const it = ignored[idx];
        const groupHint = normalizeWhitespace(it.groupHint) || "未分组";
        const platform = guessPlatformByGroup(groupHint);
        const fields = parseLineToFields(it.line, {
          group: groupHint,
          platform,
        });
        if (fields && fields.displayName) {
          chosen.push(
            makeTempPlayer(fields, {
              group: groupHint,
              platform,
              isNew: false,
            }),
          );
        }
      });
    }

    // Manual additions
    if (previewRoot) {
      const ta = previewRoot.querySelector("#import-manual-text");
      const sel = previewRoot.querySelector("#import-manual-group");
      const manualText = ta && typeof ta.value === "string" ? ta.value : "";
      const manualGroup =
        sel && typeof sel.value === "string" ? sel.value : "未分组";
      const groupHint = normalizeWhitespace(manualGroup) || "未分组";
      const platform = guessPlatformByGroup(groupHint);

      const lines = String(manualText || "").split("\n");
      for (const raw of lines) {
        const t = normalizeWhitespace(raw);
        if (!t) continue;
        const fields = parseLineToFields(t, { group: groupHint, platform });
        if (fields && fields.displayName) {
          chosen.push(
            makeTempPlayer(fields, { group: groupHint, platform, isNew: true }),
          );
        }
      }
    }

    // Keep preview/final consistency when user doesn't apply any correction.
    // parseResult.players is already deduped/sorted.
    const merged =
      chosen.length === 0
        ? basePlayers.slice().sort(comparePlayersForList)
        : dedupeAndSortPlayers(basePlayers.concat(chosen));

    if (merged.length === 0) {
      showAlert(
        "导入失败",
        "导入后仍未得到任何有效选手，请检查输入或勾选/补充。",
      );
      return null;
    }

    return merged;
  }

  // ------------------------------
  // UI: dialogs + snackbar
  // ------------------------------
  const dialogBackdrop = $("#dialog-backdrop");
  const dialogTitle = $("#dialog-title");
  const dialogMessage = $("#dialog-message");
  const dialogButtons = $("#dialog-buttons");

  let dialogSequence = 0;
  let activeDialogToken = 0;
  let dialogDismissible = true;

  function closeDialog(options = {}) {
    if (options.token && options.token !== activeDialogToken) return false;
    if (!dialogDismissible && options.force !== true) return false;
    if (dialogBackdrop) dialogBackdrop.classList.add("hidden");
    activeDialogToken = 0;
    dialogDismissible = true;
    return true;
  }

  function showDialog({
    title,
    message,
    contentNode,
    buttons,
    wide = false,
    dismissible = true,
  }) {
    if (!dialogBackdrop || !dialogTitle || !dialogMessage || !dialogButtons) {
      const fallback = [
        title || "提示",
        typeof message === "string" ? message : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (typeof window.alert === "function") {
        window.alert(fallback || "提示");
      } else {
        console.warn("对话框节点缺失：", fallback);
      }
      return 0;
    }

    const dialogToken = ++dialogSequence;
    activeDialogToken = dialogToken;
    dialogDismissible = dismissible !== false;
    dialogTitle.textContent = title || "提示";
    const dialogPanel = dialogBackdrop.querySelector(".dialog");
    if (dialogPanel) dialogPanel.classList.toggle("dialog--large", Boolean(wide));
    dialogMessage.innerHTML = "";
    dialogMessage.style.whiteSpace = "pre-line";

    if (contentNode && isNode(contentNode)) {
      dialogMessage.style.whiteSpace = "normal";
      dialogMessage.appendChild(contentNode);
    } else {
      dialogMessage.textContent = typeof message === "string" ? message : "";
    }

    dialogButtons.innerHTML = "";

    // When there are many buttons, allow wrapping on small screens.
    const btnCount = Array.isArray(buttons) ? buttons.length : 0;
    if (dialogButtons.classList) {
      dialogButtons.classList.toggle("dialog__footer--wrap", btnCount > 2);
    }

    (buttons || []).forEach((btn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = btn.className || "btn btn-filled";
      b.textContent = btn.label || "确定";
      b.addEventListener("click", () => {
        let shouldClose = true;
        try {
          if (typeof btn.onClick === "function") {
            const r = btn.onClick();
            // If the handler explicitly returns false, keep the dialog open (useful for form validation).
            if (r === false) shouldClose = false;
          }
        } catch (e) {
          console.error("对话框按钮回调异常：", e);
        } finally {
          if (shouldClose) closeDialog();
        }
      });
      dialogButtons.appendChild(b);
    });

    dialogBackdrop.classList.remove("hidden");
    return dialogToken;
  }

  function showAlert(title, message) {
    showDialog({
      title,
      message,
      buttons: [{ label: "好的", className: "btn btn-filled" }],
    });
  }

  function showConfirm(title, message, onConfirm, confirmLabel = "确认") {
    showDialog({
      title,
      message,
      buttons: [
        { label: "取消", className: "btn btn-outlined" },
        {
          label: confirmLabel,
          className: "btn btn-filled",
          onClick: () => {
            if (typeof onConfirm === "function") onConfirm();
          },
        },
      ],
    });
  }

  const snackbar = $("#snackbar");
  const snackbarText = $("#snackbar .snackbar__text");
  const snackbarAction = $("#snackbar-action");

  let snackbarTimer = null;
  let snackbarActionHandler = null;

  function hideSnackbar() {
    if (!snackbar) return;
    snackbar.classList.remove("show");
    if (snackbarTimer) window.clearTimeout(snackbarTimer);
    snackbarTimer = null;

    if (snackbarAction) {
      snackbarAction.hidden = true;
      snackbarAction.textContent = "";
    }
    snackbarActionHandler = null;
  }

  function showSnackbar(
    text,
    duration = 2500,
    actionLabel = "",
    actionHandler = null,
  ) {
    if (!snackbar) return;
    if (snackbarText) snackbarText.textContent = text;
    else snackbar.textContent = text;

    if (snackbarTimer) window.clearTimeout(snackbarTimer);
    snackbarTimer = null;

    if (snackbarAction) {
      if (actionLabel && typeof actionHandler === "function") {
        snackbarAction.hidden = false;
        snackbarAction.textContent = actionLabel;
        snackbarActionHandler = actionHandler;
      } else {
        snackbarAction.hidden = true;
        snackbarAction.textContent = "";
        snackbarActionHandler = null;
      }
    }

    snackbar.classList.add("show");

    // duration=0 => persistent until user action / next snackbar / close
    const d = Number(duration);
    if (Number.isFinite(d) && d > 0) {
      snackbarTimer = window.setTimeout(() => {
        hideSnackbar();
      }, d);
    }
  }

  function showUndoSnackbar(text, onUndo, duration = UNDO_SNACKBAR_DURATION) {
    showSnackbar(text, duration, "撤销", () => {
      if (typeof onUndo === "function") onUndo();
    });
  }

  // ------------------------------
  // UI: step switching + elements
  // ------------------------------
  const stepSchedule = $("#step-schedule");
  const stepImport = $("#step-import");
  const stepCheckin = $("#step-checkin");
  const stepScoreHelper = $("#step-score-helper");
  const stepFinalRegistration = $("#step-final-registration");
  const finalRegistrationStatus = $("#final-registration-status");
  const finalRegistrationContent = $("#final-registration-content");
  const workspacePicker = $("#workspace-picker");
  const workspaceChoiceGrid = $("#workspace-choice-grid");
  const workspaceSurveyHandoff = $("#workspace-survey-handoff");
  const surveyOptionGrid = $("#survey-option-grid");
  const surveyPastPanel = $("#survey-past-panel");
  const surveyIdPanel = $("#survey-id-panel");
  const btnSurveyPast = $("#btn-survey-past");
  const btnSurveyId = $("#btn-survey-id");
  const surveyAccountInput = $("#survey-account-input");
  const btnSurveyQuery = $("#btn-survey-query");
  const surveyProfileResult = $("#survey-profile-result");
  const surveyProfileId = $("#survey-profile-id");
  const surveyProfileName = $("#survey-profile-name");
  const surveyProfileRating = $("#survey-profile-rating");
  const surveyProfileHigh = $("#survey-profile-high");
  const surveyProfilePlayed = $("#survey-profile-played");
  const surveyProfileWin = $("#survey-profile-win");
  const surveyProfileLoss = $("#survey-profile-loss");
  const surveyProfileDraw = $("#survey-profile-draw");
  const btnWorkspaceCompetition = $("#btn-workspace-competition");
  const btnWorkspaceSurvey = $("#btn-workspace-survey");
  const btnWorkspaceBack = $("#btn-workspace-back");
  const scheduleRegistrationDeadlineInput = $("#schedule-registration-deadline");
  const scheduleCheckinStartInput = $("#schedule-checkin-start");
  const scheduleCheckinDeadlineInput = $("#schedule-checkin-deadline");
  const scheduleCompetitionStartInput = $("#schedule-competition-start");
  const scheduleSemifinalAndFinalInput = $("#schedule-semifinal-and-final");
  const scheduleSkipSemifinalInput = $("#schedule-skip-semifinal");
  const scheduleBrightwellConstantInput = $("#schedule-brightwell-constant");
  const scheduleValidation = $("#schedule-validation");
  const btnScheduleBack = $("#btn-schedule-back");
  const btnScheduleContinue = $("#btn-schedule-continue");
  const btnEditSchedule = $("#btn-edit-schedule");
  const btnLoadWechatGroups = $("#btn-load-wechat-groups");
  const scheduleChatSelected = $("#schedule-chat-selected");
  const scheduleChatStatus = $("#schedule-chat-status");
  const scheduleChatList = $("#schedule-chat-list");
  const btnCheckWechatDecryptStatus = $("#btn-check-wechat-decrypt-status");
  const wechatDecryptStatus = $("#wechat-decrypt-status");
  const eventScheduleInputs = {
    registrationDeadline: scheduleRegistrationDeadlineInput,
    checkinStart: scheduleCheckinStartInput,
    checkinDeadline: scheduleCheckinDeadlineInput,
    competitionStart: scheduleCompetitionStartInput,
  };
  const checkinViewTabs = $("#checkin-view-tabs");
  const checkinPlayersView = $("#checkin-players-view");
  const mappingView = $("#checkin-mapping-view");
  const mappingGroupNameInput = $("#mapping-group-name");
  const mappingTableWrap = $("#mapping-table-wrap");
  const mappingTableBody = $("#mapping-table-body");
  const mappingEmptyState = $("#mapping-empty-state");
  const mappingSummary = $("#mapping-summary");
  const mappingGroupNickOptions = $("#mapping-group-nick-options");
  const btnRefreshWechatNicks = $("#btn-refresh-wechat-nicks");
  const btnValidateOqAccounts = $("#btn-validate-oq-accounts");
  const btnSelfCheckMapping = $("#btn-self-check-mapping");
  const btnExportMappingPng = $("#btn-export-mapping-png");
  const btnApplyMappingToRoster = $("#btn-apply-mapping-to-roster");
  const btnClearMapping = $("#btn-clear-mapping");

  const clubMembersEl = $("#club-members");
  const relayInfoEl = $("#relay-info");
  const relayInfoDetails = $("#relay-info-details");
  const wechatRelayReferenceStatus = $("#wechat-relay-reference-status");
  const btnWechatRelayReference = $("#btn-wechat-relay-reference");
  const btnWechatRelaySync = $("#btn-wechat-relay-sync");
  const btnWechatAutoCheckin = $("#btn-wechat-auto-checkin");
  const wechatAutoCheckinPendingPanel = $("#wechat-auto-checkin-pending");
  const wechatAutoCheckinPendingList = $("#wechat-auto-checkin-pending-list");
  const wechatAutoCheckinPendingCount = $("#wechat-auto-checkin-pending-count");
  const groupRulesEl = $("#group-rules");
  const btnAddGroupRule = $("#btn-add-group-rule");
  const btnResetGroupRules = $("#btn-reset-group-rules");

  const btnImport = $("#btn-import");
  const btnResume = $("#btn-resume");

  const btnBack = $("#btn-back");
  const btnBatch = $("#btn-batch");
  const btnFinish = $("#btn-finish");
  const btnLiveStandings = $("#btn-live-standings");
  const btnOpenPreliminaryStandings = $("#btn-open-preliminary-standings");
  const btnBackPreliminaryRegistration = $("#btn-back-preliminary-registration");
  const btnOpenOverallStandings = $("#btn-open-overall-standings");
  const btnOpenOverallStandingsLabel = $("#btn-open-overall-standings-label");
  const btnOpenTournamentResultLabel = $("#btn-open-tournament-result-label");
  const scoreNextStageHint = $("#score-next-stage-hint");
  const btnExportQuick = $("#btn-export-quick");
  const scoreHelperTitle = $("#score-helper-title");
  const scoreRoundCountInput = $("#score-round-count");
  const btnScoreApplyRounds = $("#btn-score-apply-rounds");
  const scoreRoundStartInput = $("#score-round-start");
  const btnScoreApplyCurrentTime = $("#btn-score-apply-current-time");
  const finalRoundStartInput = $("#final-round-start");
  const btnApplyFinalRoundCurrentTime = $("#btn-apply-final-round-current-time");
  const btnImportScorePairings = $("#btn-import-score-pairings");
  const btnImportPappPairings = $("#btn-import-papp-pairings");
  const pappPairingsFileInput = $("#papp-pairings-file-input");
  const btnRefreshScoreRound = $("#btn-refresh-score-round");
  const btnExportScorePairingsPng = $("#btn-export-score-pairings-png");
  const btnExportScoreResultsPng = $("#btn-export-score-results-png");
  const scoreOqPollSecondsInput = $("#score-oq-poll-seconds");
  const btnUpdateRoundOqScores = $("#btn-update-round-oq-scores");
  const btnToggleOqScorePoll = $("#btn-toggle-oq-score-poll");
  const btnToggleEgAnalysis = $("#btn-toggle-eg-analysis");
  const btnUpdatePlayoffOqScores = $("#btn-update-playoff-oq-scores");
  const btnTogglePlayoffOqScorePoll = $("#btn-toggle-playoff-oq-score-poll");
  const btnTogglePlayoffEgAnalysis = $("#btn-toggle-playoff-eg-analysis");
  const btnExportEgPerformancePng = $("#btn-export-eg-performance-png");
  const scoreIntegrationStatus = $("#score-integration-status");
  const btnScoreBackCheckin = $("#btn-score-back-checkin");
  const scoreRoundTabs = $("#score-round-tabs");
  const scoreHelperSummary = $("#score-helper-summary");
  const btnRegisterReadyScores = $("#btn-register-ready-scores");
  const scorePairingSearchInput = $("#score-pairing-search");
  const scorePairingSearchHint = $("#score-pairing-search-hint");
  const scorePairingsList = $("#score-pairings-list");
  const finalRegistrationSummary = $("#final-registration-summary");
  const finalRegistrationPairings = $("#final-registration-pairings");
  const btnRegisterPlayoffReadyScores = $("#btn-register-playoff-ready-scores");
  const scorePendingList = $("#score-pending-list");
  const scoreManualPendingList = $("#score-manual-pending-list");
  const scoreCompletedList = $("#score-completed-list");

  const competitionTitleEl = $("#competition-title");
  const competitionNameInput = $("#competition-name-input");

  const groupFilterEl = $("#group-filter");
  const btnCallMode = $("#btn-call-mode");
  const btnShowTime = $("#btn-show-time");
  const btnSuspects = $("#btn-suspects");
  const btnPlanWithdrawal = $("#btn-plan-withdrawal");

  const searchBox = $("#search-box");
  const btnClearSearch = $("#btn-clear-search");
  const playerList = $("#player-list");
  const iosPlayerListAnchor = $("#ios-player-list-anchor");

  const totalCountEl = $("#total-count");
  const checkedInCountEl = $("#checked-in-count");
  const notCheckedInCountEl = $("#not-checked-in-count");
  const statFilteredContainer = $("#stat-filtered-container");
  const statFilteredEl = $("#stat-filtered");

  const addPlayerNameInput = $("#add-player-name");
  const btnAdd = $("#btn-add");
  const importEmptyState = $("#import-empty-state");
  const autosaveTimeEl = $("#autosave-time");

  const btnReset = $("#btn-reset");
  const btnHelp = $("#btn-help");
  const btnInstall = $("#btn-install");
  const panelInstallBtn = $("#panel-install-btn");

  const btnExportJson = $("#btn-export-json");
  const btnImportJsonPaste = $("#btn-import-json-paste");
  const importJsonInput = $("#import-json-input");

  // Export modal
  const exportBackdrop = $("#export-backdrop");
  const exportContainer = $("#export-container");
  const exportInappTip = $("#export-inapp-tip");
  const btnExportClose = $("#btn-export-close");
  const btnDownloadPng = $("#btn-download-png");
  const btnDownloadCsv = $("#btn-download-csv");
  const btnCopy = $("#btn-copy");
  const exportGroupSel = $("#export-group");
  const exportScopeSel = $("#export-scope");
  const exportOrderSel = $("#export-order");
  const exportWithGroupEl = $("#export-with-group");
  const exportWithPlatformEl = $("#export-with-platform");
  const exportWithAccountEl = $("#export-with-account");
  const exportWithClubEl = $("#export-with-club");
  const exportWithTimeEl = $("#export-with-time");

  function shouldUseIOSTouchCheckinLayout() {
    try {
      const touchPoints =
        window.navigator && Number(window.navigator.maxTouchPoints);
      const hasTouch = touchPoints > 0 || "ontouchstart" in window;
      if (!hasTouch) return false;

      const ua = getUA();
      if (isIOS() || /Android/i.test(ua)) return true;
      if (navigator.virtualKeyboard) return true;

      const coarse =
        window.matchMedia &&
        window.matchMedia("(pointer: coarse) and (hover: none)").matches;
      return Boolean(coarse);
    } catch (_) {
      return false;
    }
  }

  function shouldUseTabletCheckinLayout() {
    try {
      const ua = getUA();
      const touchPoints =
        window.navigator && Number(window.navigator.maxTouchPoints);
      const iPadOS =
        window.navigator.platform === "MacIntel" && touchPoints > 1;
      if (/iPad/i.test(ua) || iPadOS) return true;
      if (!/Android/i.test(ua)) return false;

      const minSide = Math.min(
        Number(window.screen && window.screen.width) || window.innerWidth || 0,
        Number(window.screen && window.screen.height) || window.innerHeight || 0,
      );
      return (
        minSide >= 600 ||
        (touchPoints > 1 &&
          Math.min(window.innerWidth || 0, window.innerHeight || 0) >= 600)
      );
    } catch (_) {
      return false;
    }
  }

  function setupIOSTouchCheckinLayout() {
    const root = document.documentElement;
    const body = document.body;
    const enabled = shouldUseIOSTouchCheckinLayout();
    const tabletEnabled = enabled && shouldUseTabletCheckinLayout();
    if (root && root.classList) {
      root.classList.toggle("ios-touch-checkin", enabled);
      root.classList.toggle("screen-keyboard-checkin", enabled);
      root.classList.toggle("ios-tablet-checkin", tabletEnabled);
      root.classList.toggle("tablet-checkin", tabletEnabled);
    }

    if (!enabled || !playerList || !iosPlayerListAnchor) return;
    iosPlayerListAnchor.appendChild(playerList);

    const isKeyboardLikelyOpen = () => {
      const vv = window.visualViewport;
      const layoutHeight = Number(window.innerHeight) || 0;
      const visualHeight = vv && Number(vv.height) > 0 ? Number(vv.height) : 0;
      return Boolean(
        visualHeight &&
          layoutHeight &&
          visualHeight < Math.max(320, layoutHeight * 0.86),
      );
    };

    const updateVisualViewportVars = () => {
      if (!root || !root.style) return;
      const vv = window.visualViewport;
      const height =
        vv && Number(vv.height) > 0 ? Number(vv.height) : window.innerHeight;
      const offsetTop =
        vv && Number.isFinite(Number(vv.offsetTop))
          ? Number(vv.offsetTop)
          : 0;
      root.style.setProperty(
        "--ios-checkin-visual-height",
        `${Math.max(320, Math.round(height || 0))}px`,
      );
      root.style.setProperty(
        "--ios-checkin-visual-offset-top",
        `${Math.max(0, Math.round(offsetTop))}px`,
      );
    };

    const setEditing = (value) => {
      updateVisualViewportVars();
      if (body && body.classList) {
        body.classList.toggle("ios-checkin-editing", Boolean(value));
      }
      if (
        value &&
        root &&
        root.classList.contains("screen-keyboard-checkin")
      ) {
        window.requestAnimationFrame(() => {
          if (playerList) playerList.scrollTop = 0;
        });
      }
    };

    updateVisualViewportVars();
    window.addEventListener("resize", updateVisualViewportVars, {
      passive: true,
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener(
        "resize",
        updateVisualViewportVars,
        { passive: true },
      );
      window.visualViewport.addEventListener(
        "scroll",
        updateVisualViewportVars,
        { passive: true },
      );
    }

    document.addEventListener("focusin", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target || !stepCheckin || stepCheckin.classList.contains("hidden")) {
        return;
      }
      if (!target.closest("#step-checkin")) return;
      const tag = String(target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        setEditing(true);
      }
    });
    document.addEventListener("focusout", () => {
      window.setTimeout(() => {
        const active = isElement(document.activeElement)
          ? document.activeElement
          : null;
        if (active && active.closest("#step-checkin")) return;
        if (
          root &&
          root.classList.contains("screen-keyboard-checkin") &&
          isKeyboardLikelyOpen()
        ) {
          setEditing(true);
          return;
        }
        setEditing(false);
      }, 80);
    });
  }

  function getCurrentStep() {
    const s = String(viewStepOverride || "").trim();
    const requestedStep = COMPETITION_STEP_IDS.includes(s)
      ? s
      : COMPETITION_STEP_IDS.includes(state.step)
        ? state.step
        : "import";
    return normalizeTournamentStep(requestedStep);
  }

  let tournamentStageLoadSequence = 0;

  function stageLoadIsCurrent(sequence, step) {
    return tournamentStageLoadSequence === sequence &&
      state.appMode === "competition" && getCurrentStep() === step;
  }

  function setTournamentStageStatus(statusElement, contentElement, message, kind = "idle") {
    if (statusElement) {
      statusElement.textContent = String(message || "");
      statusElement.dataset.kind = ["loading", "empty", "warning", "error", "ok"].includes(kind)
        ? kind
        : "idle";
    }
    if (contentElement) {
      contentElement.setAttribute("aria-busy", kind === "loading" ? "true" : "false");
    }
  }

  function renderTournamentStageEmpty(contentElement, title, message) {
    if (!contentElement) return;
    contentElement.innerHTML = `
      <div class="empty-state empty-state--list">
        <svg class="empty-state__icon" aria-hidden="true"><use href="#i-tune"></use></svg>
        <div>
          <div class="empty-state__title">${escapeHtml(title || "暂无数据")}</div>
          <div class="empty-state__text">${escapeHtml(message || "")}</div>
        </div>
      </div>
    `;
  }

  function standingsProgressMessage(progress) {
    if (!progress || typeof progress !== "object") return "";
    const expected = Math.max(1, Math.trunc(Number(progress.expectedRounds) || 1));
    if (progress.complete === true) return `预赛 ${expected} 轮配对与比分均已登记。`;

    const details = [];
    const missing = Array.isArray(progress.missingRounds) ? progress.missingRounds : [];
    if (missing.length) {
      const shown = missing.slice(0, 5).map((round) => `第 ${Math.trunc(Number(round))} 轮`);
      details.push(`缺少${shown.join("、")}${missing.length > shown.length ? "等配对" : "配对"}`);
    }
    const unresolved = Math.max(0, Math.trunc(Number(progress.unresolvedPairings) || 0));
    if (unresolved) details.push(`${unresolved} 场比分待登记`);
    return `当前排名为暂算${details.length ? `：${details.join("；")}` : "，预赛成绩尚未完整"}。`;
  }

  function formatTournamentMetric(value) {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return Number.isInteger(number)
      ? String(number)
      : number.toLocaleString("zh-Hans-CN", { maximumFractionDigits: 2, useGrouping: false });
  }

  function renderStandingsTable(contentElement, rows, label, options = {}) {
    if (!contentElement) return;
    const showPreliminaryRank = options.showPreliminaryRank === true;
    const standings = Array.isArray(rows) ? rows : [];
    if (!standings.length) {
      renderTournamentStageEmpty(contentElement, "没有已签到选手", "完成选手签到后，排名数据会显示在这里。");
      return;
    }

    const body = standings.map((row) => {
      const player = row && typeof row === "object" ? row : {};
      const rank = standingsNumber(player.rank);
      const preliminaryRank = standingsNumber(player.preliminaryRank);
      const account = normalizeWhitespace(player.account || "");
      return `
        <tr>
          <td class="papp-standings-table__rank">${rank === null ? "—" : rank}</td>
          <td class="papp-standings-table__player">
            <span>${escapeHtml(player.displayName || "未命名选手")}</span>
            ${account ? `<small>${escapeHtml(account)}</small>` : ""}
          </td>
          <td class="papp-standings-table__numeric">${escapeHtml(formatTournamentMetric(player.totalPoints))}</td>
          <td class="papp-standings-table__numeric">${escapeHtml(formatTournamentMetric(player.brightwell))}</td>
          <td class="papp-standings-table__numeric">${escapeHtml(formatTournamentMetric(player.totalDiscs))}</td>
          ${showPreliminaryRank ? `<td class="papp-standings-table__numeric">${preliminaryRank === null ? "—" : preliminaryRank}</td>` : ""}
        </tr>
      `;
    }).join("");

    contentElement.innerHTML = `
      <div class="papp-standings-table-wrap">
        <table class="papp-standings-table" aria-label="${escapeHtml(label || "比赛排名")}">
          <thead>
            <tr><th scope="col">名次</th><th scope="col">选手</th><th scope="col">总积分</th><th scope="col">Brightwell</th><th scope="col">总棋子数</th>${showPreliminaryRank ? '<th scope="col">预赛名次</th>' : ""}</tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    `;
  }

  function liveStandingsSelection(kind, round) {
    return kind === "overall" ? "overall" : `preliminary:${round}`;
  }

  function parseLiveStandingsSelection(value) {
    if (value === "overall") {
      return { kind: "overall", round: ensureScoreHelper().preliminaryRoundCount };
    }
    const match = /^preliminary:(\d+)$/.exec(String(value || ""));
    const helper = ensureScoreHelper();
    const requestedRound = match ? Number(match[1]) : helper.activeRound;
    const round = Math.max(1, Math.min(
      helper.preliminaryRoundCount,
      Math.trunc(Number(requestedRound) || 1),
    ));
    return { kind: "preliminary", round };
  }

  function currentStandingsSnapshots() {
    const helper = ensureScoreHelper();
    return sanitizeStandingsSnapshots(
      state.standingsSnapshots,
      helper.pappWorkfileId,
    );
  }

  function findStandingsSnapshot(kind, round) {
    return currentStandingsSnapshots().find((snapshot) =>
      snapshot.kind === kind && snapshot.round === round,
    ) || null;
  }

  function storeStandingsSnapshot(kind, round, result) {
    if (
      !result || result.source !== "papp-c" ||
      !Array.isArray(result.standings) || result.standings.length === 0
    ) return null;
    const helper = ensureScoreHelper();
    const existing = currentStandingsSnapshots().filter((snapshot) =>
      snapshot.kind !== kind || snapshot.round !== round,
    );
    const snapshot = {
      kind,
      round,
      source: "papp-c",
      operation: result.operation || (kind === "overall" ? "overall-standings" : "round-standings"),
      pappWorkfileId: helper.pappWorkfileId,
      capturedAt: now(),
      progress: result.progress || {},
      standings: result.standings,
    };
    state.standingsSnapshots = sanitizeStandingsSnapshots(
      [...existing, snapshot],
      helper.pappWorkfileId,
    );
    const stored = findStandingsSnapshot(kind, round);
    if (stored) scheduleSave({ source: "script" });
    return stored;
  }

  function liveStandingsLabel(kind, round) {
    return kind === "overall"
      ? "赛事总排名"
      : `第 ${round} 轮`;
  }

  function formatStandingsSnapshotTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return "时间未知";
    return new Date(value).toLocaleString(document.documentElement.lang || undefined);
  }

  function setLiveStandingsStatus(view, message, kind = "idle") {
    setTournamentStageStatus(view.status, view.content, message, kind);
  }

  function renderCachedLiveStandings(view, selection, statusOverride) {
    const snapshot = findStandingsSnapshot(selection.kind, selection.round);
    if (!snapshot) {
      view.snapshot = null;
      view.exportButton.disabled = true;
      view.summary.textContent = "";
      setLiveStandingsStatus(view, "该轮尚无排名缓存，请刷新以读取 PAPP C。", "empty");
      renderTournamentStageEmpty(
        view.content,
        "排名尚未加载",
        "点击“刷新排名”后，结果会由 PAPP C 返回并保存为本轮快照。",
      );
      return false;
    }

    view.snapshot = snapshot;
    view.exportButton.disabled = false;
    const label = liveStandingsLabel(snapshot.kind, snapshot.round);
    const caption = `${label} · ${snapshot.standings.length} 位选手 · 更新时间：${formatStandingsSnapshotTime(snapshot.capturedAt)}`;
    view.summary.textContent = caption;
    const status = statusOverride || (
      snapshot.progress.complete === true
        ? "显示已完成的 PAPP C 排名快照。"
        : "显示最近保存的 PAPP C 排名快照。"
    );
    setLiveStandingsStatus(
      view,
      status,
      snapshot.progress.complete === true ? "ok" : "warning",
    );
    renderStandingsTable(view.content, snapshot.standings, `${label}排名`, {
      showPreliminaryRank: snapshot.kind === "overall",
    });
    return true;
  }

  function createLiveStandingsDialogContent(initialSelection) {
    const root = document.createElement("div");
    root.className = "live-standings";

    const controls = document.createElement("div");
    controls.className = "live-standings__controls";
    const label = document.createElement("label");
    label.className = "live-standings__label";
    label.htmlFor = "live-standings-round-select";
    label.textContent = "排名轮次";

    const select = document.createElement("select");
    select.id = "live-standings-round-select";
    select.className = "input live-standings__select";
    const helper = ensureScoreHelper();
    for (let round = 1; round <= helper.preliminaryRoundCount; round++) {
      const option = document.createElement("option");
      option.value = liveStandingsSelection("preliminary", round);
      option.textContent = `第 ${round} 轮`;
      select.appendChild(option);
    }
    const overallOption = document.createElement("option");
    overallOption.value = "overall";
    overallOption.textContent = "赛事总排名";
    select.appendChild(overallOption);

    const refreshButton = document.createElement("button");
    refreshButton.className = "btn btn-outlined";
    refreshButton.type = "button";
    refreshButton.textContent = "刷新排名";

    const exportButton = document.createElement("button");
    exportButton.className = "btn btn-outlined live-standings__export-button";
    exportButton.type = "button";
    exportButton.title = "导出当前排名 PNG";
    exportButton.innerHTML = `
      <svg class="btn__icon" aria-hidden="true"><use href="#i-image"></use></svg>
      <span class="btn__label">导出 PNG</span>
    `;
    exportButton.disabled = true;
    const archiveButton = document.createElement("button");
    archiveButton.className = "btn btn-outlined live-standings__archive-button";
    archiveButton.type = "button";
    archiveButton.textContent = "存档该比赛";
    archiveButton.title = "将本次比赛完整资料另存为 CSV，保存在仓库的手动比赛存档文件夹";
    controls.append(label, select, refreshButton, exportButton, archiveButton);

    const note = document.createElement("p");
    note.className = "live-standings__note";
    note.textContent = "排名由本地 PAPP C 计算；每轮最近一次结果会保留，可切换查看。";

    const status = document.createElement("div");
    status.className = "score-integration-status live-standings__status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const archiveStatus = document.createElement("div");
    archiveStatus.className = "score-integration-status live-standings__status";
    archiveStatus.setAttribute("role", "status");
    archiveStatus.setAttribute("aria-live", "polite");
    archiveStatus.style.overflowWrap = "anywhere";
    archiveStatus.hidden = true;

    const summary = document.createElement("div");
    summary.className = "tournament-stage__summary live-standings__summary";
    const content = document.createElement("div");
    content.className = "tournament-stage-content live-standings__content";

    root.append(controls, note, archiveStatus, status, summary, content);
    const view = {
      root,
      select,
      refreshButton,
      exportButton,
      archiveButton,
      archiveStatus,
      status,
      summary,
      content,
      snapshot: null,
    };
    select.value = initialSelection;
    select.addEventListener("change", () => {
      renderCachedLiveStandings(view, parseLiveStandingsSelection(select.value));
    });
    refreshButton.addEventListener("click", () => {
      void refreshLiveStandings(view);
    });
    exportButton.addEventListener("click", () => {
      void exportLiveStandingsPNG(view);
    });
    archiveButton.addEventListener("click", () => {
      void archiveLiveStandingsTournament(view);
    });
    renderCachedLiveStandings(view, parseLiveStandingsSelection(select.value));
    return view;
  }

  async function archiveLiveStandingsTournament(view) {
    if (view.archiveButton.disabled) return;
    view.archiveButton.disabled = true;
    view.archiveButton.textContent = "正在存档…";
    view.archiveStatus.hidden = false;
    view.archiveStatus.dataset.kind = "idle";
    view.archiveStatus.textContent = "正在整理本次比赛资料并读取 PAPP C 排名…";
    try {
      ensureScoreHelper();
      ensureTournamentParametersState();
      const response = await fetch("/api/papp/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ state: deepClone(state) }),
      });
      const result = await response.json();
      if (!response.ok || !result || result.ok !== true || !result.file) {
        throw new Error(normalizeWhitespace(result && (result.detail || result.message || result.error)) || "比赛存档失败");
      }
      const missingNote = Number(result.missingCount) > 0
        ? `；有 ${Number(result.missingCount)} 条记录存在资料缺失，已在 CSV 中标注`
        : "";
      view.archiveStatus.dataset.kind = "ok";
      view.archiveStatus.textContent = `比赛已另存为 CSV：${result.file}${missingNote}。`;
    } catch (error) {
      view.archiveStatus.dataset.kind = "error";
      view.archiveStatus.textContent = `比赛存档失败：${normalizeWhitespace(error && error.message) || "未知错误"}`;
    } finally {
      view.archiveButton.disabled = false;
      view.archiveButton.textContent = "存档该比赛";
    }
  }

  function liveStandingsIncompleteMessage(selection, result) {
    if (selection.kind === "overall") {
      return "最终名次尚未由 PAPP C 确认，请完成当前比赛阶段后重试。";
    }
    const unresolved = Math.max(0, Math.trunc(Number(
      result.progress && result.progress.unresolvedPairings,
    ) || 0));
    if (unresolved) {
      return "PAPP C 返回暂算排名，仍有 " + unresolved + " 场比分待确认。";
    }
    return "PAPP C 返回暂算排名，本轮成绩尚未完整。";
  }

  async function refreshLiveStandings(view) {
    if (view.refreshButton.disabled) return;
    const selection = parseLiveStandingsSelection(view.select.value);
    const requestedSelection = liveStandingsSelection(selection.kind, selection.round);
    view.refreshButton.disabled = true;
    view.refreshButton.textContent = "正在读取…";
    setLiveStandingsStatus(view, "正在向 PAPP C 请求最新排名…", "loading");
    try {
      const helper = ensureScoreHelper();
      const isOverall = selection.kind === "overall";
      const result = assertAdapterSuccess(
        await invokeTournamentAdapter(
          isOverall ? "getOverallStandings" : "getRoundStandings",
          {
            round: isOverall
              ? helper.preliminaryRoundCount + (hasSemifinalAndFinal() ? 2 : 1)
              : selection.round,
            stage: isOverall ? "overall" : "preliminary",
            mode: isOverall ? "overall-standings" : "round-standings",
          },
        ),
        "PAPP C 实时排名读取失败",
      );
      if (result.source !== "papp-c") throw new Error("排名结果不是由 PAPP C 返回");
      if (!Array.isArray(result.standings)) throw new Error("PAPP C 返回的排名格式无效");
      if (!isOverall && (
        result.operation !== "round-standings" || Number(result.round) !== selection.round
      )) {
        throw new Error("PAPP C 返回的排名轮次与请求不一致");
      }

      if (result.standings.length) {
        const snapshot = storeStandingsSnapshot(selection.kind, selection.round, result);
        if (!snapshot) throw new Error("PAPP C 排名数据缺少选手编号或姓名，无法保存快照");
        if (view.select.value === requestedSelection) {
          const freshStatus = selection.kind === "overall"
            ? result.stageProgress && result.stageProgress.complete === true
              ? "赛事最终排名已由 PAPP C 更新。"
              : liveStandingsIncompleteMessage(selection, result)
            : result.progress && result.progress.complete === true
              ? "本轮排名已由 PAPP C 更新。"
              : liveStandingsIncompleteMessage(selection, result);
          renderCachedLiveStandings(view, selection, freshStatus);
        }
      } else {
        const message = liveStandingsIncompleteMessage(selection, result);
        view.snapshot = null;
        view.exportButton.disabled = true;
        view.summary.textContent = "";
        setLiveStandingsStatus(view, message, "warning");
        renderTournamentStageEmpty(view.content, "排名尚未就绪", message);
      }
    } catch (error) {
      const message = normalizeWhitespace(error && error.message) || "PAPP C 实时排名读取失败";
      const hasCached = renderCachedLiveStandings(
        view,
        selection,
        "PAPP C 查询失败，当前显示上次保存的排名快照。 " + message,
      );
      if (!hasCached) {
        setLiveStandingsStatus(view, message, "error");
        renderTournamentStageEmpty(view.content, "无法读取实时排名", message);
      }
    } finally {
      view.refreshButton.disabled = false;
      view.refreshButton.textContent = "刷新排名";
      if (view.select.value !== requestedSelection) {
        renderCachedLiveStandings(view, parseLiveStandingsSelection(view.select.value));
      }
    }
  }

  function liveStandingsPngCopy(snapshot) {
    const lang = document.documentElement.lang || "zh-Hans";
    const english = lang.toLowerCase().startsWith("en");
    const japanese = lang.toLowerCase().startsWith("ja");
    const traditional = lang === "zh-Hant";
    const count = snapshot.standings.length;
    const timestamp = formatStandingsSnapshotTime(snapshot.capturedAt);
    const complete = snapshot.progress && snapshot.progress.complete === true;
    const explicitlyIncomplete = snapshot.progress && snapshot.progress.complete === false;
    const copy = english
      ? {
          overallTitle: "Tournament standings",
          roundTitle: `Round ${snapshot.round} standings`,
          players: "players",
          updated: "Updated: ",
          complete: "Confirmed by PAPP C",
          incomplete: "Provisional PAPP C standings",
          saved: "Saved PAPP C snapshot",
          rank: "Rank",
          player: "Player",
          totalPoints: "Total points",
          brightwell: "Brightwell",
          totalDiscs: "Total discs",
          preliminaryRank: "Preliminary rank",
          source: "Standings provided by local PAPP C",
          competitionFallback: "Tournament",
          unnamedPlayer: "Unnamed player",
          exportFailed: "Standings PNG export failed",
          downloadStarted: "Standings PNG download started",
          imageOpened: "PNG opened. Save the image from the new tab.",
          imagePreview: "PNG is ready. Save the image from the preview page.",
          inAppBlocked: "This in-app browser may block downloads. Open the page in your system browser.",
        }
      : japanese
        ? {
            overallTitle: "大会総合順位",
            roundTitle: `第 ${snapshot.round} ラウンド順位`,
            players: "人",
            updated: "更新：",
            complete: "PAPP C 確定順位",
            incomplete: "PAPP C 暫定順位",
            saved: "保存済み PAPP C スナップショット",
            rank: "順位",
            player: "選手",
            totalPoints: "合計ポイント",
            brightwell: "Brightwell",
            totalDiscs: "合計石数",
            preliminaryRank: "予選順位",
            source: "順位データ提供：ローカル PAPP C",
            competitionFallback: "大会",
            unnamedPlayer: "名前未設定",
            exportFailed: "順位 PNG の書き出しに失敗しました",
            downloadStarted: "順位 PNG のダウンロードを開始しました",
            imageOpened: "PNG を開きました。新しいタブから画像を保存してください。",
            imagePreview: "PNG を表示しました。プレビュー画面から画像を保存してください。",
            inAppBlocked: "アプリ内ブラウザではダウンロードが制限される場合があります。通常のブラウザで開いてください。",
          }
        : traditional
          ? {
              overallTitle: "賽事總排名",
              roundTitle: `第 ${snapshot.round} 輪排名`,
              players: "位選手",
              updated: "更新時間：",
              complete: "PAPP C 已確認",
              incomplete: "PAPP C 暫算排名",
              saved: "已保存的 PAPP C 排名快照",
              rank: "名次",
              player: "選手",
              totalPoints: "總積分",
              brightwell: "Brightwell",
              totalDiscs: "總棋子數",
              preliminaryRank: "預賽名次",
              source: "排名資料由本機 PAPP C 提供",
              competitionFallback: "比賽",
              unnamedPlayer: "未命名選手",
              exportFailed: "排名 PNG 匯出失敗",
              downloadStarted: "已開始下載排名 PNG",
              imageOpened: "PNG 已開啟，請在新分頁儲存圖片。",
              imagePreview: "PNG 已顯示，請在預覽頁儲存圖片。",
              inAppBlocked: "內建瀏覽器可能會阻擋下載，請改用系統瀏覽器開啟。",
            }
          : {
              overallTitle: "赛事总排名",
              roundTitle: `第 ${snapshot.round} 轮排名`,
              players: "位选手",
              updated: "更新时间：",
              complete: "PAPP C 已确认",
              incomplete: "PAPP C 暂算排名",
              saved: "已保存的 PAPP C 排名快照",
              rank: "名次",
              player: "选手",
              totalPoints: "总积分",
              brightwell: "Brightwell",
              totalDiscs: "总棋子数",
              preliminaryRank: "预赛名次",
              source: "排名数据由本地 PAPP C 提供",
              competitionFallback: "比赛",
              unnamedPlayer: "未命名选手",
              exportFailed: "排名 PNG 导出失败",
              downloadStarted: "已开始下载排名 PNG",
              imageOpened: "PNG 已打开，请在新标签页保存图片。",
              imagePreview: "PNG 已显示，请在预览页保存图片。",
              inAppBlocked: "内置浏览器可能会拦截下载，请改用系统浏览器打开。",
            };
    const status = complete ? copy.complete : explicitlyIncomplete ? copy.incomplete : copy.saved;
    const metadata = english
      ? `${count} ${copy.players} · ${copy.updated}${timestamp} · ${status}`
      : japanese
        ? `${count}${copy.players} · ${copy.updated}${timestamp} · ${status}`
        : `${count} ${copy.players} · ${copy.updated}${timestamp} · ${status}`;
    return {
      labels: {
        title: snapshot.kind === "overall" ? copy.overallTitle : copy.roundTitle,
        metadata,
        rank: copy.rank,
        player: copy.player,
        totalPoints: copy.totalPoints,
        brightwell: copy.brightwell,
        totalDiscs: copy.totalDiscs,
        preliminaryRank: copy.preliminaryRank,
        source: copy.source,
        competitionFallback: copy.competitionFallback,
        unnamedPlayer: copy.unnamedPlayer,
        exportFailed: copy.exportFailed,
        downloadStarted: copy.downloadStarted,
        imageOpened: copy.imageOpened,
        imagePreview: copy.imagePreview,
        inAppBlocked: copy.inAppBlocked,
      },
      showPreliminaryRank: snapshot.kind === "overall",
    };
  }

  async function exportLiveStandingsPNG(view) {
    const snapshot = view.snapshot;
    if (!snapshot || !Array.isArray(snapshot.standings) || !snapshot.standings.length) return;

    const idleLabel = "导出 PNG";
    const busyLabel = isIOS() ? "打开中…" : "生成中…";
    setBtnBusy(view.exportButton, true, busyLabel, idleLabel);
    const previewWindow = shouldOpenPNGPreviewWindow()
      ? openPNGPreviewWindow()
      : null;
    const copy = liveStandingsPngCopy(snapshot);

    try {
      const renderer = window.PAPP_STANDINGS_PNG_RENDERER;
      if (!renderer || typeof renderer.buildStandingsCanvas !== "function") {
        throw new Error("排名 PNG 渲染器未加载");
      }
      const canvas = renderer.buildStandingsCanvas({
        competitionName: state.competitionName,
        standings: snapshot.standings,
        showPreliminaryRank: copy.showPreliminaryRank,
        labels: copy.labels,
      });
      const suffix = snapshot.kind === "overall"
        ? "总排名"
        : `第${snapshot.round}轮排名`;
      const filename = `${makeSafeFilename(state.competitionName || "比赛")}_${makeSafeFilename(suffix)}.png`;
      const mode = await saveCanvasAsPNG(canvas, filename, previewWindow);
      const message = mode === "inapp"
        ? copy.labels.inAppBlocked
        : mode === "open"
          ? copy.labels.imageOpened
          : mode === "preview"
            ? copy.labels.imagePreview
            : copy.labels.downloadStarted;
      showSnackbar(message, 3200);
    } catch (error) {
      closePNGPreviewWindow(previewWindow);
      const message = normalizeWhitespace(error && error.message) || "未知错误";
      showSnackbar(`${copy.labels.exportFailed}：${message}`, 3600);
    } finally {
      setBtnBusy(view.exportButton, false, busyLabel, idleLabel);
    }
  }

  function openLiveStandings(selection = liveStandingsSelection(
    "preliminary",
    ensureScoreHelper().activeRound,
  )) {
    const normalized = parseLiveStandingsSelection(selection);
    const key = liveStandingsSelection(normalized.kind, normalized.round);
    const view = createLiveStandingsDialogContent(key);
    showDialog({
      title: "查看实时排名",
      contentNode: view.root,
      wide: true,
      buttons: [{ label: "关闭", className: "btn btn-outlined" }],
    });
    void refreshLiveStandings(view);
  }

  async function captureRoundStandingsSnapshot(round) {
    const result = assertAdapterSuccess(
      await invokeTournamentAdapter("getRoundStandings", {
        round,
        stage: "preliminary",
        mode: "round-standings",
      }),
      "PAPP C 本轮排名快照读取失败",
    );
    if (
      result.source !== "papp-c" || result.operation !== "round-standings" ||
      Number(result.round) !== Number(round)
    ) {
      throw new Error("PAPP C 返回的排名轮次与请求不一致");
    }
    const snapshot = storeStandingsSnapshot("preliminary", Number(round), result);
    if (!snapshot) throw new Error("PAPP C 未返回可保存的本轮排名");
    return snapshot;
  }

  function localSyncVerificationWaitMs(status) {
    const serverWait = status && status.scriptWritePending === true
      ? Math.max(0, Number(status.retryAfterMs) || 0)
      : 0;
    const rememberedWait = Math.max(0, localSyncPendingScriptUntil - now());
    const localEditWait = Math.max(
      0,
      lastLocalEditAt + LOCAL_SYNC_USER_WRITE_GUARD_MS - now(),
    );
    return Math.max(serverWait, rememberedWait, localEditWait);
  }

  function updatePappVerificationDialog(content, waitMs) {
    if (!content) return;
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 100) / 10;
      content.textContent =
        `正在等待比分与比赛进度同步，预计还需 ${seconds.toFixed(1)} 秒…`;
    } else {
      content.textContent = "同步保护时间已结束，正在确认最新比赛状态…";
    }
  }

  async function verifyPappSyncBeforeAdvance() {
    if (!LOCAL_SYNC_ENABLED) return;
    if (!(await persistCurrentStateToLocalService())) {
      throw new Error("当前比赛状态尚未保存，不能进入下一轮");
    }

    let status = await fetchLocalSyncState({
      force: true,
      showToast: false,
      pushIfEmpty: false,
    });
    if (!status) throw new Error("无法读取本地同步状态，不能进入下一轮");

    let waitMs = localSyncVerificationWaitMs(status);
    if (status.scriptWritePending !== true && waitMs <= 0) return;

    const content = document.createElement("div");
    content.setAttribute("role", "status");
    content.setAttribute("aria-live", "polite");
    updatePappVerificationDialog(content, waitMs);
    const dialogToken = showDialog({
      title: "正在检验 PAPP",
      contentNode: content,
      buttons: [],
      dismissible: false,
    });

    try {
      while (status.scriptWritePending === true || waitMs > 0) {
        const delayMs = waitMs > 0 ? Math.min(waitMs, 250) : 25;
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        status = await fetchLocalSyncState({
          force: true,
          showToast: false,
          pushIfEmpty: false,
        });
        if (!status) throw new Error("无法确认本地同步已经完成");
        waitMs = localSyncVerificationWaitMs(status);
        updatePappVerificationDialog(content, waitMs);
      }
    } finally {
      closeDialog({ force: true, token: dialogToken });
    }
  }

  function renderFinalRegistration(preliminaryResult, registration) {
    if (!finalRegistrationContent || !registration) return;
    const helper = ensureScoreHelper();
    const activeStage = registration.activeStage === "placement" ? "placement" : "semifinal";
    const rows = activeStage === "semifinal"
      ? registration.semifinalPairings
      : registration.placementPairings;
    const pairings = Array.isArray(rows) ? rows : [];
    const round = scoreStageRound(activeStage);
    const directFinal = activeStage === "placement" && skipsSemifinal();
    const title = activeStage === "semifinal" ? "半决赛" : directFinal ? "决赛" : "决赛与三四名赛";
    const startAt = registration[playoffRoundStartField(activeStage)];
    const progress = scorePairingsProgress(pairings);
    const qualifiers = Array.isArray(preliminaryResult && preliminaryResult.standings)
      ? preliminaryResult.standings.slice(0, 4)
      : [];
    const seedText = qualifiers.length
      ? `预赛前四：${qualifiers.map(formatPreliminaryQualifier).join("、")}；`
      : "";
    if (finalRegistrationSummary) {
      finalRegistrationSummary.textContent = pairings.length
        ? `${seedText}${title}第 ${round} 轮：配对 ${progress.total} 台；PAPP 已确认 ${progress.confirmed}/${progress.eligible}；黄色待写入 ${progress.ready}。`
        : `${seedText}${title}配对尚未生成。`;
    }
    if (finalRoundStartInput && document.activeElement !== finalRoundStartInput) {
      finalRoundStartInput.value = scoreRoundStartToInputValue(startAt);
    }
    renderScorePairings(pairings, {
      stage: activeStage,
      round,
      title,
      roundData: activeScoreRegistration("final-registration").roundData,
    }, finalRegistrationPairings);
    updateOqScorePollButton();
    setEgAnalysisButtonStatus(egAnalysisStatus || registration.eg && registration.eg[activeStage]);
    if (btnOpenOverallStandingsLabel) {
      btnOpenOverallStandingsLabel.textContent = activeStage === "semifinal"
        ? "生成决赛与三四名赛配对"
        : "查看最终排名";
    }
    updateScoreRegistrationControls();
  }

  function formatPreliminaryQualifier(player) {
    const rank = standingsNumber(player && player.rank);
    const name = normalizeWhitespace(player && player.displayName) || "未命名选手";
    return `${rank === null ? "名次待确认" : `第 ${Math.trunc(rank)} 名`} ${name}`;
  }

  function loadTournamentStageData(step) {
    const normalizedStep = normalizeTournamentStep(step || getCurrentStep());
    const sequence = ++tournamentStageLoadSequence;
    if (state.appMode !== "competition") return;
    if (normalizedStep === "final-registration") {
      void loadFinalRegistrationStage(sequence);
    }
  }

  async function loadFinalRegistrationStage(sequence) {
    setTournamentStageStatus(
      finalRegistrationStatus,
      finalRegistrationContent,
      "正在读取预赛排名并准备淘汰赛配对…",
      "loading",
    );
    try {
      const helper = ensureScoreHelper();
      const preliminaryRoundCount = helper.preliminaryRoundCount;
      const preliminaryResult = assertAdapterSuccess(
        await invokeTournamentAdapter("getPreliminaryStandings", {
          round: preliminaryRoundCount + 1,
          mode: "playoff-seeding",
        }),
        "PAPP 预赛排名读取失败",
      );
      if (!stageLoadIsCurrent(sequence, "final-registration")) return;

      const preliminaryPlayers = Array.isArray(preliminaryResult.standings)
        ? preliminaryResult.standings
        : [];
      if (!preliminaryPlayers.length) {
        setTournamentStageStatus(finalRegistrationStatus, finalRegistrationContent, "没有已签到选手可进入淘汰赛。", "empty");
        renderFinalRegistrationSummary(ensurePlayoffRegistration());
        renderScorePairings([], { stage: skipsSemifinal() ? "placement" : "semifinal", round: preliminaryRoundCount + 1, title: skipsSemifinal() ? "决赛" : "半决赛" }, finalRegistrationPairings);
        return;
      }
      if (!preliminaryResult.progress || preliminaryResult.progress.complete !== true) {
        setTournamentStageStatus(
          finalRegistrationStatus,
          finalRegistrationContent,
          skipsSemifinal() ? "预赛配对或比分尚未全部完成，暂不生成决赛。" : "预赛配对或比分尚未全部完成，暂不生成半决赛。",
          "warning",
        );
        renderFinalRegistrationSummary(ensurePlayoffRegistration());
        renderScorePairings([], { stage: skipsSemifinal() ? "placement" : "semifinal", round: preliminaryRoundCount + 1, title: skipsSemifinal() ? "决赛" : "半决赛" }, finalRegistrationPairings);
        return;
      }
      if (preliminaryResult.source !== "papp-c") {
        throw new Error("预赛排名不是由 PAPP C 返回");
      }
      storeStandingsSnapshot("preliminary", preliminaryRoundCount, preliminaryResult);
      if (preliminaryPlayers.length < 4) {
        setTournamentStageStatus(finalRegistrationStatus, finalRegistrationContent, "淘汰赛至少需要 4 名已签到选手。", "empty");
        renderFinalRegistrationSummary(ensurePlayoffRegistration(), preliminaryResult);
        renderScorePairings([], { stage: skipsSemifinal() ? "placement" : "semifinal", round: preliminaryRoundCount + 1, title: skipsSemifinal() ? "决赛" : "半决赛" }, finalRegistrationPairings);
        return;
      }

      let registration = ensurePlayoffRegistration();
      if (skipsSemifinal() && !registration.placementPairings.length) {
        const finalResult = await invokeTournamentAdapter("importPairings", {
          round: preliminaryRoundCount + 1,
          stage: "placement",
          mode: "advance-playoff-stage",
          roundData: { round: preliminaryRoundCount + 1, stage: "placement", pairings: [] },
        });
        if (!stageLoadIsCurrent(sequence, "final-registration")) return;
        if (finalResult && finalResult.ok === false) {
          throw new Error(adapterResultMessage(finalResult, "PAPP 决赛配对生成失败"));
        }
        if (finalResult.source !== "papp-c") throw new Error("决赛配对不是由 PAPP C 生成");
        const pairings = resultPairings(finalResult);
        if (!pairings.length) throw new Error("PAPP 适配器没有返回决赛配对");
        setPlayoffPairings(preliminaryRoundCount + 1, pairings, { stage: "placement" });
        registration = ensurePlayoffRegistration();
      } else if (!skipsSemifinal() && !registration.semifinalPairings.length) {
        const semifinalResult = await invokeTournamentAdapter("importPairings", {
          round: preliminaryRoundCount + 1,
          mode: "playoff-registration",
        });
        if (!stageLoadIsCurrent(sequence, "final-registration")) return;
        if (semifinalResult && semifinalResult.ok === false) {
          throw new Error(adapterResultMessage(semifinalResult, "PAPP 半决赛配对生成失败"));
        }
        const pairings = resultPairings(semifinalResult);
        if (!pairings.length) throw new Error("PAPP 适配器没有返回半决赛配对");
        setPlayoffPairings(preliminaryRoundCount + 1, pairings);
        registration = ensurePlayoffRegistration();
      }
      if (skipsSemifinal() && registration.activeStage !== "placement") {
        registration.activeStage = "placement";
        registration.updatedAt = now();
        state.playoffRegistration = registration;
        scheduleSave({ source: "script" });
      }

      if (!stageLoadIsCurrent(sequence, "final-registration")) return;
      renderFinalRegistration(preliminaryResult, registration);
      const activeStage = registration.activeStage === "placement" ? "placement" : "semifinal";
      const statusResult = assertAdapterSuccess(
        await invokeTournamentAdapter("getStageStatus", {
          stage: activeStage,
          round: scoreStageRound(activeStage),
        }),
        "PAPP 淘汰赛阶段状态读取失败",
      );
      if (statusResult.source !== "papp-c") throw new Error("淘汰赛阶段状态不是由 PAPP C 返回");
      const canAdvance = statusResult.canAdvance === true;
      const statusText = activeStage === "placement"
        ? canAdvance
          ? skipsSemifinal()
            ? "决赛比分已由 PAPP C 读回确认，可以生成最终排名。"
            : "决赛与三四名赛比分已由 PAPP C 读回确认，可以生成最终排名。"
          : skipsSemifinal()
            ? "预赛排名已确认；请完成决赛比分，并批量写入后等待 PAPP C 读回确认。"
            : "请完成决赛与三四名赛比分，并批量写入后等待 PAPP C 读回确认。"
        : canAdvance
          ? "半决赛比分已由 PAPP C 读回确认；可以生成决赛与三四名赛配对。"
          : `已生成 ${registration.semifinalPairings.length} 场半决赛；录入比分后按 Shift + Enter 批量写入。`;
      setTournamentStageStatus(
        finalRegistrationStatus,
        finalRegistrationContent,
        statusText,
        canAdvance ? "ok" : "idle",
      );
    } catch (error) {
      if (!stageLoadIsCurrent(sequence, "final-registration")) return;
      setTournamentStageStatus(
        finalRegistrationStatus,
        finalRegistrationContent,
        normalizeWhitespace(error && error.message) || "PAPP 决赛登记数据读取失败",
        "error",
      );
      renderFinalRegistrationSummary(ensurePlayoffRegistration());
      const fallbackStage = skipsSemifinal() ? "placement" : "semifinal";
      renderScorePairings([], { stage: fallbackStage, round: scoreStageRound(fallbackStage), title: skipsSemifinal() ? "决赛" : "半决赛" }, finalRegistrationPairings);
    }
  }

  async function advancePreliminaryRegistration() {
    if (scoreStageAdvanceInFlight) return;
    let current = activeScoreRegistration("score-helper");
    let helper = ensureScoreHelper();
    scoreStageAdvanceInFlight = true;
    setBtnBusy(btnOpenPreliminaryStandings, true, "正在生成下一轮…", "进入下一轮");
    updateScoreRegistrationControls();
    try {
      const stageStatus = assertAdapterSuccess(
        await invokeTournamentAdapter("getStageStatus", {
          stage: "preliminary",
          round: current.round,
        }),
        "PAPP C 预赛阶段状态读取失败",
      );
      if (stageStatus.source !== "papp-c") throw new Error("预赛阶段状态不是由 PAPP C 返回");
      if (stageStatus.canAdvance !== true) {
        const missingRounds = stageStatus.progress && Array.isArray(stageStatus.progress.missingRounds)
          ? stageStatus.progress.missingRounds
          : [];
        const message = missingRounds.length
          ? `第 ${missingRounds.join("、")} 轮配对尚未由 PAPP C 确认。`
          : "请完成本轮比分并等到 PAPP C 读回确认。";
        setScoreIntegrationStatus(message, "idle");
        showSnackbar(message, 2600);
        return;
      }
      const hasPlayoffs = hasSemifinalAndFinal();
      if (!(current.round === helper.preliminaryRoundCount && hasPlayoffs)) {
        try {
          await captureRoundStandingsSnapshot(current.round);
        } catch (error) {
          console.warn("本轮 PAPP C 排名快照暂未保存：", error);
          showSnackbar("本轮排名快照未保存，可稍后从右上角重新读取。", 3200);
        }
      }
      await verifyPappSyncBeforeAdvance();
      current = activeScoreRegistration("score-helper");
      helper = ensureScoreHelper();
      if (current.round >= helper.preliminaryRoundCount) {
        if (hasPlayoffs) navigateTournamentStep("final-registration");
        else openLiveStandings("overall");
        return;
      }

      const nextRound = current.round + 1;
      const nextRoundData = helper.rounds[nextRound - 1];
      if (!Array.isArray(nextRoundData.pairings) || !nextRoundData.pairings.length) {
        const withdrawalResult = await prepareRoundPairingImport(nextRound);
        const result = assertAdapterSuccess(
          await invokeTournamentAdapter("importPairings", {
            round: nextRound,
            stage: "preliminary",
            roundData: deepClone(nextRoundData),
            mode: "advance-preliminary-round",
          }),
          "PAPP 下一轮配对生成失败",
        );
        if (result.source !== "papp-c") throw new Error("新一轮配对不是由 PAPP C 生成");
        if (result.readOnly === true) throw new Error("旧版比赛历史为只读，不能作为新一轮 PAPP C 配对依据");
        const pairings = resultPairings(result);
        if (!pairings.length) throw new Error("PAPP 没有返回下一轮配对表");
        setRoundPairings(nextRound, pairings, { source: "papp-c" });
        const withdrawn = withdrawalResult.removedNames.length
          ? `；已执行计划退出 ${withdrawalResult.removedNames.join("、")}`
          : "";
        setScoreIntegrationStatus(`第 ${nextRound} 轮配对已生成，共 ${pairings.length} 台${withdrawn}。`, "ok");
      }
      // setRoundPairings may replace scoreHelper during sanitization; reacquire it.
      const activeHelper = ensureScoreHelper();
      activeHelper.activeRound = nextRound;
      activeHelper.updatedAt = now();
      navigateTournamentStep("score-helper");
      showSnackbar(`已进入第 ${nextRound} 轮`, 2000);
    } catch (error) {
      const message = normalizeWhitespace(error && error.message) || "生成下一轮配对失败";
      setScoreIntegrationStatus(message, "error");
      showAlert("生成下一轮配对失败", message);
    } finally {
      scoreStageAdvanceInFlight = false;
      setBtnBusy(btnOpenPreliminaryStandings, false, "正在生成下一轮…", "进入下一轮");
      renderScoreHelper();
    }
  }

  async function advanceFinalRegistration() {
    if (scoreStageAdvanceInFlight) return;
    let registration = ensurePlayoffRegistration();
    let stage = registration.activeStage === "placement" ? "placement" : "semifinal";
    let current = activeScoreRegistration("final-registration");
    let helper = ensureScoreHelper();
    scoreStageAdvanceInFlight = true;
    const busyLabel = stage === "placement" ? "正在读取最终排名…" : "正在生成决赛配对…";
    const readyLabel = stage === "placement" ? "查看最终排名" : "生成决赛与三四名赛配对";
    setBtnBusy(btnOpenOverallStandings, true, busyLabel, readyLabel);
    setTournamentStageStatus(
      finalRegistrationStatus,
      finalRegistrationContent,
      stage === "placement"
        ? skipsSemifinal() ? "正在读取决赛状态…" : "正在读取决赛与三四名赛状态…"
        : "半决赛比分已确认，正在生成决赛与三四名赛配对…",
      "loading",
    );
    updateScoreRegistrationControls();
    try {
      const stageStatus = assertAdapterSuccess(
        await invokeTournamentAdapter("getStageStatus", {
          stage: stage,
          round: current.round,
        }),
        "PAPP C 淘汰赛阶段状态读取失败",
      );
      if (stageStatus.source !== "papp-c") throw new Error("淘汰赛阶段状态不是由 PAPP C 返回");
      if (stageStatus.canAdvance !== true) {
        const message = stageStatus.code === "preliminary-results-incomplete"
          ? "预赛配对或比分尚未全部由 PAPP C 确认。"
          : stageStatus.code === "semifinal-results-incomplete"
            ? "请完成两场半决赛并等待 PAPP C 读回确认。"
            : stageStatus.code === "placement-results-incomplete"
              ? skipsSemifinal()
                ? "请完成决赛并等待 PAPP C 读回确认。"
                : "请完成决赛与三四名赛并等待 PAPP C 读回确认。"
              : "当前淘汰赛阶段尚不能推进，请检查 PAPP C 返回的阶段状态。";
        setTournamentStageStatus(finalRegistrationStatus, finalRegistrationContent, message, "warning");
        showSnackbar(message, 2600);
        return;
      }
      await verifyPappSyncBeforeAdvance();
      registration = ensurePlayoffRegistration();
      stage = registration.activeStage === "placement" ? "placement" : "semifinal";
      current = activeScoreRegistration("final-registration");
      helper = ensureScoreHelper();
      if (stage === "placement") {
        openLiveStandings("overall");
        return;
      }
      if (registration.placementPairings.length) {
        setActivePlayoffStage("placement");
        renderFinalRegistration(null, ensurePlayoffRegistration());
        scrollTournamentToTop();
        return;
      }

      const placementRound = scoreStageRound("placement");
      const result = assertAdapterSuccess(
        await invokeTournamentAdapter("importPairings", {
          round: placementRound,
          stage: "placement",
          mode: "advance-playoff-stage",
          roundData: { round: placementRound, stage: "placement", pairings: [] },
          semifinalPairings: deepClone(registration.semifinalPairings),
        }),
        "PAPP 决赛配对生成失败",
      );
      if (result.source !== "papp-c") throw new Error("决赛和三四名赛配对不是由 PAPP C 生成");
      if (result.readOnly === true) throw new Error("旧版淘汰赛记录为只读，不能转换为 PAPP C 配对");
      const pairings = resultPairings(result);
      if (!pairings.length) throw new Error("PAPP 没有返回决赛和三四名赛配对");
      setPlayoffPairings(placementRound, pairings, { stage: "placement" });
      const updated = ensurePlayoffRegistration();
      renderFinalRegistration(null, updated);
      setTournamentStageStatus(
        finalRegistrationStatus,
        finalRegistrationContent,
        `决赛与三四名赛配对已生成，共 ${pairings.length} 台；输入比分后按 Shift + Enter 批量写入。`,
        "ok",
      );
      showSnackbar("已生成决赛与三四名赛配对", 2200);
      scrollTournamentToTop();
    } catch (error) {
      const message = normalizeWhitespace(error && error.message) || "生成决赛配对失败";
      setTournamentStageStatus(finalRegistrationStatus, finalRegistrationContent, message, "error");
      showAlert("生成决赛配对失败", message);
    } finally {
      scoreStageAdvanceInFlight = false;
      setBtnBusy(btnOpenOverallStandings, false, busyLabel, readyLabel);
      renderFinalRegistration(null, ensurePlayoffRegistration());
      updateScoreRegistrationControls();
    }
  }

  function navigateTournamentStep(step) {
    if (!TOURNAMENT_STEP_IDS.includes(step)) return;
    state.step = normalizeTournamentStep(step);
    viewStepOverride = null;
    applyStepUI();
    updateProgressBar();
    if (state.step === "score-helper") renderScoreHelper();
    scheduleSave();
    loadTournamentStageData(state.step);
    scrollTournamentToTop();
  }

  function scrollTournamentToTop() {
    window.scrollTo(0, 0);
  }

  function showExportModal(options = {}) {
    if (!exportBackdrop) {
      showAlert("操作失败", "导出弹窗未正确加载，请刷新页面后重试。");
      return;
    }

    // Mainland China in-app browsers (WeChat/QQ/Weibo) often block downloads.
    const inApp = isLikelyInAppBrowser();
    const inAppName = getInAppBrowserName();
    if (exportInappTip) {
      exportInappTip.classList.toggle("hidden", !inApp);
      const sub = exportInappTip.querySelector(".export-inapp-tip__sub");
      if (sub && isElement(sub)) {
        sub.textContent = inApp
          ? `当前环境：${inAppName}内置浏览器。若“下载 CSV/PNG”失败，建议优先使用“复制文本”，或右上角菜单选择“在浏览器打开”。`
          : "若在微信/QQ/微博等内置浏览器中“下载 CSV/PNG”失败，建议使用“复制文本”，或右上角菜单选择“在浏览器打开”。";
      }
    }
    if (btnCopy) {
      btnCopy.classList.toggle("btn-tonal", inApp);
      btnCopy.classList.toggle("btn-outlined", !inApp);
      btnCopy.title = inApp ? "内置浏览器中推荐优先使用复制文本" : "复制文本";
    }
    if (btnDownloadPng) {
      btnDownloadPng.title = isIOS()
        ? "iPhone/iPad 会打开图片预览页，请长按图片保存到相册；快捷键：⌘/Ctrl + Shift + S"
        : "下载 PNG；快捷键：⌘/Ctrl + Shift + S";
    }
    if (inApp && safeLocalStorageGet(INAPP_EXPORT_TIP_KEY) !== "1") {
      showSnackbar(
        "当前是内置浏览器，建议优先使用“复制文本”导出。",
        3200,
        "不再提示",
        () => {
          safeLocalStorageSet(INAPP_EXPORT_TIP_KEY, "1");
        },
      );
    }

    exportBackdrop.classList.remove("hidden");
    if (options && options.focusPng && btnDownloadPng) {
      window.setTimeout(() => {
        try {
          btnDownloadPng.focus({ preventScroll: true });
        } catch (_) {
          try {
            btnDownloadPng.focus();
          } catch (e) {
            // ignore
          }
        }
      }, 0);
    }
  }

  function closeExportModal() {
    if (!exportBackdrop) return;
    exportBackdrop.classList.add("hidden");
  }

  function applyStepUI() {
    if (state.appMode !== "competition") {
      stepSchedule && stepSchedule.classList.add("hidden");
      stepImport && stepImport.classList.add("hidden");
      stepCheckin && stepCheckin.classList.add("hidden");
      stepScoreHelper && stepScoreHelper.classList.add("hidden");
      stepFinalRegistration && stepFinalRegistration.classList.add("hidden");
      return;
    }

    const step = getCurrentStep();
    stepSchedule && stepSchedule.classList.add("hidden");
    stepImport && stepImport.classList.add("hidden");
    stepCheckin && stepCheckin.classList.add("hidden");
    stepScoreHelper && stepScoreHelper.classList.add("hidden");
    stepFinalRegistration && stepFinalRegistration.classList.add("hidden");

    if (step === "schedule") {
      stepSchedule && stepSchedule.classList.remove("hidden");
    } else if (step === "checkin") {
      stepCheckin && stepCheckin.classList.remove("hidden");
    } else if (step === "score-helper") {
      stepScoreHelper && stepScoreHelper.classList.remove("hidden");
    } else if (step === "final-registration") {
      stepFinalRegistration && stepFinalRegistration.classList.remove("hidden");
    } else {
      stepImport && stepImport.classList.remove("hidden");
    }
  }

  function applyWorkspaceUI() {
    // The root page is the competition workspace. The portal page owns the
    // competition-management/player-investigation choice.
  }

  function chooseWorkspace(mode) {
    const nextMode = mode === "survey" ? "survey" : "competition";
    state.appMode = nextMode;
    if (
      nextMode === "competition" &&
      (!Array.isArray(state.players) || state.players.length === 0) &&
      !normalizeWhitespace(state.clubText || "") &&
      !normalizeWhitespace(state.relayText || "")
    ) {
      state.step = "schedule";
      viewStepOverride = null;
    }
    applyWorkspaceUI();
    applyStepUI();
    if (nextMode === "competition") {
      renderEventSchedule();
      updateProgressBar();
      if (getCurrentStep() === "checkin") refreshCheckinUI();
      loadTournamentStageData(getCurrentStep());
      showSnackbar("已进入比赛管理工作区", 1800);
    } else {
      updateProgressBar();
      showSnackbar("选手调查工作区保持独立，未改写其目录", 3200);
    }
    scheduleSave();
  }

  /*
   * The schedule page is deliberately kept as a local, deterministic form.
   * It only writes the same browser state as the roster/check-in workflow.
   */
  function ensureEventScheduleState() {
    state.eventSchedule = sanitizeEventSchedule(state.eventSchedule);
    return state.eventSchedule;
  }

  function ensureTournamentParametersState() {
    state.tournamentParameters = sanitizeTournamentParameters(
      state.tournamentParameters,
      state.players,
    );
    return state.tournamentParameters;
  }

  function hasSemifinalAndFinal() {
    return ensureTournamentParametersState().hasSemifinalAndFinal;
  }

  function skipsSemifinal() {
    const parameters = ensureTournamentParametersState();
    return parameters.hasSemifinalAndFinal && parameters.skipSemifinal === true;
  }

  function normalizeTournamentStep(step) {
    if (!hasSemifinalAndFinal() && step === "final-registration") return "score-helper";
    return step;
  }

  function visibleCompetitionSteps() {
    if (hasSemifinalAndFinal()) return COMPETITION_STEP_IDS;
    return COMPETITION_STEP_IDS.filter((step) => step !== "final-registration");
  }

  function updateTournamentStagePresentation() {
    const hasFinals = hasSemifinalAndFinal();
    const helper = ensureScoreHelper();
    const activeRound = Math.max(1, Math.min(helper.preliminaryRoundCount, helper.activeRound || 1));
    const hasNextPreliminaryRound = activeRound < helper.preliminaryRoundCount;
    const resultLabel = hasNextPreliminaryRound
      ? `进入第 ${activeRound + 1} 轮`
      : hasFinals
        ? "进入决赛登记"
        : "查看最终排名";

    if (btnOpenTournamentResultLabel) {
      btnOpenTournamentResultLabel.textContent = resultLabel;
    }
    if (scoreNextStageHint) {
      scoreNextStageHint.textContent = hasNextPreliminaryRound
        ? `第 ${activeRound} 轮的非 BYE 对局全部由 PAPP 读回确认后，生成第 ${activeRound + 1} 轮配对。`
        : hasFinals
          ? "预赛比分全部确认后，直接按 PAPP C 排名进入淘汰赛；各轮排名可从右上角查看。"
          : "最后一轮比分全部确认后，可从右上角查看 PAPP C 最终排名。";
    }
  }

  function normalizeWechatGroupOption(raw) {
    const option = sanitizeWechatGroupSelection(raw);
    if (!option.queryIndex) return null;
    return {
      ...option,
      displayName: option.displayName || option.queryIndex,
    };
  }

  function renderSelectedWechatGroup() {
    if (!scheduleChatSelected) return;
    const selection = ensureEventScheduleState().wechatGroup;
    if (!selection.queryIndex) {
      scheduleChatSelected.textContent = "尚未选择比赛群聊";
      return;
    }
    const displayName = selection.displayName || selection.queryIndex;
    scheduleChatSelected.textContent =
      `已选择：${displayName}（查询索引：${selection.queryIndex}）`;
  }

  function renderWechatGroupList(groups) {
    const seen = new Set();
    wechatGroupOptions = (Array.isArray(groups) ? groups : [])
      .map(normalizeWechatGroupOption)
      .filter((option) => {
        if (!option || seen.has(option.queryIndex)) return false;
        seen.add(option.queryIndex);
        return true;
      });

    if (!scheduleChatList) return;
    scheduleChatList.replaceChildren();
    if (!wechatGroupOptions.length) {
      scheduleChatList.hidden = true;
      return;
    }

    const selectedIndex = ensureEventScheduleState().wechatGroup.queryIndex;
    wechatGroupOptions.forEach((group) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "schedule-chat-option";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", group.queryIndex === selectedIndex ? "true" : "false");

      const name = document.createElement("strong");
      name.textContent = group.displayName;
      const index = document.createElement("span");
      index.textContent = group.queryIndex;
      button.append(name, index);
      button.addEventListener("click", () => selectWechatGroup(group));
      scheduleChatList.appendChild(button);
    });
    scheduleChatList.hidden = false;
    if (scheduleChatStatus) {
      scheduleChatStatus.textContent = `已读取 ${wechatGroupOptions.length} 个群聊，请点击选择。`;
    }
  }

  function setCompetitionName(value) {
    const name = normalizeWhitespace(value);
    if (!name) return false;
    state.competitionName = name;
    if (competitionTitleEl) competitionTitleEl.textContent = name;
    if (competitionNameInput) competitionNameInput.value = name;
    return true;
  }

  function setCompetitionNameFromWechatGroup(group) {
    return setCompetitionName(group && (group.displayName || group.queryIndex));
  }

  function selectWechatGroup(group) {
    const selection = normalizeWechatGroupOption(group);
    if (!selection) return;
    const schedule = ensureEventScheduleState();
    const previousSelection = schedule.wechatGroup;
    const previousIdentity = previousSelection.username || previousSelection.queryIndex;
    const nextIdentity = selection.username || selection.queryIndex;
    const groupChanged =
      previousSelection.queryIndex !== selection.queryIndex ||
      previousSelection.displayName !== selection.displayName ||
      previousSelection.username !== selection.username;
    schedule.wechatGroup = selection;
    const mapping = ensureMappingState();
    if (synchronizeMappingGroupToSelectedChat(mapping, selection)) {
      mapping.updatedAt = now();
      if (state.ui && state.ui.checkinView === "mapping") renderMappingTable();
    }
    if (groupChanged) setCompetitionNameFromWechatGroup(selection);
    if (groupChanged && ensureWechatAutoCheckinState().enabled) {
      ensureWechatAutoCheckinState().enabled = false;
      wechatAutoCheckinStatusText = "所选比赛群聊已更改，请重新开启自动签到。";
      updateWechatAutoCheckinUI({ notify: true });
    }
    const relaySync = ensureWechatRelaySyncState();
    if (previousIdentity !== nextIdentity) {
      relaySync.enabled = false;
      relaySync.ready = false;
      relaySync.groupUsername = "";
      relaySync.lastProcessedMessageId = "";
      relaySync.lastProcessedCreateTime = 0;
      relaySync.stopReason = "";
      clearWechatRelayReferenceContext(relaySync);
      stopWechatRelayPolling();
      latestWechatRelayMessage = null;
      latestWechatRelayGroupUsername = "";
      wechatRelayStatusText = "比赛群聊已更改，请在签到页重新开启实时同步。";

      if (relayInfoEl && relayInfoEl.value === wechatRelayReferenceAutoText) {
        relayInfoEl.value = "";
        if (state.relayText === wechatRelayReferenceAutoText) state.relayText = "";
      }
      pendingWechatRelayImport = null;
      wechatRelayReferenceAutoText = "";
      wechatRelayReferenceStatusText = "比赛群聊已更改，请重新引用聊天记录。";
    }
    renderSelectedWechatGroup();
    renderWechatGroupList(wechatGroupOptions);
    updateWechatRelaySyncUI();
    updateWechatAutoCheckinUI();
    updateWechatRelayReferenceUI();
    scheduleSave();
    resumeWechatRelayPolling();
    showSnackbar(`已选择比赛群聊：${selection.displayName}`, 2200);
  }

  function formatWechatDecryptStatus(status) {
    if (!status || status.ok !== true) return "无法读取本机解密状态。";
    const config = !status.configExists
      ? "未找到 config.json"
      : status.configValid === false
        ? "config.json 格式有误"
        : "配置已找到";
    const sourceDb = status.dbDirConfigured
      ? status.dbDirExists
        ? "微信源数据库目录已找到"
        : "微信源数据库目录不存在"
      : "尚未配置微信源数据库目录";
    const keys = status.keysFileExists ? "密钥文件已找到" : "尚未找到密钥文件";
    const contact = status.contactDbExists ? "contact.db 已找到" : "尚未找到 contact.db";
    const messages = `已解密消息库 ${Number(status.messageDbCount) || 0} 个`;
    const headline = status.contactReady
      ? "联系人数据库已准备好，可以读取群聊。"
      : "尚未完成微信数据库解密。";
    return `${headline}${config}；${sourceDb}；${keys}；${contact}；${messages}。`;
  }

  async function checkWechatDecryptStatus() {
    if (typeof fetch !== "function") {
      if (wechatDecryptStatus) {
        wechatDecryptStatus.textContent = "当前页面没有可用的本地服务连接。";
      }
      return;
    }

    setBtnBusy(btnCheckWechatDecryptStatus, true, "检查中…", "检查解密状态");
    if (wechatDecryptStatus) wechatDecryptStatus.textContent = "正在检查本机解密状态…";
    try {
      const response = await fetch(`/api/wechat-decrypt/status?t=${Date.now()}`, {
        cache: "no-store",
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      if (wechatDecryptStatus) wechatDecryptStatus.textContent = formatWechatDecryptStatus(result);
    } catch (error) {
      const detail = normalizeWhitespace(error && error.message ? error.message : error);
      if (wechatDecryptStatus) {
        wechatDecryptStatus.textContent =
          `无法检查解密状态：${detail || "请先启动 PAPP 本地服务"}`;
      }
    } finally {
      setBtnBusy(btnCheckWechatDecryptStatus, false, "检查中…", "检查解密状态");
    }
  }

  async function loadWechatGroups() {
    if (typeof fetch !== "function") {
      if (scheduleChatStatus) scheduleChatStatus.textContent = "当前页面没有可用的本地服务连接。";
      return;
    }

    setBtnBusy(btnLoadWechatGroups, true, "读取中…", "读取微信群聊");
    if (scheduleChatStatus) scheduleChatStatus.textContent = "正在读取本机微信群聊…";
    try {
      const response = await fetch(`/api/wechat-groups?t=${Date.now()}`, {
        cache: "no-store",
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      renderWechatGroupList(result.groups);
      if (scheduleChatStatus && !wechatGroupOptions.length) {
        scheduleChatStatus.textContent = "未找到可用群聊，请先完成微信数据库解密或设置 PAPP_WECHAT_CONTACT_DB。";
      }
    } catch (error) {
      wechatGroupOptions = [];
      if (scheduleChatList) {
        scheduleChatList.replaceChildren();
        scheduleChatList.hidden = true;
      }
      const detail = normalizeWhitespace(error && error.message ? error.message : error);
      const message = detail.includes("contact.db") || detail.includes("解密")
        ? "本机尚未准备好已解密的微信联系人数据库，请先完成解密后再读取。"
        : `读取微信群聊失败：${detail || "本地服务不可用"}`;
      if (scheduleChatStatus) scheduleChatStatus.textContent = message;
      showSnackbar(message, 3600);
      void checkWechatDecryptStatus();
    } finally {
      setBtnBusy(btnLoadWechatGroups, false, "读取中…", "读取微信群聊");
    }
  }

  function ensureWechatRelaySyncState() {
    state.wechatRelaySync = sanitizeWechatRelaySync(state.wechatRelaySync);
    return state.wechatRelaySync;
  }

  function ensureWechatAutoCheckinState() {
    state.wechatAutoCheckin = sanitizeWechatAutoCheckin(state.wechatAutoCheckin);
    return state.wechatAutoCheckin;
  }

  function clearWechatRelayReferenceContext(sync = ensureWechatRelaySyncState()) {
    sync.referenceMessageId = "";
    sync.referenceCreateTime = 0;
    sync.referenceGroupUsername = "";
    sync.referenceDeadlineMs = 0;
  }

  function restoreWechatRelayReferenceContext() {
    const sync = ensureWechatRelaySyncState();
    const groupUsername = wechatRelayGroupIdentity();
    if (pendingWechatRelayImport) {
      const pendingStillMatches =
        pendingWechatRelayImport.groupUsername === groupUsername &&
        pendingWechatRelayImport.deadlineMs === relaySyncDeadlineMs() &&
        String(relayInfoEl && relayInfoEl.value || "") ===
          String(pendingWechatRelayImport.message.content || "");
      if (pendingStillMatches) return;
      pendingWechatRelayImport = null;
      wechatRelayReferenceAutoText = "";
    }
    if (
      !state.relayText ||
      !sync.referenceMessageId ||
      !sync.referenceCreateTime ||
      !sync.referenceGroupUsername ||
      !sync.referenceDeadlineMs
    ) {
      wechatRelayReferenceAutoText = "";
      return;
    }
    if (sync.referenceGroupUsername !== groupUsername) {
      clearWechatRelayReferenceContext(sync);
      return;
    }
    const message = {
      messageId: sync.referenceMessageId,
      createTime: sync.referenceCreateTime,
      content: String(state.relayText),
    };
    wechatRelayReferenceAutoText = String(state.relayText);
    pendingWechatRelayImport = {
      message: { ...message },
      groupUsername,
      deadlineMs: sync.referenceDeadlineMs,
    };
    wechatRelayReferenceStatusText = "已恢复先前引用的接龙原文；核对后点击现有导入按钮继续。";
  }

  function selectedWechatRelayGroup() {
    return ensureEventScheduleState().wechatGroup;
  }

  function wechatRelayGroupIdentity(group = selectedWechatRelayGroup()) {
    return String(group && (group.username || group.queryIndex) || "");
  }

  function wechatMessageTimestampMs(message) {
    const value = Number(message && message.createTime);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value > 1e12 ? value : value * 1000;
  }

  function anyWechatMessageAfterDeadline(messages, deadlineMs) {
    const deadline = Number(deadlineMs);
    if (!Number.isFinite(deadline)) return false;
    const newestMessageTime = (Array.isArray(messages) ? messages : []).reduce(
      (newest, message) => Math.max(newest, wechatMessageTimestampMs(message)),
      0,
    );
    return newestMessageTime > deadline + 60_000;
  }

  function formatWechatMessageTimestamp(message) {
    const timestamp = wechatMessageTimestampMs(message);
    if (!timestamp) return "—";
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
  }

  const AUTO_CHECKIN_POLL_INTERVAL_MS = 10_000;
  const AUTO_CHECKIN_LEAD_MS = 5 * 60_000;
  const AUTO_CHECKIN_TRAIL_MS = 60_000;
  const AUTO_CHECKIN_TOKENS = new Set(["1", "2", "111", "222"]);
  const AUTO_CHECKIN_NEWCOMER_TOKENS = new Set(["2", "222"]);
  const AUTO_CHECKIN_PENDING_KEYWORDS = Object.freeze([
    "请假",
    "请个假",
    "缺席",
    "缺赛",
    "不能来",
    "来不了",
    "去不了",
    "无法参加",
    "没法参加",
    "无法参赛",
    "不能参赛",
    "赶不过来",
    "到不了",
    "临时有事",
    "有事不能来",
    "不能出席",
    "不出席",
    "无法到场",
    "不能到场",
    "没法来",
    "不方便参加",
    "不能参加",
    "不参加",
    "不来",
    "弃赛",
    "退赛",
    "退出比赛",
    "取消报名",
    "不参加了",
    "不参赛",
    "不比了",
    "不打了",
    "放弃比赛",
    "可能来不了",
    "可能缺席",
    "还不确定",
    "不确定能否参加",
    "不确定能不能来",
    "暂时不确定",
    "迟到",
    "可能迟到",
    "晚到",
    "晚点到",
    "提前离场",
    "不签到",
    "只能参加部分轮次",
  ].sort((left, right) => right.length - left.length));

  function normalizeAutoCheckinToken(content) {
    return String(content || "")
      .normalize("NFKC")
      .trim()
      .replace(/^[\s.,!?;:，。！？；：、~～…—–\-()[\]{}“”‘’"'`]+|[\s.,!?;:，。！？；：、~～…—–\-()[\]{}“”‘’"'`]+$/g, "")
      .trim();
  }

  function classifyWechatAutoCheckinMessage(message) {
    if (!message || typeof message !== "object") return null;
    if (message.type != null && Number(message.type) !== 1) return null;
    const content = normalizeWhitespace(message.content);
    if (!content) return null;
    const keyword = AUTO_CHECKIN_PENDING_KEYWORDS.find((word) => content.includes(word));
    if (keyword) return { kind: "keyword", keyword };
    const token = normalizeAutoCheckinToken(content);
    return AUTO_CHECKIN_TOKENS.has(token) ? { kind: "checkin", token } : null;
  }

  function isWechatAutoCheckinMessageInWindow(timestampMs, startMs, deadlineMs) {
    const timestamp = Number(timestampMs);
    const start = Number(startMs);
    const deadline = Number(deadlineMs);
    return (
      Number.isFinite(timestamp) &&
      Number.isFinite(start) &&
      Number.isFinite(deadline) &&
      timestamp >= start - AUTO_CHECKIN_LEAD_MS &&
      timestamp <= deadline + AUTO_CHECKIN_TRAIL_MS
    );
  }

  function autoCheckinMappingGroupMatches(mapping, selectedGroupName) {
    const mappingGroup = normalizeMappingNameKey(mapping && mapping.groupName);
    const selectedGroup = normalizeMappingNameKey(selectedGroupName);
    return Boolean(mappingGroup && selectedGroup && mappingGroup === selectedGroup);
  }

  function isWechatAutoCheckinMappingComplete(mapping, rosterPlayers, selectedGroupName) {
    const players = Array.isArray(rosterPlayers) ? rosterPlayers : [];
    const rows = Array.isArray(mapping && mapping.rows) ? mapping.rows : [];
    if (!players.length || !autoCheckinMappingGroupMatches(mapping, selectedGroupName)) return false;

    const nickCounts = new Map();
    rows.forEach((row) => {
      const key = normalizeMappingNameKey(row && row.wechatNick);
      if (key) nickCounts.set(key, (nickCounts.get(key) || 0) + 1);
    });

    return players.every((player) => {
      const playerId = mappingTextId(player && player.id);
      if (!playerId) return false;
      const linkedRows = rows.filter(
        (row) => mappingTextId(row && row.checkinPlayerId) === playerId,
      );
      if (linkedRows.length !== 1) return false;
      const registrationKey = normalizeMappingNameKey(linkedRows[0].registrationNick);
      const playerNameKey = normalizeMappingNameKey(player.displayName || player.name);
      if (!registrationKey || registrationKey !== playerNameKey) return false;
      const nickKey = normalizeMappingNameKey(linkedRows[0].wechatNick);
      return Boolean(nickKey && nickCounts.get(nickKey) === 1);
    });
  }

  function resolveWechatAutoCheckinPlayer(senderGroupNick, mapping, rosterPlayers, selectedGroupName) {
    if (!autoCheckinMappingGroupMatches(mapping, selectedGroupName)) {
      return { status: "unmatched", player: null };
    }
    const nickKey = normalizeMappingNameKey(senderGroupNick);
    if (!nickKey) return { status: "unmatched", player: null };
    const rows = (Array.isArray(mapping && mapping.rows) ? mapping.rows : []).filter(
      (row) => normalizeMappingNameKey(row && row.wechatNick) === nickKey,
    );
    if (rows.length !== 1) {
      return { status: rows.length > 1 ? "ambiguous" : "unmatched", player: null };
    }
    const playerId = mappingTextId(rows[0].checkinPlayerId);
    const linkedPlayers = (Array.isArray(rosterPlayers) ? rosterPlayers : []).filter(
      (player) => mappingTextId(player && player.id) === playerId,
    );
    return linkedPlayers.length === 1
      ? { status: "matched", player: linkedPlayers[0] }
      : { status: linkedPlayers.length ? "ambiguous" : "unmatched", player: null };
  }

  function reconcileWechatAutoCheckinMessages(options = {}) {
    const autoCheckin = options.autoCheckin && typeof options.autoCheckin === "object"
      ? options.autoCheckin
      : createDefaultWechatAutoCheckin();
    const items = (Array.isArray(autoCheckin.items) ? autoCheckin.items : []).map((item) => ({ ...item }));
    const players = Array.isArray(options.rosterPlayers) ? options.rosterPlayers : [];
    const mapping = options.mapping && typeof options.mapping === "object" ? options.mapping : {};
    const groupUsername = normalizeWhitespace(options.groupUsername);
    const selectedGroupName = normalizeWhitespace(options.selectedGroupName);
    const startMs = Number(options.checkinStartMs);
    const deadlineMs = Number(options.checkinDeadlineMs);
    const nowMs = Number(options.nowMs) || Date.now();
    const scopeKey = `${groupUsername}|${Math.trunc(startMs)}|${Math.trunc(deadlineMs)}`;
    const mappingComplete = isWechatAutoCheckinMappingComplete(
      mapping,
      players,
      selectedGroupName,
    );
    const itemIndex = new Map(items.map((item, index) => [item.id, index]));
    const messages = (Array.isArray(options.messages) ? options.messages : [])
      .filter((message) => message && typeof message === "object" && normalizeWhitespace(message.messageId))
      .slice()
      .sort((left, right) => wechatMessageTimestampMs(left) - wechatMessageTimestampMs(right));
    let changed = false;

    for (const message of messages) {
      const timestampMs = wechatMessageTimestampMs(message);
      if (!isWechatAutoCheckinMessageInWindow(timestampMs, startMs, deadlineMs)) continue;
      const classification = classifyWechatAutoCheckinMessage(message);
      if (!classification) continue;

      const messageId = normalizeWhitespace(message.messageId).slice(0, 500);
      const itemId = `${scopeKey}|${messageId}`.slice(0, 1200);
      const existingIndex = itemIndex.get(itemId);
      const existing = existingIndex == null ? null : items[existingIndex];
      if (existing && existing.status !== "pending") continue;

      const senderGroupNick = normalizeWhitespace(message.senderGroupNick);
      const match = resolveWechatAutoCheckinPlayer(
        senderGroupNick,
        mapping,
        players,
        selectedGroupName,
      );
      const player = match.status === "matched" ? match.player : null;
      const item = existing ? { ...existing } : {
        id: itemId,
        messageId,
        scopeKey,
        groupUsername,
        createTime: Math.trunc(Number(message.createTime) || timestampMs / 1000),
        senderUsername: normalizeWhitespace(message.senderUsername),
        senderGroupNick,
        senderDisplayName: normalizeWhitespace(message.senderDisplayName),
        content: String(message.content || "").slice(0, 4000),
        kind: classification.kind,
        pendingKind: "",
        keyword: "",
        playerId: "",
        playerName: "",
        status: "pending",
        resolvedBy: "",
        resolvedAt: 0,
      };
      let itemChanged = !existing;
      item.senderUsername = normalizeWhitespace(message.senderUsername) || item.senderUsername;
      item.senderGroupNick = senderGroupNick || item.senderGroupNick;
      item.senderDisplayName = normalizeWhitespace(message.senderDisplayName) || item.senderDisplayName;
      item.content = String(message.content || item.content || "").slice(0, 4000);

      if (classification.kind === "keyword") {
        item.kind = "keyword";
        item.pendingKind = "attendance-keyword";
        item.keyword = classification.keyword;
        item.status = "pending";
        if (player) {
          item.playerId = mappingTextId(player.id);
          item.playerName = normalizeWhitespace(player.displayName);
        }
      } else if (player) {
        const alreadyCheckedIn = Boolean(player.checkedIn);
        if (AUTO_CHECKIN_NEWCOMER_TOKENS.has(classification.token)) {
          player.isNew = true;
        }
        if (!alreadyCheckedIn) {
          player.checkedIn = true;
          player.checkedInAt = timestampMs;
        }
        item.kind = "checkin";
        item.pendingKind = "";
        item.keyword = "";
        item.playerId = mappingTextId(player.id);
        item.playerName = normalizeWhitespace(player.displayName);
        item.status = alreadyCheckedIn ? "already-checked-in" : "auto-checked-in";
        item.resolvedBy = "script";
        item.resolvedAt = nowMs;
      } else if (mappingComplete) {
        if (!existing) continue;
        item.status = "auto-ignored";
        item.resolvedBy = "script";
        item.resolvedAt = nowMs;
      } else {
        item.kind = "checkin";
        item.pendingKind = "unmapped-checkin";
        item.keyword = "";
        item.playerId = "";
        item.playerName = "";
        item.status = "pending";
      }

      if (itemChanged || JSON.stringify(existing) !== JSON.stringify(item)) {
        if (existingIndex == null) {
          itemIndex.set(itemId, items.length);
          items.push(item);
        } else {
          items[existingIndex] = item;
        }
        changed = true;
      }
    }

    return { items, changed, mappingComplete };
  }

  function wechatRelayMatchesEventMonth(message, eventMonth, eventYear) {
    const expectedMonth = Number(eventMonth);
    if (!Number.isInteger(expectedMonth) || expectedMonth < 1 || expectedMonth > 12) {
      return true;
    }
    const timestamp = wechatMessageTimestampMs(message);
    if (!timestamp) return false;
    const sentAt = new Date(timestamp);
    if (sentAt.getMonth() + 1 !== expectedMonth) return false;

    const expectedYear = Number(eventYear);
    return !Number.isInteger(expectedYear) || expectedYear < 1 || sentAt.getFullYear() === expectedYear;
  }

  function currentWechatRelayEventDateParts() {
    const schedule = ensureEventScheduleState();
    const dateValues = [schedule.competitionStart, schedule.checkinDeadline];
    for (const value of dateValues) {
      const match = String(value || "").match(/^(\d{4})-(\d{1,2})-/);
      if (!match) continue;
      const year = Number(match[1]);
      const month = Number(match[2]);
      if (year >= 1 && month >= 1 && month <= 12) return { year, month };
    }
    return { year: 0, month: 0 };
  }

  function currentWechatRelayEventMonth() {
    return currentWechatRelayEventDateParts().month;
  }

  function wechatRelayMonthUnixRange(anchorValue, fallbackDate = new Date()) {
    const anchor = normalizeEventScheduleValue(anchorValue);
    const match = anchor.match(/^(\d{4})-(\d{2})-/);
    const fallback = fallbackDate instanceof Date ? fallbackDate : new Date(fallbackDate);
    const year = match ? Number(match[1]) : fallback.getFullYear();
    const month = match ? Number(match[2]) : fallback.getMonth() + 1;
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error("无法确定接龙历史查询月份");
    }
    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const nextMonth = new Date(year, month, 1, 0, 0, 0, 0);
    return {
      startTime: Math.floor(start.getTime() / 1000),
      endTime: Math.floor(nextMonth.getTime() / 1000) - 1,
    };
  }

  function currentWechatRelayHistoryRange() {
    const schedule = ensureEventScheduleState();
    const anchor = [
      schedule.competitionStart,
      schedule.checkinDeadline,
      schedule.checkinStart,
      schedule.registrationDeadline,
    ].find(Boolean) || "";
    return wechatRelayMonthUnixRange(anchor);
  }

  function isWechatRelayTemplateContent(content) {
    const text = String(content || "").replace(/^\uFEFF/, "");
    if (!text) return false;

    const lines = text.split(/\r?\n/);
    const firstNonemptyIndex = lines.findIndex((line) => normalizeWhitespace(line));
    const firstLine = firstNonemptyIndex >= 0
      ? normalizeWhitespace(lines[firstNonemptyIndex])
      : "";
    if (
      firstNonemptyIndex >= 0 &&
      /^#\s*接[龙龍](?:\s|$)/.test(firstLine)
    ) {
      let expectedNumber = 1;
      let currentRun = 0;
      let longestRun = 0;
      for (const line of lines.slice(firstNonemptyIndex + 1)) {
        if (!normalizeWhitespace(line)) continue;
        const match = String(line).match(/^\s*([0-9０-９]{1,3})\s*[.．、)）\]］]\s*\S/);
        if (!match) {
          expectedNumber = 1;
          currentRun = 0;
          continue;
        }

        const number = Number(
          match[1].replace(/[０-９]/g, (digit) =>
            String.fromCharCode(digit.charCodeAt(0) - 0xFEE0),
          ),
        );
        if (number === expectedNumber) {
          currentRun += 1;
          expectedNumber += 1;
        } else if (number === 1) {
          currentRun = 1;
          expectedNumber = 2;
        } else {
          currentRun = 0;
          expectedNumber = 1;
        }
        longestRun = Math.max(longestRun, currentRun);
      }
      if (longestRun >= 2) return true;
    }

    if (!/报名接[龙龍]/.test(text)) return false;
    try {
      return parseImportTextsDetailed("", text).players.length > 0;
    } catch (_) {
      return false;
    }
  }

  function isWechatRelayTemplateMessage(message) {
    const content = String(message && message.content || "");
    return Boolean(content && isWechatRelayTemplateContent(content));
  }

  function latestWechatRelayFromMessages(
    messages,
    eventMonth = currentWechatRelayEventMonth(),
    eventYear = currentWechatRelayEventDateParts().year,
  ) {
    return (Array.isArray(messages) ? messages : [])
      .filter(isWechatRelayTemplateMessage)
      .filter((message) =>
        wechatRelayMatchesEventMonth(message, eventMonth, eventYear),
      )
      .sort((left, right) => wechatMessageTimestampMs(right) - wechatMessageTimestampMs(left))[0] || null;
  }

  function updateWechatRelayReferenceUI() {
    if (wechatRelayReferenceStatus) {
      wechatRelayReferenceStatus.textContent =
        wechatRelayReferenceStatusText ||
        "从所选群聊中查找微信发送月份与比赛参数月份一致、且不晚于签到截止时间的接龙。";
    }
  }

  function showWechatStatusToast(message) {
    const text = String(message || "").trim();
    if (!text || text === "未启用") return;
    showSnackbar(text, 3000);
  }

  function updateWechatRelaySyncUI({ notify = false } = {}) {
    const sync = ensureWechatRelaySyncState();
    if (btnWechatRelaySync) {
      btnWechatRelaySync.classList.toggle("btn-tonal--active", sync.enabled);
      btnWechatRelaySync.setAttribute("aria-pressed", String(sync.enabled));
      btnWechatRelaySync.title = sync.enabled ? "关闭接龙轮询" : "开启接龙轮询";
      btnWechatRelaySync.disabled = apOwnsAutomation();
      if (apOwnsAutomation()) btnWechatRelaySync.title = "AP 正在管理接龙刷新";
    }
    const statusText =
      wechatRelayStatusText ||
      (sync.stopReason === "deadline"
        ? "已到签到截止时间，实时同步已停止。"
        : sync.enabled
          ? "等待读取所选群聊…"
          : "未启用");
    if (notify) showWechatStatusToast(statusText);
  }

  function renderWechatAutoCheckinPending() {
    if (!wechatAutoCheckinPendingPanel || !wechatAutoCheckinPendingList) return;
    const autoCheckin = sanitizeWechatAutoCheckin(state.wechatAutoCheckin);
    const pending = autoCheckin.items
      .filter((item) => item.status === "pending")
      .sort((left, right) => Number(right.createTime) - Number(left.createTime));
    wechatAutoCheckinPendingPanel.hidden = pending.length === 0;
    if (wechatAutoCheckinPendingCount) {
      wechatAutoCheckinPendingCount.textContent = String(pending.length);
    }
    wechatAutoCheckinPendingList.innerHTML = pending
      .map((item) => {
        const player = (Array.isArray(state.players) ? state.players : []).find(
          (candidate) => mappingTextId(candidate && candidate.id) === item.playerId,
        );
        const sender = item.senderGroupNick || item.senderDisplayName || item.senderUsername || "未知发送者";
        const when = formatWechatMessageTimestamp({ createTime: item.createTime });
        const reason = item.pendingKind === "attendance-keyword"
          ? `需要确认：${item.keyword || "请假/退赛相关信息"}`
          : "签到消息尚未匹配到唯一选手";
        const candidate = player || item.playerName
          ? ` · 可能选手：${escapeHtml(player ? player.displayName : item.playerName)}`
          : "";
        const message = escapeHtml(item.content).replace(/\r?\n/g, "<br>");
        return `
          <article class="wechat-auto-checkin-pending__item" data-auto-checkin-pending-id="${escapeHtml(item.id)}">
            <div class="wechat-auto-checkin-pending__details">
              <div class="wechat-auto-checkin-pending__meta">${escapeHtml(when)} · ${escapeHtml(sender)} · ${escapeHtml(reason)}${candidate}</div>
              <div class="wechat-auto-checkin-pending__message">${message}</div>
            </div>
            <div class="wechat-auto-checkin-pending__actions">
              <button class="btn btn-outlined" type="button" data-auto-checkin-pending-action="ignore" data-auto-checkin-pending-id="${escapeHtml(item.id)}">忽略</button>
              <button class="btn btn-tonal" type="button" data-auto-checkin-pending-action="solved" data-auto-checkin-pending-id="${escapeHtml(item.id)}" title="请先手动完成签到表或映射表处理">已解决</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function updateWechatAutoCheckinUI({ notify = false } = {}) {
    const autoCheckin = sanitizeWechatAutoCheckin(state.wechatAutoCheckin);
    if (btnWechatAutoCheckin) {
      btnWechatAutoCheckin.classList.toggle("btn-tonal--active", autoCheckin.enabled);
      btnWechatAutoCheckin.setAttribute("aria-pressed", String(autoCheckin.enabled));
      btnWechatAutoCheckin.title = autoCheckin.enabled ? "关闭自动签到" : "开启自动签到";
      btnWechatAutoCheckin.disabled = apOwnsAutomation();
      if (apOwnsAutomation()) btnWechatAutoCheckin.title = "AP 正在管理自动签到";
    }
    const pendingCount = autoCheckin.items.filter((item) => item.status === "pending").length;
    const statusText = wechatAutoCheckinStatusText || (autoCheckin.enabled
      ? `自动签到已开启，每 10 秒复查签到时间窗；待处理 ${pendingCount} 项。`
      : "未启用");
    if (notify) showWechatStatusToast(statusText);
    renderWechatAutoCheckinPending();
  }

  function setWechatAutoCheckinPendingStatus(itemId, status) {
    const safeStatus = status === "ignored" ? "ignored" : status === "solved" ? "solved" : "";
    if (!safeStatus) return false;
    const autoCheckin = ensureWechatAutoCheckinState();
    const item = autoCheckin.items.find(
      (entry) => entry.id === itemId && entry.status === "pending",
    );
    if (!item) return false;
    item.status = safeStatus;
    item.resolvedBy = "human";
    item.resolvedAt = now();
    wechatAutoCheckinStatusText = safeStatus === "ignored"
      ? "已忽略该 pending；自动签到不会处理这条消息。"
      : "已标记为解决；请在签到表或映射表中手动完成的处理已保留。";
    updateWechatAutoCheckinUI({ notify: true });
    scheduleSave();
    return true;
  }

  function stopWechatRelayPolling() {
    if (wechatRelayPollTimer) window.clearInterval(wechatRelayPollTimer);
    wechatRelayPollTimer = null;
  }

  function stopWechatRelayForDeadline() {
    const sync = ensureWechatRelaySyncState();
    sync.enabled = false;
    sync.stopReason = "deadline";
    wechatRelayStatusText = "群聊最新消息的微信时间已超过签到截至时间 1 分钟，实时同步已停止。";
    updateWechatRelaySyncUI({ notify: true });
    scheduleSave({ source: "script" });
    resumeWechatRelayPolling();
  }

  function stopWechatRelayForConfiguration(message) {
    const sync = ensureWechatRelaySyncState();
    sync.enabled = false;
    wechatRelayStatusText = String(message || "请检查比赛群聊和签到截至时间设置。");
    updateWechatRelaySyncUI({ notify: true });
    scheduleSave({ source: "script" });
    resumeWechatRelayPolling();
  }

  async function fetchWechatRelayMessages(
    offset = 0,
    limit = 200,
    groupQuery = "",
    startTime = null,
    endTime = null,
    relayOnly = false,
  ) {
    const group = selectedWechatRelayGroup();
    const queryIndex = groupQuery || group.username || group.queryIndex;
    if (!queryIndex) throw new Error("请先在 AP 参数中选择比赛群聊。");
    const params = new URLSearchParams({
      group: queryIndex,
      limit: String(limit),
      offset: String(offset),
      t: String(Date.now()),
    });
    if (Number.isFinite(startTime)) params.set("startTime", String(Math.trunc(startTime)));
    if (Number.isFinite(endTime)) params.set("endTime", String(Math.trunc(endTime)));
    if (relayOnly) params.set("relayOnly", "true");
    const response = await fetch(
      `/api/wechat-chat-messages?${params.toString()}`,
      { cache: "no-store" },
    );
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) {
      throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
    }
    return result;
  }

  async function fetchAllWechatMessagesInTimeRange(
    groupQuery,
    startTime,
    endTime,
    { relayOnly = false } = {},
  ) {
    const pageSize = 2000;
    const maxOffset = relayOnly ? 1_000_000 : 10_000;
    const messages = [];
    const seen = new Set();
    for (let offset = 0; offset <= maxOffset; offset += pageSize) {
      const result = await fetchWechatRelayMessages(
        offset,
        pageSize,
        groupQuery,
        startTime,
        endTime,
        relayOnly,
      );
      const page = Array.isArray(result.messages) ? result.messages : [];
      page.forEach((message) => {
        const messageId = normalizeWhitespace(message && message.messageId);
        if (!messageId || seen.has(messageId)) return;
        seen.add(messageId);
        messages.push(message);
      });
      if (page.length < pageSize) return messages;
      if (offset === maxOffset) {
        throw new Error(
          relayOnly
            ? "本月接龙记录超过读取上限，无法完成全量映射。"
            : "签到时间窗内消息超过读取上限，无法完成全量复查。",
        );
      }
    }
    return messages;
  }

  function relaySyncDeadlineMs() {
    const value = normalizeEventScheduleValue(
      ensureEventScheduleState().checkinDeadline,
    );
    return value ? Date.parse(value) : NaN;
  }

  function relaySyncDeadlineSeconds() {
    const deadlineMs = relaySyncDeadlineMs();
    return Number.isFinite(deadlineMs) ? Math.floor(deadlineMs / 1000) : NaN;
  }

  function checkinStartMs() {
    const value = normalizeEventScheduleValue(ensureEventScheduleState().checkinStart);
    return value ? Date.parse(value) : NaN;
  }

  function stopWechatAutoCheckinForConfiguration(message) {
    const autoCheckin = ensureWechatAutoCheckinState();
    if (!autoCheckin.enabled) return;
    autoCheckin.enabled = false;
    wechatAutoCheckinStatusText = String(message || "请检查比赛群聊和签到时间设置。");
    updateWechatAutoCheckinUI({ notify: true });
    scheduleSave({ source: "script" });
    resumeWechatRelayPolling();
  }

  async function setWechatAutoCheckinEnabled(enabled) {
    if (apOwnsAutomation()) return showSnackbar("AP 正在管理自动签到，请在 AP 面板操作", 2600);
    const autoCheckin = ensureWechatAutoCheckinState();
    lastWechatAutoCheckinPollingErrorText = "";
    if (!enabled) {
      autoCheckin.enabled = false;
      wechatAutoCheckinStatusText = "自动签到已关闭。";
      scheduleSave();
      updateWechatAutoCheckinUI({ notify: true });
      resumeWechatRelayPolling();
      return;
    }

    if (!Array.isArray(state.players) || state.players.length === 0) {
      autoCheckin.enabled = false;
      wechatAutoCheckinStatusText = "请先确认导入并开始签到，再开启自动签到。";
      updateWechatAutoCheckinUI({ notify: true });
      return;
    }
    if (!LOCAL_SYNC_ENABLED) {
      autoCheckin.enabled = false;
      wechatAutoCheckinStatusText = "自动签到需要通过 PAPP 本地启动器打开页面。";
      updateWechatAutoCheckinUI({ notify: true });
      return;
    }
    const username = wechatRelayGroupIdentity();
    if (!username) {
      autoCheckin.enabled = false;
      wechatAutoCheckinStatusText = "请先在 AP 参数中选择比赛群聊。";
      updateWechatAutoCheckinUI({ notify: true });
      return;
    }
    const startMs = checkinStartMs();
    const deadlineMs = relaySyncDeadlineMs();
    if (!Number.isFinite(startMs) || !Number.isFinite(deadlineMs) || startMs > deadlineMs) {
      autoCheckin.enabled = false;
      wechatAutoCheckinStatusText = "请设置有效的签到开始时间和签到截至时间。";
      updateWechatAutoCheckinUI({ notify: true });
      return;
    }

    autoCheckin.enabled = true;
    autoCheckin.groupUsername = username;
    wechatAutoCheckinStatusText = "自动签到已开启，正在复查签到前 5 分钟至当前时间的聊天记录…";
    scheduleSave();
    updateWechatAutoCheckinUI({ notify: true });
    resumeWechatRelayPolling();
  }

  async function checkWechatAutoCheckinMessages(groupUsername, deadlineMs) {
    if (apOwnsAutomation()) return;
    const autoCheckin = ensureWechatAutoCheckinState();
    if (!autoCheckin.enabled) return;
    if (autoCheckin.groupUsername !== groupUsername) {
      stopWechatAutoCheckinForConfiguration("所选比赛群聊已更改，请重新开启自动签到。");
      return;
    }

    const startMs = checkinStartMs();
    if (!Number.isFinite(startMs) || !Number.isFinite(deadlineMs) || startMs > deadlineMs) {
      stopWechatAutoCheckinForConfiguration("签到开始时间或签到截至时间无效，自动签到已停止。");
      return;
    }

    const fetchStartMs = startMs - AUTO_CHECKIN_LEAD_MS;
    const fetchStopMs = deadlineMs + AUTO_CHECKIN_TRAIL_MS;
    const currentTime = now();
    if (currentTime < fetchStartMs) {
      wechatAutoCheckinStatusText = "已开启，等待签到开始前 5 分钟。";
      updateWechatAutoCheckinUI();
      return;
    }

    const fetchEndMs = Math.min(currentTime, fetchStopMs);
    const messages = await fetchAllWechatMessagesInTimeRange(
      groupUsername,
      Math.floor(fetchStartMs / 1000),
      Math.floor(fetchEndMs / 1000),
    );
    if (apOwnsAutomation()) return;
    lastWechatAutoCheckinPollingErrorText = "";
    if (!ensureWechatAutoCheckinState().enabled || wechatRelayGroupIdentity() !== groupUsername) return;
    if (checkinStartMs() !== startMs || relaySyncDeadlineMs() !== deadlineMs) {
      stopWechatAutoCheckinForConfiguration("签到时间已更改，请重新开启自动签到。");
      return;
    }

    const autoState = ensureWechatAutoCheckinState();
    const result = reconcileWechatAutoCheckinMessages({
      autoCheckin: autoState,
      messages,
      mapping: ensureMappingState(),
      rosterPlayers: state.players,
      groupUsername,
      selectedGroupName: selectedWechatRelayGroup().displayName,
      checkinStartMs: startMs,
      checkinDeadlineMs: deadlineMs,
      nowMs: currentTime,
    });
    autoState.items = result.items;
    let changed = result.changed;
    const reachedStopTime = currentTime >= fetchStopMs;
    if (reachedStopTime && autoState.enabled) {
      autoState.enabled = false;
      changed = true;
      wechatAutoCheckinStatusText = "签到截止时间后 1 分钟已完成最后一次复查，自动签到已停止。";
    } else {
      const pendingCount = autoState.items.filter((item) => item.status === "pending").length;
      wechatAutoCheckinStatusText = `已全量复查 ${messages.length} 条群消息；待处理 ${pendingCount} 项。`;
    }

    if (changed) {
      state.savedAt = now();
      refreshCheckinUI();
      scheduleSave({ source: "script" });
    }
    updateWechatAutoCheckinUI({ notify: reachedStopTime });
    if (reachedStopTime) resumeWechatRelayPolling();
  }

  async function findLatestWechatRelayBeforeDeadline(groupQuery, deadlineSeconds) {
    const eventDate = currentWechatRelayEventDateParts();
    const monthRange = eventDate.month ? currentWechatRelayHistoryRange() : null;
    const startTime = monthRange ? monthRange.startTime : null;
    const endTime = Math.min(
      Number(deadlineSeconds),
      monthRange ? monthRange.endTime : Number(deadlineSeconds),
    );
    if (startTime !== null && endTime < startTime) return null;
    const pageSize = 2000;
    for (let offset = 0; offset <= 10000; offset += pageSize) {
      const result = await fetchWechatRelayMessages(
        offset,
        pageSize,
        groupQuery,
        startTime,
        endTime,
      );
      const page = Array.isArray(result.messages) ? result.messages : [];
      const latestRelay = latestWechatRelayFromMessages(
        page,
        eventDate.month,
        eventDate.year,
      );
      if (latestRelay) return latestRelay;
      if (page.length < pageSize) return null;
    }
    return null;
  }

  async function findLatestNewWechatRelay(sync, groupQuery, deadlineSeconds) {
    const eventDate = currentWechatRelayEventDateParts();
    const monthRange = eventDate.month ? currentWechatRelayHistoryRange() : null;
    const pageSize = 2000;
    const startTime = Math.max(
      monthRange ? monthRange.startTime : 0,
      Number(sync.lastProcessedCreateTime) || 0,
    );
    const endTime = Math.min(
      Number(deadlineSeconds),
      monthRange ? monthRange.endTime : Number(deadlineSeconds),
    );
    if (startTime > endTime) return null;
    for (let offset = 0; offset <= 10000; offset += pageSize) {
      const result = await fetchWechatRelayMessages(
        offset,
        pageSize,
        groupQuery,
        startTime,
        endTime,
      );
      const page = Array.isArray(result.messages) ? result.messages : [];
      const latestNewRelay = page
        .filter(isWechatRelayTemplateMessage)
        .filter((message) =>
          wechatRelayMatchesEventMonth(message, eventDate.month, eventDate.year),
        )
        .filter((message) => isNewWechatRelayMessage(message, sync))
        .sort((left, right) =>
          wechatMessageTimestampMs(right) - wechatMessageTimestampMs(left),
        )[0];
      if (latestNewRelay) return latestNewRelay;
      if (page.length < pageSize) return null;
    }
    return null;
  }

  function isNewWechatRelayMessage(message, sync) {
    const timestamp = Number(message && message.createTime) || 0;
    const previous = Number(sync.lastProcessedCreateTime) || 0;
    const messageId = String(message && message.messageId || "");
    return Boolean(
      messageId &&
        (timestamp > previous ||
          (timestamp === previous && messageId !== sync.lastProcessedMessageId)),
    );
  }

  function rememberProcessedWechatRelayMessage(message) {
    const sync = ensureWechatRelaySyncState();
    sync.lastProcessedMessageId = String(message && message.messageId || "").slice(0, 500);
    sync.lastProcessedCreateTime = Math.max(0, Math.trunc(Number(message && message.createTime) || 0));
  }

  function mergeWechatRelayRosterMessage(message) {
    const sync = ensureWechatRelaySyncState();
    const result = parseImportTextsDetailed("", message.content);
    rememberProcessedWechatRelayMessage(message);

    if (!result.players || result.players.length === 0) {
      wechatRelayStatusText = "新接龙没有可导入选手。";
      scheduleSave({ source: "script" });
      updateWechatRelaySyncUI({ notify: true });
      return;
    }

    const currentPlayers = Array.isArray(state.players) ? state.players : [];
    const incomingPlayers = result.players;
    const missingCurrent = currentPlayers.filter(
      (player) => !incomingPlayers.some((candidate) => wechatRelayPlayersMatch(player, candidate)),
    );
    if (missingCurrent.length) {
      wechatRelayStatusText = `新接龙少于当前签到名单，缺少 ${missingCurrent.length} 名现有选手；本次未合并。`;
      scheduleSave({ source: "script" });
      updateWechatRelaySyncUI({ notify: true });
      return;
    }

    const additions = incomingPlayers.filter(
      (candidate) => !currentPlayers.some((player) => wechatRelayPlayersMatch(player, candidate)),
    );
    if (!additions.length) {
      wechatRelayStatusText = "新接龙没有新增选手。";
      scheduleSave({ source: "script" });
      updateWechatRelaySyncUI({ notify: true });
      return;
    }

    additions.forEach((player) => {
      state.players.push(
        makePlayer(player, {
          isNew: true,
          group: player.group,
          platform: player.platform,
        }),
      );
    });
    state.players.sort(comparePlayersForList);
    void updateAutoPreliminaryRoundsIfNeeded();
    syncMappingRowsWithCheckinPlayers();
    refreshCheckinUI();
    wechatRelayStatusText = `新接龙新增 ${additions.length} 名选手，已加入签到名单。`;
    scheduleSave({ source: "script" });
    updateWechatRelaySyncUI({ notify: true });
  }

  async function checkWechatRelayMessages() {
    if (apOwnsAutomation()) return;
    if (wechatRelayPollInFlight) return;
    const sync = ensureWechatRelaySyncState();
    const autoCheckin = ensureWechatAutoCheckinState();
    if ((!sync.enabled && !autoCheckin.enabled) || (!autoCheckin.enabled && state.step !== "checkin")) return;

    const group = selectedWechatRelayGroup();
    const username = wechatRelayGroupIdentity(group);
    if (!username) {
      if (sync.enabled) {
        stopWechatRelayForConfiguration("请先在 AP 参数中选择比赛群聊，再开启实时同步。");
      }
      if (autoCheckin.enabled) {
        stopWechatAutoCheckinForConfiguration("请先在 AP 参数中选择比赛群聊，自动签到已停止。");
      }
      return;
    }
    const deadline = relaySyncDeadlineMs();
    const deadlineSeconds = relaySyncDeadlineSeconds();
    if (!Number.isFinite(deadline)) {
      if (sync.enabled) {
        stopWechatRelayForConfiguration("请先设置签到截至时间，再开启实时同步。");
      }
      if (autoCheckin.enabled) {
        stopWechatAutoCheckinForConfiguration("请先设置签到截至时间，自动签到已停止。");
      }
      return;
    }
    if (sync.ready && sync.groupUsername !== username) {
      sync.ready = false;
      sync.enabled = false;
      sync.groupUsername = "";
      sync.lastProcessedMessageId = "";
      sync.lastProcessedCreateTime = 0;
      wechatRelayStatusText = "所选比赛群聊已更改，请重新选择接龙并开始同步。";
      scheduleSave({ source: "script" });
      updateWechatRelaySyncUI({ notify: true });
    }

    wechatRelayPollInFlight = true;
    try {
      if (ensureWechatAutoCheckinState().enabled) {
        try {
          await checkWechatAutoCheckinMessages(username, deadline);
        } catch (error) {
          const detail = normalizeWhitespace(error && error.message ? error.message : error);
          wechatAutoCheckinStatusText = `自动签到读取失败：${detail || "本地服务不可用"}`;
          const notify = wechatAutoCheckinStatusText !== lastWechatAutoCheckinPollingErrorText;
          lastWechatAutoCheckinPollingErrorText = wechatAutoCheckinStatusText;
          updateWechatAutoCheckinUI({ notify });
        }
      }

      if (apOwnsAutomation()) return;
      const currentSync = ensureWechatRelaySyncState();
      if (!currentSync.enabled || !currentSync.ready || state.step !== "checkin" || wechatRelayGroupIdentity() !== username) return;

      wechatRelayStatusText = "正在读取所选群聊的微信消息…";
      updateWechatRelaySyncUI();
      const latestMessagesResult = await fetchWechatRelayMessages(0, 200, username);
      if (apOwnsAutomation()) return;
      const latestMessages = Array.isArray(latestMessagesResult.messages)
        ? latestMessagesResult.messages
        : [];
      if (!ensureWechatRelaySyncState().enabled || wechatRelayGroupIdentity() !== username) return;
      if (anyWechatMessageAfterDeadline(latestMessages, deadline)) {
        stopWechatRelayForDeadline();
        return;
      }

      const latestRelay = await findLatestNewWechatRelay(
        currentSync,
        username,
        deadlineSeconds,
      );
      if (apOwnsAutomation()) return;
      if (!ensureWechatRelaySyncState().enabled || wechatRelayGroupIdentity() !== username) return;
      lastWechatRelayPollingErrorText = "";
      latestWechatRelayMessage = latestRelay;
      latestWechatRelayGroupUsername = username;

      if (latestRelay) {
        mergeWechatRelayRosterMessage(latestRelay);
      } else {
        wechatRelayStatusText = "已检查群聊消息，尚无更新的接龙。";
        updateWechatRelaySyncUI();
      }
    } catch (error) {
      if (ensureWechatRelaySyncState().enabled) {
        const detail = normalizeWhitespace(error && error.message ? error.message : error);
        wechatRelayStatusText = `读取微信群聊失败：${detail || "本地服务不可用"}`;
        const notify = wechatRelayStatusText !== lastWechatRelayPollingErrorText;
        lastWechatRelayPollingErrorText = wechatRelayStatusText;
        updateWechatRelaySyncUI({ notify });
      }
    } finally {
      wechatRelayPollInFlight = false;
    }
  }

  function resumeWechatRelayPolling() {
    stopWechatRelayPolling();
    if (apOwnsAutomation()) return;
    const sync = ensureWechatRelaySyncState();
    const autoCheckin = ensureWechatAutoCheckinState();
    const relayNeedsPolling = sync.enabled && sync.ready && state.step === "checkin";
    if ((!relayNeedsPolling && !autoCheckin.enabled) || !LOCAL_SYNC_ENABLED) return;
    void checkWechatRelayMessages();
    wechatRelayPollTimer = window.setInterval(() => {
      void checkWechatRelayMessages();
    }, AUTO_CHECKIN_POLL_INTERVAL_MS);
  }

  async function setWechatRelaySyncEnabled(enabled) {
    if (apOwnsAutomation()) return showSnackbar("AP 正在管理接龙刷新，请在 AP 面板操作", 2600);
    const sync = ensureWechatRelaySyncState();
    lastWechatRelayPollingErrorText = "";
    if (!enabled) {
      sync.enabled = false;
      if (sync.stopReason !== "deadline") wechatRelayStatusText = "实时同步已关闭。";
      scheduleSave();
      updateWechatRelaySyncUI({ notify: true });
      resumeWechatRelayPolling();
      return;
    }

    if (!Array.isArray(state.players) || state.players.length === 0) {
      sync.enabled = false;
      wechatRelayStatusText = "请先确认导入并开始签到，再开启实时同步。";
      updateWechatRelaySyncUI({ notify: true });
      return;
    }
    if (!LOCAL_SYNC_ENABLED) {
      sync.enabled = false;
      wechatRelayStatusText = "实时同步需要通过 PAPP 本地启动器打开页面。";
      updateWechatRelaySyncUI({ notify: true });
      return;
    }
    const group = selectedWechatRelayGroup();
    const username = wechatRelayGroupIdentity(group);
    if (!username) {
      sync.enabled = false;
      wechatRelayStatusText = "请先在 AP 参数中选择比赛群聊。";
      updateWechatRelaySyncUI({ notify: true });
      return;
    }
    const deadlineSeconds = relaySyncDeadlineSeconds();
    if (!Number.isFinite(deadlineSeconds)) {
      sync.enabled = false;
      wechatRelayStatusText = "请先设置签到截至时间。";
      updateWechatRelaySyncUI({ notify: true });
      return;
    }
    if (sync.groupUsername && sync.groupUsername !== username) {
      sync.ready = false;
      sync.lastProcessedMessageId = "";
      sync.lastProcessedCreateTime = 0;
    }
    sync.enabled = true;
    sync.groupUsername = username;
    sync.stopReason = "";
    if (!sync.ready) {
      wechatRelayStatusText = "正在寻找比赛月份相符且不晚于签到截止时间的接龙…";
      updateWechatRelaySyncUI({ notify: true });
      try {
        const message = await findLatestWechatRelayBeforeDeadline(
          username,
          deadlineSeconds,
        );
        if (!sync.enabled || wechatRelayGroupIdentity() !== username) return;
        if (!message) {
          sync.enabled = false;
          wechatRelayStatusText = "签到截止时间前未找到与比赛时间月份相符的接龙，无法建立实时同步基线。";
          updateWechatRelaySyncUI({ notify: true });
          return;
        }
        sync.ready = true;
        sync.groupUsername = username;
        rememberProcessedWechatRelayMessage(message);
      } catch (error) {
        sync.enabled = false;
        const detail = normalizeWhitespace(error && error.message ? error.message : error);
        wechatRelayStatusText = `建立同步基线失败：${detail || "本地服务不可用"}`;
        updateWechatRelaySyncUI({ notify: true });
        return;
      }
    }
    sync.enabled = true;
    sync.groupUsername = username;
    sync.stopReason = "";
    wechatRelayStatusText = "实时同步已开启，每 10 秒检查一次新接龙。";
    scheduleSave();
    updateWechatRelaySyncUI({ notify: true });
    resumeWechatRelayPolling();
  }

  async function referenceLatestWechatRelay() {
    const sync = ensureWechatRelaySyncState();
    const group = selectedWechatRelayGroup();
    const username = wechatRelayGroupIdentity(group);
    const deadlineSeconds = relaySyncDeadlineSeconds();
    if (!LOCAL_SYNC_ENABLED) {
      wechatRelayReferenceStatusText = "引用聊天记录需要通过 PAPP 本地启动器打开页面。";
      updateWechatRelayReferenceUI();
      return;
    }
    if (!username) {
      wechatRelayReferenceStatusText = "请先在 AP 参数中选择比赛群聊。";
      updateWechatRelayReferenceUI();
      return;
    }
    if (!Number.isFinite(deadlineSeconds)) {
      wechatRelayReferenceStatusText = "请先设置签到截至时间。";
      updateWechatRelayReferenceUI();
      return;
    }

    const deadlineAtStart = relaySyncDeadlineMs();
    wechatRelayReferenceStatusText = "正在查找比赛月份相符且不晚于签到截止时间的接龙…";
    if (btnWechatRelayReference) btnWechatRelayReference.disabled = true;
    updateWechatRelayReferenceUI();
    try {
      const message = await findLatestWechatRelayBeforeDeadline(
        username,
        deadlineSeconds,
      );
      if (
        wechatRelayGroupIdentity() !== username ||
        relaySyncDeadlineMs() !== deadlineAtStart
      ) {
        wechatRelayReferenceStatusText = "群聊或签到截至时间已更改，请重新引用。";
        updateWechatRelayReferenceUI();
        return;
      }
      if (!message) {
        if (relayInfoEl) relayInfoEl.value = "";
        state.relayText = "";
        pendingWechatRelayImport = null;
        wechatRelayReferenceAutoText = "";
        clearWechatRelayReferenceContext(sync);
        wechatRelayReferenceStatusText = "签到截止时间前未找到与比赛时间月份相符的接龙；“比赛报名接龙信息”已留空。";
        scheduleSave();
        updateWechatRelayReferenceUI();
        return;
      }

      const content = String(message.content || "");
      wechatRelayReferenceAutoText = content;
      pendingWechatRelayImport = {
        message: { ...message },
        groupUsername: username,
        deadlineMs: deadlineAtStart,
      };
      if (sync.groupUsername !== username) {
        sync.groupUsername = username;
      }
      sync.referenceMessageId = String(message.messageId || "").slice(0, 500);
      sync.referenceCreateTime = Math.max(0, Math.trunc(Number(message.createTime) || 0));
      sync.referenceGroupUsername = username;
      sync.referenceDeadlineMs = Math.trunc(deadlineAtStart);
      if (relayInfoEl) relayInfoEl.value = content;
      state.relayText = content;
      if (relayInfoDetails) relayInfoDetails.open = true;
      wechatRelayReferenceStatusText = `已将目标接龙完整原文填入“比赛报名接龙信息” · 微信时间 ${formatWechatMessageTimestamp(message)}。核对后点击现有导入按钮继续。`;
      scheduleSave();
      updateWechatRelayReferenceUI();
      updateWechatRelaySyncUI();
    } catch (error) {
      const detail = normalizeWhitespace(error && error.message ? error.message : error);
      wechatRelayReferenceStatusText = `引用微信群聊失败：${detail || "本地服务不可用"}`;
      updateWechatRelayReferenceUI();
    } finally {
      if (btnWechatRelayReference) btnWechatRelayReference.disabled = false;
    }
  }

  function renderEventSchedule() {
    const schedule = ensureEventScheduleState();
    const tournamentParameters = ensureTournamentParametersState();
    const currentCompetitionName = normalizeWhitespace(state.competitionName);
    if (
      schedule.wechatGroup.queryIndex &&
      (!currentCompetitionName || currentCompetitionName === "比赛签到表") &&
      setCompetitionNameFromWechatGroup(schedule.wechatGroup)
    ) {
      scheduleSave();
    }
    EVENT_SCHEDULE_FIELDS.forEach(({ key }) => {
      const input = eventScheduleInputs[key];
      if (!input) return;
      if (document.activeElement !== input) input.value = schedule[key] || "";
    });
    if (
      scheduleSemifinalAndFinalInput &&
      document.activeElement !== scheduleSemifinalAndFinalInput
    ) {
      scheduleSemifinalAndFinalInput.value = String(
        tournamentParameters.semifinalAndFinalMode,
      );
    }
    if (scheduleSkipSemifinalInput && document.activeElement !== scheduleSkipSemifinalInput) {
      scheduleSkipSemifinalInput.checked = tournamentParameters.skipSemifinal === true;
      scheduleSkipSemifinalInput.disabled = state.step !== "schedule" && state.step !== "import";
    }
    if (
      scheduleBrightwellConstantInput &&
      document.activeElement !== scheduleBrightwellConstantInput
    ) {
      scheduleBrightwellConstantInput.value = String(
        tournamentParameters.brightwellConstant,
      );
    }
    renderSelectedWechatGroup();
  }

  function readEventScheduleFromUI() {
    const schedule = createDefaultEventSchedule();
    EVENT_SCHEDULE_FIELDS.forEach(({ key }) => {
      const input = eventScheduleInputs[key];
      schedule[key] = normalizeEventScheduleValue(input ? input.value : "");
    });
    schedule.wechatGroup = sanitizeWechatGroupSelection(ensureEventScheduleState().wechatGroup);
    return schedule;
  }

  function readTournamentParametersFromUI() {
    const current = ensureTournamentParametersState();
    const rawConstant = scheduleBrightwellConstantInput
      ? String(scheduleBrightwellConstantInput.value).trim()
      : String(current.brightwellConstant);
    const brightwellConstant = rawConstant ? Number(rawConstant) : NaN;
    if (!Number.isFinite(brightwellConstant) || brightwellConstant < 0) {
      return {
        ok: false,
        message: "请输入大于或等于 0 的 Brightwell 常数。",
      };
    }

    return {
      ok: true,
      value: {
        ...sanitizeTournamentParameters(
          {
            ...current,
            semifinalAndFinalMode: scheduleSemifinalAndFinalInput
              ? scheduleSemifinalAndFinalInput.value
              : current.semifinalAndFinalMode,
            skipSemifinal: scheduleSkipSemifinalInput ? scheduleSkipSemifinalInput.checked : current.skipSemifinal,
            brightwellConstant,
          },
          state.players,
        ),
        brightwellConstant,
      },
    };
  }

  function validateEventSchedule(schedule) {
    let previous = null;
    for (const field of EVENT_SCHEDULE_FIELDS) {
      const value = normalizeEventScheduleValue(schedule && schedule[field.key]);
      if (!value) continue;
      const time = Date.parse(value);
      if (!Number.isFinite(time)) {
        return { ok: false, message: `${field.label}格式无效，请重新选择时间。` };
      }
      if (previous && time < previous.time) {
        return {
          ok: false,
          message: `${field.label}不能早于${previous.label}，请检查时间顺序。`,
        };
      }
      previous = { label: field.label, time };
    }
    return { ok: true, message: "" };
  }

  function showScheduleValidation(message) {
    if (!scheduleValidation) return;
    scheduleValidation.textContent = String(message || "");
    scheduleValidation.hidden = !message;
  }

  function continueFromSchedule() {
    const schedule = readEventScheduleFromUI();
    const validation = validateEventSchedule(schedule);
    if (!validation.ok) {
      showScheduleValidation(validation.message);
      return;
    }
    const tournamentParameters = readTournamentParametersFromUI();
    if (!tournamentParameters.ok) {
      showScheduleValidation(tournamentParameters.message);
      return;
    }

    state.eventSchedule = schedule;
    state.tournamentParameters = tournamentParameters.value;
    const hasSavedProgress =
      Array.isArray(state.players) &&
      state.players.length > 0 &&
      (state.step === "checkin" || TOURNAMENT_STEP_IDS.includes(state.step));
    if (hasSavedProgress) {
      // Keep the persisted check-in/score step intact when editing schedule
      // settings from the import-page override.
      viewStepOverride = "import";
    } else {
      state.step = "import";
      viewStepOverride = null;
    }
    showScheduleValidation("");
    applyStepUI();
    updateProgressBar();
    updateImportEmptyState();
    scheduleSave();
    showSnackbar("比赛参数已保存，开始导入选手名单", 2200);
  }

  function editEventSchedule() {
    if (state.appMode !== "competition") return;
    viewStepOverride = "schedule";
    renderEventSchedule();
    showScheduleValidation("");
    applyStepUI();
    updateProgressBar();
  }

  function backToPortal() {
    if (typeof window !== "undefined" && window.location) {
      window.location.href = "./papp-portal/";
    }
  }

  function surveyState() {
    if (!state.survey || typeof state.survey !== "object") {
      state.survey = createDefaultSurveyState();
    }
    return state.survey;
  }

  function formatSurveyNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
  }

  function shouldMarkSurveyRating(profile) {
    const totalGames =
      Number(profile.win || 0) +
      Number(profile.loss || 0) +
      Number(profile.draw || 0);
    const hiddenR = Number(profile.hiddenR || 0);
    return hiddenR !== 0 || totalGames < 40;
  }

  function formatSurveyRating(profile) {
    const rating = formatSurveyNumber(profile.rating);
    return shouldMarkSurveyRating(profile) ? `${rating}?` : rating;
  }

  function renderSurveyProfile() {
    const profile = sanitizeSurveyProfile(surveyState().profile);
    surveyState().profile = profile;
    if (surveyAccountInput && document.activeElement !== surveyAccountInput) {
      surveyAccountInput.value = surveyState().accountInput || "";
    }
    if (surveyProfileResult) surveyProfileResult.classList.toggle("hidden", !profile);
    if (!profile) return;
    if (surveyProfileId) surveyProfileId.textContent = profile.id || "—";
    if (surveyProfileName) surveyProfileName.textContent = profile.name || "—";
    if (surveyProfileRating) surveyProfileRating.textContent = formatSurveyRating(profile);
    if (surveyProfileHigh) surveyProfileHigh.textContent = formatSurveyNumber(profile.high);
    if (surveyProfilePlayed) surveyProfilePlayed.textContent = formatSurveyNumber(profile.played);
    if (surveyProfileWin) surveyProfileWin.textContent = formatSurveyNumber(profile.win);
    if (surveyProfileLoss) surveyProfileLoss.textContent = formatSurveyNumber(profile.loss);
    if (surveyProfileDraw) surveyProfileDraw.textContent = formatSurveyNumber(profile.draw);
  }

  function applySurveyUI() {
    const current = String(surveyState().view || "");
    if (surveyOptionGrid) {
      surveyOptionGrid.querySelectorAll("[data-survey-view]").forEach((button) => {
        button.setAttribute("aria-selected", button.dataset.surveyView === current ? "true" : "false");
      });
    }
    if (surveyPastPanel) surveyPastPanel.classList.toggle("hidden", current !== "past");
    if (surveyIdPanel) surveyIdPanel.classList.toggle("hidden", current !== "id");
    renderSurveyProfile();
  }

  function setSurveyView(view) {
    const next = view === "id" ? "id" : "past";
    surveyState().view = next;
    applySurveyUI();
    scheduleSave();
  }

  async function querySurveyPlayerProfile() {
    const account = normalizeWhitespace(surveyAccountInput && surveyAccountInput.value);
    if (!account) {
      showAlert("无法查询", "请输入 OQ ID。");
      return;
    }
    if (!LOCAL_SYNC_ENABLED || typeof fetch !== "function") {
      showAlert("无法查询", "请通过本机启动通道打开页面，才能调用本地画像查询服务。");
      return;
    }

    if (btnSurveyQuery) btnSurveyQuery.disabled = true;
    try {
      const response = await fetch("/api/player-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "查询服务返回失败");
      }
      const profile = sanitizeSurveyProfile(payload.profile);
      if (!profile) throw new Error("查询结果缺少可确认的画像信息");
      const current = surveyState();
      current.view = "id";
      current.accountInput = account;
      current.profile = profile;
      applySurveyUI();
      scheduleSave();
      showSnackbar("已查询到 5 分钟 Player 画像", 2400);
    } catch (error) {
      showAlert("查询 OQ 选手画像失败", String(error && error.message ? error.message : error));
    } finally {
      if (btnSurveyQuery) btnSurveyQuery.disabled = false;
    }
  }

  function getAllGroupsFromPlayers() {
    const set = new Set();
    for (const p of state.players) {
      const g = normalizeWhitespace(p.group) || "未分组";
      set.add(g);
    }
    return Array.from(set).sort((a, b) => nameCollator.compare(a, b));
  }

  function ensureValidSelectedGroup() {
    if (!state.ui)
      state.ui = { group: "all", callMode: false, showTime: false };
    if (!state.ui.group) state.ui.group = "all";

    if (state.ui.group === "all") return;

    const exists = state.players.some((p) => p.group === state.ui.group);
    if (!exists) state.ui.group = "all";
  }

  function createRuleId() {
    return `rule-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 7)}`;
  }

  function readGroupRulesFromEditor() {
    if (!groupRulesEl) return sanitizeGroupRules(state.groupRules);

    const nodes = Array.from(groupRulesEl.querySelectorAll(".group-rule"));
    const rules = [];

    nodes.forEach((node) => {
      const id = normalizeWhitespace(node.getAttribute("data-rule-id"));
      if (!id) return;

      const groupInput = node.querySelector('input[data-role="group"]');
      const keywordsInput = node.querySelector(
        'textarea[data-role="keywords"]',
      );
      const enabledInput = node.querySelector('input[data-role="enabled"]');

      const group = normalizeWhitespace(groupInput && groupInput.value);
      const keywords = normalizeGroupRuleKeywords(
        keywordsInput && keywordsInput.value,
      );
      const enabled = !(enabledInput && enabledInput.checked === false);

      rules.push({ id, group, keywords, enabled });
    });

    return sanitizeGroupRules(rules);
  }

  function renderGroupRulesEditor() {
    if (!groupRulesEl) return;

    state.groupRules = sanitizeGroupRules(state.groupRules);
    const rules = state.groupRules;
    groupRulesEl.innerHTML = "";

    for (const rule of rules) {
      const item = document.createElement("div");
      item.className = "group-rule";
      item.setAttribute("data-rule-id", rule.id);

      const title = escapeHtml(rule.group || "");
      const keywordsText = escapeHtml((rule.keywords || []).join(", "));

      item.innerHTML = `
        <div class="group-rule__top">
          <label class="switch">
            <input type="checkbox" data-role="enabled" ${rule.enabled ? "checked" : ""} />
            <span>启用</span>
          </label>
          <button class="btn btn-text" type="button" data-role="delete" aria-label="删除组别规则">删除</button>
        </div>
        <div class="group-rule__row">
          <div class="field">
            <label>组别名称</label>
            <input type="text" data-role="group" value="${title}" placeholder="例如：无差别组" />
          </div>
          <div class="field">
            <label>关键词（逗号/换行分隔）</label>
            <textarea rows="2" data-role="keywords" placeholder="例如：无差别组, open">${keywordsText}</textarea>
          </div>
        </div>
      `;

      groupRulesEl.appendChild(item);
    }
  }

  function renderGroupFilter() {
    if (!groupFilterEl) return;

    ensureValidSelectedGroup();

    const groups = getAllGroupsFromPlayers();
    const counts = new Map();
    for (const p of state.players) {
      const g = normalizeWhitespace(p.group) || "未分组";
      counts.set(g, (counts.get(g) || 0) + 1);
    }

    // Build buttons
    groupFilterEl.innerHTML = "";

    const addBtn = (label, value, count) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "seg-btn";
      b.dataset.group = value;
      const selected = state.ui.group === value;
      b.setAttribute("aria-selected", selected ? "true" : "false");
      b.setAttribute("role", "tab");
      // Roving tabindex: improves keyboard navigation/accessibility.
      b.tabIndex = selected ? 0 : -1;
      b.textContent = typeof count === "number" ? `${label}(${count})` : label;
      groupFilterEl.appendChild(b);
    };

    addBtn("全部", "all", state.players.length);

    for (const g of groups) {
      addBtn(g, g, counts.get(g) || 0);
    }
  }

  function applyModeClasses() {
    const body =
      document && document.body && document.body.classList
        ? document.body
        : null;
    if (body)
      body.classList.toggle(
        "mode-call",
        Boolean(state.ui && state.ui.callMode),
      );

    if (btnCallMode) {
      const on = Boolean(state.ui && state.ui.callMode);
      btnCallMode.setAttribute("aria-pressed", on ? "true" : "false");
      btnCallMode.textContent = on ? "点名模式：开" : "点名模式";
    }

    if (btnShowTime) {
      const on = Boolean(state.ui && state.ui.showTime);
      btnShowTime.setAttribute("aria-pressed", on ? "true" : "false");
      btnShowTime.textContent = on ? "显示时间：开" : "显示时间";
    }

    updateProgressBar();
  }

  function updateProgressBar() {
    const progressBar = document.getElementById("progress-bar");
    if (!progressBar) return;
    if (state.appMode !== "competition") {
      if (btnLiveStandings) btnLiveStandings.hidden = true;
      progressBar.classList.add("hidden");
      return;
    }
    if (btnLiveStandings) btnLiveStandings.hidden = false;
    progressBar.classList.remove("hidden");
    updateTournamentStagePresentation();
    const currentStep = getCurrentStep();
    const fill = progressBar.querySelector(".progress-bar__fill");
    const labels = progressBar.querySelectorAll(".progress-bar__label[data-step]");
    const steps = visibleCompetitionSteps();
    const currentIndex = Math.max(0, steps.indexOf(currentStep));
    if (fill) fill.style.width = `${((currentIndex + 1) / steps.length) * 100}%`;
    progressBar.setAttribute("aria-valuemax", String(steps.length));
    progressBar.setAttribute("aria-valuenow", String(currentIndex + 1));
    labels.forEach((label) => {
      const labelIndex = steps.indexOf(label.dataset.step);
      label.classList.toggle("hidden", labelIndex < 0);
      label.classList.toggle(
        "progress-bar__label--active",
        labelIndex === currentIndex,
      );
    });
    document.querySelectorAll(".step-chip[data-step]").forEach((chip) => {
      const stepIndex = steps.indexOf(chip.dataset.step);
      chip.classList.toggle("hidden", stepIndex < 0);
      if (stepIndex < 0) return;
      const text = `步骤 ${stepIndex + 1}/${steps.length}`;
      chip.textContent = text;
      chip.setAttribute("aria-label", text);
    });
  }

  function updateClearSearchButton() {
    if (!btnClearSearch || !searchBox) return;
    btnClearSearch.hidden = !normalizeWhitespace(searchBox.value || "");
  }

  function updateImportEmptyState() {
    if (!importEmptyState) return;
    const hasText = Boolean(
      normalizeWhitespace((clubMembersEl && clubMembersEl.value) || "") ||
        normalizeWhitespace((relayInfoEl && relayInfoEl.value) || ""),
    );
    importEmptyState.hidden = hasText;
  }

  function updateAutosaveChip(ts) {
    if (!autosaveTimeEl) return;
    const text = formatShortTime(ts || (state && state.savedAt));
    if (!text) {
      autosaveTimeEl.hidden = true;
      return;
    }
    autosaveTimeEl.textContent = text;
    autosaveTimeEl.hidden = false;
  }

  function renderEmptyPlayerState() {
    const empty = document.createElement("div");
    empty.className = "empty-state empty-state--list";

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.classList.add("empty-state__icon");
    icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-search");
    icon.appendChild(use);

    const textWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "empty-state__title";
    const text = document.createElement("div");
    text.className = "empty-state__text";

    const hasSearch =
      searchBox && Boolean(normalizeWhitespace(searchBox.value || ""));
    if (hasSearch || (state.ui && state.ui.callMode)) {
      title.textContent = "没有匹配的选手";
      text.textContent = hasSearch
        ? "可清除搜索词，或切换组别和点名模式后再查看。"
        : "当前范围内没有等待签到的选手。";
    } else {
      title.textContent = "暂无选手";
      text.textContent = "返回上一步导入名单，或在上方输入框临时添加选手。";
    }

    textWrap.appendChild(title);
    textWrap.appendChild(text);
    empty.appendChild(icon);
    empty.appendChild(textWrap);
    return empty;
  }

  function getStatsScopePlayers() {
    // Stats are based on selected group, NOT affected by callMode/search.
    let list = Array.isArray(state.players) ? state.players : [];
    if (state.ui && state.ui.group && state.ui.group !== "all") {
      list = list.filter((p) => p.group === state.ui.group);
    }
    return list;
  }

  function updateStats(visiblePlayers) {
    const list = getStatsScopePlayers();
    const total = list.length;
    const checkedIn = list.filter((p) => p.checkedIn).length;

    if (totalCountEl) totalCountEl.textContent = String(total);
    if (checkedInCountEl) checkedInCountEl.textContent = String(checkedIn);
    if (notCheckedInCountEl)
      notCheckedInCountEl.textContent = String(total - checkedIn);

    // 显示筛选计数
    const searchTerm =
      searchBox && searchBox.value ? normalizeWhitespace(searchBox.value) : "";
    const isFiltered = Boolean(
      (state.ui && state.ui.callMode) ||
        (state.ui && state.ui.group !== "all") ||
        searchTerm,
    );

    if (visiblePlayers && isFiltered && visiblePlayers.length !== total) {
      if (statFilteredContainer) statFilteredContainer.hidden = false;
      if (statFilteredEl) statFilteredEl.textContent = String(visiblePlayers.length);
    } else {
      if (statFilteredContainer) statFilteredContainer.hidden = true;
    }
  }

  function getVisiblePlayers() {
    let list = getStatsScopePlayers();

    // call mode => only unchecked players
    if (state.ui && state.ui.callMode) {
      list = list.filter((p) => !p.checkedIn);
    }

    // search filter (displayName + account + club)
    const term = normalizeWhitespace(
      searchBox && typeof searchBox.value === "string" ? searchBox.value : "",
    ).toLowerCase();
    if (term) {
      list = list.filter((p) => {
        const hay = [p.displayName, p.account, p.club, p.group, p.platform]
          .map((x) => normalizeWhitespace(x).toLowerCase())
          .join(" ");
        return hay.includes(term);
      });
    }

    return list;
  }

  function renderPlayerList(visiblePlayers) {
    if (!playerList) return;

    const prevScrollTop = playerList.scrollTop;
    const visible = visiblePlayers || getVisiblePlayers();
    const shouldPinFirstPlayerToBottom =
      document.documentElement &&
      document.documentElement.classList &&
      document.documentElement.classList.contains("screen-keyboard-checkin") &&
      document.body &&
      document.body.classList &&
      document.body.classList.contains("ios-checkin-editing");

    playerList.innerHTML = "";

    if (visible.length === 0) {
      playerList.appendChild(renderEmptyPlayerState());
      return;
    }

    visible.forEach((player, index) => {
      const row = document.createElement("div");
      row.className = `player-item ${player.checkedIn ? "player-item--checked" : "player-item--waiting"}`;
      if (player.isNew) row.classList.add("player-item--new");
      row.dataset.playerId = String(player.id);

      const left = document.createElement("div");
      left.className = "player-left";

      const idx = document.createElement("div");
      idx.className = "player-index";
      idx.textContent = `${index + 1}.`;

      const meta = document.createElement("div");
      meta.className = "player-meta";

      const name = document.createElement("div");
      name.className = "player-name";
      name.textContent = player.displayName;

      const sub = document.createElement("div");
      sub.className = "player-sub";

      const parts = [];
      if (player.platform) {
        parts.push(player.platform.toUpperCase());
      }
      if (player.account) {
        parts.push(player.account);
      }
      if (player.club) {
        parts.push(`俱乐部:${player.club}`);
      }
      sub.textContent = parts.join(" · ");

      const tags = document.createElement("div");
      tags.className = "player-tags";

      const status = document.createElement("span");
      status.className = `chip-small ${player.checkedIn ? "chip-good" : "chip-warn"}`;
      status.textContent = player.checkedIn ? "已签到" : "等待中";
      tags.appendChild(status);

      // Group tag (helpful in "全部"视图)
      if (player.group && player.group !== "未分组") {
        const gchip = document.createElement("span");
        gchip.className = "chip-small";
        gchip.textContent = player.group;
        tags.appendChild(gchip);
      }

      if (player.isNew) {
        const newChip = document.createElement("span");
        newChip.className = "chip-small chip-new";
        newChip.textContent = "新人";
        tags.appendChild(newChip);
      }

      if (
        state.ui &&
        state.ui.showTime &&
        player.checkedIn &&
        player.checkedInAt
      ) {
        const tchip = document.createElement("span");
        tchip.className = "chip-small";
        tchip.textContent = formatTime(player.checkedInAt);
        tags.appendChild(tchip);
      }

      meta.appendChild(name);
      if (parts.length) meta.appendChild(sub);
      meta.appendChild(tags);

      left.appendChild(idx);
      left.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "player-actions";

      // Check-in toggle
      const checkBtn = document.createElement("button");
      checkBtn.type = "button";
      checkBtn.className = `action-btn ${player.checkedIn ? "" : "action-btn--primary"}`;
      checkBtn.dataset.action = "toggle-checkin";
      checkBtn.dataset.playerId = String(player.id);
      checkBtn.textContent = player.checkedIn ? "取消签到" : "签到";

      // New toggle
      const newBtn = document.createElement("button");
      newBtn.type = "button";
      newBtn.className = "action-btn";
      newBtn.dataset.action = "toggle-new";
      newBtn.dataset.playerId = String(player.id);
      newBtn.textContent = player.isNew ? "取消新人" : "设为新人";

      // Edit
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "action-btn";
      editBtn.dataset.action = "edit";
      editBtn.dataset.playerId = String(player.id);
      editBtn.textContent = "编辑";

      // Delete
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "action-btn action-btn--danger";
      delBtn.dataset.action = "delete";
      delBtn.dataset.playerId = String(player.id);
      delBtn.textContent = "删除";

      actions.appendChild(checkBtn);
      actions.appendChild(newBtn);
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      row.appendChild(left);
      row.appendChild(actions);

      playerList.appendChild(row);
    });

    playerList.scrollTop = shouldPinFirstPlayerToBottom ? 0 : prevScrollTop;
  }

  function shouldPreserveTouchKeyboardCheckinScroll() {
    return Boolean(
      document.documentElement &&
        document.documentElement.classList &&
        document.documentElement.classList.contains("screen-keyboard-checkin") &&
        document.body &&
        document.body.classList &&
        document.body.classList.contains("ios-checkin-editing"),
    );
  }

  function preserveViewportScrollDuring(fn) {
    if (typeof fn !== "function") return;
    if (!shouldPreserveTouchKeyboardCheckinScroll()) {
      fn();
      return;
    }

    const scrollX = Number(window.scrollX) || 0;
    const scrollY = Number(window.scrollY) || 0;
    const docEl = document.documentElement;
    const body = document.body;
    const docTop = docEl ? Number(docEl.scrollTop) || 0 : 0;
    const bodyTop = body ? Number(body.scrollTop) || 0 : 0;

    const restore = () => {
      try {
        window.scrollTo(scrollX, scrollY);
        if (docEl) docEl.scrollTop = docTop;
        if (body) body.scrollTop = bodyTop;
      } catch (_) {
        // ignore scroll restoration errors
      }
    };

    fn();
    restore();
    window.requestAnimationFrame(restore);
  }

  function ensureMappingState() {
    if (!state.mapping || typeof state.mapping !== "object") {
      state.mapping = createDefaultMapping();
    }
    return state.mapping;
  }

  function mappingGroupInfo(selectedGroup = selectedWechatRelayGroup()) {
    const group = selectedGroup && typeof selectedGroup === "object"
      ? selectedGroup
      : {};
    const identity = normalizeWhitespace(
      group.username || group.roomUsername || group.room_username || group.queryIndex,
    );
    const name = normalizeWhitespace(
      group.displayName || group.display_name || group.groupName || group.group_name ||
        group.queryIndex || identity,
    );
    return { identity, name };
  }

  function mappingGroupRefreshQuery(mapping, selectedGroup = selectedWechatRelayGroup()) {
    const override = normalizeWhitespace(mapping && mapping.groupOverride);
    if (override) return override;
    const group = mappingGroupInfo(selectedGroup);
    return group.identity || group.name || normalizeWhitespace(mapping && mapping.groupName);
  }

  function mappingGroupCacheQuery(mapping, selectedGroup = selectedWechatRelayGroup()) {
    const group = mappingGroupInfo(selectedGroup);
    return normalizeWhitespace(mapping && mapping.groupName) || group.name || group.identity;
  }

  function mappingGroupInputValue(mapping, selectedGroup = selectedWechatRelayGroup()) {
    const override = normalizeWhitespace(mapping && mapping.groupOverride);
    if (override) return override;
    const group = mappingGroupInfo(selectedGroup);
    return group.name || normalizeWhitespace(mapping && mapping.groupName);
  }

  function mappingGroupTargetKey(mapping, selectedGroup = selectedWechatRelayGroup()) {
    const override = normalizeWhitespace(mapping && mapping.groupOverride);
    if (override) return `override:${override}`;
    const group = mappingGroupInfo(selectedGroup);
    if (group.identity) return `chat:${group.identity}`;
    return `name:${normalizeWhitespace(mapping && mapping.groupName)}`;
  }

  function clearMappingGroupNickPool(mapping) {
    mapping.groupNicks = [];
    mapping.memberCount = 0;
    mapping.mappedCount = 0;
    mapping.refreshedAt = "";
  }

  function synchronizeMappingGroupToSelectedChat(
    mapping,
    selectedGroup = selectedWechatRelayGroup(),
  ) {
    if (!mapping || typeof mapping !== "object" || normalizeWhitespace(mapping.groupOverride)) {
      return false;
    }
    const group = mappingGroupInfo(selectedGroup);
    if (!group.identity) return false;

    let changed = false;
    if (normalizeWhitespace(mapping.groupUsername) !== group.identity) {
      clearMappingGroupNickPool(mapping);
      mapping.groupUsername = group.identity;
      changed = true;
    }
    if (group.name && normalizeWhitespace(mapping.groupName) !== group.name) {
      mapping.groupName = group.name;
      changed = true;
    }
    return changed;
  }

  function mappingRowById(rowId) {
    const mapping = ensureMappingState();
    const id = String(rowId || "");
    return mapping.rows.find((row) => String(row.id) === id) || null;
  }

  function mappingOqNeedsQuestionMark(rawCheck) {
    const check = sanitizeMappingCheck(rawCheck);
    if (check.status !== "ok" && check.status !== "forced-ok") return false;
    if (!check.profileReady) return check.questionMark === true;

    const counts = [check.win, check.loss, check.draw];
    const totalGames = counts.every((value) => value !== null)
      ? counts.reduce((sum, value) => sum + value, 0)
      : check.n ?? check.played;
    // maturity = min(N / 40, 1); use N < 40 so the decision is not affected
    // by floating-point comparisons.
    return (check.hiddenR !== null && check.hiddenR !== 0) ||
      (totalGames !== null && totalGames < 40);
  }

  function mappingOqQuestionMarkTitle(rawCheck) {
    const check = sanitizeMappingCheck(rawCheck);
    const details = [];
    if (check.hiddenR !== null) details.push(`hiddenR=${check.hiddenR}`);
    const counts = [check.win, check.loss, check.draw];
    const totalGames = counts.every((value) => value !== null)
      ? counts.reduce((sum, value) => sum + value, 0)
      : check.n ?? check.played;
    if (totalGames !== null) details.push(`N=${totalGames}`);
    return details.length
      ? `OQ 账号需要人工核对（${details.join("，")}）`
      : "OQ 账号需要人工核对";
  }

  function mappingOqRatingLabel(rawCheck) {
    const check = sanitizeMappingCheck(rawCheck);
    if (check.status !== "ok" && check.status !== "forced-ok") return null;
    if (check.rating === null) return null;
    const questionMark = mappingOqNeedsQuestionMark(check);
    return {
      text: `${formatSurveyNumber(check.rating)}${questionMark ? "？" : ""}`,
      title: questionMark
        ? mappingOqQuestionMarkTitle(check)
        : "5 分钟 OQ 当前等级分；账号通过校验",
      className: questionMark ? "mapping-oq-rating--suspect" : "",
    };
  }

  function mappingStatusLabel(row) {
    const account = normalizeWhitespace(row && row.oqAccount);
    const check = sanitizeMappingCheck(row && row.oqCheck);
    if (!account) return { text: "未填写", className: "mapping-oq-status--empty", title: "尚未填写 OQ 账号" };
    if (normalizeKey(check.account) !== normalizeKey(account) || !check.status) {
      return { text: "待校验", className: "mapping-oq-status--pending", title: "点击“校验 OQ 账号”" };
    }
    if (check.status === "ok") {
      const profileHint = check.profileError ? `；账号画像读取失败：${check.profileError}` : "";
      return {
        text: check.totalGames ? `有效 · ${check.totalGames} 局` : "有效",
        className: "mapping-oq-status--ok",
        title: `${check.fallbackUsed ? "使用备用 OQ 模式校验通过" : "OQ 账号校验通过"}${profileHint}`,
      };
    }
    if (check.status === "forced-ok") {
      return { text: "已确认", className: "mapping-oq-status--ok", title: "已手动确认" };
    }
    return {
      text: "未通过",
      className: "mapping-oq-status--invalid",
      title: check.error || "OQ 账号校验未通过",
    };
  }

  function refreshMappingSummary() {
    const mapping = ensureMappingState();
    if (!mappingSummary) return;
    const rows = mappingRowsForRoster(mapping, state.players);
    const complete = rows.filter(
      (row) => row.wechatNick && row.registrationNick && row.oqAccount,
    ).length;
    const valid = rows.filter(
      (row) =>
        row.oqAccount &&
        normalizeKey(row.oqCheck && row.oqCheck.account) === normalizeKey(row.oqAccount) &&
        row.oqCheck &&
        row.oqCheck.status === "ok",
    ).length;
    const refreshed = mapping.refreshedAt
      ? `最近刷新：${mapping.refreshedAt}`
      : "尚未刷新群昵称";
    mappingSummary.innerHTML = `
      <span class="mapping-summary__item">群成员 <strong>${Number(mapping.memberCount) || mapping.groupNicks.length}</strong></span>
      <span class="mapping-summary__item">映射行 <strong>${rows.length}</strong></span>
      <span class="mapping-summary__item">三项完整 <strong>${complete}</strong></span>
      <span class="mapping-summary__item">OQ 已通过 <strong>${valid}</strong></span>
      <span class="mapping-summary__meta">${escapeHtml(mapping.groupName || "未指定群聊")} · ${escapeHtml(refreshed)}</span>
    `;
  }

  function updateMappingGroupNickWarningInput(input, row) {
    if (!input) return;
    const shouldWarn = mappingGroupNickHasIdentityMismatch(row);
    input.classList.toggle("mapping-input--identity-warning", shouldWarn);
    if (shouldWarn && !input.hasAttribute("title")) {
      input.title = MAPPING_GROUP_NICK_WARNING;
    } else if (!shouldWarn && input.hasAttribute("title")) {
      input.removeAttribute("title");
    }
  }

  function renderMappingTable() {
    const mapping = ensureMappingState();
    const groupSyncChanged = synchronizeMappingGroupToSelectedChat(mapping);
    const rowSync = syncMappingRowsWithCheckinPlayers();
    if (rowSync.changed || groupSyncChanged) {
      mapping.updatedAt = now();
      scheduleSave();
    }
    if (mappingGroupNameInput && document.activeElement !== mappingGroupNameInput) {
      mappingGroupNameInput.value = mappingGroupInputValue(mapping);
    }
    if (mappingGroupNickOptions) {
      mappingGroupNickOptions.innerHTML = mapping.groupNicks
        .map((nick) => `<option value="${escapeHtml(nick)}"></option>`)
        .join("");
    }

    const rows = mappingRowsForRoster(mapping, state.players);
    if (mappingEmptyState) mappingEmptyState.hidden = rows.length > 0;
    if (mappingTableWrap) mappingTableWrap.classList.toggle("mapping-table-wrap--empty", rows.length === 0);
    if (!mappingTableBody) {
      refreshMappingSummary();
      return;
    }
    mappingTableBody.innerHTML = rows
      .map((row, index) => {
        const status = mappingStatusLabel(row);
        const oqRating = mappingOqRatingLabel(row.oqCheck);
        const playerLabel = row.registrationNick || row.wechatNick || "未命名选手";
        const groupNickWarning = mappingGroupNickHasIdentityMismatch(row);
        const lockLabel = row.scriptLocked
          ? `解除 ${playerLabel} 的脚本锁`
          : `锁定 ${playerLabel} 的三个映射字段`;
        const lockIcon = row.scriptLocked ? "i-lock" : "i-lock-open";
        return `
          <tr class="${row.scriptLocked ? "mapping-table-row--script-locked" : ""}"
            data-mapping-row-id="${escapeHtml(row.id)}">
            <td>
              <div class="mapping-cell-edit">
                <input class="input mapping-input${groupNickWarning ? " mapping-input--identity-warning" : ""}" type="text" list="mapping-group-nick-options"
                  data-mapping-field="wechatNick" data-mapping-row-id="${escapeHtml(row.id)}"
                  value="${escapeHtml(row.wechatNick)}" placeholder="选择或输入群昵称" autocomplete="off"
                  ${groupNickWarning ? `title="${escapeHtml(MAPPING_GROUP_NICK_WARNING)}"` : ""} />
                <button class="icon-btn mapping-row-delete" type="button" data-mapping-action="delete"
                  data-mapping-row-id="${escapeHtml(row.id)}" aria-label="删除第 ${index + 1} 行映射" title="删除此行">
                  <svg class="ms-icon" aria-hidden="true"><use href="#i-delete"></use></svg>
                </button>
              </div>
            </td>
            <td>
              <div class="mapping-registration-cell">
                <input class="input mapping-input" type="text" data-mapping-field="registrationNick"
                  data-mapping-row-id="${escapeHtml(row.id)}" value="${escapeHtml(row.registrationNick)}"
                  placeholder="报名时使用的昵称" autocomplete="off" />
                <button class="btn btn-tonal mapping-move-selection" type="button"
                  data-mapping-action="move-selection" data-mapping-row-id="${escapeHtml(row.id)}"
                  title="将选中文字剪切到 OQ 账号" aria-label="迁移选中文字到 OQ 账号" hidden>迁移为 OQ 账号</button>
              </div>
            </td>
            <td>
              <div class="mapping-oq-cell">
                <input class="input mapping-input" type="text" data-mapping-field="oqAccount"
                  data-mapping-row-id="${escapeHtml(row.id)}" value="${escapeHtml(row.oqAccount)}"
                  placeholder="OQ 账号" inputmode="text" autocomplete="off" />
                ${oqRating ? `<span class="mapping-oq-rating ${oqRating.className}" title="${escapeHtml(oqRating.title)}">${escapeHtml(oqRating.text)}</span>` : ""}
                <span class="mapping-oq-status ${status.className}" title="${escapeHtml(status.title)}">${escapeHtml(status.text)}</span>
              </div>
            </td>
            <td class="mapping-lock-cell">
              <button class="icon-btn mapping-row-lock${row.scriptLocked ? " mapping-row-lock--active" : ""}"
                type="button" data-mapping-action="toggle-script-lock"
                data-mapping-row-id="${escapeHtml(row.id)}"
                aria-label="${escapeHtml(lockLabel)}" aria-pressed="${row.scriptLocked ? "true" : "false"}"
                title="${escapeHtml(lockLabel)}">
                <svg class="ms-icon" aria-hidden="true"><use href="#${lockIcon}"></use></svg>
              </button>
            </td>
          </tr>
        `;
      })
      .join("");
    refreshMappingSummary();
  }

  function resortMappingTableDomRows() {
    if (!mappingTableBody) return;
    const rowOrder = new Map(
      mappingRowsForRoster(ensureMappingState(), state.players)
        .map((row, index) => [mappingTextId(row.id), index]),
    );
    const rows = Array.from(
      mappingTableBody.querySelectorAll("tr[data-mapping-row-id]"),
    );
    rows.sort((left, right) => {
      const leftOrder = rowOrder.get(mappingTextId(left.dataset.mappingRowId));
      const rightOrder = rowOrder.get(mappingTextId(right.dataset.mappingRowId));
      return (leftOrder ?? Number.MAX_SAFE_INTEGER) -
        (rightOrder ?? Number.MAX_SAFE_INTEGER);
    });
    rows.forEach((row) => mappingTableBody.appendChild(row));
  }

  function handleMappingTableFieldFocusOut(event) {
    const target = isElement(event.target) ? event.target : null;
    if (!target || !target.matches("input[data-mapping-field]")) return;
    window.setTimeout(() => {
      const activeElement = document.activeElement;
      if (
        mappingTableWrap &&
        activeElement &&
        mappingTableWrap.contains(activeElement) &&
        isElement(activeElement) &&
        activeElement.matches("input[data-mapping-field]")
      ) return;
      resortMappingTableDomRows();
    }, 0);
  }

  function updateCheckinViewVisibility() {
    const mappingActive = state.ui && state.ui.checkinView === "mapping";
    if (checkinPlayersView) checkinPlayersView.classList.toggle("hidden", mappingActive);
    if (mappingView) mappingView.classList.toggle("hidden", !mappingActive);
    if (checkinViewTabs) {
      checkinViewTabs.querySelectorAll("button[data-checkin-view]").forEach((button) => {
        const active = String(button.dataset.checkinView || "") === (mappingActive ? "mapping" : "players");
        button.setAttribute("aria-selected", active ? "true" : "false");
      });
    }
  }

  function setCheckinView(view, loadCached = false) {
    state.ui.checkinView = view === "mapping" ? "mapping" : "players";
    updateCheckinViewVisibility();
    if (state.ui.checkinView === "mapping") {
      renderMappingTable();
      if (loadCached) loadCachedWechatNicks();
    } else {
      const visiblePlayers = getVisiblePlayers();
      updateStats(visiblePlayers);
      renderPlayerList(visiblePlayers);
    }
    scheduleSave();
  }

  function mergeWechatMemberMapPayload(payload) {
    const rawNicks = payload && Array.isArray(payload.groupNicks) ? payload.groupNicks : [];
    const nicks = [];
    const seen = new Set();
    rawNicks.forEach((value) => {
      const nick = normalizeWhitespace(value && typeof value === "object" ? value.groupNick || value.group_nick : value);
      const key = normalizeKey(nick);
      if (nick && !seen.has(key)) {
        seen.add(key);
        nicks.push(nick);
      }
    });
    if (!nicks.length) throw new Error("群昵称刷新结果为空");

    const mapping = ensureMappingState();
    mapping.groupName = normalizeWhitespace(payload.groupName || mapping.groupName);
    const roomUsername = normalizeWhitespace(
      payload.roomUsername || payload.room_username,
    );
    if (roomUsername) {
      mapping.groupUsername = roomUsername;
    } else if (!normalizeWhitespace(mapping.groupOverride)) {
      const group = mappingGroupInfo();
      if (group.identity) mapping.groupUsername = group.identity;
    }
    mapping.groupNicks = nicks.sort((a, b) => nameCollator.compare(a, b));
    mapping.memberCount = Number(payload.memberCount) || mapping.groupNicks.length;
    mapping.mappedCount = Number(payload.mappedCount) || mapping.groupNicks.length;
    mapping.refreshedAt = normalizeWhitespace(payload.refreshedAt) || new Date().toISOString();

    const rowSync = syncMappingRowsWithCheckinPlayers({ suppressProcessY: true });
    mapping.updatedAt = now();
    renderMappingTable();
    return {
      nickCount: mapping.groupNicks.length,
      addedRows: rowSync.addedCount,
    };
  }

  async function loadCachedWechatNicks() {
    if (typeof fetch !== "function") return;
    const mapping = ensureMappingState();
    const selectedGroup = selectedWechatRelayGroup();
    if (synchronizeMappingGroupToSelectedChat(mapping, selectedGroup)) {
      mapping.updatedAt = now();
      renderMappingTable();
      scheduleSave();
    }
    const group = mappingGroupCacheQuery(mapping, selectedGroup);
    if (!group) return;
    const targetKey = mappingGroupTargetKey(mapping, selectedGroup);
    const query = encodeURIComponent(group);
    try {
      const response = await fetch(`/api/wechat-member-map?group=${query}&t=${Date.now()}`, {
        cache: "no-store",
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) return;
      const currentMapping = ensureMappingState();
      if (mappingGroupTargetKey(currentMapping) !== targetKey) return;
      const expectedRoomUsername = normalizeWhitespace(
        currentMapping.groupOverride
          ? ""
          : mappingGroupInfo(selectedWechatRelayGroup()).identity,
      );
      const cachedRoomUsername = normalizeWhitespace(
        result.roomUsername || result.room_username,
      );
      if (
        expectedRoomUsername &&
        cachedRoomUsername &&
        cachedRoomUsername !== expectedRoomUsername
      ) return;
      mergeWechatMemberMapPayload(result);
      const processResult = await runMappingProcessY();
      if (processResult.historyError) {
        console.warn("流程 Y 历史接龙查询失败：", processResult.historyError);
      }
      scheduleSave({ source: "script" });
    } catch (_) {
      // A missing local cache is normal before the first explicit refresh.
    }
  }

  async function refreshWechatNicks() {
    if (typeof fetch !== "function") {
      showAlert("刷新失败", "当前页面没有可用的本地服务连接。");
      return;
    }
    const mapping = ensureMappingState();
    const selectedGroup = selectedWechatRelayGroup();
    if (synchronizeMappingGroupToSelectedChat(mapping, selectedGroup)) {
      mapping.updatedAt = now();
      renderMappingTable();
      scheduleSave();
    }
    const group = mappingGroupRefreshQuery(mapping, selectedGroup);
    const targetKey = mappingGroupTargetKey(mapping, selectedGroup);
    if (mapping.groupOverride) {
      mapping.groupName = mapping.groupOverride;
    } else {
      const selectedInfo = mappingGroupInfo(selectedGroup);
      if (selectedInfo.name) mapping.groupName = selectedInfo.name;
    }
    if (mappingGroupNameInput) {
      mappingGroupNameInput.value = mappingGroupInputValue(mapping, selectedGroup);
    }
    setBtnBusy(btnRefreshWechatNicks, true, "拉取中…", "刷新群昵称");
    try {
      const response = await fetch("/api/wechat-member-map/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ group }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      if (mappingGroupTargetKey(ensureMappingState()) !== targetKey) {
        showSnackbar("目标群聊已更改，已忽略之前的刷新结果。", 3200);
        return;
      }
      const nickResult = mergeWechatMemberMapPayload(result);
      const matchResult = await runMappingProcessY();
      state.ui.checkinView = "mapping";
      updateCheckinViewVisibility();
      scheduleSave({ source: "script" });
      const historySummary = matchResult.historyError
        ? `历史接龙查询失败：${matchResult.historyError}`
        : `历史归属 ${matchResult.historyMatchedCount} 行`;
      showSnackbar(
        `已拉取 ${nickResult.nickCount} 个微信群昵称，${historySummary}，自动关联 ${matchResult.autoMatchedCount} 行；歧义 ${matchResult.ambiguousCount} 行、账号冲突 ${matchResult.accountConflictCount} 行待核对`,
        4200,
      );
    } catch (error) {
      showAlert("刷新微信群昵称失败", String(error && error.message ? error.message : error));
    } finally {
      setBtnBusy(btnRefreshWechatNicks, false, "拉取中…", "刷新群昵称");
    }
  }

  async function validateMappingOqAccounts() {
    const mapping = ensureMappingState();
    const accounts = [];
    const seen = new Set();
    mappingRowsForRoster(mapping, state.players).forEach((row) => {
      const account = normalizeWhitespace(row.oqAccount);
      const key = normalizeKey(account);
      if (account && !seen.has(key)) {
        seen.add(key);
        accounts.push(account);
      }
    });
    if (!accounts.length) {
      showAlert("无法校验 OQ 账号", "映射表中还没有填写 oq账号。");
      return;
    }
    if (typeof fetch !== "function") {
      showAlert("校验失败", "当前页面没有可用的本地服务连接。");
      return;
    }

    setBtnBusy(btnValidateOqAccounts, true, "校验中…", "校验 OQ 账号");
    try {
      const response = await fetch("/api/oq-accounts/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ accounts, mode: "5min", concurrency: 8, timeout: 20 }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && (result.detail || result.error)) || `HTTP ${response.status}`);
      }
      const checkedAt = normalizeWhitespace(result.checkedAt) || new Date().toISOString();
      const byAccount = result.byAccount && typeof result.byAccount === "object" ? result.byAccount : {};
      mapping.rows.forEach((row) => {
        const account = normalizeWhitespace(row.oqAccount);
        const validation = byAccount[normalizeKey(account)];
        if (!account || !validation) return;
        row.oqCheck = sanitizeMappingCheck({ ...validation, checkedAt });
      });
      mapping.oqValidation = {
        checkedAt,
        checkedCount: Number(result.checkedCount) || 0,
        okCount: Number(result.okCount) || 0,
        invalidCount: Number(result.invalidCount) || 0,
        wallMs: Number(result.wallMs) || 0,
      };
      mapping.updatedAt = now();
      renderMappingTable();
      scheduleSave();
      showSnackbar(
        `OQ 校验完成：${Number(result.okCount) || 0} 个通过，${Number(result.invalidCount) || 0} 个未通过`,
        3600,
      );
    } catch (error) {
      showAlert(
        "校验 OQ 账号失败",
        `${String(error && error.message ? error.message : error)}\n\nOQ 校验需要本机能够访问 questgames.net；格式错误的账号也会在本地直接标记为未通过。`,
      );
    } finally {
      setBtnBusy(btnValidateOqAccounts, false, "校验中…", "校验 OQ 账号");
    }
  }

  function selfCheckMapping() {
    const mapping = ensureMappingState();
    const rows = mappingRowsForRoster(mapping, state.players);
    const issues = [];
    const checkDuplicates = (field, label) => {
      const owners = new Map();
      rows.forEach((row, index) => {
        const value = normalizeWhitespace(row[field]);
        const key = normalizeKey(value);
        if (!key) return;
        const list = owners.get(key) || [];
        list.push(`${index + 1}行${value}`);
        owners.set(key, list);
      });
      owners.forEach((list) => {
        if (list.length > 1) issues.push(`${label}重复：${list.join("、")}`);
      });
    };
    checkDuplicates("wechatNick", "微信群昵称");
    checkDuplicates("registrationNick", "报名昵称");
    checkDuplicates("oqAccount", "oq账号");
    rows.forEach((row, index) => {
      if (row.oqAccount && !row.registrationNick) issues.push(`第 ${index + 1} 行填写了 oq账号，但缺少报名昵称`);
      if (row.registrationNick && !row.wechatNick) issues.push(`第 ${index + 1} 行填写了报名昵称，但缺少微信群昵称`);
    });
    if (!mapping.groupNicks.length) issues.push("尚未拉取微信群昵称池");

    const message = issues.length
      ? `发现 ${issues.length} 项需要处理：\n\n${issues.slice(0, 30).join("\n")}${issues.length > 30 ? "\n……" : ""}`
      : `未发现结构性问题。\n\n当前 ${rows.length} 行映射中，三项完整 ${rows.filter((row) => row.wechatNick && row.registrationNick && row.oqAccount).length} 行。`;
    showAlert("映射表自检", message);
  }

  function findRosterPlayersForMappingName(name, rosterPlayers = state.players) {
    const raw = normalizeWhitespace(name);
    if (!raw) return [];
    const players = Array.isArray(rosterPlayers) ? rosterPlayers : [];
    const exactKey = normalizeKey(raw);
    const exact = players.filter((player) => normalizeKey(player.displayName) === exactKey);
    if (exact.length) return exact;
    const compactKey = normalizeForSimilarity(raw);
    return players.filter((player) => normalizeForSimilarity(player.displayName) === compactKey);
  }

  function mappingRowCandidateMatches(row, rosterPlayers = state.players) {
    const players = Array.isArray(rosterPlayers) ? rosterPlayers : [];
    const linkedId = mappingTextId(row && row.checkinPlayerId);
    if (linkedId) {
      return players.filter(
        (player) => mappingTextId(player && player.id) === linkedId,
      );
    }

    const matches = findRosterPlayersForMappingName(
      row && row.registrationNick,
      players,
    );
    if (matches.length <= 1) return matches;

    const oqAccountKey = normalizeKey(row && row.oqAccount);
    if (!oqAccountKey) return matches;
    const accountMatches = matches.filter((player) => {
      const platform = normalizeKey(player && player.platform);
      const account = normalizeKey(player && (player.account || player.oqAccount));
      return account === oqAccountKey && (!platform || platform === "oq");
    });
    return accountMatches.length === 1 ? accountMatches : matches;
  }

  function mappingRowsForRoster(mappingState, rosterPlayers) {
    const mapping = mappingState && typeof mappingState === "object"
      ? mappingState
      : {};
    const rows = Array.isArray(mapping.rows) ? mapping.rows : [];
    const players = Array.isArray(rosterPlayers) ? rosterPlayers : [];
    const rowsByPlayerId = new Map();
    rows.forEach((row) => {
      const playerId = mappingTextId(row && row.checkinPlayerId);
      if (playerId && !rowsByPlayerId.has(playerId)) rowsByPlayerId.set(playerId, row);
    });

    const orderedRows = players.flatMap((player) => {
      const playerId = mappingTextId(player && player.id);
      if (!playerId) return [];
      const row = rowsByPlayerId.get(playerId);
      return row ? [row] : [];
    });
    return orderedRows
      .map((row, rosterOrder) => ({
        row,
        rosterOrder,
        missingCount: mappingRowMissingFieldCount(row),
      }))
      .sort((left, right) =>
        right.missingCount - left.missingCount ||
        left.rosterOrder - right.rosterOrder,
      )
      .map((entry) => entry.row);
  }

  function mappingRowMissingFieldCount(row) {
    return [row && row.wechatNick, row && row.registrationNick, row && row.oqAccount]
      .filter((value) => !normalizeWhitespace(value))
      .length;
  }

  function syncMappingFieldToCheckinPlayer(row, field, rosterPlayers) {
    const playerField = field === "registrationNick"
      ? "displayName"
      : field === "oqAccount"
        ? "account"
        : "";
    const playerId = mappingTextId(row && row.checkinPlayerId);
    if (!playerField || !playerId) return false;

    const players = Array.isArray(rosterPlayers) ? rosterPlayers : [];
    const linkedPlayers = players.filter(
      (player) => mappingTextId(player && player.id) === playerId,
    );
    if (linkedPlayers.length !== 1) return false;

    const player = linkedPlayers[0];
    const value = normalizeWhitespace(row[field]);
    if (field === "registrationNick" && !value) return false;
    let changed = false;
    if (normalizeWhitespace(player[playerField]) !== value) {
      player[playerField] = value;
      changed = true;
    }
    if (
      field === "oqAccount" &&
      value &&
      !normalizeWhitespace(player.platform)
    ) {
      player.platform = "oq";
      changed = true;
    }
    return changed;
  }

  function reconcileMappingRowsWithCandidates(mappingState, rosterPlayers) {
    const mapping = mappingState && typeof mappingState === "object"
      ? mappingState
      : createDefaultMapping();
    if (!Array.isArray(mapping.rows)) mapping.rows = [];
    const candidates = Array.isArray(rosterPlayers) ? rosterPlayers : [];
    const excludedIds = new Set(
      Array.isArray(mapping.excludedCheckinPlayerIds)
        ? mapping.excludedCheckinPlayerIds.map((id) => mappingTextId(id)).filter(Boolean)
        : [],
    );
    const associatedIds = new Set();
    let changed = false;
    let addedCount = 0;

    mapping.rows.forEach((row) => {
      const matches = mappingRowCandidateMatches(row, candidates);
      if (matches.length !== 1) return;
      const playerId = mappingTextId(matches[0] && matches[0].id);
      if (!playerId || associatedIds.has(playerId)) return;
      if (mappingTextId(row.checkinPlayerId) !== playerId) {
        row.checkinPlayerId = playerId;
        changed = true;
      }
      if (
        row.scriptLocked !== true &&
        isManualGroupNick(row) &&
        mappingTextId(row.checkinPlayerId) === playerId
      ) {
        const registrationNick = normalizeWhitespace(
          matches[0].displayName || matches[0].name,
        );
        const oqAccount = normalizeWhitespace(
          matches[0].account || matches[0].oqAccount,
        );
        if (!normalizeWhitespace(row.registrationNick) && registrationNick) {
          row.registrationNick = registrationNick;
          changed = true;
        }
        if (!normalizeWhitespace(row.oqAccount) && oqAccount) {
          row.oqAccount = oqAccount;
          row.oqCheck = sanitizeMappingCheck(null);
          changed = true;
        }
      }
      associatedIds.add(playerId);
      if (excludedIds.delete(playerId)) changed = true;
    });

    const usedRowIds = new Set(
      mapping.rows.map((row) => mappingTextId(row && row.id)).filter(Boolean),
    );
    candidates.forEach((player) => {
      const playerId = mappingTextId(player && player.id);
      const registrationNick = normalizeWhitespace(player && player.displayName);
      if (
        !playerId ||
        !registrationNick ||
        associatedIds.has(playerId) ||
        excludedIds.has(playerId)
      ) {
        return;
      }

      const baseId = `checkin-${playerId}`;
      let rowId = baseId;
      let suffix = 2;
      while (usedRowIds.has(rowId)) {
        rowId = `${baseId}-${suffix}`;
        suffix += 1;
      }
      usedRowIds.add(rowId);
      mapping.rows.push({
        id: rowId,
        wechatNick: "",
        wechatNickSource: "",
        registrationNick,
        oqAccount: normalizeWhitespace(player && player.account),
        oqCheck: sanitizeMappingCheck(null),
        checkinPlayerId: playerId,
        scriptLocked: false,
      });
      associatedIds.add(playerId);
      addedCount += 1;
      changed = true;
    });

    mapping.excludedCheckinPlayerIds = Array.from(excludedIds);
    return { changed, addedCount };
  }

  function accountTokenFromGroupNick(groupNick, matchedName, rosterName = matchedName) {
    const text = String(groupNick || "").trim();
    const nameKeys = [matchedName, rosterName]
      .map(normalizeMappingNameKey)
      .filter(Boolean);
    if (!text || !nameKeys.length) return "";

    const tokens = text.match(/[A-Za-z0-9_][A-Za-z0-9_.-]*/g) || [];
    if (tokens.length) {
      const nameTokenCount = (String(rosterName || matchedName || "").match(/[A-Za-z]+/g) || []).length;
      const hasHan = /[\u4e00-\u9fff]/.test(text);
      const firstTokenIsFullName =
        nameKeys.includes(normalizeMappingNameKey(tokens[0])) && tokens.length > 1;
      if (
        hasHan ||
        firstTokenIsFullName ||
        tokens.length > Math.max(1, nameTokenCount)
      ) {
        for (const token of tokens.slice().reverse()) {
          const clean = token.replace(/^[ .]+|[ .]+$/g, "");
          if (
            clean.length >= 2 &&
            /[A-Za-z0-9]/.test(clean) &&
            (hasHan || !nameKeys.includes(normalizeMappingNameKey(clean)))
          ) {
            return clean;
          }
        }
      }
    }

    const compact = normalizeMappingNameKey(text);
    for (const nameKey of nameKeys) {
      if (!compact.startsWith(nameKey)) continue;
      const tail = compact.slice(nameKey.length);
      if (tail && /[A-Za-z0-9]/.test(tail)) return tail;
    }
    return "";
  }

  function matchGroupNicksToRosterPlayers(groupNicks, rosterPlayers) {
    const nicks = [];
    const seenNicks = new Set();
    (Array.isArray(groupNicks) ? groupNicks : []).forEach((rawNick) => {
      const nick = normalizeWhitespace(rawNick);
      const key = normalizeMappingNameKey(nick);
      if (!nick || !key || seenNicks.has(key)) return;
      seenNicks.add(key);
      nicks.push({ nick, key });
    });

    const seenPlayerIds = new Set();
    const players = (Array.isArray(rosterPlayers) ? rosterPlayers : [])
      .map((player) => {
        const id = mappingTextId(player && player.id);
        const displayName = normalizeWhitespace(
          player && (player.displayName || player.name),
        );
        const account = normalizeWhitespace(
          player && (player.account || player.oqAccount),
        );
        const rawAliases = Array.isArray(player && player.mappingNameAliases)
          ? player.mappingNameAliases
          : [];
        const names = [displayName, ...rawAliases]
          .map((value) => normalizeWhitespace(value))
          .filter(Boolean)
          .map((name) => ({ name, key: normalizeMappingNameKey(name) }))
          .filter((item) => item.key)
          .sort((left, right) => right.key.length - left.key.length);
        return { player, id, displayName, account, names };
      })
      .filter((item) => {
        if (!item.id || !item.displayName || !item.names.length || seenPlayerIds.has(item.id)) {
          return false;
        }
        seenPlayerIds.add(item.id);
        return true;
      });

    const provisional = nicks.map(({ nick, key }) => {
      const namedCandidates = players
        .map((item) => {
          const name = item.names.find((candidate) => key.includes(candidate.key));
          if (!name) return null;
          return {
            candidatePlayerId: item.id,
            displayName: item.displayName,
            rosterAccount: item.account,
            nicknameAccount: accountTokenFromGroupNick(nick, name.name, item.displayName),
          };
        })
        .filter(Boolean);

      const candidatePlayerIds = namedCandidates.map((item) => item.candidatePlayerId);
      if (!namedCandidates.length) return { status: "unmatched", wechatNick: nick };

      const accountMatches = namedCandidates.filter(
        (candidate) =>
          candidate.nicknameAccount &&
          candidate.rosterAccount &&
          normalizeKey(candidate.nicknameAccount) === normalizeKey(candidate.rosterAccount),
      );
      const effective = accountMatches.length === 1
        ? accountMatches
        : namedCandidates;
      if (effective.length !== 1) {
        return {
          status: "ambiguous",
          wechatNick: nick,
          candidatePlayerIds,
          candidateDisplayNames: namedCandidates.map((item) => item.displayName),
        };
      }

      const candidate = effective[0];
      if (
        candidate.nicknameAccount &&
        candidate.rosterAccount &&
        normalizeKey(candidate.nicknameAccount) !== normalizeKey(candidate.rosterAccount)
      ) {
        return {
          status: "account-conflict",
          wechatNick: nick,
          candidatePlayerIds,
          candidateDisplayName: candidate.displayName,
          nicknameAccount: candidate.nicknameAccount,
          rosterAccount: candidate.rosterAccount,
        };
      }
      return {
        status: "matched",
        wechatNick: nick,
        candidatePlayerId: candidate.candidatePlayerId,
        candidatePlayerIds,
        displayName: candidate.displayName,
        rosterAccount: candidate.rosterAccount,
        nicknameAccount: candidate.nicknameAccount,
        account: candidate.rosterAccount || candidate.nicknameAccount,
      };
    });

    const nickCountByPlayerId = new Map();
    provisional.forEach((item) => {
      const candidatePlayerIds = Array.isArray(item.candidatePlayerIds)
        ? item.candidatePlayerIds
        : [];
      candidatePlayerIds.forEach((playerId) => {
        const nicksForPlayer = nickCountByPlayerId.get(playerId) || new Set();
        nicksForPlayer.add(item.wechatNick);
        nickCountByPlayerId.set(playerId, nicksForPlayer);
      });
    });

    const matches = [];
    const ambiguous = [];
    const accountConflicts = [];
    const unmatched = [];
    provisional.forEach((item) => {
      const hasMultipleNicksForCandidate = (item.candidatePlayerIds || []).some(
        (playerId) => (nickCountByPlayerId.get(playerId) || new Set()).size > 1,
      );
      if (
        (item.status === "matched" || item.status === "account-conflict") &&
        hasMultipleNicksForCandidate
      ) {
        ambiguous.push({
          status: "ambiguous",
          wechatNick: item.wechatNick,
          candidatePlayerIds: item.candidatePlayerIds,
          candidateDisplayNames:
            item.candidateDisplayNames || [item.candidateDisplayName || item.displayName],
          reason: "multiple-group-nicks-for-player",
        });
      } else if (item.status === "matched") {
        matches.push(item);
      } else if (item.status === "ambiguous") {
        ambiguous.push(item);
      } else if (item.status === "account-conflict") {
        accountConflicts.push(item);
      } else {
        unmatched.push(item.wechatNick);
      }
    });
    return { matches, ambiguous, accountConflicts, unmatched };
  }

  function mappingRowHasOqCheckData(row) {
    const check = row && row.oqCheck && typeof row.oqCheck === "object"
      ? row.oqCheck
      : {};
    return Boolean(
      check.account ||
      check.status ||
      check.checkedAt ||
      check.profileStatus ||
      (check.rating !== null && check.rating !== undefined) ||
      (check.high !== null && check.high !== undefined) ||
      (check.hiddenR !== null && check.hiddenR !== undefined) ||
      (check.played !== null && check.played !== undefined) ||
      (check.n !== null && check.n !== undefined) ||
      (check.win !== null && check.win !== undefined) ||
      (check.loss !== null && check.loss !== undefined) ||
      (check.draw !== null && check.draw !== undefined)
    );
  }

  function relayMessageContainsMappingIdentity(message, registrationNick, oqAccount) {
    const registrationKey = normalizeMappingNameKey(registrationNick);
    const accountKey = normalizeMappingNameKey(oqAccount);
    if (!registrationKey) return false;
    const messageKey = normalizeMappingNameKey(message && message.content);
    return messageKey.includes(registrationKey) &&
      (!accountKey || messageKey.includes(accountKey));
  }

  function reconcileHistoricalRelayGroupNicks(mappingState, rosterPlayers, messages) {
    const mapping = mappingState && typeof mappingState === "object"
      ? mappingState
      : createDefaultMapping();
    if (!Array.isArray(mapping.rows)) mapping.rows = [];
    const candidates = Array.isArray(rosterPlayers) ? rosterPlayers : [];
    const relayMessages = (Array.isArray(messages) ? messages : [])
      .filter((message) => isWechatRelayTemplateContent(message && message.content))
      .slice()
      .sort((left, right) => {
        const timeDifference =
          (Number(left && left.createTime) || 0) -
          (Number(right && right.createTime) || 0);
        if (timeDifference) return timeDifference;
        return String(left && left.messageId || "").localeCompare(
          String(right && right.messageId || ""),
        );
      });

    const rowIdentities = mapping.rows.map((row) => ({
      row,
      nameKey: normalizeMappingNameKey(row && row.registrationNick),
      accountKey: normalizeMappingNameKey(row && row.oqAccount),
      candidateMatches: mappingRowCandidateMatches(row, candidates),
    }));
    const rowCountByName = new Map();
    const rowCountByIdentity = new Map();
    rowIdentities.forEach(({ nameKey, accountKey }) => {
      if (!nameKey) return;
      rowCountByName.set(nameKey, (rowCountByName.get(nameKey) || 0) + 1);
      const identityKey = `${nameKey}\u0000${accountKey}`;
      rowCountByIdentity.set(
        identityKey,
        (rowCountByIdentity.get(identityKey) || 0) + 1,
      );
    });

    let changed = false;
    let matchedCount = 0;
    let ambiguousCount = 0;
    let unmatchedCount = 0;
    rowIdentities.forEach(({ row, nameKey, accountKey, candidateMatches }) => {
      if (!nameKey || candidateMatches.length !== 1) {
        if (nameKey && candidateMatches.length !== 1) ambiguousCount += 1;
        return;
      }
      if (
        (!accountKey && rowCountByName.get(nameKey) > 1) ||
        rowCountByIdentity.get(`${nameKey}\u0000${accountKey}`) > 1
      ) {
        ambiguousCount += 1;
        return;
      }
      if (row.scriptLocked === true || isManualGroupNick(row)) return;

      const registrationNick = normalizeWhitespace(row.registrationNick);
      const oqAccount = normalizeWhitespace(row.oqAccount);
      const firstMessage = relayMessages.find((message) =>
        relayMessageContainsMappingIdentity(message, registrationNick, oqAccount),
      );
      const senderGroupNick = normalizeWhitespace(firstMessage && firstMessage.senderGroupNick);
      if (!firstMessage || !senderGroupNick) {
        unmatchedCount += 1;
        return;
      }
      if (
        row.wechatNick &&
        row.wechatNickSource !== "auto" &&
        row.wechatNickSource !== "history"
      ) {
        return;
      }
      matchedCount += 1;
      if (
        row.wechatNick !== senderGroupNick ||
        row.wechatNickSource !== "history"
      ) {
        row.wechatNick = senderGroupNick;
        row.wechatNickSource = "history";
        changed = true;
      }
    });

    return { changed, matchedCount, ambiguousCount, unmatchedCount };
  }

  function reconcileGroupNicksWithCandidates(mappingState, rosterPlayers) {
    const mapping = mappingState && typeof mappingState === "object"
      ? mappingState
      : createDefaultMapping();
    if (!Array.isArray(mapping.rows)) mapping.rows = [];
    const candidates = Array.isArray(rosterPlayers) ? rosterPlayers : [];
    const excludedIds = new Set(
      Array.isArray(mapping.excludedCheckinPlayerIds)
        ? mapping.excludedCheckinPlayerIds.map(mappingTextId).filter(Boolean)
        : [],
    );

    const availablePlayers = candidates.map((player) => {
      const playerId = mappingTextId(player && player.id);
      const linkedRows = mapping.rows.filter(
        (row) => mappingTextId(row && row.checkinPlayerId) === playerId,
      );
      const row = linkedRows.length === 1 ? linkedRows[0] : null;
      const displayName = normalizeWhitespace(player.displayName || player.name);
      const aliases = [row && row.registrationNick]
        .map(normalizeWhitespace)
        .filter((name) => name && normalizeMappingNameKey(name) !== normalizeMappingNameKey(displayName));
      return {
        ...player,
        id: playerId,
        displayName,
        account: normalizeWhitespace((row && row.oqAccount) || player.account || player.oqAccount),
        mappingNameAliases: aliases,
      };
    }).filter((player) => player.id && player.displayName);

    const availableNicks = (Array.isArray(mapping.groupNicks) ? mapping.groupNicks : [])
      .map(normalizeWhitespace)
      .filter((nick) => {
        const key = normalizeMappingNameKey(nick);
        if (!key) return false;
        const rows = mapping.rows.filter(
          (row) => normalizeMappingNameKey(row && row.wechatNick) === key,
        );
        if (rows.length > 1) return false;
        if (!rows.length) return true;
        const row = rows[0];
        return Boolean(
          !row.registrationNick &&
          !row.oqAccount &&
          !mappingTextId(row.checkinPlayerId) &&
          !isManualGroupNick(row) &&
          !mappingRowHasOqCheckData(row),
        );
      });

    const matchResult = matchGroupNicksToRosterPlayers(availableNicks, availablePlayers);
    let changed = false;
    let autoMatchedCount = 0;
    const removeRowIds = new Set();

    matchResult.matches.forEach((match) => {
      const playerRows = mapping.rows.filter(
        (row) => mappingTextId(row && row.checkinPlayerId) === match.candidatePlayerId,
      );
      if (excludedIds.has(match.candidatePlayerId) || playerRows.length !== 1) return;
      const playerRow = playerRows[0];
      const replaceableNicknameSource =
        playerRow.wechatNickSource === "auto" ||
        playerRow.wechatNickSource === "history";
      if (
        playerRow.scriptLocked === true ||
        (playerRow.wechatNick && !replaceableNicknameSource) ||
        isManualGroupNick(playerRow)
      ) {
        return;
      }

      const nickKey = normalizeMappingNameKey(match.wechatNick);
      const nickRows = mapping.rows.filter(
        (row) => normalizeMappingNameKey(row && row.wechatNick) === nickKey,
      );
      if (nickRows.length > 1) return;
      const nickRow = nickRows[0];
      if (
        nickRow &&
        nickRow !== playerRow &&
        (
          nickRow.registrationNick ||
          nickRow.oqAccount ||
          mappingTextId(nickRow.checkinPlayerId) ||
          isManualGroupNick(nickRow) ||
          mappingRowHasOqCheckData(nickRow)
        )
      ) {
        return;
      }

      playerRow.wechatNick = match.wechatNick;
      playerRow.wechatNickSource = "auto";
      if (!playerRow.registrationNick) playerRow.registrationNick = match.displayName;
      if (!playerRow.oqAccount && match.account) {
        playerRow.oqAccount = match.account;
        playerRow.oqCheck = sanitizeMappingCheck(null);
      }
      if (nickRow && nickRow !== playerRow) {
        const nickRowId = mappingTextId(nickRow.id);
        if (nickRowId) removeRowIds.add(nickRowId);
      }
      autoMatchedCount += 1;
      changed = true;
    });

    if (removeRowIds.size) {
      mapping.rows = mapping.rows.filter((row) => !removeRowIds.has(mappingTextId(row && row.id)));
      changed = true;
    }

    return {
      changed,
      autoMatchedCount,
      ambiguousCount: matchResult.ambiguous.length,
      accountConflictCount: matchResult.accountConflicts.length,
      unmatchedCount: matchResult.unmatched.length,
    };
  }

  function syncMappingRowsWithCheckinPlayers(options = {}) {
    const mapping = ensureMappingState();
    const candidates = Array.isArray(state.players) ? state.players : [];
    const result = reconcileMappingRowsWithCandidates(
      mapping,
      candidates,
    );
    const match = options.matchGroupNicks === true
      ? reconcileGroupNicksWithCandidates(mapping, candidates)
      : {
          changed: false,
          autoMatchedCount: 0,
          ambiguousCount: 0,
          accountConflictCount: 0,
          unmatchedCount: 0,
        };
    const changed = result.changed || match.changed;
    if (changed) mapping.updatedAt = now();
    if (
      (result.addedCount > 0 || result.changed) &&
      options.suppressProcessY !== true
    ) {
      queueMappingProcessY();
    }
    return { ...result, ...match, changed };
  }

  function queueMappingProcessY() {
    if (IS_NODE || typeof window === "undefined") return;
    if (mappingProcessYTimer) window.clearTimeout(mappingProcessYTimer);
    mappingProcessYTimer = window.setTimeout(() => {
      mappingProcessYTimer = null;
      runMappingProcessY().catch((error) => {
        console.error("流程 Y 执行失败：", error);
        showSnackbar("流程 Y 执行失败，请检查本地服务连接后重试。", 3200);
      });
    }, 120);
  }

  async function executeMappingProcessY() {
    const mapping = ensureMappingState();
    const rosterPlayers = Array.isArray(state.players) ? state.players : [];
    const rowSync = syncMappingRowsWithCheckinPlayers({ suppressProcessY: true });
    let historyMessages = [];
    let historyError = "";
    const selectedGroup = selectedWechatRelayGroup();
    const groupQuery = mappingGroupRefreshQuery(mapping, selectedGroup);
    if (rosterPlayers.length && groupQuery) {
      try {
        const range = currentWechatRelayHistoryRange();
        historyMessages = await fetchAllWechatMessagesInTimeRange(
          groupQuery,
          range.startTime,
          range.endTime,
          { relayOnly: true },
        );
      } catch (error) {
        historyError = normalizeWhitespace(error && error.message) || "读取历史接龙失败";
      }
    }

    const historyMatch = reconcileHistoricalRelayGroupNicks(
      mapping,
      rosterPlayers,
      historyMessages,
    );
    const groupNickMatch = reconcileGroupNicksWithCandidates(mapping, rosterPlayers);
    const changed = rowSync.changed || historyMatch.changed || groupNickMatch.changed;
    if (changed) {
      mapping.updatedAt = now();
      if (state.ui && state.ui.checkinView === "mapping") renderMappingTable();
      scheduleSave({ source: "script" });
    }
    return {
      ...rowSync,
      changed,
      historyMessageCount: historyMessages.length,
      historyMatchedCount: historyMatch.matchedCount,
      historyAmbiguousCount: historyMatch.ambiguousCount,
      historyUnmatchedCount: historyMatch.unmatchedCount,
      historyError,
      autoMatchedCount: groupNickMatch.autoMatchedCount,
      ambiguousCount: groupNickMatch.ambiguousCount,
      accountConflictCount: groupNickMatch.accountConflictCount,
      unmatchedCount: groupNickMatch.unmatchedCount,
    };
  }

  async function runMappingProcessY() {
    if (mappingProcessYTimer && typeof window !== "undefined") {
      window.clearTimeout(mappingProcessYTimer);
      mappingProcessYTimer = null;
    }
    if (mappingProcessYInFlight) {
      mappingProcessYPending = true;
      return await mappingProcessYInFlight;
    }

    const run = async () => {
      let result;
      do {
        mappingProcessYPending = false;
        result = await executeMappingProcessY();
      } while (mappingProcessYPending);
      return result;
    };
    const task = run();
    mappingProcessYInFlight = task;
    try {
      return await task;
    } finally {
      if (mappingProcessYInFlight === task) mappingProcessYInFlight = null;
    }
  }

  function buildMappingPlayersForPappSync(mapping, rosterPlayers) {
    const source = mapping && typeof mapping === "object" ? mapping : {};
    const rows = Array.isArray(source.rows) ? source.rows : [];
    const players = Array.isArray(rosterPlayers) ? rosterPlayers : [];
    const entries = [];
    const countsByCandidateId = new Map();

    rows.forEach((row) => {
      const registrationNick = normalizeWhitespace(row && row.registrationNick);
      if (!registrationNick) return;
      const matches = mappingRowCandidateMatches(row, players);
      if (matches.length !== 1) return;
      const candidatePlayerId = mappingTextId(matches[0] && matches[0].id);
      const mappingRowId = mappingTextId(row && row.id);
      if (!candidatePlayerId || !mappingRowId) return;
      entries.push({
        mappingRowId,
        candidatePlayerId,
        name: registrationNick,
        country: normalizeWhitespace(row && row.oqAccount),
      });
      countsByCandidateId.set(
        candidatePlayerId,
        (countsByCandidateId.get(candidatePlayerId) || 0) + 1,
      );
    });

    return entries.filter(
      (entry) => countsByCandidateId.get(entry.candidatePlayerId) === 1,
    );
  }

  function applyMappingToRoster() {
    const mapping = ensureMappingState();
    const snapshot = captureUndoSnapshot();
    let applied = 0;
    const unmatched = [];
    const ambiguous = [];
    mapping.rows.forEach((row) => {
      const registrationNick = normalizeWhitespace(row.registrationNick);
      const account = normalizeWhitespace(row.oqAccount);
      if (!registrationNick || !account) return;
      const matches = findRosterPlayersForMappingName(registrationNick);
      if (matches.length === 1) {
        matches[0].account = account;
        if (!normalizeWhitespace(matches[0].platform)) matches[0].platform = "oq";
        applied += 1;
      } else if (matches.length === 0) {
        unmatched.push(registrationNick);
      } else {
        ambiguous.push(registrationNick);
      }
    });
    mapping.lastAppliedAt = new Date().toISOString();
    mapping.updatedAt = now();
    refreshCheckinUI();
    scheduleSave();
    const details = [];
    if (unmatched.length) details.push(`未找到签到名单：${unmatched.slice(0, 12).join("、")}`);
    if (ambiguous.length) details.push(`匹配到多个选手：${ambiguous.slice(0, 12).join("、")}`);
    const text = `已写入 ${applied} 行 OQ 账号到签到名单。${details.length ? `\n\n${details.join("\n")}` : ""}`;
    showUndoSnackbar(text, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销刷写签到名单", 2200);
    }, 6500);
  }

  function clearMappingState() {
    const snapshot = captureUndoSnapshot();
    const mapping = ensureMappingState();
    const excludedIds = new Set(
      Array.isArray(mapping.excludedCheckinPlayerIds)
        ? mapping.excludedCheckinPlayerIds.map((id) => mappingTextId(id)).filter(Boolean)
        : [],
    );
    mapping.rows.forEach((row) => {
      const linkedPlayerId = mappingTextId(row && row.checkinPlayerId);
      if (linkedPlayerId) excludedIds.add(linkedPlayerId);
      mappingRowCandidateMatches(row, state.players).forEach((player) => {
        const playerId = mappingTextId(player && player.id);
        if (playerId) excludedIds.add(playerId);
      });
    });
    (Array.isArray(state.players) ? state.players : []).forEach((player) => {
      const playerId = mappingTextId(player && player.id);
      if (playerId) excludedIds.add(playerId);
    });
    state.mapping = {
      ...createDefaultMapping(),
      excludedCheckinPlayerIds: Array.from(excludedIds),
    };
    renderMappingTable();
    scheduleSave();
    showUndoSnackbar("已清除映射表和微信群昵称池", () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销清除映射表", 2200);
    });
  }

  async function exportMappingAsPNG() {
    const mapping = ensureMappingState();
    const rows = mappingRowsForRoster(mapping, state.players);
    if (!rows.length) {
      showAlert("无法导出映射 PNG", "映射表目前没有数据。");
      return;
    }
    setBtnBusy(btnExportMappingPng, true, "生成中…", "导出映射 PNG");
    const filename = `${makeSafeFilename(mapping.groupName || "微信群昵称映射")}_映射表.png`;
    const previewWindow = shouldOpenPNGPreviewWindow() ? openPNGPreviewWindow() : null;
    try {
      const canvas = buildMappingExportCanvasFromData(rows, {
        safeIOS: isIOS(),
      });
      const mode = await saveCanvasAsPNG(canvas, filename, previewWindow);
      notifyPNGResult(mode, isIOS());
    } catch (error) {
      closePNGPreviewWindow(previewWindow);
      showAlert("导出映射 PNG 失败", String(error && error.message ? error.message : error));
    } finally {
      setBtnBusy(btnExportMappingPng, false, "生成中…", "导出映射 PNG");
    }
  }

  function transferSelectedMappingText(registrationNick, oqAccount, selectionStart, selectionEnd) {
    const name = String(registrationNick || "");
    const account = String(oqAccount || "");
    const start = Number(selectionStart);
    const end = Number(selectionEnd);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > name.length
    ) {
      return { ok: false, reason: "empty-selection" };
    }

    const selectedText = normalizeWhitespace(name.slice(start, end));
    if (!selectedText) return { ok: false, reason: "empty-selection" };
    const currentAccount = normalizeWhitespace(account);
    if (currentAccount && normalizeKey(currentAccount) !== normalizeKey(selectedText)) {
      return { ok: false, reason: "account-occupied" };
    }

    return {
      ok: true,
      registrationNick: normalizeWhitespace(name.slice(0, start) + name.slice(end)),
      oqAccount: currentAccount || selectedText,
      selectedText,
    };
  }

  function refreshMappingSelectionAction() {
    if (!mappingTableBody) return;
    const buttons = mappingTableBody.querySelectorAll(
      'button[data-mapping-action="move-selection"]',
    );
    buttons.forEach((button) => {
      button.hidden = true;
    });

    const input = document.activeElement;
    if (
      !input ||
      !input.matches('input[data-mapping-field="registrationNick"]') ||
      !mappingTableBody.contains(input)
    ) {
      return;
    }
    const start = Number(input.selectionStart);
    const end = Number(input.selectionEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return;
    const button = input.closest("tr")?.querySelector(
      'button[data-mapping-action="move-selection"]',
    );
    if (button) button.hidden = false;
  }

  function handleMappingTableSelectionChange() {
    refreshMappingSelectionAction();
  }

  function handleMappingTableMouseDown(event) {
    const target = isElement(event.target) ? event.target : null;
    const button = target && target.closest('button[data-mapping-action="move-selection"]');
    if (button) event.preventDefault();
  }

  function moveSelectedRegistrationTextToOqAccount(button) {
    const rowElement = button.closest("tr");
    const registrationInput = rowElement && rowElement.querySelector(
      'input[data-mapping-field="registrationNick"]',
    );
    const accountInput = rowElement && rowElement.querySelector(
      'input[data-mapping-field="oqAccount"]',
    );
    if (!registrationInput || !accountInput) return;

    const result = transferSelectedMappingText(
      registrationInput.value,
      accountInput.value,
      registrationInput.selectionStart,
      registrationInput.selectionEnd,
    );
    if (!result.ok) {
      if (result.reason === "account-occupied") {
        showSnackbar("OQ 账号栏已有内容，请先确认后再迁移", 3000);
      }
      refreshMappingSelectionAction();
      return;
    }

    registrationInput.value = result.registrationNick;
    registrationInput.dispatchEvent(new Event("input", { bubbles: true }));
    accountInput.value = result.oqAccount;
    accountInput.dispatchEvent(new Event("input", { bubbles: true }));
    accountInput.focus();
    accountInput.setSelectionRange(0, accountInput.value.length);
    showSnackbar(`已将“${result.selectedText}”迁移到 OQ 账号`, 2400);
  }

  function mappingRowForScorePairing(pairing, side) {
    const item = pairing && typeof pairing === "object" ? pairing : {};
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    const papp = metadata.papp && typeof metadata.papp === "object" ? metadata.papp : {};
    const playerId = mappingTextId(
      item[`${side}Id`] || item[`${side}PlayerId`] || papp[`${side}PlayerId`],
    );
    const rows = Array.isArray(ensureMappingState().rows) ? state.mapping.rows : [];
    let matches = playerId
      ? rows.filter((row) => mappingTextId(row && row.checkinPlayerId) === playerId)
      : [];
    if (!matches.length) {
      const name = normalizeKey(item[side] || item[`${side}Name`]);
      if (name) {
        matches = rows.filter((row) =>
          normalizeKey(row && row.registrationNick) === name,
        );
      }
    }
    if (!matches.length) return { found: false, row: null };
    return { found: true, row: matches.length === 1 ? matches[0] : null };
  }

  function clearPairingTranscriptForMappingChange(pairing) {
    const metadata = pairing.metadata && typeof pairing.metadata === "object"
      ? { ...pairing.metadata }
      : {};
    ["gameRecord", "oqRecord", "oqDetail", "transcript", "moves", "board"].forEach((key) => {
      delete metadata[key];
    });
    pairing.metadata = metadata;
    pairing.oqGameId = "";
    pairing.oqGameAvailable = false;
    pairing.oqGameAvailableAt = null;
    pairing.oqGameAvailableAudit = null;
    pairing.oqAutoAudit = null;
  }

  function setScorePairingOqAccount(pairing, side, rawAccount) {
    const account = normalizeWhitespace(rawAccount);
    const current = normalizeWhitespace(pairing[`${side}Account`] || pairing[`${side}OqAccount`]);
    const changed = normalizeKey(current) !== normalizeKey(account);
    pairing[`${side}Account`] = account;
    pairing[`${side}OqAccount`] = account;
    delete pairing[`${side}Username`];
    if (!changed) return false;

    clearPairingTranscriptForMappingChange(pairing);
    const scriptOqResult = pairing.lastEditedBy === "script" &&
      (pairing.resultKind === "oq-auto" || pairing.resultSource === "oq-auto");
    if (scriptOqResult && !isPappReadbackConfirmedPairing(pairing)) {
      pairing.status = "imported";
      pairing.blackScore = null;
      pairing.whiteScore = null;
      pairing.reporter = "";
      pairing.opponent = "";
      pairing.resultKind = "";
      pairing.resultSource = "";
      pairing.sourceMessageKey = "";
      pairing.resultText = "";
      pairing.reason = "";
      pairing.completedAt = null;
      pairing.pappReadbackAt = "";
      pairing.oqUpdatedAt = "";
      pairing.lastEditedBy = "";
      pairing.lastEditedAt = null;
      pairing.updatedAt = null;
    }
    return true;
  }

  function refreshScorePairingAccountsFromMapping() {
    const helper = ensureScoreHelper();
    const stagePairings = helper.rounds.map((round, index) => ({
      stage: "preliminary",
      round: index + 1,
      pairings: Array.isArray(round.pairings) ? round.pairings : [],
      roundData: round,
    }));
    const playoff = ensurePlayoffRegistration();
    stagePairings.push(
      { stage: "semifinal", round: helper.preliminaryRoundCount + 1, pairings: playoff.semifinalPairings },
      { stage: "placement", round: scoreStageRound("placement"), pairings: playoff.placementPairings },
    );
    let changed = false;
    for (const group of stagePairings) {
      const pairings = Array.isArray(group.pairings) ? group.pairings : [];
      for (const pairing of pairings) {
        if (isLegacyScorePairing(pairing) || normalizeWhitespace(pairing.status).toLowerCase() === "bye") continue;
        let accountChanged = false;
        for (const side of ["black", "white"]) {
          const match = mappingRowForScorePairing(pairing, side);
          if (!match.found) continue;
          const row = match.row;
          const registrationNick = normalizeWhitespace(row && row.registrationNick);
          const account = registrationNick && row
            ? normalizeWhitespace(row.oqAccount)
            : "";
          if (registrationNick && normalizeWhitespace(pairing[side] || pairing[`${side}Name`]) !== registrationNick) {
            pairing[side] = registrationNick;
            pairing[`${side}Name`] = registrationNick;
            changed = true;
          }
          if (setScorePairingOqAccount(pairing, side, account)) {
            accountChanged = true;
            changed = true;
          }
        }
        if (accountChanged && group.roundData && Array.isArray(group.roundData.pending)) {
          const pairingId = normalizeWhitespace(pairing.id || pairing.pairingId);
          group.roundData.pending = group.roundData.pending.filter((pending) =>
            isUserPendingScoreItem(pending) ||
            normalizeWhitespace(pending && pending.pairingId) !== pairingId,
          );
        }
      }
    }
    return changed;
  }

  function handleMappingTableInput(event) {
    const target = isElement(event.target) ? event.target : null;
    if (!target) return;
    const row = mappingRowById(target.dataset.mappingRowId);
    const field = String(target.dataset.mappingField || "");
    if (!row || !["wechatNick", "registrationNick", "oqAccount"].includes(field)) return;
    const value = normalizeWhitespace(target.value);
    if (field === "oqAccount" && normalizeKey(row.oqAccount) !== normalizeKey(value)) {
      row.oqCheck = sanitizeMappingCheck(null);
    }
    row[field] = value;
    const checkinPlayerChanged = syncMappingFieldToCheckinPlayer(
      row,
      field,
      state.players,
    );
    if (checkinPlayerChanged && field === "registrationNick") {
      state.players.sort(comparePlayersForList);
    }
    if (field === "wechatNick") row.wechatNickSource = "manual";
    const mappingRowElement = target.closest("tr[data-mapping-row-id]");
    const groupNickInput = field === "wechatNick"
      ? target
      : mappingRowElement &&
        mappingRowElement.querySelector('input[data-mapping-field="wechatNick"]');
    updateMappingGroupNickWarningInput(groupNickInput, row);
    ensureMappingState().updatedAt = now();
    refreshScorePairingAccountsFromMapping();
    refreshMappingSummary();
    refreshMappingSelectionAction();
    scheduleSave();
  }

  function handleMappingTableClick(event) {
    const target = isElement(event.target) ? event.target : null;
    const button = target && target.closest("button[data-mapping-action]");
    if (!button) return;
    if (button.dataset.mappingAction === "move-selection") {
      moveSelectedRegistrationTextToOqAccount(button);
      return;
    }
    if (button.dataset.mappingAction === "toggle-script-lock") {
      const rowId = String(button.dataset.mappingRowId || "");
      const row = mappingRowById(rowId);
      if (!row) return;
      row.scriptLocked = row.scriptLocked !== true;
      ensureMappingState().updatedAt = now();
      renderMappingTable();
      scheduleSave();
      showSnackbar(
        row.scriptLocked
          ? `已锁定“${row.registrationNick || row.wechatNick || "未命名选手"}”的三个映射字段`
          : `已解除“${row.registrationNick || row.wechatNick || "未命名选手"}”的脚本锁`,
        2400,
      );
      return;
    }
    if (button.dataset.mappingAction !== "delete") return;
    const rowId = String(button.dataset.mappingRowId || "");
    const row = mappingRowById(rowId);
    if (!row) return;
    const snapshot = captureUndoSnapshot();
    const mapping = ensureMappingState();
    const excludedIds = new Set(
      Array.isArray(mapping.excludedCheckinPlayerIds)
        ? mapping.excludedCheckinPlayerIds.map((id) => mappingTextId(id)).filter(Boolean)
        : [],
    );
    const linkedPlayerId = mappingTextId(row.checkinPlayerId);
    if (linkedPlayerId) excludedIds.add(linkedPlayerId);
    mappingRowCandidateMatches(row, state.players).forEach((player) => {
      const playerId = mappingTextId(player && player.id);
      if (playerId) excludedIds.add(playerId);
    });
    mapping.excludedCheckinPlayerIds = Array.from(excludedIds);
    mapping.rows = mapping.rows.filter((item) => String(item.id) !== rowId);
    mapping.updatedAt = now();
    renderMappingTable();
    scheduleSave();
    showUndoSnackbar(`已删除映射行：${row.registrationNick || row.wechatNick || "未命名"}`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销删除映射行", 2200);
    });
  }

  function refreshCheckinUI() {
    updateCheckinViewVisibility();
    if (state.ui && state.ui.checkinView === "mapping") {
      renderMappingTable();
      return;
    }
    renderGroupFilter();
    applyModeClasses();

    // 只计算一次 visible players，避免重复调用
    const visiblePlayers = getVisiblePlayers();

    updateStats(visiblePlayers);
    renderPlayerList(visiblePlayers);
  }

  // ------------------------------
  // Suspects (疑似重复/疑似异常) panel
  // - 在导入完成后自动提示一次（可关闭）
  // - 也可通过“检查重复”手动打开
  // ------------------------------
  const SUSPECTS_PREF_KEY = "checkin_assistant_suspects_auto_v1";
  const SUSPECTS_LAST_HASH_KEY = "checkin_assistant_suspects_last_hash_v1";

  function normalizeForSimilarity(str) {
    // Keep chinese + letters + digits, remove most separators.
    // This helps catch duplicates like "WangGang" vs "Wang Gang" vs "Wang-Gang".
    return normalizeWhitespace(str || "")
      .toLowerCase()
      .replace(
        /[\s\u2000-\u206F\u2E00-\u2E7F'"“”‘’`·•・\.,，。:：;；!?！？、\/\\\-_=\(\)\[\]\{\}<>《》【】（）]+/g,
        "",
      );
  }

  function looksLikeHandleStyle(text) {
    const t = normalizeWhitespace(text || "");
    if (!t) return false;
    if (t.includes(" ")) return false;
    if (/^\d{3,10}$/.test(t)) return true;
    if (tokenIsAsciiLike(t) && /[0-9_]/.test(t) && t.length >= 3) return true;
    return false;
  }

  function makeBigrams(str) {
    const s = String(str || "");
    if (!s) return [];
    if (s.length === 1) return [s];
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  }

  function diceSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const A = makeBigrams(a);
    const B = makeBigrams(b);
    if (!A.length || !B.length) return 0;

    const map = new Map();
    for (const g of A) map.set(g, (map.get(g) || 0) + 1);

    let inter = 0;
    for (const g of B) {
      const c = map.get(g) || 0;
      if (c > 0) {
        inter++;
        if (c === 1) map.delete(g);
        else map.set(g, c - 1);
      }
    }

    return (2 * inter) / (A.length + B.length);
  }

  function computeSuspectReport(
    players,
    { limitPairs = 80, limitAnomalies = 80 } = {},
  ) {
    const list = Array.isArray(players) ? players : [];

    const pairMap = new Map(); // key -> {a,b,reasons[], kinds:Set, score}
    const anomalies = [];

    // --- anomalies ---
    for (const p of list) {
      if (!p) continue;
      const reasons = [];

      const nameRaw = normalizeWhitespace(p.displayName);
      const nameNorm = normalizeForSimilarity(nameRaw);
      const accRaw = normalizeWhitespace(p.account);
      const accNorm = normalizeForSimilarity(accRaw);
      const group = normalizeWhitespace(p.group) || "未分组";
      const plat = normalizeWhitespace(p.platform || "");

      if (!nameRaw) reasons.push("昵称为空");
      if (nameRaw && nameRaw.length > 24) reasons.push("昵称过长");
      if (nameRaw && nameRaw.length < 2) reasons.push("昵称过短");

      // Account-related heuristics (OQ账号通常为字母/数字/下划线)
      if (plat === "oq" && accRaw && tokenHasChinese(accRaw)) {
        reasons.push("OQ账号包含中文（可能粘贴错列）");
      }

      // "Surname + account" often means only 姓 was provided, missing full name pinyin.
      if (
        plat === "oq" &&
        accRaw &&
        !String(group).includes("长期") &&
        looksLikeRomanizedSurnameOnly(nameRaw) &&
        tokenLooksLikeAccount(accRaw, plat) >= 2
      ) {
        reasons.push("昵称疑似仅填写姓氏（建议补全姓名拼音）");
      }

      // Missing account (exclude long-term club list)
      if (!accRaw && plat && !String(group).includes("长期")) {
        if (plat === "oq") reasons.push("未填写账号");
        else if (plat === "vint")
          reasons.push("未填写账号（vint 组可人工确认）");
        else reasons.push("未填写账号");
      }

      // Name looks like handle but account is empty -> likely column mismatch (OQ only)
      if (
        !accRaw &&
        plat === "oq" &&
        !String(group).includes("长期") &&
        looksLikeHandleStyle(nameRaw)
      ) {
        reasons.push("昵称形态更像账号（可能错列）");
      }

      // Name/account look effectively identical -> likely duplicated paste.
      // For vint, nickname==账号 is relatively common and lower-signal, so skip.
      if (
        nameNorm &&
        accNorm &&
        nameNorm.length >= 4 &&
        nameNorm === accNorm &&
        plat !== "vint"
      ) {
        reasons.push("昵称与账号几乎相同（可能重复粘贴）");
      }

      // suspicious keywords accidentally included as player
      if (
        nameNorm &&
        instructionKeywords.some((k) =>
          nameNorm.includes(normalizeForSimilarity(k)),
        )
      ) {
        reasons.push("昵称疑似包含说明文字");
      }

      const uniqueReasons = Array.from(new Set(reasons));
      if (uniqueReasons.length) {
        let severity = "low";
        if (
          uniqueReasons.includes("昵称为空") ||
          uniqueReasons.includes("昵称疑似包含说明文字")
        ) {
          severity = "high";
        } else if (
          uniqueReasons.includes("OQ账号包含中文（可能粘贴错列）") ||
          uniqueReasons.includes("未填写账号") ||
          uniqueReasons.includes("昵称形态更像账号（可能错列）") ||
          uniqueReasons.includes("昵称疑似仅填写姓氏（建议补全姓名拼音）")
        ) {
          severity = "medium";
        }

        anomalies.push({
          id: p.id,
          displayName: p.displayName || "",
          group,
          platform: plat,
          account: p.account || "",
          reasons: uniqueReasons,
          severity,
        });
      }
    }

    // --- duplicates / similarity pairs ---
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (!a) continue;
      const aNameRaw = normalizeWhitespace(a.displayName);
      const aName = normalizeForSimilarity(aNameRaw);
      const aAccRaw = normalizeWhitespace(a.account);
      const aAcc = normalizeForSimilarity(aAccRaw);
      const aPlat = normalizeWhitespace(a.platform || "");

      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (!b) continue;

        const bNameRaw = normalizeWhitespace(b.displayName);
        const bName = normalizeForSimilarity(bNameRaw);
        const bAccRaw = normalizeWhitespace(b.account);
        const bAcc = normalizeForSimilarity(bAccRaw);
        const bPlat = normalizeWhitespace(b.platform || "");
        const bothNoAccount = !aAcc && !bAcc;

        const key = `${a.id}|${b.id}`;
        let entry = null;

        const addPair = (reason, score, kind = "generic") => {
          entry = entry ||
            pairMap.get(key) || {
              a,
              b,
              reasons: [],
              kinds: new Set(),
              score: 0,
            };
          if (reason && !entry.reasons.includes(reason))
            entry.reasons.push(reason);
          entry.kinds.add(kind);
          entry.score = Math.max(entry.score, score);
          pairMap.set(key, entry);
        };

        // Name similarity
        if (aName && bName) {
          const maxLen = Math.max(aName.length, bName.length);
          const minLen = Math.min(aName.length, bName.length);

          if (aName === bName) {
            // Same after normalization
            if (aNameRaw !== bNameRaw) {
              addPair(
                "昵称规范化后相同",
                bothNoAccount ? 0.96 : 1,
                "name_exact",
              );
            } else {
              addPair(
                "昵称完全相同",
                bothNoAccount ? 0.96 : 0.99,
                "name_exact_raw",
              );
              if (aAcc && bAcc && aAcc !== bAcc) {
                addPair("同名但账号不同", 0.99, "name_account_conflict");
              }
              if (aPlat && bPlat && aPlat !== bPlat) {
                addPair("同名但平台不同", 0.97, "name_platform_conflict");
              }
            }
          } else if (maxLen >= 4 && minLen >= 3) {
            const sim = diceSimilarity(aName, bName);
            // Threshold tuned for short names to reduce false positives
            let threshold = maxLen >= 10 ? 0.88 : maxLen >= 7 ? 0.9 : 0.93;
            if (bothNoAccount) threshold = Math.min(0.98, threshold + 0.05);
            if (sim >= threshold)
              addPair(
                `昵称相似度 ${(sim * 100).toFixed(0)}%`,
                sim,
                "name_similar",
              );
          }
        }

        // Account similarity
        if (aAcc && bAcc) {
          const maxLen = Math.max(aAcc.length, bAcc.length);
          const minLen = Math.min(aAcc.length, bAcc.length);

          if (aAcc === bAcc) {
            // Same normalized account
            if (aAccRaw !== bAccRaw)
              addPair("账号规范化后相同", 1, "account_exact");
            else addPair("账号完全相同", 1, "account_exact_raw");
            // If the same account appears with different *raw* nicknames (even if they normalize
            // to the same form), it's still worth surfacing to help the user cleanup.
            if (aNameRaw && bNameRaw && aNameRaw !== bNameRaw) {
              addPair("同账号但昵称不同", 1, "account_name_conflict");
            }
            if (aPlat && bPlat && aPlat !== bPlat)
              addPair("账号相同但平台不同", 0.98, "account_cross_platform");
          } else if (maxLen >= 5 && minLen >= 4) {
            const sim = diceSimilarity(aAcc, bAcc);
            const threshold = maxLen >= 10 ? 0.88 : maxLen >= 7 ? 0.9 : 0.93;
            if (sim >= threshold)
              addPair(
                `账号相似度 ${(sim * 100).toFixed(0)}%`,
                sim,
                "account_similar",
              );
          }
        }
      }
    }

    const pairs = Array.from(pairMap.values()).map((it) => {
      const kinds = Array.from(it.kinds || []);
      const hasAccountExact =
        kinds.includes("account_exact") || kinds.includes("account_exact_raw");
      const hasStrongAccountSimilar =
        kinds.includes("account_similar") && Number(it.score || 0) >= 0.97;
      const hasCrossPlatform = kinds.includes("account_cross_platform");
      const hasNameConflict =
        kinds.includes("name_account_conflict") ||
        kinds.includes("name_platform_conflict");
      const hasAccountNameConflict = kinds.includes("account_name_conflict");
      const hasNameExact =
        kinds.includes("name_exact") || kinds.includes("name_exact_raw");
      const highConfidence =
        hasAccountExact ||
        hasStrongAccountSimilar ||
        hasNameConflict ||
        hasAccountNameConflict;
      // Cross-platform same account is useful, but often less certain than same-platform exact match.
      const mediumConfidence =
        !highConfidence && (hasCrossPlatform || hasNameExact);
      return {
        a: it.a,
        b: it.b,
        reasons: Array.isArray(it.reasons)
          ? Array.from(new Set(it.reasons))
          : [],
        score: Number(it.score || 0),
        kinds,
        highConfidence,
        mediumConfidence,
      };
    });
    pairs.sort((x, y) => (y.score || 0) - (x.score || 0));

    const highConfidencePairs = pairs.filter((p) => p.highConfidence);
    const mediumConfidencePairs = pairs.filter((p) => p.mediumConfidence);
    const crossPlatformPairs = pairs.filter(
      (p) =>
        Array.isArray(p.kinds) && p.kinds.includes("account_cross_platform"),
    );
    const highConflictPairs = highConfidencePairs.filter((p) => {
      const kinds = Array.isArray(p && p.kinds) ? p.kinds : [];
      return (
        kinds.includes("name_account_conflict") ||
        kinds.includes("account_name_conflict") ||
        (kinds.includes("account_similar") && Number(p.score || 0) >= 0.97)
      );
    });
    const highExactDuplicatePairs = highConfidencePairs.filter((p) => {
      const kinds = Array.isArray(p && p.kinds) ? p.kinds : [];
      const hasAccountExact =
        kinds.includes("account_exact") || kinds.includes("account_exact_raw");
      if (!hasAccountExact) return false;
      if (
        kinds.includes("name_account_conflict") ||
        kinds.includes("account_name_conflict")
      )
        return false;
      return true;
    });
    const highSeverityAnomalies = anomalies.filter(
      (a) => a.severity === "high",
    );
    const mediumSeverityAnomalies = anomalies.filter(
      (a) => a.severity === "medium",
    );
    const severityWeight = { high: 3, medium: 2, low: 1 };
    anomalies.sort((a, b) => {
      const sa = severityWeight[a.severity] || 0;
      const sb = severityWeight[b.severity] || 0;
      if (sa !== sb) return sb - sa;
      return nameCollator.compare(
        String(a.displayName || ""),
        String(b.displayName || ""),
      );
    });

    // Auto prompt strategy:
    // - Always prompt for high-confidence conflict pairs (账号/昵称冲突等强信号).
    // - High-confidence exact duplicates only trigger when they are dense enough
    //   (to reduce single-pair noise on large lists).
    // - Always prompt for obvious high-severity anomalies.
    // - Medium-severity anomalies only trigger auto prompt when they are dense enough.
    // - Cross-platform same-account pairs are treated as medium confidence; prompt only when they are dense.
    const mediumReasonBuckets = new Set();
    let mediumMissingAccountCount = 0;
    for (const item of mediumSeverityAnomalies) {
      const reasons = Array.isArray(item && item.reasons) ? item.reasons : [];
      for (const reason of reasons) {
        const text = String(reason || "");
        if (!text) continue;
        if (text.includes("未填写账号")) {
          mediumReasonBuckets.add("missing_account");
          mediumMissingAccountCount++;
          continue;
        }
        if (text.includes("错列") || text.includes("包含中文")) {
          mediumReasonBuckets.add("column_mismatch");
          continue;
        }
        mediumReasonBuckets.add("other");
      }
    }

    const mediumThreshold = list.length <= 20 ? 4 : list.length <= 40 ? 5 : 6;
    const mediumRatioThreshold =
      list.length <= 20 ? 0.28 : list.length <= 40 ? 0.2 : 0.15;
    const mediumRatio =
      mediumSeverityAnomalies.length / Math.max(1, list.length);
    const mediumMissingRatio =
      mediumMissingAccountCount / Math.max(1, list.length);
    const mediumDiverse =
      mediumReasonBuckets.size >= 2 ||
      !mediumReasonBuckets.has("missing_account");
    const mediumMissingDominant =
      mediumSeverityAnomalies.length > 0 &&
      mediumMissingAccountCount / Math.max(1, mediumSeverityAnomalies.length) >=
        0.85;
    const mediumHasActionableReason =
      mediumReasonBuckets.has("column_mismatch") ||
      mediumReasonBuckets.has("other");
    const mediumAllowedByMissingOnly =
      mediumMissingRatio >= 0.5 &&
      mediumSeverityAnomalies.length >= mediumThreshold + 2;
    const mediumTriggerQualityOk =
      !mediumMissingDominant ||
      (mediumHasActionableReason &&
        mediumSeverityAnomalies.length >= mediumThreshold + 1);
    const mediumOnlyTrigger =
      list.length >= 8 &&
      highConfidencePairs.length === 0 &&
      highSeverityAnomalies.length === 0 &&
      mediumSeverityAnomalies.length >= mediumThreshold &&
      mediumRatio >= mediumRatioThreshold &&
      (mediumHasActionableReason ||
        mediumAllowedByMissingOnly ||
        mediumDiverse) &&
      mediumTriggerQualityOk;

    const mediumDuplicatePairs = mediumConfidencePairs.filter((p) => {
      const kinds = Array.isArray(p && p.kinds) ? p.kinds : [];
      return !kinds.includes("account_cross_platform");
    });
    // Similar-name pairs are useful hints but often produce false positives,
    // especially for拼音/短昵称. To reduce noisy auto-popups, we exclude *pure*
    // “name_similar only” pairs from the *auto-trigger* calculation, while still
    // keeping them in the report list.
    const mediumDuplicatePairsForAuto = mediumDuplicatePairs.filter((p) => {
      const kinds = Array.isArray(p && p.kinds) ? p.kinds : [];
      return !(kinds.length === 1 && kinds[0] === "name_similar");
    });
    const mediumDupThreshold =
      list.length <= 20 ? 2 : list.length <= 40 ? 3 : 4;
    const mediumDupRatioThreshold =
      list.length <= 20 ? 0.1 : list.length <= 40 ? 0.08 : 0.06;
    const mediumDuplicateOnlyTrigger =
      list.length >= 8 &&
      highConfidencePairs.length === 0 &&
      highSeverityAnomalies.length === 0 &&
      mediumDuplicatePairsForAuto.length >= mediumDupThreshold &&
      mediumDuplicatePairsForAuto.length / Math.max(1, list.length) >=
        mediumDupRatioThreshold;

    const crossPlatformThreshold = Math.max(3, Math.ceil(list.length * 0.12));
    const crossPlatformRatio =
      crossPlatformPairs.length / Math.max(1, list.length);
    const crossPlatformOnlyTrigger =
      highConfidencePairs.length === 0 &&
      highSeverityAnomalies.length === 0 &&
      crossPlatformPairs.length >= crossPlatformThreshold &&
      crossPlatformRatio >= 0.12;

    const highExactDupMin = list.length <= 24 ? 1 : list.length <= 80 ? 2 : 3;
    const highExactDupRatioMin =
      list.length <= 24 ? 0 : list.length <= 80 ? 0.05 : 0.04;
    const highExactDupRatio =
      highExactDuplicatePairs.length / Math.max(1, list.length);
    const highExactDuplicateOnlyTrigger =
      highExactDuplicatePairs.length >= highExactDupMin &&
      (highExactDupRatioMin === 0 || highExactDupRatio >= highExactDupRatioMin);

    // Auto-prompt high confidence when conflict is clear (账号/昵称冲突),
    // or when exact duplicates are dense enough (to reduce single-pair noise on large lists).
    const highConfidenceTrigger =
      highConflictPairs.length > 0 || highExactDuplicateOnlyTrigger;

    const autoPromptRecommended =
      highConfidenceTrigger ||
      highSeverityAnomalies.length > 0 ||
      mediumOnlyTrigger ||
      mediumDuplicateOnlyTrigger ||
      crossPlatformOnlyTrigger;

    // Limit output to keep UI responsive on very large lists
    const limitedPairs = pairs.slice(0, limitPairs);
    const limitedAnom = anomalies.slice(0, limitAnomalies);

    return {
      totalPlayers: list.length,
      duplicatePairs: limitedPairs,
      duplicatePairsTotal: pairs.length,
      anomalies: limitedAnom,
      anomaliesTotal: anomalies.length,
      highConfidencePairsTotal: highConfidencePairs.length,
      highConflictPairsTotal: highConflictPairs.length,
      highExactDuplicatePairsTotal: highExactDuplicatePairs.length,
      mediumConfidencePairsTotal: mediumConfidencePairs.length,
      mediumDuplicatePairsTotal: mediumDuplicatePairs.length,
      crossPlatformPairsTotal: crossPlatformPairs.length,
      highSeverityAnomaliesTotal: highSeverityAnomalies.length,
      mediumSeverityAnomaliesTotal: mediumSeverityAnomalies.length,
      autoPromptRecommended,
    };
  }

  function reopenSuspectsDialogFromCurrentState() {
    const report = computeSuspectReport(
      state && Array.isArray(state.players) ? state.players : [],
    );
    showSuspectsDialog(report, { allowDisableAuto: true });
  }

  function openEditPlayerFromSuspects(playerId) {
    const id = Number(playerId);
    if (!Number.isFinite(id)) return;
    if (!getPlayerById(id)) {
      showSnackbar("该选手已不存在，请刷新后重试", 2200);
      return;
    }
    showEditPlayerDialog(id, {
      onReturnToSuspects: reopenSuspectsDialogFromCurrentState,
    });
  }

  function buildSuspectsPanel(report) {
    const root = document.createElement("div");
    root.className = "suspects-panel import-preview";
    root.style.whiteSpace = "normal";

    const title = document.createElement("div");
    title.className = "import-summary__title";
    title.textContent = `疑似重复：${report.duplicatePairsTotal} 对 · 疑似异常：${report.anomaliesTotal} 条`;

    const sub = document.createElement("div");
    sub.className = "import-summary__sub";
    sub.textContent = `说明：以下为自动检测结果（仅供参考，可能误判）。高置信重复 ${report.highConfidencePairsTotal || 0} 对，中置信重复 ${report.mediumDuplicatePairsTotal || report.mediumConfidencePairsTotal || 0} 对，跨平台同账号 ${report.crossPlatformPairsTotal || 0} 对，高优先异常 ${report.highSeverityAnomaliesTotal || 0} 条。点击下方选手名称可直接编辑并保存。`;

    root.appendChild(title);
    root.appendChild(sub);

    // Duplicate pairs
    const dupDetails = document.createElement("details");
    dupDetails.className = "import-ignored";
    dupDetails.open = report.duplicatePairsTotal > 0;

    const dupSummary = document.createElement("summary");
    dupSummary.className = "import-ignored__summary";
    const dupLeft = document.createElement("div");
    dupLeft.className = "import-ignored__summary-left";
    const dupIcon = document.createElement("svg");
    dupIcon.className = "ms-icon import-ignored__chev";
    dupIcon.setAttribute("aria-hidden", "true");
    dupIcon.innerHTML = '<use href="#i-expand-more"></use>';
    const dupT = document.createElement("div");
    dupT.className = "import-ignored__title";
    dupT.textContent = `疑似重复/相似（展示 ${report.duplicatePairs.length} / ${report.duplicatePairsTotal}）`;
    const dupH = document.createElement("div");
    dupH.className = "import-ignored__hint";
    dupH.textContent = "点击展开/收起";
    dupLeft.appendChild(dupIcon);
    dupLeft.appendChild(dupT);
    dupLeft.appendChild(dupH);
    dupSummary.appendChild(dupLeft);
    dupDetails.appendChild(dupSummary);

    const dupPanel = document.createElement("div");
    dupPanel.className = "import-ignored__panel";

    if (report.duplicatePairsTotal === 0) {
      const p = document.createElement("div");
      p.className = "suspects-empty";
      p.textContent = "未发现明显重复。";
      dupPanel.appendChild(p);
    } else {
      report.duplicatePairs.forEach((it) => {
        const row = document.createElement("div");
        row.className = "suspect-row";
        if (it && it.highConfidence) row.classList.add("suspect-row--high");
        else if (
          it &&
          Array.isArray(it.kinds) &&
          it.kinds.includes("account_cross_platform")
        )
          row.classList.add("suspect-row--cross");

        const main = document.createElement("div");
        main.className = "suspect-row__main suspect-row__main--pair";

        const aBtn = document.createElement("button");
        aBtn.type = "button";
        aBtn.className = "suspect-row__player-btn";
        aBtn.textContent =
          normalizeWhitespace(it && it.a && it.a.displayName) || "（空昵称）";
        aBtn.title = "点击编辑该选手";
        aBtn.addEventListener("click", () => {
          openEditPlayerFromSuspects(it && it.a && it.a.id);
        });

        const sep = document.createElement("span");
        sep.className = "suspect-row__sep";
        sep.textContent = "↔";

        const bBtn = document.createElement("button");
        bBtn.type = "button";
        bBtn.className = "suspect-row__player-btn";
        bBtn.textContent =
          normalizeWhitespace(it && it.b && it.b.displayName) || "（空昵称）";
        bBtn.title = "点击编辑该选手";
        bBtn.addEventListener("click", () => {
          openEditPlayerFromSuspects(it && it.b && it.b.id);
        });

        main.appendChild(aBtn);
        main.appendChild(sep);
        main.appendChild(bBtn);

        const meta = document.createElement("div");
        meta.className = "suspect-row__meta";

        const aInfo = [];
        if (it.a.group) aInfo.push(it.a.group);
        if (it.a.platform) aInfo.push(String(it.a.platform).toUpperCase());
        if (it.a.account) aInfo.push(it.a.account);

        const bInfo = [];
        if (it.b.group) bInfo.push(it.b.group);
        if (it.b.platform) bInfo.push(String(it.b.platform).toUpperCase());
        if (it.b.account) bInfo.push(it.b.account);

        meta.textContent = `${it.reasons.join(" · ")} · A：${aInfo.join(" / ") || "（无）"} · B：${bInfo.join(" / ") || "（无）"}`;

        row.appendChild(main);
        row.appendChild(meta);
        dupPanel.appendChild(row);
      });
    }

    dupDetails.appendChild(dupPanel);
    root.appendChild(dupDetails);

    // Anomalies
    const anDetails = document.createElement("details");
    anDetails.className = "import-ignored";
    anDetails.open = report.anomaliesTotal > 0;

    const anSummary = document.createElement("summary");
    anSummary.className = "import-ignored__summary";
    const anLeft = document.createElement("div");
    anLeft.className = "import-ignored__summary-left";
    const anIcon = document.createElement("svg");
    anIcon.className = "ms-icon import-ignored__chev";
    anIcon.setAttribute("aria-hidden", "true");
    anIcon.innerHTML = '<use href="#i-expand-more"></use>';
    const anT = document.createElement("div");
    anT.className = "import-ignored__title";
    anT.textContent = `疑似异常（展示 ${report.anomalies.length} / ${report.anomaliesTotal}）`;
    const anH = document.createElement("div");
    anH.className = "import-ignored__hint";
    anH.textContent = "点击展开/收起";
    anLeft.appendChild(anIcon);
    anLeft.appendChild(anT);
    anLeft.appendChild(anH);
    anSummary.appendChild(anLeft);
    anDetails.appendChild(anSummary);

    const anPanel = document.createElement("div");
    anPanel.className = "import-ignored__panel";

    if (report.anomaliesTotal === 0) {
      const p = document.createElement("div");
      p.className = "suspects-empty";
      p.textContent = "未发现明显异常。";
      anPanel.appendChild(p);
    } else {
      report.anomalies.forEach((it) => {
        const row = document.createElement("div");
        row.className = "suspect-row";
        if (it && it.severity === "high")
          row.classList.add("suspect-row--high");
        else if (it && it.severity === "medium")
          row.classList.add("suspect-row--mid");

        const main = document.createElement("button");
        main.type = "button";
        main.className =
          "suspect-row__main suspect-row__player-btn suspect-row__player-btn--solo";
        main.textContent = it.displayName || "（空昵称）";
        main.title = "点击编辑该选手";
        main.addEventListener("click", () => {
          openEditPlayerFromSuspects(it && it.id);
        });

        const meta = document.createElement("div");
        meta.className = "suspect-row__meta";
        const info = [];
        if (it.group) info.push(it.group);
        if (it.platform) info.push(String(it.platform).toUpperCase());
        if (it.account) info.push(it.account);
        meta.textContent = `${it.reasons.join(" · ")} · ${info.join(" / ")}`;

        row.appendChild(main);
        row.appendChild(meta);
        anPanel.appendChild(row);
      });
    }

    anDetails.appendChild(anPanel);
    root.appendChild(anDetails);

    return root;
  }

  function showSuspectsDialog(report, { allowDisableAuto = true } = {}) {
    const panel = buildSuspectsPanel(report);

    const buttons = [];
    if (allowDisableAuto) {
      buttons.push({
        label: "不再自动提示",
        className: "btn btn-outlined",
        onClick: () => {
          safeLocalStorageSet(SUSPECTS_PREF_KEY, "1");
          showSnackbar("已关闭自动提示（仍可手动点击“检查重复”查看）", 2600);
        },
      });
    }

    buttons.push({ label: "关闭", className: "btn btn-filled" });

    showDialog({
      title: "疑似重复/异常提示",
      contentNode: panel,
      buttons,
    });
  }

  function buildSuspectsStateHash(players) {
    const list = Array.isArray(players) ? players : [];
    const raw = list
      .map((p) => {
        const name = normalizeForSimilarity(p && p.displayName);
        const acc = normalizeForSimilarity(p && p.account);
        const grp = normalizeForSimilarity(p && p.group);
        const plat = normalizeForSimilarity(p && p.platform);
        return `${name}|${acc}|${grp}|${plat}`;
      })
      .sort()
      .join("\n");

    // Simple deterministic hash (djb2 variant)
    let h = 5381;
    for (let i = 0; i < raw.length; i++) {
      h = ((h << 5) + h) ^ raw.charCodeAt(i);
    }
    return String(h >>> 0);
  }

  function shouldSoftHintForLargeSuspectsReport(report, players) {
    const list = Array.isArray(players) ? players : [];
    if (!report || list.length < 70) return false;
    if ((report.highSeverityAnomaliesTotal || 0) > 0) return false;

    const highPairs = Number(report.highConfidencePairsTotal || 0);
    const duplicatePairs = Number(report.duplicatePairsTotal || 0);
    const mediumAnomalies = Number(report.mediumSeverityAnomaliesTotal || 0);

    const isVeryLarge = list.length >= 120;
    const highPairMin = isVeryLarge ? 45 : 18;
    const duplicatePairMin = isVeryLarge ? 60 : 24;
    const highPairRatioMin = isVeryLarge ? 0.22 : 0.2;
    const duplicatePairRatioMin = isVeryLarge ? 0.3 : 0.28;
    const mediumAnomalyMax = isVeryLarge
      ? Math.max(10, Math.floor(list.length * 0.08))
      : Math.max(6, Math.floor(list.length * 0.06));

    if (highPairs < highPairMin || duplicatePairs < duplicatePairMin)
      return false;
    if (highPairs / Math.max(1, list.length) < highPairRatioMin) return false;
    if (duplicatePairs / Math.max(1, list.length) < duplicatePairRatioMin)
      return false;
    if (mediumAnomalies > mediumAnomalyMax) return false;

    const groupCounter = new Map();
    for (const p of list) {
      const g = normalizeWhitespace(p && p.group) || "未分组";
      groupCounter.set(g, (groupCounter.get(g) || 0) + 1);
    }
    const groupCountMin = isVeryLarge ? 4 : 3;
    if (groupCounter.size < groupCountMin) return false;

    const counts = Array.from(groupCounter.values()).sort((a, b) => b - a);
    const sizeableGroups = counts.filter((c) => c >= 12).length;
    const maxGroup = counts[0] || 0;
    const sizeableGroupMin = isVeryLarge ? 4 : 3;
    const dominanceLimit = isVeryLarge ? 0.55 : 0.65;

    // Typical archive-like import: many sizeable groups, no single group dominates.
    return (
      sizeableGroups >= sizeableGroupMin &&
      maxGroup <= Math.floor(list.length * dominanceLimit)
    );
  }

  function maybeAutoShowSuspectsAfterImport() {
    try {
      if (safeLocalStorageGet(SUSPECTS_PREF_KEY) === "1") return;
      if (!state || !Array.isArray(state.players) || state.players.length < 2)
        return;

      const report = computeSuspectReport(state.players);
      if (
        (report.duplicatePairsTotal || 0) === 0 &&
        (report.anomaliesTotal || 0) === 0
      )
        return;
      if (!report.autoPromptRecommended) return;

      const currentHash = buildSuspectsStateHash(state.players);
      if (lastAutoSuspectHash === currentHash) return;
      const lastHashFromStorage = safeLocalStorageGet(SUSPECTS_LAST_HASH_KEY);
      if (lastHashFromStorage && lastHashFromStorage === currentHash) return;
      lastAutoSuspectHash = currentHash;
      safeLocalStorageSet(SUSPECTS_LAST_HASH_KEY, currentHash);

      if (shouldSoftHintForLargeSuspectsReport(report, state.players)) {
        showSnackbar(
          "已检测到较多疑似重复记录；本次不自动弹窗，可按需点击“检查重复”查看。",
          3600,
        );
        return;
      }

      showSuspectsDialog(report, { allowDisableAuto: true });
    } catch (e) {
      console.warn("疑似重复提示生成失败：", e);
    }
  }

  // ------------------------------
  // Import / step actions
  // ------------------------------
  function detectCompetitionNameFromRelay(relayText) {
    const relayLines = String(relayText || "").split("\n");
    const titleLine = relayLines.find((line) => {
      const s = String(line || "");
      return s.includes("比赛报名接龙") || s.includes("比赛报名接龍");
    });
    const detectedCompetitionName = titleLine
      ? normalizeWhitespace(
          titleLine
            .replace(/#接龍|#接龙/g, "")
            .replace(/比赛报名接龙|比赛报名接龍/g, ""),
        )
      : "比赛签到表";
    return detectedCompetitionName || "比赛签到表";
  }

  function processImport() {
    try {
      const relayImportContext = pendingWechatRelayImport;
      if (
        relayImportContext &&
        (relayImportContext.groupUsername !== wechatRelayGroupIdentity() ||
          relayImportContext.deadlineMs !== relaySyncDeadlineMs())
      ) {
        wechatRelayReferenceStatusText = "比赛群聊或签到截至时间已更改，请重新引用聊天记录后再导入。";
        updateWechatRelayReferenceUI();
        showDialog({
          title: "请重新引用接龙",
          message: "群聊或签到截至时间已更改。请重新引用截止时间前最近的接龙，再确认导入。",
          buttons: [{ label: "好的", className: "btn btn-filled" }],
        });
        return;
      }
      const clubText =
        clubMembersEl && typeof clubMembersEl.value === "string"
          ? clubMembersEl.value
          : "";
      const relayText =
        relayInfoEl && typeof relayInfoEl.value === "string"
          ? relayInfoEl.value
          : "";
      state.groupRules = readGroupRulesFromEditor();

      // Persist current pasted text (for refresh/restore)
      state.clubText = clubText;
      state.relayText = relayText;
      scheduleSave();

      const detectedCompetitionName = detectCompetitionNameFromRelay(relayText);
      const result = parseImportTextsDetailed(clubText, relayText);

      if (!result.players || result.players.length === 0) {
        showDialog({
          title: "导入失败",
          message:
            buildImportReportText(result) ||
            "未能解析到任何有效的选手名称，请检查输入内容。",
          buttons: [{ label: "好的", className: "btn btn-filled" }],
        });
        return;
      }

      // Preview + correction UI
      const previewNode = buildImportPreviewNode(result);

      showDialog({
        title: "导入预览（可纠错）",
        contentNode: previewNode,
        buttons: [
          { label: "返回修改", className: "btn btn-outlined" },
          {
            label: "开始签到",
            className: "btn btn-filled",
            onClick: async () => {
              const mergedPlayers = applyImportWithCorrections(
                result,
                previewNode,
              );
              if (!mergedPlayers || mergedPlayers.length === 0) return;

              // Reset ids with new list
              state.nextPlayerId = 1;
              state.players = mergedPlayers.map((p) => {
                const safe = makePlayer(p, {
                  isNew: Boolean(p.isNew),
                  group: p.group,
                  platform: p.platform,
                });
                safe.checkedIn = Boolean(p.checkedIn);
                safe.checkedInAt = p.checkedInAt || null;
                safe.account = p.account || "";
                safe.club = p.club || "";
                safe.displayName = p.displayName || "";
                return safe;
              });

              state.players.sort(comparePlayersForList);

              let autoPreliminaryRounds;
              try {
                autoPreliminaryRounds = await preliminaryRoundCountForPlayerCount(
                  state.players.length,
                );
              } catch (error) {
                showAlert(
                  "无法计算预赛轮数",
                  normalizeWhitespace(error && error.message) || "PAPP C 轮数接口调用失败。",
                );
                return;
              }
              state.scoreHelper = createDefaultScoreHelper(autoPreliminaryRounds);
              state.standingsSnapshots = [];
              state.scoreHelper.roundCountSource = "auto";
              state.scoreHelper.autoRoundCountPlayerCount = state.players.length;
              state.scoreHelper.updatedAt = now();

              const selectedGroup = selectedWechatRelayGroup();
              const groupCompetitionName = selectedGroup.queryIndex
                ? normalizeWhitespace(
                    selectedGroup.displayName || selectedGroup.queryIndex,
                  )
                : "";
              const existingCompetitionName = normalizeWhitespace(
                state.competitionName,
              );
              const keepManualCompetitionName =
                groupCompetitionName &&
                existingCompetitionName &&
                existingCompetitionName !== groupCompetitionName &&
                existingCompetitionName !== "比赛签到表" &&
                existingCompetitionName !== detectedCompetitionName;
              setCompetitionName(
                keepManualCompetitionName
                  ? existingCompetitionName
                  : groupCompetitionName ||
                      detectedCompetitionName ||
                      "比赛签到表",
              );
              state.step = "checkin";
              viewStepOverride = null;

              // If current group filter doesn't exist, reset
              if (
                state.ui &&
                state.ui.group !== "all" &&
                !state.players.some((p) => p.group === state.ui.group)
              ) {
                state.ui.group = "all";
              }

              // UI
              if (searchBox) searchBox.value = "";
              if (addPlayerNameInput) addPlayerNameInput.value = "";

              applyStepUI();
              refreshCheckinUI();
              scheduleSave();

              const relaySync = ensureWechatRelaySyncState();
              if (
                relayImportContext &&
                relayImportContext.groupUsername ===
                  wechatRelayGroupIdentity()
              ) {
                relaySync.ready = true;
                relaySync.enabled = false;
                relaySync.groupUsername = relayImportContext.groupUsername;
                relaySync.stopReason = "";
                clearWechatRelayReferenceContext(relaySync);
                rememberProcessedWechatRelayMessage(relayImportContext.message);
                stopWechatRelayPolling();
                wechatRelayStatusText = "接龙名单已导入；可在签到页开启实时同步。";
                wechatRelayReferenceStatusText = "此接龙已用于建立签到名单；再次引用会填入符合本场比赛的接龙原文。";
                pendingWechatRelayImport = null;
                scheduleSave();
                updateWechatRelaySyncUI();
                updateWechatRelayReferenceUI();
              } else if (!relayImportContext && (relaySync.ready || relaySync.enabled)) {
                relaySync.ready = false;
                relaySync.enabled = false;
                stopWechatRelayPolling();
                clearWechatRelayReferenceContext(relaySync);
                wechatRelayStatusText = "签到名单已重新导入，实时同步已暂停。";
                scheduleSave();
                updateWechatRelaySyncUI();
              } else if (relayImportContext) {
                pendingWechatRelayImport = null;
                relaySync.ready = false;
                relaySync.enabled = false;
                stopWechatRelayPolling();
                clearWechatRelayReferenceContext(relaySync);
                wechatRelayStatusText = "比赛群聊已更改，请重新引用接龙后导入。";
                scheduleSave();
                updateWechatRelaySyncUI();
                updateWechatRelayReferenceUI();
              }
              showSnackbar("已开始签到（进度会自动保存）", 2400);

              // Auto show suspects panel (after this preview dialog closes)
              window.setTimeout(() => {
                maybeAutoShowSuspectsAfterImport();
              }, 0);
            },
          },
        ],
      });
    } catch (e) {
      console.error("导入时发生错误：", e);
      showAlert("处理失败", "处理导入数据时发生未知错误。");
    }
  }

  function backToImport() {
    showConfirm(
      "返回确认",
      "确定要返回并重新导入吗？当前签到进度将被清空（可在底部提示条中撤销）。已粘贴的文本会保留。",
      () => {
        const snapshot = captureUndoSnapshot();

        state.step = "import";
        viewStepOverride = null;
        state.players = [];
        state.nextPlayerId = 1;
        const autoCheckin = ensureWechatAutoCheckinState();
        autoCheckin.enabled = false;
        autoCheckin.items = [];
        wechatAutoCheckinStatusText = "自动签到已关闭。";
        const relaySync = ensureWechatRelaySyncState();
        relaySync.enabled = false;
        relaySync.ready = false;
        stopWechatRelayPolling();
        wechatRelayStatusText = "已返回导入页，实时同步已暂停。";

        applyStepUI();
        updateWechatRelaySyncUI();
        updateWechatAutoCheckinUI();
        refreshCheckinUI();
        scheduleSave();

        showUndoSnackbar("已返回导入页面", () => {
          restoreUndoSnapshot(snapshot);
          showSnackbar("已撤销返回", 2200);
        });
      },
      "返回",
    );
  }

  // ------------------------------
  // Player actions
  // ------------------------------
  function getPlayerById(id) {
    const pid = Number(id);
    if (!Number.isFinite(pid)) return null;
    return state.players.find((p) => p.id === pid) || null;
  }

  function toggleNewStatus(playerId) {
    const player = getPlayerById(playerId);
    if (!player) return;
    player.isNew = !player.isNew;
    refreshCheckinUI();
    scheduleSave();
  }

  function setCheckIn(playerId, checked) {
    const player = getPlayerById(playerId);
    if (!player) return;

    const next = Boolean(checked);
    const prev = Boolean(player.checkedIn);
    const prevAt = player.checkedInAt;
    if (next === prev) return;

    player.checkedIn = next;
    player.checkedInAt = next ? now() : null;

    preserveViewportScrollDuring(() => {
      refreshCheckinUI();
    });
    scheduleSave();

    // Undo action (minimal risk)
    const action = next ? "已签到" : "已取消";
    showUndoSnackbar(
      `${action}：${player.displayName}`,
      () => {
        player.checkedIn = prev;
        player.checkedInAt = prev ? prevAt || now() : null;
        preserveViewportScrollDuring(() => {
          refreshCheckinUI();
        });
        scheduleSave();
        showSnackbar("已撤销", 1800);
      },
      5200,
    );
  }

  function toggleCheckIn(playerId) {
    const player = getPlayerById(playerId);
    if (!player) return;
    setCheckIn(playerId, !player.checkedIn);
  }

  function deletePlayer(playerId) {
    const player = getPlayerById(playerId);
    if (!player) return;

    showConfirm(
      "删除确认",
      `确定要删除「${player.displayName}」吗？删除后可在底部提示条中撤销。`,
      () => {
        const snapshot = captureUndoSnapshot();

        state.players = state.players.filter((p) => p.id !== playerId);
        void updateAutoPreliminaryRoundsIfNeeded();

        // If current group is now empty, go back to "all"
        if (
          state.ui &&
          state.ui.group !== "all" &&
          !state.players.some((p) => p.group === state.ui.group)
        ) {
          state.ui.group = "all";
        }

        refreshCheckinUI();
        scheduleSave();

        showUndoSnackbar(`已删除「${player.displayName}」`, () => {
          restoreUndoSnapshot(snapshot);
          showSnackbar("已撤销删除", 2200);
        });
      },
      "删除",
    );
  }

  // ------------------------------
  // Inline edit (最小侵入：在选手右侧增加“编辑”按钮)
  // ------------------------------
  function sanitizeAccountInput(raw) {
    let s = normalizeWhitespace(raw || "");
    if (!s) return "";
    // Remove surrounding brackets/parentheses commonly used in pasted lists
    s = s.replace(/^[\[\(（【\{]\s*(.*?)\s*[\]\)）】\}]\s*$/, "$1");
    s = normalizeWhitespace(s);
    // Remove leading "@"
    s = s.replace(/^@+/, "");
    return s;
  }

  function sanitizeClubInput(raw) {
    let s = normalizeWhitespace(raw || "");
    if (!s) return "";
    s = s.replace(/^俱乐部\s*[:：]\s*/i, "");
    return s;
  }

  function showEditPlayerDialog(playerId, options = {}) {
    const player = getPlayerById(playerId);
    if (!player) return;
    const onReturnToSuspects =
      options && typeof options.onReturnToSuspects === "function"
        ? options.onReturnToSuspects
        : null;

    const root = document.createElement("div");
    root.className = "edit-form";
    root.style.whiteSpace = "normal";

    const note = document.createElement("div");
    note.className = "edit-note";
    note.textContent = onReturnToSuspects
      ? "提示：修改后会自动保存，并返回到“检查重复/异常”界面。"
      : "提示：修改后会自动保存。本工具不会上传数据；如需检查是否出现重复，可点页面上的“检查重复”。";

    const error = document.createElement("div");
    error.className = "form-error";
    error.setAttribute("role", "alert");

    const grid = document.createElement("div");
    grid.className = "form-grid";

    // Name
    const fName = document.createElement("label");
    fName.className = "field";
    const fNameLabel = document.createElement("span");
    fNameLabel.className = "field__label";
    fNameLabel.textContent = "选手名称";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = player.displayName || "";
    nameInput.placeholder = "例如：王小明 / Wang Xiaoming";
    fName.appendChild(fNameLabel);
    fName.appendChild(nameInput);

    // Platform
    const fPlat = document.createElement("label");
    fPlat.className = "field";
    const fPlatLabel = document.createElement("span");
    fPlatLabel.className = "field__label";
    fPlatLabel.textContent = "平台";
    const platSel = document.createElement("select");
    platSel.className = "input";
    const platOptions = [
      { v: "", t: "（空）/ 未知" },
      { v: "oq", t: "OQ" },
      { v: "vint", t: "VINT" },
    ];
    platOptions.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.v;
      opt.textContent = o.t;
      platSel.appendChild(opt);
    });
    platSel.value = normalizeWhitespace(player.platform || "");
    fPlat.appendChild(fPlatLabel);
    fPlat.appendChild(platSel);

    // Account
    const fAcc = document.createElement("label");
    fAcc.className = "field";
    const fAccLabel = document.createElement("span");
    fAccLabel.className = "field__label";
    fAccLabel.textContent = "账号（OQ/Vint）";
    const accInput = document.createElement("input");
    accInput.type = "text";
    accInput.value = player.account || "";
    accInput.placeholder = "例如：PoQi_G / Danica";
    fAcc.appendChild(fAccLabel);
    fAcc.appendChild(accInput);

    // Club
    const fClub = document.createElement("label");
    fClub.className = "field";
    const fClubLabel = document.createElement("span");
    fClubLabel.className = "field__label";
    fClubLabel.textContent = "俱乐部";
    const clubInput = document.createElement("input");
    clubInput.type = "text";
    clubInput.value = player.club || "";
    clubInput.placeholder = "例如：栢龙 / XX俱乐部";
    fClub.appendChild(fClubLabel);
    fClub.appendChild(clubInput);

    // Group
    const fGroup = document.createElement("label");
    fGroup.className = "field";
    const fGroupLabel = document.createElement("span");
    fGroupLabel.className = "field__label";
    fGroupLabel.textContent = "组别";
    const groupInput = document.createElement("input");
    groupInput.type = "text";
    groupInput.value = player.group || "未分组";
    groupInput.placeholder = "例如：无差别组 / 新人赛 / 特殊赛";

    // Datalist suggestions (existing groups)
    try {
      const uniqueGroups = Array.from(
        new Set(
          (state.players || []).map((p) =>
            normalizeWhitespace(p.group || "未分组"),
          ),
        ),
      ).filter(Boolean);
      uniqueGroups.sort((a, b) => nameCollator.compare(a, b));
      const dl = document.createElement("datalist");
      const dlId = `group-suggest-${playerId}-${Math.random().toString(16).slice(2)}`;
      dl.id = dlId;
      uniqueGroups.forEach((g) => {
        const opt = document.createElement("option");
        opt.value = g;
        dl.appendChild(opt);
      });
      groupInput.setAttribute("list", dlId);
      root.appendChild(dl);
    } catch (_) {
      // ignore datalist failures
    }

    fGroup.appendChild(fGroupLabel);
    fGroup.appendChild(groupInput);

    // isNew
    const fIsNew = document.createElement("label");
    fIsNew.className = "toggle toggle--inline";
    const isNewInput = document.createElement("input");
    isNewInput.type = "checkbox";
    isNewInput.checked = Boolean(player.isNew);
    const isNewText = document.createElement("span");
    isNewText.textContent = "新人标记";
    fIsNew.appendChild(isNewInput);
    fIsNew.appendChild(isNewText);

    grid.appendChild(fName);
    grid.appendChild(fPlat);
    grid.appendChild(fAcc);
    grid.appendChild(fClub);
    grid.appendChild(fGroup);

    root.appendChild(note);
    root.appendChild(error);
    root.appendChild(grid);
    root.appendChild(fIsNew);

    // Focus name for quick edit (mobile friendly)
    window.setTimeout(() => {
      try {
        nameInput.focus();
        nameInput.select();
      } catch (_) {}
    }, 0);

    const buttons = [];
    if (onReturnToSuspects) {
      buttons.push({
        label: "返回检查结果",
        className: "btn btn-tonal",
        onClick: () => {
          onReturnToSuspects();
          return false;
        },
      });
    }
    buttons.push({ label: "取消", className: "btn btn-outlined" });
    buttons.push({
      label: onReturnToSuspects ? "保存并返回" : "保存",
      className: "btn btn-filled",
      onClick: () => {
        error.textContent = "";
        const newName = normalizeWhitespace(nameInput.value);
        if (!newName) {
          error.textContent = "选手名称不能为空。";
          return false; // keep dialog open
        }

        const newPlatform = normalizeWhitespace(platSel.value);
        const newAccount = sanitizeAccountInput(accInput.value);
        const newClub = sanitizeClubInput(clubInput.value);
        const newGroup = normalizeWhitespace(groupInput.value) || "未分组";
        const newIsNew = Boolean(isNewInput.checked);

        const snapshot = captureUndoSnapshot();

        player.displayName = newName;
        player.platform = newPlatform;
        player.account = newAccount;
        player.club = newClub;
        player.group = newGroup;
        player.isNew = newIsNew;

        // Keep list order consistent with the rest of the app
        state.players.sort(comparePlayersForList);

        // If current group filter is invalid now, reset
        if (
          state.ui &&
          state.ui.group !== "all" &&
          !state.players.some((p) => p.group === state.ui.group)
        ) {
          state.ui.group = "all";
        }

        refreshCheckinUI();
        scheduleSave();

        showUndoSnackbar("已保存修改", () => {
          restoreUndoSnapshot(snapshot);
          showSnackbar("已撤销修改", 2200);
        });

        if (onReturnToSuspects) {
          onReturnToSuspects();
          return false;
        }
      },
    });

    showDialog({
      title: "编辑选手信息",
      contentNode: root,
      buttons,
    });
  }

  // ------------------------------
  // Batch operations (批量操作) + Undo
  // ------------------------------
  function getBatchScopePlayers() {
    // Scope: current group filter (与统计范围一致)，更符合“当前组别”预期
    return getStatsScopePlayers();
  }

  function batchSetCheckIn(checked) {
    const scope = getBatchScopePlayers();
    if (!scope || scope.length === 0) {
      showSnackbar("当前范围没有可操作的选手", 2200);
      return;
    }

    const snapshot = captureUndoSnapshot();

    let changed = 0;
    const ts = now();
    scope.forEach((p) => {
      if (!p) return;
      if (Boolean(p.checkedIn) === Boolean(checked)) return;
      p.checkedIn = Boolean(checked);
      p.checkedInAt = checked ? ts : null;
      changed++;
    });

    refreshCheckinUI();
    scheduleSave();

    const label = checked
      ? `已批量签到（${changed} 人）`
      : `已批量取消签到（${changed} 人）`;
    showUndoSnackbar(label, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销批量操作", 2200);
    });
  }

  function batchDeleteCurrentGroup() {
    if (!state.ui || !state.ui.group || state.ui.group === "all") {
      showSnackbar("请先选择一个具体组别后再批量删除", 3000);
      return;
    }

    const group = String(state.ui.group);
    const scope = getBatchScopePlayers();
    const count = scope.length;

    if (count === 0) {
      showSnackbar("该组别为空，无需删除", 2200);
      return;
    }

    const snapshot = captureUndoSnapshot();

    state.players = (state.players || []).filter(
      (p) => p && String(p.group || "未分组") !== group,
    );
    void updateAutoPreliminaryRoundsIfNeeded();
    state.ui.group = "all";

    refreshCheckinUI();
    scheduleSave();

    showUndoSnackbar(`已删除组别「${group}」的 ${count} 人`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销批量删除", 2200);
    });
  }

  function showBatchDialog() {
    const group = state.ui && state.ui.group ? String(state.ui.group) : "all";
    const scope = getBatchScopePlayers();
    const scopeLabel = group === "all" ? "全部组别" : `组别「${group}」`;
    const scopeCount = scope.length;

    const root = document.createElement("div");
    root.className = "batch-panel";
    root.style.whiteSpace = "normal";

    const p = document.createElement("div");
    p.className = "batch-panel__desc";
    p.textContent = `操作范围：${scopeLabel}（${scopeCount} 人）。所有批量操作都可在底部提示条中撤销。`;
    root.appendChild(p);

    showDialog({
      title: "批量操作",
      contentNode: root,
      buttons: [
        { label: "关闭", className: "btn btn-outlined" },
        {
          label: "全部签到",
          className: "btn btn-tonal",
          onClick: () => batchSetCheckIn(true),
        },
        {
          label: "全部取消签到",
          className: "btn btn-tonal",
          onClick: () => batchSetCheckIn(false),
        },
        {
          label: "删除当前组别",
          className: "btn btn-outlined",
          onClick: () => {
            if (group === "all") {
              showSnackbar(
                "为降低误删风险：请先选择一个具体组别，再使用“删除当前组别”。",
                3500,
              );
              return false; // keep dialog open
            }

            // Close this dialog first, then show confirm (avoid nested dialog auto-close)
            window.setTimeout(() => {
              showConfirm(
                "批量删除确认",
                `确定要删除组别「${group}」的全部 ${scopeCount} 人吗？删除后可在底部提示条中撤销。`,
                () => batchDeleteCurrentGroup(),
                "删除",
              );
            }, 0);
          },
        },
      ],
    });
  }

  function addPlayer() {
    if (!addPlayerNameInput) return;

    const raw = normalizeWhitespace(addPlayerNameInput.value);
    if (!raw) {
      showAlert("操作失败", "选手名称不能为空。");
      return;
    }

    // Use current selected group (or 未分组)
    const group =
      state.ui && state.ui.group && state.ui.group !== "all"
        ? state.ui.group
        : "未分组";
    const platform = guessPlatformByGroup(group);

    const fields = parseLineToFields(raw, { group, platform }) || {
      displayName: raw,
      account: "",
      club: "",
    };

    if (!fields.displayName) {
      showAlert(
        "操作失败",
        "无法解析该输入。请仅输入昵称/账号/俱乐部（每行一人）。",
      );
      return;
    }

    const nameKey = normalizeKey(fields.displayName);
    const accKey = fields.account
      ? `acc:${platform}|${normalizeKey(fields.account)}`
      : "";
    const exists = state.players.some((p) => {
      const nk = normalizeKey(p.displayName);
      if (nk === nameKey) return true;
      if (
        accKey &&
        p.account &&
        `acc:${normalizeWhitespace(p.platform)}|${normalizeKey(p.account)}` ===
          accKey
      )
        return true;
      return false;
    });

    if (exists) {
      showAlert("操作失败", "该选手已存在于列表中（按昵称或账号去重）。");
      return;
    }

    state.players.push(makePlayer(fields, { isNew: true, group, platform }));
    state.players.sort(comparePlayersForList);
    void updateAutoPreliminaryRoundsIfNeeded();

    addPlayerNameInput.value = "";
    refreshCheckinUI();
    scheduleSave();
    showSnackbar("已添加选手（已标记为新人）", 2000);
  }

  // ------------------------------
  // Swipe gestures (Plan #7)
  // ------------------------------
  function setupSwipeGestures() {
    if (!playerList) return;

    let active = null;

    const threshold = 56; // px
    const maxVertical = 38;

    const getRowFromEvent = (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return null;
      if (target.closest("button, input, textarea, select, a, label"))
        return null;
      const row = target.closest(".player-item");
      if (!row || !row.dataset || !row.dataset.playerId) return null;
      return row;
    };

    const onPointerDown = (e) => {
      // Only primary pointer
      if (e.button !== undefined && e.button !== 0) return;

      const row = getRowFromEvent(e);
      if (!row) return;

      active = {
        id: Number(row.dataset.playerId),
        row,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
        pointerId: e.pointerId,
      };

      try {
        row.setPointerCapture && row.setPointerCapture(e.pointerId);
      } catch (_) {
        // ignore
      }
    };

    const onPointerMove = (e) => {
      if (!active) return;
      if (
        active.pointerId != null &&
        e.pointerId != null &&
        active.pointerId !== e.pointerId
      )
        return;

      const dx = e.clientX - active.startX;
      const dy = e.clientY - active.startY;

      active.lastX = e.clientX;
      active.lastY = e.clientY;

      if (Math.abs(dy) > maxVertical && Math.abs(dy) > Math.abs(dx)) {
        // treat as scroll
        active = null;
        return;
      }

      if (Math.abs(dx) > 8) {
        active.moved = true;
        // Small visual feedback
        active.row.style.transform = `translateX(${Math.max(-80, Math.min(80, dx))}px)`;
        active.row.style.transition = "none";
      }
    };

    const resetRow = (row) => {
      if (!row) return;
      row.style.transform = "";
      row.style.transition = "";
    };

    const onPointerUp = () => {
      if (!active) return;

      const row = active.row;
      const dx = active.lastX - active.startX;
      const dy = active.lastY - active.startY;

      resetRow(row);

      // Only treat as swipe when mainly horizontal
      if (
        active.moved &&
        Math.abs(dx) >= threshold &&
        Math.abs(dx) > Math.abs(dy) * 1.2
      ) {
        const pid = Number(active.id);
        if (Number.isFinite(pid)) {
          if (dx > 0)
            setCheckIn(pid, true); // right swipe => check-in
          else setCheckIn(pid, false); // left swipe => uncheck
        }
      }

      active = null;
    };

    // Pointer events are widely supported; fall back to touch events if missing
    if ("PointerEvent" in window) {
      playerList.addEventListener("pointerdown", onPointerDown, {
        passive: true,
      });
      playerList.addEventListener("pointermove", onPointerMove, {
        passive: true,
      });
      playerList.addEventListener("pointerup", onPointerUp, { passive: true });
      playerList.addEventListener("pointercancel", onPointerUp, {
        passive: true,
      });
    } else {
      // Touch fallback (very old iOS)
      let touchActive = null;

      playerList.addEventListener(
        "touchstart",
        (e) => {
          if (!e.touches || e.touches.length !== 1) return;
          const row = getRowFromEvent(e);
          if (!row) return;

          const t = e.touches[0];
          touchActive = {
            id: Number(row.dataset.playerId),
            row,
            startX: t.clientX,
            startY: t.clientY,
            lastX: t.clientX,
            lastY: t.clientY,
            moved: false,
          };
        },
        { passive: true },
      );

      playerList.addEventListener(
        "touchmove",
        (e) => {
          if (!touchActive || !e.touches || e.touches.length !== 1) return;
          const t = e.touches[0];
          const dx = t.clientX - touchActive.startX;
          const dy = t.clientY - touchActive.startY;

          touchActive.lastX = t.clientX;
          touchActive.lastY = t.clientY;

          if (Math.abs(dy) > maxVertical && Math.abs(dy) > Math.abs(dx)) {
            resetRow(touchActive.row);
            touchActive = null;
            return;
          }

          if (Math.abs(dx) > 8) {
            touchActive.moved = true;
            touchActive.row.style.transform = `translateX(${Math.max(-80, Math.min(80, dx))}px)`;
            touchActive.row.style.transition = "none";
          }
        },
        { passive: true },
      );

      playerList.addEventListener(
        "touchend",
        () => {
          if (!touchActive) return;
          const dx = touchActive.lastX - touchActive.startX;
          const dy = touchActive.lastY - touchActive.startY;
          resetRow(touchActive.row);

          if (
            touchActive.moved &&
            Math.abs(dx) >= threshold &&
            Math.abs(dx) > Math.abs(dy) * 1.2
          ) {
            const pid = Number(touchActive.id);
            if (Number.isFinite(pid)) {
              if (dx > 0) setCheckIn(pid, true);
              else setCheckIn(pid, false);
            }
          }
          touchActive = null;
        },
        { passive: true },
      );

      playerList.addEventListener(
        "touchcancel",
        () => {
          if (!touchActive) return;
          resetRow(touchActive.row);
          touchActive = null;
        },
        { passive: true },
      );
    }
  }

  // ------------------------------
  // Export
  // ------------------------------
  function populateExportGroupOptions() {
    if (!exportGroupSel) return;

    const previousValue = String(exportGroupSel.value || "current");
    exportGroupSel.innerHTML = "";

    const optCurrent = document.createElement("option");
    optCurrent.value = "current";
    optCurrent.textContent = "当前筛选";
    exportGroupSel.appendChild(optCurrent);

    const optAll = document.createElement("option");
    optAll.value = "all";
    optAll.textContent = "全部组别";
    exportGroupSel.appendChild(optAll);

    const groups = getAllGroupsFromPlayers();
    for (const g of groups) {
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      exportGroupSel.appendChild(opt);
    }

    const hasPreviousValue = Array.from(exportGroupSel.options).some(
      (opt) => opt.value === previousValue,
    );
    exportGroupSel.value = hasPreviousValue ? previousValue : "current";
  }

  function getExportSettings() {
    const group = exportGroupSel
      ? String(exportGroupSel.value || "current")
      : "current";
    const scope = exportScopeSel
      ? String(exportScopeSel.value || "all")
      : "all";
    const order = exportOrderSel
      ? String(exportOrderSel.value || "uncheckedFirst")
      : "uncheckedFirst";

    const withGroup = exportWithGroupEl
      ? Boolean(exportWithGroupEl.checked)
      : false;
    const withPlatform = exportWithPlatformEl
      ? Boolean(exportWithPlatformEl.checked)
      : false;
    const withAccount = exportWithAccountEl
      ? Boolean(exportWithAccountEl.checked)
      : true;
    const withClub = exportWithClubEl
      ? Boolean(exportWithClubEl.checked)
      : false;
    const withTime = exportWithTimeEl
      ? Boolean(exportWithTimeEl.checked)
      : true;

    return {
      group,
      scope,
      order,
      withGroup,
      withPlatform,
      withAccount,
      withClub,
      withTime,
    };
  }

  function getExportBasePlayers(settings) {
    const s = settings || getExportSettings();

    let list = Array.isArray(state.players) ? state.players.slice() : [];

    // group selection
    let group = s.group || "current";
    if (group === "current") {
      group = state.ui && state.ui.group ? state.ui.group : "all";
    }

    if (group && group !== "all") {
      list = list.filter((p) => p.group === group);
    }

    return list;
  }

  function getExportViewPlayers(settings) {
    const s = settings || getExportSettings();
    let list = getExportBasePlayers(s);

    // scope filter
    if (s.scope === "checked") list = list.filter((p) => p.checkedIn);
    else if (s.scope === "unchecked") list = list.filter((p) => !p.checkedIn);

    const stable = (cmp) =>
      list
        .map((p, idx) => ({ p, idx }))
        .sort((a, b) => cmp(a.p, b.p) || a.idx - b.idx)
        .map((x) => x.p);

    if (s.order === "checkedFirst") {
      list = stable((a, b) => (b.checkedIn ? 1 : 0) - (a.checkedIn ? 1 : 0));
    } else if (s.order === "uncheckedFirst") {
      list = stable((a, b) => (a.checkedIn ? 1 : 0) - (b.checkedIn ? 1 : 0));
    } else if (s.order === "groupThenName") {
      list = stable(comparePlayersForList);
    }

    return list;
  }

  function buildExportHtml(viewPlayers, settings) {
    const s = settings || getExportSettings();
    const players = Array.isArray(viewPlayers) ? viewPlayers : [];

    const totalAll = state.players.length;
    const checkedAll = state.players.filter((p) => p.checkedIn).length;
    const total = players.length;
    const checkedIn = players.filter((p) => p.checkedIn).length;

    const title = escapeHtml(state.competitionName || "比赛签到表");
    const stats = `当前导出：${total}　|　已签到：${checkedIn}　|　等待中：${total - checkedIn}  （总表：${totalAll} / 已签到：${checkedAll}）`;

    // Build columns
    const cols = [];
    cols.push({ key: "index", label: "#", width: "72px" });
    cols.push({ key: "displayName", label: "昵称/姓名" });

    if (s.withAccount) cols.push({ key: "account", label: "账号" });
    if (s.withClub) cols.push({ key: "club", label: "俱乐部" });
    if (s.withPlatform) cols.push({ key: "platform", label: "平台" });
    if (s.withGroup) cols.push({ key: "group", label: "组别" });

    cols.push({ key: "status", label: "签到状态", width: "140px" });
    if (s.withTime)
      cols.push({ key: "time", label: "签到时间", width: "120px" });
    cols.push({ key: "isNew", label: "新人", width: "72px" });

    const ths = cols
      .map((c) => {
        const w = c.width ? ` style="width:${c.width};"` : "";
        return `<th${w}>${escapeHtml(c.label)}</th>`;
      })
      .join("");

    const rows = players
      .map((p, idx) => {
        const cells = cols
          .map((c) => {
            if (c.key === "index") return `<td>${idx + 1}</td>`;
            if (c.key === "displayName")
              return `<td>${escapeHtml(p.displayName)}</td>`;
            if (c.key === "account")
              return `<td>${escapeHtml(p.account || "")}</td>`;
            if (c.key === "club") return `<td>${escapeHtml(p.club || "")}</td>`;
            if (c.key === "platform")
              return `<td>${escapeHtml((p.platform || "").toUpperCase())}</td>`;
            if (c.key === "group")
              return `<td>${escapeHtml(p.group || "")}</td>`;
            if (c.key === "status") {
              const status = p.checkedIn ? "✔ 已签到" : "等待中";
              const statusClass = p.checkedIn
                ? 'style="color: var(--md-sys-color-primary); font-weight: 800;"'
                : 'style="opacity:.85"';
              return `<td ${statusClass}>${escapeHtml(status)}</td>`;
            }
            if (c.key === "time") {
              const t =
                p.checkedIn && p.checkedInAt ? formatTime(p.checkedInAt) : "";
              return `<td>${escapeHtml(t)}</td>`;
            }
            if (c.key === "isNew") {
              return `<td>${p.isNew ? '<span class="export-new-tag">是</span>' : ""}</td>`;
            }
            return `<td></td>`;
          })
          .join("");

        return `<tr>${cells}</tr>`;
      })
      .join("");

    return `
      <h4 class="export-title">${title}</h4>
      <div class="export-stats">${escapeHtml(stats)}</div>
      <table class="export-table">
        <thead><tr>${ths}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderExportPreview() {
    if (!exportContainer) return;
    const settings = getExportSettings();
    const players = getExportViewPlayers(settings);
    exportContainer.innerHTML = buildExportHtml(players, settings);
  }

  function generateFinalTable(options = {}) {
    if (!exportContainer) return;
    if (!prepareExportPreview()) return;
    showExportModal(options);
  }

  function ensureScoreHelper() {
    state.scoreHelper = sanitizeScoreHelper(state.scoreHelper);
    return state.scoreHelper;
  }

  function ensurePlayoffRegistration() {
    const helper = ensureScoreHelper();
    const saved = sanitizePlayoffRegistration(
      state.playoffRegistration,
      helper.preliminaryRoundCount,
    );
    state.playoffRegistration = saved.preliminaryRoundCount === helper.preliminaryRoundCount
      ? saved
      : createDefaultPlayoffRegistration(helper.preliminaryRoundCount);
    return state.playoffRegistration;
  }

  function setPlayoffPairings(roundNumber, pairings, options = {}) {
    const helper = ensureScoreHelper();
    const round = Math.trunc(Number(roundNumber));
    const requestedStage = normalizeWhitespace(options.stage).toLowerCase();
    const stage = requestedStage === "semifinal" || requestedStage === "placement"
      ? requestedStage
      : round === helper.preliminaryRoundCount + 1 && !skipsSemifinal()
        ? "semifinal"
        : "placement";
    if (!Number.isFinite(round) || !Array.isArray(pairings)) {
      throw new Error("淘汰赛轮次或配对数据无效");
    }
    if (round !== scoreStageRound(stage)) {
      throw new Error("淘汰赛轮次必须紧接预赛轮数");
    }

    const registration = ensurePlayoffRegistration();
    const previousPairings = stage === "semifinal"
      ? registration.semifinalPairings
      : registration.placementPairings;
    if (previousPairings.some(isLegacyScorePairing)) return deepClone(previousPairings);
    const normalized = pairings.map((pairing, index) => {
      const next = sanitizeScorePairing(pairing, index + 1);
      const confirmed = previousPairings.find((current) =>
        isPappReadbackConfirmedPairing(current) &&
        sameScorePairingIdentity(current, next) &&
        scorePairingScoresMatch(current, next),
      );
      if (confirmed) {
        next.status = "completed";
        next.pappReadbackAt = confirmed.pappReadbackAt;
      } else if (next.status === "completed") {
        next.status = isBoardScorePairing(next) ? "ready" : "imported";
        next.pappReadbackAt = "";
      }
      return next;
    });
    if (stage === "semifinal") {
      registration.activeStage = "semifinal";
      registration.semifinalPairings = normalized;
      registration.placementPairings = [];
    } else {
      registration.activeStage = "placement";
      registration.placementPairings = normalized;
    }
    registration.updatedAt = now();
    state.playoffRegistration = registration;
    scheduleSave({ source: "script" });
    return deepClone(normalized);
  }

  function setActivePlayoffStage(stage) {
    const registration = ensurePlayoffRegistration();
    const normalized = normalizeWhitespace(stage).toLowerCase();
    if (normalized !== "semifinal" && normalized !== "placement") {
      throw new Error("淘汰赛阶段只能是 semifinal 或 placement");
    }
    registration.activeStage = normalized;
    registration.updatedAt = now();
    state.playoffRegistration = registration;
    renderFinalRegistration(null, registration);
    scheduleSave();
    return normalized;
  }

  function getActiveScoreRound() {
    const helper = ensureScoreHelper();
    const index = Math.max(0, Math.min(helper.roundCount - 1, helper.activeRound - 1));
    return helper.rounds[index] || helper.rounds[0];
  }

  function normalizePreliminaryRoundCount(value, fallback = 1) {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed) || parsed < 1) {
      return Math.max(1, Math.trunc(Number(fallback) || 1));
    }
    return parsed;
  }

  function setScoreRoundCount(nextCount, options = {}) {
    const helper = ensureScoreHelper();
    const count = normalizePreliminaryRoundCount(
      nextCount,
      helper.preliminaryRoundCount || helper.roundCount || 1,
    );
    const preliminaryRoundCountChanged = count !== helper.preliminaryRoundCount;
    const nextRounds = [];
    for (let i = 0; i < count; i++) {
      const existing = helper.rounds[i];
      nextRounds.push(
        existing
          ? sanitizeScoreRound({ ...existing, round: i + 1 }, i + 1)
          : createEmptyScoreRound(i + 1),
      );
    }
    helper.preliminaryRoundCount = count;
    helper.roundCount = count;
    if (options.source === "manual" || options.source === "auto") {
      helper.roundCountSource = options.source;
    }
    if (options.source === "auto") {
      const configuredPlayerCount = Number(options.playerCount);
      helper.autoRoundCountPlayerCount = Number.isFinite(configuredPlayerCount)
        ? Math.max(0, Math.trunc(configuredPlayerCount))
        : Array.isArray(state.players)
          ? state.players.length
          : 0;
    }
    helper.rounds = nextRounds;
    helper.activeRound = Math.max(1, Math.min(count, helper.activeRound || 1));
    helper.updatedAt = now();
    if (preliminaryRoundCountChanged) {
      state.playoffRegistration = createDefaultPlayoffRegistration(count);
    }
    return count;
  }

  async function updateAutoPreliminaryRoundsIfNeeded() {
    const helper = ensureScoreHelper();
    if (helper.roundCountSource !== "auto") return false;
    const checkedInCount = getCheckedInPlayersForTournament().length;
    const savedAutomaticCount = Number(helper.autoRoundCountPlayerCount);
    const playerCount = TOURNAMENT_STEP_IDS.includes(state.step)
      ? checkedInCount || (Number.isFinite(savedAutomaticCount) ? savedAutomaticCount : 0)
      : Array.isArray(state.players)
        ? state.players.length
        : 0;
    let count;
    try {
      count = await preliminaryRoundCountForPlayerCount(playerCount);
    } catch (error) {
      setScoreIntegrationStatus(
        normalizeWhitespace(error && error.message) || "PAPP C 轮数接口调用失败",
        "error",
      );
      return false;
    }
    if (count === helper.preliminaryRoundCount) {
      helper.autoRoundCountPlayerCount = playerCount;
      return false;
    }
    setScoreRoundCount(count, { source: "auto", playerCount });
    return true;
  }

  function getTournamentAdapter() {
    if (IS_NODE || typeof window === "undefined") return null;
    const adapter = window.PAPP_TOURNAMENT_ADAPTER;
    return adapter && typeof adapter === "object" ? adapter : null;
  }

  function getTournamentCandidatePlayers() {
    const players = Array.isArray(state && state.players) ? state.players : [];
    return players.map((player) => deepClone(player));
  }

  function getCheckedInPlayersForTournament() {
    return getTournamentCandidatePlayers().filter(
      (player) => player && player.checkedIn === true,
    );
  }

  function futurePreliminaryRounds() {
    const helper = ensureScoreHelper();
    const currentRound = Math.max(
      1,
      Math.min(helper.roundCount, Math.trunc(Number(helper.activeRound) || 1)),
    );
    const rounds = [];
    for (let round = currentRound + 1; round <= helper.preliminaryRoundCount; round++) {
      rounds.push(round);
    }
    return { currentRound, roundCount: helper.preliminaryRoundCount, rounds };
  }

  function showPlanWithdrawalDialog() {
    const checkedInPlayers = state.players
      .filter((player) => player && player.checkedIn === true)
      .slice()
      .sort(comparePlayersForList);
    if (!checkedInPlayers.length) {
      showAlert("计划删除", "当前没有已签到选手可供选择。");
      return;
    }

    const { currentRound, roundCount, rounds } = futurePreliminaryRounds();
    if (!rounds.length) {
      showAlert(
        "计划删除",
        `当前选中第 ${currentRound} 轮，预赛共 ${roundCount} 轮，没有尚未开始的轮次可选。`,
      );
      return;
    }

    const root = document.createElement("div");
    root.className = "planned-withdrawals";
    let selectedPlayerId = null;

    function render() {
      root.innerHTML = "";
      const roundInfo = futurePreliminaryRounds();

      const hint = document.createElement("p");
      hint.className = "planned-withdrawals__hint";
      hint.textContent =
        `以当前选中的第 ${roundInfo.currentRound} 轮为基准，选择的轮次会在导入该轮配对前生效。` +
        "生效时会取消签到并保留候选人；名单同步核验通过后才会导入配对。";
      root.appendChild(hint);

      if (selectedPlayerId !== null) {
        const player = state.players.find(
          (item) => item && item.id === selectedPlayerId && item.checkedIn === true,
        );
        if (!player) {
          selectedPlayerId = null;
          render();
          return;
        }

        const selected = document.createElement("div");
        selected.className = "planned-withdrawals__section-title";
        selected.textContent = `为「${player.displayName}」选择退出生效轮次`;
        root.appendChild(selected);

        const back = document.createElement("button");
        back.type = "button";
        back.className = "btn btn-outlined";
        back.textContent = "返回选手列表";
        back.dataset.withdrawalBack = "true";
        root.appendChild(back);

        const roundButtons = document.createElement("div");
        roundButtons.className = "planned-withdrawals__rounds";
        for (const round of roundInfo.rounds) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = round === roundInfo.currentRound + 1
            ? "btn btn-tonal"
            : "btn btn-outlined";
          button.textContent = round === roundInfo.currentRound + 1
            ? `下一轮（第 ${round} 轮）`
            : `第 ${round} 轮`;
          button.dataset.withdrawalRound = String(round);
          roundButtons.appendChild(button);
        }
        root.appendChild(roundButtons);
        return;
      }

      const plans = sanitizePlannedWithdrawals(state.plannedWithdrawals);
      if (plans.length) {
        const title = document.createElement("div");
        title.className = "planned-withdrawals__section-title";
        title.textContent = "待执行计划";
        root.appendChild(title);

        const planList = document.createElement("div");
        planList.className = "planned-withdrawals__plans";
        for (const plan of plans) {
          const player = state.players.find(
            (item) => item && item.id === plan.playerId,
          );
          const row = document.createElement("div");
          row.className = "planned-withdrawals__plan";

          const detail = document.createElement("span");
          detail.className = "planned-withdrawals__plan-detail";
          const name = document.createElement("span");
          name.textContent = player ? player.displayName : plan.playerName || "已移除选手";
          detail.appendChild(name);
          const meta = document.createElement("span");
          meta.className = "planned-withdrawals__plan-meta";
          meta.textContent = `第 ${plan.round} 轮配对前取消签到`;
          detail.appendChild(meta);
          row.appendChild(detail);

          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "btn btn-outlined";
          cancel.textContent = "取消计划";
          cancel.dataset.withdrawalCancel = String(plan.playerId);
          row.appendChild(cancel);
          planList.appendChild(row);
        }
        root.appendChild(planList);
      }

      const title = document.createElement("div");
      title.className = "planned-withdrawals__section-title";
      title.textContent = "选择已签到选手";
      root.appendChild(title);

      const playerList = document.createElement("div");
      playerList.className = "planned-withdrawals__players";
      const currentCheckedIn = state.players
        .filter((player) => player && player.checkedIn === true)
        .slice()
        .sort(comparePlayersForList);
      for (const player of currentCheckedIn) {
        const existingPlan = plans.find((plan) => plan.playerId === player.id);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-outlined planned-withdrawals__player";
        button.dataset.withdrawalPlayer = String(player.id);

        const detail = document.createElement("span");
        detail.className = "planned-withdrawals__player-detail";
        const name = document.createElement("span");
        name.className = "planned-withdrawals__player-name";
        name.textContent = player.displayName;
        detail.appendChild(name);
        const metadata = [player.group, player.account].filter(Boolean).join(" · ");
        if (metadata) {
          const meta = document.createElement("span");
          meta.className = "planned-withdrawals__player-meta";
          meta.textContent = metadata;
          detail.appendChild(meta);
        }
        button.appendChild(detail);

        if (existingPlan) {
          const badge = document.createElement("span");
          badge.className = "chip-small chip-warn";
          badge.textContent = `第 ${existingPlan.round} 轮`;
          button.appendChild(badge);
        }
        playerList.appendChild(button);
      }
      root.appendChild(playerList);
    }

    root.addEventListener("click", (event) => {
      const target = isElement(event.target)
        ? event.target.closest("button")
        : null;
      if (!target) return;

      if (target.dataset.withdrawalPlayer) {
        selectedPlayerId = Number(target.dataset.withdrawalPlayer);
        render();
        return;
      }
      if (target.dataset.withdrawalBack) {
        selectedPlayerId = null;
        render();
        return;
      }
      if (target.dataset.withdrawalCancel) {
        const playerId = Number(target.dataset.withdrawalCancel);
        state.plannedWithdrawals = sanitizePlannedWithdrawals(
          state.plannedWithdrawals,
        ).filter((plan) => plan.playerId !== playerId);
        scheduleSave();
        render();
        showSnackbar("已取消计划删除", 1800);
        return;
      }
      if (target.dataset.withdrawalRound) {
        const player = state.players.find(
          (item) => item && item.id === selectedPlayerId && item.checkedIn === true,
        );
        const round = Number(target.dataset.withdrawalRound);
        const availableRounds = futurePreliminaryRounds().rounds;
        if (!player || !availableRounds.includes(round)) {
          showSnackbar("选手状态或轮次已变化，请重新选择", 2400);
          selectedPlayerId = null;
          render();
          return;
        }
        const plans = sanitizePlannedWithdrawals(state.plannedWithdrawals).filter(
          (plan) => plan.playerId !== player.id,
        );
        plans.push({
          playerId: player.id,
          playerName: player.displayName,
          round,
          createdAt: now(),
        });
        state.plannedWithdrawals = sanitizePlannedWithdrawals(plans);
        scheduleSave();
        closeDialog();
        showSnackbar(
          `已安排「${player.displayName}」在第 ${round} 轮配对前退出`,
          2800,
        );
      }
    });

    render();
    showDialog({
      title: "计划删除",
      contentNode: root,
      buttons: [{ label: "关闭", className: "btn btn-outlined" }],
    });
  }

  function mappingPlayersForPappSync() {
    return buildMappingPlayersForPappSync(
      ensureMappingState(),
      Array.isArray(state.players) ? state.players : [],
    );
  }

  function candidateSyncPayload() {
    const candidatePlayers = getTournamentCandidatePlayers();
    const checkedInPlayers = candidatePlayers.filter(
      (player) => player && player.checkedIn === true,
    );
    return {
      mode: "sync-candidates",
      rosterSource: "checkin",
      candidatePlayers,
      candidatePlayerCount: candidatePlayers.length,
      checkedInPlayers,
      checkedInPlayerCount: checkedInPlayers.length,
      mappingPlayers: mappingPlayersForPappSync(),
    };
  }

  function candidateSyncSnapshot(payload = candidateSyncPayload()) {
    return JSON.stringify({
      candidatePlayers: payload.candidatePlayers,
      mappingPlayers: payload.mappingPlayers,
    });
  }

  function tournamentRosterIdentity(player) {
    const account = normalizeWhitespace(player && player.account).toLowerCase();
    const platform = normalizeWhitespace(player && player.platform).toLowerCase();
    if (account) return `account:${platform}:${account}`;
    const displayName = normalizeWhitespace(
      player && (player.displayName || player.name),
    ).toLowerCase();
    return displayName ? `name:${displayName}` : "";
  }

  function rosterCounts(players) {
    const counts = new Map();
    for (const player of players) {
      const identity = tournamentRosterIdentity(player);
      if (!identity) {
        throw new Error("选手缺少姓名或账号，无法核对 PAPP 参赛名单");
      }
      const entry = counts.get(identity) || { count: 0, names: [] };
      entry.count++;
      entry.names.push(
        normalizeWhitespace(player.displayName || player.name || player.account),
      );
      counts.set(identity, entry);
    }
    return counts;
  }

  function compareTournamentRosters(expectedPlayers, actualPlayers) {
    const expectedCounts = rosterCounts(expectedPlayers);
    const actualCounts = rosterCounts(actualPlayers);
    const missing = [];
    const extra = [];

    for (const [identity, expected] of expectedCounts) {
      const actualCount = actualCounts.get(identity)?.count || 0;
      const difference = expected.count - actualCount;
      if (difference > 0) missing.push(...expected.names.slice(0, difference));
    }
    for (const [identity, actual] of actualCounts) {
      const expectedCount = expectedCounts.get(identity)?.count || 0;
      const difference = actual.count - expectedCount;
      if (difference > 0) extra.push(...actual.names.slice(0, difference));
    }

    const matches = missing.length === 0 && extra.length === 0;
    const detail = [];
    if (missing.length) detail.push(`PAPP 缺少：${missing.slice(0, 5).join("、")}`);
    if (extra.length) detail.push(`PAPP 多出：${extra.slice(0, 5).join("、")}`);
    return {
      matches,
      message: matches
        ? ""
        : `签到表 ${expectedPlayers.length} 人，PAPP ${actualPlayers.length} 人；${detail.join("；")}`,
    };
  }

  async function readPappCandidatePlayers(roundNo) {
    const result = assertAdapterSuccess(
      await invokeTournamentAdapter("getCandidates", {
        round: roundNo,
        mode: "read-roster-before-round",
        rosterSource: "checkin",
      }),
      "读取 PAPP 选手名单失败",
    );
    if (!Array.isArray(result.candidatePlayers)) {
      throw new Error("PAPP getCandidates 接口未返回 candidatePlayers 数组");
    }
    return result.candidatePlayers;
  }

  function plannedWithdrawalsBeforeRound(roundNo) {
    state.plannedWithdrawals = sanitizePlannedWithdrawals(
      state.plannedWithdrawals,
    );
    const duePlans = state.plannedWithdrawals.filter(
      (plan) => plan.round <= roundNo,
    );
    if (!duePlans.length) {
      return { changed: false, removedNames: [] };
    }

    const duePlayerIds = new Set(duePlans.map((plan) => plan.playerId));
    const removedNames = [];
    for (const player of state.players) {
      if (!player || !duePlayerIds.has(player.id) || player.checkedIn !== true) {
        continue;
      }
      player.checkedIn = false;
      player.checkedInAt = null;
      removedNames.push(player.displayName);
    }
    state.plannedWithdrawals = state.plannedWithdrawals.filter(
      (plan) => plan.round > roundNo,
    );
    return { changed: true, removedNames };
  }

  async function reconcilePappRosterBeforeRound(roundNo) {
    const adapter = getTournamentAdapter();
    if (!adapter || typeof adapter.getCandidates !== "function") {
      throw new Error("PAPP 编排适配器未提供 getCandidates 接口");
    }
    if (typeof adapter.syncCandidates !== "function") {
      throw new Error("PAPP 编排适配器未提供 syncCandidates 接口");
    }

    if (pappCandidateSyncTimer) window.clearTimeout(pappCandidateSyncTimer);
    pappCandidateSyncTimer = null;
    pappCandidateSyncPending = false;
    while (pappCandidateSyncInFlight) {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }

    let lastFailure = "尚未读取 PAPP 名单";
    const readAndCompare = async () => {
      const expectedPlayers = getCheckedInPlayersForTournament();
      const candidates = await readPappCandidatePlayers(roundNo);
      const actualPlayers = candidates.filter(
        (player) => player && player.checkedIn === true,
      );
      return {
        expectedPlayers,
        actualPlayers,
        comparison: compareTournamentRosters(expectedPlayers, actualPlayers),
      };
    };

    for (let attempt = 1; attempt <= PAPP_ROSTER_SYNC_MAX_ATTEMPTS; attempt++) {
      setScoreIntegrationStatus(
        `正在核对第 ${roundNo} 轮的 PAPP 名单（${attempt}/${PAPP_ROSTER_SYNC_MAX_ATTEMPTS}）…`,
      );
      try {
        const check = await readAndCompare();
        if (check.comparison.matches) {
          pappCandidateSyncLastSnapshot = candidateSyncSnapshot();
          setScoreIntegrationStatus(
            `第 ${roundNo} 轮 PAPP 名单已与签到表核对一致（${check.expectedPlayers.length} 人）`,
            "ok",
          );
          return;
        }
        lastFailure = check.comparison.message;
      } catch (error) {
        lastFailure = normalizeWhitespace(error && error.message) || String(error);
      }

      setScoreIntegrationStatus(
        `第 ${roundNo} 轮名单不一致，正在尝试同步（${attempt}/${PAPP_ROSTER_SYNC_MAX_ATTEMPTS}）…`,
      );
      try {
        const syncResult = await invokeTournamentAdapter("syncCandidates", {
          round: roundNo,
          mode: "sync-roster-before-round",
          rosterSource: "checkin",
        });
        assertAdapterSuccess(syncResult, "同步 PAPP 选手名单失败");
      } catch (error) {
        const syncMessage =
          normalizeWhitespace(error && error.message) || String(error);
        lastFailure = `${lastFailure}；同步错误：${syncMessage}`;
      }

      await new Promise((resolve) =>
        window.setTimeout(resolve, PAPP_ROSTER_SYNC_RETRY_DELAY_MS),
      );
    }

    try {
      const finalCheck = await readAndCompare();
      if (finalCheck.comparison.matches) {
        pappCandidateSyncLastSnapshot = candidateSyncSnapshot();
        setScoreIntegrationStatus(
          `第 ${roundNo} 轮 PAPP 名单已与签到表核对一致（${finalCheck.expectedPlayers.length} 人）`,
          "ok",
        );
        return;
      }
      lastFailure = finalCheck.comparison.message;
    } catch (error) {
      lastFailure = normalizeWhitespace(error && error.message) || String(error);
    }

    throw new Error(
      `PAPP 名单在同步 ${PAPP_ROSTER_SYNC_MAX_ATTEMPTS} 次后仍与签到表不一致。${lastFailure}`,
    );
  }

  async function prepareRoundPairingImport(roundNo) {
    const withdrawalResult = plannedWithdrawalsBeforeRound(roundNo);
    if (withdrawalResult.changed) {
      if (state.step === "checkin") refreshCheckinUI();
      scheduleSave();
    }

    try {
      const saved = await persistCurrentStateToLocalService();
      if (!saved) {
        throw new Error("签到状态未能保存到本地服务");
      }
      if (!getCheckedInPlayersForTournament().length) {
        throw new Error("当前没有已签到选手");
      }
      await reconcilePappRosterBeforeRound(roundNo);
      return withdrawalResult;
    } catch (error) {
      const message = normalizeWhitespace(error && error.message) || String(error);
      if (!withdrawalResult.removedNames.length) throw error;
      throw new Error(
        `${message}；前端已取消签到：${withdrawalResult.removedNames.join("、")}，第 ${roundNo} 轮配对尚未导入。`,
      );
    }
  }

  function appendWithdrawalContextToError(message, withdrawalResult, roundNo, action) {
    if (!withdrawalResult || !withdrawalResult.removedNames.length) return message;
    return `${message}；计划删除已在前端生效（${withdrawalResult.removedNames.join("、")}），第 ${roundNo} 轮${action}未完成。`;
  }

  function schedulePappCandidateSync(options = {}) {
    if (IS_NODE || typeof window === "undefined") return;
    const adapter = getTournamentAdapter();
    if (!adapter || typeof adapter.syncCandidates !== "function") return;

    pappCandidateSyncPending = true;
    if (pappCandidateSyncTimer) window.clearTimeout(pappCandidateSyncTimer);
    const delay = options.immediate ? 0 : 180;
    pappCandidateSyncTimer = window.setTimeout(() => {
      pappCandidateSyncTimer = null;
      flushPappCandidateSync();
    }, delay);
  }

  async function flushPappCandidateSync() {
    if (IS_NODE || pappCandidateSyncInFlight || !pappCandidateSyncPending) return;
    pappCandidateSyncPending = false;

    const payload = candidateSyncPayload();
    const snapshot = candidateSyncSnapshot(payload);
    if (snapshot === pappCandidateSyncLastSnapshot) return;

    pappCandidateSyncInFlight = true;
    try {
      const result = await invokeTournamentAdapter("syncCandidates", payload);
      if (result && result.ok === false) {
        throw new Error(
          normalizeWhitespace(result.message || result.error) || "PAPP 候选选手同步失败",
        );
      }
      pappCandidateSyncLastSnapshot = snapshot;
    } catch (error) {
      console.warn(
        "[papp] 候选选手同步失败：",
        normalizeWhitespace(error && error.message) || error,
      );
    } finally {
      pappCandidateSyncInFlight = false;
      if (pappCandidateSyncPending) schedulePappCandidateSync({ immediate: true });
    }
  }

  function setScoreIntegrationStatus(text, kind = "idle") {
    if (!scoreIntegrationStatus) return;
    scoreIntegrationStatus.textContent = String(text || "");
    scoreIntegrationStatus.dataset.kind = kind === "error" || kind === "ok" ? kind : "idle";
  }

  function setActiveScoreIntegrationStatus(text, kind = "idle") {
    if (activeScoreRegistration().stage === "preliminary") {
      setScoreIntegrationStatus(text, kind);
      return;
    }
    if (!finalRegistrationStatus) return;
    finalRegistrationStatus.textContent = String(text || "");
    finalRegistrationStatus.dataset.kind = kind === "error" || kind === "ok" ? kind : "idle";
  }

  async function invokeTournamentAdapter(method, payload = {}) {
    const adapter = getTournamentAdapter();
    const handler = adapter && adapter[method];
    if (typeof handler !== "function") {
      throw new Error(`PAPP 编排适配器未提供 ${method} 接口`);
    }
    const helper = ensureScoreHelper();
    const roundNo = Math.max(1, Math.trunc(Number(payload.round || helper.activeRound || 1)));
    const round = helper.rounds[roundNo - 1] || null;
    const roundData = Object.prototype.hasOwnProperty.call(payload, "roundData")
      ? payload.roundData
      : round;
    const candidatePlayers = getTournamentCandidatePlayers();
    const checkedInPlayers = candidatePlayers.filter(
      (player) => player && player.checkedIn === true,
    );
    const context = {
      ...payload,
      round: roundNo,
      stage: normalizeWhitespace(payload.stage || (roundData && roundData.stage) || "preliminary"),
      roundData: deepClone(roundData),
      roundCount: helper.roundCount,
      preliminaryRoundCount: helper.preliminaryRoundCount,
      rosterSource: "checkin",
      candidatePlayers,
      candidatePlayerCount: candidatePlayers.length,
      checkedInPlayers,
      checkedInPlayerCount: checkedInPlayers.length,
      tournamentParameters: deepClone(ensureTournamentParametersState()),
      mappingPlayers: mappingPlayersForPappSync(),
      state: deepClone(state),
      apiVersion: "papp-tournament-adapter-v2",
    };
    return handler(context);
  }

  function scoreRoundStartToInputValue(value) {
    const text = normalizeWhitespace(value || "");
    if (!text) return "";
    const normalized = text.replace(" ", "T");
    return normalized.length >= 19 ? normalized.slice(0, 19) : normalized;
  }

  function scoreRoundStartFromInputValue(value) {
    const text = normalizeWhitespace(value || "");
    if (!text) return "";
    const normalized = text.replace("T", " ");
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) {
      return `${normalized}:00`;
    }
    return normalized;
  }

  function scoreRoundStartInputValueFromDate(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function isValidScoreRoundStart(value) {
    const text = normalizeWhitespace(value || "");
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)) {
      return false;
    }
    return Number.isFinite(Date.parse(text.replace(" ", "T")));
  }

  function syncActiveScoreRoundStartFromInput() {
    if (!scoreRoundStartInput) return "";
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const start = scoreRoundStartFromInputValue(scoreRoundStartInput.value);
    if (!round) return start;
    round.roundStartAt = start;
    round.roundStartSource = start ? "frontend" : "";
    helper.updatedAt = now();
    return start;
  }

  function playoffRoundStartField(stage) {
    return stage === "placement" ? "placementRoundStartAt" : "semifinalRoundStartAt";
  }

  function playoffRoundStartSourceField(stage) {
    return stage === "placement" ? "placementRoundStartSource" : "semifinalRoundStartSource";
  }

  function syncActivePlayoffRoundStartFromInput() {
    if (!finalRoundStartInput) return "";
    const registration = ensurePlayoffRegistration();
    const stage = registration.activeStage === "placement" ? "placement" : "semifinal";
    const start = scoreRoundStartFromInputValue(finalRoundStartInput.value);
    registration[playoffRoundStartField(stage)] = start;
    registration[playoffRoundStartSourceField(stage)] = start ? "frontend" : "";
    registration.updatedAt = now();
    return start;
  }

  function applyFinalRoundCurrentTime() {
    if (!finalRoundStartInput) return;
    finalRoundStartInput.value = scoreRoundStartInputValueFromDate(new Date());
    syncActivePlayoffRoundStartFromInput();
    const registration = ensurePlayoffRegistration();
    renderFinalRegistration(null, registration);
    scheduleSave();
  }

  function oqPollSeconds() {
    const inputValue = scoreOqPollSecondsInput && scoreOqPollSecondsInput.value;
    const stateValue = state && state.ui && state.ui.oqPollSeconds;
    const parsed = Math.trunc(Number(inputValue || stateValue || 15));
    return Math.max(5, Number.isFinite(parsed) ? parsed : 15);
  }

  function selectedScoreRoundInfo() {
    const helper = ensureScoreHelper();
    const roundNo = Math.max(1, Math.min(helper.roundCount, helper.activeRound || 1));
    return { helper, round: helper.rounds[roundNo - 1], roundNo };
  }

  function scoreStageRound(stage) {
    const helper = ensureScoreHelper();
    if (stage === "semifinal") return helper.preliminaryRoundCount + 1;
    if (stage === "placement") return helper.preliminaryRoundCount + (skipsSemifinal() ? 1 : 2);
    return helper.activeRound;
  }

  function scoreStagePairings(stage, roundNumber) {
    const helper = ensureScoreHelper();
    if (stage === "semifinal") {
      return ensurePlayoffRegistration().semifinalPairings;
    }
    if (stage === "placement") {
      return ensurePlayoffRegistration().placementPairings;
    }
    const roundNo = Math.max(1, Math.min(helper.preliminaryRoundCount,
      Math.trunc(Number(roundNumber) || helper.activeRound || 1)));
    return helper.rounds[roundNo - 1].pairings;
  }

  function activeScoreRegistration(step = getCurrentStep()) {
    const helper = ensureScoreHelper();
    if (step === "final-registration") {
      const registration = ensurePlayoffRegistration();
      const stage = registration.activeStage === "placement" ? "placement" : "semifinal";
      const round = scoreStageRound(stage);
      return {
        stage,
        round,
        pairings: scoreStagePairings(stage, round),
        title: stage === "semifinal" ? "半决赛" : "决赛与三四名赛",
        registration,
        roundData: {
          stage,
          roundStartAt: registration[playoffRoundStartField(stage)],
          roundEndAt: registration[stage === "placement" ? "placementRoundEndAt" : "semifinalRoundEndAt"],
          windowMinutes: registration[stage === "placement" ? "placementWindowMinutes" : "semifinalWindowMinutes"],
          pairings: scoreStagePairings(stage, round),
        },
      };
    }
    const round = Math.max(1, Math.min(helper.preliminaryRoundCount, helper.activeRound || 1));
    return {
      stage: "preliminary",
      round,
      pairings: scoreStagePairings("preliminary", round),
      title: `预赛第 ${round} 轮`,
      roundData: helper.rounds[round - 1],
    };
  }

  async function applyScoreRoundSettings() {
    const helper = ensureScoreHelper();
    const raw = scoreRoundCountInput && scoreRoundCountInput.value;
    const parsed = Math.trunc(Number(raw));
    if (!Number.isFinite(parsed) || parsed < 1 || String(Number(raw)) !== String(parsed)) {
      showAlert("轮次设置无效", "预赛轮次必须是正整数。");
      return;
    }
    let pappRoundCount;
    try {
      pappRoundCount = await preliminaryRoundCountForPlayerCount(
        getTournamentCandidatePlayers().length,
        parsed,
      );
    } catch (error) {
      const message = normalizeWhitespace(error && error.message) || "PAPP C 轮次设置校验失败";
      setScoreIntegrationStatus(message, "error");
      showAlert("轮次设置无效", message);
      return;
    }
    if (pappRoundCount !== parsed) {
      showAlert("轮次设置无效", "PAPP C 未确认该预赛轮数。");
      return;
    }
    const planOutsideNewCount = sanitizePlannedWithdrawals(
      state.plannedWithdrawals,
    ).find((plan) => plan.round > parsed);
    if (planOutsideNewCount) {
      showAlert(
        "无法缩短预赛轮次",
        `有计划删除安排在第 ${planOutsideNewCount.round} 轮。请先调整或取消该计划，再减少预赛轮次。`,
      );
      return;
    }
    const roundStartAt = scoreRoundStartInput
      ? scoreRoundStartFromInputValue(scoreRoundStartInput.value)
      : "";
    if (roundStartAt && !isValidScoreRoundStart(roundStartAt)) {
      showAlert("本轮开始时间无效", "请填写有效的日期和时间，或清空后再应用。");
      return;
    }
    const snapshot = captureUndoSnapshot();
    const applied = setScoreRoundCount(parsed, { source: "manual" });
    syncActiveScoreRoundStartFromInput();
    renderScoreHelper();
    scheduleSave();
    showUndoSnackbar(`已更新预赛轮次：${applied} 轮`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销轮次设置", 1800);
    });
  }

  function applyScoreCurrentTime() {
    if (!scoreRoundStartInput) return;
    const snapshot = captureUndoSnapshot();
    scoreRoundStartInput.value = scoreRoundStartInputValueFromDate(new Date());
    syncActiveScoreRoundStartFromInput();
    renderScoreHelper();
    scheduleSave();
    showUndoSnackbar("已应用当前时间", () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销当前时间", 1800);
    });
  }

  function pairingIdentity(item) {
    return Array.from(pairingIdentityVariants(item))[0] || "players::";
  }

  function pairingIdentityVariants(item) {
    const value = item && typeof item === "object" ? item : {};
    const identities = new Set();
    const add = (prefix, raw) => {
      const normalized = normalizeWhitespace(raw === null || raw === undefined ? "" : String(raw));
      if (normalized) identities.add(`${prefix}:${normalized}`);
    };

    add("id", value.id);
    add("id", value.pairingId);
    add("table", value.table);
    add("table", value.pendingTable);
    add("game", value.oqGameId || value.gameId);

    const black = normalizeKey(value.black || value.blackName);
    const white = normalizeKey(value.white || value.whiteName);
    if (black || white) {
      identities.add(`players:${black}:${white}`);
      identities.add(`players:${white}:${black}`);
      identities.add(`players-unordered:${[black, white].sort().join(":")}`);
    }

    const metadata = value.metadata && typeof value.metadata === "object"
      ? value.metadata
      : {};
    const papp = metadata.papp && typeof metadata.papp === "object"
      ? metadata.papp
      : {};
    add("player", papp.blackPlayerId);
    add("player", papp.whitePlayerId);
    return identities;
  }

  function pairingIdentitiesOverlap(first, second) {
    const left = pairingIdentityVariants(first);
    const right = pairingIdentityVariants(second);
    for (const value of left) {
      if (right.has(value)) return true;
    }
    return false;
  }

  function isUserPendingScoreItem(item) {
    const kind = normalizeWhitespace(item && item.pendingKind).toLowerCase();
    return kind.startsWith("user-") || kind.startsWith("manual-") || kind === "user-pending";
  }

  function hasUserPendingForScorePairing(round, pairing) {
    const pending = [
      ...(Array.isArray(round && round.pending) ? round.pending : []),
      ...(Array.isArray(round && round.manualPending) ? round.manualPending : []),
    ];
    return pending.some((item) => isUserPendingScoreItem(item) && pairingIdentitiesOverlap(
      pairing,
      {
        id: item && item.pairingId,
        table: item && (item.pendingTable || item.table),
        oqGameId: item && item.oqGameId,
        black: item && item.black,
        white: item && item.white,
      },
    ));
  }

  function scorePairingStatusText(pairing) {
    if (isLegacyScorePairing(pairing)) return "旧版比赛记录（只读）";
    const status = normalizeWhitespace(pairing && pairing.status).toLowerCase();
    if (status === "completed") return "PAPP 已读回确认";
    if (status === "ready") return "待批量写入 PAPP";
    if (status === "pending") return "待核对";
    if (status === "bye") return "BYE";
    if (status === "dirty") return "旧登记待复核";
    return "待录入比分";
  }

  function getEgPairingLoss(round, stage, pairing, side) {
    const analysis = state && state.egAnalysis && typeof state.egAnalysis === "object"
      ? state.egAnalysis
      : {};
    const byRound = analysis.pairingLossByRound && typeof analysis.pairingLossByRound === "object"
      ? analysis.pairingLossByRound
      : {};
    const bucket = byRound[String(round)] || byRound[round];
    if (!bucket || typeof bucket !== "object") return null;
    const item = pairing && typeof pairing === "object" ? pairing : {};
    const pairingLoss = bucket[String(item.table)] || bucket[item.table];
    if (!pairingLoss || typeof pairingLoss !== "object" || !Array.isArray(pairingLoss.players)) return null;
    if (normalizeWhitespace(pairingLoss.stage).toLowerCase() !== normalizeWhitespace(stage).toLowerCase()) return null;
    const pairingId = normalizeWhitespace(item.id || item.pairingId);
    if (pairingLoss.pairingId && pairingId && normalizeWhitespace(pairingLoss.pairingId) !== pairingId) return null;
    const currentGameId = normalizeWhitespace(item.oqGameId ||
      item.metadata && item.metadata.gameRecord && item.metadata.gameRecord.gameId);
    if (pairingLoss.gameId && currentGameId && normalizeWhitespace(pairingLoss.gameId) !== currentGameId) return null;

    const sideAccount = normalizeKey(item[`${side}Account`] || item[`${side}OqAccount`]);
    const analyzedSideAccount = normalizeKey(pairingLoss[`${side}Account`]);
    if (!sideAccount || sideAccount !== analyzedSideAccount) return null;
    const sidePlayers = pairingLoss.players.filter((player) => {
      const ftdSide = normalizeWhitespace(player && player.ftdSide).toLowerCase();
      const color = normalizeWhitespace(player && player.color).toLowerCase();
      return ftdSide ? ftdSide === side : color === side;
    });
    return sidePlayers.find((player) => normalizeKey(player && player.account) === sideAccount) ||
      sidePlayers.find((player) => normalizeKey(player && player.name) === normalizeKey(item[side] || item[`${side}Name`])) ||
      null;
  }

  function renderEgLossTag(round, stage, pairing, side) {
    const loss = getEgPairingLoss(round, stage, pairing, side);
    if (!loss || !Number.isFinite(Number(loss.totalLoss))) return "";
    const total = Number(loss.totalLoss);
    const average = Number(loss.averageLoss);
    const totalText = Math.abs(total - Math.round(total)) < 0.001
      ? String(Math.round(total))
      : total.toFixed(1);
    const averageText = Number.isFinite(average) ? average.toFixed(2) : "N/A";
    const gameId = normalizeWhitespace(loss.gameId || pairing.oqGameId || "");
    const title = `Egaroucid 子损：总 ${totalText}，平均 ${averageText}${gameId ? `，game ${gameId}` : ""}`;
    return `<span class="score-pairing__ega-loss" title="${escapeHtml(title)}">子损 ${escapeHtml(totalText)}</span>`;
  }

  function renderScorePairing(pairing, registration) {
    const item = pairing && typeof pairing === "object" ? pairing : {};
    const status = normalizeWhitespace(item.status || "imported").toLowerCase();
    const isBye = status === "bye" ||
      Boolean(item.metadata && typeof item.metadata === "object" && item.metadata.bye === true);
    const legacyReadOnly = isLegacyScorePairing(item);
    const blackName = normalizeWhitespace(item.black || item.blackName) || "选手待接入";
    const whiteName = isBye
      ? "BYE"
      : normalizeWhitespace(item.white || item.whiteName) || "选手待接入";
    const blackAccount = normalizeWhitespace(item.blackAccount || item.blackOqAccount);
    const whiteAccount = normalizeWhitespace(item.whiteAccount || item.whiteOqAccount);
    const gameId = normalizeWhitespace(item.oqGameId);
    const stage = normalizeWhitespace(registration && registration.stage || "preliminary");
    const round = Math.max(1, Math.trunc(Number(registration && registration.round) || 1));
    const pairingIdentity = normalizeWhitespace(item.id || item.table);
    const userPending = stage === "preliminary" &&
      hasUserPendingForScorePairing(registration && registration.roundData, item);
    const input = (side, playerName) => `
      <label class="score-pairing__score-field">
        <input
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength="2"
          autocomplete="off"
          value="${scoreValue(item[`${side}Score`]) ?? ""}"
          aria-label="第 ${escapeHtml(item.table || "-")} 台 ${escapeHtml(playerName)} 比分"
          placeholder="—"
          data-score-input="true"
          data-score-stage="${escapeHtml(stage)}"
          data-score-round="${round}"
          data-score-pairing-id="${escapeHtml(pairingIdentity)}"
          data-score-side="${side}"
          ${userPending || legacyReadOnly ? "disabled" : ""}
        />
      </label>`;
    const participantIdentity = (name, account, side) => `
      <div class="score-pairing__identity">
        <div class="score-pairing__name">${escapeHtml(name)}</div>
        <div class="score-pairing__account">OQ · ${escapeHtml(account || "未映射账号")} ${side && !isBye ? renderEgLossTag(round, stage, item, side) : ""}</div>
      </div>`;
    const matchup = isBye
      ? `<div class="score-pairing__matchup">
           <div class="score-pairing__participant score-pairing__participant--bye">${participantIdentity(blackName, blackAccount, "black")}</div>
           <span class="score-pairing__vs" aria-hidden="true">vs</span>
           <div class="score-pairing__participant score-pairing__participant--right score-pairing__participant--bye">
             <div class="score-pairing__identity score-pairing__identity--bye"><div class="score-pairing__name">BYE</div></div>
           </div>
         </div>`
      : `<div class="score-pairing__matchup">
           <div class="score-pairing__participant">
             ${participantIdentity(blackName, blackAccount, "black")}
             ${input("black", blackName)}
           </div>
           <span class="score-pairing__vs" aria-hidden="true">vs</span>
           <div class="score-pairing__participant score-pairing__participant--right">
             ${input("white", whiteName)}
             ${participantIdentity(whiteName, whiteAccount, "white")}
           </div>
         </div>`;
    return `
      <article class="score-pairing score-pairing--${escapeHtml(status)}" data-score-row="true" data-score-pairing-id="${escapeHtml(pairingIdentity)}">
        <div class="score-pairing__table">第 ${escapeHtml(item.table || "-")} 台</div>
        <div class="score-pairing__content">
          ${matchup}
          ${gameId ? `<div class="score-pairing__meta">OQ game ${escapeHtml(gameId)}</div>` : ""}
        </div>
        ${isBye
          ? `<div class="score-pairing__status"><span class="score-pairing__status-text">BYE（免登分对局）</span></div>`
          : `<div class="score-pairing__status"><span class="score-pairing__status-text">${escapeHtml(legacyReadOnly ? "旧版比赛记录（只读）" : userPending ? "手动 pending，请先移回待登记" : scorePairingStatusText(item))}</span></div>`}
      </article>
    `;
  }

  function renderScorePairings(pairings, registration, list = scorePairingsList) {
    if (!list) return;
    const rows = Array.isArray(pairings) ? pairings : [];
    const isPreliminarySearch = list === scorePairingsList &&
      normalizeWhitespace(registration && registration.stage).toLowerCase() === "preliminary";
    const query = isPreliminarySearch && scorePairingSearchInput
      ? normalizeWhitespace(scorePairingSearchInput.value).normalize("NFKC").toLowerCase()
      : "";
    const normalizedRows = rows.map((pairing, index) => {
      const item = pairing && typeof pairing === "object" ? pairing : {};
      const searchValues = [
        item.black, item.blackName, item.white, item.whiteName,
        item.blackAccount, item.blackOqAccount, item.whiteAccount, item.whiteOqAccount,
      ];
      const matches = !query || searchValues.some((value) =>
        normalizeWhitespace(value).normalize("NFKC").toLowerCase().includes(query),
      );
      return { pairing, index, matches };
    });
    const orderedRows = query
      ? normalizedRows.sort((left, right) => Number(right.matches) - Number(left.matches) || left.index - right.index)
      : normalizedRows;
    if (isPreliminarySearch && scorePairingSearchHint) {
      const matchCount = normalizedRows.filter((row) => row.matches).length;
      scorePairingSearchHint.textContent = query
        ? `${matchCount} 台对局匹配，已置顶；其余对局仍保留。`
        : "匹配的对局会置顶，其余对局仍保留。";
    }
    list.innerHTML = orderedRows.length
      ? orderedRows.map(({ pairing }) => renderScorePairing(pairing, registration)).join("")
      : `<div class="score-pairings__empty">${escapeHtml(registration && registration.title || "本轮")}配对尚未生成或接入。</div>`;
  }

  function setRoundPairings(roundNumber, pairings, options = {}) {
    const helper = ensureScoreHelper();
    const roundNo = Math.max(1, Math.min(helper.roundCount, Math.trunc(Number(roundNumber) || helper.activeRound || 1)));
    if (!Array.isArray(pairings)) {
      throw new Error("本轮配对必须是数组");
    }
    const round = helper.rounds[roundNo - 1];
    if (Array.isArray(round.pairings) && round.pairings.some(isLegacyScorePairing)) {
      return deepClone(round.pairings);
    }
    const normalizedPairings = pairings.map((item, index) => {
      const normalized = sanitizeScorePairing(item, index + 1);
      const confirmed = round.pairings.find((current) =>
        isPappReadbackConfirmedPairing(current) &&
        sameScorePairingIdentity(current, normalized) &&
        scorePairingScoresMatch(current, normalized),
      );
      if (confirmed) {
        normalized.status = "completed";
        normalized.pappReadbackAt = confirmed.pappReadbackAt;
      }
      else if (normalized.status === "completed") {
        normalized.status = isBoardScorePairing(normalized) ? "ready" : "imported";
        normalized.pappReadbackAt = "";
      }
      return normalized;
    });
    const pairingsChanged = JSON.stringify(round.pairings) !==
      JSON.stringify(normalizedPairings);
    round.pairings = normalizedPairings;
    if (pairingsChanged && roundNo <= helper.preliminaryRoundCount) {
      state.playoffRegistration = createDefaultPlayoffRegistration(
        helper.preliminaryRoundCount,
      );
    }
    helper.updatedAt = now();
    if (options.source) {
      round.pairings.forEach((item) => {
        item.source = normalizeWhitespace(options.source);
      });
    }
    if (options.render !== false) renderScoreHelper();
    if (options.persist !== false) {
      scheduleSave({ source: options.source === "papp-c" ? "script" : "human" });
    }
    return deepClone(round.pairings);
  }

  function scorePairingGroup(stage, roundNumber) {
    const stageName = normalizeWhitespace(stage || "preliminary").toLowerCase();
    const roundNo = Math.max(1, Math.trunc(Number(roundNumber) || 1));
    if (stageName === "semifinal" || stageName === "placement") {
      const registration = ensurePlayoffRegistration();
      return {
        stage: stageName,
        round: roundNo,
        pairings: stageName === "semifinal"
          ? registration.semifinalPairings
          : registration.placementPairings,
        roundData: null,
      };
    }
    const helper = ensureScoreHelper();
    const round = helper.rounds[roundNo - 1];
    return round
      ? { stage: "preliminary", round: roundNo, pairings: round.pairings, roundData: round }
      : null;
  }

  function pairingInScoreGroup(group, rawId) {
    if (!group) return null;
    const id = normalizeWhitespace(rawId);
    return (Array.isArray(group.pairings) ? group.pairings : []).find((pairing) =>
      normalizeWhitespace(pairing && (pairing.id || pairing.pairingId)) === id,
    ) || null;
  }

  function mergeOqPollResult(roundNumber, result, options = {}) {
    const payload = result && typeof result === "object" ? result : {};
    if (payload.source !== "papp-c") {
      throw new Error("OQ 结果不是由 PAPP C 返回");
    }
    const stage = normalizeWhitespace(options.stage || payload.stage || "preliminary").toLowerCase();
    const roundNo = Math.max(1, Math.trunc(Number(roundNumber || payload.round) || 1));
    // Normalize once: ensureScoreHelper replaces objects, so repeated lookups
    // during this merge would detach earlier pairing references from state.
    const playoff = ensurePlayoffRegistration();
    const helper = state.scoreHelper;
    const groupForMerge = (groupStage, groupRound) => {
      const stageName = normalizeWhitespace(groupStage || "preliminary").toLowerCase();
      const number = Math.max(1, Math.trunc(Number(groupRound) || 1));
      if (stageName === "semifinal" || stageName === "placement") {
        return {
          stage: stageName,
          round: number,
          pairings: stageName === "semifinal" ? playoff.semifinalPairings : playoff.placementPairings,
          roundData: null,
        };
      }
      const round = helper.rounds[number - 1];
      return round ? { stage: "preliminary", round: number, pairings: round.pairings, roundData: round } : null;
    };
    const group = groupForMerge(stage, roundNo);
    if (!group) throw new Error("OQ 结果引用了不存在的比赛轮次");
    if (Array.isArray(group.pairings) && group.pairings.some(isLegacyScorePairing)) {
      return { readyCount: 0, pendingCount: 0, skippedCount: 0, gameAvailableCount: 0, transcriptCount: 0 };
    }
    if (!Array.isArray(group.pairings)) group.pairings = [];

    const accountUpdates = Array.isArray(payload.pairingAccountUpdates)
      ? payload.pairingAccountUpdates
      : [];
    accountUpdates.forEach((raw) => {
      const update = raw && typeof raw === "object" ? raw : {};
      const targetGroup = groupForMerge(update.stage, update.round);
      const target = pairingInScoreGroup(targetGroup, update.pairingId);
      if (!target || isLegacyScorePairing(target)) return;
      setScorePairingOqAccount(target, "black", update.blackAccount);
      setScorePairingOqAccount(target, "white", update.whiteAccount);
      if (targetGroup.roundData && Array.isArray(targetGroup.roundData.pending)) {
        const id = normalizeWhitespace(target.id || target.pairingId);
        targetGroup.roundData.pending = targetGroup.roundData.pending.filter((pending) =>
          isUserPendingScoreItem(pending) ||
          normalizeWhitespace(pending && pending.pairingId) !== id,
        );
      }
    });

    const pairingForCResult = (raw) => {
      const item = raw && typeof raw === "object" ? raw : {};
      const id = normalizeWhitespace(item.id || item.pairingId);
      if (!id) throw new Error("PAPP C 的 OQ 结果缺少配对 id");
      const target = pairingInScoreGroup(group, id);
      if (!target) throw new Error("PAPP C 的 OQ 结果引用了未知配对 " + id);
      return { item, target };
    };

    const readyRows = Array.isArray(payload.ready) ? payload.ready : [];
    readyRows.forEach((raw, index) => {
      const { item, target } = pairingForCResult(raw);
      if (isLegacyScorePairing(target) || normalizeWhitespace(target.status).toLowerCase() === "completed") {
        throw new Error("PAPP C 返回的 OQ ready 与当前只读或已确认配对冲突");
      }
      const normalized = sanitizeScorePairing(item, index + 1);
      if (normalizeWhitespace(normalized.status).toLowerCase() !== "ready") {
        throw new Error("PAPP C 返回的 OQ ready 状态无效");
      }
      Object.assign(target, normalized, {
        id: normalizeWhitespace(target.id || normalized.id),
        source: normalizeWhitespace(target.source) || "papp-c",
        pappReadbackAt: "",
      });
    });

    const currentPairingIds = new Set(group.pairings.map((pairing) =>
      normalizeWhitespace(pairing && (pairing.id || pairing.pairingId)),
    ).filter(Boolean));
    const pendingRows = Array.isArray(payload.pending) ? payload.pending : [];
    pendingRows.forEach((raw) => {
      const item = raw && typeof raw === "object" ? raw : {};
      const id = normalizeWhitespace(item.pairingId || item.id);
      if (!id || !currentPairingIds.has(id)) {
        throw new Error("PAPP C 的 OQ pending 引用了未知配对");
      }
      const target = pairingInScoreGroup(group, id);
      if (!target || isPappReadbackConfirmedPairing(target) ||
          ["human", "user"].includes(normalizeWhitespace(target.lastEditedBy).toLowerCase())) return;
      target.status = "pending";
      target.reason = normalizeWhitespace(item.reason || item.message);
      target.pendingKind = normalizeWhitespace(item.pendingKind || "oq-auto");
    });

    if (stage === "preliminary" && group.roundData) {
      const preservedPending = (Array.isArray(group.roundData.pending) ? group.roundData.pending : []).filter((item) => {
        const pairingId = normalizeWhitespace(item && item.pairingId);
        return isUserPendingScoreItem(item) ||
          item && (item.resolvedByReferee === true || item.resolutionStatus === "resolved") ||
          !pairingId || !currentPairingIds.has(pairingId);
      });
      const mergedPending = preservedPending.slice();
      pendingRows.forEach((raw) => {
        const item = sanitizeScoreItem(raw && typeof raw === "object" ? raw : {});
        const pairingId = normalizeWhitespace(item.pairingId);
        const existingIndex = mergedPending.findIndex((current) =>
          normalizeWhitespace(current && current.id) === normalizeWhitespace(item.id) ||
          (isUserPendingScoreItem(item) && isUserPendingScoreItem(current) &&
            normalizeWhitespace(current && current.pairingId) === pairingId),
        );
        if (existingIndex >= 0) mergedPending[existingIndex] = item;
        else mergedPending.push(item);
      });
      group.roundData.pending = mergedPending;
    }

    const availableRows = Array.isArray(payload.gameAvailable) ? payload.gameAvailable : [];
    availableRows.forEach((raw) => {
      const { item, target } = pairingForCResult(raw);
      target.oqGameAvailable = item.oqGameAvailable === true;
      target.oqGameAvailableAt = Number.isFinite(Number(item.oqGameAvailableAt))
        ? Number(item.oqGameAvailableAt)
        : null;
      target.oqGameAvailableAudit = item.oqGameAvailableAudit && typeof item.oqGameAvailableAudit === "object"
        ? deepClone(item.oqGameAvailableAudit)
        : null;
    });

    const transcriptRows = Array.isArray(payload.oqGameRecords) ? payload.oqGameRecords : [];
    transcriptRows.forEach((raw) => {
      const record = raw && typeof raw === "object" ? raw : {};
      const targetGroup = groupForMerge(record.stage, record.round);
      const target = pairingInScoreGroup(targetGroup, record.pairingId);
      if (!target || isLegacyScorePairing(target) ||
          !record.gameRecord || typeof record.gameRecord !== "object") return;
      target.oqGameId = normalizeWhitespace(record.oqGameId || record.gameRecord.gameId);
      const metadata = target.metadata && typeof target.metadata === "object"
        ? { ...target.metadata }
        : {};
      metadata.gameRecord = deepClone(record.gameRecord);
      delete metadata.oqRecord;
      target.metadata = metadata;
    });

    if (stage === "preliminary") {
      group.roundData.oq = {
        lastPollAt: new Date().toISOString(),
        lastOk: payload.ok !== false,
        lastError: payload.ok === false ? normalizeWhitespace(payload.error || payload.message) : "",
        queryErrors: payload.queryErrors && typeof payload.queryErrors === "object"
          ? deepClone(payload.queryErrors)
          : {},
        window: payload.window && typeof payload.window === "object"
          ? deepClone(payload.window)
          : null,
      };
      helper.updatedAt = now();
    } else {
      playoff.updatedAt = now();
    }
    renderScoreHelper();
    renderFinalRegistration(null, ensurePlayoffRegistration());
    scheduleSave({ source: "oq" });
    return {
      readyCount: readyRows.length,
      pendingCount: pendingRows.length,
      skippedCount: Array.isArray(payload.skipped) ? payload.skipped.length : 0,
      gameAvailableCount: availableRows.length,
      transcriptCount: transcriptRows.length,
      historicalTranscriptCount: Number(payload.historicalTranscriptCount) || 0,
    };
  }
  function adapterResultMessage(result, fallback) {
    if (result && typeof result === "object") {
      const detail = normalizeWhitespace(result.message || result.error || result.detail);
      if (detail) return detail;
    }
    return fallback;
  }

  function assertAdapterSuccess(result, fallback) {
    if (result && typeof result === "object" && result.ok === false) {
      throw new Error(adapterResultMessage(result, fallback));
    }
    return result && typeof result === "object" ? result : {};
  }

  function resultPairings(result) {
    if (Array.isArray(result)) return result;
    if (!result || typeof result !== "object") return [];
    if (Array.isArray(result.pairings)) return result.pairings;
    if (result.roundData && Array.isArray(result.roundData.pairings)) {
      return result.roundData.pairings;
    }
    return [];
  }

  function resultOqPayload(result) {
    if (!result || typeof result !== "object") return null;
    if (result.oq && typeof result.oq === "object") return result.oq;
    if (Array.isArray(result.ready) || Array.isArray(result.pending)) return result;
    return null;
  }

  function resultEgAnalysis(result) {
    if (!result || typeof result !== "object") return null;
    if (result.analysis && typeof result.analysis === "object") return result.analysis;
    if (result.egAnalysis && typeof result.egAnalysis === "object") return result.egAnalysis;
    if (result.egaAnalysis && typeof result.egaAnalysis === "object") return result.egaAnalysis;
    if (result.report && typeof result.report === "object") return result.report;
    if (
      Array.isArray(result.topPlayers) ||
      Array.isArray(result.players) ||
      (result.pairingLossByRound && typeof result.pairingLossByRound === "object")
    ) {
      return result;
    }
    return null;
  }

  function setEgAnalysisResult(rawAnalysis, options = {}) {
    const analysis = sanitizeEgAnalysis(rawAnalysis);
    state.egAnalysis = analysis;
    const helper = ensureScoreHelper();
    helper.updatedAt = now();
    if (options.render !== false) {
      renderScoreHelper();
      renderFinalRegistration(null, ensurePlayoffRegistration());
    }
    if (options.persist !== false) scheduleSave({ source: options.source || "human" });
    return deepClone(analysis);
  }

  function applyEgAnalysisResult(result, options = {}) {
    const analysis = resultEgAnalysis(result);
    if (!analysis) throw new Error("EG 分析接口未返回可用的选手表现数据");
    return setEgAnalysisResult(analysis, options);
  }

  function recordOqPollFailure(roundNumber, error, stage = "preliminary") {
    const group = scorePairingGroup(stage, roundNumber);
    const message = normalizeWhitespace(error && error.message) || "OQ 更新失败";
    if (group && group.stage === "preliminary" && group.roundData) {
      group.roundData.oq = {
        ...group.roundData.oq,
        lastPollAt: new Date().toISOString(),
        lastOk: false,
        lastError: message,
      };
      ensureScoreHelper().updatedAt = now();
    }
    setActiveScoreIntegrationStatus(message, "error");
    renderScoreHelper();
    renderFinalRegistration(null, ensurePlayoffRegistration());
    scheduleSave({ source: "oq" });
  }

  async function importScorePairings() {
    const { roundNo } = selectedScoreRoundInfo();
    const existingRound = ensureScoreHelper().rounds[roundNo - 1];
    if (Array.isArray(existingRound && existingRound.pairings) &&
        existingRound.pairings.some(isLegacyScorePairing)) {
      setScoreIntegrationStatus("当前轮次是旧版比赛历史，只读展示，未重新生成或转换。", "idle");
      renderScoreHelper();
      return;
    }
    let withdrawalResult = { removedNames: [] };
    setBtnBusy(btnImportScorePairings, true, "导入中…", "导入本轮配对");
    setScoreIntegrationStatus(`正在准备第 ${roundNo} 轮配对…`);
    try {
      withdrawalResult = roundNo > 1
        ? await prepareRoundPairingImport(roundNo)
        : withdrawalResult;
      setScoreIntegrationStatus(`正在导入第 ${roundNo} 轮配对…`);
      const result = assertAdapterSuccess(
        await invokeTournamentAdapter("importPairings", {
          round: roundNo,
          mode: "import-pairings",
        }),
        "PAPP 配对导入失败",
      );
      if (result.readOnly === true) {
        setScoreIntegrationStatus("当前轮次是旧版比赛历史，只读展示，未重新生成或转换。", "idle");
        renderScoreHelper();
        return;
      }
      if (result.validationSource !== "papp-c" && result.source !== "papp-c") {
        throw new Error("配对导入未经过 PAPP C 校验");
      }
      const pairings = resultPairings(result);
      if (!pairings.length) {
        throw new Error("PAPP 配对导入接口未返回本轮配对表");
      }
      setRoundPairings(roundNo, pairings, {
        source: result.source === "papp-c" ? "papp-c" : "papp-file",
      });
      const withdrawn = withdrawalResult.removedNames.length
        ? `；已取消签到：${withdrawalResult.removedNames.join("、")}`
        : "";
      setScoreIntegrationStatus(
        `第 ${roundNo} 轮已导入 ${pairings.length} 台配对${withdrawn}`,
        "ok",
      );
      showSnackbar(`已导入第 ${roundNo} 轮配对：${pairings.length} 台${withdrawn}`, 2800);
    } catch (error) {
      const baseMessage = normalizeWhitespace(error && error.message) || "配对导入失败";
      const message = appendWithdrawalContextToError(
        baseMessage,
        withdrawalResult,
        roundNo,
        "配对导入",
      );
      setScoreIntegrationStatus(message, "error");
      showAlert("导入本轮配对失败", message);
    } finally {
      setBtnBusy(btnImportScorePairings, false, "导入中…", "导入本轮配对");
    }
  }

  function importPappPairingsFile(file) {
    if (!file) return;
    if (Number(file.size) > 5 * 1024 * 1024) {
      showAlert("导入配对表失败", "配对表文件过大（超过 5MB）。");
      if (pappPairingsFileInput) pappPairingsFileInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      showAlert("导入配对表失败", "读取配对表文件失败，请检查文件是否损坏或编码是否为 UTF-8。");
      if (pappPairingsFileInput) pappPairingsFileInput.value = "";
    };
    reader.onload = async () => {
      const { roundNo } = selectedScoreRoundInfo();
      const existingRound = ensureScoreHelper().rounds[roundNo - 1];
      if (Array.isArray(existingRound && existingRound.pairings) &&
          existingRound.pairings.some(isLegacyScorePairing)) {
        setScoreIntegrationStatus("当前轮次是旧版比赛历史，只读展示；没有导入覆盖。", "idle");
        if (pappPairingsFileInput) pappPairingsFileInput.value = "";
        return;
      }
      let withdrawalResult = { removedNames: [] };
      setBtnBusy(btnImportPappPairings, true, "导入中…", "导入配对表文件");
      setScoreIntegrationStatus(`正在读取并导入第 ${roundNo} 轮 PAPP 配对表…`);
      try {
        withdrawalResult = roundNo > 1
          ? await prepareRoundPairingImport(roundNo)
          : withdrawalResult;
        const source = String(reader.result || "");
        if (!source.trim()) throw new Error("配对表文件为空");
        const result = assertAdapterSuccess(
          await invokeTournamentAdapter("importPairings", {
            round: roundNo,
            mode: "import-pairings-file",
            pairingSource: source,
            pairingFileName: String(file.name || ""),
          }),
          "PAPP 配对表文件导入失败",
        );
        if (result.readOnly === true) {
          setScoreIntegrationStatus("当前轮次是旧版比赛历史，只读展示，未覆盖或转换。", "idle");
          renderScoreHelper();
          return;
        }
        if (result.validationSource !== "papp-c") throw new Error("导入的配对表未经过 PAPP C 校验");
        const pairings = resultPairings(result);
        if (!pairings.length) throw new Error("PAPP 配对表文件未返回本轮配对");
        setRoundPairings(roundNo, pairings, { source: "papp-file" });
        const withdrawn = withdrawalResult.removedNames.length
          ? `；已取消签到：${withdrawalResult.removedNames.join("、")}`
          : "";
        setScoreIntegrationStatus(
          `第 ${roundNo} 轮已从文件导入 ${pairings.length} 台配对${withdrawn}`,
          "ok",
        );
        showSnackbar(`已导入第 ${roundNo} 轮配对表：${pairings.length} 台${withdrawn}`, 2800);
      } catch (error) {
        const baseMessage = normalizeWhitespace(error && error.message) || "配对表文件导入失败";
        const message = appendWithdrawalContextToError(
          baseMessage,
          withdrawalResult,
          roundNo,
          "配对表导入",
        );
        setScoreIntegrationStatus(message, "error");
        showAlert("导入配对表失败", message);
      } finally {
        setBtnBusy(btnImportPappPairings, false, "导入中…", "导入配对表文件");
        if (pappPairingsFileInput) pappPairingsFileInput.value = "";
      }
    };
    reader.readAsText(file, "utf-8");
  }

  async function refreshScoreRound() {
    const { roundNo } = selectedScoreRoundInfo();
    const existingRound = ensureScoreHelper().rounds[roundNo - 1];
    if (Array.isArray(existingRound && existingRound.pairings) &&
        existingRound.pairings.some(isLegacyScorePairing)) {
      setScoreIntegrationStatus("当前轮次是旧版比赛历史，只读展示；刷新不会触碰历史数据。", "idle");
      renderScoreHelper();
      return;
    }
    let withdrawalResult = { removedNames: [] };
    setBtnBusy(btnRefreshScoreRound, true, "刷新中…", "刷新本轮");
    setScoreIntegrationStatus(`正在准备刷新第 ${roundNo} 轮…`);
    try {
      withdrawalResult = roundNo > 1
        ? await prepareRoundPairingImport(roundNo)
        : withdrawalResult;
      setScoreIntegrationStatus(`正在刷新第 ${roundNo} 轮…`);
      const result = assertAdapterSuccess(
        await invokeTournamentAdapter("refreshRound", {
          round: roundNo,
          mode: "refresh-round",
        }),
        "PAPP 本轮刷新失败",
      );
      if (result.readOnly === true) {
        setScoreIntegrationStatus("当前轮次是旧版比赛历史，只读展示；刷新未改动记录。", "idle");
        renderScoreHelper();
        return;
      }
      if (result.validationSource !== "papp-c" && result.source !== "papp-c") {
        throw new Error("刷新配对未经过 PAPP C 确认");
      }
      const pairings = resultPairings(result);
      if (pairings.length) {
        setRoundPairings(roundNo, pairings, {
          source: result.source === "papp-c" ? "papp-c" : "papp-file",
          render: false,
          persist: false,
        });
      }
      const oqPayload = resultOqPayload(result);
      if (oqPayload) mergeOqPollResult(roundNo, oqPayload);
      else if (pairings.length) {
        renderScoreHelper();
        scheduleSave();
      }
      if (!pairings.length && !oqPayload) {
        throw new Error("刷新接口未返回配对或比分数据");
      }
      setScoreIntegrationStatus(
        `第 ${roundNo} 轮已刷新${pairings.length ? `，配对 ${pairings.length} 台` : ""}${withdrawalResult.removedNames.length ? `；已取消签到：${withdrawalResult.removedNames.join("、")}` : ""}`,
        "ok",
      );
      showSnackbar(`已刷新第 ${roundNo} 轮`, 2200);
    } catch (error) {
      const baseMessage = normalizeWhitespace(error && error.message) || "本轮刷新失败";
      const message = appendWithdrawalContextToError(
        baseMessage,
        withdrawalResult,
        roundNo,
        "刷新",
      );
      setScoreIntegrationStatus(message, "error");
      showAlert("刷新本轮失败", message);
    } finally {
      setBtnBusy(btnRefreshScoreRound, false, "刷新中…", "刷新本轮");
    }
  }

  function shouldRetryFailedEgAnalysis(status, currentState) {
    const value = status && typeof status === "object" ? status : {};
    if (value.running === true || value.pending === true || value.status === "pending" ||
        !normalizeWhitespace(value.error)) return false;
    const saved = currentState && typeof currentState === "object" ? currentState : {};
    const helper = saved.scoreHelper || {};
    const playoff = saved.playoffRegistration || {};
    const groups = [
      ...(Array.isArray(helper.rounds) ? helper.rounds.map((round) => round && round.pairings) : []),
      playoff.semifinalPairings,
      playoff.placementPairings,
    ];
    return groups.some((pairings) => Array.isArray(pairings) && pairings.some((pairing) =>
      !isLegacyScorePairing(pairing) && pairing && pairing.metadata &&
      pairing.metadata.gameRecord && typeof pairing.metadata.gameRecord === "object",
    ));
  }

  async function updateRoundScoresFromOq(options = {}) {
    if (apOwnsAutomation()) {
      if (!options.silent) showSnackbar("AP 正在管理 OQ 轮询和比分登记", 2600);
      return;
    }
    const silent = Boolean(options.silent);
    const registration = activeScoreRegistration();
    const stage = registration.stage;
    const roundNo = registration.round;
    const roundData = registration.roundData || {};
    const pairings = Array.isArray(registration.pairings) ? registration.pairings : [];
    if (pairings.some(isLegacyScorePairing)) {
      setScoreIntegrationStatus("旧版比赛历史为只读，不会从 OQ 修改其比分。", "idle");
      return false;
    }
    const startInput = stage === "preliminary" ? scoreRoundStartInput : finalRoundStartInput;
    const inputStart = startInput ? scoreRoundStartFromInputValue(startInput.value) : "";
    const roundStartAt = inputStart || normalizeWhitespace(roundData.roundStartAt || "");
    if (!roundStartAt || !isValidScoreRoundStart(roundStartAt)) {
      const error = new Error("请先填写有效的本轮开始时间");
      recordOqPollFailure(roundNo, error, stage);
      if (!silent) showAlert("无法更新 OQ 比分", error.message);
      return false;
    }
    if (stage === "preliminary") {
      if (roundData.roundStartAt !== roundStartAt) {
        roundData.roundStartAt = roundStartAt;
        roundData.roundStartSource = "frontend";
        ensureScoreHelper().updatedAt = now();
      }
    } else {
      const playoff = ensurePlayoffRegistration();
      const startField = playoffRoundStartField(stage);
      if (playoff[startField] !== roundStartAt) {
        playoff[startField] = roundStartAt;
        playoff[playoffRoundStartSourceField(stage)] = "frontend";
        playoff.updatedAt = now();
      }
    }
    if (inputStart && startInput && startInput.value !== scoreRoundStartToInputValue(roundStartAt)) {
      startInput.value = scoreRoundStartToInputValue(roundStartAt);
    }
    if (roundData.roundStartAt !== roundStartAt) {
      scheduleSave();
    }

    const updateButton = stage === "preliminary" ? btnUpdateRoundOqScores : btnUpdatePlayoffOqScores;
    if (!silent) {
      setBtnBusy(updateButton, true, "更新中…", stage === "preliminary" ? "从 OQ 更新本轮比分" : "从 OQ 更新本阶段");
    }
    setActiveScoreIntegrationStatus(`正在从 OQ 更新${registration.title}…`);
    try {
      const result = assertAdapterSuccess(
        await invokeTournamentAdapter("pollOqRound", {
          round: roundNo,
          stage,
          roundStartAt,
          roundEndAt: roundData.roundEndAt || "",
          windowMinutes: roundData.windowMinutes || 0,
          roundData: { ...deepClone(roundData), stage, pairings: deepClone(pairings) },
          pairings: deepClone(pairings),
          mode: options.mode || "oq-poll",
        }),
        "PAPP OQ 更新失败",
      );
      if (apOwnsAutomation()) return;
      const summary = mergeOqPollResult(roundNo, result, { stage });
      let egStartError = "";
      if (summary.transcriptCount > 0 || shouldRetryFailedEgAnalysis(egAnalysisStatus, state)) {
        try {
          const egGroup = scorePairingGroup(stage, roundNo);
          const egResult = assertAdapterSuccess(
            await invokeTournamentAdapter("startEgAnalysis", {
              round: roundNo,
              stage,
              roundStartAt,
              roundData: { ...deepClone(egGroup.roundData), stage, pairings: deepClone(egGroup.pairings) },
              pairings: deepClone(egGroup.pairings),
              mode: "eg-auto-start",
            }),
            "PAPP EG 分析启动失败",
          );
          egAnalysisStatus = egResult;
          if (resultEgAnalysis(egResult)) applyEgAnalysisResult(egResult, { source: "oq" });
          setEgAnalysisButtonStatus(egAnalysisStatus);
          scheduleEgAnalysisStatusPoll(1200);
        } catch (error) {
          egStartError = normalizeWhitespace(error && error.message) || "EG 分析启动失败";
          egAnalysisStatus = { running: false, pending: false, error: egStartError };
          setEgAnalysisButtonStatus(egAnalysisStatus);
        }
      }
      const queryErrors = result.queryErrors && typeof result.queryErrors === "object"
        ? Object.entries(result.queryErrors)
        : [];
      const pulledText = summary.historicalTranscriptCount
        ? `；历史补抓 ${summary.historicalTranscriptCount} 局棋谱`
        : "";
      if (queryErrors.length) {
        const errorText = queryErrors.slice(0, 3)
          .map(([account, message]) => `${account}：${normalizeWhitespace(message)}`)
          .join("；");
        setActiveScoreIntegrationStatus(
          `${registration.title} OQ 更新：可用 ${summary.readyCount}，pending ${summary.pendingCount}${pulledText}；${queryErrors.length} 个查询失败${errorText ? `（${errorText}）` : ""}`,
          "error",
        );
      } else {
        setActiveScoreIntegrationStatus(
          `${registration.title} OQ 已更新：可用 ${summary.readyCount}，pending ${summary.pendingCount}${pulledText}${egStartError ? `；EG 分析启动失败：${egStartError}` : ""}`,
          egStartError ? "error" : "ok",
        );
      }
      if (!silent) showSnackbar(`OQ 已更新${registration.title}`, 2200);
      return true;
    } catch (error) {
      recordOqPollFailure(roundNo, error, stage);
      if (!silent) {
        showAlert(
          "从 OQ 更新比分失败",
          normalizeWhitespace(error && error.message) || "OQ 更新失败",
        );
      }
      return false;
    } finally {
      if (!silent) {
        setBtnBusy(updateButton, false, "更新中…", stage === "preliminary" ? "从 OQ 更新本轮比分" : "从 OQ 更新本阶段");
      }
    }
  }

  function updateOqScorePollButton() {
    const owned = apOwnsAutomation();
    const enabled = owned || Boolean(oqScorePollEnabled);
    [btnToggleOqScorePoll, btnTogglePlayoffOqScorePoll].forEach((button) => {
      if (!button) return;
      button.textContent = owned ? "AP · OQ 轮询" : enabled ? "停止 OQ 轮询" : "OQ轮询";
      button.disabled = owned;
      button.setAttribute("aria-pressed", enabled ? "true" : "false");
      button.classList.toggle("btn-tonal--active", enabled);
    });
  }

  function scheduleOqScorePoll(delayMs = 0) {
    if (IS_NODE || !oqScorePollEnabled || apOwnsAutomation()) return;
    if (oqScorePollTimer) window.clearTimeout(oqScorePollTimer);
    const delay = Math.max(0, Math.trunc(Number(delayMs) || 0));
    oqScorePollNextAt = Date.now() + delay;
    oqScorePollTimer = window.setTimeout(async () => {
      oqScorePollTimer = null;
      if (!oqScorePollEnabled || oqScorePollInFlight) return;
      oqScorePollInFlight = true;
      try {
        await updateRoundScoresFromOq({ silent: true, mode: "oq-poll" });
      } finally {
        oqScorePollInFlight = false;
        if (oqScorePollEnabled) scheduleOqScorePoll(oqPollSeconds() * 1000);
      }
    }, delay);
  }

  function stopOqScorePolling(options = {}) {
    if (oqScorePollTimer) window.clearTimeout(oqScorePollTimer);
    oqScorePollTimer = null;
    oqScorePollNextAt = 0;
    oqScorePollEnabled = false;
    updateOqScorePollButton();
    if (!options.quiet) showSnackbar("已停止 OQ 轮询", 1800);
  }

  function startOqScorePolling() {
    if (apOwnsAutomation()) return showSnackbar("AP 正在管理 OQ 轮询，请在 AP 面板操作", 2600);
    const seconds = oqPollSeconds();
    state.ui.oqPollSeconds = seconds;
    oqScorePollEnabled = true;
    updateOqScorePollButton();
    scheduleOqScorePoll(0);
    scheduleSave();
    showSnackbar(`已开启 OQ 轮询：每 ${seconds} 秒`, 2200);
  }

  function toggleOqScorePolling() {
    if (oqScorePollEnabled) stopOqScorePolling();
    else startOqScorePolling();
  }

  function setEgAnalysisButtonStatus(status) {
    const value = status && typeof status === "object" ? status : {};
    const running = value.running === true;
    const pending = value.pending === true || value.status === "pending";
    [btnToggleEgAnalysis, btnTogglePlayoffEgAnalysis].forEach((button) => {
      if (!button) return;
      button.classList.toggle("btn-eg-analysis--on", running);
      button.classList.toggle("btn-eg-analysis--off", !running && !pending);
      button.classList.toggle("btn-eg-analysis--pending", pending);
      button.setAttribute("aria-pressed", running ? "true" : "false");
      button.textContent = pending
        ? "EG分析处理中…"
        : running
          ? "停止 EG分析"
          : "EG分析";
      button.disabled = pending;
    });
  }

  function scheduleEgAnalysisStatusPoll(delayMs = 2500) {
    if (IS_NODE) return;
    if (egAnalysisPollTimer) window.clearTimeout(egAnalysisPollTimer);
    egAnalysisPollTimer = window.setTimeout(async () => {
      egAnalysisPollTimer = null;
      if (!egAnalysisPollInFlight) await refreshEgAnalysisStatus({ silent: true });
    }, Math.max(500, Math.trunc(Number(delayMs) || 2500)));
  }

  async function refreshEgAnalysisStatus(options = {}) {
    if (egAnalysisPollInFlight) return egAnalysisStatus;
    egAnalysisPollInFlight = true;
    try {
      const result = assertAdapterSuccess(
        await invokeTournamentAdapter("getEgAnalysisStatus", {
          mode: "eg-status",
        }),
        "PAPP EG 分析状态读取失败",
      );
      egAnalysisStatus = result;
      const analysis = resultEgAnalysis(result);
      if (analysis) {
        const normalized = sanitizeEgAnalysis(analysis);
        if (JSON.stringify(normalized) !== JSON.stringify(sanitizeEgAnalysis(state.egAnalysis))) {
          applyEgAnalysisResult(normalized, { source: "oq" });
        }
      }
      setEgAnalysisButtonStatus(result);
      if (result.running === true || result.pending === true || result.status === "pending") {
        scheduleEgAnalysisStatusPoll();
      } else if (egAnalysisPollTimer) {
        window.clearTimeout(egAnalysisPollTimer);
        egAnalysisPollTimer = null;
      }
      if (result.error) setActiveScoreIntegrationStatus(`EG 分析失败：${result.error}`, "error");
      return result;
    } catch (error) {
      egAnalysisStatus = { running: false, error: normalizeWhitespace(error && error.message) };
      setEgAnalysisButtonStatus(egAnalysisStatus);
      setActiveScoreIntegrationStatus(egAnalysisStatus.error || "EG 分析状态读取失败", "error");
      return null;
    } finally {
      egAnalysisPollInFlight = false;
    }
  }

  async function toggleEgAnalysis() {
    const current = egAnalysisStatus || (await refreshEgAnalysisStatus({ silent: true }));
    const running = Boolean(current && current.running === true);
    const method = running ? "stopEgAnalysis" : "startEgAnalysis";
    const registration = activeScoreRegistration();
    const { stage, round: roundNo } = registration;
    const button = stage === "preliminary" ? btnToggleEgAnalysis : btnTogglePlayoffEgAnalysis;
    const roundStartAt = normalizeWhitespace(registration.roundData && registration.roundData.roundStartAt);
    setBtnBusy(button, true, "处理中…", running ? "停止 EG分析" : "EG分析");
    setActiveScoreIntegrationStatus(`${running ? "正在停止" : "正在启动"}${registration.title} EG 分析…`);
    try {
      const result = assertAdapterSuccess(
        await invokeTournamentAdapter(method, {
          round: roundNo,
          stage,
          roundStartAt,
          roundData: deepClone(registration.roundData),
          pairings: deepClone(registration.pairings),
          mode: running ? "eg-stop" : "eg-start",
        }),
        `PAPP EG 分析${running ? "停止" : "启动"}失败`,
      );
      egAnalysisStatus = {
        ...result,
        running: typeof result.running === "boolean" ? result.running : !running,
      };
      if (resultEgAnalysis(result)) applyEgAnalysisResult(result, { source: "oq" });
      setEgAnalysisButtonStatus(egAnalysisStatus);
      renderScoreHelper();
      renderFinalRegistration(null, ensurePlayoffRegistration());
      setActiveScoreIntegrationStatus(
        `${registration.title} EG 分析${running ? "已停止" : "已启动"}`,
        "ok",
      );
      if (egAnalysisStatus.running === true || egAnalysisStatus.pending === true) {
        scheduleEgAnalysisStatusPoll(1000);
      }
      showSnackbar(`EG 分析${running ? "已停止" : "已启动"}`, 2200);
    } catch (error) {
      const message = normalizeWhitespace(error && error.message) || "EG 分析操作失败";
      egAnalysisStatus = { running, error: message };
      setEgAnalysisButtonStatus(egAnalysisStatus);
      setActiveScoreIntegrationStatus(message, "error");
      showAlert("EG 分析操作失败", message);
    } finally {
      setBtnBusy(button, false, "处理中…", running ? "停止 EG分析" : "EG分析");
      setEgAnalysisButtonStatus(egAnalysisStatus);
    }
  }

  function updateScorePairingRow(row, pairing) {
    if (!row || !pairing) return;
    Array.from(row.classList).forEach((className) => {
      if (className.startsWith("score-pairing--")) row.classList.remove(className);
    });
    row.classList.add(`score-pairing--${normalizeWhitespace(pairing.status || "imported")}`);
    const status = row.querySelector(".score-pairing__status-text");
    if (status) status.textContent = scorePairingStatusText(pairing);
    const meta = row.querySelector(".score-pairing__meta");
    if (meta) {
      const gameId = normalizeWhitespace(pairing.oqGameId);
      meta.textContent = gameId ? `OQ game ${gameId}` : "";
    }
  }

  function updateScoreRegistrationControls() {
    const preliminary = activeScoreRegistration("score-helper");
    const preliminaryReady = preliminary.pairings.filter(isScoreBatchCandidate).length > 0;
    const preliminaryLegacy = preliminary.pairings.some(isLegacyScorePairing);
    if (btnRegisterReadyScores) btnRegisterReadyScores.disabled = scoreBatchInFlight || !preliminaryReady || preliminaryLegacy;
    if (btnOpenPreliminaryStandings) {
      btnOpenPreliminaryStandings.disabled = scoreBatchInFlight || scoreStageAdvanceInFlight ||
        preliminaryLegacy || preliminary.pairings.length === 0;
    }

    const playoff = activeScoreRegistration("final-registration");
    const playoffReady = playoff.pairings.filter(isScoreBatchCandidate).length > 0;
    const playoffLegacy = playoff.pairings.some(isLegacyScorePairing);
    if (btnRegisterPlayoffReadyScores) btnRegisterPlayoffReadyScores.disabled = scoreBatchInFlight || !playoffReady || playoffLegacy;
    if (btnOpenOverallStandings) {
      btnOpenOverallStandings.disabled = scoreBatchInFlight || scoreStageAdvanceInFlight ||
        playoffLegacy || playoff.pairings.length === 0;
    }
  }

  async function updateScorePairingFromInput(event) {
    const input = isElement(event.target) ? event.target : null;
    if (!input || input.getAttribute("data-score-input") !== "true") return;
    const stage = normalizeWhitespace(input.dataset.scoreStage || "preliminary");
    const round = Math.max(1, Math.trunc(Number(input.dataset.scoreRound) || 1));
    const identity = normalizeWhitespace(input.dataset.scorePairingId);
    let pairings = scoreStagePairings(stage, round);
    let pairing = pairings.find((item) =>
      normalizeWhitespace(item.id || item.table) === identity,
    );
    if (!pairing || normalizeWhitespace(pairing.status).toLowerCase() === "bye" ||
        isLegacyScorePairing(pairing)) return;
    if (stage === "preliminary" &&
        hasUserPendingForScorePairing(ensureScoreHelper().rounds[round - 1], pairing)) {
      showSnackbar("该桌处于手动 pending，请先移回待登记", 2200);
      renderScoreHelper();
      return;
    }

    const revisionKey = `${stage}:${round}:${identity}`;
    const revision = ++scoreInputRevision;
    scoreInputRevisions.set(revisionKey, revision);
    const submittedValue = input.value;
    let blackScore = null;
    let whiteScore = null;
    if (submittedValue !== "") {
      if (input.validity && !input.validity.valid) return;
      let completedScore;
      try {
        completedScore = await complementBoardScore(submittedValue, input.dataset.scoreSide);
      } catch (error) {
        if (scoreInputRevisions.get(revisionKey) !== revision || input.value !== submittedValue) return;
        setRegistrationStatus(
          stage,
          normalizeWhitespace(error && error.message) || "PAPP C 比分校验失败",
          "error",
        );
        return;
      }
      if (scoreInputRevisions.get(revisionKey) !== revision || input.value !== submittedValue) return;
      blackScore = completedScore.blackScore;
      whiteScore = completedScore.whiteScore;
      if (blackScore === null || whiteScore === null) return;
    }
    pairings = scoreStagePairings(stage, round);
    pairing = pairings.find((item) =>
      normalizeWhitespace(item.id || item.table) === identity,
    );
    if (!pairing || isLegacyScorePairing(pairing) ||
        normalizeWhitespace(pairing.status).toLowerCase() === "bye") return;
    pairing.status = submittedValue === "" ? "imported" : "ready";
    pairing.blackScore = blackScore;
    pairing.whiteScore = whiteScore;
    pairing.lastEditedBy = "human";
    pairing.lastEditedAt = now();
    pairing.updatedAt = pairing.lastEditedAt;

    const row = input.closest("[data-score-row]");
    if (row) {
      const otherSide = input.dataset.scoreSide === "black" ? "white" : "black";
      const otherInput = row.querySelector(`[data-score-side="${otherSide}"]`);
      if (otherInput) otherInput.value = otherSide === "black" ? blackScore ?? "" : whiteScore ?? "";
      updateScorePairingRow(row, pairing);
    }
    const helper = ensureScoreHelper();
    if (stage === "preliminary") {
      helper.updatedAt = now();
    } else {
      ensurePlayoffRegistration().updatedAt = now();
    }
    updateScoreRegistrationControls();
    if (stage === "preliminary") renderScoreHelperSummary();
    else renderFinalRegistrationSummary();
    scheduleSave();
  }

  function registrationStatusElement(stage) {
    return stage === "preliminary" ? scoreIntegrationStatus : finalRegistrationStatus;
  }

  function setRegistrationStatus(stage, text, kind = "idle") {
    if (stage === "preliminary") setScoreIntegrationStatus(text, kind);
    else if (finalRegistrationStatus) {
      finalRegistrationStatus.textContent = String(text || "");
      finalRegistrationStatus.dataset.kind = kind === "error" || kind === "ok" ? kind : "idle";
    }
  }

  function scoreBatchOperationId(registration, pairings) {
    const rows = pairings.map((pairing) =>
      encodeURIComponent(JSON.stringify([
        normalizeWhitespace(pairing.id || pairing.table),
        scoreParticipantKey(pairing, "black"),
        scoreParticipantKey(pairing, "white"),
        scoreValue(pairing.blackScore),
        scoreValue(pairing.whiteScore),
      ])),
    ).sort();
    return `score-${registration.stage}-r${registration.round}:${rows.join("|")}`;
  }

  function scoreReadbackRows(result) {
    if (Array.isArray(result)) return result;
    if (!result || typeof result !== "object") return [];
    if (Array.isArray(result.pairings)) return result.pairings;
    if (Array.isArray(result.results)) return result.results;
    if (result.readback && Array.isArray(result.readback.pairings)) return result.readback.pairings;
    return [];
  }

  function applyScoreBatchReadback(registration, submittedPairings, readbackPairings) {
    const currentPairings = scoreStagePairings(registration.stage, registration.round);
    const confirmedAt = new Date().toISOString();
    let confirmedCount = 0;
    for (const submitted of submittedPairings) {
      const matchingReadback = readbackPairings.filter((candidate) =>
        scorePairingConfirmedByReadback(submitted, candidate),
      );
      if (matchingReadback.length !== 1) continue;
      const current = currentPairings.find((pairing) =>
        sameScorePairingIdentity(submitted, pairing),
      );
      if (!current || !scorePairingScoresMatch(submitted, current)) continue;
      current.status = "completed";
      current.pappReadbackAt = confirmedAt;
      confirmedCount += 1;
    }
    if (registration.stage === "preliminary") ensureScoreHelper().updatedAt = now();
    else ensurePlayoffRegistration().updatedAt = now();
    return confirmedCount;
  }

  async function registerReadyScores(button) {
    if (scoreBatchInFlight) return;
    const registration = activeScoreRegistration();
    const pairings = registration.pairings
      .filter(isScoreBatchCandidate)
      .map((pairing) => deepClone(pairing));
    if (!pairings.length) {
      showSnackbar("当前阶段没有可批量写入的黄色比分", 2000);
      return;
    }

    const batchId = scoreBatchOperationId(registration, pairings);
    const request = {
      stage: registration.stage,
      round: registration.round,
      batchId,
      pairings,
    };
    let writeAccepted = false;
    scoreBatchInFlight = true;
    setBtnBusy(button, true, "写入并读回中…", "批量写入黄色比分");
    setRegistrationStatus(registration.stage,
      `正在批量写入 ${registration.title} 的 ${pairings.length} 台比分…`);
    updateScoreRegistrationControls();
    try {
      if (!(await persistCurrentStateToLocalService())) {
        throw new Error("人工比分及比赛状态尚未通过本地服务保存，无法写入 PAPP C");
      }
      const writeResult = assertAdapterSuccess(
        await invokeTournamentAdapter("writeScoreBatch", {
          ...request,
          mode: "write-score-batch",
        }),
        "PAPP 批量比分写入失败",
      );
      if (writeResult.ok !== true) throw new Error("PAPP 批量比分接口未确认写入请求");
      writeAccepted = true;
      const readback = assertAdapterSuccess(
        await invokeTournamentAdapter("readScoreBatch", {
          ...request,
          mode: "read-score-batch",
          pairingIds: pairings.map((pairing) => pairing.id),
        }),
        "PAPP 比分读回失败",
      );
      if (readback.ok !== true) throw new Error("PAPP 比分读回接口未确认读取成功");
      const confirmedCount = applyScoreBatchReadback(
        registration,
        pairings,
        scoreReadbackRows(readback),
      );
      if (registration.stage === "preliminary") renderScoreHelper();
      else renderFinalRegistration(null, ensurePlayoffRegistration());
      scheduleSave({ source: "script" });
      const remaining = pairings.length - confirmedCount;
      setRegistrationStatus(registration.stage,
        remaining === 0
          ? `${registration.title}：${confirmedCount} 台比分已由 PAPP 读回确认。`
          : `PAPP 写入请求已返回；读回确认 ${confirmedCount}/${pairings.length} 台，其余比分保持黄色。`,
        remaining === 0 ? "ok" : "idle");
      showSnackbar(remaining === 0
        ? `PAPP 已确认 ${confirmedCount} 台比分`
        : `PAPP 读回确认 ${confirmedCount}/${pairings.length} 台`, 2400);
    } catch (error) {
      const detail = normalizeWhitespace(error && error.message) || "比分批量写入或读回失败";
      const message = writeAccepted
        ? `PAPP C 已校验比分，但本地保存或读回确认未完成；比分保持待确认。${detail}`
        : detail;
      setRegistrationStatus(registration.stage, message, "error");
      showAlert("批量登记比分失败", message);
    } finally {
      scoreBatchInFlight = false;
      setBtnBusy(button, false, "写入并读回中…", "批量写入黄色比分");
      updateScoreRegistrationControls();
    }
  }

  function scoreItemSummary(item) {
    const sender =
      normalizeWhitespace(item && item.sender) ||
      [item && item.black, item && item.white]
        .map((value) => normalizeWhitespace(value))
        .filter(Boolean)
        .join(" vs ") ||
      "发图者未识别";
    const loserStoneCount =
      item && Number.isFinite(Number(item.loserStoneCount))
        ? String(Math.trunc(Number(item.loserStoneCount)))
        : "待判定";
    return `${sender}　输者子数：${loserStoneCount}`;
  }

  function renderScoreItem(item, index, mode) {
    const isDone = mode === "completed";
    const isManual = mode === "manualPending";
    const title = scoreItemSummary(item);
    const meta = [
      item.sourceTime ? `时间 ${escapeHtml(item.sourceTime)}` : "",
      item.verdict ? `状态 ${escapeHtml(item.verdict)}` : "",
      item.confidence ? `置信 ${escapeHtml(item.confidence)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const oqCandidates = Array.isArray(item && item.oqCandidates) && item.oqCandidates.length
      ? item.oqCandidates
      : Array.isArray(item && item.oqPendingDetail && item.oqPendingDetail.candidates)
        ? item.oqPendingDetail.candidates
        : [];
    const oqCandidateText = oqCandidates.slice(0, 5).map((candidate) => {
      const value = candidate && typeof candidate === "object" ? candidate : {};
      const accounts = [value.blackAccount || value.blackName, value.whiteAccount || value.whiteName]
        .map((entry) => normalizeWhitespace(entry))
        .filter(Boolean)
        .join(" vs ");
      const score = Number.isFinite(Number(value.blackScore)) && Number.isFinite(Number(value.whiteScore))
        ? `${Math.trunc(Number(value.blackScore))}-${Math.trunc(Number(value.whiteScore))}`
        : "待回放";
      const time = normalizeWhitespace(value.createdLocal || value.createdAt);
      const gameId = normalizeWhitespace(value.gameId);
      const replayError = normalizeWhitespace(value.error || value.scoreReason);
      return [time, accounts, score, gameId ? `game ${gameId}` : "", replayError]
        .filter(Boolean)
        .join(" · ");
    }).filter(Boolean);
    const actions =
      mode === "pending"
        ? `<div class="score-card__actions">
            <button class="score-card__btn score-card__btn--primary" type="button" data-score-action="complete" data-score-mode="pending" data-score-index="${index}">登记</button>
            <button class="score-card__btn" type="button" data-score-action="manual-pending" data-score-mode="pending" data-score-index="${index}">暂缓</button>
          </div>`
        : mode === "completed"
          ? `<div class="score-card__actions">
              <button class="score-card__btn" type="button" data-score-action="manual-pending" data-score-mode="completed" data-score-index="${index}">暂缓</button>
            </div>`
          : `<div class="score-card__actions">
              <button class="score-card__btn score-card__btn--primary" type="button" data-score-action="restore-pending" data-score-mode="manualPending" data-score-index="${index}">移回待登记</button>
              <button class="score-card__btn" type="button" data-score-action="complete" data-score-mode="manualPending" data-score-index="${index}">登记</button>
            </div>`;
    return `
      <article class="score-card ${index === 0 && mode === "pending" ? "score-card--active" : ""} ${isManual ? "score-card--manual" : ""}">
        <div class="score-card__index">${isDone ? "✓" : isManual ? "P" : index + 1}</div>
        <div class="score-card__main">
          <div class="score-card__title">${escapeHtml(title)}</div>
          <div class="score-card__detail">选手：${escapeHtml(item.sender || "")}</div>
          ${meta ? `<div class="score-card__meta">${meta}</div>` : ""}
          ${item.resultText ? `<div class="score-card__note">${escapeHtml(item.resultText)}</div>` : ""}
          ${item.accountMismatchText ? `<div class="score-card__detail">${escapeHtml(item.accountMismatchText)}</div>` : ""}
          ${oqCandidateText.length ? `<div class="score-card__meta">OQ 候选：${oqCandidateText.map(escapeHtml).join("；")}</div>` : ""}
          ${actions}
        </div>
      </article>
    `;
  }

  function scorePairingsProgress(pairings) {
    const rows = Array.isArray(pairings) ? pairings : [];
    const eligible = rows.filter((pairing) =>
      normalizeWhitespace(pairing && pairing.status).toLowerCase() !== "bye",
    );
    const confirmed = eligible.filter(isPappReadbackConfirmedPairing).length;
    const ready = eligible.filter(isScoreBatchCandidate).length;
    return { total: rows.length, byes: rows.length - eligible.length, eligible: eligible.length, confirmed, ready };
  }

  function renderScoreHelperSummary() {
    if (!scoreHelperSummary) return;
    const helper = ensureScoreHelper();
    const activeRound = getActiveScoreRound();
    const progress = scorePairingsProgress(activeRound.pairings);
    const manualPending = Array.isArray(activeRound.manualPending) ? activeRound.manualPending.length : 0;
    const startText = activeRound.roundStartAt
      ? activeRound.roundStartAt.replace("T", " ")
      : "未设置";
    scoreHelperSummary.textContent =
      `预赛共 ${helper.preliminaryRoundCount} 轮；第 ${activeRound.round} 轮开始 ${startText}；` +
      `配对 ${progress.total} 台（BYE ${progress.byes}）；PAPP 已确认 ${progress.confirmed}/${progress.eligible}；` +
      `黄色待写入 ${progress.ready}；OQ pending ${activeRound.pending.length}，手动 pending ${manualPending}。`;
    updateTournamentStagePresentation();
  }

  function renderFinalRegistrationSummary(registration = ensurePlayoffRegistration(), preliminaryResult = null) {
    if (!finalRegistrationSummary) return;
    const activeStage = registration.activeStage === "placement" ? "placement" : "semifinal";
    const pairings = activeStage === "semifinal"
      ? registration.semifinalPairings
      : registration.placementPairings;
    const round = scoreStageRound(activeStage);
    const title = activeStage === "semifinal" ? "半决赛" : "决赛与三四名赛";
    const progress = scorePairingsProgress(pairings);
    if (finalRoundStartInput && document.activeElement !== finalRoundStartInput) {
      finalRoundStartInput.value = scoreRoundStartToInputValue(
        registration[playoffRoundStartField(activeStage)],
      );
    }
    const qualifiers = Array.isArray(preliminaryResult && preliminaryResult.standings)
      ? preliminaryResult.standings.slice(0, 4)
      : [];
    const seedText = qualifiers.length
      ? `预赛前四：${qualifiers.map(formatPreliminaryQualifier).join("、")}；`
      : "";
    finalRegistrationSummary.textContent = Array.isArray(pairings) && pairings.length
      ? `${seedText}${title}第 ${round} 轮：配对 ${progress.total} 台；PAPP 已确认 ${progress.confirmed}/${progress.eligible}；黄色待写入 ${progress.ready}。`
      : `${seedText}${title}配对尚未生成。`;
    updateOqScorePollButton();
    setEgAnalysisButtonStatus(egAnalysisStatus);
  }

  function renderScoreHelper() {
    if (!stepScoreHelper) return;
    const helper = ensureScoreHelper();
    const activeRound = getActiveScoreRound();
    if (scoreHelperTitle)
      scoreHelperTitle.textContent = state.competitionName || "预赛登记";
    if (scoreRoundCountInput) {
      scoreRoundCountInput.value = String(helper.preliminaryRoundCount || helper.roundCount);
    }
    if (scoreRoundStartInput) {
      scoreRoundStartInput.value = scoreRoundStartToInputValue(activeRound.roundStartAt);
    }
    if (scoreOqPollSecondsInput) {
      scoreOqPollSecondsInput.value = String(state.ui.oqPollSeconds || 15);
    }
    updateOqScorePollButton();
    setEgAnalysisButtonStatus(egAnalysisStatus || activeRound.eg);

    if (scoreRoundTabs) {
      scoreRoundTabs.innerHTML = helper.rounds
        .map((round) => {
          const pending = round.pending.length;
          const manualPending = Array.isArray(round.manualPending)
            ? round.manualPending.length
            : 0;
          const pairingProgress = scorePairingsProgress(round.pairings);
          const active = round.round === helper.activeRound;
          return `<button class="seg-btn" type="button" role="tab" aria-selected="${active ? "true" : "false"}" data-round="${round.round}">第 ${round.round} 轮 <span>${pairingProgress.confirmed}/${pairingProgress.eligible} · P${pending + manualPending}</span></button>`;
        })
        .join("");
    }

    renderScoreHelperSummary();
    const registration = activeScoreRegistration("score-helper");
    renderScorePairings(registration.pairings, registration, scorePairingsList);

    if (scorePendingList) {
      scorePendingList.innerHTML = activeRound.pending.length
        ? activeRound.pending.map((item, index) => renderScoreItem(item, index, "pending")).join("")
        : `<div class="empty-state empty-state--list"><svg class="empty-state__icon" aria-hidden="true"><use href="#i-done-all"></use></svg><div><div class="empty-state__title">当前轮没有待登记比分</div><div class="empty-state__text">PAPP OQ 适配器返回的 pending 会保留在这里，等待后续核对。</div></div></div>`;
    }

    if (scoreManualPendingList) {
      const manualPending = Array.isArray(activeRound.manualPending)
        ? activeRound.manualPending
        : [];
      scoreManualPendingList.innerHTML = manualPending.length
        ? manualPending.map((item, index) => renderScoreItem(item, index, "manualPending")).join("")
        : `<div class="score-manual-pending__empty">没有手动 pending 项</div>`;
    }

    if (scoreCompletedList) {
      scoreCompletedList.innerHTML = activeRound.completed.length
        ? activeRound.completed.map((item, index) => renderScoreItem(item, index, "completed")).join("")
        : `<div class="score-completed__empty">还没有登记完成项</div>`;
    }
    updateScoreRegistrationControls();
  }

  async function enterScoreHelper() {
    if (scoreStartInFlight) return;

    const candidatePlayers = getTournamentCandidatePlayers();
    const existingHelper = ensureScoreHelper();
    if (hasLegacyTournamentHistory(existingHelper)) {
      existingHelper.activeRound = Math.max(1, Math.min(
        existingHelper.preliminaryRoundCount,
        existingHelper.activeRound || 1,
      ));
      state.step = "score-helper";
      viewStepOverride = null;
      applyStepUI();
      renderScoreHelper();
      setScoreIntegrationStatus("已载入旧版比赛历史；原配对和比分只读展示，不会由 PAPP C 重算。", "idle");
      return;
    }
    const checkedInPlayers = candidatePlayers.filter(
      (player) => player && player.checkedIn === true,
    );
    if (!checkedInPlayers.length) {
      showAlert(
        "无法开始预赛登记",
        "签到表中还没有已签到选手，请先至少完成一名选手的签到。",
      );
      return;
    }

    scoreStartInFlight = true;
    setBtnBusy(btnFinish, true);

    try {
      const preliminaryRoundCount = await preliminaryRoundCountForPlayerCount(
        checkedInPlayers.length,
      );
      setScoreRoundCount(preliminaryRoundCount, {
        source: "auto",
        playerCount: checkedInPlayers.length,
      });
      const helper = ensureScoreHelper();
      helper.activeRound = 1;

      state.step = "score-helper";
      viewStepOverride = null;
      applyStepUI();
      renderScoreHelper();
      setScoreIntegrationStatus(
        `正在把签到表中的 ${candidatePlayers.length} 名候选选手同步到 PAPP，并用其中 ${checkedInPlayers.length} 名已签到选手生成第 1 轮配对…`,
      );
      scheduleSave();

      const result = assertAdapterSuccess(
        await invokeTournamentAdapter("importPairings", {
          round: 1,
          mode: "start-score-registration",
          rosterSource: "checkin",
          candidatePlayers,
          candidatePlayerCount: candidatePlayers.length,
          checkedInPlayers,
          checkedInPlayerCount: checkedInPlayers.length,
        }),
        "PAPP 第一轮配对生成失败",
      );
      if (result.readOnly === true) {
        setScoreIntegrationStatus("已载入旧版比赛历史；原配对和比分只读展示，不会覆盖或转换。", "idle");
        renderScoreHelper();
        return;
      }
      if (result.source !== "papp-c") throw new Error("第一轮配对不是由 PAPP C 生成");
      const pairings = resultPairings(result);
      if (!pairings.length) {
        throw new Error("PAPP 未返回第一轮配对表");
      }

      setRoundPairings(1, pairings, { source: "papp-c" });
      setScoreIntegrationStatus(
        `已同步 ${candidatePlayers.length} 名候选选手；第 1 轮使用 ${checkedInPlayers.length} 名已签到选手，生成 ${pairings.length} 台配对`,
        "ok",
      );
      showSnackbar(
        `已开始预赛登记：同步 ${candidatePlayers.length} 名候选选手，第一轮 ${pairings.length} 台配对`,
        2600,
      );
    } catch (error) {
      const message = normalizeWhitespace(error && error.message) || "PAPP 第一轮配对生成失败";
      setScoreIntegrationStatus(message, "error");
      showAlert("开始预赛登记失败", message);
    } finally {
      scoreStartInFlight = false;
      setBtnBusy(btnFinish, false);
    }
  }

  function returnToCheckinFromScoreHelper() {
    stopOqScorePolling({ quiet: true });
    state.step = "checkin";
    viewStepOverride = null;
    applyStepUI();
    refreshCheckinUI();
    scheduleSave();
  }

  function completeTopScoreItem() {
    if (!completeScoreItem("pending", 0)) {
      showSnackbar("当前轮没有待登记项", 1800);
    }
  }

  function scoreItemBucket(round, mode) {
    if (!round) return null;
    if (mode === "pending") return round.pending;
    if (mode === "manualPending") return round.manualPending;
    if (mode === "completed") return round.completed;
    return null;
  }

  function completeScoreItem(mode, index) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const source = scoreItemBucket(round, mode);
    const idx = Math.trunc(Number(index));
    if (!Array.isArray(source) || !Number.isFinite(idx) || idx < 0 || idx >= source.length) {
      return false;
    }
    const snapshot = captureUndoSnapshot();
    const item = source.splice(idx, 1)[0];
    item.registeredAt = now();
    item.manualPendingAt = null;
    round.completed.unshift(item);
    helper.updatedAt = now();
    renderScoreHelper();
    scheduleSave();
    showUndoSnackbar(`已登记：${scoreItemSummary(item)}`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销登记", 1800);
    });
    return true;
  }

  function moveScoreItemToManualPending(mode, index) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const source = scoreItemBucket(round, mode);
    const idx = Math.trunc(Number(index));
    if (!Array.isArray(source) || !Number.isFinite(idx) || idx < 0 || idx >= source.length) {
      showSnackbar("没有找到该比分项", 1800);
      return;
    }
    const snapshot = captureUndoSnapshot();
    const item = source.splice(idx, 1)[0];
    item.registeredAt = null;
    item.manualPendingAt = now();
    if (!Array.isArray(round.manualPending)) round.manualPending = [];
    round.manualPending.unshift(item);
    helper.updatedAt = now();
    renderScoreHelper();
    scheduleSave();
    showUndoSnackbar(`已移入手动 pending：${scoreItemSummary(item)}`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销暂缓", 1800);
    });
  }

  function restoreScoreItemToPending(index) {
    const helper = ensureScoreHelper();
    const round = getActiveScoreRound();
    const source = Array.isArray(round && round.manualPending)
      ? round.manualPending
      : [];
    const idx = Math.trunc(Number(index));
    if (!Number.isFinite(idx) || idx < 0 || idx >= source.length) {
      showSnackbar("没有找到该 pending 项", 1800);
      return;
    }
    const snapshot = captureUndoSnapshot();
    const item = source.splice(idx, 1)[0];
    item.manualPendingAt = null;
    round.pending.unshift(item);
    helper.updatedAt = now();
    renderScoreHelper();
    scheduleSave();
    showUndoSnackbar(`已移回待登记：${scoreItemSummary(item)}`, () => {
      restoreUndoSnapshot(snapshot);
      showSnackbar("已撤销移回", 1800);
    });
  }

  function handleScoreItemAction(e) {
    const target = isElement(e.target) ? e.target : null;
    const btn = target && target.closest("button[data-score-action]");
    if (!btn) return;
    const action = btn.dataset.scoreAction;
    const mode = btn.dataset.scoreMode || "";
    const index = Number(btn.dataset.scoreIndex);
    if (action === "complete") completeScoreItem(mode, index);
    else if (action === "manual-pending") moveScoreItemToManualPending(mode, index);
    else if (action === "restore-pending") restoreScoreItemToPending(index);
  }

  function makeSafeFilename(name) {
    const base = normalizeWhitespace(name || "比赛签到表") || "比赛签到表";
    return (
      base
        .replace(/[\\\/:*?"<>|]/g, "_")
        .replace(/[\u0000-\u001F]/g, "_")
        .replace(/\s+/g, "_")
        .slice(0, 80) || "比赛签到表"
    );
  }

  function supportsAnchorDownload() {
    const a = document.createElement("a");
    return typeof a.download === "string";
  }

  function isStandaloneMode() {
    return (
      (window.matchMedia &&
        window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true
    );
  }

  function getUA() {
    return String(window.navigator.userAgent || "");
  }

  function isWeChat() {
    return /MicroMessenger/i.test(getUA());
  }

  function isQQInApp() {
    const ua = getUA();
    return /\bQQ\//i.test(ua) && !/QQBrowser/i.test(ua);
  }

  function isWeCom() {
    return /wxwork/i.test(getUA());
  }

  function isWeibo() {
    return /Weibo/i.test(getUA());
  }

  function isDingTalk() {
    return /DingTalk/i.test(getUA());
  }

  function isAlipay() {
    return /AlipayClient/i.test(getUA());
  }

  function isFeishu() {
    return /Feishu|Lark/i.test(getUA());
  }

  function isBaiduBoxApp() {
    return /baiduboxapp/i.test(getUA());
  }

  function isXiaohongshu() {
    return /XiaoHongShu|xiaohongshu|xhsapp|xhs\//i.test(getUA());
  }

  function isDouyinInApp() {
    return /Aweme|Douyin/i.test(getUA());
  }

  function isToutiaoInApp() {
    return /NewsArticle|Toutiao|BytedanceWebview/i.test(getUA());
  }

  function isKuaishouInApp() {
    return /Kwai|KUAISHOU/i.test(getUA());
  }

  function isBilibiliInApp() {
    return /BiliApp/i.test(getUA());
  }

  function getInAppBrowserName() {
    if (isWeChat()) return "微信";
    if (isWeCom()) return "企业微信";
    if (isQQInApp()) return "QQ";
    if (isWeibo()) return "微博";
    if (isDingTalk()) return "钉钉";
    if (isAlipay()) return "支付宝";
    if (isFeishu()) return "飞书/Lark";
    if (isBaiduBoxApp()) return "百度";
    if (isXiaohongshu()) return "小红书";
    if (isDouyinInApp()) return "抖音";
    if (isToutiaoInApp()) return "今日头条";
    if (isKuaishouInApp()) return "快手";
    if (isBilibiliInApp()) return "哔哩哔哩";
    return "内置浏览器";
  }

  function isLikelyInAppBrowser() {
    // These webviews are common among Mainland CN users and may limit
    // downloads / PWA installation / clipboard APIs.
    return (
      isWeChat() ||
      isWeCom() ||
      isQQInApp() ||
      isWeibo() ||
      isDingTalk() ||
      isAlipay() ||
      isFeishu() ||
      isBaiduBoxApp() ||
      isXiaohongshu() ||
      isDouyinInApp() ||
      isToutiaoInApp() ||
      isKuaishouInApp() ||
      isBilibiliInApp()
    );
  }

  async function copyCurrentPageUrl() {
    const href = normalizeWhitespace(
      (window.location && window.location.href) || "",
    );
    if (!href) {
      showSnackbar("无法读取当前链接，请手动复制地址栏网址。", 2600);
      return false;
    }

    try {
      if (
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(href);
        showSnackbar("已复制当前链接，可粘贴到系统浏览器打开。", 2600);
        return true;
      }
    } catch (e) {
      console.warn("复制链接失败（Clipboard API）：", e);
    }

    try {
      const ta = document.createElement("textarea");
      ta.value = href;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(ta);
      if (copied) {
        showSnackbar("已复制当前链接，可粘贴到系统浏览器打开。", 2600);
        return true;
      }
    } catch (e) {
      console.warn("复制链接失败（execCommand）：", e);
    }

    showManualCopyDialog(href);
    return false;
  }

  function showInAppBrowserGuide(appName, prefKey) {
    const ios = isIOS();
    const platformBrowser = ios ? "Safari" : "Chrome/Edge";
    const message = [
      `检测到你正在使用 ${appName} 内置浏览器，可能出现以下限制：`,
      "1) 下载 CSV/PNG/JSON 可能被拦截",
      "2) “添加到主屏幕”入口可能不可用",
      "",
      "建议操作：",
      "• 先点击「复制当前链接」",
      `• 粘贴到系统浏览器（${platformBrowser}）再打开`,
      "• 导出时优先使用“复制文本”可避免下载拦截",
    ].join("\n");

    showDialog({
      title: "内置浏览器使用提示",
      message,
      buttons: [
        {
          label: "复制当前链接",
          className: "btn btn-tonal",
          onClick: () => {
            copyCurrentPageUrl();
            return false;
          },
        },
        {
          label: "不再提示",
          className: "btn btn-outlined",
          onClick: () => {
            safeLocalStorageSet(prefKey, "1");
            showSnackbar("已关闭内置浏览器提示（仍可在帮助中查看）", 2400);
          },
        },
        { label: "关闭", className: "btn btn-filled" },
      ],
    });
  }

  function maybeShowInAppBrowserTipOnce() {
    try {
      const ua = getUA();
      const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
      if (!isMobile) return;
      if (!isLikelyInAppBrowser()) return;

      const KEY = "checkin_assistant_inapp_tip_v1";
      if (safeLocalStorageGet(KEY)) return;

      const appName = getInAppBrowserName();

      showSnackbar(
        `检测到${appName}内置浏览器：若下载失败或无法添加到桌面，可点“查看方法”。`,
        9000,
        "查看方法",
        () => {
          showInAppBrowserGuide(appName, KEY);
        },
      );
    } catch (e) {
      // No-op
    }
  }

  function isLikelyMobileDevice() {
    try {
      const ua = getUA();
      if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;

      const touchPoints = Number(window.navigator.maxTouchPoints) || 0;
      const coarse =
        window.matchMedia &&
        window.matchMedia("(pointer: coarse) and (hover: none)").matches;
      const minSide = Math.min(
        Number(window.innerWidth) || 0,
        Number(window.innerHeight) || 0,
      );
      return Boolean(touchPoints > 1 && coarse && minSide > 0 && minSide <= 1024);
    } catch (_) {
      return false;
    }
  }

  function isIOS() {
    const ua = getUA();
    const platform = String(
      (window.navigator.userAgentData &&
        window.navigator.userAgentData.platform) ||
        window.navigator.platform ||
        "",
    );
    const iDevice = /iPhone|iPad|iPod/i.test(ua);
    const macLike = /Mac/i.test(platform) || /\bMacintosh\b|\bMac OS X\b/i.test(ua);
    const touchPoints = Number(window.navigator.maxTouchPoints) || 0;
    const definitelyNotApple = /Windows|Win32|Win64|Android|Linux/i.test(
      `${ua} ${platform}`,
    );
    const iPadOS = !definitelyNotApple && macLike && touchPoints > 1;
    return iDevice || iPadOS;
  }

  function canDirectDownloadInCurrentBrowser() {
    const mobileRestrictedInApp = isLikelyInAppBrowser() && isLikelyMobileDevice();
    return supportsAnchorDownload() && !isIOS() && !mobileRestrictedInApp;
  }

  function shouldOpenPNGPreviewWindow() {
    return !canDirectDownloadInCurrentBrowser();
  }

  function triggerAnchorDownload(url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    window.setTimeout(() => {
      if (link.parentNode) link.parentNode.removeChild(link);
    }, 0);
  }

  function triggerObjectUrlDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const inApp = isLikelyInAppBrowser();
    const canDirectDownload = canDirectDownloadInCurrentBrowser();

    if (canDirectDownload) {
      triggerAnchorDownload(url, filename);
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      return "download";
    }

    const opened = window.open(url, "_blank");
    if (!opened) triggerAnchorDownload(url, filename);
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (opened) return "open";
    return inApp ? "inapp" : "download";
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (!canvas || typeof canvas.toBlob !== "function") {
        resolve(null);
        return;
      }
      try {
        canvas.toBlob((blob) => resolve(blob || null), "image/png");
      } catch (e) {
        reject(e);
      }
    });
  }

  function fitTextToWidth(ctx, text, maxWidth) {
    const raw = String(text ?? "");
    if (!raw) return "";
    if (ctx.measureText(raw).width <= maxWidth) return raw;

    let out = raw;
    while (out.length > 1 && ctx.measureText(out + "…").width > maxWidth) {
      out = out.slice(0, -1);
    }
    return out + "…";
  }

  function buildExportCanvasFromData(viewPlayers, settings, options) {
    const s = settings || getExportSettings();
    const opts = options || {};
    const safeIOS = Boolean(opts.safeIOS);
    const players = Array.isArray(viewPlayers) ? viewPlayers : [];
    const title = state.competitionName || "比赛签到表";
    const total = players.length;
    const checkedIn = players.filter((p) => p.checkedIn).length;

    const width = safeIOS ? 1000 : 1280;
    const marginX = safeIOS ? 28 : 40;
    const marginY = safeIOS ? 24 : 30;
    const titleH = safeIOS ? 44 : 48;
    const statsH = safeIOS ? 28 : 28;
    const headerH = safeIOS ? 40 : 44;
    const rowH = safeIOS ? 36 : 40;
    const noteH = safeIOS ? 56 : 34;
    const bottomPad = safeIOS ? 22 : 26;
    const maxCanvasHeight = safeIOS ? 3600 : 32760;

    const tableY = marginY + titleH + statsH + 14;
    const reserved = headerH + bottomPad + noteH;
    const maxRows = Math.max(
      1,
      Math.floor((maxCanvasHeight - tableY - reserved) / rowH),
    );
    const visiblePlayers = players.slice(0, maxRows);
    const truncated = players.length > visiblePlayers.length;
    const noteRows = truncated ? 1 : 0;

    const height =
      tableY +
      headerH +
      visiblePlayers.length * rowH +
      noteRows * noteH +
      bottomPad;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.max(height, 240);

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");

    const fontFamily =
      '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

    // Background
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Title
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#1F2937";
    ctx.font = `${safeIOS ? "700 28px" : "700 30px"} ${fontFamily}`;
    ctx.fillText(title, width / 2, marginY + 20);

    // Stats
    ctx.textAlign = "left";
    ctx.fillStyle = "#4B5563";
    ctx.font = `${safeIOS ? "500 17px" : "500 18px"} ${fontFamily}`;
    ctx.fillText(
      `总人数：${total}  |  已签到：${checkedIn}  |  等待中：${total - checkedIn}`,
      marginX,
      marginY + titleH,
    );

    const tableX = marginX;
    const tableW = width - marginX * 2;
    const colIndexW = 88;
    const colStatusW = s.withTime ? 260 : 220;
    const colNameW = tableW - colIndexW - colStatusW;

    // Header
    ctx.fillStyle = "#F3F4F6";
    ctx.fillRect(tableX, tableY, tableW, headerH);

    ctx.fillStyle = "#111827";
    ctx.font = `${safeIOS ? "700 17px" : "700 18px"} ${fontFamily}`;
    ctx.textAlign = "center";
    ctx.fillText("#", tableX + colIndexW / 2, tableY + headerH / 2);
    ctx.textAlign = "left";
    ctx.fillText("选手信息", tableX + colIndexW + 12, tableY + headerH / 2);
    ctx.fillText(
      "签到状态",
      tableX + colIndexW + colNameW + 12,
      tableY + headerH / 2,
    );

    // Rows
    ctx.font = `${safeIOS ? "500 16px" : "500 17px"} ${fontFamily}`;
    for (let i = 0; i < visiblePlayers.length; i++) {
      const p = visiblePlayers[i];
      const y = tableY + headerH + i * rowH;
      const rowIsEven = i % 2 === 0;
      ctx.fillStyle = rowIsEven ? "#FFFFFF" : "#FAFAFA";
      ctx.fillRect(tableX, y, tableW, rowH);

      // Row border
      ctx.strokeStyle = "#E5E7EB";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tableX, y + rowH);
      ctx.lineTo(tableX + tableW, y + rowH);
      ctx.stroke();

      // Name cell: include optional info in one line
      let nameRaw = p.displayName;
      const info = [];
      if (s.withAccount && p.account) info.push(p.account);
      if (s.withClub && p.club) info.push(`俱乐部:${p.club}`);
      if (s.withGroup && p.group) info.push(`组:${p.group}`);
      if (s.withPlatform && p.platform) info.push(p.platform.toUpperCase());
      if (p.isNew) info.push("新人");

      if (info.length) nameRaw = `${nameRaw}（${info.join(" · ")}）`;
      const name = fitTextToWidth(ctx, nameRaw, colNameW - 24);

      ctx.fillStyle = "#111827";
      ctx.textAlign = "center";
      ctx.fillText(String(i + 1), tableX + colIndexW / 2, y + rowH / 2);

      ctx.textAlign = "left";
      ctx.fillStyle = "#111827";
      ctx.fillText(name, tableX + colIndexW + 12, y + rowH / 2);

      ctx.fillStyle = p.checkedIn ? "#059669" : "#6B7280";
      const statusText = p.checkedIn ? "已签到" : "等待中";
      const t =
        s.withTime && p.checkedIn && p.checkedInAt
          ? ` ${formatTime(p.checkedInAt)}`
          : "";
      ctx.fillText(
        statusText + t,
        tableX + colIndexW + colNameW + 12,
        y + rowH / 2,
      );
    }

    // Outer border
    const rowsHeight = headerH + visiblePlayers.length * rowH;
    ctx.strokeStyle = "#D1D5DB";
    ctx.lineWidth = 1;
    ctx.strokeRect(tableX + 0.5, tableY + 0.5, tableW - 1, rowsHeight - 1);

    if (truncated) {
      const noteY = tableY + rowsHeight + Math.floor(noteH / 2);
      ctx.textAlign = "left";
      ctx.fillStyle = "#B45309";
      ctx.font = `${safeIOS ? "600 15px" : "600 16px"} ${fontFamily}`;
      const note = safeIOS
        ? `iOS 兼容模式：PNG 仅导出前 ${visiblePlayers.length} 人，完整数据请用 CSV。`
        : `名单较长，PNG 仅导出前 ${visiblePlayers.length} 人（完整数据请用 CSV）。`;
      ctx.fillText(fitTextToWidth(ctx, note, tableW), tableX, noteY);
    }

    return canvas;
  }

  function buildMappingExportCanvasFromData(rows, options) {
    const opts = options || {};
    const safeIOS = Boolean(opts.safeIOS);
    const mappingRows = Array.isArray(rows) ? rows : [];
    const mapping = ensureMappingState();
    const competitionName = normalizeWhitespace(state.competitionName) || "比赛";
    const groupName = normalizeWhitespace(mapping.groupName);
    const title = groupName
      ? `${competitionName} 映射表 · ${groupName}`
      : `${competitionName} 映射表`;
    const complete = mappingRows.filter(
      (row) => row && row.wechatNick && row.registrationNick && row.oqAccount,
    ).length;
    const valid = mappingRows.filter((row) => {
      const account = normalizeWhitespace(row && row.oqAccount);
      const check = sanitizeMappingCheck(row && row.oqCheck);
      return (
        account &&
        normalizeKey(check.account) === normalizeKey(account) &&
        (check.status === "ok" || check.status === "forced-ok")
      );
    }).length;

    const width = safeIOS ? 1000 : 1280;
    const marginX = safeIOS ? 28 : 40;
    const marginY = safeIOS ? 24 : 30;
    const titleH = safeIOS ? 44 : 48;
    const statsH = safeIOS ? 28 : 28;
    const headerH = safeIOS ? 40 : 44;
    const rowH = safeIOS ? 38 : 42;
    const noteH = safeIOS ? 56 : 34;
    const bottomPad = safeIOS ? 22 : 26;
    const maxCanvasHeight = safeIOS ? 3600 : 32760;
    const tableY = marginY + titleH + statsH + 14;
    const reserved = headerH + bottomPad + noteH;
    const maxRows = Math.max(
      1,
      Math.floor((maxCanvasHeight - tableY - reserved) / rowH),
    );
    const visibleRows = mappingRows.slice(0, maxRows);
    const truncated = mappingRows.length > visibleRows.length;
    const noteRows = truncated ? 1 : 0;
    const height =
      tableY +
      headerH +
      visibleRows.length * rowH +
      noteRows * noteH +
      bottomPad;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.max(height, 240);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");

    const fontFamily =
      '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = "#1F2937";
    ctx.font = `${safeIOS ? "700 28px" : "700 30px"} ${fontFamily}`;
    ctx.fillText(
      fitTextToWidth(ctx, title, width - marginX * 2),
      width / 2,
      marginY + 20,
    );

    ctx.textAlign = "left";
    ctx.fillStyle = "#4B5563";
    ctx.font = `${safeIOS ? "500 17px" : "500 18px"} ${fontFamily}`;
    ctx.fillText(
      `映射行：${mappingRows.length}  |  三项完整：${complete}  |  OQ 已通过：${valid}`,
      marginX,
      marginY + titleH,
    );

    const tableX = marginX;
    const tableW = width - marginX * 2;
    const colIndexW = safeIOS ? 72 : 84;
    const colWechatW = safeIOS ? 250 : 320;
    const colRegistrationW = safeIOS ? 300 : 380;
    const colOqW = tableW - colIndexW - colWechatW - colRegistrationW;

    ctx.fillStyle = "#F3F4F6";
    ctx.fillRect(tableX, tableY, tableW, headerH);
    ctx.fillStyle = "#111827";
    ctx.font = `${safeIOS ? "700 17px" : "700 18px"} ${fontFamily}`;
    ctx.textAlign = "center";
    ctx.fillText("#", tableX + colIndexW / 2, tableY + headerH / 2);
    ctx.textAlign = "left";
    ctx.fillText("微信群昵称", tableX + colIndexW + 12, tableY + headerH / 2);
    ctx.fillText(
      "报名昵称",
      tableX + colIndexW + colWechatW + 12,
      tableY + headerH / 2,
    );
    ctx.fillText(
      "oq账号",
      tableX + colIndexW + colWechatW + colRegistrationW + 12,
      tableY + headerH / 2,
    );

    ctx.font = `${safeIOS ? "500 16px" : "500 17px"} ${fontFamily}`;
    visibleRows.forEach((row, index) => {
      const y = tableY + headerH + index * rowH;
      ctx.fillStyle = index % 2 === 0 ? "#FFFFFF" : "#FAFAFA";
      ctx.fillRect(tableX, y, tableW, rowH);

      ctx.strokeStyle = "#E5E7EB";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tableX, y + rowH);
      ctx.lineTo(tableX + tableW, y + rowH);
      ctx.stroke();

      const wechatNick = normalizeWhitespace(row && row.wechatNick) || "未填写";
      const registrationNick = normalizeWhitespace(row && row.registrationNick) || "未填写";
      const account = normalizeWhitespace(row && row.oqAccount);
      const status = mappingStatusLabel(row);
      const rating = mappingOqRatingLabel(row && row.oqCheck);
      const oqText = account
        ? `${account} · ${status.text}${rating ? ` · ${rating.text}` : ""}`
        : "未填写";

      ctx.fillStyle = "#111827";
      ctx.textAlign = "center";
      ctx.fillText(String(index + 1), tableX + colIndexW / 2, y + rowH / 2);
      ctx.textAlign = "left";
      ctx.fillText(
        fitTextToWidth(ctx, wechatNick, colWechatW - 24),
        tableX + colIndexW + 12,
        y + rowH / 2,
      );
      ctx.fillText(
        fitTextToWidth(ctx, registrationNick, colRegistrationW - 24),
        tableX + colIndexW + colWechatW + 12,
        y + rowH / 2,
      );
      ctx.fillStyle = account
        ? status.className === "mapping-oq-status--invalid"
          ? "#B91C1C"
          : "#111827"
        : "#B45309";
      ctx.fillText(
        fitTextToWidth(ctx, oqText, colOqW - 24),
        tableX + colIndexW + colWechatW + colRegistrationW + 12,
        y + rowH / 2,
      );
    });

    const rowsHeight = headerH + visibleRows.length * rowH;
    ctx.strokeStyle = "#D1D5DB";
    ctx.lineWidth = 1;
    ctx.strokeRect(tableX + 0.5, tableY + 0.5, tableW - 1, rowsHeight - 1);

    if (truncated) {
      const noteY = tableY + rowsHeight + Math.floor(noteH / 2);
      ctx.textAlign = "left";
      ctx.fillStyle = "#B45309";
      ctx.font = `${safeIOS ? "600 15px" : "600 16px"} ${fontFamily}`;
      const note = safeIOS
        ? `iOS 兼容模式：PNG 仅导出前 ${visibleRows.length} 行。`
        : `映射行较多，PNG 仅导出前 ${visibleRows.length} 行。`;
      ctx.fillText(fitTextToWidth(ctx, note, tableW), tableX, noteY);
    }

    return canvas;
  }

  function openPNGPreviewWindow() {
    try {
      const win = window.open("", "_blank");
      if (!win) return null;
      win.document.open();
      win.document.write(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>签到表图片</title>
  <style>
    body{margin:0;padding:18px;background:#f8fafc;color:#111827;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    .tip{position:sticky;top:0;margin:-18px -18px 16px;padding:14px 18px;background:#fff7ed;border-bottom:1px solid #fed7aa;font-size:15px;line-height:1.5}
    .actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:0 0 16px}
    .btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 16px;border:0;border-radius:999px;background:#111827;color:#fff;text-decoration:none;font-size:14px;font-weight:700;cursor:pointer}
    .wrap{display:flex;justify-content:center}
    img{max-width:100%;height:auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 30px rgba(15,23,42,.12)}
  </style>
</head>
<body>
  <div class="tip">正在生成图片…如果稍后显示图片，可直接下载，或长按/右键图片保存。</div>
  <div class="actions">
    <button class="btn" id="png-back" type="button">返回主签到界面</button>
    <a class="btn" id="png-download" href="#" download="签到表.png">下载 PNG</a>
  </div>
  <div class="wrap"><img id="png-preview" alt="签到表图片" /></div>
</body>
</html>`);
      const backBtn = win.document.getElementById("png-back");
      if (backBtn) {
        backBtn.addEventListener("click", () => {
          try {
            if (win.opener && !win.opener.closed) {
              win.opener.focus();
            }
          } catch (e) {
            // ignore
          }
          try {
            win.close();
          } catch (e) {
            // ignore
          }
        });
      }
      win.document.close();
      return win;
    } catch (e) {
      return null;
    }
  }

  function renderPNGPreviewWindow(win, imageUrl, filename) {
    if (!win || !imageUrl) return false;
    try {
      const doc = win.document;
      const tip = doc.querySelector(".tip");
      const img = doc.getElementById("png-preview");
      const downloadLink = doc.getElementById("png-download");
      if (tip) {
        tip.textContent =
          "图片已生成。可点击“下载 PNG”，或长按/右键图片保存。";
      }
      if (img) img.src = imageUrl;
      if (downloadLink) {
        downloadLink.href = imageUrl;
        if (filename) downloadLink.download = filename;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function closePNGPreviewWindow(win) {
    if (!win) return;
    try {
      win.close();
    } catch (e) {
      // ignore
    }
  }

  async function saveCanvasAsPNG(canvas, filename, previewWindow) {
    const inApp = isLikelyInAppBrowser();
    const canDirectDownload = canDirectDownloadInCurrentBrowser();

    if (isIOS() && previewWindow) {
      const dataUrl = canvas.toDataURL("image/png");
      if (renderPNGPreviewWindow(previewWindow, dataUrl, filename)) return "preview";
    }

    const blob = await canvasToBlob(canvas);

    if (blob) {
      const url = URL.createObjectURL(blob);
      if (canDirectDownload) {
        triggerAnchorDownload(url, filename);
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
        return "download";
      }

      if (previewWindow && renderPNGPreviewWindow(previewWindow, url, filename)) {
        return "preview";
      }

      const opened = window.open(url, "_blank");
      if (!opened) triggerAnchorDownload(url, filename);
      if (!isIOS()) window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      if (opened) return "open";
      return inApp ? "inapp" : "download";
    }

    const dataUrl = canvas.toDataURL("image/png");
    if (canDirectDownload) {
      triggerAnchorDownload(dataUrl, filename);
      return "download";
    }

    if (previewWindow && renderPNGPreviewWindow(previewWindow, dataUrl, filename)) {
      return "preview";
    }

    const opened = window.open(dataUrl, "_blank");
    if (!opened) triggerAnchorDownload(dataUrl, filename);
    if (opened) return "open";
    return inApp ? "inapp" : "download";
  }

  function notifyPNGResult(mode, compatMode = false) {
    if (mode === "inapp") {
      showSnackbar(
        "内置浏览器可能拦截图片下载；若未成功，请改用“复制文本”或右上角“在浏览器打开”。",
        3800,
      );
      return;
    }
    if (mode === "open") {
      showSnackbar(
        compatMode
          ? "已使用兼容模式生成 PNG，请在新窗口长按/右键另存为图片"
          : "PNG 已打开，请长按/右键另存为图片",
        3400,
      );
      return;
    }
    if (mode === "preview") {
      showSnackbar("PNG 已在新页面显示，请长按图片保存到相册。", 3600);
      return;
    }
    showSnackbar(
      compatMode ? "已使用兼容模式导出 PNG" : "已开始下载 PNG",
      2400,
    );
  }

  function drawEgRoundRectPath(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(Number(radius) || 0, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function fillEgRoundRect(ctx, x, y, width, height, radius) {
    drawEgRoundRectPath(ctx, x, y, width, height, radius);
    ctx.fill();
  }

  function strokeEgRoundRect(ctx, x, y, width, height, radius) {
    drawEgRoundRectPath(ctx, x, y, width, height, radius);
    ctx.stroke();
  }

  function getEgAnalysisPlayers() {
    const analysis = state && state.egAnalysis ? sanitizeEgAnalysis(state.egAnalysis) : null;
    return analysis && Array.isArray(analysis.topPlayers) ? analysis.topPlayers.slice() : [];
  }

  function egPlayerLabel(player) {
    const name = normalizeWhitespace(player && player.name) || "未命名选手";
    const account = normalizeWhitespace(player && player.account);
    return account ? `${name} (${account})` : name;
  }

  function egPlayerAverageGameLoss(player) {
    const direct = Number(player && player.averageGameLoss);
    if (Number.isFinite(direct)) return direct;
    const values = (Array.isArray(player && player.games) ? player.games : [])
      .filter((game) => game && game.offlineFilled !== true && Number.isFinite(Number(game.totalLoss)))
      .map((game) => Number(game.totalLoss))
      .filter((value) => value >= 0);
    if (!values.length) return Number.POSITIVE_INFINITY;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function getEgTopPlayersForReport() {
    return getEgAnalysisPlayers()
      .sort((a, b) => {
        const avgA = egPlayerAverageGameLoss(a);
        const avgB = egPlayerAverageGameLoss(b);
        if (avgA !== avgB) return avgA - avgB;
        const lossA = Number(a && a.averageLoss);
        const lossB = Number(b && b.averageLoss);
        if (Number.isFinite(lossA) && Number.isFinite(lossB) && lossA !== lossB) {
          return lossA - lossB;
        }
        return egPlayerLabel(a).localeCompare(egPlayerLabel(b), "zh-Hans-CN");
      })
      .slice(0, 10);
  }

  function buildEgCurveReportCanvas(options = {}) {
    const safeIOS = Boolean(options.safeIOS);
    const players = getEgTopPlayersForReport();
    if (!players.length) throw new Error("没有可导出的 EG 选手表现数据");

    const width = safeIOS ? 1200 : 1500;
    const marginX = safeIOS ? 48 : 64;
    const marginTop = safeIOS ? 36 : 42;
    const panelGap = safeIOS ? 20 : 24;
    const panelRows = Math.ceil(players.length / 3);
    const panelW = width - marginX * 2;
    const panelH = safeIOS ? 236 : 256;
    const height = marginTop + 86 + panelRows * panelH + Math.max(0, panelRows - 1) * panelGap + 42;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");
    const fontFamily = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
    const palette = ["#0F766E", "#2563EB", "#B45309", "#7C3AED", "#DC2626", "#0891B2", "#4D7C0F", "#C026D3", "#EA580C", "#475569"];

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#111827";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `${safeIOS ? "700 30px" : "700 34px"} ${fontFamily}`;
    ctx.fillText(`${state.competitionName || "比赛"} EG 选手表现报告`, marginX, 36);
    ctx.fillStyle = "#4B5563";
    ctx.font = `${safeIOS ? "500 16px" : "500 17px"} ${fontFamily}`;
    ctx.fillText("按场均子损从小到大排序 · 每张小图最多 3 人 · ply 1-60 按两手一组统计", marginX, 72);

    const values = [];
    players.forEach((player) => {
      for (let group = 1; group <= 30; group += 1) {
        const item = player.plyGroups && player.plyGroups[String(group)];
        const value = item && Number(item.averageLoss);
        if (Number.isFinite(value)) values.push(value);
      }
    });
    const maxY = Math.max(1, Math.ceil((Math.max(...values, 1) + 1) / 5) * 5);

    for (let panelIndex = 0; panelIndex < panelRows; panelIndex += 1) {
      const panelPlayers = players.slice(panelIndex * 3, panelIndex * 3 + 3);
      const panelX = marginX;
      const panelY = marginTop + 94 + panelIndex * (panelH + panelGap);
      ctx.fillStyle = "#F8FAFC";
      fillEgRoundRect(ctx, panelX, panelY, panelW, panelH, 8);
      ctx.strokeStyle = "#E5E7EB";
      ctx.lineWidth = 1;
      strokeEgRoundRect(ctx, panelX + 0.5, panelY + 0.5, panelW - 1, panelH - 1, 8);

      const plotX = panelX + (safeIOS ? 54 : 64);
      const plotY = panelY + 36;
      const legendW = safeIOS ? 282 : 330;
      const plotW = panelW - (plotX - panelX) - legendW - 28;
      const plotH = panelH - 74;
      const yScale = (value) => plotY + plotH - (Math.max(0, Math.min(maxY, value)) / maxY) * plotH;
      const xScale = (group) => plotX + ((group - 1) / 29) * plotW;

      ctx.fillStyle = "#111827";
      ctx.font = `${safeIOS ? "700 16px" : "700 18px"} ${fontFamily}`;
      ctx.textAlign = "left";
      ctx.fillText(`第 ${panelIndex * 3 + 1}-${panelIndex * 3 + panelPlayers.length} 名`, panelX + 20, panelY + 20);
      ctx.strokeStyle = "#D1D5DB";
      ctx.strokeRect(plotX + 0.5, plotY + 0.5, plotW, plotH);
      ctx.font = `${safeIOS ? "500 12px" : "500 13px"} ${fontFamily}`;
      ctx.fillStyle = "#6B7280";
      ctx.textAlign = "right";
      for (let tick = 0; tick <= 4; tick += 1) {
        const value = (maxY / 4) * tick;
        const y = yScale(value);
        ctx.strokeStyle = tick === 0 ? "#9CA3AF" : "#E5E7EB";
        ctx.beginPath();
        ctx.moveTo(plotX, y);
        ctx.lineTo(plotX + plotW, y);
        ctx.stroke();
        ctx.fillText(String(Math.round(value)), plotX - 8, y);
      }
      ctx.textAlign = "center";
      for (let group = 1; group <= 30; group += 5) {
        ctx.fillText(String(group * 2 - 1), xScale(group), plotY + plotH + 18);
      }
      ctx.fillStyle = "#374151";
      ctx.fillText("ply", plotX + plotW + 24, plotY + plotH + 18);

      panelPlayers.forEach((player, localIdx) => {
        const idx = panelIndex * 3 + localIdx;
        const points = [];
        for (let group = 1; group <= 30; group += 1) {
          const item = player.plyGroups && player.plyGroups[String(group)];
          const value = item && Number(item.averageLoss);
          if (Number.isFinite(value)) points.push({ x: xScale(group), y: yScale(value) });
        }
        ctx.strokeStyle = palette[idx % palette.length];
        ctx.fillStyle = palette[idx % palette.length];
        ctx.lineWidth = 3;
        if (points.length >= 2) {
          ctx.beginPath();
          points.forEach((point, pointIdx) => {
            if (pointIdx === 0) ctx.moveTo(point.x, point.y);
            else {
              const prev = points[pointIdx - 1];
              const midX = (prev.x + point.x) / 2;
              ctx.bezierCurveTo(midX, prev.y, midX, point.y, point.x, point.y);
            }
          });
          ctx.stroke();
        } else if (points.length === 1) {
          ctx.beginPath();
          ctx.arc(points[0].x, points[0].y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      const legendX = plotX + plotW + 26;
      let legendY = plotY + 10;
      ctx.textAlign = "left";
      panelPlayers.forEach((player, localIdx) => {
        const idx = panelIndex * 3 + localIdx;
        ctx.fillStyle = palette[idx % palette.length];
        fillEgRoundRect(ctx, legendX, legendY - 8, 18, 18, 4);
        ctx.fillStyle = "#111827";
        ctx.font = `${safeIOS ? "700 13px" : "700 14px"} ${fontFamily}`;
        ctx.fillText(fitTextToWidth(ctx, egPlayerLabel(player), legendW - 34), legendX + 28, legendY);
        ctx.fillStyle = "#6B7280";
        ctx.font = `${safeIOS ? "500 12px" : "500 13px"} ${fontFamily}`;
        const gameAvg = Number.isFinite(Number(player.averageGameLoss)) ? Number(player.averageGameLoss).toFixed(1) : "N/A";
        const moveAvg = Number.isFinite(Number(player.averageLoss)) ? Number(player.averageLoss).toFixed(2) : "N/A";
        ctx.fillText(`场均 ${gameAvg} · 手均 ${moveAvg}`, legendX + 28, legendY + 18);
        legendY += 54;
      });
    }
    return canvas;
  }

  function buildEgRoundGridReportCanvas(options = {}) {
    const safeIOS = Boolean(options.safeIOS);
    const players = getEgTopPlayersForReport();
    if (!players.length) throw new Error("没有可导出的 EG 选手表现数据");
    const analysis = state && state.egAnalysis ? sanitizeEgAnalysis(state.egAnalysis) : createDefaultEgAnalysis();
    const observedRounds = players.flatMap((player) =>
      Array.isArray(player.games) ? player.games.map((game) => Number(game.round) || 0) : [],
    );
    const roundLimit = Math.max(
      1,
      Number(analysis.roundLimit) || 0,
      ...observedRounds,
      Number(state.scoreHelper && state.scoreHelper.preliminaryRoundCount) || 0,
    );
    const width = safeIOS ? 1180 : 1500;
    const rowH = safeIOS ? 78 : 86;
    const headerY = safeIOS ? 150 : 158;
    const firstRowY = headerY + 54;
    const height = firstRowY + Math.max(0, players.length - 1) * rowH + 84;
    const marginX = safeIOS ? 44 : 58;
    const nameW = safeIOS ? 300 : 370;
    const valueW = safeIOS ? 118 : 140;
    const barX = marginX + nameW;
    const barW = width - marginX * 2 - nameW - valueW;
    const barH = safeIOS ? 34 : 38;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 Canvas 2D 上下文");
    const fontFamily = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
    const roundColors = ["#14B8A6", "#22D3EE", "#2563EB", "#7C3AED", "#F97316", "#DC2626", "#84CC16", "#C026D3", "#0F766E"];

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#111827";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `${safeIOS ? "700 30px" : "700 34px"} ${fontFamily}`;
    ctx.fillText(`${state.competitionName || "比赛"} EG 选手轮次表现`, marginX, 38);
    ctx.fillStyle = "#4B5563";
    ctx.font = `${safeIOS ? "500 16px" : "500 17px"} ${fontFamily}`;
    ctx.fillText("按场均子损从小到大排序 · X 轴为总子损 · 条内每段对应一轮单局子损", marginX, 76);

    const playerBars = players.map((player) => {
      const games = (Array.isArray(player.games) ? player.games : [])
        .map((game) => {
          const round = Math.trunc(Number(game && game.round) || 0);
          const value = Number(game && game.totalLoss);
          return round > 0 && Number.isFinite(value) && value >= 0 && game.offlineFilled !== true
            ? { round, value }
            : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.round - b.round);
      const totalLoss = Number.isFinite(Number(player.totalLoss))
        ? Number(player.totalLoss)
        : games.reduce((sum, game) => sum + game.value, 0);
      const gameAvg = Number.isFinite(Number(player.averageGameLoss))
        ? Number(player.averageGameLoss)
        : games.length
          ? games.reduce((sum, game) => sum + game.value, 0) / games.length
          : 0;
      return { player, games, gameAvg, totalLoss };
    });
    const maxTotalLoss = Math.max(1, ...playerBars.map((item) => item.totalLoss));
    const tickStep = maxTotalLoss <= 120 ? 20 : maxTotalLoss <= 300 ? 50 : 100;
    const maxScale = Math.ceil(maxTotalLoss / tickStep) * tickStep;

    ctx.fillStyle = "#6B7280";
    ctx.font = `${safeIOS ? "600 13px" : "600 14px"} ${fontFamily}`;
    ctx.fillText("选手", marginX, headerY);
    ctx.fillText("总子损", barX, headerY);
    ctx.strokeStyle = "#CBD5E1";
    ctx.lineWidth = 1;
    ctx.font = `${safeIOS ? "600 20px" : "600 24px"} ${fontFamily}`;
    ctx.fillStyle = "#6B7280";
    for (let tick = 0; tick <= maxScale; tick += tickStep) {
      const x = barX + (tick / maxScale) * barW;
      ctx.beginPath();
      ctx.moveTo(x, headerY + 20);
      ctx.lineTo(x, height - 48);
      ctx.stroke();
      ctx.fillText(String(tick), x + 6, headerY - 30);
    }
    ctx.textAlign = "right";
    ctx.font = `${safeIOS ? "600 13px" : "600 14px"} ${fontFamily}`;
    ctx.fillText("总子损", width - marginX, headerY);

    const legendY = height - 34;
    ctx.textAlign = "left";
    ctx.font = `${safeIOS ? "600 12px" : "600 13px"} ${fontFamily}`;
    for (let round = 1; round <= roundLimit; round += 1) {
      const x = marginX + (round - 1) * (safeIOS ? 74 : 84);
      ctx.fillStyle = roundColors[(round - 1) % roundColors.length];
      fillEgRoundRect(ctx, x, legendY - 8, 16, 16, 4);
      ctx.fillStyle = "#475569";
      ctx.fillText(`R${round}`, x + 22, legendY);
    }

    playerBars.forEach((item, idx) => {
      const y = firstRowY + idx * rowH;
      ctx.fillStyle = idx % 2 === 0 ? "#FFFFFF" : "#F9FAFB";
      ctx.fillRect(marginX - 12, y - 32, width - marginX * 2 + 24, rowH);
      ctx.fillStyle = "#111827";
      ctx.font = `${safeIOS ? "600 15px" : "600 16px"} ${fontFamily}`;
      ctx.textAlign = "left";
      ctx.fillText(fitTextToWidth(ctx, egPlayerLabel(item.player), nameW - 18), marginX, y - 10);
      ctx.fillStyle = "#6B7280";
      ctx.font = `${safeIOS ? "500 12px" : "500 13px"} ${fontFamily}`;
      const gameAvgText = Number.isFinite(item.gameAvg) ? item.gameAvg.toFixed(1) : "N/A";
      const moveAvg = Number.isFinite(Number(item.player.averageLoss)) ? Number(item.player.averageLoss).toFixed(2) : "N/A";
      ctx.fillText(`场均子损 ${gameAvgText} · 手均 ${moveAvg}`, marginX, y + 14);

      ctx.fillStyle = "#E5E7EB";
      fillEgRoundRect(ctx, barX, y - barH / 2, barW, barH, barH / 2);
      const fullW = Number.isFinite(item.totalLoss)
        ? Math.max(4, Math.round((Math.min(item.totalLoss, maxScale) / maxScale) * barW))
        : 0;
      const segmentTotal = item.games.reduce((sum, game) => sum + game.value, 0);
      let cursorX = barX;
      ctx.save();
      if (fullW > 0) {
        drawEgRoundRectPath(ctx, barX, y - barH / 2, fullW, barH, barH / 2);
        ctx.clip();
      }
      item.games.forEach((game, gameIdx) => {
        const isLast = gameIdx === item.games.length - 1;
        const segmentW = isLast
          ? Math.max(0, barX + fullW - cursorX)
          : Math.max(2, Math.round(fullW * (game.value / Math.max(1, segmentTotal))));
        if (segmentW <= 0) return;
        ctx.fillStyle = roundColors[(game.round - 1) % roundColors.length];
        ctx.fillRect(cursorX, y - barH / 2, segmentW, barH);
        cursorX += segmentW;
        if (!isLast) {
          ctx.strokeStyle = "rgba(255,255,255,0.72)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(cursorX, y - barH / 2 + 3);
          ctx.lineTo(cursorX, y + barH / 2 - 3);
          ctx.stroke();
        }
      });
      ctx.restore();
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = 2;
      strokeEgRoundRect(ctx, barX, y - barH / 2, Math.max(fullW, 4), barH, barH / 2);

      ctx.fillStyle = "#111827";
      ctx.font = `${safeIOS ? "700 24px" : "700 30px"} ${fontFamily}`;
      ctx.textAlign = "right";
      ctx.fillText(Number.isFinite(item.totalLoss) ? String(Math.round(item.totalLoss)) : "N/A", width - marginX, y - 2);
      ctx.fillStyle = "#6B7280";
      ctx.font = `${safeIOS ? "500 12px" : "500 13px"} ${fontFamily}`;
      ctx.fillText(`场均 ${gameAvgText}`, width - marginX, y + 22);
    });
    return canvas;
  }

  async function exportEgPerformancePngs() {
    if (!btnExportEgPerformancePng) return;
    setBtnBusy(btnExportEgPerformancePng, true, "导出中…", "导出选手表现 PNG");
    let previewWindow = null;
    try {
      const { roundNo, round } = selectedScoreRoundInfo();
      const adapter = getTournamentAdapter();
      const hasCachedReport = getEgAnalysisPlayers().length > 0;
      if (adapter && typeof adapter.getEgAnalysisReport === "function") {
        setScoreIntegrationStatus(`正在读取第 ${roundNo} 轮 EG 分析结果…`);
        const result = await invokeTournamentAdapter("getEgAnalysisReport", {
          round: roundNo,
          mode: "eg-report",
          pairings: deepClone(round.pairings),
          pairingsByRound: deepClone(
            round.helper.rounds.map((item) => ({
              round: item.round,
              pairings: Array.isArray(item.pairings) ? item.pairings : [],
            })),
          ),
        });
        if (result && result.ok === false && result.code === "adapter-not-ready" && hasCachedReport) {
          setScoreIntegrationStatus("EG 报告接口尚未接入，使用已缓存的 EG 分析结果", "idle");
        } else {
          applyEgAnalysisResult(
            assertAdapterSuccess(result, "PAPP EG 分析结果读取失败"),
          );
        }
      } else if (!hasCachedReport) {
        throw new Error("PAPP 适配器未提供 getEgAnalysisReport，且页面没有已缓存的 EG 结果");
      } else {
        setScoreIntegrationStatus("适配器未返回新报告，使用已缓存的 EG 分析结果", "idle");
      }

      const players = getEgTopPlayersForReport();
      if (!players.length) throw new Error("当前没有可导出的 EG 选手表现数据，请先完成 EG 分析");
      const base = makeSafeFilename(state.competitionName || "比赛");
      const safeIOS = isIOS();
      if (shouldOpenPNGPreviewWindow()) previewWindow = openPNGPreviewWindow();
      const curve = buildEgCurveReportCanvas({ safeIOS });
      const mode1 = await saveCanvasAsPNG(curve, `${base}_低子损曲线.png`, previewWindow);
      const grid = buildEgRoundGridReportCanvas({ safeIOS });
      const mode2 = await saveCanvasAsPNG(grid, `${base}_低子损轮次.png`, null);
      notifyPNGResult(mode2 || mode1);
      setScoreIntegrationStatus(`已导出 EG 选手表现 PNG：${players.length} 名选手`, "ok");
    } catch (error) {
      closePNGPreviewWindow(previewWindow);
      const message = normalizeWhitespace(error && error.message) || "导出选手表现 PNG 失败";
      console.error("导出选手表现 PNG 失败：", error);
      setScoreIntegrationStatus(message, "error");
      showSnackbar(`导出失败：${message}`, 3600);
    } finally {
      setBtnBusy(btnExportEgPerformancePng, false, "导出中…", "导出选手表现 PNG");
    }
  }

  function getPappScorePngRenderer() {
    const renderer =
      typeof window !== "undefined" && window.PAPP_SCORE_PNG_RENDERER
        ? window.PAPP_SCORE_PNG_RENDERER
        : null;
    if (
      !renderer ||
      typeof renderer.buildPairingsCanvas !== "function" ||
      typeof renderer.buildScoreCanvas !== "function"
    ) {
      throw new Error("PAPP PNG 绘图模块未加载，请刷新页面后重试");
    }
    return renderer;
  }

  async function exportScoreRoundPng(kind) {
    const isPairings = kind === "pairings";
    const button = isPairings ? btnExportScorePairingsPng : btnExportScoreResultsPng;
    const idleLabel = isPairings ? "导出本轮配对 PNG" : "导出本轮比分 PNG";
    const busyLabel = isPairings ? "生成配对图…" : "生成比分图…";
    if (!button) return;

    setBtnBusy(button, true, busyLabel, idleLabel);
    let previewWindow = null;
    try {
      const { roundNo, round } = selectedScoreRoundInfo();
      const pairings = Array.isArray(round && round.pairings) ? round.pairings : [];
      if (!pairings.length) {
        throw new Error("当前轮还没有配对数据，请先导入或刷新本轮配对");
      }

      const renderer = getPappScorePngRenderer();
      const payload = {
        round: roundNo,
        stage: normalizeWhitespace(round.stage || "preliminary"),
        competitionName: normalizeWhitespace(state.competitionName || ""),
        pairings: deepClone(pairings),
      };
      const accountIndex = new Map();
      pairings.forEach((pairing) => {
        [
          [pairing && pairing.black, pairing && pairing.blackAccount],
          [pairing && pairing.white, pairing && pairing.whiteAccount],
        ].forEach(([name, account]) => {
          const key = normalizeKey(name);
          const value = normalizeWhitespace(account);
          if (key && value && !accountIndex.has(key)) accountIndex.set(key, value);
        });
      });
      const resolveAccount = (name) => accountIndex.get(normalizeKey(name)) || "";
      const canvas = isPairings
        ? renderer.buildPairingsCanvas(payload, resolveAccount)
        : renderer.buildScoreCanvas(pairings, payload);
      const filename = `${makeSafeFilename(state.competitionName || "比赛")}_第${roundNo}轮_${isPairings ? "配对" : "比分"}.png`;

      if (shouldOpenPNGPreviewWindow()) previewWindow = openPNGPreviewWindow();
      const mode = await saveCanvasAsPNG(canvas, filename, previewWindow);
      notifyPNGResult(mode);
      setScoreIntegrationStatus(
        `已导出第 ${roundNo} 轮${isPairings ? "配对" : "比分"} PNG：${pairings.length} 台`,
        "ok",
      );
      return true;
    } catch (error) {
      closePNGPreviewWindow(previewWindow);
      const message = normalizeWhitespace(error && error.message) || "PNG 导出失败";
      setScoreIntegrationStatus(message, "error");
      showSnackbar(`导出失败：${message}`, 3600);
      setBtnBusy(button, false, busyLabel, idleLabel);
      return false;
    } finally {
      setBtnBusy(button, false, busyLabel, idleLabel);
    }
  }

  function setBtnBusy(btn, busy, labelWhenBusy, labelWhenIdle) {
    if (!btn) return;
    btn.disabled = Boolean(busy);
    btn.classList.toggle("is-loading", Boolean(busy));
    if (busy) btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");

    // Do not remove potential icons (we don't use icons inside here but keep safe)
    if (labelWhenBusy || labelWhenIdle) {
      const labelNode = btn.querySelector(".btn__label") || btn;
      if (labelNode) {
        if (busy && labelWhenBusy) labelNode.textContent = labelWhenBusy;
        if (!busy && labelWhenIdle) labelNode.textContent = labelWhenIdle;
      }
    }
  }

  async function captureExportPreviewCanvas(node) {
    if (typeof window.html2canvas !== "function") {
      throw new Error("html2canvas 未加载");
    }

    let clone = null;
    try {
      // Clone to avoid cropping due to scroll
      clone = node.cloneNode(true);
      clone.style.position = "absolute";
      clone.style.left = "-9999px";
      clone.style.top = "0";
      clone.style.width =
        Math.max(node.offsetWidth, node.scrollWidth, 320) + "px";
      clone.style.maxHeight = "none";
      clone.style.overflow = "visible";
      clone.style.background = "#ffffff";

      // Remove media nodes which may introduce cross-origin taint unexpectedly.
      clone
        .querySelectorAll("img,video,canvas,iframe,object,embed")
        .forEach((el) => el.remove());
      const allNodes = [clone, ...clone.querySelectorAll("*")];
      allNodes.forEach((el) => {
        if (isHTMLElement(el)) {
          el.style.backgroundImage = "none";
          el.style.maskImage = "none";
          el.style.webkitMaskImage = "none";
        }
      });

      document.body.appendChild(clone);
      await new Promise((r) => setTimeout(r, 80));

      const width = Math.max(clone.scrollWidth, clone.offsetWidth, 320);
      const height = Math.max(clone.scrollHeight, clone.offsetHeight, 180);

      // Keep canvas under common browser limits to reduce export failure on large lists.
      const sideLimit = 8192;
      const areaLimit = 16_000_000;
      const bySide = Math.min(2, sideLimit / Math.max(width, height));
      const byArea = Math.min(
        2,
        Math.sqrt(areaLimit / Math.max(1, width * height)),
      );
      const captureScale = Math.max(0.75, Math.min(2, bySide, byArea));

      try {
        return await window.html2canvas(clone, {
          scale: captureScale,
          useCORS: true,
          allowTaint: false,
          backgroundColor: "#ffffff",
          logging: false,
        });
      } catch (firstErr) {
        // Retry once with scale=1 for strict browsers / low-memory devices.
        return await window.html2canvas(clone, {
          scale: 1,
          useCORS: true,
          allowTaint: false,
          backgroundColor: "#ffffff",
          logging: false,
        });
      }
    } finally {
      if (clone && clone.parentNode) clone.parentNode.removeChild(clone);
    }
  }

  async function buildPNGCanvasForExport(settings, viewPlayers) {
    const node = exportContainer;
    if (!node) throw new Error("导出预览未加载");

    if (isIOS()) {
      return {
        canvas: buildExportCanvasFromData(viewPlayers, settings, {
          safeIOS: true,
        }),
        compatMode: true,
        iosSafeMode: true,
      };
    }

    try {
      return {
        canvas: await captureExportPreviewCanvas(node),
        compatMode: false,
        iosSafeMode: false,
      };
    } catch (e) {
      console.warn("html2canvas 导出失败，尝试兼容模式：", e);
      return {
        canvas: buildExportCanvasFromData(viewPlayers, settings),
        compatMode: true,
        iosSafeMode: false,
      };
    }
  }

  function prepareExportPreview() {
    if (!Array.isArray(state.players) || state.players.length === 0) {
      showAlert("无法生成总表", "当前没有任何选手数据，请先导入名单。");
      return false;
    }

    populateExportGroupOptions();
    renderExportPreview();
    return true;
  }

  async function exportPNG(options = {}) {
    if (!exportContainer) return;

    const opts = options || {};
    const triggerButton = opts.triggerButton || btnDownloadPng;
    const idleLabel = opts.idleLabel || "下载 PNG";
    const busyLabel = isIOS() ? "打开中…" : "生成中…";
    setBtnBusy(triggerButton, true, busyLabel, idleLabel);
    const settings = getExportSettings();
    const filename = `${makeSafeFilename(state.competitionName)}_签到表.png`;
    const viewPlayers = getExportViewPlayers(settings);
    const previewWindow = shouldOpenPNGPreviewWindow()
      ? openPNGPreviewWindow()
      : null;

    try {
      let canvas = null;
      let compatMode = false;
      if (opts.forceDataCanvas) {
        const iosSafeMode = isIOS();
        canvas = buildExportCanvasFromData(viewPlayers, settings, {
          safeIOS: iosSafeMode,
        });
        compatMode = iosSafeMode;
      } else {
        const built = await buildPNGCanvasForExport(settings, viewPlayers);
        canvas = built.canvas;
        compatMode = built.compatMode;
      }
      const mode = await saveCanvasAsPNG(canvas, filename, previewWindow);
      notifyPNGResult(mode, compatMode);
    } catch (e) {
      closePNGPreviewWindow(previewWindow);
      console.error("导出 PNG 失败：", e);
      showAlert(
        "导出失败",
        "导出 PNG 失败。iPhone/iPad 若无法打开图片页，请用「下载 CSV」或「复制文本」保留结果。",
      );
    } finally {
      setBtnBusy(triggerButton, false, busyLabel, idleLabel);
    }
  }

  async function downloadAsPNG() {
    if (!prepareExportPreview()) return;
    await exportPNG();
  }

  async function quickExportAsPNG() {
    if (!prepareExportPreview()) return;
    await exportPNG({
      triggerButton: btnExportQuick,
      idleLabel: "导出签到 PNG",
      forceDataCanvas: true,
    });
  }

  function csvEscape(value) {
    const s = String(value ?? "");
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function downloadAsCSV() {
    const settings = getExportSettings();
    const players = getExportViewPlayers(settings);

    const headers = ["序号", "昵称/姓名"];
    if (settings.withAccount) headers.push("账号");
    if (settings.withClub) headers.push("俱乐部");
    if (settings.withPlatform) headers.push("平台");
    if (settings.withGroup) headers.push("组别");
    headers.push("签到状态");
    if (settings.withTime) headers.push("签到时间");
    headers.push("新人");

    const lines = [];
    lines.push(headers.join(","));

    players.forEach((p, idx) => {
      const row = [String(idx + 1), csvEscape(p.displayName)];
      if (settings.withAccount) row.push(csvEscape(p.account || ""));
      if (settings.withClub) row.push(csvEscape(p.club || ""));
      if (settings.withPlatform)
        row.push(csvEscape((p.platform || "").toUpperCase()));
      if (settings.withGroup) row.push(csvEscape(p.group || ""));
      row.push(p.checkedIn ? "已签到" : "等待中");
      if (settings.withTime)
        row.push(
          csvEscape(
            p.checkedIn && p.checkedInAt ? formatTime(p.checkedInAt) : "",
          ),
        );
      row.push(p.isNew ? "是" : "否");
      lines.push(row.join(","));
    });

    const csv = "\ufeff" + lines.join("\n"); // BOM for Excel
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const filename = `${makeSafeFilename(state.competitionName)}_签到表.csv`;
    const mode = triggerObjectUrlDownload(blob, filename);

    if (mode === "inapp") {
      showSnackbar(
        "内置浏览器可能拦截 CSV 下载；若未成功，请改用“复制文本”或右上角“在浏览器打开”。",
        3600,
      );
      return;
    }
    if (mode === "open") {
      showSnackbar("已在新窗口打开 CSV，请使用浏览器菜单保存文件", 3200);
      return;
    }
    showSnackbar("已开始下载 CSV", 2200);
  }

  function showManualCopyDialog(text) {
    const root = document.createElement("div");
    root.className = "edit-form";
    root.style.whiteSpace = "normal";

    const note = document.createElement("div");
    note.className = "edit-note";
    note.textContent = "当前环境可能限制自动复制，请手动全选并复制以下文本。";

    const ta = document.createElement("textarea");
    ta.className = "import-manual__textarea";
    ta.readOnly = true;
    ta.value = String(text || "");

    root.appendChild(note);
    root.appendChild(ta);

    showDialog({
      title: "手动复制",
      contentNode: root,
      buttons: [
        {
          label: "全选",
          className: "btn btn-tonal",
          onClick: () => {
            try {
              ta.focus();
              ta.select();
            } catch (_) {
              // ignore
            }
            return false;
          },
        },
        { label: "关闭", className: "btn btn-filled" },
      ],
    });
  }

  async function tryCopyTextToClipboard(text) {
    const value = String(text ?? "");
    if (!value) return false;

    // Modern Clipboard API
    try {
      if (
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (e) {
      // fall through
    }

    // Legacy fallback (execCommand). Some embedded browsers still require this.
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return Boolean(ok);
    } catch (_) {
      return false;
    }
  }

  async function copyTextWithFallback(text, options = {}) {
    const value = String(text ?? "");
    const successToast = options.successToast || "";

    const ok = await tryCopyTextToClipboard(value);
    if (ok) {
      if (successToast) showSnackbar(successToast, 2200);
      return true;
    }

    // Last resort: let user manually copy.
    showManualCopyDialog(value);
    return false;
  }

  async function copyAsText() {
    const settings = getExportSettings();
    const players = getExportViewPlayers(settings);
    const total = players.length;
    const checkedIn = players.filter((p) => p.checkedIn).length;

    const lines = [];
    lines.push(state.competitionName || "比赛签到表");
    lines.push(
      `总人数: ${total} | 已签到: ${checkedIn} | 等待中: ${total - checkedIn}`,
    );
    lines.push("--------------------------------");

    players.forEach((p, idx) => {
      const status = p.checkedIn ? "已签到" : "等待中";
      const extra = [];
      if (settings.withGroup && p.group) extra.push(p.group);
      if (settings.withPlatform && p.platform)
        extra.push(p.platform.toUpperCase());
      if (settings.withAccount && p.account) extra.push(p.account);
      if (settings.withClub && p.club) extra.push(`俱乐部:${p.club}`);
      if (settings.withTime && p.checkedInAt && p.checkedIn)
        extra.push(formatTime(p.checkedInAt));
      if (p.isNew) extra.push("新人");

      const suffix = extra.length ? `（${extra.join(" · ")}）` : "";
      lines.push(`${idx + 1}. ${p.displayName}${suffix} - ${status}`);
    });

    const text = lines.join("\n");

    await copyTextWithFallback(text, { successToast: "已复制到剪贴板" });
  }

  // ------------------------------
  // JSON import/export (optional)
  // ------------------------------
  function buildProgressExportPayload() {
    return {
      version: STORAGE_VERSION,
      appVersion: APP_VERSION,
      exportedAt: now(),
      ap: deepClone(state.ap),
      appMode: state.appMode,
      competitionName: state.competitionName,
      eventSchedule: sanitizeEventSchedule(state.eventSchedule),
      tournamentParameters: sanitizeTournamentParameters(
        state.tournamentParameters,
        state.players,
      ),
      wechatRelaySync: {
        ...sanitizeWechatRelaySync(state.wechatRelaySync),
        enabled: false,
        ready: false,
        lastProcessedMessageId: "",
        lastProcessedCreateTime: 0,
      },
      wechatAutoCheckin: {
        ...sanitizeWechatAutoCheckin(state.wechatAutoCheckin),
        enabled: false,
      },
      nextPlayerId: state.nextPlayerId,
      ui: state.ui,
      groupRules: sanitizeGroupRules(state.groupRules),
      scoreHelper: sanitizeScoreHelper(state.scoreHelper),
      playoffRegistration: sanitizePlayoffRegistration(
        state.playoffRegistration,
        state.scoreHelper.preliminaryRoundCount,
      ),
      standingsSnapshots: sanitizeStandingsSnapshots(
        state.standingsSnapshots,
        state.scoreHelper.pappWorkfileId,
      ),
      plannedWithdrawals: sanitizePlannedWithdrawals(
        state.plannedWithdrawals,
      ),
      mapping: sanitizeMapping(state.mapping),
      survey: sanitizeSurveyState(state.survey),
      players: state.players,
    };
  }

  function showExportProgressJSONFallbackDialog(jsonText, mode) {
    const root = document.createElement("div");
    root.className = "edit-form";
    root.style.whiteSpace = "normal";

    const note = document.createElement("div");
    note.className = "edit-note";

    if (mode === "inapp") {
      note.textContent =
        "检测到内置浏览器环境，文件下载可能被拦截。你可以点击“复制 JSON”，然后在另一台设备用“粘贴导入/导入进度”恢复。";
    } else if (mode === "open") {
      note.textContent =
        "浏览器已在新窗口打开 JSON（可能无法自动保存）。如未保存成功，可先复制 JSON 文本备用。";
    } else {
      note.textContent = "若下载未成功，可先复制 JSON 文本备用。";
    }

    const ta = document.createElement("textarea");
    ta.className = "import-manual__textarea";
    ta.readOnly = true;
    ta.value = String(jsonText || "");

    root.appendChild(note);
    root.appendChild(ta);

    showDialog({
      title: "导出进度 JSON（备用方案）",
      contentNode: root,
      buttons: [
        {
          label: "复制 JSON",
          className: "btn btn-filled",
          onClick: () => {
            // Keep dialog open; some browsers require a user gesture per copy.
            copyTextWithFallback(ta.value, {
              successToast: "已复制 JSON 到剪贴板",
            });
            return false;
          },
        },
        {
          label: "全选",
          className: "btn btn-tonal",
          onClick: () => {
            try {
              ta.focus();
              ta.select();
            } catch (_) {
              // ignore
            }
            return false;
          },
        },
        { label: "关闭", className: "btn btn-outlined" },
      ],
    });
  }

  function exportProgressAsJSON() {
    const payload = buildProgressExportPayload();
    const jsonText = JSON.stringify(payload, null, 2);

    const blob = new Blob([jsonText], {
      type: "application/json;charset=utf-8",
    });
    const filename = `${makeSafeFilename(state.competitionName)}_签到进度.json`;
    const mode = triggerObjectUrlDownload(blob, filename);

    if (mode === "download") {
      showSnackbar("已导出进度 JSON", 2000);
      return;
    }

    // Provide a robust fallback for Mainland CN in-app browsers (WeChat/QQ/Feishu, etc.)
    showExportProgressJSONFallbackDialog(jsonText, mode);
    if (mode === "inapp") {
      showSnackbar("下载可能被内置浏览器拦截：已提供“复制 JSON”备用方案", 3600);
      return;
    }
    if (mode === "open") {
      showSnackbar(
        "已在新窗口打开 JSON；若未保存成功，可在弹窗中复制 JSON 文本",
        3600,
      );
      return;
    }
  }

  function importProgressFromJSONText(rawText, meta = {}) {
    const source = String(meta.source || "text");
    const snapshot = captureUndoSnapshot();

    try {
      const text = String(rawText || "")
        .replace(/^\uFEFF/, "")
        .trim();
      if (!text) {
        showAlert("导入失败", "内容为空：请粘贴/选择有效的 JSON。");
        return false;
      }

      const parsed = JSON.parse(text);
      if (
        !parsed ||
        parsed.version !== STORAGE_VERSION ||
        !Array.isArray(parsed.players)
      ) {
        showAlert("导入失败", "文件/内容格式不正确或版本不匹配。");
        return false;
      }

      const loaded = sanitizeLoadedState({
        version: STORAGE_VERSION,
        appMode: parsed.appMode === "survey" ? "survey" : "competition",
        step: "checkin",
        competitionName: parsed.competitionName,
        eventSchedule: parsed.eventSchedule,
        tournamentParameters: parsed.tournamentParameters,
        ap: parsed.ap,
        wechatRelaySync: parsed.wechatRelaySync,
        wechatAutoCheckin: parsed.wechatAutoCheckin,
        nextPlayerId: parsed.nextPlayerId,
        players: parsed.players,
        ui: parsed.ui || {},
        groupRules: parsed.groupRules,
        scoreHelper: parsed.scoreHelper,
        plannedWithdrawals: parsed.plannedWithdrawals,
        mapping: parsed.mapping,
        survey: parsed.survey,
        // Keep current import texts to avoid confusing the import page after restore.
        clubText: state.clubText || "",
        relayText: state.relayText || "",
        savedAt: now(),
      });

      if (!loaded || !loaded.players || loaded.players.length === 0) {
        showAlert("导入失败", "JSON 中未包含任何有效选手。");
        return false;
      }

      state = loaded;
      state.step = "checkin";
      state.wechatAutoCheckin.enabled = false;
      wechatAutoCheckinStatusText = "";
      viewStepOverride = null;
      stopWechatRelayPolling();
      latestWechatRelayMessage = null;
      latestWechatRelayGroupUsername = "";

      if (competitionTitleEl)
        competitionTitleEl.textContent = state.competitionName;
      if (competitionNameInput)
        competitionNameInput.value = state.competitionName;

      applyStepUI();
      refreshCheckinUI();
      scheduleSave();
      updateWechatRelaySyncUI();
      updateWechatAutoCheckinUI();
      resumeWechatRelayPolling();

      const label =
        source === "file"
          ? "已导入进度（文件）"
          : source === "paste"
            ? "已导入进度（粘贴）"
            : "已导入进度";
      showUndoSnackbar(
        `${label}（并自动保存到本机）`,
        () => {
          restoreUndoSnapshot(snapshot);
          showSnackbar("已撤销导入", 2200);
        },
        6500,
      );
      return true;
    } catch (e) {
      console.error("导入 JSON 失败：", e);
      showAlert(
        "导入失败",
        "无法解析 JSON。请确认内容完整、未被聊天软件截断。",
      );
      return false;
    }
  }

  function importProgressFromJSONFile(file) {
    if (!file) return;

    const maxBytes = 5 * 1024 * 1024; // 5MB
    if (Number(file.size) > maxBytes) {
      showAlert(
        "导入失败",
        "JSON 文件过大（超过 5MB），请确认文件内容是否正确。",
      );
      if (importJsonInput) importJsonInput.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      console.error("读取 JSON 文件失败：", reader.error);
      showAlert(
        "导入失败",
        "读取 JSON 文件失败，请检查文件是否损坏或编码异常。",
      );
      if (importJsonInput) importJsonInput.value = "";
    };

    reader.onload = () => {
      try {
        importProgressFromJSONText(String(reader.result || ""), {
          source: "file",
        });
      } finally {
        if (importJsonInput) importJsonInput.value = "";
      }
    };

    reader.readAsText(file, "utf-8");
  }

  function showImportProgressPasteDialog() {
    const root = document.createElement("div");
    root.className = "edit-form";
    root.style.whiteSpace = "normal";

    const note = document.createElement("div");
    note.className = "edit-note";
    note.textContent =
      "将另一台设备“导出进度”得到的 JSON 内容粘贴到下面，然后点击“导入”。不会上传到服务器；导入会覆盖当前进度，可在导入后点击“撤销”。";

    const ta = document.createElement("textarea");
    ta.className = "import-manual__textarea";
    ta.placeholder = '{\n  "version": ...\n  "players": [...]\n}';
    ta.value = "";

    root.appendChild(note);
    root.appendChild(ta);

    showDialog({
      title: "粘贴导入进度 JSON",
      contentNode: root,
      buttons: [
        {
          label: "导入",
          className: "btn btn-filled",
          onClick: () => {
            const ok = importProgressFromJSONText(ta.value, {
              source: "paste",
            });
            return ok; // true -> close dialog
          },
        },
        {
          label: "清空",
          className: "btn btn-tonal",
          onClick: () => {
            ta.value = "";
            try {
              ta.focus();
            } catch (_) {
              /* ignore */
            }
            return false;
          },
        },
        { label: "关闭", className: "btn btn-outlined" },
      ],
    });

    // Focus after open for quick paste
    setTimeout(() => {
      try {
        ta.focus();
      } catch (_) {
        /* ignore */
      }
    }, 50);
  }

  // ------------------------------
  // Help + regression tests (Plan #1)
  // ------------------------------
  const IMPORT_TESTS = [
    {
      name: "基础：无差别组（账号含括号）",
      clubText: "",
      relayText: `无差别组：\n1. yetaiqi sky111\n2. zhang qiang [ fszq1191]\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "yetaiqi", account: "sky111" },
          { displayName: "zhang qiang", account: "fszq1191" },
        ],
      },
    },
    {
      name: "两段小写：昵称 + 纯字母账号",
      clubText: "",
      relayText: `无差别组：\n1. niuhongli mtqh\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "niuhongli", account: "mtqh" }],
      },
    },
    {
      name: "无差别组：单词拼音姓氏 + 账号仍应解析为昵称+账号",
      clubText: "",
      relayText: `无差别组：\n1. Tang root498\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Tang", account: "root498" }],
      },
    },
    {
      name: "无差别组：同名不同账号不应在导入阶段被合并",
      clubText: "",
      relayText: `无差别组：\n1. dengyuqi yinguo_cat\n2. dengyuqi omgyouwin\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "dengyuqi", account: "yinguo_cat" },
          { displayName: "dengyuqi", account: "omgyouwin" },
        ],
      },
    },
    {
      name: "无差别组：同账号不同名不应在导入阶段被合并",
      clubText: "",
      relayText: `无差别组：\n1. zhangsan sky111\n2. lisi sky111\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "zhangsan", account: "sky111" },
          { displayName: "lisi", account: "sky111" },
        ],
      },
    },
    {
      name: "青少年组：中文名+账号粘连",
      clubText: "",
      relayText: `青少年组：\n13. 王光轩wgxzwl\n`,
      expect: {
        total: 1,
        groups: { 青少年组: 1 },
        contains: [{ displayName: "王光轩", account: "wgxzwl" }],
      },
    },
    {
      name: "新人赛：含俱乐部",
      clubText: "",
      relayText: `新人赛：\n4. 夜洛 Nightspoke 神秘猫猫教\n`,
      expect: {
        total: 1,
        groups: { 新人赛: 1 },
        contains: [
          { displayName: "夜洛", account: "Nightspoke", club: "神秘猫猫教" },
        ],
      },
    },
    {
      name: "标题识别：新人赛组应归入新人赛（兼容常见写法）",
      clubText: "",
      relayText: `新人赛组：\n1. 张三 zhangsan\n`,
      expect: {
        total: 1,
        groups: { 新人赛: 1 },
        contains: [{ displayName: "张三", account: "zhangsan" }],
      },
    },
    {
      name: "分隔符：竖线 | 支持三列（昵称|账号|俱乐部）",
      clubText: "",
      relayText: `无差别组：\n1. 张三|zhangsan|自由俱乐部\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [
          { displayName: "张三", account: "zhangsan", club: "自由俱乐部" },
        ],
      },
    },
    {
      name: "分隔符：斜杠 / 支持三列（昵称/账号/俱乐部）",
      clubText: "",
      relayText: `无差别组：\n1. 张三/zhangsan/自由俱乐部\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [
          { displayName: "张三", account: "zhangsan", club: "自由俱乐部" },
        ],
      },
    },
    {
      name: "字段标签：昵称/账号/俱乐部（常见聊天复制格式）",
      clubText: "",
      relayText: `无差别组：\n昵称：战鹰 账号：Steven ji 俱乐部：自由\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "战鹰", account: "Steven ji", club: "自由" }],
      },
    },
    {
      name: "特殊赛：vint（含纯数字账号 & 中文账号）",
      clubText: "",
      relayText: `特殊赛：\n2. 神 35206\n3. 沉淀 点点要沉淀\n`,
      expect: {
        total: 2,
        groups: { 特殊赛: 2 },
      },
    },
    {
      name: "长期名单：--不参赛应忽略",
      clubText: "",
      relayText: `长期选手，长期俱乐部格式：\n全部名单:\nWang Chen --\nLin Feng\n--为不参加本次比赛\n`,
      expect: {
        total: 1,
        groups: { 长期名单: 1 },
        contains: [{ displayName: "Lin Feng" }],
      },
    },
    {
      name: "长期名单：中英文横杠不参赛标记应忽略",
      clubText: "",
      relayText: `长期选手，长期俱乐部格式：\n全部名单:\nAscii Hyphen --\nEn Dash ––\nEm Dash ——\nFullwidth Hyphen －－\nMinus Sign −−\nComma Tail --，\nLin Feng\n`,
      expect: {
        total: 1,
        groups: { 长期名单: 1 },
        contains: [{ displayName: "Lin Feng" }],
      },
    },
    {
      name: "长期名单：两段拼音姓名（小写）不应被拆成账号",
      clubText: "",
      relayText: `长期选手，长期俱乐部格式：\n全部名单:\nlin feng\n`,
      expect: {
        total: 1,
        groups: { 长期名单: 1 },
        contains: [{ displayName: "lin feng" }],
        accountEmptyFor: ["lin feng"],
      },
    },
    {
      name: "俱乐部区：两段拼音姓名（小写）不应被拆成账号",
      clubText: `yan yiru\n`,
      relayText: "",
      expect: {
        total: 1,
        groups: { 长期成员: 1 },
        contains: [{ displayName: "yan yiru" }],
        accountEmptyFor: ["yan yiru"],
      },
    },
    {
      name: "杂质：说明行应忽略，但不影响人数",
      clubText: "",
      relayText: `无差别组：\n报名接龙：请按格式\n1. Phoenix_Soul+TheAuEsted\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Phoenix_Soul", account: "TheAuEsted" }],
      },
    },
    {
      name: "连字符：name-account",
      clubText: "",
      relayText: `无差别组：\n17. jiabaolong-rainbow1010\n`,
      expect: {
        total: 1,
        contains: [{ displayName: "jiabaolong", account: "rainbow1010" }],
      },
    },
    {
      name: "账号含空格：两段英文（复制粘贴常见）",
      clubText: "",
      relayText: `青少年组：\n9. Liaoyi  Liao yi\n`,
      expect: {
        total: 1,
        groups: { 青少年组: 1 },
        contains: [{ displayName: "Liaoyi", account: "Liao yi" }],
      },
    },
    {
      name: "俱乐部区：简单名单去重并归入“长期成员”",
      clubText: `Alice\nBob\n`,
      relayText: `无差别组：\n1. Alice alice123\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 1, 长期成员: 1 },
      },
    },
    {
      name: "括号/隐藏空格：方括号/中文括号/Hangul filler",
      clubText: "",
      relayText: `无差别组：\n20. Lu Wenting[eagleeee]ㅤ\n24. liducheng（sino001）\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "Lu Wenting", account: "eagleeee" },
          { displayName: "liducheng", account: "sino001" },
        ],
      },
    },
    {
      name: "全角编号：１．/２、应能正确剥离",
      clubText: "",
      relayText: `无差别组：\n１． 张三 zhangsan\n２、 李四 lisi\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "张三", account: "zhangsan" },
          { displayName: "李四", account: "lisi" },
        ],
      },
    },
    {
      name: "账号下划线尾缀：4z_",
      clubText: "",
      relayText: `新人赛：\n16. 柿子 4z_\n`,
      expect: {
        total: 1,
        groups: { 新人赛: 1 },
        contains: [{ displayName: "柿子", account: "4z_" }],
      },
    },
    {
      name: "全角空格：eagle　 he70（常见复制粘贴）",
      clubText: "",
      relayText: `特殊赛：\n4. eagle　 he70\n`,
      expect: {
        total: 1,
        groups: { 特殊赛: 1 },
        contains: [{ displayName: "eagle", account: "he70" }],
      },
    },
    {
      name: "特殊赛：两段短中文更像姓名时不强制识别账号",
      clubText: "",
      relayText: `特殊赛：\n1. 王 小明\n`,
      expect: {
        total: 1,
        groups: { 特殊赛: 1 },
        contains: [{ displayName: "王 小明" }],
        accountEmptyFor: ["王 小明"],
      },
    },
    {
      name: "特殊赛：中文名 + 双词英文账号（不应把第二词识别成俱乐部）",
      clubText: "",
      relayText: `特殊赛：\n20. 战鹰 Steven ji\n`,
      expect: {
        total: 1,
        groups: { 特殊赛: 1 },
        contains: [{ displayName: "战鹰", account: "Steven ji" }],
      },
    },
    {
      name: "无差别组：三段首字母大写更像姓名，不应误拆账号",
      clubText: "",
      relayText: `无差别组：\n1. Wang De Hua\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Wang De Hua" }],
        accountEmptyFor: ["Wang De Hua"],
      },
    },
    {
      name: "无差别组：三段标题式中若第3段更像英文ID，应识别为账号",
      clubText: "",
      relayText: `无差别组：\n1. Wang Zhen Fury\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Wang Zhen", account: "Fury" }],
      },
    },
    {
      name: "无差别组：三段标题式中第3段为普通英文词也应优先识别账号",
      clubText: "",
      relayText: `无差别组：\n1. Wang Zhen Head\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Wang Zhen", account: "Head" }],
      },
    },
    {
      name: "无差别组：三段典型拼音姓名仍不应误拆账号",
      clubText: "",
      relayText: `无差别组：\n1. Wang Xiao Ming\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Wang Xiao Ming" }],
        accountEmptyFor: ["Wang Xiao Ming"],
      },
    },
    {
      name: "无差别组：姓名与账号使用中文破折号连接（—）应可识别",
      clubText: "",
      relayText: `无差别组：\n1. wangyuchen—JiaoBu10\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "wangyuchen", account: "JiaoBu10" }],
      },
    },
    {
      name: "无差别组：单词粘连的姓名+账号（含数字）应可拆分",
      clubText: "",
      relayText: `无差别组：\n1. zhangyujieT0Thuiyi\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "zhangyujie", account: "T0Thuiyi" }],
      },
    },
    {
      name: "无差别组：两段短拼音更像姓名时不强制识别账号",
      clubText: "",
      relayText: `无差别组：\n1. lin feng\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "lin feng" }],
        accountEmptyFor: ["lin feng"],
      },
    },
    {
      name: "无差别组：两段小写拼音姓名（较长）不应误拆账号",
      clubText: "",
      relayText: `无差别组：\n1. zhang qiang\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "zhang qiang" }],
        accountEmptyFor: ["zhang qiang"],
      },
    },
    {
      name: "无差别组：三段小写拼音姓名不应误拆账号",
      clubText: "",
      relayText: `无差别组：\n1. wang de hua\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "wang de hua" }],
        accountEmptyFor: ["wang de hua"],
      },
    },
    {
      name: "无差别组：三段中第3段为英文ID时仍应识别账号",
      clubText: "",
      relayText: `无差别组：\n1. Zhong Wei optionale\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "Zhong Wei", account: "optionale" }],
      },
    },
    {
      name: "长期名单：三段小写拼音姓名不应误拆账号",
      clubText: "",
      relayText: `长期选手，长期俱乐部格式：\n全部名单:\nwang de hua\n`,
      expect: {
        total: 1,
        groups: { 长期名单: 1 },
        contains: [{ displayName: "wang de hua" }],
        accountEmptyFor: ["wang de hua"],
      },
    },
    {
      name: "长期名单：标题写成“长期人员名单”时也应归入长期名单",
      clubText: "",
      relayText: `长期人员名单：\nWu Jianxiang\n`,
      expect: {
        total: 1,
        groups: { 长期名单: 1 },
        contains: [{ displayName: "Wu Jianxiang" }],
      },
    },
    {
      name: "标题识别：仅有【x月无差别组】也能归组",
      clubText: "",
      relayText: `#接龙\n【1月无差别组】“栢龙杯”比赛报名接龙\n1. yetaiqi sky111\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "yetaiqi", account: "sky111" }],
      },
    },
    {
      name: "标题识别：无差别赛事应归入无差别组",
      clubText: "",
      relayText: `无差别赛事：\n1. yetaiqi sky111\n`,
      expect: {
        total: 1,
        groups: { 无差别组: 1 },
        contains: [{ displayName: "yetaiqi", account: "sky111" }],
      },
    },
    {
      name: "中文昵称+粘连账号+尾部俱乐部应可解析",
      clubText: "",
      relayText: `新人赛：\n1. 馒头926wjp Zeb\n`,
      expect: {
        total: 1,
        groups: { 新人赛: 1 },
        contains: [{ displayName: "馒头", account: "926wjp", club: "Zeb" }],
      },
    },
    {
      name: "连接符&：连写双人名应拆分为两名选手",
      clubText: "",
      relayText: `无差别组：\n12. zhanganping&zhangxiaoguo\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "zhanganping" },
          { displayName: "zhangxiaoguo" },
        ],
        accountEmptyFor: ["zhanganping", "zhangxiaoguo"],
      },
    },
    {
      name: "去重稳定：同账号冲突行重复出现不应放大人数",
      clubText: "",
      relayText: `无差别组：\n1. Alice alice123\n2. Bob alice123\n3. Alice alice123\n`,
      expect: {
        total: 2,
        groups: { 无差别组: 2 },
        contains: [
          { displayName: "Alice", account: "alice123" },
          { displayName: "Bob", account: "alice123" },
        ],
      },
    },
  ];

  function runImportParseTests() {
    const lines = [];
    let pass = 0;
    let fail = 0;

    for (const t of IMPORT_TESTS) {
      const result = parseImportTextsDetailed(t.clubText, t.relayText);
      const players = result.players || [];
      const report = result.report || {};

      const groupCounts = new Map();
      for (const p of players) {
        const g = normalizeWhitespace(p.group) || "未分组";
        groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
      }

      const expectedTotal =
        t.expect && typeof t.expect.total === "number" ? t.expect.total : null;

      let ok = true;
      const reasons = [];

      if (expectedTotal != null && players.length !== expectedTotal) {
        ok = false;
        reasons.push(`人数不符：期望 ${expectedTotal}，实际 ${players.length}`);
      }

      if (t.expect && t.expect.groups) {
        for (const [g, c] of Object.entries(t.expect.groups)) {
          const actual = groupCounts.get(g) || 0;
          if (actual !== c) {
            ok = false;
            reasons.push(`组别人数不符：${g} 期望 ${c}，实际 ${actual}`);
          }
        }
      }

      if (t.expect && Array.isArray(t.expect.contains)) {
        for (const want of t.expect.contains) {
          const dn = normalizeWhitespace(want.displayName);
          const acc = normalizeWhitespace(want.account || "");
          const club = normalizeWhitespace(want.club || "");

          const found = players.some((p) => {
            if (dn && normalizeWhitespace(p.displayName) !== dn) return false;
            if (acc && normalizeWhitespace(p.account) !== acc) return false;
            if (club && normalizeWhitespace(p.club) !== club) return false;
            return true;
          });

          if (!found) {
            ok = false;
            reasons.push(`缺少关键选手：${dn}${acc ? `(${acc})` : ""}`);
          }
        }
      }

      if (t.expect && Array.isArray(t.expect.accountEmptyFor)) {
        for (const dnRaw of t.expect.accountEmptyFor) {
          const dn = normalizeWhitespace(dnRaw);
          if (!dn) continue;
          const target = players.find(
            (p) => normalizeWhitespace(p.displayName) === dn,
          );
          if (!target) {
            ok = false;
            reasons.push(`未找到应为空账号的选手：${dn}`);
            continue;
          }
          if (normalizeWhitespace(target.account)) {
            ok = false;
            reasons.push(
              `账号应为空但实际为：${dn} -> ${normalizeWhitespace(target.account)}`,
            );
          }
        }
      }

      if (ok) pass++;
      else fail++;

      lines.push(`${ok ? "✅" : "❌"} ${t.name}`);
      lines.push(
        `  - 解析人数：${players.length}（忽略：${report.ignored || 0} 行）`,
      );
      if (groupCounts.size) {
        lines.push(
          "  - 组别：" +
            Array.from(groupCounts.entries())
              .map(([g, c]) => `${g}(${c})`)
              .join("  "),
        );
      }
      if (!ok) {
        for (const r of reasons) lines.push(`  - 问题：${r}`);
      }
      lines.push("");
    }

    lines.unshift(`导入解析回归测试：通过 ${pass} / ${pass + fail}`);
    lines.push(
      "提示：若你修改了解析规则，可先运行本测试对比人数/组别/忽略原因是否发生异常变化。",
    );

    showDialog({
      title: "解析回归测试结果",
      message: lines.join("\n"),
      buttons: [{ label: "关闭", className: "btn btn-filled" }],
    });
  }

  function showHelp() {
    const msg = [
      "• 本页面是纯前端静态程序：不会把名单/签到结果上传到任何服务器。",
      "• 签到进度会自动保存到当前设备浏览器（LocalStorage）。刷新页面也能继续。",
      "• 支持多组别：导入时识别“无差别组 / 新人赛 / 特殊赛 / 青少年组”等标题，并可在签到页用“组别筛选”切换。",
      "• 可在导入页「组别识别设置」里自定义关键词（例如给新赛道增加识别词）。",
      "• 点名模式：只显示未签到，按钮更大；支持电脑在搜索框按 Enter 直接给第一条匹配签到；支持左右滑动快捷签到/取消。",
      "• 导出：PNG / CSV / 复制文本。CSV 可选择是否带“签到时间”列。",
      "• 中国大陆常见内置浏览器（微信/QQ/微博/抖音等）会提供“查看方法”引导，可一键复制链接到系统浏览器打开。",
      "• 需要跨设备/备份：可用「导出进度/导入进度」JSON；若内置浏览器拦截下载，可用“复制 JSON → 粘贴导入”。",
      "• 如果在公共电脑/公共平板上使用，建议结束后点击右上角「清除」按钮清除本地进度。",
    ].join("\n");

    showDialog({
      title: "使用说明 / 隐私 / 自检",
      message: msg,
      buttons: [
        {
          label: "运行解析回归测试",
          className: "btn btn-tonal",
          onClick: runImportParseTests,
        },
        { label: "知道了", className: "btn btn-filled" },
      ],
    });
  }

  // ------------------------------
  // PWA: Add to Home Screen / Install
  // ------------------------------
  let deferredInstallPrompt = null;

  function isAndroid() {
    return /Android/i.test(getUA());
  }

  function isMacOS() {
    return /Macintosh/i.test(getUA());
  }

  function isSafari() {
    const ua = getUA();
    const hasSafari = /Safari/i.test(ua);
    const isOther = /Chrome|CriOS|Edg|OPR|FxiOS|Firefox/i.test(ua);
    return hasSafari && !isOther;
  }

  function isSafariOnMac() {
    return isMacOS() && !isIOS() && isSafari();
  }

  function updateInstallButton() {
    const standalone = isStandaloneMode();
    if (btnInstall) btnInstall.hidden = standalone;
    if (panelInstallBtn) {
      panelInstallBtn.disabled = standalone;
      panelInstallBtn.textContent = standalone
        ? "已在主屏幕运行"
        : "保存到主屏幕";
    }
  }

  async function handleInstallClick() {
    if (isStandaloneMode()) {
      updateInstallButton();
      showSnackbar("已在主屏幕/独立窗口模式运行", 2200);
      return;
    }

    // Mainland CN in-app browsers often block PWA install entry.
    if (isLikelyInAppBrowser()) {
      showDialog({
        title: "当前环境限制安装",
        message:
          "检测到内置浏览器（如微信/QQ/微博/钉钉等），通常不支持“添加到主屏幕”。\n\n建议：\n1) 右上角菜单选择「在浏览器打开」\n2) 在系统浏览器（Chrome/Edge/Safari）中再执行安装。",
        buttons: [
          {
            label: "复制当前链接",
            className: "btn btn-tonal",
            onClick: () => {
              copyCurrentPageUrl();
              return false;
            },
          },
          { label: "知道了", className: "btn btn-filled" },
        ],
      });
      return;
    }

    // Chromium install prompt
    if (deferredInstallPrompt) {
      try {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        updateInstallButton();

        if (choice && choice.outcome === "accepted") {
          showSnackbar("已发起安装/添加到主屏幕", 2400);
        } else {
          showSnackbar("已取消安装（也可在浏览器菜单里再次安装）", 2600);
        }
      } catch (e) {
        console.warn("触发安装提示失败：", e);
        showInstallInstructions();
      }
      return;
    }

    showInstallInstructions();
  }

  function showInstallInstructions() {
    if (isIOS()) {
      if (!isSafari()) {
        showDialog({
          title: "在 iPhone/iPad 上添加到主屏幕",
          message:
            "iOS/iPadOS 上只有 Safari 支持「添加到主屏幕」。\n\n请复制当前网址，用 Safari 打开后：\n1) 点击底部「分享」按钮（方框向上箭头）\n2) 选择「添加到主屏幕」\n3) 点击「添加」完成。",
          buttons: [{ label: "知道了", className: "btn btn-filled" }],
        });
      } else {
        showDialog({
          title: "添加到主屏幕",
          message:
            "在 Safari 中：\n1) 点击底部「分享」按钮（方框向上箭头）\n2) 选择「添加到主屏幕」\n3) 点击「添加」。\n\n添加后可离线使用（PNG 导出也支持离线）。",
          buttons: [{ label: "好的", className: "btn btn-filled" }],
        });
      }
      return;
    }

    if (isSafariOnMac()) {
      showDialog({
        title: "添加到 Dock / 安装为应用",
        message:
          "在 macOS 的 Safari 中可以将网页添加为独立应用：\n1) 菜单栏「文件」→「添加到 Dock…」（Add to Dock…）\n2) 确认名称与图标后保存。\n\n添加后会以独立窗口运行，使用体验更接近原生应用。",
        buttons: [{ label: "知道了", className: "btn btn-filled" }],
      });
      return;
    }

    const platform = isAndroid() ? "Android" : "桌面端（Windows/macOS/Linux）";
    showDialog({
      title: "安装/添加到主屏幕",
      message: `在 ${platform} 的 Chrome/Edge 中：\n1) 打开浏览器菜单（右上角 ⋮/…）\n2) 选择「安装应用」或「安装 比赛签到助手」或「添加到主屏幕」\n3) 按提示完成。\n\n若地址栏右侧出现“安装”图标，也可直接点击安装。`,
      buttons: [{ label: "好的", className: "btn btn-filled" }],
    });
  }

  function setupPWAInstall() {
    if (LOCAL_SYNC_ENABLED) {
      deferredInstallPrompt = null;
      updateInstallButton();
      return;
    }

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      updateInstallButton();
    });

    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      updateInstallButton();
      showSnackbar("已添加到主屏幕/安装完成", 2400);
    });

    updateInstallButton();

    if (btnInstall) {
      btnInstall.addEventListener("click", handleInstallClick);
    }
  }

  // ------------------------------
  // PWA: Service Worker + update prompt (Plan #11)
  // ------------------------------
  function promptAppUpdate(reg) {
    showSnackbar("发现新版本，建议刷新以使用最新功能", 0, "刷新", () => {
      try {
        if (reg && reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      } catch (_) {
        // ignore
      }
      window.location.reload();
    });
  }

  function registerServiceWorker() {
    const host = String(window.location.hostname || "").toLowerCase();
    const isLoopback =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]";
    if (isLoopback) {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker
          .getRegistrations()
          .then((regs) => regs.forEach((reg) => reg.unregister()))
          .catch(() => {});
      }
      if (typeof caches !== "undefined" && caches && caches.keys) {
        caches
          .keys()
          .then((keys) =>
            Promise.all(
              keys
                .filter((key) => String(key).startsWith("checkin-assistant-cache-"))
                .map((key) => caches.delete(key)),
            ),
          )
          .catch(() => {});
      }
      return;
    }
    const isSecure = window.location.protocol === "https:" || isLoopback;
    if (!isSecure) return;
    if (!("serviceWorker" in navigator)) return;

    const sw = navigator.serviceWorker;
    if (!sw || typeof sw.register !== "function") return;

    const hadController = Boolean(sw.controller);

    let hasPrompted = false;

    const swUrl = `./sw.js?v=${encodeURIComponent(APP_VERSION)}`;
    sw.register(swUrl)
      .then((reg) => {
        if (!reg) return;

        // If already waiting, prompt immediately
        if (reg.waiting && sw.controller && !hasPrompted) {
          hasPrompted = true;
          promptAppUpdate(reg);
        }

        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed") {
              // A new SW is installed: if we already have a controller, it is an update.
              if (sw.controller && !hasPrompted) {
                hasPrompted = true;
                promptAppUpdate(reg);
              }
            }
          });
        });
      })
      .catch((e) => {
        console.warn("Service Worker 注册失败：", e);
      });

    // controllerchange: new SW took over
    sw.addEventListener("controllerchange", () => {
      // On first install there was no controller; avoid confusing "update" prompt.
      if (!hadController) return;
      if (hasPrompted) return;
      hasPrompted = true;
      showSnackbar("应用已更新，点击刷新以加载最新界面", 0, "刷新", () =>
        window.location.reload(),
      );
    });
  }

  // ------------------------------
  // Event wiring
  // ------------------------------
  function wireEvents() {
    on(btnScheduleBack, "click", backToPortal);
    on(btnScheduleContinue, "click", continueFromSchedule);
    on(btnEditSchedule, "click", editEventSchedule);
    on(btnLoadWechatGroups, "click", loadWechatGroups);
    on(btnCheckWechatDecryptStatus, "click", checkWechatDecryptStatus);
    EVENT_SCHEDULE_FIELDS.forEach(({ key }) => {
      on(eventScheduleInputs[key], "input", () => {
        const schedule = ensureEventScheduleState();
        const input = eventScheduleInputs[key];
        schedule[key] = normalizeEventScheduleValue(input ? input.value : "");
        showScheduleValidation("");
        scheduleSave();
      });
    });
    on(scheduleSemifinalAndFinalInput, "change", () => {
      const previousHasFinals = hasSemifinalAndFinal();
      const parameters = readTournamentParametersFromUI();
      if (!parameters.ok) return;
      state.tournamentParameters = parameters.value;
      if (previousHasFinals && !parameters.value.hasSemifinalAndFinal &&
          state.step === "final-registration") state.step = "score-helper";
      showScheduleValidation("");
      applyStepUI();
      updateProgressBar();
      scheduleSave();
    });
    on(scheduleBrightwellConstantInput, "input", () => {
      const parameters = readTournamentParametersFromUI();
      if (!parameters.ok) {
        showScheduleValidation(parameters.message);
        return;
      }
      state.tournamentParameters = parameters.value;
      showScheduleValidation("");
      scheduleSave();
    });
    on(checkinViewTabs, "click", (event) => {
      const target = isElement(event.target) ? event.target : null;
      const button = target && target.closest("button[data-checkin-view]");
      if (!button) return;
      setCheckinView(button.dataset.checkinView, button.dataset.checkinView === "mapping");
    });

    on(mappingGroupNameInput, "input", () => {
      const mapping = ensureMappingState();
      const selectedGroup = selectedWechatRelayGroup();
      const selectedInfo = mappingGroupInfo(selectedGroup);
      const value = normalizeWhitespace(mappingGroupNameInput.value);
      const nextOverride = value && normalizeKey(value) !== normalizeKey(selectedInfo.name)
        ? value
        : "";
      const previousTargetKey = mappingGroupTargetKey(mapping, selectedGroup);
      mapping.groupOverride = nextOverride;
      if (nextOverride) {
        mapping.groupName = nextOverride;
      } else if (selectedInfo.identity) {
        mapping.groupName = selectedInfo.name;
        mapping.groupUsername = selectedInfo.identity;
      } else {
        mapping.groupName = "";
      }
      if (mappingGroupTargetKey(mapping, selectedGroup) !== previousTargetKey) {
        clearMappingGroupNickPool(mapping);
        mapping.groupUsername = nextOverride ? "" : selectedInfo.identity;
        if (mappingGroupNickOptions) mappingGroupNickOptions.innerHTML = "";
      }
      mapping.updatedAt = now();
      refreshMappingSummary();
      scheduleSave();
    });
    on(mappingTableWrap, "input", handleMappingTableInput);
    on(mappingTableWrap, "focusout", handleMappingTableFieldFocusOut);
    on(mappingTableWrap, "click", handleMappingTableClick);
    on(mappingTableWrap, "mousedown", handleMappingTableMouseDown);
    on(mappingTableWrap, "mouseup", handleMappingTableSelectionChange);
    on(mappingTableWrap, "keyup", handleMappingTableSelectionChange);
    on(mappingTableWrap, "select", handleMappingTableSelectionChange);
    on(document, "selectionchange", handleMappingTableSelectionChange);
    on(btnRefreshWechatNicks, "click", refreshWechatNicks);
    on(btnValidateOqAccounts, "click", validateMappingOqAccounts);
    on(btnSelfCheckMapping, "click", selfCheckMapping);
    on(btnExportMappingPng, "click", exportMappingAsPNG);
    on(btnApplyMappingToRoster, "click", applyMappingToRoster);
    on(btnClearMapping, "click", () => {
      if (!ensureMappingState().rows.length && !ensureMappingState().groupNicks.length) {
        showSnackbar("映射表已经为空", 1800);
        return;
      }
      showConfirm(
        "清除映射表",
        "将清除当前三列映射和已拉取的微信群昵称池；签到名单不会被删除。确定继续吗？",
        clearMappingState,
        "清除",
      );
    });
    on(btnImport, "click", processImport);
    on(btnWechatRelaySync, "click", () => {
      void setWechatRelaySyncEnabled(!ensureWechatRelaySyncState().enabled);
    });
    on(btnWechatAutoCheckin, "click", () => {
      void setWechatAutoCheckinEnabled(!ensureWechatAutoCheckinState().enabled);
    });
    on(wechatAutoCheckinPendingList, "click", (event) => {
      const target = isElement(event.target) ? event.target : null;
      const button = target && target.closest("button[data-auto-checkin-pending-action]");
      if (!button) return;
      const action = button.dataset.autoCheckinPendingAction;
      if (action !== "ignore" && action !== "solved") return;
      const itemId = button.dataset.autoCheckinPendingId;
      setWechatAutoCheckinPendingStatus(itemId, action === "ignore" ? "ignored" : "solved");
    });
    on(btnWechatRelayReference, "click", () => {
      void referenceLatestWechatRelay();
    });
    on(btnResume, "click", () => {
      if (
        !state ||
        !Array.isArray(state.players) ||
        state.players.length === 0
      ) {
        showSnackbar("没有可继续的签到进度", 2200);
        return;
      }
      viewStepOverride = null;
      if (!TOURNAMENT_STEP_IDS.includes(state.step)) state.step = "checkin";
      applyStateToUI();
      showSnackbar("已继续上次进度", 2200);
    });

    const syncGroupRules = debounce(() => {
      state.groupRules = readGroupRulesFromEditor();
      scheduleSave();
    }, 140);

    on(groupRulesEl, "input", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return;
      const role = String(target.getAttribute("data-role") || "");
      if (role === "group" || role === "keywords") syncGroupRules();
    });

    on(groupRulesEl, "change", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return;
      const role = String(target.getAttribute("data-role") || "");
      if (role === "enabled") syncGroupRules();
    });

    on(groupRulesEl, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return;
      const btn = target.closest('button[data-role="delete"]');
      if (!btn) return;

      const row = btn.closest(".group-rule");
      if (!row) return;

      const ruleNodes = groupRulesEl
        ? groupRulesEl.querySelectorAll(".group-rule")
        : [];
      if (ruleNodes && ruleNodes.length <= 1) {
        showSnackbar("至少保留 1 条组别规则", 1800);
        return;
      }

      if (row.parentNode) row.parentNode.removeChild(row);
      state.groupRules = readGroupRulesFromEditor();
      renderGroupRulesEditor();
      scheduleSave();
      showSnackbar("已删除组别规则", 1800);
    });

    on(btnAddGroupRule, "click", () => {
      const rules = readGroupRulesFromEditor();
      rules.push({
        id: createRuleId(),
        group: "新组别",
        keywords: ["新组别"],
        enabled: true,
      });
      state.groupRules = sanitizeGroupRules(rules);
      renderGroupRulesEditor();
      scheduleSave();
      showSnackbar("已新增组别规则", 1800);
    });

    on(btnResetGroupRules, "click", () => {
      state.groupRules = cloneDefaultGroupRules();
      renderGroupRulesEditor();
      scheduleSave();
      showSnackbar("已恢复默认组别规则", 2000);
    });

    on(btnBack, "click", backToImport);
    on(btnBatch, "click", showBatchDialog);
    on(btnFinish, "click", enterScoreHelper);
    on(btnLiveStandings, "click", () => openLiveStandings());
    on(btnOpenPreliminaryStandings, "click", advancePreliminaryRegistration);
    on(btnBackPreliminaryRegistration, "click", () =>
      navigateTournamentStep("score-helper"),
    );
    on(btnOpenOverallStandings, "click", advanceFinalRegistration);
    on(btnScoreBackCheckin, "click", returnToCheckinFromScoreHelper);
    on(btnScoreApplyRounds, "click", applyScoreRoundSettings);
    on(btnScoreApplyCurrentTime, "click", applyScoreCurrentTime);
    on(btnApplyFinalRoundCurrentTime, "click", applyFinalRoundCurrentTime);
    on(finalRoundStartInput, "change", () => {
      const start = scoreRoundStartFromInputValue(finalRoundStartInput.value);
      if (start && !isValidScoreRoundStart(start)) {
        showSnackbar("请填写有效的日期和时间", 2200);
        return;
      }
      syncActivePlayoffRoundStartFromInput();
      renderFinalRegistration(null, ensurePlayoffRegistration());
      scheduleSave();
    });
    on(scoreRoundStartInput, "change", () => {
      syncActiveScoreRoundStartFromInput();
      renderScoreHelper();
      scheduleSave();
    });
    on(scoreOqPollSecondsInput, "change", () => {
      state.ui.oqPollSeconds = oqPollSeconds();
      if (oqScorePollEnabled) scheduleOqScorePoll(state.ui.oqPollSeconds * 1000);
      scheduleSave();
    });
    on(btnImportScorePairings, "click", importScorePairings);
    on(btnImportPappPairings, "click", () => {
      if (pappPairingsFileInput) pappPairingsFileInput.click();
    });
    on(pappPairingsFileInput, "change", () => {
      const file = pappPairingsFileInput && pappPairingsFileInput.files
        ? pappPairingsFileInput.files[0]
        : null;
      if (file) importPappPairingsFile(file);
    });
    on(btnRefreshScoreRound, "click", refreshScoreRound);
    on(btnExportScorePairingsPng, "click", () => {
      exportScoreRoundPng("pairings");
    });
    on(btnExportScoreResultsPng, "click", () => {
      exportScoreRoundPng("scores");
    });
    on(btnUpdateRoundOqScores, "click", () => {
      updateRoundScoresFromOq({ silent: false, mode: "oq-manual" });
    });
    on(btnUpdatePlayoffOqScores, "click", () => {
      updateRoundScoresFromOq({ silent: false, mode: "oq-manual" });
    });
    on(btnRegisterReadyScores, "click", () => registerReadyScores(btnRegisterReadyScores));
    on(btnRegisterPlayoffReadyScores, "click", () => registerReadyScores(btnRegisterPlayoffReadyScores));
    on(btnToggleOqScorePoll, "click", toggleOqScorePolling);
    on(btnTogglePlayoffOqScorePoll, "click", toggleOqScorePolling);
    on(btnToggleEgAnalysis, "click", toggleEgAnalysis);
    on(btnTogglePlayoffEgAnalysis, "click", toggleEgAnalysis);
    on(btnExportEgPerformancePng, "click", exportEgPerformancePngs);
    on(scoreRoundTabs, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      const btn = target && target.closest("button[data-round]");
      if (!btn) return;
      const round = Number(btn.dataset.round);
      const helper = ensureScoreHelper();
      if (!Number.isFinite(round) || round < 1 || round > helper.roundCount) return;
      helper.activeRound = Math.trunc(round);
      renderScoreHelper();
      scheduleSave();
    });
    on(scorePendingList, "click", handleScoreItemAction);
    on(scoreManualPendingList, "click", handleScoreItemAction);
    on(scoreCompletedList, "click", handleScoreItemAction);
    on(scorePairingSearchInput, "input", () => renderScoreHelper());
    on(scorePairingsList, "input", updateScorePairingFromInput);
    on(finalRegistrationPairings, "input", updateScorePairingFromInput);

    on(btnAdd, "click", addPlayer);
    on(addPlayerNameInput, "keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addPlayer();
      }
    });

    // Search input
    on(
      searchBox,
      "input",
      debounce(() => {
        updateClearSearchButton();
        const visiblePlayers = getVisiblePlayers();
        updateStats(visiblePlayers);
        renderPlayerList(visiblePlayers);
      }, 120),
    );

    // Clear search button
    if (btnClearSearch) {
      on(btnClearSearch, "click", () => {
        if (searchBox) {
          searchBox.value = "";
          btnClearSearch.hidden = true;
          const visiblePlayers = getVisiblePlayers();
          updateStats(visiblePlayers);
          renderPlayerList(visiblePlayers);
          searchBox.focus();
        }
      });
    }
    on(searchBox, "keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const visible = getVisiblePlayers();
        if (visible.length === 0) return;
        // PC: Enter => check-in first match (Plan #7)
        setCheckIn(visible[0].id, true);
      }
    });

    // Group filter click (segmented)
    on(groupFilterEl, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return;
      const btn = target.closest("button");
      if (!btn || !btn.dataset || !btn.dataset.group) return;

      const g = String(btn.dataset.group || "all");
      state.ui.group = g;
      scheduleSave();
      refreshCheckinUI();
    });

    // Group filter keyboard navigation (ArrowLeft/ArrowRight/Home/End)
    on(groupFilterEl, "keydown", (e) => {
      const key = String(e.key || "");
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;

      const buttons = Array.from(
        groupFilterEl.querySelectorAll("button.seg-btn"),
      );
      if (!buttons.length) return;

      const target = isElement(e.target) ? e.target : null;
      const currentBtn = target ? target.closest("button.seg-btn") : null;

      let idx = currentBtn ? buttons.indexOf(currentBtn) : -1;
      if (idx < 0)
        idx = buttons.findIndex(
          (b) => b.getAttribute("aria-selected") === "true",
        );
      if (idx < 0) idx = 0;

      if (key === "Home") idx = 0;
      else if (key === "End") idx = buttons.length - 1;
      else if (key === "ArrowLeft")
        idx = (idx - 1 + buttons.length) % buttons.length;
      else if (key === "ArrowRight") idx = (idx + 1) % buttons.length;

      const next = buttons[idx];
      if (!next) return;

      e.preventDefault();

      const g = String(next.dataset.group || "all");
      state.ui.group = g;
      scheduleSave();
      refreshCheckinUI();

      // Rerendering recreates buttons; restore focus to the selected tab.
      try {
        const after = Array.from(
          groupFilterEl.querySelectorAll("button.seg-btn"),
        );
        const focusBtn = after.find((b) => String(b.dataset.group || "") === g);
        if (focusBtn) focusBtn.focus();
      } catch (_) {
        // ignore focus errors
      }
    });

    // Call mode / show time toggles
    on(btnCallMode, "click", () => {
      state.ui.callMode = !state.ui.callMode;
      scheduleSave();
      refreshCheckinUI();
      showSnackbar(
        state.ui.callMode ? "已开启点名模式" : "已关闭点名模式",
        1800,
      );
    });

    on(btnShowTime, "click", () => {
      state.ui.showTime = !state.ui.showTime;
      scheduleSave();
      refreshCheckinUI();
      showSnackbar(
        state.ui.showTime ? "已显示签到时间" : "已隐藏签到时间",
        1800,
      );
    });

    on(btnSuspects, "click", () => {
      if (
        !state ||
        !Array.isArray(state.players) ||
        state.players.length === 0
      ) {
        showSnackbar("当前没有名单可检查", 2200);
        return;
      }

      const report = computeSuspectReport(state.players);
      if (
        (report.duplicatePairsTotal || 0) === 0 &&
        (report.anomaliesTotal || 0) === 0
      ) {
        showSnackbar("未发现明显重复/异常", 2200);
        return;
      }

      showSuspectsDialog(report, { allowDisableAuto: true });
    });
    on(btnPlanWithdrawal, "click", showPlanWithdrawalDialog);

    // Player list (delegation)
    on(playerList, "click", (e) => {
      const target = isElement(e.target) ? e.target : null;
      if (!target) return;

      const btn = target.closest("button");
      if (btn) {
        const action = btn.dataset.action;
        const id = Number(btn.dataset.playerId);
        if (!action || !Number.isFinite(id)) return;

        if (action === "toggle-checkin") toggleCheckIn(id);
        else if (action === "toggle-new") toggleNewStatus(id);
        else if (action === "edit") showEditPlayerDialog(id);
        else if (action === "delete") deletePlayer(id);
        return;
      }

      // Call mode: tap row to check-in quickly
      if (state.ui && state.ui.callMode) {
        const row = target.closest(".player-item");
        if (!row || !row.dataset || !row.dataset.playerId) return;
        const id = Number(row.dataset.playerId);
        if (!Number.isFinite(id)) return;
        setCheckIn(id, true);
      }
    });

    // Inputs -> state
    on(clubMembersEl, "input", () => {
      state.clubText = clubMembersEl.value || "";
      updateImportEmptyState();
      scheduleSave();
    });

    on(relayInfoEl, "input", () => {
      state.relayText = relayInfoEl.value || "";
      updateImportEmptyState();
      scheduleSave();
    });

    on(competitionNameInput, "input", () => {
      state.competitionName =
        normalizeWhitespace(competitionNameInput.value) || "比赛签到表";
      if (competitionTitleEl)
        competitionTitleEl.textContent = state.competitionName;
      scheduleSave();
    });

    // Reset + help
    on(btnReset, "click", () => {
      showConfirm(
        "清除本地进度",
        "将删除此设备上保存的签到进度（可在底部提示条中撤销）。确定继续吗？",
        clearStorageAndReset,
        "清除",
      );
    });

    on(btnHelp, "click", showHelp);

    // Export modal
    on(btnExportQuick, "click", quickExportAsPNG);
    on(btnExportClose, "click", closeExportModal);
    on(exportBackdrop, "click", (e) => {
      if (e.target === exportBackdrop) closeExportModal();
    });

    on(btnDownloadPng, "click", downloadAsPNG);
    on(btnDownloadCsv, "click", downloadAsCSV);
    on(btnCopy, "click", copyAsText);

    // Export options -> live preview
    on(exportGroupSel, "change", renderExportPreview);
    on(exportScopeSel, "change", renderExportPreview);
    on(exportOrderSel, "change", renderExportPreview);
    on(exportWithGroupEl, "change", renderExportPreview);
    on(exportWithPlatformEl, "change", renderExportPreview);
    on(exportWithAccountEl, "change", renderExportPreview);
    on(exportWithClubEl, "change", renderExportPreview);
    on(exportWithTimeEl, "change", renderExportPreview);

    // JSON export/import
    on(btnExportJson, "click", exportProgressAsJSON);
    on(btnImportJsonPaste, "click", showImportProgressPasteDialog);
    on(importJsonInput, "change", () => {
      const file = importJsonInput.files && importJsonInput.files[0];
      importProgressFromJSONFile(file);
    });

    // Dialog close on backdrop click
    on(dialogBackdrop, "click", (e) => {
      if (e.target === dialogBackdrop) closeDialog();
    });

    // Snackbar action
    on(snackbarAction, "click", () => {
      if (typeof snackbarActionHandler === "function") {
        try {
          snackbarActionHandler();
        } finally {
          hideSnackbar();
        }
      }
    });

    // ESC close
    on(window, "keydown", (e) => {
      const key = String(e.key || "").toLowerCase();
      const saveShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && key === "s";
      if (saveShortcut) {
        const exportOpen =
          exportBackdrop && !exportBackdrop.classList.contains("hidden");
        if (exportOpen) {
          e.preventDefault();
          downloadAsPNG();
          return;
        }

        if (getCurrentStep() === "checkin" && state.players.length > 0) {
          e.preventDefault();
          generateFinalTable();
          showSnackbar(
            "已打开签到总表预览。再次按 ⌘/Ctrl + Shift + S 保存图片。",
            3200,
          );
          return;
        }
      }

      if (
        e.key === "Enter" &&
        e.shiftKey &&
        ["score-helper", "final-registration"].includes(getCurrentStep())
      ) {
        e.preventDefault();
        const button = getCurrentStep() === "final-registration"
          ? btnRegisterPlayoffReadyScores
          : btnRegisterReadyScores;
        void registerReadyScores(button);
        return;
      }

      if (
        e.key === "Enter" &&
        getCurrentStep() === "score-helper" &&
        !(e.target && /input|textarea|select/i.test(e.target.tagName || ""))
      ) {
        e.preventDefault();
        completeTopScoreItem();
        return;
      }

      if (e.key === "Escape") {
        if (dialogBackdrop && !dialogBackdrop.classList.contains("hidden"))
          closeDialog();
        if (exportBackdrop && !exportBackdrop.classList.contains("hidden"))
          closeExportModal();
        hideSnackbar();
      }
    });
  }

  // ------------------------------
  // Apply state to UI (on init)
  // ------------------------------
  function applyStateToUI(fromReset = false) {
    wechatAutoCheckinStatusText = "";
    renderEventSchedule();
    if (clubMembersEl) clubMembersEl.value = state.clubText || "";
    if (relayInfoEl) relayInfoEl.value = state.relayText || "";
    restoreWechatRelayReferenceContext();
    updateWechatRelaySyncUI();
    updateWechatAutoCheckinUI();
    updateWechatRelayReferenceUI();
    updateImportEmptyState();
    updateClearSearchButton();
    updateAutosaveChip(state.savedAt);
    renderGroupRulesEditor();

    if (competitionTitleEl)
      competitionTitleEl.textContent = state.competitionName || "比赛签到表";
    if (competitionNameInput)
      competitionNameInput.value = state.competitionName || "";

    applyWorkspaceUI();
    applyStepUI();

    applyModeClasses();

    const step = getCurrentStep();

    // Show "继续上次进度" only when we are viewing import and saved tournament progress exists.
    if (btnResume) {
      const canResume =
        step === "import" &&
        (state.step === "checkin" || TOURNAMENT_STEP_IDS.includes(state.step)) &&
        Array.isArray(state.players) &&
        state.players.length > 0;
      btnResume.hidden = !canResume;
    }

    if (step === "checkin") {
      refreshCheckinUI();
    } else if (step === "score-helper") {
      renderScoreHelper();
    } else {
      if (playerList) playerList.innerHTML = "";
      renderGroupFilter();
      updateStats();
    }
  }

  function exposeTournamentApi() {
    if (typeof window === "undefined") return;
    const existing =
      window.PAPP_TOURNAMENT_API && typeof window.PAPP_TOURNAMENT_API === "object"
        ? window.PAPP_TOURNAMENT_API
        : {};
    window.PAPP_TOURNAMENT_API = {
      ...existing,
      version: "papp-tournament-api-v2",
      getState: () => {
        ensurePlayoffRegistration();
        return deepClone(state);
      },
      getTournamentParameters: () =>
        deepClone(ensureTournamentParametersState()),
      getRound: (roundNumber) => {
        const helper = ensureScoreHelper();
        const roundNo = Math.max(
          1,
          Math.min(helper.roundCount, Math.trunc(Number(roundNumber) || helper.activeRound || 1)),
        );
        return deepClone(helper.rounds[roundNo - 1]);
      },
      setActiveRound: (roundNumber) => {
        const helper = ensureScoreHelper();
        const roundNo = Math.max(
          1,
          Math.min(helper.roundCount, Math.trunc(Number(roundNumber) || 1)),
        );
        helper.activeRound = roundNo;
        renderScoreHelper();
        scheduleSave();
        return roundNo;
      },
      setRoundStart: (roundNumber, value) => {
        const helper = ensureScoreHelper();
        const roundNo = Math.max(
          1,
          Math.min(helper.roundCount, Math.trunc(Number(roundNumber) || helper.activeRound || 1)),
        );
        const normalized = scoreRoundStartFromInputValue(value);
        if (normalized && !isValidScoreRoundStart(normalized)) {
          throw new Error("本轮开始时间格式无效");
        }
        helper.rounds[roundNo - 1].roundStartAt = normalized;
        helper.rounds[roundNo - 1].roundStartSource = normalized ? "papp-adapter" : "";
        helper.updatedAt = now();
        renderScoreHelper();
        scheduleSave();
        return normalized;
      },
      setRoundPairings: (roundNumber, pairings, options = {}) =>
        setRoundPairings(roundNumber, pairings, options),
      getPlayoffRegistration: () => deepClone(ensurePlayoffRegistration()),
      setPlayoffPairings: (roundNumber, pairings, options = {}) =>
        setPlayoffPairings(roundNumber, pairings, options),
      setActivePlayoffStage: (stage) => setActivePlayoffStage(stage),
      mergeOqPollResult: (roundNumber, result, options = {}) =>
        mergeOqPollResult(roundNumber, result, options),
      getEgAnalysis: () => deepClone(state.egAnalysis),
      setEgAnalysis: (analysis, options = {}) =>
        setEgAnalysisResult(analysis, options),
      mergeEgAnalysisResult: (result, options = {}) =>
        applyEgAnalysisResult(result, options),
      preliminaryRoundCountForPlayerCount,
      setIntegrationStatus: setScoreIntegrationStatus,
      renderScoreHelper,
    };
  }

  // ------------------------------
  // Init
  // ------------------------------
  function apOwnsAutomation() {
    return Boolean(state && state.ap && state.ap.enabled);
  }

  function mountApUi() {
    if (!LOCAL_SYNC_ENABLED || !window.PappApUi) return;
    let shownCompleteSession = "";
    window.PappApUi.mount({
      getState: () => state,
      persist: persistCurrentStateToLocalService,
      onStatus(ap) {
        const wasEnabled = apOwnsAutomation();
        state.ap = deepClone(ap);
        if (ap.enabled) {
          stopWechatRelayPolling();
          stopOqScorePolling({ quiet: true });
        } else if (wasEnabled) {
          resumeWechatRelayPolling();
        }
        updateWechatRelaySyncUI();
        updateWechatAutoCheckinUI();
        updateOqScorePollButton();
        const completedSession = ap.sessionId || state.scoreHelper.pappWorkfileId;
        if (ap.status === "complete" && shownCompleteSession !== completedSession) {
          shownCompleteSession = completedSession;
          openLiveStandings("overall");
        }
      },
    });
  }

  function init() {
    // Some embedded browsers report color-mix support incorrectly.
    // Add a defensive class fallback to keep UI readable.
    try {
      const root = document.documentElement;
      const css = window.CSS;
      const ok = !!(
        css &&
        typeof css.supports === "function" &&
        css.supports("color", "color-mix(in srgb, #000 50%, #fff)")
      );
      if (root && root.classList && !ok) root.classList.add("no-color-mix");
    } catch (_) {
      const root = document.documentElement;
      if (root && root.classList) root.classList.add("no-color-mix");
    }

    wireEvents();
    setupIOSTouchCheckinLayout();

    // Flush pending autosave when the page is backgrounded/closed.
    window.addEventListener("pagehide", () => {
      stopOqScorePolling({ quiet: true });
      stopWechatRelayPolling();
      flushSave();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden || document.visibilityState === "hidden") {
        flushSave();
      }
    });

    // PWA: offline cache + "添加到主屏幕"
    registerServiceWorker();
    setupPWAInstall();

    setupSwipeGestures();

    // Mainland CN: many users open this in in-app browsers (WeChat/QQ/Weibo...).
    // These webviews may restrict downloads & PWA installation; show a one-time tip.
    maybeShowInAppBrowserTipOnce();

    let mappingRowsChangedOnLoad = false;
    let scorePairingsChangedOnLoad = false;
    const loaded = loadFromStorage();
    if (loaded) {
      state = loaded;
      const mappingSyncOnLoad = syncMappingRowsWithCheckinPlayers();
      mappingRowsChangedOnLoad = mappingSyncOnLoad.changed;
      scorePairingsChangedOnLoad = refreshScorePairingAccountsFromMapping();
      if (
        !mappingSyncOnLoad.addedCount &&
        Array.isArray(state.players) &&
        state.players.length &&
        ensureMappingState().rows.some((row) =>
          !row.scriptLocked &&
          (!normalizeWhitespace(row.wechatNick) ||
            !normalizeWhitespace(row.registrationNick) ||
            !normalizeWhitespace(row.oqAccount)),
        )
      ) {
        queueMappingProcessY();
      }

      // Automatic preliminary rounds always follow the PAPP rule. A saved
      // manual value remains an explicit user choice; legacy/default values
      // are recalculated from the current roster instead of restoring an old
      // fixed-round default.
      if (
        Array.isArray(state.players) &&
        state.players.length > 0 &&
        state.scoreHelper &&
        state.scoreHelper.roundCountSource !== "manual"
      ) {
        state.scoreHelper.roundCountSource = "auto";
        void updateAutoPreliminaryRoundsIfNeeded();
      }

      // Saved check-in progress exists: default to showing import page, without overwriting stored step.
      if (
        state.step === "checkin" &&
        state.players &&
        state.players.length > 0
      ) {
        viewStepOverride = "import";
      }

      applyStateToUI();

      if (state.step === "checkin" && state.players.length > 0) {
        showSnackbar("已从本地恢复签到进度", 2400);
      } else if (
        state.step === "import" &&
        (state.clubText || state.relayText)
      ) {
        showSnackbar("已恢复上次粘贴的文本", 2200);
      }
    } else {
      applyStateToUI(true);
    }

    if (mappingRowsChangedOnLoad || scorePairingsChangedOnLoad) {
      state.savedAt = now();
      safeLocalStorageSet(STORAGE_KEY, JSON.stringify(state));
    }

    exposeTournamentApi();
    loadTournamentStageData(getCurrentStep());
    startLocalSync();
    mountApUi();
    void refreshEgAnalysisStatus({ silent: true });
    resumeWechatRelayPolling();
    schedulePappCandidateSync({ immediate: true });
  }

  // ------------------------------------------------------------
  // Node.js export (regression tests)
  // ------------------------------------------------------------
  if (IS_NODE) {
    // Export only the pure logic that tests rely on.
    module.exports = {
      // Parsing
      normalizeWhitespace,
      normalizeAutoCheckinToken,
      classifyWechatAutoCheckinMessage,
      isWechatAutoCheckinMessageInWindow,
      isWechatAutoCheckinMappingComplete,
      resolveWechatAutoCheckinPlayer,
      reconcileWechatAutoCheckinMessages,
      createDefaultWechatAutoCheckin,
      sanitizeWechatAutoCheckin,
      createDefaultTournamentParameters,
      sanitizeTournamentParameters,
      isWechatRelayTemplateContent,
      wechatRelayMonthUnixRange,
      wechatRelayMatchesEventMonth,
      formatWechatMessageTimestamp,
      latestWechatRelayFromMessages,
      wechatRelayPlayersMatch,
      wechatRelayRosterContainsCurrent,
      sanitizeWechatRelaySync,
      wechatMessageTimestampMs,
      anyWechatMessageAfterDeadline,
      cleanPlayerLine,
      parseLineToFields,
      parseImportTextsDetailed,
      // Suspects / duplicates
      computeSuspectReport,
      // Utilities used by tests
      normalizeForSimilarity,
      normalizeMappingNameKey,
      diceSimilarity,
      preliminaryRoundCountForPlayerCount,
      mappingOqNeedsQuestionMark,
      mappingOqRatingLabel,
      sanitizeMappingCheck,
      sanitizeMapping,
      mappingGroupRefreshQuery,
      mappingGroupCacheQuery,
      mappingGroupInputValue,
      mappingGroupTargetKey,
      synchronizeMappingGroupToSelectedChat,
      accountTokenFromGroupNick,
      matchGroupNicksToRosterPlayers,
      reconcileGroupNicksWithCandidates,
      reconcileHistoricalRelayGroupNicks,
      mappingGroupNickHasIdentityMismatch,
      relayMessageContainsMappingIdentity,
      mappingRowCandidateMatches,
      mappingRowsForRoster,
      syncMappingFieldToCheckinPlayer,
      reconcileMappingRowsWithCandidates,
      transferSelectedMappingText,
      buildMappingPlayersForPappSync,
      sanitizeScoreItem,
      sanitizeScorePairing,
      sanitizeScoreRound,
      sanitizeStandingsSnapshots,
      createDefaultScoreHelper,
      sanitizeScoreHelper,
      shouldRetryFailedEgAnalysis,
      sanitizePlayoffRegistration,
      scoreValue,
      isBoardScorePairing,
      isPappReadbackConfirmedPairing,
      complementBoardScore,
      isScoreBatchCandidate,
      scorePairingScoresMatch,
      scorePairingConfirmedByReadback,
    };
    return;
  }

  init();
})();
