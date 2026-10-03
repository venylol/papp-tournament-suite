"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const service = require("./local-server.js");

test("initial import progress button is hidden without hiding the check-in recovery action", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const labels = Array.from(html.matchAll(
    /<label class="([^"]*)" for="import-json-input">\s*<svg[^>]*>\s*<use href="#i-upload"><\/use>\s*<\/svg>\s*导入进度\s*<\/label>/g,
  ));
  assert.equal(labels.length, 2);
  assert.match(labels[0][1], /(?:^|\s)hidden(?:\s|$)/);
  assert.doesNotMatch(labels[1][1], /(?:^|\s)hidden(?:\s|$)/);
});

test("reported prediction summary subtracts fixed observed reported-game values from bootstrap results", () => {
  const summary = service.reportedAnalysisSummary({
    model: {
      reportedBootstrap: {
        groups: {
          combined: {
            pointEstimates: {
              zero: { gameEqualActualRate: 0.65 },
              ge4: { gameEqualActualRate: 0.20 },
            },
          },
        },
        requestedReportedGroupMetrics: {
          actualPointEstimates: { expected_wld_loss: 0.04 },
          wldApplicableNodes: 8,
          pointEstimates: { zero: 0.70, ge4: 0.18, expected_wld_loss: 0.10 },
          bootstrap95PercentIntervals: {
            zero: { lower: 0.68, upper: 0.72 },
            ge4: { lower: 0.16, upper: 0.20 },
            expected_wld_loss: { lower: 0.08, upper: 0.12 },
          },
        },
      },
    },
  });
  const zero = summary.reportedPrediction.metrics.find((metric) => metric.key === "zero");
  const ge4 = summary.reportedPrediction.metrics.find((metric) => metric.key === "ge4");
  const wld = summary.reportedPrediction.metrics.find((metric) => metric.key === "expected_wld_loss");

  assert.equal(zero.reportedActual, 0.65);
  assert.ok(Math.abs(zero.difference - 0.05) < 1e-12);
  assert.ok(Math.abs(zero.differenceInterval.lower - 0.03) < 1e-12);
  assert.ok(Math.abs(zero.differenceInterval.upper - 0.07) < 1e-12);
  assert.equal(ge4.reportedActual, 0.20);
  assert.ok(Math.abs(ge4.difference - (-0.02)) < 1e-12);
  assert.equal(wld.reportedActual, 0.04);
  assert.ok(Math.abs(wld.difference - 0.06) < 1e-12);
  assert.ok(Math.abs(wld.differenceInterval.lower - 0.04) < 1e-12);
  assert.ok(Math.abs(wld.differenceInterval.upper - 0.08) < 1e-12);
});

test("analysis page cache key advances with the reported-versus-observed copy", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "papp-portal", "player-investigation", "analysis.html"),
    "utf8",
  );
  assert.match(html, /analysis\.js\?v=papp-portal\.13/);
});

test("model WLD prediction reports insufficient sample when no WLD node is applicable", () => {
  const summary = service.reportedAnalysisSummary({
    model: {
      reportedBootstrap: {
        requestedReportedGroupMetrics: {
          wldApplicableNodes: 0,
          pointEstimates: { expected_wld_loss: 0 },
          bootstrap95PercentIntervals: { expected_wld_loss: { lower: 0, upper: 0 } },
        },
      },
    },
  });
  const wld = summary.reportedPrediction.metrics.find(
    (metric) => metric.key === "expected_wld_loss",
  );
  assert.equal(wld.insufficientSample, true);
  assert.equal(wld.value, null);
  assert.equal(wld.interval, null);
});

test("unused front-end actions are hidden and score tools are grouped by workflow", () => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  for (const id of [
    "btn-call-mode",
    "btn-self-check-mapping",
    "btn-clear-mapping",
    "btn-import-score-pairings",
    "btn-import-papp-pairings",
  ]) {
    const match = html.match(new RegExp(`<[^>]+class="([^"]*)"[^>]+id="${id}"`));
    assert.ok(match, `${id} exists`);
    assert.match(match[1], /(?:^|\s)hidden(?:\s|$)/, `${id} is hidden`);
  }

  const schedule = html.indexOf('score-helper__group--schedule');
  const oq = html.indexOf('score-helper__group--oq');
  const exports = html.indexOf('score-helper__group--exports');
  const navigation = html.indexOf('score-helper__group--navigation');
  assert.ok(schedule > 0 && schedule < oq && oq < exports && exports < navigation);
  const exportBlock = html.slice(exports, navigation);
  assert.match(exportBlock, /btn-export-score-pairings-png/);
  assert.match(exportBlock, /btn-export-score-results-png/);
  assert.match(exportBlock, /btn-export-eg-performance-png/);
});

test("final pairing generation targets the round immediately after semifinals", () => {
  const app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  const start = app.indexOf("async function advanceFinalRegistration()");
  const end = app.indexOf("function navigateTournamentStep", start);
  const advance = app.slice(start, end);
  assert.match(advance, /const placementRound = scoreStageRound\("placement"\);/);
  assert.match(advance, /round: placementRound,/);
  assert.match(advance, /setPlayoffPairings\(placementRound, pairings, \{ stage: "placement" \}\);/);
  assert.doesNotMatch(advance, /round:\s*scoreStageRound\("semifinal"\)/);
});
