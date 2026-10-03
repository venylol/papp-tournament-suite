"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "papp-combination-test-"));
process.env.PAPP_DATA_DIR = scratch;
process.env.PAPP_STATE_FILE = path.join(scratch, "state.json");
const { reportedAnalysisSummary } = require("./local-server.js");
const projectRoot = path.resolve(__dirname, "../..");
const runPath = "data/player-investigations/xiaojianbao-1790403714515-2/report.json";
const reportPath = fs.existsSync(path.join(projectRoot, runPath))
  ? path.join(projectRoot, runPath)
  : path.join(projectRoot, "artifacts/papp-release-20260913-01/PAPP-Offline", runPath);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

function render(results) {
  const source = fs.readFileSync(path.join(__dirname,
    "papp-portal/player-investigation/analysis.js"), "utf8");
  const start = source.indexOf("  function renderExactCombination(");
  const end = source.indexOf("  function renderReportedAnalysis(", start);
  assert.ok(start >= 0 && end > start);
  assert.ok(source.includes("renderExactCombination(section, data.exactCombinations);"));
  const output = { notes: [], rows: [] };
  const context = {
    formatMetricNumber: (value, digits) => value === null || value === undefined
      ? "—" : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits }),
    appendReportSection: (title, note) => {
      output.title = title;
      output.notes.push(note);
      return { append: (element) => output.notes.push(element.textContent) };
    },
    appendReportTable: (_, headers, rows) => Object.assign(output, { headers, rows }),
    document: { createElement: () => ({}) },
    results,
  };
  vm.runInNewContext(`${source.slice(start, end)}\nrenderExactCombination({}, results);`, context);
  return output;
}

test("saved report preserves both combination universes and tail positions", () => {
  const results = reportedAnalysisSummary(report).exactCombinations;
  assert.equal(results.length, 2);
  const [sameColor, allGames] = results;
  assert.equal(sameColor.statistic, "game_equal_mean_disc_loss");
  assert.equal(sameColor.universeGameCount, 16);
  assert.equal(sameColor.reportedGameCount, 1);
  assert.equal(sameColor.controlGameCount, 15);
  assert.equal(sameColor.combinationCount, 16);
  assert.equal(sameColor.evaluatedCombinationCount, 16);
  assert.equal(sameColor.ascendingRank, 7);
  assert.equal(sameColor.lowerTailPosition, 0.4375);
  assert.equal(sameColor.upperTailPosition, 0.625);
  assert.equal(sameColor.twoTailPosition, 0.875);
  assert.equal(allGames.universeGameCount, 30);
  assert.equal(allGames.ascendingRank, 11);
  assert.equal(allGames.lowerTailPosition, 0.366667);
  const view = render(results);
  assert.equal(view.title, "精确组合位置");
  assert.match(view.rows[0][0], /举报 1 \/ 对照 15/);
  assert.equal(view.rows[0][2], "全部枚举（精确）");
  assert.equal(view.rows[0][5], "7");
  assert.equal(view.rows[0][6], "43.75%");
  assert.equal(view.rows[1][6], "36.67%");
  assert.match(view.notes[0], /局等权/);
  assert.match(view.notes[0], /不是 Bootstrap 区间或作弊概率/);
});

test("sampled combinations are explicitly approximate and have no exact rank", () => {
  const results = reportedAnalysisSummary({ nonModel: { lossAndWld: {
    sameColorComparison: {
      reported: { gameCount: 3, gameWeightedMeanLoss: 0.4 },
      control: { gameCount: 97 },
      exactCombination: {
        status: "monte_carlo", combinationCount: 161700, sampledCombinationCount: 10000,
        lowerTailMonteCarloP: 0, upperTailMonteCarloP: 1, twoTailMonteCarloP: 0,
      },
    },
  } } }).exactCombinations;
  assert.equal(results[0].ascendingRank, null);
  assert.equal(results[0].evaluatedCombinationCount, 10000);
  const view = render(results);
  assert.equal(view.rows[0][2], "抽样估计（非精确）");
  assert.equal(view.rows[0][3], "161,700");
  assert.equal(view.rows[0][4], "10,000");
  assert.equal(view.rows[0][5], "—");
  assert.equal(view.rows[0][6], "0.00%");
  assert.equal(view.rows[0][7], "100.00%");
});

test("older reports show missing results instead of invented zero positions", () => {
  const results = reportedAnalysisSummary({}).exactCombinations;
  assert.equal(results[0].status, "unavailable");
  assert.equal(results[0].lowerTailPosition, null);
  const view = render(results);
  assert.equal(view.rows[0][2], "未提供结果");
  assert.equal(view.rows[0][6], "—");
  assert.match(render(undefined).notes[1], /未提供组合位置结果/);
});

test("updated analysis page and launcher identify the matching runtime", () => {
  const html = fs.readFileSync(path.join(__dirname,
    "papp-portal/player-investigation/analysis.html"), "utf8");
  assert.match(html, /analysis\.js\?v=papp-portal\.13/);
  const service = fs.readFileSync(path.join(__dirname, "local-server.js"), "utf8");
  const launcher = fs.readFileSync(path.join(projectRoot, "打开PAPP前端.cmd"), "utf8");
  assert.equal(service.match(/const SERVICE_VERSION = "([^"]+)"/)[1],
    launcher.match(/SERVER_VERSION=([^"\r\n]+)/)[1]);
});
