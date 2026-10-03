# PAPP 比赛编排前端接口

更新日期：2026-09-12

## 结果权威与运行边界

比赛结果由本地 PAPP C 提供。前端通过适配器请求本地服务 POST /api/papp/tournament；服务启动编译产物 bin/Windows/papp_GB.exe，并以 --tournament-json 调用结构化接口。OQ 使用 POST /api/papp/oq/poll，原始棋局快照交给 C 处理。C 不可用或返回错误时，页面显示错误，不回退到 JavaScript 结果算法。

JavaScript 负责页面交互、收集人工输入和 OQ 原始数据、候选名单与姓名映射、纯字段映射、调用本地服务、共享状态写入和展示。预赛配对继续使用 PAPP C 原生核心算法和随机行为。旧 JS 配对、排名、淘汰赛及 OQ 计分实现已从活动代码路径清退；比分输入的格式化与显示校验仍由页面完成，正式比分校验由 C 返回。

## C 操作

| 操作 | 输入 | 由 C 返回的结果 |
|---|---|---|
| round-count | 已签到 playerCount；可选 manualRoundCount | roundCount、PAPP C 来源及错误码 |
| pairings | 阶段、轮次、选手、预赛轮次与历史 | 预赛或淘汰赛配对；Bye 使用 PAPP C 的 40:24 口径 |
| validate-pairings | 导入或人工配对、参赛选手和阶段 | 身份、参赛覆盖、种子与比分有效性及规范化配对 |
| validate-score | 黑白比分；允许单边比分输入 | 完整性、C 补算的 scorePair 或错误 |
| preliminary-standings / overall-standings | 选手、预赛轮次、已登记比分和赛制参数 | C 积分、Brightwell、排名、阶段进度与最终名次 |
| round-standings | 目标预赛轮次、选手、预赛轮数、赛制参数和比分历史 | 截至目标轮次的 PAPP C 排名、目标轮完成状态和预赛进度 |
| stage-status | 阶段、轮次、配对和已登记比分 | complete、canAdvance、nextStage 及错误码 |
| write-score-batch / read-score-batch | 比赛 workfile ID、阶段、轮次、batchId、稳定配对 ID、桌号、黑白身份与比分；读回同时提供 pairingIds | 写入该比赛独立的 PAPP 原生 workfile；read 重新用 PAPP C 解析同一文件，并核对原生轮次比分与批次身份 |

比分批次只以 PAPP workfile 为权威存储。每场比赛的 `scoreHelper.pappWorkfileId` 在新建比赛时生成，并随签到状态及进度 JSON 导出；恢复同一份进度时沿用该 ID，创建另一场比赛时使用新 ID。本地服务按 ID 将文件保存在 `data/papp-tournament-workfiles/papp-<ID>.txt`；可用 `PAPP_TOURNAMENT_WORKFILES_DIR` 指定目录。旧的根目录 `papp-internal-workfile.txt` 保留为原样，不会被新比赛读写，因此未完成比赛互不串用。写入将 0–64 的整数比分（黑白合计 64）序列化为 PAPP 原生轮次结果，并在同一 workfile 中保存适配映射，以保留稳定配对 ID、桌号、参赛者账号及黑白方向；文件只推进到已有比分的最高轮次，不提前登记未来轮次。相同 batchId 和内容重试为幂等写入；同一 batchId 内容不同、配对或桌号重复、PAPP 原生读回缺失/重复/身份或比分不符时返回失败。write 的 accepted 仅表示 PAPP 已接受或完成写入；页面只有 readScoreBatch 从原生 workfile 读回并逐项匹配后才把比分标为 completed。缺少或格式无效的比赛 workfile ID 会在本地服务明确拒绝，不会退回共用 workfile。

若写入下一轮时，PAPP workfile 恰好多出一个紧随最后已持久化轮次的空原生轮次（无任何比分行），C 会先核对已有原生比分，再用本次比分批次重建 workfile。读回旧批次、跳过多轮，或额外轮次含比分行时仍会拒绝。

积分字段 pointsHalfUnits 是内部半分整数，胜局为 2、和棋为 1；displayPoints 是人类显示积分，胜局为 1、和棋为 0.5。totalPoints 若用于兼容页面，也使用显示积分单位，不能把半分整数直接显示为积分。

`round-standings` 使用现有 `POST /api/papp/tournament` 通道，适配器调用 `getRoundStandings(context)` 时传入 `operation: "round-standings"` 和目标预赛 `round`。C 严格校验目标轮次为 1 到 `preliminaryRoundCount` 的整数；适配器不截断或夹取越界轮次。请求包含当前参赛选手、赛制参数和 `state.scoreHelper.rounds` 比分历史。前端应在该轮每场比分经 `readScoreBatch` 从 PAPP workfile 读回并确认为 `completed` 后请求排名。

PAPP C 只载入第 1 轮到目标轮次的数据。请求第 2 轮时，排名累计第 1、2 轮；请求第 1 轮时，第 2 轮及之后的数据不参与本次积分、同分比较或排名。即使预赛总轮数尚未完成，只要目标轮及其之前各轮的配对和比分都已完成确认，C 仍返回排名。行字段与既有排名接口一致：`rank`、`preliminaryRank`、`playerId`、`displayName`、`account`、`pointsHalfUnits`、`displayPoints`、`totalPoints`、`brightwell` 和 `totalDiscs`；JavaScript 仅传入请求、映射字段并展示 C 返回的数组。

可复制的请求示例：

```json
{
  "operation": "round-standings",
  "round": 1,
  "preliminaryRoundCount": 1,
  "players": [
    { "id": "p1", "displayName": "Alpha", "account": "acct_a" },
    { "id": "p2", "displayName": "Bravo", "account": "acct_b" }
  ],
  "presentPlayerIds": ["p1", "p2"],
  "tournamentParameters": {
    "hasSemifinalAndFinal": false,
    "brightwellConstant": 0
  },
  "rounds": [
    {
      "round": 1,
      "presentPlayerIds": ["p1", "p2"],
      "pairings": [
        {
          "id": "r1-t1",
          "blackId": "p1",
          "whiteId": "p2",
          "blackScore": 40,
          "whiteScore": 24,
          "status": "completed"
        }
      ]
    }
  ]
}
```

成功响应示例：

```json
{
  "ok": true,
  "source": "papp-c",
  "operation": "round-standings",
  "stage": "preliminary",
  "round": 1,
  "targetRound": 1,
  "throughRound": 1,
  "preliminaryRoundCount": 1,
  "participantCount": 2,
  "hasSemifinalAndFinal": false,
  "pointsUnit": "half-point-ticks",
  "progress": {
    "expectedRounds": 1,
    "roundsWithPairings": 1,
    "missingRounds": [],
    "unresolvedPairings": 0,
    "complete": true
  },
  "complete": true,
  "status": "complete",
  "roundComplete": true,
  "roundStatus": "complete",
  "standings": [
    {
      "rank": 1,
      "preliminaryRank": 1,
      "playerId": "p1",
      "displayName": "Alpha",
      "account": "acct_a",
      "pointsHalfUnits": 2,
      "displayPoints": 1,
      "totalPoints": 1,
      "brightwell": 40,
      "totalDiscs": 40
    },
    {
      "rank": 2,
      "preliminaryRank": 2,
      "playerId": "p2",
      "displayName": "Bravo",
      "account": "acct_b",
      "pointsHalfUnits": 0,
      "displayPoints": 0,
      "totalPoints": 0,
      "brightwell": 24,
      "totalDiscs": 24
    }
  ],
  "stageProgress": {
    "complete": true,
    "cumulativeHistoryComplete": true
  },
  "nextStage": "overall-ranking"
}
```

`complete` 表示从第 1 轮到所请求轮次的数据足以生成排名；`roundComplete` 和 `roundStatus` 单独描述目标轮。目标轮或前序轮未登记、没有配对或仍有比分未被 PAPP C 确认时，响应为 `ok: true`、`complete: false`、`standings: []`，并带 `blockingRound` 与状态码 `round-missing` 或 `round-results-incomplete`。目标轮已完成但前序轮缺失时，`roundComplete` 可以为 `true`，整体 `complete` 仍为 `false`，不返回排名。非整数或越界轮次返回 `ok: false`、`code: "invalid-round-index"`；比分不在 0–64 范围返回 `invalid-score`，黑白比分之和不等于 64 返回 `invalid-score-pair`；缺少选手 ID 的轮空记录返回 `invalid-bye`。错误响应不包含部分排名。

响应中的 `targetRound` 和 `throughRound` 都等于请求的 `round`；`throughRound` 保留供现有前端调用契约使用。

`progress.complete` 和 `stageProgress.complete` 表示整场预赛是否全部完成，因此可以与一个已完成历史轮次的 `complete: true` 同时出现。排名查询只计算请求中的历史比分，不读写比赛 workfile 或 `data/checkin-state.json`；本地服务仅对比分批次读写操作选择比赛专属 workfile。

实时排名窗口按 `pappWorkfileId + 类型 + round` 缓存 PAPP C 的快照。推进到下一预赛轮次前会尝试保存刚完成轮次的快照；最后一轮排名也会从淘汰赛种子查询保存。快照使用签到状态的常规 `POST /api/state` 同步，不直接改写共享 JSON。缓存显示更新时间，重复读取同一轮时只替换该轮条目；最终名次使用既有 `overall-standings` 操作并显示在同一窗口。

自动预赛轮数按实际已签到人数计算：max(4, floor(log2(n)) + 1)。无人签到时页面禁止开始；手动轮数保持用户设置，C 校验 1–128 轮上限。hasSemifinalAndFinal 默认启用；auto 模式在已签到人数达到 8 人时启用淘汰赛。Brightwell 默认常数为 6，允许 0 和非负小数；0 时沿用 PAPP C 的总棋子数同分决胜语义。

## 阶段规则

开启淘汰赛时，预赛全部完成后，`preliminary-standings` 提供供半决赛种子使用的预赛最终排名；种子为第 1 对第 4、第 2 对第 3。半决赛胜者打决赛、负者打三四名赛。半决赛完成后不返回新排名；只有决赛和三四名赛两场比分都由 PAPP C 确认后，`overall-standings` 才提供最终总排名。淘汰赛平局由预赛 C 排名较高者判胜，第 5 名以后沿用预赛 C 排名。

关闭淘汰赛时，预赛完成后 `overall-standings` 直接提供最终排名；阶段完成与能否推进由 C 返回。

## 旧比赛记录

data/checkin-state.json 中已有 source 为 papp-adapter 的计分轮次继续作为旧记录展示。适配器将它们作为只读历史，不让 C 重算、不改写来源、不转换、不清除；OQ 轮询和分数登记也不会修改这些行。新 C 配对标记为 papp-c。本次没有写入共享状态文件。

## 名单、映射与共享状态

getCandidates 从 GET /api/state 读取已持久化的 state.players。syncCandidates 通过 POST /api/state 的 sync-candidates 操作提交完整候选池与有效映射，脚本写入使用 source: script；用户写入使用 source: human。脚本不得直接覆盖 data/checkin-state.json；本地服务按规则处理用户写入后的 3 秒保护和排队补写。

候选池保留顺序、重名、稳定 ID、账号、平台和其他字段；只有已签到选手参与编排。映射依候选稳定 ID 更新长期 PAPP 选手记录，不按姓名模糊猜测。缺失映射或候选移除不会删除 PAPP 记录或比赛历史。

## OQ 结果

本地服务直接访问 OQ，与参考自动化流程使用相同的公开 JSON 接口：按每桌名单映射得到的双方 OQ 账号分别请求 `/games/{mode}/{account}.json`，再由 PAPP C 按精确账号组合和本轮时间窗筛出候选。默认使用 5 分钟模式 `reversi`，并行度 8、单次请求超时 20 秒；模式端点为 1 分钟 `reversi1`、5 分钟 `reversi`、XOT `reversix`。可用 `PAPP_OQ_BASE_URL`、`PAPP_OQ_MODE`、`PAPP_OQ_TIMEOUT_MS`、`PAPP_OQ_CONCURRENCY` 配置本地服务。

C 首次处理账号查询快照时返回需要补详情的 game ID；本地服务随后按 `/game/{gameId}.json` 获取 detail，再把完整对局交回 C 最终核对和处理。若缺少该详情或取回失败，对局进入 pending 并显示失败原因。C 回放 `position.moves` 得到棋盘结果，不采用 OQ 摘要中的 `blackScore`、`whiteScore` 或 score difference。普通终局的空格计给棋盘领先方；认输、超时、断线按回放中的终局状态写成 64:0。实际 OQ 黑白方向可能与 PAPP 配对显示顺序不同，C 根据本桌双方的账号映射将回放结果映回配对的左右选手。

缺少棋谱、非法着法或同桌命中多局进入 pending；无匹配棋局进入 skipped。人工比分受保护，差异保留为待核对；裁判已解决候选不会被重复处理，用户 pending 保留原人工原因并记录 followup。页面只呈现 C 返回的 ready、pending、skipped 及审计信息。

为测试和显式导入保留 `oqPollResult` 快照接口；设置 `PAPP_OQ_RESULTS_FILE` 时也可显式读取快照文件。没有指定快照来源时默认执行上述 OQ 网络查询和 detail 补抓，不读取隐式旧快照文件。

## 页面 API 与辅助功能

页面初始化后提供 window.PAPP_TOURNAMENT_API：

- getState、getTournamentParameters、getRound：读取状态副本。
- setActiveRound、setRoundStart、setRoundPairings：更新页面轮次和配对展示。
- setActivePlayoffStage：切换半决赛与名次赛登记。
- mergeOqPollResult：合并 C 返回的轮询结果和审计信息。
- getEgAnalysis、setEgAnalysis、mergeEgAnalysisResult：管理 EG 报告展示。
- preliminaryRoundCountForPlayerCount：通过 C 获取自动预赛轮数。

EG 分析由仓库内的 Egaroucid 引擎提供，不产生比赛结果。接口为 /api/papp/eg/status、/api/papp/eg/start 和 /api/papp/eg/stop；缺少棋谱时明确失败。

## 构建与验证记录

Windows 构建产物为 bin/Windows/papp_GB.exe。本次在临时副本中编译 Windows 版本并完成 round-count 冒烟验证；生成的 lexyy.c、pap_tab.c 有既存生成代码警告。前端完整 Node 回归 107/107 通过；比分批次适配器、C 集成与多赛事 workfile 隔离专项回归 57/57 通过；app.js、tournament-adapter.js、local-server.js 及新增测试的 Node 语法检查通过。

旧 oq-score-logic.js 与专属 oq-score-logic.test.cjs 已替换为 C/EXE 集成覆盖并移入 Windows 回收站。浏览器测试依项目约束由用户执行。
