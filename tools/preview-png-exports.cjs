"use strict";
// Run the production Canvas drawing code with Skia, without a browser.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createCanvas } = require("../third_party/ap-runtime/node_modules/@napi-rs/canvas");
const frontend = path.join(__dirname, "../third_party/checkin-frontend");
const output = path.resolve(process.argv[2] || "artifacts/png-layout-preview");
fs.mkdirSync(output, { recursive: true });
const sandbox = {
  document: { createElement(tag) {
    if (tag !== "canvas") throw new Error(tag);
    const canvas = createCanvas(1, 1);
    canvas.style = {};
    const getContext = canvas.getContext.bind(canvas);
    canvas.getContext = type => {
      const ctx = getContext(type);
      return new Proxy(ctx, {
        get(target, key) { const v = Reflect.get(target, key, target); return typeof v === "function" ? v.bind(target) : v; },
        set(target, key, v) {
          if (key === "font") v = String(v).replace(/^(\d{3})\s+/, (_, w) => `${Math.round(Number(w) / 100) * 100} `);
          return Reflect.set(target, key, v, target);
        },
      });
    };
    return canvas;
  } },
  state: { competitionName: "秋季黑白棋交流赛", players: [] },
  normalizeWhitespace: v => String(v || "").replace(/\s+/g, " ").trim(),
  normalizeKey: v => String(v || "").toLowerCase(),
  ensureMappingState: () => ({ groupName: "黑白棋比赛交流群" }),
  sanitizeMappingCheck: v => v || {},
  mappingStatusLabel: row => ({ text: row.oqCheck?.status === "ok" ? "已通过" : "待验证", className: "" }),
  mappingOqRatingLabel: check => check?.rating ? { text: `等级 ${check.rating}` } : null,
  formatTime: () => "19:05:32",
};
vm.createContext(sandbox);
for (const file of ["papp-score-png-renderer.js", "papp-standings-png-renderer.js"]) {
  vm.runInContext(fs.readFileSync(path.join(frontend, file), "utf8"), sandbox);
}
const app = fs.readFileSync(path.join(frontend, "app.js"), "utf8");
vm.runInContext(app.slice(app.indexOf("  function fitTextToWidth("), app.indexOf("  function openPNGPreviewWindow(")), sandbox);
const names = ["小林", "Alice Chen", "这是一个比较长的参赛昵称用于检查文字边界", "王一鸣", "棋友🌟", "山海之间"];
const players = names.map((displayName, i) => ({ displayName, account: `othello_player_${i + 1}`, club: "城市黑白棋俱乐部", group: "公开组", platform: "oq", isNew: i === 1, checkedIn: i % 3 !== 2, checkedInAt: "2026-10-01T11:05:32Z" }));
sandbox.state.players = players;
const settings = { withAccount: true, withClub: true, withGroup: true, withPlatform: true, withTime: true };
const mapping = players.map((p, i) => ({ wechatNick: i === 2 ? "群昵称很长很长用于检验列边界" : p.displayName, registrationNick: p.displayName, oqAccount: p.account, oqCheck: { account: p.account, status: "ok", rating: 1850 } }));
// Synthetic display fixtures only; no tournament pairing/ranking computation.
const pairings = [
  { table: 1, black: names[0], white: names[1], blackAccount: players[0].account, whiteAccount: players[1].account, blackScore: 36, whiteScore: 28 },
  { table: 12, black: names[2], white: names[3], blackAccount: "very_long_othello_account_name", whiteAccount: players[3].account, blackScore: 32, whiteScore: 32 },
  { table: 123, black: names[4], white: names[5] },
  { table: 4, black: names[0], white: "BYE", status: "bye" },
];
const payload = { competitionName: sandbox.state.competitionName, round: 3, pairings };
const standings = players.map((p, i) => ({ ...p, rank: i + 1, preliminaryRank: i + 1, totalPoints: 4, brightwell: 123.45, totalDiscs: 180 }));
const save = (name, canvas) => { fs.writeFileSync(path.join(output, `${name}.png`), canvas.toBuffer("image/png")); console.log(`${name}: ${canvas.width} × ${canvas.height}`); };
save("checkin", sandbox.buildExportCanvasFromData(players, settings));
save("mapping", sandbox.buildMappingExportCanvasFromData(mapping));
save("pairings", sandbox.PAPP_SCORE_PNG_RENDERER.buildPairingsCanvas(payload));
save("scores", sandbox.PAPP_SCORE_PNG_RENDERER.buildScoreCanvas(pairings, payload));
save("standings", sandbox.PAPP_STANDINGS_PNG_RENDERER.buildStandingsCanvas({ competitionName: payload.competitionName, standings, showPreliminaryRank: true, labels: { title: "最终排名" } }));
save("checkin-ios", sandbox.buildExportCanvasFromData(players, settings, { safeIOS: true }));
save("mapping-ios", sandbox.buildMappingExportCanvasFromData(mapping, { safeIOS: true }));
if (process.argv.includes("--edges")) {
  sandbox.state.competitionName = "这是一个用于检查标题边界的很长很长的比赛名称 · 秋季黑白棋公开赛与交流活动";
  save("long-title-checkin", sandbox.buildExportCanvasFromData(players, settings));
  save("empty-checkin", sandbox.buildExportCanvasFromData([], settings));
  save("empty-mapping", sandbox.buildMappingExportCanvasFromData([]));
  save("minimal-checkin", sandbox.buildExportCanvasFromData(players, {}));
  save("large-checkin-ios", sandbox.buildExportCanvasFromData(Array.from({ length: 150 }, (_, i) => players[i % players.length]), settings, { safeIOS: true }));
  save("long-title-pairings", sandbox.PAPP_SCORE_PNG_RENDERER.buildPairingsCanvas({ ...payload, competitionName: sandbox.state.competitionName }));
}
