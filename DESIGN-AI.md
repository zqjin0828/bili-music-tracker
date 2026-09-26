# AI 增强判定 — 设计方案

> 用大模型替代/补充现有的规则引擎，判断「这是不是音乐」「歌名是什么」「哪个版本」
>
> 目标扩展：`bili-music-tracker` v1.2.0

---

## 一、为什么不完全抛弃规则引擎

先说清楚一个反直觉的结论：**规则引擎不该被删掉**。理由：

| 维度 | 规则引擎 | 大模型 |
|---|---|---|
| 延迟 | < 1ms | 0.5 ~ 5s |
| 成本 | 0 | ~¥0.001/次 |
| 离线可用 | ✅ | ❌ |
| 稳定性 | 确定 | 有波动、可能拒答 |
| 准确性（常见标题） | 90%+ | 95%+ |
| 准确性（刁钻标题） | 60% | 90%+ |

如果全部走 AI，你会遇到：B 站翻页快时请求堆积、网络断了插件就废了、
API 偶尔返回非 JSON 导致计数出错。

**正确做法是三层架构**：

```
第 1 层：本地规则引擎（毫秒级，永远先用）
   └─ 置信度 > 0.85  → 直接采纳，不调 AI
   └─ 置信度 < 0.85  → 交给第 2 层

第 2 层：AI 判定（秒级，只处理拿不准的）
   └─ 成功 → 采纳 + 永久缓存
   └─ 失败/超时 → 落到第 3 层

第 3 层：规则结果兜底（保证永远有结果）
```

**关键收益**：实测大部分标题规则引擎就够用，AI 只处理长尾。这能把 token 消耗压到
原来的 20~30%，同时拿到 AI 的准确性。

---

## 二、双通道设计（这是核心）

因为 WorkBuddy 无法常驻浏览器，所以必须支持两种接入方式，用户可切换：

### 通道 A：队列中转（WorkBuddy 模式）

```
┌─────────────────────────────────────────────────────────┐
│ 浏览器：插件                                             │
│  · 规则引擎拿不准 → 写入 pendingQueue                    │
│  · pendingQueue 结构：{ key, title, desc, up, tid,       │
│      tname, duration, ruleResult, addedAt, status }      │
│  · 同时用规则结果先计数（乐观策略，见第五节）             │
│  · 定期轮询 aiResults，有新结果就覆盖并修正计数           │
└────────────────────┬────────────────────────────────────┘
                     │ 用户触发 / 定时任务
                     ▼
┌─────────────────────────────────────────────────────────┐
│ WorkBuddy（我）                                          │
│  · 读取 pendingQueue                                     │
│  · 逐条构造 prompt → 调用云端 API                         │
│  · 校验响应 JSON，写回 aiResults                          │
│  · 从 pendingQueue 移除已处理项                           │
└─────────────────────────────────────────────────────────┘
```

**插件侧不存 API Key** → 更安全。
**触发方式**：你对我说「处理 B 站听歌队列」，或建一个定时自动化。

### 通道 B：插件直连 API

插件自己 `fetch` LLM API。需要你在设置里填：
- API 端点（默认 OpenAI 兼容格式）
- API Key
- 模型名（如 `gpt-4o-mini` / `deepseek-chat` / `glm-4-flash`）

**触发**：自动，实时。适合不想手动触发的场景。

> ⚠️ API Key 存在 `chrome.storage.local`，明文。这是浏览器扩展的固有限制。
> 建议用**权限受限的子 Key**，不要用主账号 Key。

### 通道切换

设置项 `aiChannel`: `"off" | "queue" | "direct"`

---

## 三、发送给 AI 的内容

### 3.1 采集字段

从 `__INITIAL_STATE__` 可拿到（v1.1 已采集大部分，需补 `desc`）：

| 字段 | 来源 | 用途 |
|---|---|---|
| `title` | `videoData.title` | 主判断依据 |
| `desc` | `videoData.desc` | **新增**，简介常含曲目表、原曲信息 |
| `up` | `videoData.owner.name` | 辅助 |
| `tid` / `tname` | `videoData.tid/tname` | 分区，强信号 |
| `duration` | `videoData.duration` | 区分单曲/合集 |
| `pages` | `videoData.pages[].part` | **新增**，分P标题是歌名的好来源 |

### 3.2 Prompt 设计（关键）

必须**强制 JSON 输出**且**给足 few-shot**，否则模型会自由发挥。

```
你是一个音乐元数据解析器。给定 B 站视频信息，判断它是否为音乐视频，
并提取结构化的曲目信息。

【判定规则】
- isMusic: 该视频主体是否为歌曲/音乐（含翻唱、演奏、纯音乐、MV、Live）
  - 教程、游戏实况、vlog、纪录片、影视解说 → false
  - 音乐区但不含具体曲目（如纯聊音乐）→ 视情况
- isCompilation: 是否为多首歌的集合（歌单/串烧/作业用BGM/超过30分钟的多曲合集）
- songName: 曲名。没有明确曲名就留空字符串，不要编造
- artist: 演唱者/原作者。分不清就留空
- version: 版本类型，只能从以下枚举选：
  original | 翻唱 | AI翻唱 | Live | Remix | 钢琴版 | 吉他版 |
  Acoustic | 纯音乐 | 中文版 | 日语版 | 粤语版 | 英文版 |
  替え歌 | Remake | Demo | 其他
  注意：歌ってみた/弾いてみた/カバー → 翻唱；オリジナル/本家 → original
- confidence: 你对本次判断的把握，0~1

【重要】
- 日语的「歌ってみた」是翻唱，不是原创
- 「カラオケ」「インスト」「オフボーカル」是伴奏，归入「纯音乐」
- 别把 UP 主名字当成歌手，除非标题明确写「歌手 - 歌名」且方向可确认
- 只输出 JSON，不要任何解释文字

【输出格式】
{"isMusic":bool,"isCompilation":bool,"songName":str,"artist":str,
 "version":str,"confidence":number,"reason":str}

【示例1】
输入: {"title":"【初音ミク】千本桜【オリジナル】","up":"ボカロP","tid":30,"tname":"VOCALOID·UTAU","duration":240,"desc":""}
输出: {"isMusic":true,"isCompilation":false,"songName":"千本桜","artist":"初音ミク","version":"original","confidence":0.95,"reason":"VOCALOID区，オリジナル表示原创曲"}

【示例2】
输入: {"title":"【ピアノ】千本桜","up":"piano ch","tid":59,"tname":"演奏","duration":260,"desc":"ピアノアレンジ"}
输出: {"isMusic":true,"isCompilation":false,"songName":"千本桜","artist":"","version":"钢琴版","confidence":0.92,"reason":"ピアノ明示钢琴版"}

【示例3】
输入: {"title":"【作業用BGM】アニソンメドレー 100曲","up":"music ch","tid":3,"tname":"音乐","duration":7200,"desc":"収録曲一覧..."}
输出: {"isMusic":true,"isCompilation":true,"songName":"アニソンメドレー","artist":"","version":"original","confidence":0.9,"reason":"メドレー+2小时+100曲，判为合辑"}

【示例4】
输入: {"title":"艾尔登法环 全boss无伤攻略","up":"游戏UP","tid":4,"tname":"游戏","duration":1800,"desc":""}
输出: {"isMusic":false,"isCompilation":false,"songName":"","artist":"","version":"","confidence":0.98,"reason":"游戏攻略，非音乐"}

【现在处理】
输入: {INPUT_JSON}
输出:
```

**设计要点**：

1. **枚举 version**：不给枚举模型会造出「日式摇滚版」「抒情翻唱」这种无法归一化的值，破坏 songKey 稳定性。
2. **few-shot 用真实踩坑案例**：示例 2 就是 v1.1 修的那个 `ピアノ` 问题。
3. **`reason` 字段**：便于你在 popup 里看到 AI 的判断依据，也方便我调试。
4. **明确「不要编造」**：模型有补全倾向，会硬凑一个歌名出来。
5. **`desc` 截断到 500 字**：简介可能极长，浪费 token。

---

## 四、缓存设计

```
aiCache: {
  "BV1xx411c7mD_p1": {
    result: { isMusic, isCompilation, songName, artist, version, confidence, reason },
    model: "gpt-4o-mini",
    at: 1758000000000,
    source: "queue" | "direct",
    confidence: 0.95        // AI 自评置信度
  }
}
```

**缓存键**：`BV号` 或 `BV号_p页号`（与 videoKey 一致）。

**永久缓存**（用户选择），但支持：
- 手动「重新判定」按钮 → 删除该条缓存
- 视频标题变了 → 检测到 `title !== cached.title` 时失效

> 为什么能永久缓存：一个 BV 号的标题/简介基本不变。永久缓存能把成本压到近乎零
> （每个视频只问一次，之后无限次复用）。

---

## 五、乐观计数与结果修正（容易踩的坑）

**问题**：AI 判定是异步的（尤其队列模式要等你触发）。但用户可能已经在听歌了。
如果等 AI 结果再计数，会丢掉这段时间的播放。

**方案：乐观计数 + 回溯修正**

```
播放达成 → 用规则引擎结果立即计数（乐观）
         → 同时写入 pendingQueue 请求 AI 判定
         → AI 结果回来：
             · 与规则结果一致      → 无操作
             · 判定为非音乐        → 回溯扣减（playCount -= 1）
             · songKey 变了        → 把计数从旧 key 迁到新 key
             · version 变了        → 同上
```

**回溯修正要幂等**：记录 `appliedAiRevision`，避免同一条 AI 结果被应用两次。

**边界**：如果 playCount 已经扣到 0，则删除该条记录而不是留负数。

---

## 六、失败与降级

| 情况 | 处理 |
|---|---|
| AI 超时（> 10s） | 用规则结果，`aiStatus: "timeout"` |
| AI 返回非 JSON | 尝试提取 `{...}` 片段；再失败则丢弃 |
| AI 返回字段缺失 | 缺的字段回退到规则结果 |
| version 不在枚举内 | 归一化到最近的枚举值，或置 `其他` |
| AI 判定与规则冲突且 AI 置信度 < 0.6 | 保留规则结果，标注「AI 存疑」 |
| 队列模式下无 WorkBuddy 响应 | 保持规则结果，队列不删（下次继续） |
| API 限流 429 | 指数退避，最多 3 次 |
| 无网络 | 跳过 AI，纯规则运行 |

**核心原则**：**AI 永远不能让插件不可用**。任何 AI 环节失败都必须优雅降级。

---

## 七、成本估算

以 `gpt-4o-mini` 为例（输入 ~$0.15/M token，输出 ~$0.6/M token）：

- 单次 prompt ≈ 900 token（含 few-shot），输出 ≈ 80 token
- 单次成本 ≈ 900×0.15/1e6 + 80×0.6/1e6 ≈ **$0.000183** ≈ **¥0.0013**

配合三层架构（只有 ~25% 的视频需要 AI）和永久缓存：

| 场景 | AI 调用次数 | 成本 |
|---|---|---|
| 听 100 首歌（首次） | ~25 次 | ≈ ¥0.03 |
| 同上，重听 | 0 次（缓存命中） | ¥0 |
| 一个月重度使用（500 视频） | ~125 次 | ≈ ¥0.16 |

**结论**：成本可以忽略。真正的成本是延迟和实现复杂度，所以三层架构很值得。

---

## 八、数据结构变更

```js
// 新增 storage key
settings: {
  ...,
  aiChannel: "off",            // off | queue | direct
  aiEndpoint: "",              // 直连模式用，OpenAI 兼容端点
  aiApiKey: "",                // 直连模式用，明文存储（警告用户）
  aiModel: "gpt-4o-mini",
  aiConfidenceThreshold: 0.85, // 高于此值不调 AI
  aiTimeout: 10000,
  aiApplyMode: "auto"          // auto | suggest  —— 是否自动应用AI结果
}

pendingQueue: {
  "BV1xx_p1": {
    key, bvid, page, title, desc, up, tid, tname, duration, part,
    ruleResult: {...},     // 规则引擎的判断，供 AI 参考 + 兜底
    addedAt, status
  }
}

aiResults: {
  "BV1xx_p1": {
    result: {...},         // AI 判断
    model, at, source,
    appliedRevision: 0     // 已应用到第几版，用于幂等
  }
}

aiCache: { ... }           // 永久缓存，避免重复调用
```

---

## 九、UI 变更

### popup 新增

1. **AI 面板**（设置里）
   - 通道选择：关闭 / 队列中转 / 直连 API
   - 直连模式：端点、Key、模型名输入框
   - 置信度阈值滑块
   - 「测试连接」按钮

2. **队列状态条**（主界面顶部）
   ```
   ┌────────────────────────────────────────┐
   │ 🤖 12 个视频待 AI 判定  [复制队列] [清空]│
   └────────────────────────────────────────┘
   ```
   「复制队列」把 pendingQueue 序列化为 JSON 放进剪贴板 ——
   你就能直接粘给我处理，**这是通道 A 最简的触发方式**。

3. **条目上的 AI 标记**
   - `🤖` 表示该条经过 AI 判定
   - 悬浮显示 AI 的 `reason`
   - 「重新判定」按钮

4. **AI 结果确认**（`aiApplyMode: "suggest"` 时）
   - AI 判定与规则不同 → 条目高亮，显示「AI 认为：翻唱（点击采纳）」

### content.js 新增

- 采集 `desc`（简介）和 `pages[].part`
- AI 结果回来后修正计数（通过 background 广播）

---

## 十、实施计划

| 阶段 | 内容 |
|---|---|
| P0 | `ai.js`：prompt 构建 + 响应解析 + 校验 + 归一化 |
| P0 | 三层架构调度逻辑（规则→AI→兜底） |
| P0 | `aiCache` 永久缓存 |
| P1 | 通道 A（队列）：background 队列管理 + popup 复制队列 |
| P1 | 通道 B（直连）：fetch 调用 + 超时 + 退避重试 |
| P1 | 乐观计数 + 回溯修正（含幂等） |
| P2 | popup AI 面板与队列状态条 |
| P2 | `aiApplyMode: suggest` 人工确认流 |
| P2 | 单测：prompt 构建、响应校验、降级路径 |

---

## 十一、WorkBuddy 侧的工作流

你（或在自动化任务里）对我说：

> 「处理 B 站听歌队列」

我会：
1. 从 `pendingQueue` 读出待判定项
2. 逐条按上面第五节构造请求，调云端 API
3. 校验响应，写回 `aiResults`
4. 从 `pendingQueue` 移除已处理项
5. 回报：处理了几条、AI 与规则不一致的有哪些

**也可以做成定时自动化**，比如每天凌晨处理一次队列。

> 注意：我这边需要能访问浏览器扩展的 `chrome.storage.local`。
> 扩展的 storage 是 LevelDB 格式，位置在 Chrome 用户数据目录下。
> 实际实现时会在 popup 提供 **「导出队列 JSON」/「导入结果 JSON」** 两个按钮，
> 用文件做中转 —— 这样不依赖直接读 Chrome 内部数据，更稳妥、更通用。
