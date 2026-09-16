(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const params = new URLSearchParams(window.location.search);
  const runId = String(params.get("runId") || "").trim();
  const batchId = String(params.get("batchId") || "").trim();
  const fromHistory = params.get("from") === "history";
  const brandLink = $("#analysis-brand");
  const headerBack = $("#analysis-header-back");
  const footerBack = $("#analysis-footer-back");
  const statusBadge = $("#analysis-status-badge");
  const workflowName = $("#analysis-workflow-name");
  const pageTitle = $("#analysis-title");
  const pageLead = $("#analysis-lead");
  const account = $("#analysis-account");
  const runIdElement = $("#analysis-run-id");
  const stage = $("#analysis-stage");
  const startedAt = $("#analysis-started-at");
  const cpu = $("#analysis-cpu");
  const cpuDetail = $("#analysis-cpu-detail");
  const memory = $("#analysis-memory");
  const memoryDetail = $("#analysis-memory-detail");
  const gpu = $("#analysis-gpu");
  const gpuDetail = $("#analysis-gpu-detail");
  const updatedAt = $("#analysis-updated-at");
  const progressLabel = $("#analysis-progress-label");
  const progressTrack = $(".investigation-analysis__progress-track");
  const progressFill = $("#analysis-progress-fill");
  const message = $("#analysis-message");
  const stageList = $("#analysis-stage-list");
  const terminateButton = $("#btn-analysis-terminate");
  const errorMessage = $("#analysis-error");
  const reportPanel = $("#analysis-report");
  const reportStatus = $("#analysis-report-status");
  const reportDetail = $("#analysis-report-detail");
  const reportSections = $("#analysis-report-sections");

  const stageLabels = {
    fetch_games: "拉取全部对局",
    select_groups: "设置举报局和对照局",
    acquisition: "准备哨兵对局集",
    profile: "拉取选手画像",
    fetch_profiles: "拉取画像",
    level22: "Egaroucid Level22 分析",
    offbook_detection: "传统哨兵候选局检测",
    sentinel_reference_scoring: "传统哨兵参考评分",
    sentinel_pseudo_scan: "哨兵统计扫描",
    sentinel_group_freeze: "自动拟定举报局与对照局",
    sentinel_unified_analysis: "Rating 估值与哨兵结果汇总",
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

  const manualStageOrder = [
    "fetch_games", "select_groups", "fetch_profiles", "level22", "offbook_detection",
    "hint_source", "hint1", "hint6", "hint_assembly", "model_materialization",
    "profile_materialization", "adapt_models", "evaluate_reported", "non_model_statistics",
    "final_report",
  ];
  const sentinelStageOrder = [
    "acquisition", "profile", "level22", "offbook_detection", "sentinel_reference_scoring",
    "sentinel_pseudo_scan", "sentinel_group_freeze", "sentinel_unified_analysis", "hint_source",
    "hint1", "hint6", "hint_assembly", "model_materialization", "profile_materialization",
    "adapt_models", "evaluate_reported", "non_model_statistics", "final_report",
  ];

  const sentinelClassLabels = {
    concentrated_external_internal_anomaly: "集中异常信号",
    external_uniform_anomaly: "广泛一致异常信号",
    isolated_external_anomaly: "单局异常信号",
    internal_variation_only: "仅局内波动",
    no_clear_signal: "无明确异常信号",
  };

  const stageStatusLabels = {
    pending: "待处理",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    skipped: "已跳过",
    not_applicable: "不适用",
    terminated: "已终止",
  };

  let stopping = false;
  let polling = true;

  if (fromHistory) {
    brandLink.href = "./history.html";
    brandLink.setAttribute("aria-label", "返回历史分析");
    headerBack.hidden = false;
    headerBack.href = "./history.html";
    headerBack.textContent = "返回历史分析";
    footerBack.href = "./history.html";
    footerBack.textContent = "返回历史分析";
  } else if (batchId && runId) {
    const batchParams = new URLSearchParams({ batchId });
    const batchOverviewHref = `./batch-analysis.html?${batchParams.toString()}`;
    brandLink.href = batchOverviewHref;
    brandLink.setAttribute("aria-label", "返回批量分析概览");
    headerBack.hidden = true;
    footerBack.href = batchOverviewHref;
    footerBack.textContent = "返回批量分析概览";
  }

  function normalize(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function formatDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return normalize(value) || "—";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  }

  function formatPercent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(1)}%` : "采样中…";
  }

  function formatMiB(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toLocaleString("zh-CN")} MiB` : "—";
  }

  function formatMetricNumber(value, digits = 2) {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    return Number.isFinite(number)
      ? number.toLocaleString("zh-CN", { maximumFractionDigits: digits })
      : "—";
  }

  function formatRate(value) {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "—";
  }

  function formatRateInterval(interval) {
    if (!interval) return "—";
    return `[${formatRate(interval.lower)}, ${formatRate(interval.upper)}]`;
  }

  function formatSignedNumber(value, digits = 2) {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const formatted = formatMetricNumber(Math.abs(number), digits);
    return `${number > 0 ? "+" : number < 0 ? "−" : ""}${formatted}`;
  }

  function formatMetricDifference(value, kind) {
    if (kind === "percentagePoints") {
      return value === null || value === undefined
        ? "—"
        : `${formatSignedNumber(Number(value) * 100, 1)} 个百分点`;
    }
    return formatSignedNumber(value, 2);
  }

  function formatDifferenceInterval(interval, kind) {
    if (!interval) return "—";
    if (kind === "percentagePoints") {
      return `[${formatSignedNumber(Number(interval.lower) * 100, 1)}, ${formatSignedNumber(Number(interval.upper) * 100, 1)}] 个百分点`;
    }
    return `[${formatSignedNumber(interval.lower, 2)}, ${formatSignedNumber(interval.upper, 2)}]`;
  }

  function appendReportSection(title, note = "", parent = reportSections) {
    const section = document.createElement("section");
    section.className = "investigation-analysis__report-section";
    const heading = document.createElement("h4");
    heading.textContent = title;
    section.append(heading);
    if (note) {
      const description = document.createElement("p");
      description.className = "investigation-analysis__report-note";
      description.textContent = note;
      section.append(description);
    }
    parent.append(section);
    return section;
  }

  function appendReportMetrics(section, metrics) {
    if (!metrics.length) return;
    const grid = document.createElement("div");
    grid.className = "investigation-analysis__metric-grid";
    metrics.forEach((metric) => {
      const card = document.createElement("div");
      card.className = "investigation-analysis__metric";
      const label = document.createElement("span");
      label.className = "investigation-analysis__metric-label";
      label.textContent = metric.label;
      const value = document.createElement("strong");
      value.className = "investigation-analysis__metric-value";
      value.textContent = metric.value;
      card.append(label, value);
      if (metric.detail) {
        const detail = document.createElement("small");
        detail.className = "investigation-analysis__metric-detail";
        detail.textContent = metric.detail;
        card.append(detail);
      }
      grid.append(card);
    });
    section.append(grid);
  }

  function appendReportTable(section, headers, rows) {
    if (!rows.length) return;
    const wrap = document.createElement("div");
    wrap.className = "investigation-analysis__table-wrap";
    const table = document.createElement("table");
    table.className = "investigation-analysis__table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    headers.forEach((label) => {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      headRow.append(cell);
    });
    head.append(headRow);
    const body = document.createElement("tbody");
    rows.forEach((values) => {
      const row = document.createElement("tr");
      values.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
        row.append(cell);
      });
      body.append(row);
    });
    table.append(head, body);
    wrap.append(table);
    section.append(wrap);
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || payload.detail || "本地服务返回失败");
    }
    return payload;
  }

  function taskState(payload) {
    if (payload.terminated) return "terminated";
    if (payload.terminationRequested) return "terminating";
    const progress = payload.progress || {};
    if (progress.status === "completed" || payload.report?.status === "completed") return "completed";
    if (progress.status === "failed" || (!payload.running && payload.exitCode !== null && payload.exitCode !== 0)) return "failed";
    return payload.running ? "running" : "waiting";
  }

  function taskStateLabel(state) {
    return {
      running: "运行中",
      terminating: "终止中",
      completed: "已完成",
      failed: "失败",
      terminated: "已终止",
      waiting: "等待中",
    }[state] || "连接中";
  }

  function isSentinelMode(payload) {
    const stages = payload.progress && payload.progress.stages;
    return payload.mode === "sentinel"
      || payload.report?.mode === "sentinel"
      || Boolean(stages && (
        stages.sentinel_reference_scoring
        || stages.sentinel_pseudo_scan
        || stages.sentinel_group_freeze
        || stages.sentinel_unified_analysis
      ));
  }

  function configureWorkflow(sentinel) {
    const name = sentinel ? "哨兵监测" : "举报局分析";
    workflowName.textContent = name;
    pageTitle.textContent = name;
    document.title = `PAPP · ${name}`;
    pageLead.textContent = sentinel
      ? "哨兵监测在本机后台运行，自动完成传统哨兵分析、Rating 估值、举报局拟定及后续流程。"
      : "分析任务正在本机后台运行。页面会持续刷新当前阶段和系统资源状态。";
  }

  function renderStages(progress, sentinel) {
    const stages = progress && progress.stages && typeof progress.stages === "object"
      ? progress.stages
      : {};
    const keys = [...(sentinel ? sentinelStageOrder : manualStageOrder)];
    Object.keys(stages).forEach((key) => {
      if (!keys.includes(key)) keys.push(key);
    });
    stageList.replaceChildren();
    keys.forEach((key) => {
      const rawStatus = normalize(stages[key] && stages[key].status).toLowerCase();
      const stageStatus = stageStatusLabels[rawStatus] ? rawStatus : "pending";
      const row = document.createElement("div");
      row.className = `investigation-analysis__stage investigation-analysis__stage--${stageStatus}`;
      const name = document.createElement("span");
      name.className = "investigation-analysis__stage-name";
      name.textContent = stageLabels[key] || key;
      const state = document.createElement("span");
      state.className = "investigation-analysis__stage-status";
      state.textContent = stageStatusLabels[rawStatus] || "待处理";
      row.append(name, state);
      stageList.append(row);
    });
    const entries = Object.values(stages);
    const completed = entries.filter((item) => ["completed", "skipped", "not_applicable"]
      .includes(normalize(item && item.status))).length;
    const running = entries.some((item) => normalize(item && item.status) === "running");
    const percent = entries.length
      ? Math.round(((completed + (running ? 0.5 : 0)) / entries.length) * 100)
      : 0;
    progressFill.style.width = `${Math.min(100, percent)}%`;
    progressTrack.setAttribute("aria-valuenow", String(Math.min(100, percent)));
    progressLabel.textContent = entries.length ? `${completed}/${entries.length} 阶段完成` : "等待阶段信息";
  }

  function renderResources(resources) {
    const data = resources && typeof resources === "object" ? resources : {};
    const cpuData = data.cpu || {};
    const memoryData = data.memory || {};
    cpu.textContent = formatPercent(cpuData.percent);
    cpuDetail.textContent = "系统 CPU 使用率";
    memory.textContent = formatPercent(memoryData.percent);
    memoryDetail.textContent = `${formatMiB(memoryData.usedMiB)} / ${formatMiB(memoryData.totalMiB)}`;

    const gpuData = data.gpu || {};
    if (!gpuData.available || !Array.isArray(gpuData.devices) || !gpuData.devices.length) {
      gpu.textContent = "不可用";
      gpuDetail.textContent = normalize(gpuData.reason) || "未检测到可用 GPU 指标";
    } else {
      const devices = gpuData.devices;
      const utilization = devices.map((device) => Number(device.utilizationPercent));
      const validUtilization = utilization.filter((value) => Number.isFinite(value));
      gpu.textContent = validUtilization.length === 1
        ? formatPercent(validUtilization[0])
        : `${devices.length} 个设备`;
      gpuDetail.textContent = devices.map((device) => {
        const name = normalize(device.name) || "GPU";
        const usage = Number.isFinite(Number(device.utilizationPercent))
          ? formatPercent(device.utilizationPercent)
          : "—";
        return `${name} ${usage}`;
      }).join("；");
    }
    updatedAt.textContent = formatDate(data.capturedAt);
  }

  function renderCoverageReport(report) {
    const coverage = report.acquisition;
    if (!coverage) return;
    const hasCoverageData = [
      coverage.listedGameCount,
      coverage.detailFetchedGameCount,
      coverage.detailFailureGameCount,
    ].some((value) => value !== null && value !== undefined)
      || coverage.coverageStatus
      || coverage.coverageWarning;
    if (!hasCoverageData) return;
    const statusLabels = { complete: "完整", partial: "部分完成", failed: "失败" };
    const fetched = coverage.detailFetchedGameCount;
    const listed = coverage.listedGameCount;
    const section = appendReportSection("对局数据覆盖");
    appendReportMetrics(section, [
      {
        label: "已获取详情",
        value: fetched === null || fetched === undefined || listed === null || listed === undefined
          ? "—"
          : `${formatMetricNumber(fetched, 0)} / ${formatMetricNumber(listed, 0)} 局`,
      },
      {
        label: "详情失败",
        value: coverage.detailFailureGameCount === null || coverage.detailFailureGameCount === undefined
          ? "—"
          : `${formatMetricNumber(coverage.detailFailureGameCount, 0)} 局`,
      },
      {
        label: "覆盖状态",
        value: statusLabels[coverage.coverageStatus] || coverage.coverageStatus || "—",
        detail: coverage.coverageWarning || "",
      },
    ]);
  }

  function renderSentinelReport(report) {
    const data = report.sentinel;
    if (!data) return;
    const classification = sentinelClassLabels[report.classification]
      || report.classification
      || "—";
    const note = `哨兵分类：${classification}。超越率是扫描统计指标，不等同于作弊概率。`;
    const section = appendReportSection("完整哨兵流程", note);
    const rating = data.rating || {};
    const ratingPresentation = window.PappRatingPresentation.presentRating(rating);
    const rateMetric = (label, value, interval) => ({
      label,
      value: formatRate(value),
      detail: `95% Wilson 区间：${formatRateInterval(interval)}`,
    });
    const bestKDetail = data.candidateGameCount === null || data.candidateGameCount === undefined
      ? "扫描选出的候选局数量"
      : `候选局 ${formatMetricNumber(data.candidateGameCount, 0)} 局`;

    appendReportMetrics(section, [
      { label: "预估 Rating", value: ratingPresentation.value, detail: ratingPresentation.detail },
      {
        label: "最佳 K",
        value: data.bestK === null || data.bestK === undefined ? "—" : `K = ${formatMetricNumber(data.bestK, 0)}`,
        detail: bestKDetail,
      },
      rateMetric("最强单局超越率", data.bestSingleExceedanceRate, data.bestSingleExceedanceInterval),
      rateMetric("整体超越率", data.overallExceedanceRate, data.overallExceedanceInterval),
      rateMetric("扫描校准超越率", data.scanCorrectedExceedanceRate, data.scanCorrectedExceedanceInterval),
      {
        label: "举报组模型分析",
        value: data.modelReviewReady ? "已就绪" : data.modelStatus === "not_run" ? "未运行" : "未就绪",
        detail: data.modelReason || "",
      },
    ]);

    const strongest = normalize(data.strongestPhaseLabel);
    const weakest = normalize(data.weakestPhaseLabel);
    const phaseRows = (Array.isArray(data.phases) ? data.phases : []).map((phase) => {
      const phaseNumber = Number(phase.phase);
      const startPly = Number(phase.startPly);
      const endPly = Number(phase.endPly);
      const hasPlyRange = Number.isInteger(startPly)
        && startPly > 0
        && Number.isInteger(endPly)
        && endPly >= startPly;
      let label = Number.isInteger(phaseNumber) && phaseNumber > 0
        ? `第${phaseNumber}阶段`
        : phase.label || "—";
      if (hasPlyRange) label += `（Ply ${startPly}–${endPly}）`;
      if (strongest && phase.label === strongest) label += "（最强）";
      if (weakest && phase.label === weakest) label += "（最弱）";
      const samples = `${formatMetricNumber(phase.validGames, 0)} 局 / ${formatMetricNumber(phase.validNodes, 0)} 步`;
      return [
        label,
        samples,
        formatMetricNumber(phase.meanDiscLoss, 2),
        formatRate(phase.probabilityLossEq0),
        formatRate(phase.probabilityLossGe4),
        formatRate(phase.probabilityLossGe10),
      ];
    });
    if (phaseRows.length) {
      const phases = appendReportSection("选手四阶段结果");
      appendReportTable(phases, ["阶段", "样本", "平均子损", "零子损率", "≥4 子损率", "≥10 子损率"], phaseRows);
    }
  }

  function renderReportedAnalysis(report) {
    const data = report.reportedAnalysis;
    if (!data) return;
    const groupCountNote = `分组：举报局 ${report.reportedGameCount ?? "—"} 局、对照局 ${report.controlGameCount ?? "—"} 局；同色比较样本为举报局 ${data.reportedSameColorGameCount ?? "—"} 局、对照局 ${data.controlSameColorGameCount ?? "—"} 局。`;
    const section = appendReportSection("举报局分析", groupCountNote);
    const engineRows = (Array.isArray(data.engineMetrics) ? data.engineMetrics : []).map((metric) => [
      metric.label,
      formatMetricDifference(metric.difference, metric.kind),
      `95% Bootstrap CI：${formatDifferenceInterval(metric.interval, metric.kind)}`,
    ]);
    const engineSection = appendReportSection(
      "引擎分析差值",
      "差值方向为举报局减去同色对照组。",
      section,
    );
    appendReportTable(engineSection, ["指标", "差值", "区间"], engineRows);

    const adaptation = data.adaptation || {};
    const hardRows = (Array.isArray(adaptation.hardMatchMetrics) ? adaptation.hardMatchMetrics : []).map((metric) => [
      metric.label,
      formatRate(metric.before),
      formatRate(metric.after),
    ]);
    if (hardRows.length) {
      const hardSection = appendReportSection("对照局适配前后：硬符合匹配率", "", section);
      appendReportTable(hardSection, ["指标", "适配前", "适配后"], hardRows);
    }

    const probabilityRows = (Array.isArray(adaptation.probabilityMatchMetrics)
      ? adaptation.probabilityMatchMetrics
      : []).map((metric) => {
      const format = metric.kind === "rate" ? formatRate : (value) => formatMetricNumber(value, 3);
      return [metric.label, format(metric.actual), format(metric.before), format(metric.after)];
    });
    if (probabilityRows.length) {
      const probabilitySection = appendReportSection(
        "对照局适配前后：概率匹配率",
        adaptation.evaluationRole === "in-sample-control-adapter-fit"
          ? "显示实测率与适配前后模型率；适配表现来自对照局内拟合。"
          : "显示实测率与适配前后模型率。",
        section,
      );
      appendReportTable(probabilitySection, ["指标", "实测率", "适配前", "适配后"], probabilityRows);
    }

    const prediction = data.reportedPrediction || {};
    const predictionRows = (Array.isArray(prediction.metrics) ? prediction.metrics : []).map((metric) => {
      if (metric.insufficientSample) {
        return [metric.label, "样本不足", "样本不足", "—", "—"];
      }
      const isRate = metric.kind === "rate";
      const point = isRate ? formatRate(metric.value) : formatMetricNumber(metric.value, 3);
      const reportedActual = isRate
        ? formatRate(metric.reportedActual)
        : formatMetricNumber(metric.reportedActual, 3);
      const differenceKind = isRate ? "percentagePoints" : "number";
      return [
        metric.label,
        point,
        reportedActual,
        formatMetricDifference(metric.difference, differenceKind),
        formatDifferenceInterval(metric.differenceInterval, differenceKind),
      ];
    });
    const predictionDetails = [];
    if (prediction.reportedGameCount !== null && prediction.reportedGameCount !== undefined) {
      predictionDetails.push(`${formatMetricNumber(prediction.reportedGameCount, 0)} 局举报局`);
    }
    if (prediction.nodeCount !== null && prediction.nodeCount !== undefined) {
      predictionDetails.push(`${formatMetricNumber(prediction.nodeCount, 0)} 个节点`);
    }
    if (prediction.memberCount !== null && prediction.memberCount !== undefined) {
      predictionDetails.push(`${formatMetricNumber(prediction.memberCount, 0)} 个个人模型`);
    }
    if (prediction.bootstrapReplicates !== null && prediction.bootstrapReplicates !== undefined) {
      predictionDetails.push(`${formatMetricNumber(prediction.bootstrapReplicates, 0)} 次 Bootstrap`);
    }
    const predictionSection = appendReportSection(
      "举报局模型预测与举报局实测的差值",
      `${predictionDetails.join("；") || ""}${predictionDetails.length ? "。" : ""}差值方向为举报局模型预测减去举报局实测值；区间为每个模型 Bootstrap 复本减去固定的举报局实测值。差值区间不是作弊概率。`,
      section,
    );
    if (predictionRows.length) {
      appendReportTable(
        predictionSection,
        ["指标", "举报局模型预测", "举报局实测", "差值", "差值 Bootstrap 95% CI"],
        predictionRows,
      );
    } else if (prediction.status && prediction.status !== "completed") {
      const unavailable = document.createElement("p");
      unavailable.className = "investigation-analysis__report-note";
      unavailable.textContent = `模型预测状态：${prediction.status}`;
      predictionSection.append(unavailable);
    }
  }

  function renderReport(report, state, sentinel) {
    const hasReport = report && typeof report === "object";
    const completed = state === "completed";
    reportPanel.hidden = !hasReport && !completed;
    reportSections.replaceChildren();
    if (reportPanel.hidden) return;

    reportStatus.textContent = completed ? "已完成" : "—";
    if (!hasReport) {
      reportDetail.textContent = "任务已结束，但暂未找到最终报告文件。";
      return;
    }

    if (sentinel) {
      const classification = sentinelClassLabels[report.classification]
        || report.classification
        || "—";
      const bestK = report.sentinel && report.sentinel.bestK;
      const candidateCount = report.sentinel && report.sentinel.candidateGameCount;
      const candidateText = candidateCount === null || candidateCount === undefined
        ? ""
        : `；扫描候选 ${formatMetricNumber(candidateCount, 0)} 局`;
      const bestKText = bestK === null || bestK === undefined
        ? ""
        : `；最佳 K=${formatMetricNumber(bestK, 0)}`;
      reportDetail.textContent = `哨兵分类：${classification}${bestKText}${candidateText}；最终分组为举报局 ${report.reportedGameCount ?? "—"} 局、对照局 ${report.controlGameCount ?? "—"} 局。完整报告 JSON：${report.reportPath || "—"}`;
    } else {
      reportDetail.textContent = `举报局 ${report.reportedGameCount ?? "—"} 局，对照局 ${report.controlGameCount ?? "—"} 局。报告已生成：${report.reportPath || "—"}`;
    }

    renderCoverageReport(report);
    if (sentinel) renderSentinelReport(report);
    renderReportedAnalysis(report);
  }

  function render(payload) {
    const progress = payload.progress || {};
    const state = taskState(payload);
    const sentinel = isSentinelMode(payload);
    configureWorkflow(sentinel);
    account.textContent = normalize(payload.account) || "—";
    runIdElement.textContent = runId || "—";
    stage.textContent = stageLabels[progress.currentStage] || normalize(progress.currentStage) || "—";
    startedAt.textContent = formatDate(payload.startedAt || progress.createdAtUtc);
    statusBadge.textContent = taskStateLabel(state);
    statusBadge.className = `investigation-analysis__status-badge investigation-analysis__status-badge--${state}`;
    message.textContent = state === "running"
      ? `正在进行：${stageLabels[progress.currentStage] || progress.currentStage || "准备中"}`
      : state === "terminating"
        ? "正在终止后台任务，请稍候…"
        : state === "terminated"
          ? "任务已终止，后台进程已停止。"
          : state === "completed"
            ? sentinel ? "哨兵监测完整流程已完成。" : "举报局和对照局分析已完成。"
            : state === "failed"
              ? `任务失败：${normalize(payload.error) || "请查看本地服务输出。"}`
              : "正在等待本地任务状态…";
    errorMessage.textContent = state === "failed" ? normalize(payload.error) : "";
    renderStages(progress, sentinel);
    renderResources(payload.resources);
    renderReport(payload.report, state, sentinel);
    stopping = state === "terminating" || state === "terminated";
    terminateButton.disabled = !payload.running || stopping;
    terminateButton.textContent = state === "terminating" ? "终止中…" : "终止任务";
    return state;
  }

  async function stopTask() {
    if (!runId || stopping) return;
    if (!window.confirm("确定要终止当前调查任务吗？已完成的阶段不会回滚。")) return;
    stopping = true;
    terminateButton.disabled = true;
    terminateButton.textContent = "终止中…";
    try {
      const payload = await requestJson("/api/player-investigation/terminate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      render(payload);
    } catch (error) {
      stopping = false;
      terminateButton.disabled = false;
      terminateButton.textContent = "终止任务";
      errorMessage.textContent = String(error && error.message ? error.message : error);
    }
  }

  async function watch() {
    if (!runId) {
      message.textContent = "缺少调查运行 ID，请从对局选择页面重新开始。";
      terminateButton.disabled = true;
      return;
    }
    while (polling) {
      try {
        const payload = await requestJson(
          `/api/player-investigation/status?runId=${encodeURIComponent(runId)}&includeResources=1`,
        );
        const state = render(payload);
        if (["completed", "failed", "terminated"].includes(state)) return;
        errorMessage.textContent = "";
      } catch (error) {
        errorMessage.textContent = String(error && error.message ? error.message : error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  terminateButton.addEventListener("click", stopTask);
  window.addEventListener("pagehide", () => {
    polling = false;
  });
  void watch();
})();
