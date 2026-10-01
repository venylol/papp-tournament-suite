(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const params = new URLSearchParams(window.location.search);
  const batchId = params.get("batchId") || "";
  const fromHistory = params.get("from") === "history";
  const brandLink = $("#batch-brand");
  const headerBack = $("#batch-header-back");
  const footerBack = $("#batch-footer-back");
  const statusBadge = $("#batch-status-badge");
  const tournament = $("#batch-tournament");
  const id = $("#batch-id");
  const currentPlayer = $("#batch-current-player");
  const reportPath = $("#batch-report-path");
  const progressLabel = $("#batch-progress-label");
  const progressTrack = $("#batch-progress-track");
  const progressFill = $("#batch-progress-fill");
  const message = $("#batch-message");
  const reportStatus = $("#batch-report-status");
  const reportDetail = $("#batch-report-detail");
  const resultList = $("#batch-result-list");
  const error = $("#batch-error");
  let polling = true;
  let leaving = false;

  if (fromHistory) {
    brandLink.href = "./history.html";
    brandLink.setAttribute("aria-label", "返回历史分析");
    headerBack.href = "./history.html";
    headerBack.textContent = "返回历史分析";
    footerBack.href = "./history.html";
    footerBack.textContent = "返回历史分析";
  }

  function text(value) {
    return String(value ?? "").replace(/\s+/gu, " ").trim();
  }

  function number(value) {
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  function format(value, digits = 0) {
    const result = number(value);
    return result === null ? "—" : result.toFixed(digits).replace(/\.0+$/u, "");
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.detail || payload.error || "本地服务返回失败");
    return payload;
  }

  async function requestStatus() {
    const response = await fetch(`/api/player-investigation/batch-status?batchId=${encodeURIComponent(batchId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.detail || payload.error || "本地服务返回失败");
    return payload;
  }

  function metric(parent, label, value, detail = "") {
    const item = document.createElement("div");
    item.className = "investigation-analysis__metric";
    const labelNode = document.createElement("span");
    labelNode.className = "investigation-analysis__metric-label";
    labelNode.textContent = label;
    const valueNode = document.createElement("strong");
    valueNode.className = "investigation-analysis__metric-value";
    valueNode.textContent = value;
    item.append(labelNode, valueNode);
    if (detail) {
      const detailNode = document.createElement("small");
      detailNode.className = "investigation-analysis__metric-detail";
      detailNode.textContent = detail;
      item.append(detailNode);
    }
    parent.append(item);
  }

  function renderResults(results) {
    resultList.replaceChildren();
    results.forEach((result) => {
      const section = document.createElement("section");
      section.className = "investigation-analysis__report-section";
      const heading = document.createElement("h4");
      heading.textContent = `第 ${result.rank} 名 · ${result.name}（${result.account}）`;
      section.append(heading);
      if (result.status === "failed") {
        const note = document.createElement("p");
        note.className = "investigation-analysis__report-note investigation-query-status--error";
        note.textContent = `分析失败：${text(result.error) || "未提供原因"}`;
        section.append(note);
      } else {
        const summary = result.summary || {};
        const sentinel = summary.sentinel || {};
        const ratingPresentation = window.PappRatingPresentation.presentRating(sentinel.rating || {});
        const grid = document.createElement("div");
        grid.className = "investigation-analysis__metric-grid";
        metric(grid, "哨兵分类", text(summary.classification) || "—");
        metric(grid, "预估 Rating", ratingPresentation.value, ratingPresentation.detail);
        metric(grid, "候选举报局", `${format(sentinel.candidateGameCount)} 局`, `最终举报组 ${format(summary.reportedGameCount)} 局`);
        metric(grid, "整体超越率", number(sentinel.overallExceedanceRate) === null ? "—" : `${format(number(sentinel.overallExceedanceRate) * 100, 2)}%`);
        metric(grid, "最强阶段", text(sentinel.strongestPhaseLabel) || "—", `最弱阶段：${text(sentinel.weakestPhaseLabel) || "—"}`);
        section.append(grid);
        if (result.runId) {
          const link = document.createElement("a");
          link.className = "investigation-analysis__appendix-link";
          const detailParams = new URLSearchParams({ runId: result.runId, batchId });
          if (fromHistory) detailParams.set("from", "history");
          link.href = `./analysis.html?${detailParams.toString()}`;
          link.textContent = "查看该选手完整分析详情";
          section.append(link);
        }
      }
      resultList.append(section);
    });
  }

  function render(payload) {
    const total = number(payload.totalCount) ?? 0;
    const completed = number(payload.completedCount) ?? 0;
    const failed = number(payload.failedCount) ?? 0;
    const processed = Math.min(total, completed + failed);
    const percent = total ? Math.round(processed / total * 100) : 0;
    const active = payload.currentPlayer && typeof payload.currentPlayer === "object" ? payload.currentPlayer : null;
    const state = text(payload.status).toLowerCase() || "running";
    if (["terminating", "terminated"].includes(state)) {
      statusBadge.textContent = state === "terminated" ? "已终止" : "终止中";
      reportStatus.textContent = statusBadge.textContent;
      message.textContent = state === "terminated" ? "多人任务已终止，后续选手不再分析。" : "正在终止多人任务…";
      return state;
    }
    tournament.textContent = text(payload.competitionName) || text(payload.tournamentFile) || "—";
    id.textContent = batchId || "—";
    currentPlayer.textContent = active ? `第 ${active.rank} 名 · ${active.name}（${active.account}）` : "—";
    reportPath.textContent = text(payload.reportPath) || "任务完成后生成";
    progressLabel.textContent = `${processed} / ${total}`;
    progressTrack.setAttribute("aria-valuenow", String(percent));
    progressFill.style.width = `${percent}%`;
    statusBadge.textContent = state === "completed" ? "已完成" : "运行中";
    statusBadge.className = `investigation-analysis__status-badge investigation-analysis__status-badge--${state === "completed" ? "completed" : "running"}`;
    reportStatus.textContent = state === "completed" ? "已完成" : "运行中";
    message.textContent = state === "completed"
      ? `全部 ${total} 位选手已处理：成功 ${completed} 位，失败 ${failed} 位。`
      : active ? `正在处理第 ${payload.currentIndex} / ${total} 位选手：${active.name}` : "正在准备下一位选手…";
    reportDetail.textContent = state === "completed"
      ? `汇总报告已生成；成功 ${completed} 位，失败 ${failed} 位。`
      : `已成功完成 ${completed} 位，失败 ${failed} 位；失败不会阻止后续选手。`;
    renderResults(Array.isArray(payload.results) ? payload.results : []);
    return state;
  }

  async function returnToParent(event) {
    event.preventDefault();
    if (leaving) return;
    const destination = event.currentTarget.href;
    if (!batchId) { window.location.assign(destination); return; }
    leaving = true;
    try {
      let payload = await requestJson(`/api/player-investigation/batch-status?batchId=${encodeURIComponent(batchId)}`);
      if (["running", "terminating"].includes(payload.status)) {
        if (!window.confirm("是否终止当前的任务？确认后将终止任务并返回上一级。")) return;
        payload = await requestJson("/api/player-investigation/batch-terminate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchId }),
        });
        while (["running", "terminating"].includes(payload.status)) {
          if (!(payload.status === "terminating")) throw new Error(payload.error || "终止任务失败，请重试。");
          await new Promise((resolve) => setTimeout(resolve, 100));
          payload = await requestJson(`/api/player-investigation/batch-status?batchId=${encodeURIComponent(batchId)}`);
        }
      }
      polling = false;
      window.location.assign(destination);
    } catch (failure) {
      error.textContent = String(failure && failure.message ? failure.message : failure);
    } finally {
      leaving = false;
    }
  }

  [brandLink, headerBack, footerBack].forEach((link) => link.addEventListener("click", returnToParent));

  async function watch() {
    if (!batchId) {
      error.textContent = "缺少多人哨兵任务 ID，请从往期比赛调查入口重新开始。";
      return;
    }
    while (polling) {
      try {
        const state = render(await requestStatus());
        error.textContent = "";
        if (["completed", "terminated"].includes(state)) return;
      } catch (failure) {
        error.textContent = text(failure && failure.message) || "读取任务状态失败";
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  window.addEventListener("pagehide", () => { polling = false; });
  void watch();
})();
