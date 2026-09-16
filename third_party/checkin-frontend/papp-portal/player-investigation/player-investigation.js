(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const modeGrid = $("#investigation-mode-grid");
  const pastPanel = $("#investigation-past-panel");
  const idPanel = $("#investigation-id-panel");
  const queryForm = $("#investigation-query-form");
  const accountInput = $("#investigation-account-input");
  const queryButton = $("#btn-investigation-query");
  const status = $("#investigation-query-status");
  const profilePanel = $("#investigation-profile");
  const confirmButton = $("#btn-investigation-confirm");
  const gamesPanel = $("#investigation-games");
  const workflowChoices = $("#investigation-workflow-choices");
  const manualEntryButton = $("#btn-investigation-manual");
  const sentinelEntryButton = $("#btn-investigation-sentinel");
  const manualPanel = $("#investigation-manual-panel");
  const backToChoicesButton = $("#btn-investigation-back-to-choices");
  const gamesCount = $("#investigation-games-count");
  const gamesStatus = $("#investigation-games-status");
  const gamesBody = $("#investigation-games-body");
  const selectionCount = $("#investigation-selection-count");
  const clearSelectionButton = $("#btn-investigation-clear-selection");
  const runButton = $("#btn-investigation-run");
  const resultPanel = $("#investigation-result");
  const resultStatus = $("#investigation-result-status");
  const resultDetail = $("#investigation-result-detail");
  const pastRefreshButton = $("#btn-past-refresh");
  const pastStatus = $("#past-investigation-status");
  const pastTournamentList = $("#past-tournament-list");
  const pastTournamentDetail = $("#past-tournament-detail");
  const pastTournamentTitle = $("#past-tournament-title");
  const pastTournamentMeta = $("#past-tournament-meta");
  const pastBackButton = $("#btn-past-back");
  const pastPlayerList = $("#past-player-list");
  const pastPlayerSelectionCount = $("#past-player-selection-count");
  const pastClearSelectionButton = $("#btn-past-clear-selection");
  const pastSentinelButton = $("#btn-past-sentinel");
  const pastReportedButton = $("#btn-past-reported");
  const pastBatchStatus = $("#past-batch-status");
  const pastBatchStatusBadge = $("#past-batch-status-badge");
  const pastBatchStatusDetail = $("#past-batch-status-detail");

  const analysisResourceConfirmation = [
    "运行分析会大量占用 CPU 资源和内存。",
    "请确保机器至少有 8 GB 内存，并在分析期间保持闲置状态。",
    "",
    "确认条件符合并继续吗？",
  ].join("\n");

  const profileFields = {
    id: $("#profile-id"),
    name: $("#profile-name"),
    rating: $("#profile-rating"),
    high: $("#profile-high"),
    played: $("#profile-played"),
    win: $("#profile-win"),
    loss: $("#profile-loss"),
    draw: $("#profile-draw"),
  };

  const stageLabels = {
    fetch_profiles: "拉取画像",
    level22: "Egaroucid Level22 分析",
    offbook_detection: "举报局检测",
    hint_source: "准备估值数据",
    hint1: "评估阶段 1",
    hint6: "评估阶段 6",
    hint_assembly: "汇总估值数据",
    model_materialization: "生成个人模型数据",
    profile_materialization: "生成画像模型数据",
    adapt_models: "适配个人模型",
    evaluate_reported: "计算举报局结果",
    non_model_statistics: "计算非模型统计",
    final_report: "生成最终报告",
  };

  let currentProfile = null;
  let investigationRunId = "";
  let games = [];
  let investigationToken = 0;
  let analysisRunning = false;
  let pastTournamentsLoaded = false;
  let currentTournament = null;
  let pastPlayers = [];
  let pastBatchToken = 0;
  let pendingAcquisitionFlow = "";
  let pastReportedPlayer = null;

  function normalize(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, "");
  }

  function shouldMarkRating(profile) {
    const totalGames =
      Number(profile.win || 0) +
      Number(profile.loss || 0) +
      Number(profile.draw || 0);
    const hiddenR = Number(profile.hiddenR || 0);
    return hiddenR !== 0 || totalGames < 40;
  }

  function formatRating(profile) {
    const rating = formatNumber(profile.rating);
    return shouldMarkRating(profile) ? `${rating}?` : rating;
  }

  function setMode(mode) {
    const current = mode === "past" ? "past" : "id";
    idPanel.classList.remove("investigation-panel--past-games");
    pastReportedPlayer = null;
    modeGrid.querySelectorAll("[data-investigation-mode]").forEach((button) => {
      const selected = button.dataset.investigationMode === current;
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
    pastPanel.hidden = current !== "past";
    idPanel.hidden = current !== "id";
    if (current === "past" && !pastTournamentsLoaded) void loadPastTournaments();
  }

  function setStatus(message, isError = false) {
    status.textContent = normalize(message);
    status.classList.toggle("investigation-query-status--error", isError);
  }

  function setGamesStatus(message, isError = false) {
    gamesStatus.textContent = normalize(message);
    gamesStatus.classList.toggle("investigation-query-status--error", isError);
  }

  function setPastStatus(message, isError = false) {
    pastStatus.textContent = normalize(message);
    pastStatus.classList.toggle("investigation-query-status--error", isError);
  }

  function renderProfile(profile) {
    const data = profile && typeof profile === "object" ? profile : null;
    currentProfile = data;
    profilePanel.classList.toggle("hidden", !data);
    confirmButton.disabled = !data || analysisRunning;
    if (!data) return;
    Object.entries(profileFields).forEach(([key, element]) => {
      if (key === "rating") {
        element.textContent = formatRating(data);
        return;
      }
      element.textContent = key === "high" || key === "played" || key === "win" || key === "loss" || key === "draw"
        ? formatNumber(data[key])
        : normalize(data[key]) || "—";
    });
  }

  function cancelInvestigationWatch() {
    investigationToken += 1;
  }

  function resetInvestigation() {
    cancelInvestigationWatch();
    investigationRunId = "";
    games = [];
    analysisRunning = false;
    pendingAcquisitionFlow = "";
    gamesBody.replaceChildren();
    gamesPanel.classList.add("hidden");
    workflowChoices.classList.add("hidden");
    manualPanel.classList.add("hidden");
    sentinelEntryButton.disabled = false;
    resultPanel.classList.add("hidden");
    setGamesStatus("");
    selectionCount.textContent = "举报局 0 · 对照局 0";
    gamesCount.textContent = "0 局";
    $("#investigation-games-title").textContent = "选择调查流程";
    $("#investigation-games-title").nextElementSibling.textContent = "可以手动设定举报局，也可以自动运行哨兵监测完整流程。";
    backToChoicesButton.textContent = "返回流程选择";
    runButton.disabled = true;
  }

  function formatChinaTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return normalize(value) || "—";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function gameResultClass(result) {
    return ["win", "draw", "loss"].includes(result)
      ? ` investigation-game-result--${result}`
      : "";
  }

  function renderGames(catalog) {
    const rows = catalog && Array.isArray(catalog.games) ? catalog.games : [];
    games = rows.filter((game) => normalize(game && game.gameId));
    gamesBody.replaceChildren();
    games.forEach((game) => {
      const gameId = normalize(game.gameId);
      const opponentAccount = normalize(game.opponentAccount);
      const opponentName = normalize(game.opponentName) || opponentAccount || "—";
      const result = normalize(game.result).toLowerCase();

      const row = document.createElement("tr");
      const selectCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "investigation-game-check";
      checkbox.dataset.gameId = gameId;
      checkbox.setAttribute("aria-label", `将与 ${opponentName} 的对局设为举报局`);
      checkbox.addEventListener("change", updateSelectionSummary);
      selectCell.append(checkbox);

      const opponentCell = document.createElement("td");
      opponentCell.className = "investigation-game-opponent";
      const opponentStrong = document.createElement("strong");
      opponentStrong.textContent = opponentName;
      opponentCell.append(opponentStrong);
      if (opponentAccount && opponentAccount !== opponentName) {
        const accountSmall = document.createElement("small");
        accountSmall.textContent = opponentAccount;
        opponentCell.append(accountSmall);
      }

      const resultCell = document.createElement("td");
      const resultStrong = document.createElement("strong");
      resultStrong.className = `investigation-game-result${gameResultClass(result)}`;
      resultStrong.textContent = ["win", "draw", "loss"].includes(result) ? result : "—";
      resultCell.append(resultStrong);

      const timeCell = document.createElement("td");
      timeCell.className = "investigation-game-time";
      const timeText = document.createElement("span");
      timeText.textContent = formatChinaTime(game.created);
      timeCell.append(timeText);

      row.append(selectCell, opponentCell, resultCell, timeCell);
      gamesBody.append(row);
    });
    gamesCount.textContent = `${games.length} 局`;
    gamesPanel.classList.toggle("hidden", games.length === 0);
    updateSelectionSummary();
  }

  function selectedGameIds() {
    return [...gamesBody.querySelectorAll("input[data-game-id]:checked")]
      .map((input) => normalize(input.dataset.gameId))
      .filter(Boolean);
  }

  function updateSelectionSummary() {
    const reportedCount = selectedGameIds().length;
    const controlCount = Math.max(0, games.length - reportedCount);
    selectionCount.textContent = `举报局 ${reportedCount} · 对照局 ${controlCount}`;
    runButton.disabled = !investigationRunId || analysisRunning || reportedCount === 0 || controlCount === 0;
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || payload.detail || "本地服务返回失败");
    }
    return payload;
  }

  function tournamentFile(item) {
    if (typeof item === "string") return normalize(item);
    return normalize(item && (item.file || item.filename || item.fileName));
  }

  function tournamentLabel(item) {
    if (typeof item === "string") return normalize(item).replace(/\.csv$/i, "");
    return normalize(item && (item.competitionName || item.tournamentName || item.title || item.name))
      || tournamentFile(item).replace(/\.csv$/i, "")
      || "未命名比赛";
  }

  function tournamentAvailability(item) {
    if (typeof item === "string") return { selectable: true, reason: "" };
    const reason = normalize(item && (item.reason || item.unavailableReason || item.detail));
    const flags = [item && item.selectable, item && item.eligible, item && item.available,
      item && item.hasOfficialStandings, item && item.officialFinalStandings];
    const explicit = flags.find((value) => typeof value === "boolean");
    if (typeof explicit === "boolean") {
      return { selectable: explicit, reason: explicit ? "" : reason || "没有已完赛的正式总排名" };
    }
    const state = normalize(item && (item.status || item.state)).toLowerCase();
    if (["incomplete", "provisional", "invalid", "unavailable"].includes(state) || reason) {
      return { selectable: false, reason: reason || "没有已完赛的正式总排名" };
    }
    return { selectable: true, reason: "" };
  }

  function renderTournamentList(items) {
    pastTournamentList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "investigation-note past-tournament-list__empty";
      empty.textContent = "存档目录中暂无比赛 CSV。";
      pastTournamentList.append(empty);
      return;
    }
    items.forEach((item) => {
      const file = tournamentFile(item);
      const availability = tournamentAvailability(item);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "past-tournament-card";
      card.disabled = !file || !availability.selectable;
      const content = document.createElement("span");
      content.className = "past-tournament-card__content";
      const title = document.createElement("strong");
      title.textContent = tournamentLabel(item);
      const filename = document.createElement("small");
      filename.textContent = file || "缺少存档文件名";
      content.append(title, filename);
      const state = document.createElement("span");
      state.className = `past-tournament-card__state${availability.selectable ? "" : " past-tournament-card__state--unavailable"}`;
      state.textContent = availability.selectable ? "选择比赛" : availability.reason;
      card.append(content, state);
      if (file && availability.selectable) {
        card.addEventListener("click", () => void loadTournamentDetail(file));
      }
      pastTournamentList.append(card);
    });
  }

  async function loadPastTournaments() {
    pastRefreshButton.disabled = true;
    pastTournamentsLoaded = false;
    pastTournamentDetail.classList.add("hidden");
    pastTournamentList.classList.remove("hidden");
    pastBatchStatus.classList.add("hidden");
    setPastStatus("正在读取比赛存档…");
    try {
      const payload = await requestJson("/api/player-investigation/tournaments");
      const items = Array.isArray(payload.tournaments) ? payload.tournaments
        : Array.isArray(payload.files) ? payload.files : [];
      renderTournamentList(items);
      pastTournamentsLoaded = true;
      setPastStatus(items.length ? `找到 ${items.length} 份比赛存档。` : "没有找到比赛存档。");
    } catch (error) {
      pastTournamentList.replaceChildren();
      setPastStatus(String(error && error.message ? error.message : error), true);
    } finally {
      pastRefreshButton.disabled = false;
    }
  }

  function normalizedPastPlayers(payload) {
    const tournament = payload.tournament && typeof payload.tournament === "object" ? payload.tournament : {};
    const rows = Array.isArray(payload.standings) ? payload.standings
      : Array.isArray(payload.players) ? payload.players
        : Array.isArray(tournament.standings) ? tournament.standings
          : Array.isArray(tournament.players) ? tournament.players : [];
    return rows.map((row) => ({
      rank: Number(row && (row.rank ?? row.finalRank)),
      name: normalize(row && (row.name || row.displayName || row.playerName)) || "未登记名称",
      account: normalize(row && (row.account || row.oqAccount || row.oqId || row.oqID)),
      selectable: !(row && row.selectable === false),
      reason: normalize(row && row.reason),
    })).filter((player) => Number.isFinite(player.rank) && player.rank > 0)
      .sort((left, right) => left.rank - right.rank);
  }

  function selectedPastPlayers() {
    const selected = new Set([...pastPlayerList.querySelectorAll("input[data-player-index]:checked")]
      .map((input) => Number(input.dataset.playerIndex)));
    return pastPlayers.filter((player, index) => selected.has(index) && player.account && player.selectable);
  }

  function updatePastPlayerSelection() {
    const selected = selectedPastPlayers();
    pastPlayerSelectionCount.textContent = `已选择 ${selected.length} 位选手`;
    pastSentinelButton.disabled = selected.length === 0 || analysisRunning;
    pastReportedButton.disabled = selected.length !== 1 || analysisRunning;
  }

  function renderPastPlayers() {
    pastPlayerList.replaceChildren();
    pastPlayers.forEach((player, index) => {
      const label = document.createElement("label");
      const canSelect = Boolean(player.account) && player.selectable;
      label.className = `past-player-row${canSelect ? "" : " past-player-row--unavailable"}`;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "past-player-check";
      checkbox.dataset.playerIndex = String(index);
      checkbox.disabled = !canSelect;
      checkbox.addEventListener("change", updatePastPlayerSelection);
      const rank = document.createElement("strong");
      rank.className = "past-player-row__rank";
      rank.textContent = String(player.rank);
      const identity = document.createElement("span");
      identity.className = "past-player-row__identity";
      const name = document.createElement("strong");
      name.textContent = player.name;
      const account = document.createElement("small");
      account.textContent = canSelect ? player.account : player.reason || (player.account ? "该选手不可调查" : "缺少 OQ ID，无法调查");
      identity.append(name, account);
      label.append(checkbox, rank, identity);
      pastPlayerList.append(label);
    });
    updatePastPlayerSelection();
  }

  async function loadTournamentDetail(file) {
    setPastStatus("正在读取正式总排名…");
    pastTournamentList.classList.add("hidden");
    try {
      const payload = await requestJson(`/api/player-investigation/tournaments/detail?file=${encodeURIComponent(file)}`);
      const availability = tournamentAvailability(payload.tournament || payload);
      if (!availability.selectable) throw new Error(availability.reason || "该比赛没有已完赛的正式总排名");
      pastPlayers = normalizedPastPlayers(payload);
      if (!pastPlayers.length) throw new Error("该比赛没有可读取的正式总排名");
      currentTournament = {
        file,
        name: tournamentLabel(payload.tournament || { name: payload.name, file }),
      };
      pastTournamentTitle.textContent = currentTournament.name;
      pastTournamentMeta.textContent = `${file} · 共 ${pastPlayers.length} 位选手`;
      renderPastPlayers();
      pastTournamentDetail.classList.remove("hidden");
      pastBatchStatus.classList.add("hidden");
      setPastStatus("请选择需要调查的选手。");
    } catch (error) {
      pastTournamentList.classList.remove("hidden");
      setPastStatus(String(error && error.message ? error.message : error), true);
    }
  }

  function batchProgressText(payload) {
    const progress = payload.progress && typeof payload.progress === "object" ? payload.progress : {};
    const completed = Number(progress.completed ?? payload.completedCount);
    const total = Number(progress.total ?? payload.totalCount);
    const player = normalize(progress.currentPlayer || payload.currentPlayer);
    const counts = Number.isFinite(completed) && Number.isFinite(total) ? `${completed}/${total}` : "";
    return [counts, player ? `正在分析：${player}` : "", normalize(payload.message || progress.message)]
      .filter(Boolean).join(" · ") || "批量任务正在运行…";
  }

  async function watchPastBatch(batchId) {
    const token = ++pastBatchToken;
    while (token === pastBatchToken) {
      try {
        const payload = await requestJson(`/api/player-investigation/batch-status?batchId=${encodeURIComponent(batchId)}`);
        if (token !== pastBatchToken) return;
        const state = normalize(payload.status || (payload.progress && payload.progress.status)).toLowerCase();
        if (state === "completed") {
          analysisRunning = false;
          pastBatchStatusBadge.textContent = "已完成";
          pastBatchStatusDetail.textContent = `全部选手已处理。汇总报告：${normalize(payload.reportPath || (payload.report && payload.report.reportPath)) || "已生成"}`;
          updatePastPlayerSelection();
          setPastStatus("多人哨兵分析已完成。某位选手失败时，其原因已记录在汇总报告中。");
          return;
        }
        if (state === "failed" || state === "terminated") {
          throw new Error(payload.error || payload.message || "多人哨兵分析失败");
        }
        pastBatchStatusBadge.textContent = "运行中";
        pastBatchStatusDetail.textContent = batchProgressText(payload);
      } catch (error) {
        if (token !== pastBatchToken) return;
        analysisRunning = false;
        pastBatchStatusBadge.textContent = "失败";
        pastBatchStatusDetail.textContent = String(error && error.message ? error.message : error);
        updatePastPlayerSelection();
        setPastStatus("无法继续读取多人哨兵任务状态。", true);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  async function startPastSentinel() {
    const players = selectedPastPlayers();
    if (!currentTournament || !players.length || analysisRunning) return;
    if (!window.confirm(analysisResourceConfirmation)) return;
    analysisRunning = true;
    updatePastPlayerSelection();
    pastBatchStatus.classList.remove("hidden");
    pastBatchStatusBadge.textContent = "正在提交";
    pastBatchStatusDetail.textContent = `将按名次依次分析 ${players.length} 位选手。`;
    setPastStatus("正在启动多人哨兵分析…");
    try {
      const payload = await requestJson("/api/player-investigation/batch-sentinel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tournamentFile: currentTournament.file,
          players: players.map(({ rank, name, account }) => ({ rank, name, account })),
        }),
      });
      const batchId = normalize(payload.batchId);
      if (!batchId) throw new Error("本地服务没有返回批量任务 ID");
      pastBatchStatusBadge.textContent = "运行中";
      pastBatchStatusDetail.textContent = `任务 ${batchId} 已启动，正在等待首位选手的进度。`;
      window.location.assign(`./batch-analysis.html?batchId=${encodeURIComponent(batchId)}`);
    } catch (error) {
      analysisRunning = false;
      pastBatchStatusBadge.textContent = "失败";
      pastBatchStatusDetail.textContent = String(error && error.message ? error.message : error);
      updatePastPlayerSelection();
      setPastStatus("启动多人哨兵分析失败。", true);
    }
  }

  async function startPastReported() {
    const selected = selectedPastPlayers();
    if (selected.length !== 1 || analysisRunning) {
      setPastStatus("举报局分析必须且只能选择一位选手。", true);
      return;
    }
    const player = selected[0];
    resetInvestigation();
    pastReportedPlayer = player;
    pendingAcquisitionFlow = "manual";
    currentProfile = { id: player.account, name: player.name };
    accountInput.value = player.account;
    pastPanel.hidden = true;
    idPanel.hidden = false;
    idPanel.classList.add("investigation-panel--past-games");
    gamesPanel.classList.remove("hidden");
    $("#investigation-games-title").textContent = `${player.name} · 选择举报局`;
    $("#investigation-games-title").nextElementSibling.textContent = "仅显示至少完成 16 个坐标落子、已进入 ply 17 的五分钟对局；结束状态不影响准入。勾选为举报局，未勾选为对照局（至少保留 8 局）。";
    backToChoicesButton.textContent = "返回选手选择";
    setGamesStatus("正在拉取五分钟对局并按 16 个实际落子标准筛选…");
    try {
      const payload = await requestJson("/api/player-investigation/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: player.account }),
      });
      investigationRunId = normalize(payload.runId);
      if (!investigationRunId) throw new Error("本地服务没有返回调查运行 ID");
      void watchAcquisition(investigationRunId);
    } catch (error) {
      setGamesStatus(String(error && error.message ? error.message : error), true);
    }
  }

  function progressMessage(payload, fallback) {
    const progress = payload && payload.progress;
    const stage = progress && progress.currentStage;
    const label = stageLabels[stage] || stage;
    return label ? `${fallback}：${label}` : fallback;
  }

  function renderCompletedResult(payload) {
    const report = payload.report || {};
    resultPanel.classList.remove("hidden");
    resultStatus.textContent = "已完成";
    resultDetail.textContent = `举报局 ${report.reportedGameCount ?? "—"} 局，对照局 ${report.controlGameCount ?? "—"} 局。报告已生成：${report.reportPath || "—"}`;
  }

  async function watchAcquisition(runId) {
    const token = ++investigationToken;
    while (token === investigationToken && investigationRunId === runId) {
      try {
        const payload = await requestJson(
          `/api/player-investigation/status?runId=${encodeURIComponent(runId)}&includeCatalog=1`,
        );
        if (token !== investigationToken || investigationRunId !== runId) return;
        const fetchStage = payload.progress && payload.progress.stages && payload.progress.stages.fetch_games;
        if (payload.catalog && fetchStage && fetchStage.status === "completed") {
          renderGames(payload.catalog);
          const enterManualFlow = pendingAcquisitionFlow === "manual";
          pendingAcquisitionFlow = "";
          workflowChoices.classList.toggle("hidden", games.length === 0 || enterManualFlow);
          manualPanel.classList.add("hidden");
          const excludedShort = Number(payload.catalog.excludedShortGameCount) || 0;
          const eligibilitySummary = excludedShort
            ? `符合长度标准 ${payload.catalog.gameCount} 局，已排除不足 16 个实际落子的 ${excludedShort} 局`
            : `符合长度标准 ${payload.catalog.gameCount} 局`;
          setGamesStatus(games.length
            ? `${eligibilitySummary}；${enterManualFlow ? "请勾选举报局。" : "请选择后续调查流程。"}`
            : "没有找到至少完成 16 个实际落子、已进入 ply 17 的 5 分钟对局。", games.length === 0);
          confirmButton.disabled = true;
          setStatus(games.length ? "选手已确认，对局已拉取。" : "选手已确认，但没有可调查对局。", games.length === 0);
          if (games.length && enterManualFlow) chooseManualFlow();
          return;
        }
        if (payload.progress && payload.progress.status === "failed") {
          throw new Error(payload.error || "对局拉取失败");
        }
        setStatus(progressMessage(payload, "正在拉取 5 分钟对局并筛选长度…"));
      } catch (error) {
        if (token !== investigationToken) return;
        setGamesStatus(String(error && error.message ? error.message : error), true);
        setStatus("对局拉取失败，请检查本地服务和网络。", true);
        confirmButton.disabled = false;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  async function watchAnalysis(runId) {
    const token = ++investigationToken;
    while (token === investigationToken && investigationRunId === runId) {
      try {
        const payload = await requestJson(
          `/api/player-investigation/status?runId=${encodeURIComponent(runId)}`,
        );
        if (token !== investigationToken || investigationRunId !== runId) return;
        const progress = payload.progress || {};
        if (progress.status === "completed" || (payload.report && payload.report.status === "completed")) {
          analysisRunning = false;
          updateSelectionSummary();
          setGamesStatus("举报局和对照局计算已完成。");
          renderCompletedResult(payload);
          setStatus("举报局分析已完成。");
          return;
        }
        if (progress.status === "failed" || (!payload.running && payload.exitCode !== null && payload.exitCode !== 0)) {
          throw new Error(payload.error || "举报局分析失败");
        }
        setGamesStatus(progressMessage(payload, "正在运行举报局分析…"));
      } catch (error) {
        if (token !== investigationToken) return;
        analysisRunning = false;
        updateSelectionSummary();
        setGamesStatus(String(error && error.message ? error.message : error), true);
        setStatus("举报局分析失败，请查看本地服务输出。", true);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  async function queryProfile(event) {
    event.preventDefault();
    const account = normalize(accountInput.value);
    if (!account) {
      setStatus("请输入 OQ ID。", true);
      renderProfile(null);
      resetInvestigation();
      return;
    }

    resetInvestigation();
    renderProfile(null);
    queryButton.disabled = true;
    setStatus("正在查询 5 分钟 Player 画像…");
    try {
      const payload = await requestJson("/api/player-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account }),
      });
      if (!payload.profile) throw new Error("查询结果缺少画像信息");
      renderProfile(payload.profile);
      setStatus("查询成功，请确认选手后拉取全部对局。");
    } catch (error) {
      renderProfile(null);
      setStatus(String(error && error.message ? error.message : error), true);
    } finally {
      queryButton.disabled = false;
    }
  }

  async function confirmPlayer() {
    if (!currentProfile) {
      setStatus("请先查询并确认有效的 OQ ID。", true);
      return;
    }
    const account = normalize(currentProfile.id || accountInput.value);
    resetInvestigation();
    confirmButton.disabled = true;
    setGamesStatus("正在启动对局拉取…");
    gamesPanel.classList.remove("hidden");
    setStatus("选手已确认，正在拉取 5 分钟对局并按长度筛选…");
    try {
      const payload = await requestJson("/api/player-investigation/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account }),
      });
      investigationRunId = normalize(payload.runId);
      if (!investigationRunId) throw new Error("本地服务没有返回调查运行 ID");
      void watchAcquisition(investigationRunId);
    } catch (error) {
      setGamesStatus(String(error && error.message ? error.message : error), true);
      setStatus("启动对局拉取失败。", true);
      confirmButton.disabled = false;
    }
  }

  async function runInvestigation() {
    if (!investigationRunId || analysisRunning) return;
    const reportedGameIds = selectedGameIds();
    const controlCount = games.length - reportedGameIds.length;
    if (!reportedGameIds.length || controlCount <= 0) {
      setGamesStatus("至少勾选一局举报局，并保留至少 8 局未勾选的合格对照局。", true);
      return;
    }
    if (controlCount < 8) {
      setGamesStatus(`样本不足：至少需要 8 局未勾选的合格对照局，当前只有 ${controlCount} 局。`, true);
      return;
    }
    if (!window.confirm(analysisResourceConfirmation)) return;

    analysisRunning = true;
    updateSelectionSummary();
    resultPanel.classList.add("hidden");
    setStatus("已提交分组，正在进入分析状态页…");
    setGamesStatus("正在提交举报局/对照局分组…");
    try {
      const payload = await requestJson("/api/player-investigation/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: investigationRunId, reportedGameIds }),
      });
      const nextRunId = normalize(payload.runId || investigationRunId);
      if (!nextRunId) throw new Error("本地服务没有返回分析运行 ID");
      window.location.assign(`./analysis.html?runId=${encodeURIComponent(nextRunId)}`);
    } catch (error) {
      analysisRunning = false;
      updateSelectionSummary();
      setGamesStatus(String(error && error.message ? error.message : error), true);
      setStatus("提交举报局分组失败。", true);
    }
  }

  function chooseManualFlow() {
    workflowChoices.classList.add("hidden");
    manualPanel.classList.remove("hidden");
    setGamesStatus("请勾选举报局；未勾选的对局将作为对照局。");
    updateSelectionSummary();
  }

  function returnToFlowChoices() {
    if (pastReportedPlayer) {
      resetInvestigation();
      currentProfile = null;
      setMode("past");
      setPastStatus("请选择需要调查的选手。");
      return;
    }
    manualPanel.classList.add("hidden");
    workflowChoices.classList.remove("hidden");
    setGamesStatus("请选择手动设定举报局，或运行哨兵监测模式。");
  }

  async function startSentinelMonitoring() {
    if (!investigationRunId || analysisRunning) return;
    if (!window.confirm(analysisResourceConfirmation)) return;

    analysisRunning = true;
    workflowChoices.classList.add("hidden");
    sentinelEntryButton.disabled = true;
    setGamesStatus("正在启动哨兵监测完整流程…");
    setStatus("哨兵监测已提交，正在进入任务状态页…");
    try {
      const payload = await requestJson("/api/player-investigation/sentinel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: investigationRunId }),
      });
      const sentinelRunId = normalize(payload.runId);
      if (!sentinelRunId) throw new Error("本地服务没有返回哨兵任务运行 ID");
      window.location.assign(`./analysis.html?runId=${encodeURIComponent(sentinelRunId)}`);
    } catch (error) {
      analysisRunning = false;
      workflowChoices.classList.remove("hidden");
      sentinelEntryButton.disabled = false;
      setGamesStatus(String(error && error.message ? error.message : error), true);
      setStatus("启动哨兵监测失败。", true);
    }
  }

  modeGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-investigation-mode]");
    if (!button) return;
    if (idPanel.classList.contains("investigation-panel--past-games")) resetInvestigation();
    setMode(button.dataset.investigationMode);
  });
  queryForm.addEventListener("submit", queryProfile);
  confirmButton.addEventListener("click", confirmPlayer);
  manualEntryButton.addEventListener("click", chooseManualFlow);
  sentinelEntryButton.addEventListener("click", startSentinelMonitoring);
  backToChoicesButton.addEventListener("click", returnToFlowChoices);
  clearSelectionButton.addEventListener("click", () => {
    gamesBody.querySelectorAll("input[data-game-id]").forEach((input) => {
      input.checked = false;
    });
    updateSelectionSummary();
  });
  runButton.addEventListener("click", runInvestigation);
  pastRefreshButton.addEventListener("click", () => void loadPastTournaments());
  pastBackButton.addEventListener("click", () => {
    currentTournament = null;
    pastPlayers = [];
    pastTournamentDetail.classList.add("hidden");
    pastBatchStatus.classList.add("hidden");
    pastTournamentList.classList.remove("hidden");
    setPastStatus("请选择一份具有正式总排名的比赛存档。");
  });
  pastClearSelectionButton.addEventListener("click", () => {
    pastPlayerList.querySelectorAll("input[data-player-index]").forEach((input) => {
      input.checked = false;
    });
    updatePastPlayerSelection();
  });
  pastSentinelButton.addEventListener("click", startPastSentinel);
  pastReportedButton.addEventListener("click", startPastReported);
  setMode("id");
})();
