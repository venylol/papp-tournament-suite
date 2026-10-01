"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { InvestigationBatchManager } = require("./papp-investigation-batch.js");

for (const root of [__dirname]) {
  for (const page of ["analysis", "batch-analysis"]) {
    for (const scenario of ["cancel", "confirm", "waiting", "finished", "failure"]) {
      test(`${root}: ${page} return ${scenario}`, async () => {
        const nodes = new Map();
        const getNode = (selector) => {
          if (!nodes.has(selector)) nodes.set(selector, { href: "./", addEventListener(type, handler) { this[type] = handler; } });
          return nodes.get(selector);
        };
        const calls = [];
        let destination = "";
        let prompts = 0;
        const single = page === "analysis";
        const running = single ? { running: true } : { status: "running" };
        const done = single ? { running: false, terminated: true } : { status: "terminated" };
        const sandbox = {
          URLSearchParams, Intl, Date, console,
          document: { querySelector: getNode },
          window: {
            location: { search: single ? "?runId=test" : "?batchId=test", assign(value) { destination = value; } },
            confirm() { prompts += 1; return scenario !== "cancel"; },
            addEventListener() {},
          },
          setTimeout(callback) { callback(); },
          fetch: async (url, options) => {
            calls.push({ url, options });
            if (calls.length === 1) return new Promise(() => {}); // Hold the independent progress watcher.
            if (options.method === "POST" && scenario === "failure") throw new Error("test termination failure");
            const pending = single ? { running: true, terminationRequested: true } : { status: "terminating" };
            const payload = scenario === "waiting" && options.method === "POST" ? pending
              : options.method === "POST" || scenario === "finished" || calls.length === 4 ? done : running;
            if (calls.length === 4) assert.equal(destination, "");
            return { ok: true, json: async () => ({ ok: true, ...payload }) };
          },
        };
        vm.runInNewContext(fs.readFileSync(path.join(root, "papp-portal/player-investigation", `${page}.js`), "utf8"), sandbox);
        const link = getNode(`#${page === "analysis" ? "analysis" : "batch"}-header-back`);
        let prevented = false;
        await link.click({ currentTarget: link, preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(prompts, scenario === "finished" ? 0 : 1);
        assert.equal(destination, ["confirm", "waiting", "finished"].includes(scenario) ? "./" : "");
        assert.equal(calls.filter((call) => call.options.method === "POST").length, ["confirm", "waiting", "failure"].includes(scenario) ? 1 : 0);
      });
    }
  }
}

test("terminating a batch stops the active player and skips queued players", async () => {
  const root = path.resolve(__dirname, "../../artifacts/investigation-return-tests", `batch-${Date.now()}`);
  let finish;
  const visited = [];
  let stopped = false;
  const manager = new InvestigationBatchManager({
    root,
    runPlayer(player) {
      visited.push(player.account);
      return new Promise((resolve) => { finish = resolve; });
    },
    async stopPlayer() { stopped = true; finish({ runId: "one" }); },
  });
  const start = manager.start({ tournamentFile: "test.csv", players: [{ rank: 1, account: "one" }, { rank: 2, account: "two" }] });
  const result = await manager.terminate(start.batchId);
  assert.equal(stopped, true);
  assert.equal(result.status, "terminated");
  assert.deepEqual(visited, ["one"]);
  assert.equal(result.failedCount, 0);
  const restored = new InvestigationBatchManager({ root });
  assert.equal(restored.status(start.batchId).status, "terminated");
});
