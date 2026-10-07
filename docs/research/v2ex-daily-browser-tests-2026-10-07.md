# V2EX 签到多浏览器回归（2026-10-07）

测试源码：本地 v2ex-tweaks.user.js 2.5.31，SHA-256 `f09f65381bb21148674b39bbb0092f68d49736232a6e6a9b566945411e4b5520`。
上述哈希对应测试时包含其他未提交功能的工作区文件。提交时仅提取签到改动，Daily 模块保持逐字一致；提交脚本 SHA-256 为 `0d935056e46976d40feca45610423bd5322a16f4bce212135e3fac27b680f066`。提取后的脚本已重新通过 Daily、Safari 流程与语法检查。
本地修改尚未安装到用户 Safari/wBlock。

## 结果

| 测试 | 结果 |
| --- | --- |
| Chromium 149.0.7827.55，真实引擎 | PASS |
| WebKit 26.5，真实引擎 | PASS |
| Firefox Playwright build 1538 | BLOCKED：启动超时，macOS sandbox_extension_issue_file_to_process / 图形初始化报错 |
| Daily 模块隔离回归 | PASS |
| Safari iframe 流程回归 | PASS |
| JavaScript 语法及 diff 空白检查 | PASS |

Firefox 旧引擎、新匹配引擎、带窗口模式均未能完成启动；临时测试进程的沙箱兼容环境设置也未解决。未修改个人 Firefox 配置。

## 覆盖

`tests/v2ex-daily-browsers.cjs` 提取真实 Daily 模块，在本机 HTTP 测试服务执行。每个浏览器上下文拥有独立 Cookie，同时共享模拟 GM 存储。覆盖首次领取、同页面不重复领取、不同账号、同名账号独立上下文、重新加载后向服务端确认、账号错配禁止领取、连续四次 HTTP 503 后自动恢复、领取未确认不得缓存成功、锁持有页面关闭后自动接替。断言请求没有借用 GM_xmlhttpRequest，Cookie 对应的 once 正确，领取 Referer 正确。

重试间隔缩短以加速测试，因此不是后台长时间驻留或系统休眠恢复验收。WebKit 引擎测试不等于 Safari+wBlock 扩展集成测试；隔离 browser context 不等于实际 Firefox Multi-Account Containers 扩展验收。未请求真实 V2EX、未操作真实账号签到。

## Firefox Container 历史问题

直接核对历史提交 `d36b7ddea6881a4d591ad280a30e20178c6b8520`（2.5.24）：保留页面 Cookie 请求、按账号隔离、各阶段检查返回账号的原则。

本次简化为：普通请求全部使用页面 fetch + credentials include；Safari 使用同源 iframe。共享 GM 签到日期不再作为跳过依据，只有当前文档经服务端确认的账号/日期可跳过。持久化五分钟锁已移除，改为页面生命周期 Web Lock，页面关闭后释放；失败持续退避重试，最长间隔一分钟。

结论：两种已运行引擎的隔离回归没有重现共享存储跳过/串账号问题；Firefox 实际 Container 环境仍待验证，不能标成全部通过。
