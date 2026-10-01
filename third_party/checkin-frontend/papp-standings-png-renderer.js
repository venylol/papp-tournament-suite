(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PAPP_STANDINGS_PNG_RENDERER = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var MAX_CANVAS_SIDE = 8192;
  var MAX_CANVAS_AREA = 16_000_000;
  var COLORS = {
    page: "#eef5f0",
    header: "#173c2c",
    accent: "#64c987",
    card: "#ffffff",
    alternate: "#f6faf7",
    tableHeader: "#dcebe0",
    border: "#d8e4da",
    text: "#1d3327",
    muted: "#5d7164",
    highlight: "#247144",
    white: "#ffffff",
  };

  function cleanText(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function formatMetric(value) {
    if (value === null || value === undefined || value === "") return "—";
    var number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return Number.isInteger(number)
      ? String(number)
      : number.toLocaleString("zh-Hans-CN", {
          maximumFractionDigits: 2,
          useGrouping: false,
        });
  }

  function fitText(ctx, value, maxWidth) {
    var text = String(value || "");
    if (!text || !maxWidth || ctx.measureText(text).width <= maxWidth) return text;
    var out = Array.from(text);
    while (out.length > 1 && ctx.measureText(out.join("") + "…").width > maxWidth) {
      out.pop();
    }
    return out.join("") + "…";
  }

  function canvasScale(width, height) {
    var ratio = typeof window !== "undefined" && Number(window.devicePixelRatio)
      ? Number(window.devicePixelRatio)
      : 1;
    var bySide = MAX_CANVAS_SIDE / Math.max(width, height);
    var byArea = Math.sqrt(MAX_CANVAS_AREA / (width * height));
    return Math.min(Math.max(1, Math.min(3, ratio)), bySide, byArea);
  }

  function drawText(ctx, value, x, y, maxWidth, align, font, color) {
    ctx.save();
    ctx.font = font;
    ctx.textAlign = align || "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color || COLORS.text;
    var textX = x;
    if (align === "center") textX += maxWidth / 2;
    else if (align === "right") textX += maxWidth;
    ctx.fillText(fitText(ctx, value, maxWidth), textX, y);
    ctx.restore();
  }

  function buildStandingsCanvas(options) {
    var value = options && typeof options === "object" ? options : {};
    var rows = Array.isArray(value.standings) ? value.standings : [];
    if (!rows.length) throw new Error("没有可导出的排名数据");

    var labels = value.labels && typeof value.labels === "object" ? value.labels : {};
    var includePreliminaryRank = value.showPreliminaryRank === true;
    var columns = [
      { key: "rank", label: labels.rank || "名次", width: 82, align: "center" },
      { key: "displayName", label: labels.player || "选手", width: 350, align: "left" },
      { key: "totalPoints", label: labels.totalPoints || "总积分", width: 142, align: "right" },
      { key: "brightwell", label: labels.brightwell || "Brightwell", width: 176, align: "right" },
      { key: "totalDiscs", label: labels.totalDiscs || "总棋子数", width: 148, align: "right" },
    ];
    if (includePreliminaryRank) {
      columns.push({
        key: "preliminaryRank",
        label: labels.preliminaryRank || "预赛名次",
        width: 126,
        align: "center",
      });
    }

    var marginX = 38;
    var tableWidth = columns.reduce(function (sum, column) {
      return sum + column.width;
    }, 0);
    var width = marginX * 2 + tableWidth;
    var tableX = marginX;
    var tableY = 176;
    var tableHeaderHeight = 52;
    var rowHeight = 66;
    var footerHeight = 62;
    var height = tableY + tableHeaderHeight + rows.length * rowHeight + footerHeight;
    var scale = canvasScale(width, height);
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    var ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 PNG Canvas 2D 上下文");
    ctx.scale(scale, scale);

    var fontFamily = "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Segoe UI Emoji', sans-serif";
    ctx.fillStyle = COLORS.page;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = COLORS.header;
    ctx.fillRect(0, 0, width, 154);
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(0, 0, width, 8);

    drawText(
      ctx,
      cleanText(value.competitionName) || labels.competitionFallback || "比赛",
      marginX,
      48,
      width - marginX * 2,
      "left",
      "700 30px " + fontFamily,
      COLORS.white,
    );
    drawText(
      ctx,
      labels.title || "比赛排名",
      marginX,
      91,
      width - marginX * 2,
      "left",
      "600 22px " + fontFamily,
      COLORS.white,
    );
    drawText(
      ctx,
      labels.metadata || (rows.length + " 位选手"),
      marginX,
      128,
      width - marginX * 2,
      "left",
      "500 15px " + fontFamily,
      "#d4e6d9",
    );

    ctx.fillStyle = COLORS.card;
    ctx.fillRect(tableX, tableY, tableWidth, tableHeaderHeight + rows.length * rowHeight);
    ctx.fillStyle = COLORS.tableHeader;
    ctx.fillRect(tableX, tableY, tableWidth, tableHeaderHeight);
    var columnX = tableX;
    columns.forEach(function (column) {
      drawText(
        ctx,
        column.label,
        columnX + (column.align === "center" ? 0 : 14),
        tableY + tableHeaderHeight / 2,
        column.width - (column.align === "center" ? 0 : 28),
        column.align,
        "600 15px " + fontFamily,
        COLORS.muted,
      );
      columnX += column.width;
    });

    rows.forEach(function (rowValue, rowIndex) {
      var row = rowValue && typeof rowValue === "object" ? rowValue : {};
      var rowY = tableY + tableHeaderHeight + rowIndex * rowHeight;
      var centerY = rowY + rowHeight / 2;
      if (rowIndex % 2 === 1) {
        ctx.fillStyle = COLORS.alternate;
        ctx.fillRect(tableX, rowY, tableWidth, rowHeight);
      }

      var x = tableX;
      var rankText = row.rank === null || row.rank === undefined || row.rank === ""
        ? "—"
        : String(row.rank);
      var nativeRank = Number(row.rank);
      var rankColor = nativeRank >= 1 && nativeRank <= 3
        ? COLORS.highlight
        : COLORS.text;
      drawText(
        ctx,
        rankText,
        x,
        centerY,
        columns[0].width,
        "center",
        "700 19px " + fontFamily,
        rankColor,
      );
      x += columns[0].width;

      var playerName = cleanText(row.displayName) || labels.unnamedPlayer || "未命名选手";
      var account = cleanText(row.account);
      if (account) {
        drawText(
          ctx,
          playerName,
          x + 14,
          centerY - 9,
          columns[1].width - 28,
          "left",
          "600 17px " + fontFamily,
          COLORS.text,
        );
        drawText(
          ctx,
          account,
          x + 14,
          centerY + 14,
          columns[1].width - 28,
          "left",
          "500 13px " + fontFamily,
          COLORS.muted,
        );
      } else {
        drawText(
          ctx,
          playerName,
          x + 14,
          centerY,
          columns[1].width - 28,
          "left",
          "600 17px " + fontFamily,
          COLORS.text,
        );
      }
      x += columns[1].width;

      ["totalPoints", "brightwell", "totalDiscs"].forEach(function (key, index) {
        var column = columns[index + 2];
        drawText(
          ctx,
          formatMetric(row[key]),
          x + 14,
          centerY,
          column.width - 28,
          "right",
          "500 16px " + fontFamily,
          COLORS.text,
        );
        x += column.width;
      });

      if (includePreliminaryRank) {
        drawText(
          ctx,
          formatMetric(row.preliminaryRank),
          x,
          centerY,
          columns[columns.length - 1].width,
          "center",
          "500 16px " + fontFamily,
          COLORS.text,
        );
      }

      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tableX, rowY + rowHeight - 0.5);
      ctx.lineTo(tableX + tableWidth, rowY + rowHeight - 0.5);
      ctx.stroke();
    });

    drawText(
      ctx,
      labels.source || "排名数据由本地 PAPP C 提供",
      marginX,
      height - footerHeight / 2,
      tableWidth,
      "left",
      "500 14px " + fontFamily,
      COLORS.muted,
    );
    return canvas;
  }

  return {
    buildStandingsCanvas: buildStandingsCanvas,
    formatMetric: formatMetric,
  };
});
