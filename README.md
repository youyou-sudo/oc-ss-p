# opencode-session-proxy

一个运行在 OpenCode 推理端点前的小型反向代理，为每个会话铸造一个结构合法的
`x-opencode-session`。

## 背景

OpenCode 的免费层只接受"看起来像 OpenCode 客户端"的请求，且会话头必须满足

```
ses_ + 12 位 hex + 恰好 14 位 base62          （共 30 字符）
```

其中 12 位 hex 编码一个时间戳和一个必须为 `1..63` 的 `counter`。
`new-api` 无法通过配置拼出这样的值，所以这里自行铸造：14 位 base62 用于标识
会话，使每个用户/会话都拥有稳定且互不相同的 session。

> 12 位 hex 实际是 42 位时间戳 + 6 位 counter。完整的
> `Date.now() * 4096 + counter` 需要 53 位，放不进 48 位。

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

`GET /` 会返回一个精简的健康检查载荷（上游地址、会话前缀、出站配置），
方便确认代理已就绪。

## 环境变量

| 变量                     | 默认值                 | 说明                                     |
| ------------------------ | ---------------------- | ---------------------------------------- |
| `PORT`                   | `8787`                 | 监听端口                                 |
| `HOST`                   | `127.0.0.1`            | 监听地址                                 |
| `UPSTREAM`               | `https://opencode.ai`  | 上游 base URL                            |
| `PROXIES`                | _(空)_                 | 出口代理池，见下文                       |
| `EGRESS_STRATEGY`        | `stable`               | `stable` / `round-robin` / `random`      |
| `SESSION_PREFIX`         | `ses_ecbe61115ffe`     | 合法 session id 的 12 位 hex             |
| `ROTATE_SESSION_PREFIX`  | `false`                | 为每次请求铸造新前缀                     |
| `SESSION_COUNTER`        | `7`                    | 轮换前缀内嵌的 counter（1..63）          |
| `USER_AGENT`             | _(按会话派生)_         | 固定 UA，取代指纹                        |
| `CLIENT`                 | _(按会话派生)_         | 固定 `x-opencode-client`，取代指纹       |
| `VERBOSE`                | `false`                | 打印 `METHOD path -> session via <出口>` |

非法配置会在**启动时**直接失败，而不是等到第一个请求。
完整注释模板见 `.env.example`。

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

## 指纹

早期所有用户共用同一个 session 前缀、同一个 UA、同一个 client 标签——这比共用
一个出口 IP 更像"自动化集群"。现在除非显式固定，以下三项都按会话派生：

- `user-agent`：从一小撮 OpenCode CLI 版本中按会话选取。
- `x-opencode-client`：按会话派生。
- session id 的 14 位后缀：按会话派生。

每个信号对同一会话保持稳定，跨会话则互不相关。设置 `USER_AGENT` / `CLIENT`
可退回固定值；再设 `ROTATE_SESSION_PREFIX=1`，连 12 位 hex 前缀也每次重铸。

> 这些措施降低被聚类关联的概率，但**不等于"不被识别"**。opencode 的风控规则
> 不公开，无法验证任何配置能稳定通过——尤其当 UA 版本号与 client 标签可能被
> 交叉校验时。若代理池中各出口 IP 归属同一注册主体，效果也会打折。

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
    session.ts     session 铸造辅助
    fingerprint.ts 按会话派生 UA/client/session
    egress.ts      出口代理池与选择策略
  index.ts         服务入口
```

## 实现要点

- 兜底路由使用 `parse: "none"`，请求体按字节原样转发，同时可用于计算会话种子。
- 上游的 `content-encoding` / `content-length` 会被丢弃：Bun 会透明解压响应体，
  若照搬这两个头，发给客户端的字节就会被错误标注。
- 3xx 响应按原样转发（`redirect: "manual"`），由客户端决定是否跟随。

## 已知限制

- **不支持 SOCKS5。** Bun 的 `fetch` 硬性拒绝 `socks5://` / `socks5h://`。要支持
  需更换 HTTP 客户端实现，或改走 `curl --socks5-hostname` 子进程。
- **无代理健康检查与熔断。** 失效代理会直接返回 502。

