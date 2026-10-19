# opencode-session-proxy

一个运行在 OpenCode 推理端点前的小型反向代理，为每个会话铸造一个结构合法的
`x-opencode-session`。

## 背景

OpenCode 的网关只接受"看起来像 OpenCode 客户端"的请求，且会话头必须满足

```
ses_ + 12 位 hex + 恰好 14 位 base62          （共 30 字符）
```

这 12 位 hex 不是随便填的十六进制，而是 OpenCode 自己那套 id 编码：

```
current = Date.now() * 4096 + counter        // counter 是同毫秒内的自增序号
value   = ~current                           // 取反（descending：越新越靠前）
hex     = value 的低 48 位，大端，12 位
```

（见 anomalyco/opencode `packages/schema/src/identifier.ts`。）两个后果值得注意：

- **id 是时钟的补码**。直接把时钟写进 hex（本代理早期就是这么做的）会铸出
  一个"反着的"id：解出来 counter 变成 `4096 - counter`、时钟跑到几年之外。
  网关只要解一次前缀就能看出这不是 OpenCode 发的会话。
- 只有低 48 位会被保留，所以解出来的时钟是 `Date.now() mod 2^36`
  —— 约 795 天一个循环的滚动窗口。

`new-api` 无法通过配置拼出这样的值，所以这里按同一套算法自行铸造；14 位 base62
用于标识会话，使每个用户/会话都拥有稳定且互不相同的 session。

## 使用

```bash
bun install
cp .env.example .env    # Windows：copy .env.example .env
bun start               # 或者：bun run dev（监听文件变化）
```

然后把上游渠道的 base URL 指向本代理：

```
https://opencode.ai/inference  ->  http://127.0.0.1:8787/inference
```

`GET /` 会返回一个精简的健康检查载荷（上游地址、会话模式、出站配置），
方便确认代理已就绪。

## 环境变量

| 变量                     | 默认值                 | 说明                                     |
| ------------------------ | ---------------------- | ---------------------------------------- |
| `PORT`                   | `8787`                 | 监听端口                                 |
| `HOST`                   | `127.0.0.1`            | 监听地址                                 |
| `UPSTREAM`               | `https://opencode.ai`  | 上游 base URL                            |
| `PROXIES`                | _(空)_                 | 出口代理池，见下文                       |
| `EGRESS_STRATEGY`        | `stable`               | `stable` / `round-robin` / `random`      |
| `XCP_HOST`               | _(空)_                 | xc-p 控制面地址；设置后用它节点池做出站  |
| `XCP_API_KEY`            | _(空)_                 | 服务 API Key（scope：`read` + `credentials`） |
| `XCP_REFRESH_MS`         | `360000`               | 节点列表刷新间隔（6 分钟）               |
| `XCP_RETRIES`            | `1`                    | 429 / 节点故障后的换节点重试次数（0..5） |
| `XCP_STATE`              | `.oc-ss-p/rate-limited.json` | 当日限流记录（JSON）              |
| `XCP_RESET_HOUR`         | `8`                    | 限流记录清空时刻（本地时间）             |
| `SESSION_PREFIX`         | _(按会话铸造)_         | 固定 12 位 hex 前缀（旧默认 `ses_ecbe61115ffe`） |
| `ROTATE_SESSION_PREFIX`  | `false`                | 为每次请求铸造新前缀（建议别开）         |
| `SESSION_COUNTER`        | `1`                    | 前缀内嵌的 counter（12 位，1..4095）     |
| `USER_AGENT`             | _(按会话派生)_         | 固定 UA，取代指纹                        |
| `CLIENT`                 | _(按会话派生)_         | 固定 `x-opencode-client`，取代指纹       |
| `CANONICALIZE_PATHS`     | `true`                 | 把旧的无 family 推理路径改写到规范路径   |
| `VERBOSE`                | `false`                | 打印 `METHOD path -> session via <出口>` |

非法配置会在**启动时**直接失败，而不是等到第一个请求。
完整注释模板见 `.env.example`。

## 端点路径

OpenCode 在 2026-10-12 起把 Console 推理搬到带 API family 的端点
（[#54777](https://github.com/anomalyco/opencode/pull/54777)），网关自己做的是这个映射：

```
POST /zen/v1/chat/completions  ->  /openai/v1/chat/completions
POST /zen/v1/messages          ->  /anthropic/v1/messages
POST /zen/go/v1/chat/completions -> /go/openai/v1/chat/completions
```

直连推理 base 的调用方（例如 `new-api` 渠道）拿到的仍是旧的
`/inference/v1/chat/completions`。这条别名今天还能路由，但它既不在网关映射表里，
也不在文档里，所以 `CANONICALIZE_PATHS`（默认开启）会把它改写掉：

| 请求路径                              | 上游路径                                            |
| ------------------------------------- | --------------------------------------------------- |
| `/inference/v1/chat/completions`      | `/inference/openai/v1/chat/completions`             |
| `/inference/v1/responses`             | `/inference/openai/v1/responses`                    |
| `/inference/v1/messages`              | `/inference/anthropic/v1/messages`                  |
| `/inference/go/v1/chat/completions`   | `/inference/go/openai/v1/chat/completions`          |
| `/inference/v1beta/models/<model>:...` | `/inference/google/v1beta/models/<model>:...`        |

`/inference/v1/models` 是文档公布的模型列表端点，**不改写**；已经是规范路径的请求
原样通过。设 `CANONICALIZE_PATHS=0` 可整体关闭。

## Zen 免费模型（参照 magpie 的 gateway/zenfree.go）

OpenCode Zen 的免费模型（id 以 `-free` 结尾，另有 `big-pickle`、`grok-code`）只对
"看起来像 OpenCode 客户端"的请求应答。本代理对这类请求自动做四件事：

1. **URL 重写**：`/zen/...` → `/inference/...`。2026-10 之后 Zen 对免费模型在
   `/zen/v1` 一律 403 FreeTierError，同样的请求发到 `/inference/v1` 就是 200。
2. **强制流式**：请求体 `stream` 置为 `true`（免费层只应答流式请求）。
3. **注入工具**：请求里补上 `bash` 和 `read` 两个工具（带 OpenCode 自己的参数
   schema；没有参数的空 schema 也会被拒）。客户端已有的大小写不同版本
   （如 Claude Code 的 `Bash`/`Read`）改名为小写提供，模型的调用在响应流里
   改回客户端自己的名字；客户端没有的以 stub 形式提供（描述为"永远不要调用"），
   模型对 stub 的调用从响应流中丢弃。
4. **匿名密钥**：免费模型用 `Authorization: Bearer public`（OpenCode 未登录时
   用的匿名 key）即可，调用方自己的 key 原样保留。

非免费模型完全不走这条管线：路径、流式、工具都原样转发。

## 出口代理（隐藏本机 IP）

opencode 看到的是**出站**连接方的 IP。要隐藏本机 IP，就把上游流量交给代理池：

```bash
PROXIES="http://user:pass@host1:8080#alpha,http://user:pass@host2:8080#beta"
```

- 用 `,` 或换行分隔；`url#label` 可在 `VERBOSE` 日志里显示可读名字。
- **仅支持 `http://` 与 `https://`。** Bun 的 `fetch` 会以
  `UnsupportedProxyProtocol` 拒绝 `socks5://`、`socks5h://`、`socks4://`，
  因此本代理在启动时就会拒绝这些协议，绝不会静默直连。
- `EGRESS_STRATEGY` 决定每次请求走哪个出口：
  - `stable`（默认）——同一会话固定同一个出口 IP。身份保持一致，比逐轮跳变更
    不像自动化程序。
  - `round-robin` / `random`——把请求分散到整个池子。

`https://` 上游通过 `CONNECT` 隧道穿过代理。

### xc-p 节点池

维护 `PROXIES` 要手工改环境变量。如果本机（或内网）跑着 **xc-p**（Xray 节点池面板），
把它的控制面地址和一枚服务 API Key 填进来，出站就直接用它检测过的节点池：

```bash
XCP_HOST=http://127.0.0.1:8080
XCP_API_KEY=<面板「API Keys」里创建的 key>
```

Key 要勾 `read` 与 `credentials` 两个 scope：节点列表走 `GET /v1/nodes`，凭据走
`GET /v1/endpoints`，网关端口走 `GET /v1/gateway`；`/v1` 认的是
`Authorization: Bearer <key>`，不需要管理员会话。

**xc-p 把整个池子挂在同一个网关端口上**，靠**代理用户名选节点**
（用户名 = 节点 ID，密码 = 该节点凭据），所以每一跳都是
`http://<节点用户名>:<密码>@<XCP_HOST 的主机>:<网关端口>`。主机取 `XCP_HOST`
的主机名（而不是 `/v1/gateway` 里的 `host`——那是面板展示用的 `panel.baseUrl`，
在这里不一定能解析）。

行为：

- **按状态选**：`GET /v1/nodes` 返回 xc-p 检测状态机的结论
  （`up` / `degraded` / `down` / `quarantined` / `unknown`）。排序是
  `up` → `degraded` → `unknown`，同档按实测 `delayMs` 升序；`down` 与
  `quarantined` 永远不会被选中，`unknown`（刚导入还没测过）留作兜底。
- **每 6 分钟**重新拉一次列表（`XCP_REFRESH_MS`）。刷新失败时保留上一份列表，
  不会一次性丢掉所有出口。
- **选中一个节点后一直用它**，不按对话轮换：出口 IP 只在被限流或节点失效时才变。
- **出现 429 或节点不可达**时，退役该节点、切换到下一个可用节点，并把当前请求重试
  一次（`XCP_RETRIES`）。两种情况都没有真的打到 opencode，重放请求没有副作用。
- **当天已被限流的出口 IP 不再使用**：记录写进 `XCP_STATE`（默认
  `.oc-ss-p/rate-limited.json`），纯 JSON，不引入任何依赖。
- **每天 8 点后清空限流记录**（`XCP_RESET_HOUR`）：一天从 08:00 到次日 08:00，
  早于当前这一天起点的记录会在下次读取时被丢掉 —— 不需要任何定时任务，进程睡过去了、
  重启了，都不会漏掉这次清零。
- 节点池为空或全部退役时，回退到 `PROXIES`（如果配了），否则直连。
- `GET /` 会返回节点池实时状态（当前节点及其状态/出口 IP、各状态节点数、今日已限流数量）。

> 记录以节点 ID 为键，同时记下当时的**出口 IP**（`/v1/nodes` 的 `status.exitIp`，
> 由 xc-p 检测的第三步确认）。于是同一个出口换了个节点 ID 回来，或者两个节点共用
> 同一个出口 IP，都会被认成"今天已经限流过的 IP"而跳过。

> 网关自己也会回 `429`（并发上限 `gateway.maxConcurrentPerUser` /
> `maxConcurrentPerIp`），但那是 **CONNECT 阶段的应答**：https 上游会因此让
> `fetch` 抛错，走的是"节点不可达"分支，不会被误判成 opencode 的限流。真正作为
> `429` 响应回给本代理的，只有 opencode 自己的限流。

## 指纹

早期所有用户共用同一个 session 前缀、同一个 UA、同一个 client 标签——这比共用
一个出口 IP 更像"自动化集群"。现在除非显式固定，以下三项都按会话派生：

- 12 位 hex 前缀：按会话铸造一次，时钟就是这段对话开始的时间（按 OpenCode
  的 descending 编码，解出来与真实客户端一致）。
- session id 的 14 位后缀：按会话派生。
- `user-agent` + `x-opencode-client`：按会话成对派生。

**UA 和 client 标签是一对，不能各自随机。** OpenCode 1.19.0 的写法是

```
user-agent:        opencode/<version>/<name> ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
x-opencode-client: <name>
```

（见 anomalyco/opencode `packages/core/src/app.ts` 的 `useragent()`）。早先这里
把版本、平台后缀、client 标签各自独立抽取，于是会出现
`opencode/latest/2.0.22/cli-darwin` 配 `desktop` 这种 OpenCode 自己永远不会发的
组合——平台后缀只出现在实现里，从不拼进 UA。现在：

- UA 尾部就是 client 标签，版本取自最近的正式发布。
- 固定了 `USER_AGENT` 时，client 标签从该 UA 里反解，保持成对。
- 固定了 `CLIENT` 时，生成的 UA 用这个标签。
- 调用方自己发来的 `opencode/...` UA 会被保留，同时 client 标签与它对齐。

每个信号对同一会话保持稳定，跨会话则互不相关。

> 这些措施降低被聚类关联的概率，但**不等于"不被识别"**。opencode 的风控规则
> 不公开，无法验证任何配置能稳定通过。2026-10-14 起免费层的判定已经不只看头：
> 新推理服务会检查请求是不是"像官方客户端的行为"（工具清单被裁剪、`bash` 被
> deny、agent 权限受限都会触发 403 `FreeTierError`），社区里的恢复手段是
> 登录 Console 账号（`/connect`）。若代理池中各出口 IP 归属同一注册主体，
> 效果同样会打折。

## 目录结构

按 Elysia 最佳实践采用 feature-based 结构：

```
src
  modules
    proxy
      index.ts     Elysia 控制器（路由 + 校验）
      service.ts   业务逻辑（配置、转发）
      model.ts     配置的 TypeBox schema
  utils
    session.ts     session 铸造辅助（前缀铸造 + 缓存）
    fingerprint.ts 按会话成对派生 UA/client、后缀与 project id
    upstream.ts    旧推理路径 -> 带 API family 的规范路径
    egress.ts      静态出口池、选择策略与 EgressPicker 接口
    xcp.ts         xc-p 服务 API 客户端（/v1 节点、凭据、网关）与状态排序
    nodepool.ts    xc-p 节点池（按状态粘性选节点 + 429/故障切换）
    ratelimit.ts   当日限流记录（JSON，8 点清零）
  index.ts         服务入口
```

## 实现要点

- 兜底路由使用 `parse: "none"`，请求体按字节原样转发，同时可用于计算会话种子。
- 转发时补齐 OpenCode 客户端实际会发的身份头：`x-opencode-session`、
  `x-opencode-session-id`、`x-session-affinity`、`X-Session-Id`、
  `x-opencode-client`，以及调用方没带时的 `x-opencode-project`
  （40 位 hex，形如 git root commit）。
- 每个对话的 12 位 hex 前缀只铸造一次并缓存 12 小时，因此同一对话在网关侧的
  路由与 prompt cache 亲和性保持稳定，同时时钟不会是几个月前的常量。
  `SESSION_PREFIX` 会把前缀冻住，注意它内嵌的时钟也会一起冻住（旧默认常量就是
  2026-10-13 抓到的一个真实 id，会越来越"旧"）。
- 上游的 `content-encoding` / `content-length` 会被丢弃：Bun 会透明解压响应体，
  若照搬这两个头，发给客户端的字节就会被错误标注。
- 3xx 响应按原样转发（`redirect: "manual"`），由客户端决定是否跟随。

## 已知限制

- **不支持 SOCKS5。** Bun 的 `fetch` 硬性拒绝 `socks5://` / `socks5h://`。要支持
  需更换 HTTP 客户端实现，或改走 `curl --socks5-hostname` 子进程。
- **静态 `PROXIES` 池没有健康检查与熔断。** 失效代理会直接返回 502。
  `XCP_HOST` 节点池则带健康处理：选节点时用 xc-p 的检测状态，运行时 429 与不可达
  都会换节点并重试一次。（注意 `https://` 上游走 CONNECT 隧道，节点不可达会表现为
  `fetch` 抛错；若把 `UPSTREAM` 设成 http，代理网关会把这类失败当成裸 5xx 响应
  转发，节点池看不到——保持 `UPSTREAM` 为 https 即可。）
- **免费层的服务端风控无法用配置绕过。** 2026-10-14 之后，
  opencode 新的 inference 服务接管了鉴权、模型可用性与免费层准入，判定依据是
  客户端行为（工具清单、agent 形态、登录态）而不是单个请求头。本代理能修正
  指纹不自洽、路径过期、身份头缺失这些问题，但**不保证**能通过风控；要稳定使用
  请走付费（Go/Zen）或自带 key。