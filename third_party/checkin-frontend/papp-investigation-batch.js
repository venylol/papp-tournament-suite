"use strict";

const fs = require("node:fs");
const path = require("node:path");

function cleanText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function safeBatchId(value) {
  const id = cleanText(value);
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u.test(id)) {
    throw new Error("无效的批量哨兵任务 ID");
  }
  return id;
}

function normalizePlayers(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("请至少选择一名选手");
  }
  const accounts = new Set();
  return values.map((value, index) => {
    const player = value && typeof value === "object" ? value : {};
    const rank = Number(player.rank);
    const account = cleanText(player.account);
    const name = cleanText(player.name) || account;
    if (!Number.isInteger(rank) || rank < 1) throw new Error(`第 ${index + 1} 名选手的名次无效`);
    if (!account || account.length > 64) throw new Error(`第 ${rank} 名选手缺少有效的 OQ 账号`);
    const key = account.toLowerCase();
    if (accounts.has(key)) throw new Error(`重复选择了 OQ 账号：${account}`);
    accounts.add(key);
    return { rank, name, account };
  }).sort((left, right) => left.rank - right.rank);
}

class InvestigationBatchManager {
  constructor(options) {
    this.root = path.resolve(options.root);
    this.runPlayer = options.runPlayer;
    this.stopPlayer = options.stopPlayer;
    this.now = options.now || (() => new Date());
    this.jobs = new Map();
    this.sequence = 0;
  }

  batchDir(batchId) {
    const id = safeBatchId(batchId);
    const directory = path.resolve(this.root, id);
    if (!directory.startsWith(`${this.root}${path.sep}`)) throw new Error("批量哨兵任务目录越界");
    return directory;
  }

  snapshot(job, final = false) {
    const completed = job.results.filter((result) => result.status === "completed").length;
    const failed = job.results.filter((result) => result.status === "failed").length;
    const payload = {
      schema: final ? "papp-batch-sentinel-report-v1" : "papp-batch-sentinel-progress-v1",
      batchId: job.batchId,
      status: job.status,
      tournamentFile: job.tournamentFile,
      competitionName: job.competitionName,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      currentIndex: job.currentIndex,
      totalCount: job.players.length,
      completedCount: completed,
      failedCount: failed,
      currentPlayer: job.currentPlayer,
      players: job.players,
      results: job.results,
      reportPath: final ? path.join(job.directory, "report.json") : "",
    };
    return payload;
  }

  write(job, final = false) {
    const target = path.join(job.directory, final ? "report.json" : "progress.json");
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.snapshot(job, final), null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
  }

  start(input) {
    if (typeof this.runPlayer !== "function") throw new Error("批量哨兵运行器不可用");
    if ([...this.jobs.values()].some((job) => ["running", "terminating"].includes(job.status))) {
      throw new Error("已有多人哨兵分析正在运行，请等待完成");
    }
    const value = input && typeof input === "object" ? input : {};
    const tournamentFile = cleanText(value.tournamentFile);
    const competitionName = cleanText(value.competitionName);
    if (!tournamentFile) throw new Error("缺少比赛存档文件");
    const players = normalizePlayers(value.players);
    fs.mkdirSync(this.root, { recursive: true });
    let batchId;
    let directory;
    do {
      this.sequence += 1;
      batchId = `batch-${Date.now()}-${this.sequence}`;
      directory = path.join(this.root, batchId);
    } while (fs.existsSync(directory));
    fs.mkdirSync(directory);
    const job = {
      batchId,
      directory,
      tournamentFile,
      competitionName,
      players,
      status: "running",
      createdAt: this.now().toISOString(),
      completedAt: "",
      currentIndex: 0,
      currentPlayer: null,
      results: [],
      terminationRequested: false,
      activeRunId: "",
    };
    this.jobs.set(batchId, job);
    this.write(job);
    void this.run(job);
    return this.status(batchId);
  }

  async run(job) {
    for (let index = 0; index < job.players.length; index += 1) {
      if (job.terminationRequested) break;
      const player = job.players[index];
      job.currentIndex = index + 1;
      job.currentPlayer = player;
      this.write(job);
      try {
        const result = await this.runPlayer(player, job);
        if (job.terminationRequested) break;
        job.results.push({
          ...player,
          status: "completed",
          runId: cleanText(result && result.runId),
          summary: result && result.summary ? result.summary : null,
        });
      } catch (error) {
        if (job.terminationRequested) break;
        job.results.push({
          ...player,
          status: "failed",
          runId: cleanText(error && error.runId),
          error: cleanText(error && error.message) || "分析失败",
        });
      }
      this.write(job);
    }
    job.currentPlayer = null;
    job.status = job.terminationRequested ? "terminated" : "completed";
    job.completedAt = this.now().toISOString();
    this.write(job);
    this.write(job, true);
  }

  async terminate(batchId) {
    const id = safeBatchId(batchId);
    const job = this.jobs.get(id);
    if (!job || ["completed", "terminated"].includes(job.status)) return this.status(id);
    if (typeof this.stopPlayer !== "function") throw new Error("批量哨兵终止接口不可用");
    job.terminationRequested = true;
    job.status = "terminating";
    this.write(job);
    try {
      await this.stopPlayer(job);
    } catch (error) {
      job.terminationRequested = false;
      job.status = "running";
      this.write(job);
      throw error;
    }
    return this.status(id);
  }

  status(batchId) {
    const id = safeBatchId(batchId);
    const job = this.jobs.get(id);
    if (job) {
      if (job.status === "completed") {
        const report = path.join(job.directory, "report.json");
        if (fs.existsSync(report)) {
          return { ok: true, ...JSON.parse(fs.readFileSync(report, "utf8")) };
        }
      }
      const final = job.status === "completed";
      return { ok: true, ...this.snapshot(job, final) };
    }
    const directory = this.batchDir(id);
    for (const filename of ["report.json", "progress.json"]) {
      const file = path.join(directory, filename);
      if (fs.existsSync(file)) return { ok: true, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    }
    throw new Error(`找不到批量哨兵任务：${id}`);
  }
}

module.exports = { InvestigationBatchManager, normalizePlayers, safeBatchId };
