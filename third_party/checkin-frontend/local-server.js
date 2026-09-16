"use strict";

// Local runtime for the offline check-in frontend.
//
// This server provides local static/shared-state routes and invokes PAPP C for
// tournament outcomes. It does not start or import FTD or Agent workflows.

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { URL } = require("url");
const sea = require("node:sea");
const EgAnalysis = require("./papp-eg-analysis.js");
const { ApCoordinator, mergeChanges } = require("./papp-ap-coordinator.js");
const ApCheckin = require("./papp-ap-checkin.js");
const ApTournament = require("./papp-ap-tournament.js");
const ApExport = require("./papp-ap-export.js");
const TournamentArchive = require("./papp-tournament-archive.js");
const TournamentHistory = require("./papp-tournament-history.js");
const { InvestigationBatchManager, safeBatchId } = require("./papp-investigation-batch.js");

const STATIC_ROOT = path.resolve(__dirname);
const SEA_WEB_ASSET_PREFIX = "web/";
const SEA_WEB_ASSET_KEYS = sea.isSea() ? new Set(sea.getAssetKeys()) : null;
const PROJECT_ROOT = path.resolve(STATIC_ROOT, "..", "..");
const PAPP_C_EXECUTABLE = path.resolve(
  process.env.PAPP_C_EXECUTABLE || path.join(PROJECT_ROOT, "bin", "Windows", "papp_GB.exe"),
);
const WECHAT_DIR = path.join(PROJECT_ROOT, "third_party", "wechat-decrypt");
const MAPPING_HELPER = path.join(WECHAT_DIR, "papp_mapping_helper.py");
const MAPPING_CACHE_DIR = path.join(WECHAT_DIR, "agent_cache");
const PLAYER_TOOLKIT_DIR = path.join(PROJECT_ROOT, "third_party", "player-analysis-toolkit");
const PLAYER_PROFILE_HELPER = path.join(
  PLAYER_TOOLKIT_DIR,
  "research",
  "tcn_loss_model",
  "scripts",
  "data",
  "papp_player_profile_query.py",
);
const PLAYER_PROFILE_CWD = path.join(PLAYER_TOOLKIT_DIR, "research", "tcn_loss_model");
const PLAYER_INVESTIGATION_SCRIPT = path.join(
  PLAYER_TOOLKIT_DIR,
  "scripts",
  "analysis",
  "run_player_investigation.py",
);
const PLAYER_SENTINEL_REFERENCE_CONFIG = path.join(
  PLAYER_TOOLKIT_DIR,
  "sentinel_reference_config_v11_matchup600_20260911.json",
);
const PLAYER_SENTINEL_ELO_REFERENCE_CONFIG = path.join(
  PLAYER_TOOLKIT_DIR,
  "sentinel_elo_reference_config_v4_matchup600_20260911.json",
);
const DATA_DIR = process.env.PAPP_DATA_DIR
  ? path.resolve(process.env.PAPP_DATA_DIR)
  : path.join(PROJECT_ROOT, "data");
const EG_ANALYSIS_DIR = path.join(DATA_DIR, "ega-analysis");
const EG_PGN_DIR = path.join(EG_ANALYSIS_DIR, "pgns");
const PLAYER_INVESTIGATION_ROOT = process.env.PAPP_PLAYER_INVESTIGATIONS_DIR
  ? path.resolve(process.env.PAPP_PLAYER_INVESTIGATIONS_DIR)
  : path.join(DATA_DIR, "player-investigations");
const PLAYER_INVESTIGATION_BATCH_ROOT = process.env.PAPP_PLAYER_INVESTIGATION_BATCHES_DIR
  ? path.resolve(process.env.PAPP_PLAYER_INVESTIGATION_BATCHES_DIR)
  : path.join(DATA_DIR, "player-investigation-batches");
const MANUAL_TOURNAMENT_ARCHIVES_DIR = path.join(PROJECT_ROOT, "manual-tournament-archives");
const STATE_FILE = process.env.PAPP_STATE_FILE
  ? path.resolve(process.env.PAPP_STATE_FILE)
  : path.join(DATA_DIR, "checkin-state.json");
const STATE_DIR = path.dirname(STATE_FILE);
const STATE_BASENAME = path.basename(STATE_FILE);
const PAPP_TOURNAMENT_WORKFILES_ENV = "PAPP_TOURNAMENT_WORKFILES_DIR";
const HOST = process.env.PAPP_HOST || "127.0.0.1";
const PORT = Number(process.env.PAPP_PORT || 4175);
const SERVICE = "papp-local-frontend";
const SERVICE_VERSION = "papp-local-frontend.37";
const PLAYER_INVESTIGATION_ELIGIBILITY_POLICY = "at-least-16-coordinate-placements-v1";
const PLAYER_INVESTIGATION_MINIMUM_ACTUAL_PLACEMENTS = 16;
const PLAYER_INVESTIGATION_FIRST_ELIGIBLE_DECISION_PLY = 17;
const PLAYER_INVESTIGATION_MINIMUM_CONTROL_GAMES = 8;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SCRIPT_WRITE_GUARD_MS = 3000;
const SCRIPT_RETRY_ERROR_MS = 1000;
const OQ_RESULTS_FILE = process.env.PAPP_OQ_RESULTS_FILE
  ? path.resolve(process.env.PAPP_OQ_RESULTS_FILE)
  : "";
const OQ_MODE_ENDPOINTS = Object.freeze({
  "1min": "reversi1",
  "5min": "reversi",
  xot: "reversix",
});
const OQ_USER_AGENT = "onlicheck-local-oq-client/0.1";
const OQ_DETAIL_LIMIT_PER_PAIRING = 8;
const EG_ENGINE_DIR = path.join(
  PROJECT_ROOT,
  "vendor",
  "engines",
  "Egaroucid_for_Console_7_8_1_Windows_SIMD",
);
const EG_ENGINE = path.join(EG_ENGINE_DIR, "Egaroucid_for_Console_7_8_1_SIMD.exe");

let egAnalysisJob = null;
const playerInvestigationJobs = new Map();
let playerInvestigationSequence = 0;
let resourceCpuSnapshot = null;
let gpuUsageCache = null;
let gpuUsageCacheAt = 0;
let gpuUsagePromise = null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const clients = new Set();
let revision = 0;
let lastMtimeMs = 0;
let stateWatcher = null;
let lastHumanWriteAt = 0;
let pendingScriptWrite = null;
let pendingScriptWriteTimer = null;
let pendingApWrite = null;
let pendingApWriteTimer = null;
let apTimer = null;

async function apLocalRequest(route, body) {
  const address = server.address();
  const port = address && address.port || PORT;
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180000),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.detail || result.message || result.error || `AP 请求失败：${response.status}`);
  return result;
}

const apCoordinator = new ApCoordinator({ request: apLocalRequest,
  checkin: ApCheckin, tournament: ApTournament, exportImage: ApExport.exportImage });

function scheduleApWrite() {
  if (!pendingApWrite) return;
  if (pendingApWriteTimer) clearTimeout(pendingApWriteTimer);
  pendingApWriteTimer = setTimeout(() => {
    pendingApWriteTimer = null;
    if (scriptWriteWaitMs() > 0) return scheduleApWrite();
    const pending = pendingApWrite;
    if (!pending) return;
    try {
      const current = readStateFile().state;
      const merged = mergeChanges(pending.baseState, pending.state, current);
      if (!pending.baseState.ap?.countdown && merged.ap?.status === "countdown" && merged.ap.countdown) {
        // The referee must receive ten full seconds after the queued state becomes visible.
        merged.ap.countdown.deadlineAt = Date.now() + 10000;
      }
      persistState(merged, "script");
      pendingApWrite = null;
    } catch (error) {
      console.error("[papp] AP pending state write failed:", error.message);
      pendingApWriteTimer = setTimeout(scheduleApWrite, SCRIPT_RETRY_ERROR_MS);
    }
  }, scriptWriteWaitMs());
}

function requestApWrite(baseState, state, source) {
  validateState(baseState);
  validateState(state);
  if (!isHumanWriteSource(source) && scriptWriteWaitMs() > 0) {
    pendingApWrite = { baseState, state };
    scheduleApWrite();
    return { ok: true, queued: true, retryAfterMs: scriptWriteWaitMs(), revision };
  }
  const latest = readStateFile().state;
  const written = persistState(mergeChanges(baseState, state, latest), source);
  return { ok: true, queued: false, state: written.state, revision };
}

function normalizeWriteSource(value) {
  const source = String(value || "").trim().toLowerCase();
  if (source === "human" || source === "user" || source === "frontend") {
    return "human";
  }
  return source || "script";
}

function isHumanWriteSource(source) {
  return normalizeWriteSource(source) === "human";
}

function stateSavedAt(state, fallback = 0) {
  const localSyncSavedAt = Number(
    state && state.localSync && state.localSync.savedAt,
  );
  if (Number.isFinite(localSyncSavedAt) && localSyncSavedAt > 0) {
    return localSyncSavedAt;
  }
  const savedAt = Number(state && state.savedAt);
  if (Number.isFinite(savedAt) && savedAt > 0) return savedAt;
  return Number(fallback) || 0;
}

function scriptWriteWaitMs() {
  return Math.max(0, lastHumanWriteAt + SCRIPT_WRITE_GUARD_MS - Date.now());
}

function clearPendingScriptWriteTimer() {
  if (pendingScriptWriteTimer) {
    clearTimeout(pendingScriptWriteTimer);
    pendingScriptWriteTimer = null;
  }
}

function schedulePendingScriptWrite() {
  if (!pendingScriptWrite) return;
  clearPendingScriptWriteTimer();
  pendingScriptWriteTimer = setTimeout(
    flushPendingScriptWrite,
    scriptWriteWaitMs(),
  );
}

function mappingPythonCommand() {
  const configured = String(process.env.PAPP_PYTHON || "").trim();
  if (configured) return configured;
  const packagedPython = path.join(PROJECT_ROOT, "runtime", "python", "python.exe");
  if (fs.existsSync(packagedPython)) return packagedPython;
  const venvPython = path.join(WECHAT_DIR, ".venv", "Scripts", "python.exe");
  return fs.existsSync(venvPython) ? venvPython : "python";
}

function playerProfilePythonCommand() {
  const configured = String(
    process.env.PAPP_PLAYER_PYTHON || process.env.PAPP_PYTHON || "",
  ).trim();
  return configured || mappingPythonCommand();
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function defaultWechatGroupName(date = new Date()) {
  return `【${date.getMonth() + 1}月无差别组】栢龙杯棋王赛`;
}

function safeWechatGroupFilePart(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "wechat-group";
}

function memberMapCachePath(groupName) {
  return path.join(
    MAPPING_CACHE_DIR,
    `${safeWechatGroupFilePart(groupName)}.member-map.json`,
  );
}

function normalizeWechatMemberMapPayload(raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const members = Array.isArray(payload.members) ? payload.members : [];
  const seen = new Set();
  const groupNicks = [];

  const append = (value) => {
    const nick = normalizeWhitespace(value);
    if (!nick || seen.has(nick)) return;
    seen.add(nick);
    groupNicks.push(nick);
  };

  if (Array.isArray(payload.groupNicks)) {
    payload.groupNicks.forEach(append);
  }
  members.forEach((member) => {
    if (member && typeof member === "object") {
      append(member.group_nick || member.groupNick);
    }
  });
  groupNicks.sort((a, b) => a.localeCompare(b, "zh-Hans"));

  return {
    ok: true,
    groupName: normalizeWhitespace(
      payload.group_name || payload.groupName || payload.group_query,
    ),
    roomUsername: normalizeWhitespace(payload.room_username || payload.roomUsername),
    refreshedAt: normalizeWhitespace(payload.refreshed_at || payload.refreshedAt),
    memberCount:
      Number(payload.member_count || payload.memberCount) ||
      members.length ||
      groupNicks.length,
    mappedCount:
      Number(payload.mapped_count || payload.mappedCount) || groupNicks.length,
    groupNicks,
  };
}

function readWechatMemberMap(groupName) {
  const targetGroup = normalizeWhitespace(groupName) || defaultWechatGroupName();
  const file = memberMapCachePath(targetGroup);
  if (!fs.existsSync(file)) {
    const error = new Error(`微信群昵称缓存不存在：${file}`);
    error.statusCode = 404;
    throw error;
  }
  const stat = fs.statSync(file);
  if (stat.size > 16 * 1024 * 1024) {
    throw new Error(`微信群昵称缓存过大：${file}`);
  }
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    ...normalizeWechatMemberMapPayload(payload),
    groupName: payload.group_name || targetGroup,
    cacheFile: file,
  };
}

function parseMappingHelperJSON(stdout, stderr) {
  const text = String(stdout || "").trim();
  const match = text.match(/\{[\s\S]*\}\s*$/);
  if (!match) {
    throw new Error(String(stderr || text || "mapping helper returned no JSON payload").trim());
  }
  const parsed = JSON.parse(match[0]);
  if (!parsed || parsed.ok === false) {
    throw new Error(String(parsed && parsed.error || stderr || "mapping helper failed").trim());
  }
  return parsed;
}

function runMappingHelper(args, input = "", timeoutMs = 120000) {
  if (!fs.existsSync(MAPPING_HELPER)) {
    return Promise.reject(new Error(`找不到 PAPP 映射 helper：${MAPPING_HELPER}`));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      mappingPythonCommand(),
      [MAPPING_HELPER, ...args],
      {
        cwd: WECHAT_DIR,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`映射 helper 超时（${Math.ceil(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    const appendOutput = (target, chunk) => {
      const text = chunk.toString("utf8");
      outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > 16 * 1024 * 1024) {
        child.kill();
        throw new Error("映射 helper 输出超过 16MB");
      }
      return target + text;
    };

    child.stdout.on("data", (chunk) => {
      try {
        stdout = appendOutput(stdout, chunk);
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        stderr = appendOutput(stderr, chunk);
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 Python 映射 helper：${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(String(stderr || stdout || `helper exited ${code || signal}`).trim()));
        return;
      }
      try {
        resolve(parseMappingHelperJSON(stdout, stderr));
      } catch (error) {
        reject(new Error(`映射 helper 输出解析失败：${error.message}`));
      }
    });

    child.stdin.end(String(input || ""), "utf8");
  });
}

function runPlayerProfileHelper(account, timeoutMs = 60000) {
  if (!fs.existsSync(PLAYER_PROFILE_HELPER)) {
    return Promise.reject(new Error(`找不到选手画像 helper：${PLAYER_PROFILE_HELPER}`));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      playerProfilePythonCommand(),
      [PLAYER_PROFILE_HELPER, "--account", account],
      {
        cwd: PLAYER_PROFILE_CWD,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`选手画像查询超时（${Math.ceil(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > 2 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动选手画像 helper：${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = String(stdout || "").trim();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        reject(new Error(`选手画像 helper 输出解析失败：${stderr || text || error.message}`));
        return;
      }
      if (code !== 0 || !payload || payload.ok === false) {
        reject(new Error(String((payload && payload.error) || stderr || `helper exited ${code || 1}`).trim()));
        return;
      }
      resolve(payload);
    });
  });
}

async function queryPlayerProfile(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  const account = normalizeWhitespace(input.account || input.id);
  if (!account) throw new Error("请输入 OQ ID");
  if (account.length > 64) throw new Error("OQ ID 过长");
  return runPlayerProfileHelper(account);
}

function investigationAccount(value) {
  const account = normalizeWhitespace(value);
  if (!account) throw new Error("请输入 OQ ID");
  if (account.length > 64) throw new Error("OQ ID 过长");
  return account;
}

function safeInvestigationAccountPart(account) {
  return investigationAccount(account)
    .replace(/[^0-9A-Za-z._-]+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 48) || "player";
}

function ensurePlayerInvestigationRoot() {
  fs.mkdirSync(PLAYER_INVESTIGATION_ROOT, { recursive: true });
}

function newPlayerInvestigationRun(account) {
  ensurePlayerInvestigationRoot();
  const stem = safeInvestigationAccountPart(account);
  let runId;
  let runDir;
  do {
    playerInvestigationSequence += 1;
    runId = `${stem}-${Date.now()}-${playerInvestigationSequence}`;
    runDir = path.join(PLAYER_INVESTIGATION_ROOT, runId);
  } while (fs.existsSync(runDir));
  fs.mkdirSync(runDir);
  return { runId, runDir };
}

function resolvePlayerInvestigationRun(runId) {
  const id = String(runId || "").trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(id)) {
    throw new Error("无效的选手调查运行 ID");
  }
  const root = path.resolve(PLAYER_INVESTIGATION_ROOT);
  const runDir = path.resolve(root, id);
  if (runDir !== root && !runDir.startsWith(`${root}${path.sep}`)) {
    throw new Error("选手调查运行目录越界");
  }
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    throw new Error(`找不到选手调查运行目录：${id}`);
  }
  return runDir;
}

function readInvestigationJson(file, label) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (stat.size > 64 * 1024 * 1024) {
    throw new Error(`${label} 过大：${file}`);
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 不是 JSON 对象：${file}`);
  }
  return value;
}

function readPlayerInvestigationProgress(runDir) {
  return readInvestigationJson(path.join(runDir, "progress.json"), "选手调查进度");
}

function readPlayerInvestigationCatalog(runDir) {
  const value = readInvestigationJson(
    path.join(runDir, "game_catalog.json"),
    "选手调查对局目录",
  );
  if (!value) return null;
  if (value.schema !== "player-investigation-game-catalog-v1") {
    throw new Error("选手调查对局目录 schema 不受支持");
  }
  if (!Array.isArray(value.games)) {
    throw new Error("选手调查对局目录缺少 games");
  }
  return {
    schema: value.schema,
    account: normalizeWhitespace(value.account),
    eligibilityPolicy: normalizeWhitespace(value.eligibilityPolicy),
    minimumActualPlacements: Number(value.minimumActualPlacements) || null,
    firstEligibleDecisionPly: Number(value.firstEligibleDecisionPly) || null,
    requiresRecognizedFinalStatus: value.requiresRecognizedFinalStatus === false ? false : null,
    sourceGameCount: Number(value.sourceGameCount) || value.games.length,
    excludedShortGameCount: Number(value.excludedShortGameCount) || 0,
    gameCount: value.games.length,
    games: value.games,
  };
}

function isCurrentPlayerInvestigationCatalog(catalog) {
  return Boolean(catalog)
    && catalog.eligibilityPolicy === PLAYER_INVESTIGATION_ELIGIBILITY_POLICY
    && catalog.minimumActualPlacements === PLAYER_INVESTIGATION_MINIMUM_ACTUAL_PLACEMENTS
    && catalog.firstEligibleDecisionPly === PLAYER_INVESTIGATION_FIRST_ELIGIBLE_DECISION_PLY
    && catalog.requiresRecognizedFinalStatus === false;
}

function investigationSummaryNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function investigationSummaryInterval(value) {
  if (!value) return null;
  const lower = investigationSummaryNumber(
    Array.isArray(value) ? value[0] : value.lower,
  );
  const upper = investigationSummaryNumber(
    Array.isArray(value) ? value[1] : value.upper,
  );
  return lower === null || upper === null ? null : { lower, upper };
}

function reportedAnalysisSummary(report) {
  const nonModel = report.nonModel && typeof report.nonModel === "object"
    ? report.nonModel
    : {};
  const lossAndWld = nonModel.lossAndWld && typeof nonModel.lossAndWld === "object"
    ? nonModel.lossAndWld
    : {};
  const sameColor = lossAndWld.sameColorComparison
    && typeof lossAndWld.sameColorComparison === "object"
    ? lossAndWld.sameColorComparison
    : {};
  const engineDefinitions = [
    {
      key: "wldPerGame",
      label: "WLD 损失/局",
      kind: "number",
      differenceField: "engineWldLossPerGameDifference",
      intervalField: "engineWldLossPerGameClusterBootstrap95CI",
    },
    {
      key: "zeroLossRate",
      label: "零子损率",
      kind: "percentagePoints",
      differenceField: "zeroLossRateDifference",
      intervalField: "zeroLossRateClusterBootstrap95CI",
    },
    {
      key: "ge4Rate",
      label: "≥4 子损率",
      kind: "percentagePoints",
      differenceField: "lossAtLeast4RateDifference",
      intervalField: "lossAtLeast4RateClusterBootstrap95CI",
    },
    {
      key: "ge10Rate",
      label: "≥10 子损率",
      kind: "percentagePoints",
      differenceField: "lossAtLeast10RateDifference",
      intervalField: "lossAtLeast10RateClusterBootstrap95CI",
    },
  ];
  const engineMetrics = engineDefinitions.map((definition) => ({
    key: definition.key,
    label: definition.label,
    kind: definition.kind,
    difference: investigationSummaryNumber(sameColor[definition.differenceField]),
    interval: investigationSummaryInterval(sameColor[definition.intervalField]),
  }));

  const model = report.model && typeof report.model === "object" ? report.model : {};
  const reportedModel = model.reportedBootstrap
    && typeof model.reportedBootstrap === "object"
    ? model.reportedBootstrap
    : {};
  const requestedMetrics = reportedModel.requestedReportedGroupMetrics
    && typeof reportedModel.requestedReportedGroupMetrics === "object"
    ? reportedModel.requestedReportedGroupMetrics
    : {};
  const pointEstimates = requestedMetrics.pointEstimates
    && typeof requestedMetrics.pointEstimates === "object"
    ? requestedMetrics.pointEstimates
    : {};
  const bootstrapIntervals = requestedMetrics.bootstrap95PercentIntervals
    && typeof requestedMetrics.bootstrap95PercentIntervals === "object"
    ? requestedMetrics.bootstrap95PercentIntervals
    : {};
  const requestedActuals = requestedMetrics.actualPointEstimates
    && typeof requestedMetrics.actualPointEstimates === "object"
    ? requestedMetrics.actualPointEstimates
    : {};
  const reportedGroups = reportedModel.groups && typeof reportedModel.groups === "object"
    ? reportedModel.groups
    : {};
  const combinedReportedGroup = reportedGroups.combined
    && typeof reportedGroups.combined === "object"
    ? reportedGroups.combined
    : {};
  const combinedReportedPoints = combinedReportedGroup.pointEstimates
    && typeof combinedReportedGroup.pointEstimates === "object"
    ? combinedReportedGroup.pointEstimates
    : {};
  const calibration = model.controlAdaptationCalibration
    && typeof model.controlAdaptationCalibration === "object"
    ? model.controlAdaptationCalibration
    : {};
  const probabilityRates = calibration.probabilityRateCalibration
    && typeof calibration.probabilityRateCalibration === "object"
    ? calibration.probabilityRateCalibration
    : {};
  const predictionDefinitions = [
    { key: "zero", label: "零子损率", kind: "rate" },
    { key: "ge4", label: "≥4 子损率", kind: "rate" },
    { key: "ge10", label: "≥10 子损率", kind: "rate" },
    { key: "expected_wld_loss", label: "预期 WLD 损失", kind: "number" },
  ];
  const predictionMetrics = predictionDefinitions
    .map((definition) => {
      const insufficientSample = definition.key === "expected_wld_loss"
        && !(Number(requestedMetrics.wldApplicableNodes) > 0);
      const value = insufficientSample
        ? null
        : investigationSummaryNumber(pointEstimates[definition.key]);
      const interval = insufficientSample
        ? null
        : investigationSummaryInterval(bootstrapIntervals[definition.key]);
      const reportedPoint = combinedReportedPoints[definition.key]
        && typeof combinedReportedPoints[definition.key] === "object"
        ? combinedReportedPoints[definition.key]
        : {};
      const explicitReportedActual = investigationSummaryNumber(requestedActuals[definition.key]);
      const reportedActual = explicitReportedActual !== null
        ? explicitReportedActual
        : investigationSummaryNumber(reportedPoint.gameEqualActualRate);
      const difference = value === null || reportedActual === null
        ? null
        : value - reportedActual;
      const differenceInterval = interval === null || reportedActual === null
        ? null
        : {
          lower: interval.lower - reportedActual,
          upper: interval.upper - reportedActual,
        };
      return {
        key: definition.key,
        label: definition.label,
        kind: definition.kind,
        insufficientSample,
        value,
        interval,
        reportedActual,
        difference,
        differenceInterval,
      };
    })
    .filter((metric) => metric.insufficientSample
      || metric.value !== null || metric.interval !== null || metric.reportedActual !== null);

  const hardRates = calibration.hardDecisionMatchRates
    && typeof calibration.hardDecisionMatchRates === "object"
    ? calibration.hardDecisionMatchRates
    : {};
  const hardDefinitions = [
    { key: "fourClassExact", label: "四分类完全匹配" },
    { key: "wldThreeClassExact", label: "WLD 三分类完全匹配" },
    { key: "zero", label: "零子损匹配" },
    { key: "ge4", label: "≥4 子损匹配" },
    { key: "ge10", label: "≥10 子损匹配" },
  ];
  const hardMatchMetrics = hardDefinitions
    .filter((definition) => hardRates[definition.key] && typeof hardRates[definition.key] === "object")
    .map((definition) => ({
      key: definition.key,
      label: definition.label,
      before: investigationSummaryNumber(hardRates[definition.key].before),
      after: investigationSummaryNumber(hardRates[definition.key].after),
    }));
  const probabilityDefinitions = [
    { key: "zero", label: "零子损率", kind: "rate" },
    { key: "ge4", label: "≥4 子损率", kind: "rate" },
    { key: "ge10", label: "≥10 子损率", kind: "rate" },
    { key: "expectedWldLoss", label: "预期 WLD 损失", kind: "number" },
  ];
  const probabilityMatchMetrics = probabilityDefinitions
    .filter((definition) => probabilityRates[definition.key] && typeof probabilityRates[definition.key] === "object")
    .map((definition) => ({
      key: definition.key,
      label: definition.label,
      kind: definition.kind,
      actual: investigationSummaryNumber(probabilityRates[definition.key].actual),
      before: investigationSummaryNumber(probabilityRates[definition.key].before),
      after: investigationSummaryNumber(probabilityRates[definition.key].after),
    }));
  const reportedSameColor = sameColor.reported && typeof sameColor.reported === "object"
    ? sameColor.reported
    : {};
  const controlSameColor = sameColor.control && typeof sameColor.control === "object"
    ? sameColor.control
    : {};

  return {
    comparisonBasis: "reported_minus_same_color_control",
    reportedSameColorGameCount: investigationSummaryNumber(reportedSameColor.gameCount),
    controlSameColorGameCount: investigationSummaryNumber(controlSameColor.gameCount),
    engineMetrics,
    adaptation: {
      evaluationRole: normalizeWhitespace(calibration.evaluationRole),
      hardMatchMetrics,
      probabilityMatchMetrics,
    },
    reportedPrediction: {
      status: normalizeWhitespace(reportedModel.status),
      interpretation: normalizeWhitespace(reportedModel.interpretation),
      memberCount: investigationSummaryNumber(reportedModel.memberCount),
      bootstrapReplicates: investigationSummaryNumber(reportedModel.bootstrapReplicates),
      reportedGameCount: investigationSummaryNumber(reportedModel.reportedGames),
      nodeCount: investigationSummaryNumber(requestedMetrics.nodes),
      wldApplicableNodeCount: investigationSummaryNumber(requestedMetrics.wldApplicableNodes),
      metrics: predictionMetrics,
    },
  };
}

function investigationReportSummary(runDir) {
  const report = readInvestigationJson(path.join(runDir, "report.json"), "选手调查报告");
  if (!report) return null;
  const groups = report.groups && typeof report.groups === "object" ? report.groups : {};
  const selection = report.selection && typeof report.selection === "object" ? report.selection : {};
  const isSentinel = report.schema === "player-anomaly-sentinel-report-v1";
  const reported = Array.isArray(groups.reportedGameIds)
    ? groups.reportedGameIds
    : Array.isArray(selection.reportedGameIds)
      ? selection.reportedGameIds
      : [];
  const control = Array.isArray(groups.controlGameIds)
    ? groups.controlGameIds
    : Array.isArray(selection.modelControlGameIds)
      ? selection.modelControlGameIds
      : Array.isArray(selection.statisticalControlGameIds)
        ? selection.statisticalControlGameIds
        : [];
  const acquisition = report.acquisition && typeof report.acquisition === "object"
    ? report.acquisition
    : {};
  const estimatedElo = report.estimatedElo && typeof report.estimatedElo === "object"
    ? report.estimatedElo
    : {};
  const estimate = investigationSummaryNumber(estimatedElo.estimatedElo);
  const scan = report.sentinelScan && typeof report.sentinelScan === "object"
    ? report.sentinelScan
    : {};
  const phaseAnalysis = report.playerPhaseAnalysis && typeof report.playerPhaseAnalysis === "object"
    ? report.playerPhaseAnalysis
    : {};
  const phaseRows = Array.isArray(phaseAnalysis.phases) ? phaseAnalysis.phases : [];
  const model = report.model && typeof report.model === "object" ? report.model : {};
  const ratingIntervals = Array.isArray(estimatedElo.databaseCalibrated95Intervals)
    ? estimatedElo.databaseCalibrated95Intervals
      .map((interval) => {
        const range = investigationSummaryInterval(interval);
        return range
          ? {
              ...range,
              truncatedLower: Boolean(interval.truncatedLower),
              truncatedUpper: Boolean(interval.truncatedUpper),
            }
          : null;
      })
      .filter(Boolean)
    : [];
  const ratingStatusReasons = Array.isArray(estimatedElo.statusReasons)
    ? estimatedElo.statusReasons.map(normalizeWhitespace).filter(Boolean)
    : [];
  const excludedRatingReasonCounts = new Map();
  if (Array.isArray(estimatedElo.excludedGamesWithReasons)) {
    for (const excluded of estimatedElo.excludedGamesWithReasons) {
      const reason = normalizeWhitespace(excluded && excluded.reason);
      if (!reason) continue;
      excludedRatingReasonCounts.set(reason, (excludedRatingReasonCounts.get(reason) || 0) + 1);
    }
  }
  const sentinelSummary = isSentinel
    ? {
        bestK: investigationSummaryNumber(scan.selectedK ?? selection.selectedK),
        candidateGameCount: Array.isArray(scan.selectedGameIds)
          ? scan.selectedGameIds.length
          : null,
        bestSingleExceedanceRate: investigationSummaryNumber(
          scan.bestSingle && scan.bestSingle.scanCorrectedNormalExceedanceRate,
        ),
        bestSingleExceedanceInterval: investigationSummaryInterval(
          scan.bestSingle && scan.bestSingle.wilson95Interval,
        ),
        overallExceedanceRate: investigationSummaryNumber(
          scan.allGames && scan.allGames.normalExceedanceRate,
        ),
        overallExceedanceInterval: investigationSummaryInterval(
          scan.allGames && scan.allGames.wilson95Interval,
        ),
        scanCorrectedExceedanceRate: investigationSummaryNumber(
          scan.scanCorrectedNormalExceedanceRate,
        ),
        scanCorrectedExceedanceInterval: investigationSummaryInterval(
          scan.scanCorrectedWilson95Interval,
        ),
        rating: {
          estimate,
          status: normalizeWhitespace(estimatedElo.status),
          statusReasons: ratingStatusReasons,
          selectedGameCount: investigationSummaryNumber(estimatedElo.selectedGameCount),
          minimumGameCount: investigationSummaryNumber(estimatedElo.formalMinimumGameCount),
          maximumGameCount: investigationSummaryNumber(estimatedElo.formalMaximumGameCount),
          formalMinimum: investigationSummaryNumber(estimatedElo.formalEloMinimum),
          formalMaximum: investigationSummaryNumber(estimatedElo.formalEloMaximum),
          excludedGameCount: Array.isArray(estimatedElo.excludedGamesWithReasons)
            ? estimatedElo.excludedGamesWithReasons.length
            : null,
          excludedReasons: Array.from(excludedRatingReasonCounts, ([reason, count]) => ({ reason, count }))
            .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
          intervals: ratingIntervals,
        },
        phaseStatus: normalizeWhitespace(phaseAnalysis.status),
        strongestPhaseLabel: normalizeWhitespace(phaseAnalysis.strongestPhaseLabel),
        weakestPhaseLabel: normalizeWhitespace(phaseAnalysis.weakestPhaseLabel),
        phases: phaseRows.map((phase) => ({
          phase: investigationSummaryNumber(phase && phase.phase),
          label: normalizeWhitespace(phase && phase.label),
          startPly: investigationSummaryNumber(phase && phase.startPly),
          endPly: investigationSummaryNumber(phase && phase.endPly),
          validGames: investigationSummaryNumber(phase && phase.validGames),
          validNodes: investigationSummaryNumber(phase && phase.validNodes),
          meanDiscLoss: investigationSummaryNumber(phase && phase.meanDiscLoss),
          probabilityLossEq0: investigationSummaryNumber(phase && phase.probabilityLossEq0),
          probabilityLossGe4: investigationSummaryNumber(phase && phase.probabilityLossGe4),
          probabilityLossGe10: investigationSummaryNumber(phase && phase.probabilityLossGe10),
        })),
        modelReviewReady: Boolean(model.modelReviewReady ?? scan.modelReviewReady),
        modelStatus: normalizeWhitespace(model.status),
        modelReason: normalizeWhitespace(model.reason),
      }
    : null;
  const reportedAnalysis = !isSentinel || reported.length > 0
    ? reportedAnalysisSummary(report)
    : null;
  return {
    schema: normalizeWhitespace(report.schema),
    status: normalizeWhitespace(report.status),
    generatedAtUtc: normalizeWhitespace(report.generatedAtUtc),
    account: normalizeWhitespace(report.account),
    mode: isSentinel ? "sentinel" : "manual",
    classification: normalizeWhitespace(report.classification || selection.classification),
    estimatedElo: estimate,
    reportedGameCount: reported.length,
    controlGameCount: control.length,
    acquisition: {
      listedGameCount: investigationSummaryNumber(acquisition.listedGameCount),
      detailFetchedGameCount: investigationSummaryNumber(
        acquisition.detailFetchedGameCount ?? acquisition.detailTerminalGameCount,
      ),
      detailFailureGameCount: investigationSummaryNumber(acquisition.detailFailureGameCount),
      coverageStatus: normalizeWhitespace(acquisition.coverageStatus),
      coverageWarning: normalizeWhitespace(acquisition.coverageWarning),
    },
    ...(sentinelSummary ? { sentinel: sentinelSummary } : {}),
    ...(reportedAnalysis ? { reportedAnalysis } : {}),
    reportPath: path.join(runDir, "report.json"),
  };
}

function listPlayerInvestigationHistory() {
  const reports = [];

  if (fs.existsSync(PLAYER_INVESTIGATION_ROOT)) {
    for (const entry of fs.readdirSync(PLAYER_INVESTIGATION_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(entry.name)) continue;
      const runDir = resolvePlayerInvestigationRun(entry.name);
      const reportPath = path.join(runDir, "report.json");
      if (!fs.existsSync(reportPath)) continue;
      const reportStat = fs.lstatSync(reportPath);
      if (!reportStat.isFile()) continue;

      const report = investigationReportSummary(runDir);
      if (!report || report.status !== "completed" || !report.account) continue;
      const progress = readPlayerInvestigationProgress(runDir);
      reports.push({
        type: "single",
        runId: entry.name,
        schema: report.schema,
        status: report.status,
        account: report.account,
        mode: report.mode,
        classification: report.classification,
        reportedGameCount: report.reportedGameCount,
        controlGameCount: report.controlGameCount,
        generatedAt: report.generatedAtUtc
          || normalizeWhitespace(progress && progress.createdAtUtc)
          || reportStat.mtime.toISOString(),
      });
    }
  }

  if (fs.existsSync(PLAYER_INVESTIGATION_BATCH_ROOT)) {
    for (const entry of fs.readdirSync(PLAYER_INVESTIGATION_BATCH_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let batchId;
      try {
        batchId = safeBatchId(entry.name);
      } catch (_) {
        continue;
      }
      const reportPath = path.join(PLAYER_INVESTIGATION_BATCH_ROOT, batchId, "report.json");
      if (!fs.existsSync(reportPath)) continue;
      const reportStat = fs.lstatSync(reportPath);
      if (!reportStat.isFile()) continue;
      const report = readInvestigationJson(reportPath, "多人哨兵分析报告");
      if (
        !report
        || report.schema !== "papp-batch-sentinel-report-v1"
        || report.status !== "completed"
        || report.batchId !== batchId
      ) continue;

      reports.push({
        type: "batch",
        batchId,
        schema: report.schema,
        status: report.status,
        competitionName: normalizeWhitespace(report.competitionName),
        tournamentFile: normalizeWhitespace(report.tournamentFile),
        totalCount: investigationSummaryNumber(report.totalCount),
        completedCount: investigationSummaryNumber(report.completedCount),
        failedCount: investigationSummaryNumber(report.failedCount),
        createdAt: normalizeWhitespace(report.createdAt),
        completedAt: normalizeWhitespace(report.completedAt),
        generatedAt: normalizeWhitespace(report.completedAt)
          || normalizeWhitespace(report.createdAt)
          || reportStat.mtime.toISOString(),
      });
    }
  }

  const timestamp = (report) => {
    const value = Date.parse(report.generatedAt);
    return Number.isFinite(value) ? value : 0;
  };
  return reports.sort((left, right) => timestamp(right) - timestamp(left));
}

function appendInvestigationOutput(current, chunk) {
  const text = String(chunk || "");
  const combined = `${current || ""}${text}`;
  return combined.length > 128 * 1024
    ? combined.slice(-128 * 1024)
    : combined;
}

function readSystemCpuPercent() {
  const current = os.cpus().reduce(
    (snapshot, cpu) => {
      const times = cpu.times || {};
      const user = Number(times.user) || 0;
      const nice = Number(times.nice) || 0;
      const sys = Number(times.sys) || 0;
      const idle = Number(times.idle) || 0;
      const irq = Number(times.irq) || 0;
      snapshot.idle += idle;
      snapshot.total += user + nice + sys + idle + irq;
      return snapshot;
    },
    { idle: 0, total: 0 },
  );
  const previous = resourceCpuSnapshot;
  resourceCpuSnapshot = current;
  if (!previous) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return Number(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)).toFixed(1));
}

function parseGpuUsage(stdout) {
  const devices = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, name, utilization, memoryUsed, memoryTotal] = line
        .split(",")
        .map((value) => value.trim());
      const numberOrNull = (value) => {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
      };
      return {
        index: numberOrNull(index),
        name: name || "GPU",
        utilizationPercent: numberOrNull(utilization),
        memoryUsedMiB: numberOrNull(memoryUsed),
        memoryTotalMiB: numberOrNull(memoryTotal),
      };
    });
  return devices.length
    ? { available: true, devices }
    : { available: false, reason: "没有检测到可用 GPU" };
}

function readGpuUsage() {
  const now = Date.now();
  const cacheTtl = gpuUsageCache && gpuUsageCache.available ? 1500 : 10000;
  if (gpuUsageCache && now - gpuUsageCacheAt < cacheTtl) {
    return Promise.resolve(gpuUsageCache);
  }
  if (gpuUsagePromise) return gpuUsagePromise;
  gpuUsagePromise = new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      [
        "--query-gpu=index,name,utilization.gpu,memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ],
      { windowsHide: true, timeout: 2000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        gpuUsageCache = error
          ? { available: false, reason: "未检测到 nvidia-smi" }
          : parseGpuUsage(stdout);
        gpuUsageCacheAt = Date.now();
        gpuUsagePromise = null;
        resolve(gpuUsageCache);
      },
    );
  });
  return gpuUsagePromise;
}

async function readSystemResourceSnapshot() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = Math.max(0, totalMemory - freeMemory);
  return {
    capturedAt: new Date().toISOString(),
    cpu: {
      percent: readSystemCpuPercent(),
    },
    memory: {
      usedMiB: Math.round(usedMemory / (1024 * 1024)),
      freeMiB: Math.round(freeMemory / (1024 * 1024)),
      totalMiB: Math.round(totalMemory / (1024 * 1024)),
      percent: totalMemory > 0 ? Number((usedMemory / totalMemory * 100).toFixed(1)) : null,
    },
    gpu: await readGpuUsage(),
  };
}

function startPlayerInvestigationProcess(runId, runDir, phase, args) {
  if (!fs.existsSync(PLAYER_INVESTIGATION_SCRIPT)) {
    throw new Error(`找不到选手调查流程脚本：${PLAYER_INVESTIGATION_SCRIPT}`);
  }
  const child = spawn(
    playerProfilePythonCommand(),
    [PLAYER_INVESTIGATION_SCRIPT, ...args],
    {
      cwd: PLAYER_TOOLKIT_DIR,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONPATH: [
          path.join(PLAYER_TOOLKIT_DIR, "src"),
          process.env.PYTHONPATH || "",
        ].filter(Boolean).join(path.delimiter),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const job = {
    runId,
    phase,
    child,
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    exitCode: null,
    error: "",
    stdout: "",
    stderr: "",
    terminationRequested: false,
    terminated: false,
  };
  playerInvestigationJobs.set(runId, job);
  child.stdout.on("data", (chunk) => {
    job.stdout = appendInvestigationOutput(job.stdout, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    job.stderr = appendInvestigationOutput(job.stderr, chunk.toString("utf8"));
  });
  child.on("error", (error) => {
    job.error = `无法启动选手调查流程：${error.message}`;
    job.running = false;
    job.finishedAt = new Date().toISOString();
  });
  child.on("close", (code, signal) => {
    job.running = false;
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    if (job.terminationRequested) {
      job.terminated = true;
    } else if (code !== 0 && !job.error) {
      job.error = String(
        job.stderr || job.stdout || `选手调查流程结束异常：${code === null ? signal || "unknown" : code}`,
      ).trim();
    }
  });
  return job;
}

function playerInvestigationStatus(runId, includeCatalog = false) {
  const runDir = resolvePlayerInvestigationRun(runId);
  const progress = readPlayerInvestigationProgress(runDir);
  const config = readInvestigationJson(path.join(runDir, "run_config.json"), "选手调查配置");
  const job = playerInvestigationJobs.get(String(runId).trim());
  const progressRunning = normalizeWhitespace(progress && progress.status).toLowerCase() === "running";
  let persistedProcessRunning = false;
  const persistedPid = Number(progress && progress.processId);
  if (progressRunning && Number.isInteger(persistedPid) && persistedPid > 0) {
    try {
      process.kill(persistedPid, 0);
      persistedProcessRunning = true;
    } catch (_) {
      persistedProcessRunning = false;
    }
  }
  const progressFailed = normalizeWhitespace(progress && progress.status).toLowerCase() === "failed";
  const status = {
    ok: true,
    runId: String(runId).trim(),
    account: normalizeWhitespace((config && config.account) || (progress && progress.account)),
    mode: normalizeWhitespace(config && config.mode),
    // Keep a run marked as active when the service was restarted and the
    // child process registry is empty; the progress file is the durable
    // source of truth for that in-flight stage.
    running: (Boolean(job && job.running) || (!job && persistedProcessRunning))
      && !["completed", "failed", "cancelled"].includes(normalizeWhitespace(progress && progress.status).toLowerCase()),
    phase: job ? job.phase : "",
    startedAt: job ? job.startedAt : "",
    finishedAt: job ? job.finishedAt : "",
    exitCode: job ? job.exitCode : null,
    terminationRequested: Boolean(job && job.terminationRequested),
    terminated: Boolean(job && job.terminated),
    error: normalizeWhitespace(
      (job && job.error) || (progressFailed && progress.lastError && progress.lastError.message) || "",
    ),
    progress,
    report: investigationReportSummary(runDir),
  };
  if (includeCatalog) status.catalog = readPlayerInvestigationCatalog(runDir);
  return status;
}

function terminatePlayerInvestigation(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  const runId = String(input.runId || "").trim();
  resolvePlayerInvestigationRun(runId);
  const job = playerInvestigationJobs.get(runId);
  if (!job) throw new Error("当前本地服务没有可终止的调查进程");
  if (!job.running || job.terminated || job.terminationRequested) {
    return playerInvestigationStatus(runId, false);
  }

  job.terminationRequested = true;
  const pid = Number(job.child && job.child.pid);
  if (process.platform === "win32" && Number.isInteger(pid) && pid > 0) {
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 },
      (error) => {
        if (error && job.running) {
          job.terminationRequested = false;
          job.error = `终止调查任务失败：${error.message}`;
        }
      },
    );
  } else {
    job.child.kill("SIGTERM");
  }
  return playerInvestigationStatus(runId, false);
}

function startPlayerInvestigation(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  const account = investigationAccount(input.account || input.id);
  // Reuse the newest completed acquisition so reopening the flow does not
  // discard the already downloaded game catalog and start a second fetch.
  if (fs.existsSync(PLAYER_INVESTIGATION_ROOT)) {
    const prior = fs.readdirSync(PLAYER_INVESTIGATION_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(PLAYER_INVESTIGATION_ROOT, entry.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const candidate of prior) {
      const progress = readPlayerInvestigationProgress(candidate);
      const config = readInvestigationJson(path.join(candidate, "run_config.json"), "选手调查配置");
      if (normalizeWhitespace((config && config.account) || (progress && progress.account)).toLowerCase() !== account.toLowerCase()) continue;
      // Only reuse an acquisition that is still waiting for group selection.
      // Once groups are frozen, reusing this directory after a service restart
      // sends the user back to a run that may still be analysing (or has
      // already failed), so the next selection is rejected as frozen.
      const groupsPending = progress
        && progress.stages?.fetch_games?.status === "completed"
        && progress.stages?.select_groups?.status !== "completed"
        && progress.status !== "completed";
      const catalog = groupsPending ? readPlayerInvestigationCatalog(candidate) : null;
      if (groupsPending && isCurrentPlayerInvestigationCatalog(catalog)) {
        return playerInvestigationStatus(path.basename(candidate), false);
      }
    }
  }
  for (const job of playerInvestigationJobs.values()) {
    if (job.running && normalizeWhitespace(job.account).toLowerCase() === account.toLowerCase()) {
      return playerInvestigationStatus(job.runId, false);
    }
  }
  const { runId, runDir } = newPlayerInvestigationRun(account);
  const job = startPlayerInvestigationProcess(
    runId,
    runDir,
    "acquisition",
    ["start", "--account", account, "--mode", "5min", "--output-dir", runDir],
  );
  job.account = account;
  return playerInvestigationStatus(runId, false);
}

function startPlayerSentinelInvestigation(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  const sourceRunId = normalizeWhitespace(input.runId);
  const sourceRunDir = resolvePlayerInvestigationRun(sourceRunId);
  const sourceJob = playerInvestigationJobs.get(sourceRunId);
  if (sourceJob && sourceJob.running) {
    throw new Error("全部对局仍在拉取，请等待完成后再启动哨兵监测");
  }

  const progress = readPlayerInvestigationProgress(sourceRunDir);
  if (!progress || progress.stages?.fetch_games?.status !== "completed") {
    throw new Error("全部对局尚未拉取完成");
  }
  const config = readInvestigationJson(path.join(sourceRunDir, "run_config.json"), "选手调查配置");
  const account = investigationAccount(config && config.account);
  const sourceCatalog = readPlayerInvestigationCatalog(sourceRunDir);
  if (!isCurrentPlayerInvestigationCatalog(sourceCatalog)) {
    throw new Error("旧任务不符合当前每局至少 16 个坐标落子的筛选规则，请返回调查入口重新拉取");
  }
  const sourceBundle = path.join(sourceRunDir, "account_bundle.json");
  if (!fs.existsSync(sourceBundle)) {
    throw new Error("已拉取的账号对局包不存在，无法启动哨兵监测");
  }
  for (const job of playerInvestigationJobs.values()) {
    if (!job.running || normalizeWhitespace(job.account).toLowerCase() !== account.toLowerCase()) continue;
    if (job.phase === "sentinel") return playerInvestigationStatus(job.runId, false);
    throw new Error("该选手已有调查任务正在运行，请等待任务完成后再启动哨兵监测");
  }
  if (!fs.existsSync(PLAYER_SENTINEL_REFERENCE_CONFIG)) {
    throw new Error(`找不到哨兵参照配置：${PLAYER_SENTINEL_REFERENCE_CONFIG}`);
  }
  if (!fs.existsSync(PLAYER_SENTINEL_ELO_REFERENCE_CONFIG)) {
    throw new Error(`找不到哨兵 Rating 参照配置：${PLAYER_SENTINEL_ELO_REFERENCE_CONFIG}`);
  }

  const { runId, runDir } = newPlayerInvestigationRun(account);
  const args = [
    "start-sentinel",
    "--account", account,
    "--mode", "5min",
    "--output-dir", runDir,
    "--reference-config", PLAYER_SENTINEL_REFERENCE_CONFIG,
    "--elo-reference-config", PLAYER_SENTINEL_ELO_REFERENCE_CONFIG,
    "--bundle", sourceBundle,
    // Keep the expensive pseudo scan parallel by default. Four workers cap
    // memory use while still using multiple cores on the bundled runtime.
    "--pseudo-workers", String(Math.max(1, Math.min(4, Math.floor((os.cpus()?.length || 2) / 2)))),
  ];
  const job = startPlayerInvestigationProcess(runId, runDir, "sentinel", args);
  job.account = account;
  return playerInvestigationStatus(runId, false);
}

function selectPlayerInvestigationGroups(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  const runId = String(input.runId || "").trim();
  const runDir = resolvePlayerInvestigationRun(runId);
  const currentJob = playerInvestigationJobs.get(runId);
  if (currentJob && currentJob.running) {
    throw new Error("对局拉取流程仍在运行，请等待对局列表加载完成");
  }
  const progress = readPlayerInvestigationProgress(runDir);
  if (!progress || progress.stages?.fetch_games?.status !== "completed") {
    throw new Error("对局列表尚未拉取完成");
  }
  // A service restart loses the in-memory child-process registry, but the
  // progress file still records an active analysis. Reusing that run for a
  // second selection would only produce the misleading frozen-groups error.
  if (progress.status === "running" && progress.stages?.select_groups?.status === "completed") {
    const durableStatus = playerInvestigationStatus(runId, false);
    if (!durableStatus.running) {
      throw new Error("该调查进程已退出，请返回调查入口重新开始");
    }
    return {
      ...durableStatus,
      reportedGameCount: progress.stages.select_groups.reportedGameIds?.length || 0,
      controlGameCount: progress.stages.select_groups.controlGameIds?.length || 0,
    };
  }
  const catalog = readPlayerInvestigationCatalog(runDir);
  if (!catalog || !catalog.games.length) throw new Error("没有可供选择的对局");
  if (!isCurrentPlayerInvestigationCatalog(catalog)) {
    throw new Error("旧任务不符合当前每局至少 16 个坐标落子的筛选规则，请返回调查入口重新拉取");
  }
  const available = catalog.games.map((game) => normalizeWhitespace(game.gameId));
  const availableSet = new Set(available);
  const requested = Array.isArray(input.reportedGameIds)
    ? input.reportedGameIds.map((value) => normalizeWhitespace(value)).filter(Boolean)
    : [];
  const reported = [...new Set(requested)];
  if (!reported.length) throw new Error("至少勾选一局举报局");
  const missing = reported.filter((gameId) => !availableSet.has(gameId));
  if (missing.length) throw new Error(`选中的对局不在当前账户目录中：${missing.slice(0, 5).join(", ")}`);
  const control = available.filter((gameId) => !reported.includes(gameId));
  if (control.length < PLAYER_INVESTIGATION_MINIMUM_CONTROL_GAMES) {
    throw new Error(`样本不足：至少保留 ${PLAYER_INVESTIGATION_MINIMUM_CONTROL_GAMES} 局未勾选的合格对照局，当前只有 ${control.length} 局`);
  }

  const args = ["select-groups", "--run-dir", runDir, "--control-unselected"];
  reported.forEach((gameId) => args.push("--reported-game-id", gameId));
  const job = startPlayerInvestigationProcess(runId, runDir, "analysis", args);
  job.account = normalizeWhitespace((progress && progress.account) || catalog.account);
  return {
    ...playerInvestigationStatus(runId, false),
    reportedGameCount: reported.length,
    controlGameCount: control.length,
  };
}

function waitForPlayerInvestigation(runId) {
  const id = String(runId || "").trim();
  const job = playerInvestigationJobs.get(id);
  if (!job) throw new Error(`找不到正在运行的选手调查任务：${id}`);
  if (!job.running) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    job.child.once("close", finish);
    job.child.once("error", finish);
  });
}

async function runBatchSentinelPlayer(player) {
  let runId = "";
  try {
    const acquisition = startPlayerInvestigation({ account: player.account });
    runId = acquisition.runId;
    await waitForPlayerInvestigation(runId);
    const acquired = playerInvestigationStatus(runId, false);
    if (acquired.exitCode !== 0 || acquired.progress?.stages?.fetch_games?.status !== "completed") {
      throw new Error(acquired.error || "全部五分钟对局拉取失败");
    }

    const started = startPlayerSentinelInvestigation({ runId });
    runId = started.runId;
    await waitForPlayerInvestigation(runId);
    const completed = playerInvestigationStatus(runId, false);
    if (completed.exitCode !== 0 || !completed.report || completed.report.status !== "completed") {
      throw new Error(completed.error || "哨兵分析未生成完整报告");
    }
    return { runId, summary: completed.report };
  } catch (error) {
    error.runId = runId;
    throw error;
  }
}

const investigationBatchManager = new InvestigationBatchManager({
  root: PLAYER_INVESTIGATION_BATCH_ROOT,
  runPlayer: runBatchSentinelPlayer,
});

function startBatchSentinelInvestigation(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  if ([...playerInvestigationJobs.values()].some((job) => job.running)) {
    throw new Error("当前已有选手调查正在运行，请等待完成后再启动多人哨兵分析");
  }
  const tournament = readArchivedTournament(input.tournamentFile);
  if (!tournament.available) throw new Error(tournament.reason || "该比赛没有正式总排名");
  const requested = Array.isArray(input.players) ? input.players : [];
  if (!requested.length) throw new Error("请至少选择一名选手");
  const standingsByRank = new Map(tournament.players.map((player) => [Number(player.rank), player]));
  const players = requested.map((item) => {
    const rank = Number(item && item.rank);
    const official = standingsByRank.get(rank);
    if (!official) throw new Error(`比赛正式总排名中找不到第 ${rank || "—"} 名`);
    if (!official.selectable) throw new Error(`第 ${rank} 名${official.reason ? `：${official.reason}` : "不可调查"}`);
    if (normalizeWhitespace(item && item.account).toLowerCase() !== official.account.toLowerCase()) {
      throw new Error(`第 ${rank} 名的 OQ 账号与比赛存档不一致`);
    }
    return { rank, name: official.name, account: official.account };
  });
  return investigationBatchManager.start({
    tournamentFile: tournament.file,
    competitionName: tournament.competitionName,
    players,
  });
}

function batchSentinelStatus(batchId) {
  return investigationBatchManager.status(batchId);
}

function repairBatchSentinelResult(batchId, runId) {
  const id = safeBatchId(batchId);
  const runDir = resolvePlayerInvestigationRun(runId);
  const summary = investigationReportSummary(runDir);
  if (!summary || summary.status !== "completed") {
    throw new Error("单人调查尚未生成完整报告，不能修复批量历史记录");
  }
  const repairedAt = new Date().toISOString();
  let repaired = false;
  for (const filename of ["progress.json", "report.json"]) {
    const file = path.join(PLAYER_INVESTIGATION_BATCH_ROOT, id, filename);
    if (!fs.existsSync(file)) continue;
    const batch = readInvestigationJson(file, "多人哨兵分析历史记录");
    const expectedSchema = filename === "report.json"
      ? "papp-batch-sentinel-report-v1"
      : "papp-batch-sentinel-progress-v1";
    if (batch.schema !== expectedSchema || batch.batchId !== id) {
      throw new Error(`多人哨兵分析历史记录契约不匹配：${file}`);
    }
    const results = Array.isArray(batch.results) ? batch.results : [];
    const index = results.findIndex((result) => normalizeWhitespace(result && result.runId) === runId);
    if (index < 0) throw new Error(`批量历史记录中找不到单人运行：${runId}`);
    const previous = results[index];
    results[index] = {
      rank: previous.rank,
      name: previous.name,
      account: previous.account,
      status: "completed",
      runId,
      summary,
      repair: {
        repairedAt,
        previousStatus: normalizeWhitespace(previous.status),
        previousError: normalizeWhitespace(previous.error),
      },
    };
    batch.completedCount = results.filter((result) => result.status === "completed").length;
    batch.failedCount = results.filter((result) => result.status === "failed").length;
    batch.repairedAt = repairedAt;
    const temporary = `${file}.${process.pid}.repair.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(batch, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
    repaired = true;
  }
  if (!repaired) throw new Error(`找不到批量哨兵历史记录：${id}`);
  return batchSentinelStatus(id);
}

function profileNumber(value, field, integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`OQ 账号画像字段 ${field} 无效`);
  }
  return integer ? Math.trunc(number) : number;
}

async function enrichOqValidationProfiles(result, payload) {
  if (!result || result.ok !== true || !Array.isArray(result.results)) return result;

  const input = payload && typeof payload === "object" ? payload : {};
  const requestedMode = normalizeWhitespace(input.mode).toLowerCase();
  if (requestedMode && requestedMode !== "5min") return result;

  const candidates = result.results.filter(
    (item) => item && item.ok === true && item.status === "ok" && normalizeWhitespace(item.account),
  );
  if (!candidates.length) return result;

  let cursor = 0;
  const workerCount = Math.min(
    8,
    candidates.length,
    Math.max(1, Math.trunc(Number(result.concurrency) || 1)),
  );
  const profileTimeoutMs = Math.max(
    10000,
    Math.min(30000, Math.trunc(Number(input.timeout) || 20) * 1000),
  );

  const worker = async () => {
    while (cursor < candidates.length) {
      const item = candidates[cursor++];
      try {
        const payload = await runPlayerProfileHelper(item.account, profileTimeoutMs);
        const profile = payload && payload.profile && typeof payload.profile === "object"
          ? payload.profile
          : null;
        if (!profile) throw new Error("画像响应缺少 profile");
        const win = profileNumber(profile.win, "win", true);
        const loss = profileNumber(profile.loss, "loss", true);
        const draw = profileNumber(profile.draw, "draw", true);
        const played = profileNumber(profile.played, "played", true);
        if (played !== win + loss + draw) {
          throw new Error("画像总局数与胜负和不一致");
        }
        Object.assign(item, {
          profileStatus: "ok",
          profileError: "",
          profileId: normalizeWhitespace(profile.id || profile.name || item.account),
          rating: profileNumber(profile.rating, "rating"),
          high: profileNumber(profile.high, "high"),
          hiddenR: profileNumber(profile.hiddenR, "hiddenR"),
          played,
          n: played,
          win,
          loss,
          draw,
        });
      } catch (error) {
        Object.assign(item, {
          profileStatus: "error",
          profileError: normalizeWhitespace(error && error.message ? error.message : error),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  result.byAccount = Object.fromEntries(
    result.results.map((item) => [String(item.account || "").toLowerCase(), item]),
  );
  return result;
}

function objectPayload(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function payloadRound(value) {
  const round = Number(value && value.round);
  return Number.isFinite(round) && round > 0 ? Math.trunc(round) : 1;
}

function payloadPairings(value) {
  const input = objectPayload(value);
  const roundData = objectPayload(input.roundData);
  if (Array.isArray(roundData.pairings)) return roundData.pairings;
  return Array.isArray(input.pairings) ? input.pairings : [];
}

function pendingLocalOq(pairing, reason) {
  const item = objectPayload(pairing);
  return {
    pairingId: normalizeWhitespace(item.id || item.pairingId),
    pendingTable: Number.isFinite(Number(item.table))
      ? Math.trunc(Number(item.table))
      : normalizeWhitespace(item.table),
    black: normalizeWhitespace(item.black || item.blackName),
    white: normalizeWhitespace(item.white || item.whiteName),
    blackAccount: normalizeWhitespace(item.blackAccount),
    whiteAccount: normalizeWhitespace(item.whiteAccount),
    oqGameId: normalizeWhitespace(item.oqGameId || item.gameId),
    pendingKind: "oq-auto",
    reason: normalizeWhitespace(reason) || "OQ 尚未返回稳定结果",
  };
}

function readUtf8Json(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) throw new Error(`本地结果文件为空：${file}`);
  return JSON.parse(raw);
}

function selectOqRoundPayload(source, round) {
  const input = objectPayload(source);
  if (input.rounds && typeof input.rounds === "object") {
    if (Array.isArray(input.rounds)) {
      return input.rounds.find((item) => payloadRound(item) === round) || null;
    }
    return input.rounds[String(round)] || input.rounds[round] || null;
  }
  if (input.round !== undefined && payloadRound(input) !== round) return null;
  return input;
}

function oqAccountKey(value) {
  return normalizeWhitespace(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function oqAccountsForPairings(pairings) {
  const accounts = new Map();
  for (const pairing of pairings) {
    const item = objectPayload(pairing);
    if (normalizeWhitespace(item.status).toLowerCase() === "bye") continue;
    for (const value of [item.blackAccount || item.blackOqAccount, item.whiteAccount || item.whiteOqAccount]) {
      const account = normalizeWhitespace(value);
      const key = oqAccountKey(account);
      if (account && key && !accounts.has(key)) accounts.set(key, account);
    }
  }
  return [...accounts.values()];
}

function oqGameArray(value) {
  if (Array.isArray(value)) return value;
  const games = objectPayload(value).games;
  return Array.isArray(games) ? games : [];
}

function oqGameId(game) {
  const item = objectPayload(game);
  return normalizeWhitespace(item.id ?? item.gameId ?? item.game_id);
}

function cloneOqGamesByAccount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return JSON.parse(JSON.stringify(value));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const rows = Array.isArray(items) ? items : [];
  const results = new Array(rows.length);
  let nextIndex = 0;
  const workerCount = Math.min(rows.length, Math.max(1, Math.trunc(Number(concurrency) || 1)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < rows.length) {
      const index = nextIndex++;
      results[index] = await mapper(rows[index], index);
    }
  }));
  return results;
}

async function fetchOqJson(url, options) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 20000);
  const fetchImpl = options.fetchImpl;
  if (typeof fetchImpl !== "function") throw new Error("Node fetch API is unavailable for OQ polling");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { "User-Agent": OQ_USER_AGENT },
      signal: controller.signal,
    });
    if (!response || response.ok === false) {
      const status = response && Number.isFinite(Number(response.status))
        ? `HTTP ${response.status}`
        : "HTTP error";
      throw new Error(`OQ 请求失败（${status}）`);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`OQ 请求超时（${timeoutMs} ms）`);
    }
    throw new Error(normalizeWhitespace(error && error.message) || "OQ 请求失败");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOqGamesForAccounts(accounts, options) {
  const baseUrl = String(options.baseUrl || "http://questgames.net").replace(/\/+$/, "");
  const mode = OQ_MODE_ENDPOINTS[options.mode] ? options.mode : "5min";
  const endpoint = OQ_MODE_ENDPOINTS[mode];
  const errors = {};
  const gamesByAccount = {};
  const results = await mapWithConcurrency(accounts, options.concurrency, async (account) => {
    const accountText = normalizeWhitespace(account).toLowerCase();
    const url = `${baseUrl}/games/${endpoint}/${encodeURIComponent(accountText)}.json`;
    try {
      const payload = await fetchOqJson(url, options);
      const games = Array.isArray(payload) ? payload : objectPayload(payload).games;
      return { account, games: Array.isArray(games) ? games.filter((game) => game && typeof game === "object") : [] };
    } catch (error) {
      return { account, games: [], error: normalizeWhitespace(error && error.message) || "OQ 账号对局查询失败" };
    }
  });
  for (const result of results) {
    const key = oqAccountKey(result.account);
    gamesByAccount[key] = result.games;
    if (result.error) errors[result.account] = result.error;
  }
  return { gamesByAccount, errors };
}

async function fetchOqGameDetail(gameId, options) {
  const baseUrl = String(options.baseUrl || "http://questgames.net").replace(/\/+$/, "");
  const id = normalizeWhitespace(gameId);
  if (!id) throw new Error("OQ game id is empty");
  const payload = await fetchOqJson(
    `${baseUrl}/game/${encodeURIComponent(id)}.json`,
    options,
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.error) {
    throw new Error(normalizeWhitespace(payload && payload.error) || "OQ game detail not found");
  }
  return payload;
}

function uniqueOqDetailRequests(requests) {
  const byId = new Map();
  for (const request of Array.isArray(requests) ? requests : []) {
    const item = objectPayload(request);
    const gameId = normalizeWhitespace(item.gameId || item.id);
    if (gameId && !byId.has(gameId)) byId.set(gameId, { ...item, gameId });
  }
  return [...byId.values()];
}

function attachOqDetails(gamesByAccount, detailResults) {
  const details = new Map(detailResults.map((result) => [result.gameId, result]));
  for (const rawGames of Object.values(gamesByAccount || {})) {
    for (const game of oqGameArray(rawGames)) {
      const result = details.get(oqGameId(game));
      if (!result) continue;
      if (result.detail) {
        game.detail = result.detail;
        if (!game.finalStatus && result.detail.finalStatus) game.finalStatus = result.detail.finalStatus;
        if (!game.status && result.detail.status) game.status = result.detail.status;
        if (!game.created && (result.detail.created || result.detail.createdAt)) {
          game.created = result.detail.created || result.detail.createdAt;
        }
      } else {
        game.detailFetchError = result.error;
      }
    }
  }
}

function pappTournamentWorkfile(payload) {
  const operation = normalizeWhitespace(payload && payload.operation);
  if (operation !== "write-score-batch" && operation !== "read-score-batch") {
    return null;
  }

  const workfileId = normalizeWhitespace(payload && payload.pappWorkfileId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workfileId)) {
    throw Object.assign(
      new Error("比分批次缺少有效的比赛 workfile ID，请刷新页面后重试"),
      { code: "invalid-papp-workfile-id", statusCode: 400 },
    );
  }

  const configuredDirectory = normalizeWhitespace(
    process.env[PAPP_TOURNAMENT_WORKFILES_ENV],
  );
  const configuredWorkfile = normalizeWhitespace(
    process.env.PAPP_TOURNAMENT_WORKFILE,
  );
  const directory = configuredDirectory
    ? path.resolve(PROJECT_ROOT, configuredDirectory)
    : configuredWorkfile
      ? path.dirname(path.resolve(PROJECT_ROOT, configuredWorkfile))
      : path.join(DATA_DIR, "papp-tournament-workfiles");
  const filename = path.join(directory, `papp-${workfileId}.txt`);
  fs.mkdirSync(directory, { recursive: true });
  return path.relative(PROJECT_ROOT, filename) || path.basename(filename);
}

function invokePappC(payload) {
  const workfile = pappTournamentWorkfile(payload);
  const childPayload = { ...objectPayload(payload) };
  delete childPayload.pappWorkfileId;
  return new Promise((resolve, reject) => {
    const child = spawn(PAPP_C_EXECUTABLE, ["--tournament-json"], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: workfile
        ? { ...process.env, PAPP_TOURNAMENT_WORKFILE: workfile }
        : process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      reject(Object.assign(new Error(`无法启动本地 PAPP C：${error.message}`), {
        code: error.code || "papp-c-unavailable",
      }));
    });
    child.on("close", (exitCode) => {
      let result;
      try {
        result = stdout.trim() ? JSON.parse(stdout) : null;
      } catch (_) {
        reject(new Error("PAPP C 返回了无效 JSON" + (stderr.trim() ? `：${stderr.trim()}` : "")));
        return;
      }
      if (!result || typeof result !== "object") {
        reject(new Error(`PAPP C 未返回结果${exitCode === null ? "" : `（退出码 ${exitCode}）`}`));
        return;
      }
      if (exitCode !== 0 && result.ok !== false) {
        reject(new Error(`PAPP C 异常退出（退出码 ${exitCode}）${stderr.trim() ? `：${stderr.trim()}` : ""}`));
        return;
      }
      resolve(result);
    });
    child.stdin.end(JSON.stringify(childPayload), "utf8");
  });
}

function oqStageName(value) {
  const stage = normalizeWhitespace(value).toLowerCase();
  return stage || "preliminary";
}

function oqPairingId(pairing) {
  const item = objectPayload(pairing);
  return normalizeWhitespace(item.id || item.pairingId || item.sourceLocalId);
}

function isOqBye(pairing) {
  const item = objectPayload(pairing);
  return normalizeWhitespace(item.status).toLowerCase() === "bye" ||
    normalizeWhitespace(item.white || item.whiteName).toLowerCase() === "bye" ||
    objectPayload(item.metadata).bye === true;
}

function isLegacyOqPairing(pairing) {
  const item = objectPayload(pairing);
  const metadata = objectPayload(item.metadata);
  const source = normalizeWhitespace(item.source || metadata.source || objectPayload(metadata.papp).source).toLowerCase();
  return source === "papp-adapter" || source === "papp-local" ||
    source === "papp-local-playoff";
}

function hasOqTranscript(pairing) {
  const record = EgAnalysis.storedTranscriptRecord(pairing);
  return Boolean(record && record.moves.some((move) => /^[a-h][1-8]$/i.test(move)));
}

function oqTranscriptMatchesCurrentMapping(pairing) {
  const item = objectPayload(pairing);
  const record = EgAnalysis.storedTranscriptRecord(item);
  const blackAccount = normalizeWhitespace(item.blackAccount || item.blackOqAccount);
  const whiteAccount = normalizeWhitespace(item.whiteAccount || item.whiteOqAccount);
  return Boolean(record && record.pappBlackAccount && record.pappWhiteAccount &&
    oqAccountKey(record.pappBlackAccount) === oqAccountKey(blackAccount) &&
    oqAccountKey(record.pappWhiteAccount) === oqAccountKey(whiteAccount));
}

function clonePairingForTranscriptPull(pairing, options = {}) {
  const item = JSON.parse(JSON.stringify(objectPayload(pairing)));
  const metadata = objectPayload(item.metadata);
  const gameRecord = objectPayload(metadata.gameRecord || metadata.oqRecord);
  const audit = objectPayload(item.oqAutoAudit);
  const auditGame = objectPayload(audit.game || objectPayload(item.oqGameAvailableAudit).game);
  const knownGameId = normalizeWhitespace(
    item.oqGameId || item.gameId || gameRecord.gameId || auditGame.gameId || auditGame.id,
  );
  if (knownGameId || options.clearTranscript === true) {
    delete metadata.gameRecord;
    delete metadata.oqRecord;
    delete metadata.oqDetail;
    delete metadata.transcript;
    delete metadata.moves;
    delete metadata.board;
  }
  item.metadata = metadata;
  delete item.oqGameId;
  delete item.gameId;
  delete item.oqAutoAudit;
  delete item.oqGameAvailableAudit;
  delete item.oqGameAvailable;
  if (options.historical === true) {
    item.status = "imported";
    item.lastEditedBy = "";
    item.userEditedFields = {};
    item.userPending = false;
    ["blackScore", "whiteScore", "reporter", "opponent", "resultKind",
      "resultSource", "sourceMessageKey", "resultText", "reason", "completedAt",
      "updatedAt", "pappReadbackAt", "oqUpdatedAt"].forEach((key) => delete item[key]);
  } else if (item.lastEditedBy === "script" &&
      (item.resultKind === "oq-auto" || item.resultSource === "oq-auto") &&
      !item.pappReadbackAt) {
    item.status = "imported";
    ["blackScore", "whiteScore", "reporter", "opponent", "resultKind",
      "resultSource", "sourceMessageKey", "resultText", "reason", "completedAt",
      "updatedAt", "pappReadbackAt", "oqUpdatedAt"].forEach((key) => delete item[key]);
  }
  return item;
}

function oqRoundGroups(payload) {
  const input = objectPayload(payload);
  const round = payloadRound(input);
  const stage = oqStageName(input.stage || objectPayload(input.roundData).stage);
  const raw = Array.isArray(input.egRounds) ? input.egRounds : [];
  const groups = raw.map((entry) => {
    const item = objectPayload(entry);
    const roundData = objectPayload(item.roundData);
    const pairings = Array.isArray(item.pairings)
      ? item.pairings
      : Array.isArray(roundData.pairings) ? roundData.pairings : [];
    return {
      round: payloadRound(item),
      stage: oqStageName(item.stage),
      roundData: { ...roundData },
      pairings: pairings.map((pairing) => JSON.parse(JSON.stringify(objectPayload(pairing)))),
    };
  });
  let current = groups.find((group) => group.round === round && group.stage === stage);
  if (!current) {
    current = {
      round,
      stage,
      roundData: { ...objectPayload(input.roundData) },
      pairings: payloadPairings(input).map((pairing) =>
        JSON.parse(JSON.stringify(objectPayload(pairing)))),
    };
    groups.push(current);
  } else {
    current.roundData = { ...current.roundData, ...objectPayload(input.roundData) };
    current.pairings = payloadPairings(input).map((pairing) =>
      JSON.parse(JSON.stringify(objectPayload(pairing))));
  }
  return { groups, current };
}

function mappedPairingAccountUpdates(groups) {
  const updates = [];
  for (const group of groups) {
    for (const pairing of group.pairings) {
      if (isOqBye(pairing)) continue;
      updates.push({
        round: group.round,
        stage: group.stage,
        pairingId: oqPairingId(pairing),
        blackAccount: normalizeWhitespace(pairing.blackAccount || pairing.blackOqAccount),
        whiteAccount: normalizeWhitespace(pairing.whiteAccount || pairing.whiteOqAccount),
      });
    }
  }
  return updates;
}

function pgnFileToken(value) {
  return normalizeWhitespace(value)
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 72) || "unknown";
}

function oqPgnPath(record, options) {
  const gameId = normalizeWhitespace(record.gameId || record.oqGameId ||
    objectPayload(record.gameRecord).gameId);
  const directory = options.pgnDirectory || (options.dataDir
    ? path.join(options.dataDir, "ega-analysis", "pgns")
    : EG_PGN_DIR);
  return path.join(
    directory,
    "r" + record.round + "_" + pgnFileToken(record.stage) +
      "_t" + pgnFileToken(record.table) + "_" + pgnFileToken(gameId) + ".pgn",
  );
}

function oqTranscriptOutput(row, group, options) {
  const item = objectPayload(row);
  const audit = objectPayload(item.oqAutoAudit);
  const availableAudit = objectPayload(item.oqGameAvailableAudit);
  const game = objectPayload(audit.game || availableAudit.game);
  const detail = objectPayload(game.detail || game.gameDetail);
  const position = objectPayload(detail.position);
  const moves = EgAnalysis.splitTranscript(position.moves || detail.moves);
  if (!moves.some((move) => /^[a-h][1-8]$/i.test(move))) return null;
  const pairingId = oqPairingId(item);
  const pairing = group.pairings.find((entry) => oqPairingId(entry) === pairingId);
  if (!pairing) return null;
  const table = normalizeWhitespace(item.table || pairing.table);
  const gameId = normalizeWhitespace(item.oqGameId || game.gameId || game.id);
  if (!gameId) return null;
  const pappBlackAccount = normalizeWhitespace(
    audit.pappBlackAccount || availableAudit.pappBlackAccount ||
    pairing.blackAccount || pairing.blackOqAccount,
  );
  const pappWhiteAccount = normalizeWhitespace(
    audit.pappWhiteAccount || availableAudit.pappWhiteAccount ||
    pairing.whiteAccount || pairing.whiteOqAccount,
  );
  const record = {
    round: group.round,
    stage: group.stage,
    table,
    pairingId,
    gameId,
    createdAt: normalizeWhitespace(game.createdAt || game.createdLocal || game.created),
    actualBlackAccount: normalizeWhitespace(game.blackName || game.blackAccount),
    actualWhiteAccount: normalizeWhitespace(game.whiteName || game.whiteAccount),
    pappBlackAccount,
    pappWhiteAccount,
    blackAccount: pappBlackAccount,
    whiteAccount: pappWhiteAccount,
    moves,
    transcript: moves.join(""),
    board: EgAnalysis.normalizeBoard(
      game.startBoard || position.startPos || position.startBoard || detail.startBoard,
    ),
    side: normalizeWhitespace(position.sideToMove || detail.sideToMove || "X"),
  };
  const filename = oqPgnPath(record, options);
  const pgnFile = path.relative(PROJECT_ROOT, filename).split(path.sep).join("/");
  const gameRecord = {
    source: "oq-poll",
    gameId,
    createdAt: record.createdAt,
    actualBlackAccount: record.actualBlackAccount,
    actualWhiteAccount: record.actualWhiteAccount,
    pappBlackAccount,
    pappWhiteAccount,
    blackAccount: record.actualBlackAccount,
    whiteAccount: record.actualWhiteAccount,
    moves,
    transcript: record.transcript,
    board: record.board,
    sideToMove: record.side,
    pgnFile,
  };
  return {
    round: group.round,
    stage: group.stage,
    table,
    pairingId,
    oqGameId: gameId,
    gameRecord,
  };
}

function newOqTranscriptRecords(results, options = {}) {
  const records = [];
  const seen = new Set();
  for (const entry of results) {
    const group = entry.group;
    const result = entry.result;
    for (const row of [
      ...(Array.isArray(result.ready) ? result.ready : []),
      ...(Array.isArray(result.gameAvailable) ? result.gameAvailable : []),
    ]) {
      const record = oqTranscriptOutput(row, group, options);
      if (!record) continue;
      const key = [record.round, record.stage, record.pairingId, record.oqGameId].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const pairing = group.pairings.find((entry) => oqPairingId(entry) === record.pairingId);
      const previous = pairing ? EgAnalysis.storedTranscriptRecord(pairing) : null;
      const previousMatches = previous &&
        normalizeWhitespace(previous.gameId) === record.oqGameId &&
        previous.transcript === record.gameRecord.transcript &&
        oqAccountKey(previous.pappBlackAccount || previous.blackAccount) ===
          oqAccountKey(record.gameRecord.pappBlackAccount) &&
        oqAccountKey(previous.pappWhiteAccount || previous.whiteAccount) ===
          oqAccountKey(record.gameRecord.pappWhiteAccount);
      if (previousMatches) continue;
      const filename = oqPgnPath(record, options);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, EgAnalysis.formatOqPgn({
        ...record.gameRecord,
        round: record.round,
        table: record.table,
        gameId: record.oqGameId,
      }), "utf8");
      records.push(record);
    }
  }
  return records;
}

async function pollLocalOqRound(payload, options = {}) {
  const input = objectPayload(payload);
  const round = payloadRound(input);
  const stage = oqStageName(input.stage || objectPayload(input.roundData).stage);
  const currentPairings = payloadPairings(input);
  if (!input.egRounds && currentPairings.length && currentPairings.every(isLegacyOqPairing)) {
    return {
      ok: true,
      source: "legacy-history",
      readOnly: true,
      round,
      ready: [],
      pending: [],
      skipped: [],
      gameAvailable: [],
    };
  }

  const { groups, current } = oqRoundGroups(input);
  const queryGroups = [];
  for (const group of groups) {
    const isCurrent = group === current;
    const pairings = [];
    for (const pairing of group.pairings) {
      if (isLegacyOqPairing(pairing) || isOqBye(pairing)) continue;
      const hasTranscript = hasOqTranscript(pairing);
      const mappingMatches = oqTranscriptMatchesCurrentMapping(pairing);
      if (!isCurrent && hasTranscript && mappingMatches) continue;
      pairings.push(!hasTranscript || !mappingMatches
        ? clonePairingForTranscriptPull(pairing, {
            historical: !isCurrent,
            clearTranscript: hasTranscript && !mappingMatches,
          })
        : pairing);
    }
    if (isCurrent || pairings.length) {
      queryGroups.push({ group, isCurrent, pairings });
    }
  }

  if (!queryGroups.some((entry) => entry.pairings.length)) {
    return {
      ok: true,
      source: "papp-c",
      round,
      ready: [],
      pending: [],
      skipped: [],
      gameAvailable: [],
    };
  }

  const pollOptions = {
    baseUrl: options.baseUrl || process.env.PAPP_OQ_BASE_URL || "http://questgames.net",
    timeoutMs: options.timeoutMs || process.env.PAPP_OQ_TIMEOUT_MS || 20000,
    concurrency: options.concurrency || process.env.PAPP_OQ_CONCURRENCY || 8,
    fetchImpl: options.fetchImpl || globalThis.fetch,
  };
  const embeddedMetadata = objectPayload(objectPayload(input.roundData).metadata);
  let source = input.oqPollResult || embeddedMetadata.oqPollResult || null;
  if (!source && OQ_RESULTS_FILE && fs.existsSync(OQ_RESULTS_FILE)) {
    source = readUtf8Json(OQ_RESULTS_FILE);
  }
  const allPairings = queryGroups.flatMap((entry) => entry.pairings);
  const liveAcquisition = source ? null : await fetchOqGamesForAccounts(
    oqAccountsForPairings(allPairings),
    { ...pollOptions, mode: normalizeWhitespace(input.oqMode || embeddedMetadata.oqMode ||
      process.env.PAPP_OQ_MODE || "5min").toLowerCase() },
  );
  const runPappC = options.invokePappC || invokePappC;
  const prepared = [];
  const queryErrors = { ...objectPayload(liveAcquisition && liveAcquisition.errors) };

  for (const entry of queryGroups) {
    const group = entry.group;
    const roundData = entry.isCurrent
      ? { ...group.roundData, pairings: entry.pairings }
      : {
          roundStartAt: group.roundData.roundStartAt,
          roundEndAt: group.roundData.roundEndAt,
          windowMinutes: group.roundData.windowMinutes,
          pairings: entry.pairings,
        };
    const selected = source ? selectOqRoundPayload(source, group.round) : null;
    if (selected && selected.ok === false) {
      if (entry.isCurrent) {
        return {
          ok: false,
          code: selected.code || "oq-source-failed",
          message: normalizeWhitespace(selected.message || selected.error) || "本地 OQ 结果源返回失败",
        };
      }
      queryErrors[group.stage + "-" + group.round] =
        normalizeWhitespace(selected.message || selected.error) || "历史轮次 OQ 结果源返回失败";
      continue;
    }
    const roundStartAt = selected && selected.roundStartAt ||
      (entry.isCurrent && input.roundStartAt) || group.roundData.roundStartAt;
    if (!normalizeWhitespace(roundStartAt)) {
      const message = "缺少本轮开始时间，未查询此轮 OQ 对局";
      if (entry.isCurrent && entry.pairings.length) {
        return { ok: false, code: "round-start-missing", message: "OQ 查询需要本轮开始时间" };
      }
      queryErrors[group.stage + "-" + group.round] = message;
      continue;
    }
    const selectedGames = source
      ? cloneOqGamesByAccount(selected && selected.gamesByAccount)
      : liveAcquisition.gamesByAccount;
    const groupErrors = source
      ? selected && (selected.queryErrors || selected.errors)
      : liveAcquisition.errors;
    const cPayload = {
      operation: "oq-poll",
      round: group.round,
      roundStartAt,
      roundEndAt: selected && selected.roundEndAt ||
        (entry.isCurrent && input.roundEndAt) || group.roundData.roundEndAt,
      windowMinutes: selected && selected.windowMinutes ||
        (entry.isCurrent && input.windowMinutes) || group.roundData.windowMinutes,
      window: selected && selected.window || (entry.isCurrent && input.window),
      roundData,
      pairings: entry.pairings,
      gamesByAccount: selectedGames,
      queryErrors: groupErrors,
    };
    const firstPass = await runPappC(cPayload);
    if (!firstPass || firstPass.ok === false) {
      if (entry.isCurrent) return firstPass;
      queryErrors[group.stage + "-" + group.round] =
        normalizeWhitespace(firstPass && firstPass.message) || "历史轮次 PAPP C OQ 查询失败";
      continue;
    }
    if (!Array.isArray(firstPass.detailRequests)) {
      throw new Error("本地 PAPP C 未提供 OQ detail 补抓清单，请重新构建 PAPP C");
    }
    prepared.push({ ...entry, cPayload, gamesByAccount: selectedGames, firstPass });
  }

  const detailRequests = uniqueOqDetailRequests(
    prepared.flatMap((entry) => entry.firstPass.detailRequests),
  );
  const detailResults = detailRequests.length
    ? await mapWithConcurrency(
        detailRequests,
        pollOptions.concurrency,
        async (request) => {
          try {
            return {
              gameId: request.gameId,
              detail: await fetchOqGameDetail(request.gameId, pollOptions),
            };
          } catch (error) {
            return {
              gameId: request.gameId,
              error: normalizeWhitespace(error && error.message) || "读取 OQ detail 失败",
            };
          }
        },
      )
    : [];
  for (const entry of prepared) {
    attachOqDetails(entry.gamesByAccount, detailResults);
  }

  const finalResults = [];
  for (const entry of prepared) {
    const result = detailResults.length
      ? await runPappC(entry.cPayload)
      : entry.firstPass;
    if (!result || result.ok === false) {
      if (entry.isCurrent) return result;
      queryErrors[entry.group.stage + "-" + entry.group.round] =
        normalizeWhitespace(result && result.message) || "历史轮次 PAPP C OQ 复算失败";
      continue;
    }
    finalResults.push({ group: entry.group, isCurrent: entry.isCurrent, result });
    Object.assign(queryErrors, objectPayload(result.queryErrors));
  }

  const active = finalResults.find((entry) => entry.isCurrent);
  const currentResult = active
    ? active.result
    : { ok: true, source: "papp-c", round, ready: [], pending: [], skipped: [], gameAvailable: [] };
  const transcriptResults = finalResults.map((entry) => ({
    group: { ...entry.group, pairings: entry.group.pairings },
    result: entry.result,
  }));
  const oqGameRecords = newOqTranscriptRecords(transcriptResults, {
    dataDir: options.dataDir,
    pgnDirectory: options.pgnDirectory,
  });
  return {
    ...currentResult,
    ok: currentResult.ok !== false,
    source: "papp-c",
    round,
    stage,
    queryErrors,
    pairingAccountUpdates: mappedPairingAccountUpdates(groups),
    oqGameRecords,
    historicalTranscriptCount: oqGameRecords.filter((record) =>
      record.round !== round || record.stage !== stage).length,
  };
}

function egEngineInfo() {
  return {
    name: "Egaroucid for Console",
    path: EG_ENGINE,
    level: 22,
    threads: 32,
    hash: 26,
    book: "enabled-default",
  };
}

function egRecords(payload) {
  const records = EgAnalysis.collectEgRecords(payload);
  return records.filter((record) =>
    Array.isArray(record.moves) && record.moves.some((move) => /^[a-h][1-8]$/i.test(move)),
  );
}

function egRecordMap(records) {
  const unique = new Map();
  for (const record of records) {
    unique.set(EgAnalysis.analysisRecordKey(record), record);
  }
  return unique;
}

function cachedEgAnalyses(records) {
  const analyses = new Map();
  for (const record of records) {
    const cached = EgAnalysis.readCachedGameAnalysis(EG_ANALYSIS_DIR, record);
    if (cached) analyses.set(EgAnalysis.analysisRecordKey(record), cached);
  }
  return analyses;
}

function latestEgAnalysisTime(analyses) {
  return Array.from(analyses.values())
    .map((analysis) => normalizeWhitespace(analysis.analyzedAt))
    .filter(Boolean)
    .sort()
    .pop() || "";
}

function summarizeEgJob(job, options = {}) {
  const records = job ? job.records : options.records;
  const analyses = job ? job.analyses : options.analyses;
  if (!Array.isArray(records) || !analyses || !analyses.size) return null;
  return EgAnalysis.summarizeGames(records, analyses, {
    summaryFile: path.relative(PROJECT_ROOT, path.join(EG_ANALYSIS_DIR, "summary.json")).split(path.sep).join("/"),
    engine: egEngineInfo(),
    updatedAt: latestEgAnalysisTime(analyses),
  });
}

function saveEgSummary(analysis) {
  if (!analysis) return;
  fs.mkdirSync(EG_ANALYSIS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EG_ANALYSIS_DIR, "summary.json"),
    JSON.stringify(analysis, null, 2) + "\n",
    "utf8",
  );
}

class LocalEgaroucidEngine {
  constructor() {
    this.child = null;
    this.buffer = "";
    this.waiter = null;
    this.closed = null;
    this.outputLimitBytes = 8 * 1024 * 1024;
  }

  async start() {
    // Egaroucid writes result rows to stdout and prompts to stderr. Merge the
    // OS handles before reading so a prompt cannot overtake its result rows.
    const command = `""${EG_ENGINE}" -q -noboard -l 22 -t 32 -hash 26 -noautocacheclear 2>&1"`;
    this.child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      cwd: EG_ENGINE_DIR,
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.acceptOutput(chunk));
    this.child.stderr.on("data", (chunk) => this.acceptOutput(chunk));
    this.child.on("error", (error) => this.failWaiter(
      new Error("Egaroucid 进程错误：" + normalizeWhitespace(error && error.message)),
    ));
    this.child.on("close", (code, signal) => {
      this.closed = { code, signal };
      this.failWaiter(new Error("Egaroucid 输出流已关闭"));
    });
    await this.waitForPrompt(30000);
  }

  acceptOutput(chunk) {
    this.buffer += String(chunk || "");
    if (Buffer.byteLength(this.buffer, "utf8") > this.outputLimitBytes) {
      this.failWaiter(new Error("Egaroucid 单次分析输出超过 8MB"));
      this.kill();
      return;
    }
    if (!this.waiter) return;
    const output = this.takePrompt();
    if (output === null) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(output);
  }

  takePrompt() {
    const match = this.buffer.match(/(?:^|\r?\n)>\s/);
    if (!match) return null;
    const output = this.buffer.slice(0, match.index);
    this.buffer = this.buffer.slice(match.index + match[0].length);
    return output;
  }

  waitForPrompt(timeoutMs) {
    const output = this.takePrompt();
    if (output !== null) return Promise.resolve(output);
    if (this.closed) return Promise.reject(new Error("Egaroucid 已退出"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        if (this.waiter !== waiter) return;
        this.waiter = null;
        reject(new Error("等待 Egaroucid 命令提示符超时"));
      }, timeoutMs);
      this.waiter = waiter;
    });
  }

  failWaiter(error) {
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  async command(text, timeoutMs = 120000) {
    if (!this.child || this.closed) throw new Error("Egaroucid 尚未运行");
    const command = String(text || "").trim();
    await new Promise((resolve, reject) => {
      this.child.stdin.write(command + "\n", "utf8", (error) => error ? reject(error) : resolve());
    });
    return this.waitForPrompt(timeoutMs);
  }

  async setboard(board) {
    await this.command("setboard " + board);
  }

  async play(move) {
    await this.command("play " + move);
  }

  async hint() {
    return EgAnalysis.parseHintOutput(await this.command("hint 1"));
  }

  close() {
    if (!this.child || this.closed) return;
    try {
      if (this.child.stdin && !this.child.stdin.destroyed) this.child.stdin.write("exit\n", "utf8");
    } catch (_) {}
    const timer = setTimeout(() => {
      if (!this.closed) this.kill();
    }, 5000);
    if (timer.unref) timer.unref();
  }

  kill() {
    if (this.child && this.child.pid && !this.closed) {
      // The command shell owns the engine; stopping only the shell leaves it running.
      spawn("taskkill.exe", ["/PID", String(this.child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
  }
}

function updateEgJobSummary(job) {
  job.analysis = summarizeEgJob(job);
  if (job.analysis) saveEgSummary(job.analysis);
}

async function runEgAnalysisJob(job) {
  let engine = null;
  try {
    const needsAnalysis = job.records.some((record) =>
      !job.analyses.has(EgAnalysis.analysisRecordKey(record)),
    );
    if (needsAnalysis) {
      engine = new LocalEgaroucidEngine();
      job.engineSession = engine;
      await engine.start();
    }
    while (!job.stopRequested && job.nextRecordIndex < job.records.length) {
      const record = job.records[job.nextRecordIndex++];
      const key = EgAnalysis.analysisRecordKey(record);
      if (job.analyses.has(key)) continue;
      const cached = EgAnalysis.readCachedGameAnalysis(EG_ANALYSIS_DIR, record);
      if (cached) {
        job.analyses.set(key, cached);
        updateEgJobSummary(job);
        continue;
      }
      job.currentGame = {
        round: record.round,
        stage: record.stage,
        table: record.table,
        gameId: record.gameId,
      };
      const analysis = await EgAnalysis.analyzeOqRecord(record, engine);
      EgAnalysis.writeCachedGameAnalysis(EG_ANALYSIS_DIR, record, analysis);
      job.analyses.set(key, analysis);
      job.completedRecords += 1;
      job.currentGame = null;
      updateEgJobSummary(job);
    }
  } catch (error) {
    if (!job.stopRequested) {
      job.error = normalizeWhitespace(error && error.message) || "Egaroucid 分析失败";
    }
  } finally {
    if (engine) engine.close();
    job.engineSession = null;
    job.running = false;
    job.pending = false;
    job.finishedAt = new Date().toISOString();
    if (!job.error) updateEgJobSummary(job);
  }
}

function egStatus(payload) {
  const currentRecords = egRecordMap(egRecords(payload));
  let job = egAnalysisJob;
  if (job && job.running) {
    for (const [key, record] of currentRecords) {
      if (!job.recordKeys.has(key)) {
        job.recordKeys.add(key);
        job.records.push(record);
        job.recordsTotal = job.records.length;
      }
    }
    updateEgJobSummary(job);
  } else if (currentRecords.size) {
    const records = Array.from(currentRecords.values());
    const analyses = cachedEgAnalyses(records);
    const cachedSummary = summarizeEgJob(null, { records, analyses });
    if (cachedSummary && (!job || !job.analysis ||
        JSON.stringify(cachedSummary) !== JSON.stringify(job.analysis))) {
      job = {
        running: false,
        pending: false,
        round: Math.max(0, ...records.map((record) => Number(record.round) || 0)),
        recordsTotal: records.length,
        completedRecords: analyses.size,
        startedAt: "",
        finishedAt: cachedSummary.updatedAt,
        error: "",
        analysis: cachedSummary,
      };
      egAnalysisJob = job;
      saveEgSummary(cachedSummary);
    }
  }
  const analysis = job && job.analysis ||
    (currentRecords.size ? summarizeEgJob(null, {
      records: Array.from(currentRecords.values()),
      analyses: cachedEgAnalyses(Array.from(currentRecords.values())),
    }) : null);
  return {
    ok: true,
    running: Boolean(job && job.running),
    pending: Boolean(job && job.pending),
    status: job && job.running ? "running" : "idle",
    round: job && job.round || 0,
    recordsTotal: job && job.recordsTotal || currentRecords.size,
    completedRecords: job && job.completedRecords || 0,
    currentGame: job && job.currentGame || null,
    startedAt: job && job.startedAt || "",
    finishedAt: job && job.finishedAt || "",
    error: job && job.error || "",
    analysis,
  };
}

function startEgAnalysis(payload) {
  const records = Array.from(egRecordMap(egRecords(payload)).values());
  if (!records.length) {
    return {
      ok: false,
      code: "eg-record-missing",
      message: "预赛和淘汰赛中没有可供 Egaroucid 分析的 OQ 棋谱",
    };
  }
  if (egAnalysisJob && egAnalysisJob.running) {
    for (const record of records) {
      const key = EgAnalysis.analysisRecordKey(record);
      if (!egAnalysisJob.recordKeys.has(key)) {
        egAnalysisJob.recordKeys.add(key);
        egAnalysisJob.records.push(record);
      }
    }
    egAnalysisJob.recordsTotal = egAnalysisJob.records.length;
    return egStatus(payload);
  }
  const analyses = cachedEgAnalyses(records);
  const uncached = records.some((record) =>
    !analyses.has(EgAnalysis.analysisRecordKey(record)),
  );
  if (uncached && !fs.existsSync(EG_ENGINE)) {
    return {
      ok: false,
      code: "eg-engine-missing",
      message: "找不到本地 Egaroucid 引擎：" + EG_ENGINE,
    };
  }
  const job = {
    running: uncached,
    pending: uncached,
    stopRequested: false,
    round: Math.max(0, ...records.map((record) => Number(record.round) || 0)),
    recordsTotal: records.length,
    completedRecords: 0,
    startedAt: uncached ? new Date().toISOString() : "",
    finishedAt: uncached ? "" : latestEgAnalysisTime(analyses),
    error: "",
    currentGame: null,
    records,
    recordKeys: new Set(records.map((record) => EgAnalysis.analysisRecordKey(record))),
    analyses,
    nextRecordIndex: 0,
    engineSession: null,
    analysis: summarizeEgJob(null, { records, analyses }),
  };
  egAnalysisJob = job;
  if (job.analysis) saveEgSummary(job.analysis);
  if (uncached) {
    setImmediate(() => { void runEgAnalysisJob(job); });
  }
  return egStatus(payload);
}

function stopEgAnalysis() {
  const job = egAnalysisJob;
  if (!job || !job.running) return egStatus();
  job.stopRequested = true;
  if (job.engineSession) job.engineSession.kill();
  job.running = false;
  job.pending = false;
  job.finishedAt = new Date().toISOString();
  return egStatus();
}

async function refreshWechatMemberMap(groupName) {
  const targetGroup = normalizeWhitespace(groupName) || defaultWechatGroupName();
  const helperResult = await runMappingHelper(
    ["--group", targetGroup, "refresh-map"],
    "",
    120000,
  );
  const cacheFile = String(helperResult.cachePath || "").trim();
  let refreshed;
  if (cacheFile && fs.existsSync(cacheFile)) {
    const payload = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    refreshed = {
      ...normalizeWechatMemberMapPayload(payload),
      groupName: payload.group_name || helperResult.groupName || targetGroup,
      cacheFile,
    };
  } else {
    refreshed = readWechatMemberMap(helperResult.groupName || targetGroup);
  }
  return {
    ...refreshed,
    refresh: {
      ok: true,
      cachePath: cacheFile || refreshed.cacheFile || "",
      refreshedAt: helperResult.refreshedAt || refreshed.refreshedAt || "",
    },
  };
}

async function listWechatGroups(query) {
  const args = ["list-groups"];
  const text = normalizeWhitespace(query);
  if (text) args.push("--query", text);
  return runMappingHelper(args, "", 60000);
}

async function readWechatChatMessages(
  group,
  limit = 200,
  offset = 0,
  startTime = null,
  endTime = null,
  relayOnly = false,
) {
  const target = normalizeWhitespace(group);
  if (!target) throw new Error("请先选择比赛群聊");
  const safeLimit = Math.max(1, Math.min(2000, Math.trunc(Number(limit) || 200)));
  const maxOffset = relayOnly ? 1_000_000 : 10_000;
  const safeOffset = Math.max(0, Math.min(maxOffset, Math.trunc(Number(offset) || 0)));
  const normalizeTimestamp = (value, label) => {
    if (value === null || value === undefined || value === "") return null;
    const timestamp = Number(value);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error(`${label}必须是非负整数秒时间戳`);
    }
    return timestamp;
  };
  const safeStartTime = normalizeTimestamp(startTime, "startTime");
  const safeEndTime = normalizeTimestamp(endTime, "endTime");
  if (safeStartTime !== null && safeEndTime !== null && safeStartTime > safeEndTime) {
    throw new Error("startTime 不能晚于 endTime");
  }
  const args = [
    "--group",
    target,
    "recent-chat-messages",
    "--limit",
    String(safeLimit),
    "--offset",
    String(safeOffset),
  ];
  if (safeStartTime !== null) args.push("--start-time", String(safeStartTime));
  if (safeEndTime !== null) args.push("--end-time", String(safeEndTime));
  if (relayOnly) args.push("--relay-only");
  return runMappingHelper(args, "", 60000);
}

function resolveConfiguredLocalPath(value, fallback, baseDir) {
  const raw = String(value || fallback || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(baseDir, raw);
}

function readWechatDecryptStatus() {
  const configuredAppDir = String(process.env.WECHAT_DECRYPT_APP_DIR || "").trim();
  const appDir = configuredAppDir
    ? path.resolve(configuredAppDir)
    : WECHAT_DIR;
  const configFile = path.join(appDir, "config.json");
  const configExists = fs.existsSync(configFile);
  let config = {};
  let configValid = true;

  if (configExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        configValid = false;
      } else {
        config = parsed;
      }
    } catch (_) {
      configValid = false;
    }
  }

  const decryptedDir = resolveConfiguredLocalPath(
    process.env.PAPP_WECHAT_DECRYPTED_DIR || config.decrypted_dir,
    "decrypted",
    appDir,
  );
  const dbDirValue = String(config.db_dir || "").trim();
  const dbDir = resolveConfiguredLocalPath(dbDirValue, "", appDir);
  const keysFile = resolveConfiguredLocalPath(config.keys_file, "all_keys.json", appDir);
  const explicitContactDb = String(
    process.env.PAPP_WECHAT_CONTACT_DB || process.env.WECHAT_CONTACT_DB || "",
  ).trim();
  const contactDb = explicitContactDb
    ? resolveConfiguredLocalPath(explicitContactDb, "", process.cwd())
    : path.join(decryptedDir, "contact", "contact.db");
  const messageDir = path.join(decryptedDir, "message");
  let messageDbCount = 0;
  try {
    messageDbCount = fs
      .readdirSync(messageDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".db"))
      .length;
  } catch (_) {
    messageDbCount = 0;
  }

  const contactDbExists = fs.existsSync(contactDb);
  return {
    ok: true,
    platform: process.platform,
    configExists,
    configValid: configExists ? configValid : null,
    dbDirConfigured: Boolean(dbDirValue),
    dbDirExists: Boolean(dbDir && fs.existsSync(dbDir)),
    keysFileExists: fs.existsSync(keysFile),
    decryptedDirExists: Boolean(decryptedDir && fs.existsSync(decryptedDir)),
    contactDbExists,
    messageDbCount,
    contactReady: contactDbExists,
    chatReady: contactDbExists && messageDbCount > 0,
  };
}

async function validateOqAccounts(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  if (!Array.isArray(input.accounts)) {
    throw new Error("校验请求必须包含 accounts 数组");
  }
  const result = await runMappingHelper(
    ["validate-oq-accounts"],
    JSON.stringify(input),
    180000,
  );
  return enrichOqValidationProfiles(result, input);
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendError(res, status, message, detail) {
  sendJson(res, status, {
    ok: false,
    error: String(message || "Request failed"),
    ...(detail ? { detail: String(detail) } : {}),
  });
}

function validateState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("state must be a JSON object");
  }
  if (Number(state.version) !== 2) {
    throw new Error("state.version must be 2");
  }
  if (!["schedule", "import", "checkin", "score-helper", "final-registration"].includes(state.step)) {
    throw new Error('state.step must be "schedule", "import", "checkin", "score-helper", or "final-registration"');
  }
  if (!Array.isArray(state.players)) {
    throw new Error("state.players must be an array");
  }
  if (Object.prototype.hasOwnProperty.call(state, "pappPlayers")) {
    validatePappPlayers(state.pappPlayers);
  }
}

function readStateFile() {
  if (!fs.existsSync(STATE_FILE)) {
    return { state: null, mtimeMs: 0 };
  }

  const stat = fs.statSync(STATE_FILE);
  const raw = fs.readFileSync(STATE_FILE, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) {
    return { state: null, mtimeMs: stat.mtimeMs };
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${STATE_FILE}: ${error.message}`);
  }
  validateState(state);
  revision = Math.max(
    revision,
    Number(state.localSync && state.localSync.revision) || 0,
  );
  const source = normalizeWriteSource(state.localSync && state.localSync.source);
  if (isHumanWriteSource(source)) {
    lastHumanWriteAt = Math.max(lastHumanWriteAt, stateSavedAt(state, stat.mtimeMs));
  }
  return { state, mtimeMs: stat.mtimeMs };
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of Array.from(clients)) {
    try {
      res.write(data);
    } catch (_) {
      clients.delete(res);
    }
  }
}

function persistState(input, source) {
  validateState(input);
  ensureStateDir();

  const now = Date.now();
  const writeSource = normalizeWriteSource(source);
  const nextRevision = revision + 1;
  const state = {
    ...input,
    savedAt: now,
    localSync: {
      ...(input.localSync && typeof input.localSync === "object"
        ? input.localSync
        : {}),
      revision: nextRevision,
      source: writeSource,
      savedAt: now,
    },
  };
  const tempFile = `${STATE_FILE}.${process.pid}.${now}.tmp`;

  fs.writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, STATE_FILE);

  const stat = fs.statSync(STATE_FILE);
  revision = nextRevision;
  lastMtimeMs = stat.mtimeMs;
  if (isHumanWriteSource(writeSource)) {
    lastHumanWriteAt = now;
    schedulePendingScriptWrite();
    scheduleApWrite();
  }
  broadcast({
    type: "state",
    revision,
    mtimeMs: lastMtimeMs,
    source: writeSource,
  });
  return { state, mtimeMs: lastMtimeMs };
}

function validateCandidatePlayers(candidatePlayers) {
  if (!Array.isArray(candidatePlayers)) {
    throw new Error("candidatePlayers must be an array");
  }
  candidatePlayers.forEach((player, index) => {
    if (!player || typeof player !== "object" || Array.isArray(player)) {
      throw new Error(`candidatePlayers[${index}] must be an object`);
    }
    if (typeof player.checkedIn !== "boolean") {
      throw new Error(`candidatePlayers[${index}].checkedIn must be a boolean`);
    }
  });
}

function pappPlayerId(player) {
  return String(player && player.id != null ? player.id : "").trim();
}

function validatePappPlayers(pappPlayers) {
  if (!Array.isArray(pappPlayers)) {
    throw new Error("state.pappPlayers must be an array");
  }
  const ids = new Set();
  pappPlayers.forEach((player, index) => {
    if (!player || typeof player !== "object" || Array.isArray(player)) {
      throw new Error(`state.pappPlayers[${index}] must be an object`);
    }
    const id = pappPlayerId(player);
    if (!id || ids.has(id)) {
      throw new Error(`state.pappPlayers[${index}].id must be a unique stable id`);
    }
    ids.add(id);
  });
}

function normalizeMappingPlayers(mappingPlayers, candidatePlayers) {
  if (mappingPlayers === undefined) return [];
  if (!Array.isArray(mappingPlayers)) {
    throw new Error("mappingPlayers must be an array");
  }

  const candidateIdCounts = new Map();
  candidatePlayers.forEach((player) => {
    const id = pappPlayerId(player);
    if (id) candidateIdCounts.set(id, (candidateIdCounts.get(id) || 0) + 1);
  });

  const mappingRowIds = new Set();
  const candidateIds = new Set();
  return mappingPlayers.map((mapping, index) => {
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new Error(`mappingPlayers[${index}] must be an object`);
    }
    if (typeof mapping.mappingRowId !== "string" || !mapping.mappingRowId.trim()) {
      throw new Error(`mappingPlayers[${index}].mappingRowId must be a non-empty string`);
    }
    if (typeof mapping.candidatePlayerId !== "string" || !mapping.candidatePlayerId.trim()) {
      throw new Error(`mappingPlayers[${index}].candidatePlayerId must be a non-empty string`);
    }
    if (typeof mapping.name !== "string" || typeof mapping.country !== "string") {
      throw new Error(`mappingPlayers[${index}].name and country must be strings`);
    }

    const mappingRowId = mapping.mappingRowId.trim();
    const candidatePlayerId = mapping.candidatePlayerId.trim();
    if (mappingRowIds.has(mappingRowId)) {
      throw new Error(`mappingPlayers contains duplicate mappingRowId ${mappingRowId}`);
    }
    if (candidateIds.has(candidatePlayerId)) {
      throw new Error(`mappingPlayers contains more than one row for candidate ${candidatePlayerId}`);
    }
    if (candidateIdCounts.get(candidatePlayerId) !== 1) {
      throw new Error(`mappingPlayers candidate ${candidatePlayerId} must match exactly one candidatePlayer`);
    }

    mappingRowIds.add(mappingRowId);
    candidateIds.add(candidatePlayerId);
    return {
      mappingRowId,
      candidatePlayerId,
      name: mapping.name,
      country: mapping.country,
    };
  });
}

function candidatePlayersEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((player, index) => candidatePlayersEqual(player, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && candidatePlayersEqual(left[key], right[key]),
  );
}

function candidateSyncState(currentState, candidatePlayers, mappingPlayers) {
  const nextPappPlayers = [];
  const pappPlayersById = new Map();

  const addExistingPappPlayer = (player) => {
    const id = pappPlayerId(player);
    const record = JSON.parse(JSON.stringify(player));
    pappPlayersById.set(id, record);
    nextPappPlayers.push(record);
  };
  const addCandidateIfMissing = (player) => {
    const id = pappPlayerId(player);
    if (!id || pappPlayersById.has(id)) return;
    const record = JSON.parse(JSON.stringify(player));
    pappPlayersById.set(id, record);
    nextPappPlayers.push(record);
  };

  const existingPappPlayers = Array.isArray(currentState.pappPlayers)
    ? currentState.pappPlayers
    : [];
  existingPappPlayers.forEach(addExistingPappPlayer);
  currentState.players.forEach(addCandidateIfMissing);
  candidatePlayers.forEach(addCandidateIfMissing);

  mappingPlayers.forEach((mapping) => {
    const record = pappPlayersById.get(mapping.candidatePlayerId);
    record.name = mapping.name;
    record.country = mapping.country;
  });

  const nextState = { ...currentState, players: candidatePlayers };
  if (existingPappPlayers.length || nextPappPlayers.length) {
    nextState.pappPlayers = nextPappPlayers;
  }
  const changed = !candidatePlayersEqual(currentState.players, candidatePlayers) ||
    (Object.prototype.hasOwnProperty.call(currentState, "pappPlayers")
      ? !candidatePlayersEqual(currentState.pappPlayers, nextPappPlayers)
      : nextPappPlayers.length > 0);
  return { nextState, changed };
}

function persistCandidatePlayers(candidatePlayers, mappingPlayers, source) {
  validateCandidatePlayers(candidatePlayers);
  const normalizedMappingPlayers = normalizeMappingPlayers(mappingPlayers, candidatePlayers);
  const current = readStateFile();
  if (!current.state) {
    throw new Error("shared state must be initialized before candidate synchronization");
  }
  const sync = candidateSyncState(current.state, candidatePlayers, normalizedMappingPlayers);
  if (!sync.changed) {
    return { state: current.state, mtimeMs: current.mtimeMs, changed: false };
  }
  const written = persistState(sync.nextState, source);
  return { ...written, changed: true };
}

function requestCandidatePlayersWrite(candidatePlayers, mappingPlayers, source) {
  validateCandidatePlayers(candidatePlayers);
  const normalizedMappingPlayers = normalizeMappingPlayers(mappingPlayers, candidatePlayers);
  const writeSource = normalizeWriteSource(source);
  const current = readStateFile();
  if (!current.state) {
    throw new Error("shared state must be initialized before candidate synchronization");
  }
  const sync = candidateSyncState(current.state, candidatePlayers, normalizedMappingPlayers);

  if (isHumanWriteSource(writeSource)) {
    if (!sync.changed) {
      return {
        queued: false,
        changed: false,
        written: { state: current.state, mtimeMs: current.mtimeMs },
      };
    }
    return {
      queued: false,
      changed: true,
      written: persistState(sync.nextState, writeSource),
    };
  }

  if (scriptWriteWaitMs() > 0) {
    if (sync.changed || pendingScriptWrite) {
      pendingScriptWrite = {
        kind: "candidate-roster",
        candidatePlayers,
        mappingPlayers: normalizedMappingPlayers,
        source: writeSource,
      };
      schedulePendingScriptWrite();
      return {
        queued: true,
        retryAfterMs: scriptWriteWaitMs(),
      };
    }
    return {
      queued: false,
      changed: false,
      written: { state: current.state, mtimeMs: current.mtimeMs },
    };
  }

  pendingScriptWrite = null;
  clearPendingScriptWriteTimer();
  if (!sync.changed) {
    return {
      queued: false,
      changed: false,
      written: { state: current.state, mtimeMs: current.mtimeMs },
    };
  }
  return {
    queued: false,
    changed: true,
    written: persistState(sync.nextState, writeSource),
  };
}

function preservePappPlayersFromLatestState(input) {
  const current = readStateFile();
  if (!current.state) return input;
  const next = { ...input };
  if (Array.isArray(current.state.pappPlayers)) next.pappPlayers = current.state.pappPlayers;
  // AP control is owned by the service; browser snapshots can be stale.
  if (current.state.ap) next.ap = current.state.ap;
  else delete next.ap;
  return next;
}

function enqueueScriptWrite(input, source) {
  validateState(input);
  pendingScriptWrite = {
    input,
    source: normalizeWriteSource(source),
  };
  schedulePendingScriptWrite();
  return {
    queued: true,
    retryAfterMs: scriptWriteWaitMs(),
  };
}

function flushPendingScriptWrite() {
  pendingScriptWriteTimer = null;
  if (!pendingScriptWrite) return;

  const waitMs = scriptWriteWaitMs();
  if (waitMs > 0) {
    schedulePendingScriptWrite();
    return;
  }

  const pending = pendingScriptWrite;
  try {
    if (pending.kind === "candidate-roster") {
      persistCandidatePlayers(
        pending.candidatePlayers,
        pending.mappingPlayers,
        pending.source,
      );
    } else {
      persistState(preservePappPlayersFromLatestState(pending.input), pending.source);
    }
    if (pendingScriptWrite === pending) pendingScriptWrite = null;
  } catch (error) {
    console.error("[papp] pending script state write failed:", error);
    pendingScriptWrite = pending;
    pendingScriptWriteTimer = setTimeout(
      flushPendingScriptWrite,
      SCRIPT_RETRY_ERROR_MS,
    );
  }
}

function requestStateWrite(input, source) {
  const writeSource = normalizeWriteSource(source);
  validateState(input);

  if (isHumanWriteSource(writeSource)) {
    return {
      queued: false,
      written: persistState(preservePappPlayersFromLatestState(input), writeSource),
    };
  }

  if (scriptWriteWaitMs() > 0) {
    return enqueueScriptWrite(input, writeSource);
  }

  pendingScriptWrite = null;
  clearPendingScriptWriteTimer();
  return {
    queued: false,
    written: persistState(preservePappPlayersFromLatestState(input), writeSource),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body exceeds 8MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function watchStateFile() {
  ensureStateDir();
  if (fs.existsSync(STATE_FILE)) {
    lastMtimeMs = fs.statSync(STATE_FILE).mtimeMs;
  }

  stateWatcher = fs.watch(STATE_DIR, { persistent: false }, (eventType, filename) => {
    if (String(filename || "") !== STATE_BASENAME) return;

    try {
      const stat = fs.existsSync(STATE_FILE) ? fs.statSync(STATE_FILE) : null;
      const mtimeMs = stat ? stat.mtimeMs : 0;
      if (mtimeMs === lastMtimeMs) return;
      lastMtimeMs = mtimeMs;
      revision += 1;
      broadcast({
        type: "state",
        revision,
        mtimeMs,
        source: "file-watch",
        eventType,
      });
    } catch (error) {
      revision += 1;
      broadcast({
        type: "error",
        revision,
        error: String(error && error.message ? error.message : error),
      });
    }
  });
}

function serveStatic(req, res, pathname) {
  let cleanPath;
  try {
    cleanPath = decodeURIComponent(pathname);
  } catch (error) {
    sendError(res, 400, "Invalid URL path", error.message);
    return;
  }

  const relative = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const target = path.resolve(STATIC_ROOT, relative);
  if (target !== STATIC_ROOT && !target.startsWith(`${STATIC_ROOT}${path.sep}`)) {
    sendError(res, 403, "Forbidden path");
    return;
  }

  if (sea.isSea()) {
    let assetRelative = path.relative(STATIC_ROOT, target).split(path.sep).join("/");
    let assetKey = `${SEA_WEB_ASSET_PREFIX}${assetRelative}`;
    if (!SEA_WEB_ASSET_KEYS.has(assetKey)) {
      const indexKey = `${assetKey.replace(/\/+$/, "")}/index.html`;
      if (!SEA_WEB_ASSET_KEYS.has(indexKey)) {
        sendError(res, 404, "Not found");
        return;
      }
      assetKey = indexKey;
    }

    const ext = path.extname(assetKey).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control":
        ext === ".html" || ext === ".js" || ext === ".css"
          ? "no-cache"
          : "public, max-age=3600",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(Buffer.from(sea.getAsset(assetKey)));
    return;
  }

  let file = target;
  try {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      file = path.join(file, "index.html");
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      sendError(res, 404, "Not found");
      return;
    }

    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control":
        ext === ".html" || ext === ".js" || ext === ".css"
          ? "no-cache"
          : "public, max-age=3600",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    sendError(res, 500, "Failed to serve file", error.message);
  }
}

function listArchivedTournaments() {
  return TournamentHistory.listTournaments(MANUAL_TOURNAMENT_ARCHIVES_DIR);
}

function readArchivedTournament(file) {
  return TournamentHistory.readTournament(MANUAL_TOURNAMENT_ARCHIVES_DIR, file);
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      service: SERVICE,
      version: SERVICE_VERSION,
      host: HOST,
      port: PORT,
      stateFile: STATE_FILE,
      revision,
      now: Date.now(),
    });
    return true;
  }

  if (pathname === "/api/ap/status" && req.method === "GET") {
    sendJson(res, 200, await apCoordinator.status());
    return true;
  }
  if (pathname === "/api/ap/control" && req.method === "POST") {
    try {
      const payload = JSON.parse(await readBody(req));
      sendJson(res, 200, await apCoordinator.control(payload.action));
    } catch (error) { sendError(res, 400, "AP 操作失败", error.message); }
    return true;
  }

  if (pathname === "/api/papp/archive" && req.method === "POST") {
    try {
      const payload = JSON.parse(await readBody(req));
      const result = await TournamentArchive.createArchive(payload.state, {
        directory: path.join(PROJECT_ROOT, "manual-tournament-archives"),
        request: async (url, body) => {
          if (url !== "/api/papp/tournament") throw new Error("存档请求了未知接口");
          return invokePappC(body);
        },
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, 400, "比赛存档失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/player-investigation/tournaments" && req.method === "GET") {
    try {
      sendJson(res, 200, { ok: true, tournaments: listArchivedTournaments() });
    } catch (error) {
      sendError(res, 500, "读取往期比赛列表失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/player-investigation/tournaments/detail" && req.method === "GET") {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
      const file = url.searchParams.get("file") || "";
      sendJson(res, 200, { ok: true, tournament: readArchivedTournament(file) });
    } catch (error) {
      sendError(res, Number(error && error.statusCode) || 400, "读取往期比赛失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/player-investigation/history" && req.method === "GET") {
    try {
      sendJson(res, 200, { ok: true, reports: listPlayerInvestigationHistory() });
    } catch (error) {
      sendError(res, 500, "读取历史分析报告失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/papp/tournament" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, await invokePappC(payload));
    } catch (error) {
      sendJson(res, Number(error && error.statusCode) || 503, {
        ok: false,
        source: "papp-c",
        code: error.code || "papp-c-unavailable",
        message: normalizeWhitespace(error && error.message) || "PAPP C 调用失败",
      });
    }
    return true;
  }

  if (pathname === "/api/papp/oq/poll" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, await pollLocalOqRound(payload));
    } catch (error) {
      sendError(res, 400, "读取本地 OQ 结果失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/papp/eg/status" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, egStatus(payload));
    } catch (error) {
      sendError(res, 400, "读取本地 EG 分析状态失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/papp/eg/start" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, startEgAnalysis(payload));
    } catch (error) {
      sendError(res, 400, "启动本地 EG 分析失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/papp/eg/stop" && req.method === "POST") {
    sendJson(res, 200, stopEgAnalysis());
    return true;
  }

  if (pathname === "/api/state" && req.method === "GET") {
    try {
      const current = readStateFile();
      sendJson(res, 200, {
        ok: true,
        revision,
        mtimeMs: current.mtimeMs,
        scriptWritePending: Boolean(pendingScriptWrite),
        retryAfterMs: pendingScriptWrite ? scriptWriteWaitMs() : 0,
        state: current.state,
      });
    } catch (error) {
      sendError(res, 500, "Failed to read shared state", error.message);
    }
    return true;
  }

  if (pathname === "/api/state" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("request body must be a JSON object");
      }
      if (payload.operation === "ap-patch") {
        const result = requestApWrite(payload.baseState, payload.state, payload.source);
        sendJson(res, result.queued ? 202 : 200, result);
        return true;
      }
      if (payload.operation === "sync-candidates") {
        const writeResult = requestCandidatePlayersWrite(
          payload.candidatePlayers,
          payload.mappingPlayers,
          payload.source,
        );
        if (writeResult.queued) {
          sendJson(res, 202, {
            ok: true,
            changed: false,
            queued: true,
            revision,
            retryAfterMs: writeResult.retryAfterMs,
          });
          return true;
        }
        sendJson(res, 200, {
          ok: true,
          changed: writeResult.changed,
          revision,
          mtimeMs: writeResult.written.mtimeMs,
          state: writeResult.written.state,
        });
        return true;
      }
      if (!payload.state || typeof payload.state !== "object" || Array.isArray(payload.state)) {
        throw new Error("request body must include state");
      }

      const writeResult = requestStateWrite(payload.state, payload.source);
      if (writeResult.queued) {
        sendJson(res, 202, {
          ok: true,
          changed: false,
          queued: true,
          revision,
          retryAfterMs: writeResult.retryAfterMs,
        });
        return true;
      }
      const written = writeResult.written;
      sendJson(res, 200, {
        ok: true,
        changed: true,
        revision,
        mtimeMs: written.mtimeMs,
        state: written.state,
      });
    } catch (error) {
      sendError(res, 400, "Failed to write shared state", error.message);
    }
    return true;
  }

  if (pathname === "/api/wechat-groups" && req.method === "GET") {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
      sendJson(res, 200, await listWechatGroups(url.searchParams.get("q") || ""));
    } catch (error) {
      sendError(res, 400, "读取微信群列表失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/wechat-chat-messages" && req.method === "GET") {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
      const limit = Number.parseInt(url.searchParams.get("limit") || "200", 10);
      const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
      const startTime = url.searchParams.get("startTime");
      const endTime = url.searchParams.get("endTime");
      const relayOnly = url.searchParams.get("relayOnly") === "true";
      sendJson(
        res,
        200,
        await readWechatChatMessages(
          url.searchParams.get("group") || "",
          Number.isFinite(limit) ? limit : 200,
          Number.isFinite(offset) ? offset : 0,
          startTime,
          endTime,
          relayOnly,
        ),
      );
    } catch (error) {
      sendError(res, 400, "读取微信群聊天记录失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/wechat-decrypt/status" && req.method === "GET") {
    try {
      sendJson(res, 200, readWechatDecryptStatus());
    } catch (error) {
      sendError(res, 500, "读取微信解密状态失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/wechat-member-map" && req.method === "GET") {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
      sendJson(res, 200, readWechatMemberMap(url.searchParams.get("group") || ""));
    } catch (error) {
      sendError(res, Number(error && error.statusCode) || 400, "读取微信群昵称缓存失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/wechat-member-map/refresh" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, await refreshWechatMemberMap(payload && payload.group));
    } catch (error) {
      sendError(res, 400, "刷新微信群昵称失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/oq-accounts/validate" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, await validateOqAccounts(payload));
    } catch (error) {
      sendError(res, 400, "校验 OQ 账号失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/player-profile" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, await queryPlayerProfile(payload));
    } catch (error) {
      sendError(res, 400, "查询 OQ 选手画像失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/player-investigation/start" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, startPlayerInvestigation(payload));
    } catch (error) {
      sendError(res, 400, "启动选手调查对局拉取失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/player-investigation/sentinel" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, startPlayerSentinelInvestigation(payload));
    } catch (error) {
      sendError(res, 400, "启动哨兵监测失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/player-investigation/batch-sentinel" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, startBatchSentinelInvestigation(payload));
    } catch (error) {
      sendError(res, 400, "启动多人哨兵分析失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/player-investigation/batch-status" && req.method === "GET") {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
      sendJson(res, 200, batchSentinelStatus(url.searchParams.get("batchId") || ""));
    } catch (error) {
      sendError(res, 400, "读取多人哨兵分析进度失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/player-investigation/status" && req.method === "GET") {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
      const runId = url.searchParams.get("runId") || "";
      const includeCatalog = url.searchParams.get("includeCatalog") === "1";
      const includeResources = url.searchParams.get("includeResources") === "1";
      const status = playerInvestigationStatus(runId, includeCatalog);
      if (includeResources) status.resources = await readSystemResourceSnapshot();
      sendJson(res, 200, status);
    } catch (error) {
      sendError(res, 400, "读取选手调查进度失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/player-investigation/terminate" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, terminatePlayerInvestigation(payload));
    } catch (error) {
      sendError(res, 400, "终止选手调查任务失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/player-investigation/select" && req.method === "POST") {
    try {
      const raw = await readBody(req);
      const payload = raw.trim() ? JSON.parse(raw) : {};
      sendJson(res, 200, selectPlayerInvestigationGroups(payload));
    } catch (error) {
      sendError(res, 400, "提交举报局和对照局失败", error.message);
    }
    return true;
  }

  if (pathname === "/api/events" && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    res.write(`data: ${JSON.stringify({ type: "hello", revision })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch (error) {
    sendError(res, 400, "Invalid request URL", error.message);
    return;
  }

  try {
    if (url.pathname.startsWith("/api/")) {
      if (await handleApi(req, res, url.pathname)) return;
      sendError(res, 404, "Unknown API endpoint");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendError(res, 405, "Method not allowed");
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendError(res, 500, "Unexpected server error", error.message);
  }
});

function start() {
  ensureStateDir();
  if (fs.existsSync(STATE_FILE)) readStateFile();
  watchStateFile();
  server.listen(PORT, HOST, () => {
    console.log(`[papp] Local frontend: http://${HOST}:${PORT}/`);
    console.log(`[papp] Shared state: ${STATE_FILE}`);
    console.log("[papp] Stop with Ctrl+C.");
    apTimer = setInterval(() => {
      if (!pendingApWrite) apCoordinator.tick().catch(error => console.error("[papp] AP:", error.message));
    }, 500);
    apTimer.unref();
  });
}

function stop() {
  if (apTimer) clearInterval(apTimer);
  if (pendingApWriteTimer) clearTimeout(pendingApWriteTimer);
  if (stateWatcher) stateWatcher.close();
  for (const res of Array.from(clients)) {
    try {
      res.end();
    } catch (_) {
      // The connection may already be closed.
    }
  }
  server.close(() => process.exit(0));
}

if (require.main === module) {
  start();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

module.exports = {
  server,
  start,
  stop,
  validateState,
  readWechatDecryptStatus,
  readStateFile,
  pollLocalOqRound,
  startEgAnalysis,
  stopEgAnalysis,
  egStatus,
  invokePappC,
  persistState,
  requestStateWrite,
  listArchivedTournaments,
  readArchivedTournament,
  startBatchSentinelInvestigation,
  batchSentinelStatus,
  repairBatchSentinelResult,
  listPlayerInvestigationHistory,
  reportedAnalysisSummary,
};
