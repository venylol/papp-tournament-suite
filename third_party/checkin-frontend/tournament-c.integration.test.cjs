"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const { server } = require("./local-server.js");

const PAPP_C = process.env.PAPP_C_EXE
  ? path.resolve(process.env.PAPP_C_EXE)
  : path.resolve(__dirname, "..", "..", "bin", "Windows", "papp_GB.exe");
const ROUND_START = "2026-09-12T10:00:00+08:00";
const SCORE_WORKFILE_DIRECTORY = fs.mkdtempSync(path.join(os.tmpdir(), "papp-c-score-workfiles-"));
const scoreWorkfiles = new Map();

function scoreWorkfileFor(batchId) {
  if (!scoreWorkfiles.has(batchId)) {
    scoreWorkfiles.set(batchId, path.join(SCORE_WORKFILE_DIRECTORY,
      `workfile-${scoreWorkfiles.size + 1}.txt`));
  }
  return scoreWorkfiles.get(batchId);
}

function players(count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    displayName: ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"][index],
    account: `acct_${String.fromCharCode(97 + index)}`,
  }));
}

function invokePappC(payload, workfileKey = payload.batchId) {
  const scoreBatch = payload.operation === "write-score-batch" ||
    payload.operation === "read-score-batch";
  const child = spawnSync(PAPP_C, ["--tournament-json"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: scoreBatch ? {
      ...process.env,
      PAPP_TOURNAMENT_WORKFILE: scoreWorkfileFor(workfileKey),
    } : process.env,
  });
  assert.ifError(child.error);
  assert.equal(typeof child.stdout, "string", child.stderr);
  let response;
  try {
    response = JSON.parse(child.stdout);
  } catch (error) {
    assert.fail(`PAPP C did not return JSON: ${error.message}; stdout=${child.stdout}; stderr=${child.stderr}`);
  }
  return { response, exitCode: child.status, stderr: child.stderr };
}

function completePreliminary(playersValue = players(4)) {
  const pairings = [
    { id: "pre-1", blackId: "p1", whiteId: "p2", blackScore: 64, whiteScore: 0, status: "completed" },
    { id: "pre-2", blackId: "p3", whiteId: "p4", blackScore: 64, whiteScore: 0, status: "completed" },
  ];
  if (playersValue.length === 5) {
    pairings.push({ id: "pre-bye", playerId: "p5", status: "bye" });
  }
  return [{ round: 1, pairings }];
}

function twoRoundHistory(secondRound = [
  { id: "r2-1", blackId: "p1", whiteId: "p3", blackScore: 64, whiteScore: 0, status: "completed" },
  { id: "r2-2", blackId: "p2", whiteId: "p4", blackScore: 64, whiteScore: 0, status: "completed" },
]) {
  return [
    { round: 1, pairings: [
      { id: "r1-1", blackId: "p1", whiteId: "p2", blackScore: 64, whiteScore: 0, status: "completed" },
      { id: "r1-2", blackId: "p3", whiteId: "p4", blackScore: 64, whiteScore: 0, status: "completed" },
    ] },
    { round: 2, pairings: secondRound },
  ];
}

test("the rebuilt Windows C entry implements automatic/manual round counts and score validation", () => {
  const auto = invokePappC({ operation: "round-count", playerCount: 5 }).response;
  const zero = invokePappC({ operation: "round-count", playerCount: 0 }).response;
  const aboveFloor = invokePappC({ operation: "round-count", playerCount: 17 }).response;
  const manual = invokePappC({ operation: "round-count", playerCount: 5, manualRoundCount: 3 }).response;
  const tooMany = invokePappC({ operation: "round-count", playerCount: 5, manualRoundCount: 129 }).response;
  const complement = invokePappC({ operation: "validate-score", blackScore: 37 }).response;
  const invalid = invokePappC({ operation: "validate-score", blackScore: 64, whiteScore: 1 }).response;

  assert.equal(auto.source, "papp-c");
  assert.equal(auto.roundCount, 4);
  assert.equal(zero.roundCount, 4);
  assert.equal(aboveFloor.roundCount, 5);
  for (const [playerCount, expected] of [[1, 4], [15, 4], [16, 5], [31, 5], [32, 6], [63, 6], [64, 7], [127, 7], [128, 8], [255, 8], [256, 9]]) {
    const result = invokePappC({ operation: "round-count", playerCount }).response;
    assert.equal(result.source, "papp-c");
    assert.equal(result.roundCount, expected, `automatic rounds for ${playerCount} players`);
  }
  assert.equal(manual.roundCount, 3);
  assert.equal(tooMany.ok, false);
  assert.deepEqual(complement.scorePair, { blackScore: 37, whiteScore: 27 });
  assert.equal(invalid.ok, false);
});

test("C skip-semifinal flow returns the direct final, validates its stage, and preserves later preliminary ranks", () => {
  const roster = players(4);
  const common = {
    players: roster,
    preliminaryRoundCount: 1,
    tournamentParameters: { hasSemifinalAndFinal: true, skipSemifinal: true, brightwellConstant: 0 },
    skipSemifinal: true,
    rounds: completePreliminary(roster),
  };
  const preliminary = invokePappC({ operation: "preliminary-standings", ...common }).response;
  const directFinal = invokePappC({
    operation: "pairings", stage: "placement", round: 2, ...common,
  }).response;
  assert.equal(directFinal.ok, true, JSON.stringify(directFinal));
  assert.equal(directFinal.source, "papp-c");
  assert.equal(directFinal.stage, "placement");
  assert.equal(directFinal.round, 2);
  assert.equal(directFinal.pairings.length, 1);
  assert.equal(directFinal.pairings[0].phase, "final");
  assert.deepEqual(
    [directFinal.pairings[0].blackId, directFinal.pairings[0].whiteId].sort(),
    preliminary.standings.slice(0, 2).map(row => row.playerId).sort(),
  );

  const pending = invokePappC({
    operation: "stage-status", stage: "placement", round: 2,
    placementPairings: directFinal.pairings, ...common,
  }).response;
  assert.equal(pending.canAdvance, false);
  assert.equal(pending.code, "placement-results-incomplete");

  const completedFinal = [{
    ...directFinal.pairings[0], blackScore: 32, whiteScore: 32, status: "completed",
  }];
  const complete = invokePappC({
    operation: "stage-status", stage: "placement", round: 2,
    placementPairings: completedFinal, ...common,
  }).response;
  assert.equal(complete.canAdvance, true, JSON.stringify(complete));
  assert.equal(complete.nextStage, "overall-ranking");

  const overall = invokePappC({
    operation: "overall-standings", placementPairings: completedFinal, ...common,
  }).response;
  assert.equal(overall.stageProgress.complete, true);
  assert.deepEqual(
    overall.standings.slice(2).map(row => row.playerId),
    preliminary.standings.slice(2).map(row => row.playerId),
  );
});

test("native C pairing returns mapped player sides and handles an odd field with one Bye", () => {
  const roster = players(5);
  const { response, exitCode } = invokePappC({
    operation: "pairings",
    stage: "preliminary",
    round: 1,
    preliminaryRoundCount: 1,
    players: roster,
    presentPlayerIds: roster.map((player) => player.id),
  });

  assert.equal(exitCode, 0, JSON.stringify(response));
  assert.equal(response.source, "papp-c");
  assert.equal(response.pairings.length, 3);
  const byes = response.pairings.filter((pairing) => pairing.status === "bye");
  assert.equal(byes.length, 1);
  assert.deepEqual([byes[0].blackScore, byes[0].whiteScore, byes[0].displayPoints], [40, 24, 1]);
  const covered = response.pairings.flatMap((pairing) => pairing.status === "bye"
    ? [pairing.blackId]
    : [pairing.blackId, pairing.whiteId]);
  assert.deepEqual(covered.slice().sort(), roster.map((player) => player.id).sort());
  assert.ok(response.pairings.every((pairing) => pairing.source === "papp-c"));
});

test("native C second-round pairings use prior opponents and color history", () => {
  const roster = players(4);
  const firstRound = [{ round: 1, pairings: [
    { id: "r1-1", blackId: "p1", whiteId: "p2", blackScore: 32, whiteScore: 32, status: "completed" },
    { id: "r1-2", blackId: "p3", whiteId: "p4", blackScore: 32, whiteScore: 32, status: "completed" },
  ] }];
  const { response, exitCode } = invokePappC({
    operation: "pairings",
    stage: "preliminary",
    round: 2,
    preliminaryRoundCount: 2,
    players: roster,
    rounds: firstRound,
    presentPlayerIds: roster.map((player) => player.id),
  });

  assert.equal(exitCode, 0, JSON.stringify(response));
  assert.equal(response.source, "papp-c");
  const firstOpponents = new Set(["p1/p2", "p3/p4"]);
  for (const pairing of response.pairings) {
    assert.equal(pairing.status, "imported");
    assert.equal(firstOpponents.has([pairing.blackId, pairing.whiteId].sort().join("/")), false);
  }
  const colors = new Map(roster.map((player) => [player.id, { black: 0, white: 0 }]));
  for (const pairing of [...firstRound[0].pairings, ...response.pairings]) {
    colors.get(pairing.blackId).black += 1;
    colors.get(pairing.whiteId).white += 1;
  }
  for (const counts of colors.values()) assert.ok(Math.abs(counts.black - counts.white) <= 1);
});

test("C validates imported pairing identity, coverage, names, scores, and Bye data", () => {
  const roster = players(5);
  const { response, exitCode } = invokePappC({
    operation: "validate-pairings",
    preliminaryRoundCount: 1,
    players: roster,
    presentPlayerIds: roster.map((player) => player.id),
    pairings: [
      { id: "manual-1", blackId: "p1", whiteId: "p2", blackScore: 40, whiteScore: 24, status: "ready" },
      { id: "manual-2", blackId: "p3", whiteId: "p4", status: "imported" },
      { id: "manual-bye", playerId: "p5", status: "bye" },
    ],
  });

  assert.equal(exitCode, 0, JSON.stringify(response));
  assert.equal(response.validationSource, "papp-c");
  assert.equal(response.pairings[0].blackName, "Alpha");
  assert.equal(response.pairings[0].whiteName, "Bravo");
  assert.deepEqual([response.pairings[0].blackScore, response.pairings[0].whiteScore], [40, 24]);
  assert.deepEqual([response.pairings[2].status, response.pairings[2].blackId,
    response.pairings[2].blackScore, response.pairings[2].whiteScore], ["bye", "p5", 40, 24]);
  assert.equal(response.pairings[2].blackAccount, "acct_e");
});

test("C returns both half-point ticks and display points for wins and draws", () => {
  const payload = {
    operation: "preliminary-standings",
    players: players(4),
    preliminaryRoundCount: 1,
    tournamentParameters: { hasSemifinalAndFinal: false, brightwellConstant: 0 },
    rounds: [{ round: 1, pairings: [
      { blackId: "p1", whiteId: "p2", blackScore: 64, whiteScore: 0, status: "completed" },
      { blackId: "p3", whiteId: "p4", blackScore: 32, whiteScore: 32, status: "completed" },
    ] }],
  };
  const standingsResult = invokePappC(payload).response;
  const byId = Object.fromEntries(standingsResult.standings.map((row) => [row.playerId, row]));

  assert.equal(standingsResult.source, "papp-c");
  assert.equal(standingsResult.pointsUnit, "half-point-ticks");
  assert.deepEqual([byId.p1.pointsHalfUnits, byId.p1.displayPoints, byId.p1.totalPoints], [2, 1, 1]);
  assert.deepEqual([byId.p3.pointsHalfUnits, byId.p3.displayPoints, byId.p3.totalPoints], [1, 0.5, 0.5]);
  assert.equal(byId.p1.brightwell, byId.p1.totalDiscs, "zero Brightwell uses the native disc-count tie-break");
  const fractional = invokePappC({
    ...payload,
    tournamentParameters: { hasSemifinalAndFinal: false, brightwellConstant: 1.25 },
  }).response;
  assert.ok(fractional.standings.every((row) => Number.isFinite(row.brightwell)));
});

test("round-standings uses only completed history through the requested round", () => {
  const common = {
    players: players(4),
    preliminaryRoundCount: 2,
    tournamentParameters: { hasSemifinalAndFinal: false, brightwellConstant: 0 },
  };
  const roundOne = invokePappC({
    operation: "round-standings",
    round: 1,
    ...common,
    rounds: twoRoundHistory(),
  }).response;
  const reversedFuture = invokePappC({
    operation: "round-standings",
    round: 1,
    ...common,
    rounds: twoRoundHistory([
      { id: "r2-1", blackId: "p1", whiteId: "p3", blackScore: 0, whiteScore: 64, status: "completed" },
      { id: "r2-2", blackId: "p2", whiteId: "p4", blackScore: 0, whiteScore: 64, status: "completed" },
    ]),
  }).response;
  const roundTwo = invokePappC({
    operation: "round-standings",
    round: 2,
    ...common,
    rounds: twoRoundHistory(),
  }).response;
  const roundOneById = Object.fromEntries(roundOne.standings.map((row) => [row.playerId, row]));
  const roundTwoById = Object.fromEntries(roundTwo.standings.map((row) => [row.playerId, row]));

  assert.equal(roundOne.ok, true);
  assert.equal(roundOne.source, "papp-c");
  assert.equal(roundOne.operation, "round-standings");
  assert.equal(roundOne.round, 1);
  assert.equal(roundOne.targetRound, 1);
  assert.equal(roundOne.throughRound, 1);
  assert.equal(roundOne.complete, true);
  assert.equal(roundOne.roundComplete, true);
  assert.equal(roundOne.progress.complete, true);
  assert.deepEqual(roundOne.standings.map((row) => row.rank).sort(), [1, 2, 3, 4]);
  assert.equal(roundOneById.p1.pointsHalfUnits, 2);
  assert.equal(roundOneById.p2.pointsHalfUnits, 0);
  assert.deepEqual(reversedFuture.standings, roundOne.standings,
    "changing a later round must not change the requested historical ranking");

  assert.equal(roundTwo.round, 2);
  assert.equal(roundTwo.targetRound, 2);
  assert.equal(roundTwo.throughRound, 2);
  assert.equal(roundTwo.complete, true);
  assert.equal(roundTwo.progress.complete, true);
  assert.equal(roundTwoById.p1.rank, 1);
  assert.equal(roundTwoById.p1.pointsHalfUnits, 4);
  assert.equal(roundTwoById.p2.pointsHalfUnits, 2);
  assert.equal(roundTwoById.p3.pointsHalfUnits, 2);
  assert.equal(roundTwoById.p4.pointsHalfUnits, 0);
});

test("round-standings distinguishes missing, incomplete, and invalid round results", () => {
  const common = {
    players: players(4),
    preliminaryRoundCount: 2,
    tournamentParameters: { hasSemifinalAndFinal: false, brightwellConstant: 0 },
  };
  const missing = invokePappC({
    operation: "round-standings",
    round: 1,
    ...common,
    rounds: [],
  }).response;
  const incomplete = invokePappC({
    operation: "round-standings",
    round: 2,
    ...common,
    rounds: [
      twoRoundHistory()[0],
      { round: 2, pairings: [
        { id: "r2-1", blackId: "p1", whiteId: "p3", status: "completed", blackScore: 64, whiteScore: 0 },
        { id: "r2-2", blackId: "p2", whiteId: "p4", status: "ready", blackScore: null, whiteScore: null },
      ] },
    ],
  }).response;
  const invalid = invokePappC({
    operation: "round-standings",
    round: 2,
    ...common,
    rounds: [
      twoRoundHistory()[0],
      { round: 2, pairings: [
        { id: "r2-1", blackId: "p1", whiteId: "p3", status: "completed", blackScore: 64, whiteScore: 1 },
        { id: "r2-2", blackId: "p2", whiteId: "p4", status: "completed", blackScore: 64, whiteScore: 0 },
      ] },
    ],
  }).response;
  const emptyBye = invokePappC({
    operation: "round-standings",
    round: 1,
    ...common,
    rounds: [{ round: 1, pairings: [{ id: "empty-bye", status: "bye" }] }],
  }).response;
  const outOfRange = invokePappC({
    operation: "round-standings",
    round: 3,
    ...common,
    rounds: twoRoundHistory(),
  }).response;

  assert.equal(missing.ok, true);
  assert.equal(missing.round, 1);
  assert.equal(missing.complete, false);
  assert.equal(missing.roundComplete, false);
  assert.equal(missing.roundStatus, "missing");
  assert.equal(missing.code, "round-missing");
  assert.deepEqual(missing.standings, []);

  assert.equal(incomplete.ok, true);
  assert.equal(incomplete.round, 2);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.roundComplete, false);
  assert.equal(incomplete.roundStatus, "incomplete");
  assert.equal(incomplete.code, "round-results-incomplete");
  assert.equal(incomplete.blockingRound, 2);
  assert.deepEqual(incomplete.standings, []);

  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, "invalid-score-pair");
  assert.equal(emptyBye.ok, false);
  assert.equal(emptyBye.code, "invalid-bye");
  assert.equal(Object.hasOwn(emptyBye, "standings"), false);
  assert.equal(outOfRange.ok, false);
  assert.equal(outOfRange.code, "invalid-round-index");
});

test("round-standings returns completed early rounds before preliminary play is finished", () => {
  const response = invokePappC({
    operation: "round-standings",
    round: 1,
    players: players(4),
    preliminaryRoundCount: 3,
    tournamentParameters: { hasSemifinalAndFinal: true, brightwellConstant: 0 },
    rounds: [twoRoundHistory()[0]],
  }).response;

  assert.equal(response.ok, true);
  assert.equal(response.complete, true);
  assert.equal(response.roundComplete, true);
  assert.equal(response.progress.complete, false);
  assert.equal(response.stageProgress.complete, false);
  assert.equal(response.nextStage, "preliminary-registration");
  assert.equal(response.standings.length, 4);
});

test("C owns no-playoff standings, semifinal seeds, tie advancement, and placement ranking", () => {
  const roster = players(4);
  const rounds = completePreliminary(roster);
  const common = {
    players: roster,
    preliminaryRoundCount: 1,
    tournamentParameters: { hasSemifinalAndFinal: true, brightwellConstant: 0 },
    rounds,
  };
  const standings = invokePappC({ operation: "preliminary-standings", ...common }).response;
  const beforeSemifinal = invokePappC({ operation: "overall-standings", ...common }).response;
  assert.equal(beforeSemifinal.stageProgress.complete, false);
  assert.equal(beforeSemifinal.nextStage, "semifinal-registration");
  assert.deepEqual(beforeSemifinal.standings, []);
  const rankById = Object.fromEntries(standings.standings.map((row) => [row.playerId, row.rank]));
  const semifinals = invokePappC({
    operation: "pairings", stage: "semifinal", round: 2, ...common,
  }).response;
  const semifinalPlayerSets = semifinals.pairings.map((pairing) =>
    [pairing.blackId, pairing.whiteId].sort().join("/"),
  ).sort();
  assert.deepEqual(semifinalPlayerSets, [
    [standings.standings[0].playerId, standings.standings[3].playerId].sort().join("/"),
    [standings.standings[1].playerId, standings.standings[2].playerId].sort().join("/"),
  ].sort());

  const semisCompleted = semifinals.pairings.map((pairing, index) => ({
    ...pairing,
    blackScore: index === 0 ? 32 : 64,
    whiteScore: index === 0 ? 32 : 0,
    status: "completed",
  }));
  const placement = invokePappC({
    operation: "pairings",
    stage: "placement",
    round: 3,
    ...common,
    semifinalPairings: semisCompleted,
  }).response;
  assert.deepEqual(placement.pairings.map((pairing) => pairing.phase), ["final", "third-place"]);

  const afterSemifinal = invokePappC({
    operation: "overall-standings",
    ...common,
    semifinalPairings: semisCompleted,
  }).response;
  assert.equal(afterSemifinal.stageProgress.complete, false);
  assert.equal(afterSemifinal.nextStage, "placement-registration");
  assert.deepEqual(afterSemifinal.standings, []);

  const finalPairings = placement.pairings.map((pairing) => ({
    ...pairing,
    blackScore: 32,
    whiteScore: 32,
    status: "completed",
  }));
  const onePlacementComplete = finalPairings.map((pairing, index) => index === 0
    ? pairing
    : { ...pairing, blackScore: null, whiteScore: null, status: "imported" });
  const afterOnePlacement = invokePappC({
    operation: "overall-standings",
    ...common,
    semifinalPairings: semisCompleted,
    placementPairings: onePlacementComplete,
  }).response;
  assert.equal(afterOnePlacement.stageProgress.complete, false);
  assert.equal(afterOnePlacement.nextStage, "placement-score-registration");
  assert.deepEqual(afterOnePlacement.standings, []);
  const overall = invokePappC({
    operation: "overall-standings",
    ...common,
    semifinalPairings: semisCompleted,
    placementPairings: finalPairings,
  }).response;
  const finalMatch = finalPairings.find((pairing) => pairing.phase === "final");
  const thirdMatch = finalPairings.find((pairing) => pairing.phase === "third-place");
  const higherSeed = (pairing) => rankById[pairing.blackId] < rankById[pairing.whiteId]
    ? pairing.blackId
    : pairing.whiteId;
  assert.deepEqual(overall.standings.slice(0, 4).map((row) => row.playerId), [
    higherSeed(finalMatch),
    finalMatch.blackId === higherSeed(finalMatch) ? finalMatch.whiteId : finalMatch.blackId,
    higherSeed(thirdMatch),
    thirdMatch.blackId === higherSeed(thirdMatch) ? thirdMatch.whiteId : thirdMatch.blackId,
  ]);

  const noPlayoff = invokePappC({
    operation: "overall-standings",
    ...common,
    tournamentParameters: { hasSemifinalAndFinal: false, brightwellConstant: 0 },
  }).response;
  assert.equal(noPlayoff.stageProgress.complete, true);
  assert.equal(noPlayoff.standings.length, 4);
  assert.equal(noPlayoff.nextStage, "complete");
  assert.equal(noPlayoff.mode, "preliminary-only");
  assert.deepEqual(noPlayoff.standings.map((row) => row.playerId), standings.standings.map((row) => row.playerId));

  const preliminaryStage = invokePappC({
    operation: "stage-status", stage: "preliminary", round: 1, ...common,
  }).response;
  const noPlayoffStage = invokePappC({
    operation: "stage-status", stage: "preliminary", round: 1,
    ...common,
    tournamentParameters: { hasSemifinalAndFinal: false, brightwellConstant: 0 },
  }).response;
  assert.equal(preliminaryStage.canAdvance, true);
  assert.equal(preliminaryStage.nextStage, "preliminary-ranking");
  assert.equal(noPlayoffStage.nextStage, "overall-ranking");
});

test("C keeps fifth and later places in preliminary C order after the playoffs", () => {
  const roster = players(6);
  const rounds = [{ round: 1, pairings: [
    { id: "pre-1", blackId: "p1", whiteId: "p2", blackScore: 64, whiteScore: 0, status: "completed" },
    { id: "pre-2", blackId: "p3", whiteId: "p4", blackScore: 64, whiteScore: 0, status: "completed" },
    { id: "pre-3", blackId: "p5", whiteId: "p6", blackScore: 32, whiteScore: 32, status: "completed" },
  ] }];
  const common = {
    players: roster,
    preliminaryRoundCount: 1,
    tournamentParameters: { hasSemifinalAndFinal: true, brightwellConstant: 0 },
    rounds,
  };
  const preliminary = invokePappC({ operation: "preliminary-standings", ...common }).response;
  const semifinals = invokePappC({ operation: "pairings", stage: "semifinal", ...common }).response;
  assert.equal(semifinals.ok, true, JSON.stringify(semifinals));
  const semisCompleted = semifinals.pairings.map((pairing) => ({
    ...pairing, blackScore: 64, whiteScore: 0, status: "completed",
  }));
  const placement = invokePappC({
    operation: "pairings", stage: "placement", ...common,
    semifinalPairings: semisCompleted,
  }).response;
  const placementsCompleted = placement.pairings.map((pairing) => ({
    ...pairing, blackScore: 32, whiteScore: 32, status: "completed",
  }));
  const overall = invokePappC({
    operation: "overall-standings", ...common,
    semifinalPairings: semisCompleted,
    placementPairings: placementsCompleted,
  }).response;

  assert.deepEqual(
    overall.standings.slice(4).map((row) => row.playerId),
    preliminary.standings.slice(4).map((row) => row.playerId),
  );
});

test("C stage status blocks incomplete rounds and validates playoff phase pairings", () => {
  const roster = players(4);
  const rounds = completePreliminary(roster);
  const common = {
    players: roster,
    preliminaryRoundCount: 1,
    tournamentParameters: { hasSemifinalAndFinal: true, brightwellConstant: 0 },
    rounds,
  };
  const incomplete = invokePappC({
    operation: "stage-status", stage: "preliminary", round: 1,
    ...common,
    rounds: [{ round: 1, pairings: [{ ...rounds[0].pairings[0], status: "ready" }, rounds[0].pairings[1]] }],
  }).response;
  assert.equal(incomplete.canAdvance, false);
  assert.equal(incomplete.progress.unresolvedPairings, 1);

  const semifinalPairings = invokePappC({
    operation: "pairings", stage: "semifinal", ...common,
  }).response.pairings;
  const validatedSemis = invokePappC({
    operation: "validate-pairings", stage: "semifinal", round: 2,
    ...common,
    pairings: semifinalPairings,
  }).response;
  assert.equal(validatedSemis.ok, true);
  const wrongSeeds = invokePappC({
    operation: "validate-pairings", stage: "semifinal", round: 2,
    ...common,
    pairings: [{ id: "bad-1", blackId: "p1", whiteId: "p2" },
      { id: "bad-2", blackId: "p3", whiteId: "p4" }],
  }).response;
  assert.equal(wrongSeeds.code, "semifinal-pairings-invalid");
});

function scoreBatchRequest(batchId = "score-batch-native-workfile") {
  const roster = players(4);
  return {
    operation: "write-score-batch",
    stage: "preliminary",
    round: 1,
    batchId,
    tournamentName: "PAPP workfile score test",
    preliminaryRoundCount: 1,
    roundCount: 1,
    hasSemifinalAndFinal: false,
    players: roster,
    presentPlayerIds: roster.map((player) => player.id),
    pairings: [
      {
        id: "pairing-1", table: 1, blackId: "p1", whiteId: "p2",
        black: "Alpha", white: "Bravo", blackAccount: "acct_a", whiteAccount: "acct_b",
        blackScore: 40, whiteScore: 24, status: "ready",
      },
      {
        id: "pairing-2", table: 2, blackId: "p3", whiteId: "p4",
        black: "Charlie", white: "Delta", blackAccount: "acct_c", whiteAccount: "acct_d",
        blackScore: 32, whiteScore: 32, status: "ready",
      },
    ],
  };
}

test("C writes an idempotent score batch into a native PAPP workfile and reads it back", () => {
  const request = scoreBatchRequest();
  const workfile = scoreWorkfileFor(request.batchId);
  const firstWrite = invokePappC(request);
  assert.equal(firstWrite.exitCode, 0, JSON.stringify(firstWrite.response));
  assert.equal(firstWrite.response.ok, true);
  assert.equal(firstWrite.response.accepted, true);
  assert.equal(firstWrite.response.idempotent, false);

  const nativeWorkfile = fs.readFileSync(workfile, "utf8");
  assert.match(nativeWorkfile, /# PAPP-TOURNAMENT-ADAPTER-WORKFILE-V1/);
  assert.match(nativeWorkfile, /raz-couplage;/);
  assert.match(nativeWorkfile, /ronde-suivante;/);
  assert.match(nativeWorkfile, /# PAPP-TOURNAMENT-SCORE-BATCH-V1 /);

  const retry = invokePappC(request);
  assert.equal(retry.exitCode, 0, JSON.stringify(retry.response));
  assert.equal(retry.response.accepted, true);
  assert.equal(retry.response.idempotent, true);

  const readback = invokePappC({
    ...request,
    operation: "read-score-batch",
    pairingIds: request.pairings.map((pairing) => pairing.id),
  });
  assert.equal(readback.exitCode, 0, JSON.stringify(readback.response));
  assert.deepEqual(readback.response.pairings.map((pairing) => ({
    id: pairing.id,
    table: pairing.table,
    blackId: pairing.blackId,
    whiteId: pairing.whiteId,
    blackScore: pairing.blackScore,
    whiteScore: pairing.whiteScore,
    status: pairing.status,
  })), request.pairings.map((pairing) => ({
    id: pairing.id,
    table: pairing.table,
    blackId: pairing.blackId,
    whiteId: pairing.whiteId,
    blackScore: pairing.blackScore,
    whiteScore: pairing.whiteScore,
    status: "completed",
  })));
});

test("native PAPP workfile does not mark future tournament rounds as played", () => {
  const request = scoreBatchRequest("score-batch-no-future-rounds");
  request.preliminaryRoundCount = 4;
  request.roundCount = 4;
  request.hasSemifinalAndFinal = true;
  const workfile = scoreWorkfileFor(request.batchId);

  const write = invokePappC(request);
  assert.equal(write.exitCode, 0, JSON.stringify(write.response));
  assert.equal(write.response.accepted, true);
  const nativeWorkfile = fs.readFileSync(workfile, "utf8");
  assert.match(nativeWorkfile, /#_Nombre-Rondes = 6/);
  assert.match(nativeWorkfile, /Results of round 1/);
  assert.doesNotMatch(nativeWorkfile, /Results of round 2/);
  assert.equal((nativeWorkfile.match(/ronde-suivante;/g) || []).length, 1);

  const readback = invokePappC({
    ...request,
    operation: "read-score-batch",
    pairingIds: request.pairings.map((pairing) => pairing.id),
  });
  assert.equal(readback.response.ok, true, JSON.stringify(readback.response));
});

test("C can write the next score batch after one empty native round was advanced", () => {
  const workfileKey = "score-batch-empty-advanced-round";
  const persistedRequests = [];
  for (let round = 1; round <= 3; round++) {
    const request = scoreBatchRequest(`${workfileKey}-r${round}`);
    request.round = round;
    request.preliminaryRoundCount = 4;
    request.roundCount = 4;
    const write = invokePappC(request, workfileKey);
    assert.equal(write.exitCode, 0, JSON.stringify(write.response));
    assert.equal(write.response.accepted, true);
    persistedRequests.push(request);
  }

  const workfile = scoreWorkfileFor(workfileKey);
  const nativeWorkfile = fs.readFileSync(workfile, "utf8");
  const metadataOffset = nativeWorkfile.search(/^# PAPP-TOURNAMENT-SCORE-BATCH-V1 /m);
  assert.notEqual(metadataOffset, -1, "workfile must contain persisted batch metadata");
  const emptyRound = [
    "% Players inscribed for round 4",
    "",
    "& +000001 +000002 +000003 +000004;",
    "",
    "% Results of round 4",
    "",
    "raz-couplage;",
    "ronde-suivante;",
    "",
  ].join(os.EOL);
  const advancedWorkfile =
    nativeWorkfile.slice(0, metadataOffset) + emptyRound + nativeWorkfile.slice(metadataOffset);
  fs.writeFileSync(workfile, advancedWorkfile, "utf8");

  const nextRound = scoreBatchRequest(`${workfileKey}-r4`);
  nextRound.round = 4;
  nextRound.preliminaryRoundCount = 4;
  nextRound.roundCount = 4;

  const extraRound = [
    "% Players inscribed for round 5",
    "",
    "& +000001 +000002 +000003 +000004;",
    "",
    "% Results of round 5",
    "",
    "raz-couplage;",
    "ronde-suivante;",
    "",
  ].join(os.EOL);
  const advancedMetadataOffset = advancedWorkfile.search(/^# PAPP-TOURNAMENT-SCORE-BATCH-V1 /m);
  const twiceAdvancedWorkfile = advancedWorkfile.slice(0, advancedMetadataOffset) +
    extraRound + advancedWorkfile.slice(advancedMetadataOffset);
  fs.writeFileSync(workfile, twiceAdvancedWorkfile, "utf8");
  const tooFarAhead = invokePappC(nextRound, workfileKey);
  assert.equal(tooFarAhead.response.ok, false,
    "more than one unpersisted round must remain an error");
  assert.equal(fs.readFileSync(workfile, "utf8"), twiceAdvancedWorkfile,
    "a rejected repair must not modify the existing workfile");
  fs.writeFileSync(workfile, advancedWorkfile, "utf8");

  const readbackBeforeRepair = invokePappC({
    ...persistedRequests[2],
    operation: "read-score-batch",
    pairingIds: persistedRequests[2].pairings.map((pairing) => pairing.id),
  }, workfileKey);
  assert.equal(readbackBeforeRepair.response.ok, false,
    "readback must still reject an unpersisted advanced round");
  assert.equal(readbackBeforeRepair.response.code, "native-score-round-mismatch");

  const write = invokePappC(nextRound, workfileKey);
  assert.equal(write.exitCode, 0, JSON.stringify(write.response));
  assert.equal(write.response.accepted, true);

  const repairedWorkfile = fs.readFileSync(workfile, "utf8");
  assert.equal((repairedWorkfile.match(/^% Results of round \d+\r?$/gm) || []).length, 4);
  assert.equal((repairedWorkfile.match(/^\(000001\s+40\s+000002\s+24\);\r?$/gm) || []).length, 4);
  assert.equal((repairedWorkfile.match(/^\(000003\s+32\s+000004\s+32\);\r?$/gm) || []).length, 4);

  const readback = invokePappC({
    ...nextRound,
    operation: "read-score-batch",
    pairingIds: nextRound.pairings.map((pairing) => pairing.id),
  }, workfileKey);
  assert.equal(readback.exitCode, 0, JSON.stringify(readback.response));
  assert.equal(readback.response.ok, true, JSON.stringify(readback.response));
  assert.equal(readback.response.verified, true);
});

test("C rejects batch scores outside the 0–64, total-64 rule without persisting them", () => {
  const request = scoreBatchRequest("score-batch-invalid-score");
  request.pairings[0].whiteScore = 25;
  const result = invokePappC(request);
  assert.equal(result.response.ok, false);
  assert.match(result.response.message, /整数比分|64/);
  assert.equal(fs.existsSync(scoreWorkfileFor(request.batchId)), false);
});

test("C rejects score rows whose names or accounts do not match the PAPP player IDs", () => {
  const request = scoreBatchRequest("score-batch-invalid-identity");
  request.pairings[0].black = "different player";
  const result = invokePappC(request);
  assert.equal(result.response.ok, false);
  assert.match(result.response.message, /PAPP 选手身份/);
  assert.equal(fs.existsSync(scoreWorkfileFor(request.batchId)), false);
});

test("C rejects readback when the persisted native PAPP score no longer matches the batch", () => {
  const request = scoreBatchRequest("score-batch-native-mismatch");
  const workfile = scoreWorkfileFor(request.batchId);
  const write = invokePappC(request);
  assert.equal(write.exitCode, 0, JSON.stringify(write.response));

  const nativeWorkfile = fs.readFileSync(workfile, "utf8");
  const corruptedWorkfile = nativeWorkfile.replace(
    /^(\(\s*000001\s+)40(\s+000002\s+)24(\s*\);)$/m,
    "$139$225$3",
  );
  assert.notEqual(corruptedWorkfile, nativeWorkfile, "test fixture must change the native result row");
  fs.writeFileSync(workfile, corruptedWorkfile, "utf8");

  const readback = invokePappC({
    ...request,
    operation: "read-score-batch",
    pairingIds: request.pairings.map((pairing) => pairing.id),
  });
  assert.equal(readback.response.ok, false);
  assert.match(readback.response.message, /原生轮次比分|PAPP workfile/);
});

test("C rejects a duplicate native result row during PAPP workfile readback", () => {
  const request = scoreBatchRequest("score-batch-native-duplicate");
  const workfile = scoreWorkfileFor(request.batchId);
  const write = invokePappC(request);
  assert.equal(write.exitCode, 0, JSON.stringify(write.response));

  const nativeWorkfile = fs.readFileSync(workfile, "utf8");
  const duplicatedWorkfile = nativeWorkfile.replace(
    /^(\(000001[^\r\n]*\);\r?\n)/m,
    "$1$1",
  );
  assert.notEqual(duplicatedWorkfile, nativeWorkfile, "test fixture must duplicate a native result row");
  fs.writeFileSync(workfile, duplicatedWorkfile, "utf8");

  const readback = invokePappC({
    ...request,
    operation: "read-score-batch",
    pairingIds: request.pairings.map((pairing) => pairing.id),
  });
  assert.equal(readback.response.ok, false);
  assert.match(readback.response.message, /重复|不一致|解析/);
});

test("C rejects a native result row whose black-white player direction changed", () => {
  const request = scoreBatchRequest("score-batch-native-identity-mismatch");
  const workfile = scoreWorkfileFor(request.batchId);
  const write = invokePappC(request);
  assert.equal(write.exitCode, 0, JSON.stringify(write.response));

  const nativeWorkfile = fs.readFileSync(workfile, "utf8");
  const mismatchedWorkfile = nativeWorkfile.replace(
    /^\(000001(\s+40\s+)000002(\s+24\);)$/m,
    (_row, scoreSpacing, whiteSpacing) => `(000002${scoreSpacing}000001${whiteSpacing}`,
  );
  assert.notEqual(mismatchedWorkfile, nativeWorkfile, "test fixture must reverse the native player sides");
  fs.writeFileSync(workfile, mismatchedWorkfile, "utf8");

  const readback = invokePappC({
    ...request,
    operation: "read-score-batch",
    pairingIds: request.pairings.map((pairing) => pairing.id),
  });
  assert.equal(readback.response.ok, false);
  assert.match(readback.response.message, /身份|方向|原生轮次/);
});

function oqGame(id, overrides = {}) {
  return {
    id,
    created: "2026-09-12T10:10:00+08:00",
    black_name: "acct_a",
    white_name: "acct_b",
    black_score: 1,
    white_score: 63,
    status: "SCORE",
    detail: { position: { moves: [{ m: "f5" }] } },
    ...overrides,
  };
}

function oqRequest(pairing = {}) {
  const row = {
    id: "pairing-7",
    table: 7,
    black: "报名选手甲",
    white: "报名选手乙",
    blackAccount: "acct_b",
    whiteAccount: "acct_a",
    status: "imported",
    ...pairing,
  };
  return {
    operation: "oq-poll",
    round: 2,
    roundStartAt: ROUND_START,
    roundData: { roundStartAt: ROUND_START, pairings: [row] },
    pairings: [row],
  };
}

test("C OQ scores a fetched but unregistered game and keeps all ambiguous candidates", () => {
  for (const status of ["imported", "pending"]) {
    const request = oqRequest({ status, oqGameId: "fetched-game" });
    const result = invokePappC({
      ...request,
      gamesByAccount: { acct_a: [oqGame("fetched-game")] },
    }).response;
    assert.equal(result.ready.length, 1, status);
    assert.deepEqual([result.ready[0].blackScore, result.ready[0].whiteScore], [1, 63]);

    const ambiguous = invokePappC({
      ...request,
      gamesByAccount: { acct_a: [oqGame("fetched-game"), oqGame("second-game")] },
    }).response;
    assert.equal(ambiguous.ready.length, 0);
    assert.equal(ambiguous.pending[0].pendingKind, "oq-auto-multiple-games");
    assert.equal(ambiguous.pending[0].oqPendingDetail.candidateCount, 2);
  }
});

test("C OQ polling preserves the time in frontend space-separated round windows", () => {
  for (const roundStartAt of ["2026-09-12 10:00:00", "2026-09-12 10:00", ROUND_START]) {
    const result = invokePappC({
      ...oqRequest(),
      roundStartAt,
      gamesByAccount: { acct_a: [
        oqGame("before-window", { created: "2026-09-12T01:59:59Z" }),
        oqGame("in-window", { created: "2026-09-12T02:10:00Z" }),
        oqGame("after-window", { created: "2026-09-12T02:40:01Z" }),
      ] },
    }).response;
    assert.equal(result.ok, true);
    assert.deepEqual(result.ready.map((row) => row.oqGameId), ["in-window"], roundStartAt);
    assert.equal(result.pending.length, 0);
  }

  const explicitEnd = invokePappC({
    ...oqRequest(),
    roundStartAt: "2026-09-12 10:00:00",
    roundEndAt: "2026-09-12 10:15:00",
    gamesByAccount: { acct_a: [
      oqGame("in-window", { created: "2026-09-12 10:10:00" }),
      oqGame("after-end", { created: "2026-09-12T02:15:01Z" }),
    ] },
  }).response;
  assert.deepEqual(explicitEnd.ready.map((row) => row.oqGameId), ["in-window"]);
  assert.equal(explicitEnd.pending.length, 0);
});

test("C replays OQ games, maps accounts to PAPP sides, and sends ambiguous or unscorable games to pending", () => {
  const ready = invokePappC({
    ...oqRequest(),
    gamesByAccount: { acct_a: [oqGame("game-1")] },
  }).response;
  assert.equal(ready.source, "papp-c");
  assert.equal(ready.ready.length, 1);
  assert.deepEqual([ready.ready[0].blackScore, ready.ready[0].whiteScore], [1, 63]);
  assert.equal(ready.ready[0].oqGameId, "game-1");

  const ambiguous = invokePappC({
    ...oqRequest(),
    gamesByAccount: { acct_a: [
      oqGame("game-1"),
      oqGame("game-2", { created: "2026-09-12T10:12:00+08:00" }),
    ] },
  }).response;
  assert.equal(ambiguous.ready.length, 0);
  assert.equal(ambiguous.pending.length, 1);
  assert.match(ambiguous.pending[0].pendingKind, /multiple/);
  assert.equal(ambiguous.pending[0].oqPendingDetail.candidateCount, 2);
  assert.deepEqual(ambiguous.pending[0].oqPendingDetail.candidates.map((item) => item.gameId), ["game-1", "game-2"]);

  const noReplay = invokePappC({
    ...oqRequest(),
    gamesByAccount: { acct_a: [oqGame("no-detail", { detail: undefined })] },
  }).response;
  assert.equal(noReplay.ready.length, 0);
  assert.equal(noReplay.pending.length, 1);
  assert.deepEqual(noReplay.detailRequests, [{
    gameId: "no-detail",
    candidateKey: "id:no-detail",
    table: 7,
  }]);

  const detailFetchFailed = invokePappC({
    ...oqRequest(),
    gamesByAccount: { acct_a: [oqGame("detail-failed", {
      detail: undefined,
      detailFetchError: "OQ detail returned HTTP 404",
    })] },
  }).response;
  assert.equal(detailFetchFailed.ready.length, 0);
  assert.match(detailFetchFailed.pending[0].oqCandidates[0].error, /detail fetch failed.*HTTP 404/i);

  const duplicateAcrossAccounts = invokePappC({
    ...oqRequest(),
    gamesByAccount: {
      acct_a: [oqGame("same-game")],
      acct_b: [oqGame("same-game")],
    },
  }).response;
  assert.equal(duplicateAcrossAccounts.ready.length, 1);
  assert.deepEqual(duplicateAcrossAccounts.ready[0].oqAutoAudit.seenFromAccounts, ["acct_b", "acct_a"]);

  const invalidMove = invokePappC({
    ...oqRequest(),
    gamesByAccount: { acct_a: [oqGame("illegal-pass", {
      detail: { position: { moves: [{ m: "-" }] } },
    })] },
  }).response;
  assert.equal(invalidMove.ready.length, 0);
  assert.equal(invalidMove.pending.length, 1);
  assert.match(invalidMove.pending[0].reason, /pass|着法|position/i);

  const resign = invokePappC({
    ...oqRequest(),
    gamesByAccount: { acct_a: [oqGame("resign-game", {
      status: "resign",
      detail: { position: { moves: [{ m: "f5" }, { s: "WIN:RESIGN" }] } },
    })] },
  }).response;
  assert.deepEqual([resign.ready[0].blackScore, resign.ready[0].whiteScore], [64, 0]);
  assert.match(resign.ready[0].reason, /RESIGN/i);

  const ignored = invokePappC({
    ...oqRequest(),
    gamesByAccount: { acct_a: [
      oqGame("before-window", { created: "2026-09-12T09:59:59+08:00" }),
      oqGame("wrong-opponent", { white_name: "other-account" }),
    ] },
  }).response;
  assert.equal(ignored.ready.length, 0);
  assert.equal(ignored.pending.length, 0);
  assert.equal(ignored.skipped[0].reason, "no matching OQ game");

  const humanLocked = invokePappC({
    ...oqRequest({ status: "ready", blackScore: 32, whiteScore: 32, lastEditedBy: "human" }),
    gamesByAccount: { acct_a: [oqGame("human-score-mismatch")] },
  }).response;
  assert.equal(humanLocked.ready.length, 0);
  assert.equal(humanLocked.pending[0].pendingKind, "oq-auto-score-mismatch");
  assert.equal(humanLocked.pending[0].oqScoreMismatch[0].oqBlackScore, 1);

  const userLocked = invokePappC({
    ...oqRequest({ status: "ready", blackScore: 32, whiteScore: 32, lastEditedBy: "user" }),
    gamesByAccount: { acct_a: [oqGame("user-score-mismatch")] },
  }).response;
  assert.equal(userLocked.ready.length, 0);
  assert.equal(userLocked.pending[0].pendingKind, "oq-auto-score-mismatch");
  assert.equal(userLocked.pending[0].oqScoreMismatch[0].oqBlackScore, 1);

  const resolvedRequest = oqRequest({
    status: "ready", lastEditedBy: "user", blackScore: 1, whiteScore: 63,
  });
  resolvedRequest.roundData.pending = [{
    resolvedByReferee: true,
    pendingTable: 7,
    selectedSourceKey: "oq-auto:id:resolved-game",
    oqPendingDetail: { candidates: [{ candidateKey: "id:resolved-game" }] },
  }];
  const refereeResolved = invokePappC({
    ...resolvedRequest,
    gamesByAccount: { acct_a: [oqGame("resolved-game")] },
  }).response;
  assert.equal(refereeResolved.ready.length, 0);
  assert.equal(refereeResolved.pending.length, 0);
  assert.equal(refereeResolved.skipped[0].reason, "already completed");

  const userPendingRequest = oqRequest();
  userPendingRequest.roundData.pending = [{
    id: "human-pending-7",
    pendingTable: 7,
    pendingKind: "user-pending",
    reason: "裁判要求复核",
    resultText: "人工暂缓",
    lastEditedBy: "user",
  }];
  const followedUp = invokePappC({
    ...userPendingRequest,
    gamesByAccount: { acct_a: [
      oqGame("followup-1"),
      oqGame("followup-2", { created: "2026-09-12T10:12:00+08:00" }),
    ] },
  }).response;
  assert.equal(followedUp.pending.length, 1);
  assert.equal(followedUp.pending[0].pendingKind, "user-pending");
  assert.equal(followedUp.pending[0].reason, "裁判要求复核");
  assert.equal(followedUp.pending[0].resultText, "人工暂缓");
  assert.equal(followedUp.pending[0].oqFollowup.history.length, 1);
  assert.equal(followedUp.pending[0].oqFollowupCandidates.length, 2);
});

test("C reads OQ raw metadata and applies timeout and disconnect terminal outcomes", () => {
  const rawMetadata = invokePappC({
    ...oqRequest(),
    gamesByAccount: { acct_a: [oqGame("raw-metadata", {
      detail: undefined,
      raw_metadata_json: JSON.stringify({ detail: { position: { moves: [{ m: "f5" }] } } }),
    })] },
  }).response;
  assert.deepEqual([rawMetadata.ready[0].blackScore, rawMetadata.ready[0].whiteScore], [1, 63]);

  for (const ending of [
    { id: "timeout-game", status: "timeout", marker: "WIN:TIMEOUT", reason: /timeout/i },
    { id: "disconnect-game", status: "disconnect", marker: "WIN:DISCONNECT", reason: /disconnect/i },
  ]) {
    const result = invokePappC({
      ...oqRequest(),
      gamesByAccount: { acct_a: [oqGame(ending.id, {
        status: ending.status,
        detail: { position: { moves: [{ m: "f5" }, { s: ending.marker }] } },
      })] },
    }).response;
    assert.deepEqual([result.ready[0].blackScore, result.ready[0].whiteScore], [64, 0]);
    assert.match(result.ready[0].reason, ending.reason);
  }
});

test("the local tournament API invokes the rebuilt PAPP C executable", async (t) => {
  if (!server.listening) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
  }
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/papp/tournament`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ operation: "round-count", playerCount: 8 }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.source, "papp-c");
  assert.equal(result.roundCount, 4);

  const pairing = {
    id: "api-pairing",
    table: 1,
    black: "黑方",
    white: "白方",
    blackAccount: "acct_b",
    whiteAccount: "acct_a",
    status: "imported",
  };
  const oqResponse = await fetch(`http://127.0.0.1:${address.port}/api/papp/oq/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      round: 2,
      roundStartAt: ROUND_START,
      roundData: { roundStartAt: ROUND_START, pairings: [pairing] },
      pairings: [pairing],
      oqPollResult: { gamesByAccount: { acct_a: [oqGame("api-oq-game")] } },
    }),
  });
  const oqResult = await oqResponse.json();
  assert.equal(oqResponse.status, 200);
  assert.equal(oqResult.source, "papp-c");
  assert.equal(oqResult.ready[0].oqGameId, "api-oq-game");
});

test("the local tournament API resumes unfinished batches in per-tournament workfiles", async (t) => {
  if (!server.listening) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
  }
  const address = server.address();
  const workfileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "papp-tournament-workfiles-"));
  const previousDirectory = process.env.PAPP_TOURNAMENT_WORKFILES_DIR;
  const previousWorkfile = process.env.PAPP_TOURNAMENT_WORKFILE;
  process.env.PAPP_TOURNAMENT_WORKFILES_DIR = workfileDirectory;
  process.env.PAPP_TOURNAMENT_WORKFILE = path.join(workfileDirectory, "legacy-default.txt");
  t.after(() => {
    if (previousDirectory === undefined) delete process.env.PAPP_TOURNAMENT_WORKFILES_DIR;
    else process.env.PAPP_TOURNAMENT_WORKFILES_DIR = previousDirectory;
    if (previousWorkfile === undefined) delete process.env.PAPP_TOURNAMENT_WORKFILE;
    else process.env.PAPP_TOURNAMENT_WORKFILE = previousWorkfile;
  });

  const callTournamentApi = async (payload) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/papp/tournament`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    return { status: response.status, result: await response.json() };
  };
  const firstTournament = scoreBatchRequest("incomplete-test-a-r1");
  firstTournament.pappWorkfileId = "unfinished-event-a";
  firstTournament.tournamentName = "Same test title";
  firstTournament.preliminaryRoundCount = 4;
  firstTournament.roundCount = 4;

  const secondTournament = scoreBatchRequest("incomplete-test-b-r1");
  secondTournament.pappWorkfileId = "unfinished-event-b";
  secondTournament.tournamentName = "Same test title";
  secondTournament.preliminaryRoundCount = 4;
  secondTournament.roundCount = 4;
  const secondIdByFirstId = new Map();
  secondTournament.players = secondTournament.players.map((player, index) => {
    const id = `q${index + 1}`;
    secondIdByFirstId.set(player.id, id);
    return { ...player, id, displayName: `Other ${player.displayName}`, account: `other_${player.account}` };
  });
  secondTournament.pairings = secondTournament.pairings.map((pairing) => ({
    ...pairing,
    blackId: secondIdByFirstId.get(pairing.blackId),
    whiteId: secondIdByFirstId.get(pairing.whiteId),
    black: `Other ${pairing.black}`,
    white: `Other ${pairing.white}`,
    blackAccount: `other_${pairing.blackAccount}`,
    whiteAccount: `other_${pairing.whiteAccount}`,
  }));

  const firstWrite = await callTournamentApi(firstTournament);
  assert.equal(firstWrite.status, 200);
  assert.equal(firstWrite.result.accepted, true, JSON.stringify(firstWrite.result));
  const secondWrite = await callTournamentApi(secondTournament);
  assert.equal(secondWrite.status, 200);
  assert.equal(secondWrite.result.accepted, true, JSON.stringify(secondWrite.result));

  const firstRead = await callTournamentApi({
    ...firstTournament,
    operation: "read-score-batch",
    pairingIds: firstTournament.pairings.map((pairing) => pairing.id),
  });
  assert.equal(firstRead.status, 200);
  assert.equal(firstRead.result.verified, true, JSON.stringify(firstRead.result));

  const nextRound = {
    ...firstTournament,
    operation: "write-score-batch",
    round: 2,
    batchId: "incomplete-test-a-r2",
  };
  const resumeWrite = await callTournamentApi(nextRound);
  assert.equal(resumeWrite.status, 200);
  assert.equal(resumeWrite.result.accepted, true, JSON.stringify(resumeWrite.result));
  assert.equal(fs.existsSync(path.join(workfileDirectory, "papp-unfinished-event-a.txt")), true);
  assert.equal(fs.existsSync(path.join(workfileDirectory, "papp-unfinished-event-b.txt")), true);

  const eventAFile = path.join(workfileDirectory, "papp-unfinished-event-a.txt");
  const eventBFile = path.join(workfileDirectory, "papp-unfinished-event-b.txt");
  const eventAContent = fs.readFileSync(eventAFile, "utf8");
  const eventBContent = fs.readFileSync(eventBFile, "utf8");
  const roundStandings = await callTournamentApi({
    operation: "round-standings",
    round: 1,
    preliminaryRoundCount: 4,
    roundCount: 4,
    pappWorkfileId: "unfinished-event-a",
    players: firstTournament.players,
    presentPlayerIds: firstTournament.presentPlayerIds,
    hasSemifinalAndFinal: false,
    tournamentParameters: { hasSemifinalAndFinal: false, brightwellConstant: 0 },
    rounds: [{
      round: 1,
      presentPlayerIds: firstTournament.presentPlayerIds,
      pairings: firstTournament.pairings.map((pairing) => ({
        id: pairing.id,
        blackId: pairing.blackId,
        whiteId: pairing.whiteId,
        blackScore: pairing.blackScore,
        whiteScore: pairing.whiteScore,
        status: "completed",
      })),
    }],
  });
  assert.equal(roundStandings.status, 200);
  assert.equal(roundStandings.result.source, "papp-c");
  assert.equal(roundStandings.result.complete, true, JSON.stringify(roundStandings.result));
  assert.equal(roundStandings.result.standings.length, 4);
  assert.equal(fs.existsSync(path.join(workfileDirectory, "legacy-default.txt")), false,
    "a standings query must not create or select the shared default workfile");
  assert.equal(fs.readFileSync(eventAFile, "utf8"), eventAContent);
  assert.equal(fs.readFileSync(eventBFile, "utf8"), eventBContent);

  const missingIdentity = await callTournamentApi({ ...firstTournament, pappWorkfileId: "" });
  assert.equal(missingIdentity.status, 400);
  assert.equal(missingIdentity.result.code, "invalid-papp-workfile-id");
});
