(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PAPP_SCORE_PNG_RENDERER = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var PALETTE = {
    page: "#f5f9f8",
    header: "#dcefeb",
    headerLine: "#31858b",
    card: "#ffffff",
    cardAlt: "#edf6f3",
    border: "#c5dbd6",
    text: "#173b40",
    muted: "#54706e",
    table: "#d6ebe6",
    tableText: "#235f64",
    password: "#fff0d2",
    passwordText: "#94621b",
    bye: "#e6e9e8",
    byeText: "#60716f",
  };

  var MAX_CANVAS_SIDE = 8192;
  var MAX_CANVAS_AREA = 16_000_000;

  function norm(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function keyOf(value) {
    return norm(value).toLowerCase();
  }

  function isByeName(value) {
    return keyOf(value) === "bye" || norm(value) === "轮空";
  }

  function isByeRow(row) {
    var value = row && typeof row === "object" ? row : {};
    var status = keyOf(value.status);
    return (
      status === "bye" ||
      isByeName(value.black) ||
      isByeName(value.white) ||
      (!norm(value.white) && Boolean(norm(value.black)))
    );
  }

  function fitText(ctx, text, maxWidth) {
    var raw = String(text || "");
    if (!raw || !maxWidth || ctx.measureText(raw).width <= maxWidth) return raw;
    var out = Array.from(raw);
    while (out.length > 1 && ctx.measureText(out.join("") + "…").width > maxWidth) {
      out.pop();
    }
    return out.join("") + "…";
  }

  function roundRectPath(ctx, x, y, width, height, radius) {
    var r = Math.max(0, Math.min(Number(radius) || 0, width / 2, height / 2));
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

  function fillRoundRect(ctx, x, y, width, height, radius, fill, stroke) {
    ctx.save();
    roundRectPath(ctx, x, y, width, height, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  function deviceScale(width, height) {
    var ratio =
      typeof window !== "undefined" && Number(window.devicePixelRatio)
        ? Number(window.devicePixelRatio)
        : 1;
    var requestedScale = Math.max(1, Math.min(3, ratio));
    var scaleBySide = MAX_CANVAS_SIDE / Math.max(width, height);
    var scaleByArea = Math.sqrt(MAX_CANVAS_AREA / (width * height));
    return Math.min(requestedScale, scaleBySide, scaleByArea);
  }

  function createCanvas(width, height) {
    var canvas = document.createElement("canvas");
    var scale = deviceScale(width, height);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    var ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 PNG Canvas 2D 上下文");
    ctx.scale(scale, scale);
    return { canvas: canvas, ctx: ctx };
  }

  function drawName(ctx, name, x, y, maxWidth) {
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.text;
    ctx.font = "600 21px 'Microsoft YaHei', 'PingFang SC', 'Segoe UI Emoji', sans-serif";
    var text = norm(name) || "待接入";
    var limit = maxWidth || 210;
    var chars = Array.from(text);
    var first = "";
    while (chars.length && ctx.measureText(first + chars[0]).width <= limit) {
      first += chars.shift();
    }
    // Wrap only when the measured name exceeds its cell, preserving spaces.
    if (chars.length) {
      ctx.fillText(first, x, y - 13);
      ctx.fillText(fitText(ctx, chars.join("").trim(), limit), x, y + 13);
    } else {
      ctx.fillText(text, x, y);
    }
    ctx.restore();
  }

  function drawAccount(ctx, account, x, y, maxWidth) {
    var text = norm(account) || "账号待接入";
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.passwordText;
    ctx.font = "500 14px 'Microsoft YaHei', 'PingFang SC', sans-serif";
    ctx.fillText(fitText(ctx, text, maxWidth || 172), x, y);
    ctx.restore();
  }

  function drawPasswordBlock(ctx, password, account, x, y) {
    fillRoundRect(ctx, x - 100, y - 36, 200, 72, 17, PALETTE.password, "#e7cb91");
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.passwordText;
    ctx.font = "700 24px Arial, 'Microsoft YaHei', sans-serif";
    ctx.fillText(password, x, y - 12);
    ctx.restore();
    drawAccount(ctx, account, x, y + 15, 180);
  }

  function drawByeBlock(ctx, x, y) {
    fillRoundRect(ctx, x - 100, y - 36, 200, 72, 17, PALETTE.bye, "#cbd5d2");
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.byeText;
    ctx.font = "700 20px 'Microsoft YaHei', 'PingFang SC', sans-serif";
    ctx.fillText("轮空", x, y + 1);
    ctx.restore();
  }

  function hasScoreValue(value) {
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  }

  function hasCompleteScore(row) {
    var value = row && typeof row === "object" ? row : {};
    return (
      hasScoreValue(value.blackScore) &&
      hasScoreValue(value.whiteScore) &&
      Number(value.blackScore) >= 0 &&
      Number(value.whiteScore) >= 0 &&
      Number(value.blackScore) <= 64 &&
      Number(value.whiteScore) <= 64 &&
      Math.trunc(Number(value.blackScore)) + Math.trunc(Number(value.whiteScore)) === 64
    );
  }

  function buildScoreRow(input) {
    var row = input && typeof input === "object" ? input : {};
    var blackName = norm(row.black);
    var whiteName = norm(row.white);
    var blackBye = isByeName(blackName);
    var whiteBye = isByeName(whiteName);
    var bye = isByeRow(row);

    if (bye) {
      var playerName = blackBye ? whiteName : whiteBye ? blackName : blackName || whiteName;
      return {
        table: row.table,
        black: playerName,
        white: "轮空",
        blackScore: null,
        whiteScore: null,
        isBye: true,
      };
    }

    var blackScore = null;
    var whiteScore = null;

    var candidates = [row.written, row.local, row.current, row];
    for (var i = 0; i < candidates.length; i += 1) {
      if (hasCompleteScore(candidates[i])) {
        blackScore = Math.trunc(Number(candidates[i].blackScore));
        whiteScore = Math.trunc(Number(candidates[i].whiteScore));
        break;
      }
    }

    return {
      table: row.table,
      black: blackName,
      white: whiteName,
      blackScore: blackScore,
      whiteScore: whiteScore,
      isBye: false,
    };
  }

  function drawScoreBadge(ctx, x, y, value) {
    fillRoundRect(ctx, x - 42, y - 24, 84, 48, 14, "#f3f7f6", PALETTE.border);
    if (!hasScoreValue(value)) return;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.text;
    ctx.font = "700 20px Arial, 'Microsoft YaHei', sans-serif";
    ctx.fillText(String(Math.trunc(Number(value))), x, y + 1);
    ctx.restore();
  }

  function drawByeBadge(ctx, x, y) {
    fillRoundRect(ctx, x - 82, y - 24, 164, 48, 14, PALETTE.bye, "#cbd5d2");
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.byeText;
    ctx.font = "700 20px 'Microsoft YaHei', 'PingFang SC', sans-serif";
    ctx.fillText("轮空", x, y + 1);
    ctx.restore();
  }

  function roundNumber(value) {
    if (value && typeof value === "object") {
      return roundNumber(value.round || value.roundNo);
    }
    var number = Math.trunc(Number(value));
    return Number.isFinite(number) && number > 0 ? number : "";
  }

  function titleFor(payload, suffix) {
    var value = payload && typeof payload === "object" ? payload : {};
    var competition = norm(value.competitionName);
    var round = roundNumber(value.round || value.roundNo);
    var title = round ? "第 " + round + " 轮" + suffix : suffix;
    return competition ? competition + " · " + title : title;
  }

  function pairingPassword(round, table) {
    var roundNumberValue = Math.max(0, Math.trunc(Number(round) || 0));
    var tableNumber = Math.max(0, Math.trunc(Number(table) || 0));
    var roundText = roundNumberValue < 10 ? "0" + roundNumberValue : String(roundNumberValue);
    var tableText = tableNumber < 10 ? "0" + tableNumber : String(tableNumber);
    return roundText + tableText;
  }

  function pairingTitle(payload) {
    return titleFor(payload, "配对表");
  }

  function scoreTitle(payload) {
    return titleFor(payload, "比分表");
  }

  function buildPairingsCanvas(payload, accountForName) {
    var value = payload && typeof payload === "object" ? payload : {};
    var rawPairings =
      Array.isArray(value.blankPairings) && value.blankPairings.length
        ? value.blankPairings
        : Array.isArray(value.pairings)
          ? value.pairings
          : [];
    var resolveAccount = typeof accountForName === "function" ? accountForName : function () { return ""; };
    var width = 1280;
    var headerHeight = 158;
    var rowHeight = 106;
    var footerHeight = 40;
    var height = Math.max(260, headerHeight + rowHeight * rawPairings.length + footerHeight);
    var built = createCanvas(width, height);
    var canvas = built.canvas;
    var ctx = built.ctx;
    var fontFamily = "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif";

    ctx.fillStyle = PALETTE.page;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = PALETTE.header;
    ctx.fillRect(0, 0, width, headerHeight);
    ctx.fillStyle = PALETTE.headerLine;
    ctx.fillRect(0, 0, width, 8);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.text;
    ctx.font = "700 34px " + fontFamily;
    ctx.fillText(fitText(ctx, pairingTitle(value), width - 80), width / 2, 55);
    ctx.fillStyle = PALETTE.muted;
    ctx.font = "400 16px " + fontFamily;
    ctx.fillText(
      "选手顺序仅用于列出对局，实际座次以现场为准；四位数字为本轮对局密码，密码下方显示对手 OQ 账号",
      width / 2,
      103,
    );
    ctx.font = "400 13px " + fontFamily;
    ctx.fillText("PAPP 本地编排 · 配对信息", width / 2, 134);

    rawPairings.forEach(function (raw, index) {
      var row = raw && typeof raw === "object" ? raw : {};
      var top = headerHeight + index * rowHeight;
      var table = norm(row.table) || String(index + 1);
      var blackBye = isByeName(row.black);
      var whiteBye = isByeRow(row) && !blackBye;
      var blackName = blackBye ? "BYE" : norm(row.black) || "选手待接入";
      var whiteName = whiteBye ? "BYE" : norm(row.white) || "选手待接入";
      var round = roundNumber(value.round || value.roundNo) || 1;
      var blackAccount = norm(row.blackAccount) || resolveAccount(row.black);
      var whiteAccount = norm(row.whiteAccount) || resolveAccount(row.white);

      fillRoundRect(
        ctx,
        18,
        top + 8,
        width - 36,
        rowHeight - 16,
        18,
        index % 2 === 0 ? PALETTE.card : PALETTE.cardAlt,
        PALETTE.border,
      );
      fillRoundRect(ctx, 34, top + 29, 74, 48, 15, PALETTE.table, "#afd0c9");
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = PALETTE.tableText;
      ctx.font = "700 17px " + fontFamily;
      var tableLabel = "第 " + table + " 台";
      var tableFontSize = 17;
      while (tableFontSize > 11 && ctx.measureText(tableLabel).width > 66) {
        tableFontSize -= 1;
        ctx.font = "700 " + tableFontSize + "px " + fontFamily;
      }
      ctx.fillText(fitText(ctx, tableLabel, 66), 71, top + 54);
      ctx.restore();

      drawName(ctx, blackName, 128, top + 54, 220);
      if (blackBye) drawByeBlock(ctx, 458, top + 54);
      else if (!whiteBye) drawPasswordBlock(ctx, pairingPassword(round, table), whiteAccount, 458, top + 54);

      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = PALETTE.muted;
      ctx.font = "700 17px Arial, 'Microsoft YaHei', sans-serif";
      ctx.fillText("VS", 648, top + 54);
      ctx.restore();

      drawName(ctx, whiteName, 766, top + 54, 250);
      if (whiteBye) drawByeBlock(ctx, 1138, top + 54);
      else if (!blackBye) drawPasswordBlock(ctx, pairingPassword(round, table), blackAccount, 1138, top + 54);
    });

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.muted;
    ctx.font = "400 13px " + fontFamily;
    ctx.fillText("PAPP · 配对 PNG", width / 2, height - 18);
    ctx.restore();
    return canvas;
  }

  function buildScoreCanvas(pairings, payload) {
    var value = payload && typeof payload === "object" ? payload : { round: payload };
    var rawPairings = Array.isArray(pairings) ? pairings : [];
    var rows = rawPairings.map(buildScoreRow);
    var width = 1200;
    var headerHeight = 142;
    var rowHeight = 106;
    var footerHeight = 40;
    var height = Math.max(260, headerHeight + rowHeight * rows.length + footerHeight);
    var built = createCanvas(width, height);
    var canvas = built.canvas;
    var ctx = built.ctx;
    var fontFamily = "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif";

    ctx.fillStyle = PALETTE.page;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = PALETTE.header;
    ctx.fillRect(0, 0, width, headerHeight);
    ctx.fillStyle = PALETTE.headerLine;
    ctx.fillRect(0, 0, width, 8);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.text;
    ctx.font = "700 34px " + fontFamily;
    ctx.fillText(fitText(ctx, scoreTitle(value), width - 80), width / 2, 57);
    ctx.fillStyle = PALETTE.muted;
    ctx.font = "400 16px " + fontFamily;
    ctx.fillText("选手顺序仅用于展示；未登记比分保留空白，每局比分合计为 64 子", width / 2, 104);

    rows.forEach(function (row, index) {
      var top = headerHeight + index * rowHeight;
      var table = norm(row.table) || String(index + 1);
      var blackName = norm(row.black) || "选手待接入";
      fillRoundRect(
        ctx,
        18,
        top + 8,
        width - 36,
        rowHeight - 16,
        18,
        index % 2 === 0 ? PALETTE.card : PALETTE.cardAlt,
        PALETTE.border,
      );
      fillRoundRect(ctx, 34, top + 29, 74, 48, 15, PALETTE.table, "#afd0c9");
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = PALETTE.tableText;
      ctx.font = "700 17px " + fontFamily;
      var tableLabel = "第 " + table + " 台";
      var tableFontSize = 17;
      while (tableFontSize > 11 && ctx.measureText(tableLabel).width > 66) {
        tableFontSize -= 1;
        ctx.font = "700 " + tableFontSize + "px " + fontFamily;
      }
      ctx.fillText(fitText(ctx, tableLabel, 66), 71, top + 54);
      ctx.restore();

      drawName(ctx, blackName, 132, top + 54, 292);
      if (row.isBye) {
        drawByeBadge(ctx, 600, top + 54);
        return;
      }

      var whiteName = norm(row.white) || "选手待接入";
      drawScoreBadge(ctx, 514, top + 54, row.blackScore);
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = PALETTE.muted;
      ctx.font = "700 15px Arial, 'Microsoft YaHei', sans-serif";
      ctx.fillText("VS", 600, top + 54);
      ctx.restore();
      drawScoreBadge(ctx, 686, top + 54, row.whiteScore);
      drawName(ctx, whiteName, 760, top + 54, 330);
    });

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PALETTE.muted;
    ctx.font = "400 13px " + fontFamily;
    ctx.fillText("PAPP · 比分 PNG", width / 2, height - 18);
    ctx.restore();
    return canvas;
  }

  return {
    buildPairingsCanvas: buildPairingsCanvas,
    buildScoreCanvas: buildScoreCanvas,
    buildScoreRow: buildScoreRow,
    hasPairingScore: hasCompleteScore,
    hasScoreValue: hasScoreValue,
    pairingPassword: pairingPassword,
    roundTitle: pairingTitle,
  };
});
