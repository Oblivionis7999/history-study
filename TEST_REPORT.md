# V2 实际测试报告

本报告区分已执行验证与未测试环境。全部账号、密码和学习记录均为隔离合成数据；没有调用真实付费 AI，没有连接生产数据库或部署目标服务器。

V2 实现提交 `18bcb5f9d6966544cb2768b9629524a43c2014cd` 的[完整 CI](https://github.com/Oblivionis7999/history-study/actions/runs/38598338639)全部通过。后续报告更新只记录结果，不改变该次已验证的应用实现。验证日期：2026-10-15（北京时间）。

## 当前结果

| 检查 | 状态 | 证据 |
|---|---|---|
| V1 基线 | PASS | 16 项 Python、8 项 Chromium；原提交保留为 v1.0.0 |
| V2 Python 与旧版回归 | PASS | Windows 本机与 Linux CI 各 31 项通过 |
| TypeScript / Vite / PWA 构建 | PASS | 生产资源生成成功 |
| Chromium 页面 | PASS | Windows 本机 30 项通过，包含 10 个宽度与旋转 |
| 生产构建 PWA | PASS | Windows 与 Linux CI 各 1 项：静态缓存、无 API 缓存、断网继续做题、更新确认后保留记录 |
| Linux Chromium / Firefox / WebKit | PASS | 各 30 项，共 90 项，含管理员与最长题目响应式场景 |
| Docker 生产配置集成 | PASS | config、build、启动健康、HTTPS/Secure Cookie、多账号权限、700 题、模拟 AI、安全响应头与 API 重启后持久化全部通过 |
| 全量仓库隐私扫描 | PASS | 80 个跟踪文件无发现；发布前另检查 4 个提交中的 118 个不同文件版本，无发现 |
| 中文文档与部署包 | PASS | 六份指定文档齐全、文档内相对链接有效；生成 ZIP 并检验完整性、700 题和敏感目录排除 |

首轮 [CI](https://github.com/Oblivionis7999/history-study/actions/runs/38595236214) 曾在 Docker 的首页 CSP 检查失败：Nginx 子路径缓存头覆盖了父级安全头。当前已显式包含完整安全头配置，并复测首页、资源和 Service Worker 路径通过。该历史失败已解决，没有被跳过断言。

## 覆盖内容

Python 测试覆盖 700 题/9 主题与 V1 题库内容一致、原组卷判分/续做/恢复，V2 注册邀请期限和并发次数、角色权限、禁用/改密/会话撤销、Secure Cookie、CSRF、可信代理与登录限流、AI 账号和全站额度/截断响应/提示限制、身份库备份恢复、只读 V1 加密迁移，以及仓库检查规则。

页面测试包括真实 A/B 登录、独立作答/笔记/收藏/AI、切回 A 保留记录、静态 IndexedDB 密文、重复提交、整卷自测、自动下一题暂停、搜索与真实统计、恢复密钥、换本机口令与重置账号密码、浏览器进程重开、数据库 v1 升级、多个标签页旧版本冲突、写入/容量失败、非法或篡改/跨用户/跨题库/统计不一致备份、整体恢复回滚、迁移后继续答题、延迟 AI 跨账号隔离、管理员页面和邀请码注册。

响应式场景使用最长题干与选项组合，覆盖 320、360、375、390、414、768、820、1024、1280、1440px，并切换横屏/短高度、生成 Markdown、输入长追问及检查无横向溢出。详情见 [设备报告](MOBILE_TABLET_TEST_REPORT.md)。

## 复现

```powershell
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
npm ci
.\.venv\Scripts\python.exe -m pytest tests -q
npm run build
npx playwright install chromium firefox webkit
npx playwright test
npx playwright test --config=playwright.production.config.ts
.\.venv\Scripts\python.exe scripts\check_repository.py
```

测试集自动创建隔离目录和账号，不依赖本机真实学习库。浏览器与 PWA 测试顺序执行，避免占用相同测试 API 端口。Windows 生产预览固定端口被系统拒绝时设置 `PWA_TEST_PORT`；本机已用临时可用回环端口完成复测。GitHub 工作流 `.github/workflows/verify-v2.yml` 在一次性 Linux runner 中跑核心检查、三个浏览器和 Docker。

## NOT TESTED 与剩余限制

真实 iPhone、iPad、Android 手机/平板、macOS 原生浏览器、软键盘/系统输入法和实际主屏幕安装未测。Playwright WebKit 不代表全部 iOS Safari 环境。

目标 4GB 服务器的资源峰值、1Panel/OpenResty 网络、真实域名证书、Cloudflare、真实 AI 供应商响应和真实旧数据迁移未测。模拟 AI 验证代理协议、成本限制与界面，不能证明某个真实供应商兼容或回答准确。

Windows 本机 Firefox 遇到 `spawn UNKNOWN`，跨引擎测试在 Linux CI 执行。Python 测试输出 Starlette/httpx 兼容弃用警告，未影响结果；后续依赖升级应复测相关兼容性，不在本轮额外替换整个测试客户端。

没有进行独立渗透测试、真实高并发压测、系统断电时的物理磁盘故障模拟或辅助技术完整审计。容量不足/导入中断通过 IndexedDB 写入失败注入验证事务保护，不宣称能覆盖所有硬件故障。
