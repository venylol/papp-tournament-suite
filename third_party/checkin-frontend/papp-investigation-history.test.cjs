"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
// Retain test fixtures in the temporary directory; do not delete local files.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "papp-history-test-"));
process.env.PAPP_PLAYER_INVESTIGATIONS_DIR = path.join(fixtureRoot, "single");
process.env.PAPP_PLAYER_INVESTIGATION_BATCHES_DIR = path.join(fixtureRoot, "batch");
const service = require("./local-server.js");

const portal = path.join(__dirname, "papp-portal", "player-investigation");

test("history page offers single and batch reports through existing report views", () => {
  const entryHtml = fs.readFileSync(path.join(portal, "index.html"), "utf8");
  const historyHtml = fs.readFileSync(path.join(portal, "history.html"), "utf8");
  const historyScript = fs.readFileSync(path.join(portal, "history.js"), "utf8");
  const batchScript = fs.readFileSync(path.join(portal, "batch-analysis.js"), "utf8");
  const batchHtml = fs.readFileSync(path.join(portal, "batch-analysis.html"), "utf8");
  const analysisHtml = fs.readFileSync(path.join(portal, "analysis.html"), "utf8");
  const analysisScript = fs.readFileSync(path.join(portal, "analysis.js"), "utf8");

  assert.match(entryHtml, /href="\.\/history\.html">历史分析/);
  assert.match(historyScript, /\/api\/player-investigation\/history/);
  assert.match(historyScript, /\.\/analysis\.html\?runId=.*&from=history/);
  assert.match(historyScript, /\.\/batch-analysis\.html\?batchId=.*&from=history/);
  assert.match(batchScript, /detailParams\.set\("from", "history"\)/);
  assert.match(batchScript, /analysis\.html\?\$\{detailParams\.toString\(\)\}/);
  for (const id of ["batch-header-back", "batch-footer-back"]) {
    assert.match(batchHtml, new RegExp(`id=["']${id}["']`));
  }
  const historicalBatchNavigation = batchScript.match(/if \(fromHistory\) \{([\s\S]*?)\n  \}/);
  assert.ok(historicalBatchNavigation, "historical batch reports should return to history");
  assert.match(historicalBatchNavigation[1], /headerBack\.href = "\.\/history\.html"/);
  assert.match(historicalBatchNavigation[1], /footerBack\.href = "\.\/history\.html"/);
  assert.match(analysisHtml, /id="analysis-footer-back"/);
  const historicalDetailNavigation = analysisScript.match(/if \(fromHistory\) \{([\s\S]*?)\n  \}/);
  assert.ok(historicalDetailNavigation, "all historical details should return to the history list");
  assert.match(historicalDetailNavigation[1], /headerBack\.hidden = false/);
  assert.match(historicalDetailNavigation[1], /headerBack\.href = "\.\/history\.html"/);
  assert.match(historicalDetailNavigation[1], /footerBack\.href = "\.\/history\.html"/);
  assert.match(historicalDetailNavigation[1], /footerBack\.textContent = "返回历史分析"/);
  const batchNavigation = analysisScript.match(/else if \(batchId && runId\) \{([\s\S]*?)\n  \}/);
  assert.ok(batchNavigation, "batch detail should have a dedicated navigation branch");
  assert.match(batchNavigation[1], /headerBack\.hidden = true/);
  assert.match(batchNavigation[1], /footerBack\.href = batchOverviewHref/);
  assert.match(batchNavigation[1], /footerBack\.textContent = "返回批量分析概览"/);
  assert.match(analysisHtml, /rating-presentation\.js\?v=papp-portal\.1/);
  assert.match(analysisHtml, /analysis\.js\?v=papp-portal\.10/);
  assert.match(batchHtml, /rating-presentation\.js\?v=papp-portal\.1/);
  assert.match(batchHtml, /batch-analysis\.js\?v=papp-portal\.4/);
});

test("investigation restart handling never reuses a frozen acquisition", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "local-server.js"), "utf8");
  const orchestrator = fs.readFileSync(
    path.join(__dirname, "..", "player-analysis-toolkit", "scripts", "analysis", "run_player_investigation.py"),
    "utf8",
  );
  assert.match(serverSource, /const groupsPending = progress[\s\S]*progress\.stages\?\.select_groups\?\.status !== "completed"/);
  assert.match(serverSource, /groupsPending && isCurrentPlayerInvestigationCatalog\(catalog\)/);
  assert.match(serverSource, /progress\.status === "running" && progress\.stages\?\.select_groups\?\.status === "completed"/);
  assert.match(serverSource, /process\.kill\(persistedPid, 0\)/);
  assert.match(orchestrator, /allow_completed_command_change: bool = False/);
  assert.match(orchestrator, /self\.progress\["processId"\] = os\.getpid\(\)/);
  assert.match(orchestrator, /"fetch_profiles", profile_command, \[profiles\],[\s\S]*allow_completed_command_change=True/);
});

test("sentinel launcher enables bounded pseudo-scan parallelism", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "local-server.js"), "utf8");
  assert.match(serverSource, /"--pseudo-workers", String\(Math\.max\(1, Math\.min\(4/);
});

test("history API returns completed report metadata and matches launcher health version", async () => {
  const writeReport = (root, id, report) => {
    const directory = path.join(root, id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report), "utf8");
  };
  writeReport(process.env.PAPP_PLAYER_INVESTIGATIONS_DIR, "historical-single", {
    schema: "player-anomaly-sentinel-report-v1", status: "completed", account: "历史选手",
    generatedAtUtc: "2026-09-12T10:00:00Z",
    selection: { mode: "sentinel" },
    estimatedElo: {
      estimatedElo: null,
      status: "insufficient_target_games",
      statusReasons: ["fewer_than_minimum_complete_recent_target_games"],
      selectedGameCount: 3,
      formalMinimumGameCount: 10,
      formalMaximumGameCount: 30,
      formalEloMinimum: 1600,
      formalEloMaximum: 2500,
      excludedGamesWithReasons: [
        { gameId: "a", reason: "opponent_out_of_reference_range" },
        { gameId: "b", reason: "opponent_out_of_reference_range" },
        { gameId: "c", reason: "incomplete_phase_data" },
      ],
      databaseCalibrated95Intervals: [],
    },
  });
  writeReport(process.env.PAPP_PLAYER_INVESTIGATIONS_DIR, "unfinished-single", {
    status: "failed", account: "未完成选手", generatedAtUtc: "2026-09-13T10:00:00Z",
  });
  writeReport(process.env.PAPP_PLAYER_INVESTIGATION_BATCHES_DIR, "batch-history", {
    schema: "papp-batch-sentinel-report-v1", status: "completed", batchId: "batch-history",
    competitionName: "历史比赛", completedAt: "2026-09-13T10:00:00Z",
    totalCount: 1, completedCount: 0, failedCount: 1,
    results: [{ account: "历史选手", status: "failed", runId: "historical-single", error: "旧错误" }],
  });
  fs.copyFileSync(
    path.join(process.env.PAPP_PLAYER_INVESTIGATION_BATCHES_DIR, "batch-history", "report.json"),
    path.join(process.env.PAPP_PLAYER_INVESTIGATION_BATCHES_DIR, "batch-history", "progress.json"),
  );
  const batchProgressPath = path.join(
    process.env.PAPP_PLAYER_INVESTIGATION_BATCHES_DIR, "batch-history", "progress.json",
  );
  const batchProgress = JSON.parse(fs.readFileSync(batchProgressPath, "utf8"));
  batchProgress.schema = "papp-batch-sentinel-progress-v1";
  fs.writeFileSync(batchProgressPath, JSON.stringify(batchProgress), "utf8");
  const repaired = service.repairBatchSentinelResult("batch-history", "historical-single");
  assert.equal(repaired.completedCount, 1);
  assert.equal(repaired.failedCount, 0);
  assert.equal(repaired.results[0].status, "completed");
  assert.equal(repaired.results[0].repair.previousError, "旧错误");
  const server = service.server;
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const healthResponse = await fetch(`${base}/api/health`);
    const health = await healthResponse.json();
    const launcher = fs.readFileSync(path.resolve(__dirname, "../../打开PAPP前端.cmd"), "utf8");
    assert.equal(health.ok, true);
    assert.equal(health.version, launcher.match(/SERVER_VERSION=([^"\r\n]+)/)[1]);

    const response = await fetch(`${base}/api/player-investigation/history`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.ok(Array.isArray(payload.reports));
    assert.deepEqual(payload.reports.map((report) => report.type), ["batch", "single"]);
    let previousTimestamp = Number.POSITIVE_INFINITY;
    for (const report of payload.reports) {
      assert.ok(["single", "batch"].includes(report.type));
      assert.equal(report.status, "completed");
      const timestamp = Date.parse(report.generatedAt);
      assert.ok(Number.isFinite(timestamp));
      assert.ok(timestamp <= previousTimestamp);
      previousTimestamp = timestamp;
      if (report.type === "single") assert.ok(report.runId);
      if (report.type === "batch") assert.ok(report.batchId);
    }

    const historyPage = await fetch(`${base}/papp-portal/player-investigation/history.html`);
    assert.equal(historyPage.status, 200);
    assert.match(await historyPage.text(), /历史分析/);

    // Historical report JSON is sufficient even when progress/config are absent.
    const singleResponse = await fetch(`${base}/api/player-investigation/status?runId=historical-single`);
    assert.equal(singleResponse.status, 200);
    const single = await singleResponse.json();
    assert.equal(single.running, false);
    assert.equal(single.report.account, "历史选手");
    assert.equal(single.report.status, "completed");
    assert.deepEqual(single.report.sentinel.rating, {
      estimate: null,
      status: "insufficient_target_games",
      statusReasons: ["fewer_than_minimum_complete_recent_target_games"],
      selectedGameCount: 3,
      minimumGameCount: 10,
      maximumGameCount: 30,
      formalMinimum: 1600,
      formalMaximum: 2500,
      excludedGameCount: 3,
      excludedReasons: [
        { reason: "opponent_out_of_reference_range", count: 2 },
        { reason: "incomplete_phase_data", count: 1 },
      ],
      intervals: [],
    });
    const batchResponse = await fetch(`${base}/api/player-investigation/batch-status?batchId=batch-history`);
    assert.equal(batchResponse.status, 200);
    const batch = await batchResponse.json();
    assert.equal(batch.status, "completed");
    assert.equal(batch.results[0].runId, "historical-single");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
