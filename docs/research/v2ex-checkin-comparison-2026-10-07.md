# V2EX 自动签到实现对照

核验日期：2026-10-07。仅阅读公开源码，没有访问用户账号、发送签到请求或操作 Safari。

结论：这些常见实现的核心是直接请求领取地址、读取返回页面中的成功标志、成功后缓存日期。两个浏览器扩展用后台定时器持续补偿失败；三个实现均未在签到函数中引入跨标签页持久锁或隐藏 iframe。可以借鉴直接请求和后台自动重试，但不能把其他扩展的浏览器能力直接等同于 Safari 用户脚本能力，也不能原样照搬其成功判定和缓存缺陷。

## 选取依据

此次 GitHub API 查询显示：[XIU2/UserScript](https://api.github.com/repos/XIU2/UserScript) 10,078 stars（整个脚本合集，不能当作 V2EX 单脚本使用人数）；[V2EX Polish](https://api.github.com/repos/coolpace/V2EX_Polish) 1,210 stars；[V2EX Plus](https://api.github.com/repos/sciooga/v2ex-plus) 719 stars。stars 仅用于说明这些项目有公开关注度，不代表可靠性或安装量。

## 对照

| 项目 | 触发与请求 | 成功确认 | 重试与互斥 |
| --- | --- | --- | --- |
| XIU2 V2EX 增强 1.2.2 | 页面加载后延迟 1 秒；首页有领取链接则从页头提取 `once`，直接 `GM_xmlhttpRequest GET /mission/daily/redeem?once=…`；非首页先 GET `/mission/daily` 检查领取按钮；每个请求超时 5 秒，未显式设置 Referer。 | 领取响应有 `li.fa.fa-ok-sign` 才写 UTC 完整日期；首页更新原领取链接。但非首页状态检查把“没有领取按钮”直接当作已签到，存在误判窗口。 | 无显式网络失败重试、无跨页锁；后续页面访问再次触发。见 [固定版本源码 L201–275](https://github.com/XIU2/UserScript/blob/8ef9d3eb59974a9341ebf1b76a5f655ad266ec23/V2ex-Enhanced.user.js#L201-L275)。 |
| V2EX Polish | 扩展后台 `chrome.alarms` 每 4.9 分钟调用；本地时间 08:00 前不执行，当日缓存成功也不执行。先 GET 无 token 的 `/mission/daily/redeem`，解析返回的领取地址，再 GET 带 `once` 地址；源码分别配置首页、任务页 Referer。 | 两个响应路径都要求包含“每日登录奖励已领取”，之后才写 `lastCheckInTime` 和连续天数；没有独立第三次验证请求。 | 失败未写成功日期，后续 alarm 再尝试；无请求超时、即时重试或显式跨页锁。见 [领取源码 L24–65](https://github.com/coolpace/V2EX_Polish/blob/0c42df6a806cbdd37236cfbf42cb7be118305da9/src/background/daily-check-in.ts#L24-L65)、[后台调度源码](https://github.com/coolpace/V2EX_Polish/blob/0c42df6a806cbdd37236cfbf42cb7be118305da9/src/background/main.ts)。 |
| V2EX Plus | 同样后台每 4.9 分钟；先 GET 无 token 的 redeem 页面，从 `/signout?once=…` 提取 token，再 GET redeem；第一次配置首页 Referer，第二次未显式配置。 | 用响应文本判断并写 `checkinDate`，但 `text.search("查看我的账户余额")` 直接作为布尔值：未匹配返回 -1 仍为真，存在明显缺陷；后续连续天数解析和通知也可能影响是否写标记。 | 无显式跨页锁；后台 alarm 再调用。日期仅存 UTC 日号，没有年月和账号，不能照抄。见 [完整签到源码](https://github.com/sciooga/v2ex-plus/blob/98e42e304633806a0330c623b650d5e96c355d5d/background/checkin.js)。 |

## Safari 适用边界

Polish 作者的 [Safari 文档](https://github.com/coolpace/V2EX_Polish/blob/0c42df6a806cbdd37236cfbf42cb7be118305da9/website/src/content/docs/use-in-safari.md) 写明 Safari 使用 UserScripts 脚本方式，而非该项目的浏览器扩展。上表的后台签到代码属于扩展 `src/background`，不能凭此宣称 Safari 脚本也拥有 `chrome.alarms`。XIU2 的 [安装说明](https://github.com/XIU2/UserScript/wiki/V2EX-%E5%A2%9E%E5%BC%BA) 主要列出 Chrome / Firefox / Edge 的 Tampermonkey，未提供 wBlock 实测保证。

这些源码中“设置 Referer”的写法只证明作者意图，不证明 Safari/wBlock 一定允许同样设置。当前脚本需要在其真实运行环境验证请求通道、登录 Cookie、请求来源与服务端返回，不能拿扩展后台 fetch 的静态代码作为 Safari 联调通过证据。

## 对本地实现的建议（分析推论）

1. 以“取任务页面 → 解析真实领取 URL → 请求领取 → 明确成功文本”为最小事务；只有确定成功才写入账号与完整站点日期对应的完成状态。
2. 直接请求作为首选路径的前提是 Safari 的实际脚本管理器支持所需会话与来源；无需因其他浏览器可行就删除已知必要的兼容路径。
3. 避免让持久的五分钟锁阻止新页面接手；如确有并发保护需求，其期限应受实际请求超时约束，失去原执行页面也要能够恢复。
4. 请求失败、解析失败、返回登录页都不能写完成；页面仍存活时自动重试，后续访问和重新激活也能重新检查。
5. 不能照搬“没看到按钮即成功”、仅日号缓存、跨账号共用完成日期、`search()` 直接作布尔值等缺陷。可靠性来自明确成功证据和自动补偿，不来自锁更久。

以上是源码比较和实施建议，没有宣称任何项目在当前 Safari 账号上的实际签到已验证。
