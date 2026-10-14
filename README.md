# 史纲 Study

《中国近现代史纲要（2023版）》复习网站：700 道题、9 个主题、Apple 风格题卡与按题 AI 助手。V2 支持独立账号，学习记录默认加密保存在各用户的当前浏览器。

仓库公开，应用源码和文档采用 [MIT 许可证](LICENSE)。第三方依赖和题库资料保留原有权利归属。`package.json` 的 `private: true` 仅防止误发布到 npm，不影响 GitHub 公开开源。

## 做题与复习

| 入口 | 内容 |
|---|---|
| 通刷 | 全 700 题按主题练习，独立轮次、进度保存、每 20 题小结 |
| 80 题随机卷 | 35 单选、35 多选、10 判断，不重复 |
| 20 题小卷 | 9 单选、9 多选、2 判断 |
| 分类与搜索 | 9 主题、3 题型；题干、选项、题号与学习状态筛选 |
| 我的复习 | 错题、不确定、收藏、掌握、笔记、最近错/多次错和到期复习 |
| AI 侧栏 | 自动带入当前题、选项顺序和选择，讲解/选项分析/提示/记忆/追问，可收起 |

单选与判断点击判分，多选提交后判分；答对绿色，答错红色并标出正确选项。支持固定题序、选项随机、暂停续做和整卷自测。自测交卷前隐藏判分与完整解析，AI 仅提示；未答题单列，成绩以全卷为分母。

自动下一题默认关闭，开启后新作答正确、保存成功等待 1.5 秒；AI、笔记、小结、答错或回看时停留。统计来自真实作答，不填充示例学习成绩。

## 账号与数据

管理员创建账号或发放邀请码，开放注册默认关闭。登录密码负责服务器身份，本机独立口令负责解密学习空间，首次创建时请保存恢复密钥。

服务器只保存账号、Session、邀请码、服务配置和 AI 用量。练习、进度、笔记、草稿、偏好及 AI 历史保存在按用户加密的 IndexedDB。退出不会删除记录；换账号不会显示前一账号数据。

同一账号在不同设备、浏览器或域名下的数据互相独立。通过“设置与数据”导出加密文件并在另一设备恢复；仅支持确认后的整体恢复，保留恢复前快照，不自动合并。

清除网站数据、隐私模式、卸载浏览器和系统回收可能丢失记录，请定期备份。启用 AI 会把必要题目与会话发给服务器和第三方模型供应商，需先勾选说明。静态本地加密不能保护已解锁页面免受恶意脚本或受控设备影响。

PWA 提供图标、静态缓存和更新提示；已经加载并解锁时可断网做题。刷新、重新打开或登录需要联网。题库参考答案随题库下发，自测隐藏是学习体验约束，不是考试防作弊机制。

## 本地开发

使用 Python 3.12、Node.js 24。Windows PowerShell 首次安装和创建管理员：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
npm ci
$env:AUTH_DATABASE_PATH = (Join-Path (Get-Location) '.runtime\accounts.sqlite')
.\.venv\Scripts\python.exe -m backend.accounts create-admin --username admin
.\start-local.ps1
```

访问 `http://127.0.0.1:5173`，使用刚创建的账号登录，然后建立本机加密空间。本地开发也需要真实账号，没有免登录通道。使用 `.\start-local.ps1 -Stop` 只停止此脚本启动的预览进程。

手动运行时，一个终端设置 `DEV_MODE=1` 和 `AUTH_DATABASE_PATH`，执行 `python -m uvicorn backend.app:app --host 127.0.0.1 --port 8765 --no-proxy-headers`；另一个终端执行 `npm run dev`。不要与启动脚本同时占用同一端口。

## 部署与文档

保留 React / TypeScript / Vite、FastAPI / HTTPX、SQLite WAL、Nginx 与两服务 Docker Compose，适配已确定的 4 核 4GB 服务器。网页绑定 `127.0.0.1:8080`，API 不暴露宿主端口，生产登录要求 HTTPS。

部署前阅读 [DEPLOYMENT_V2.md](DEPLOYMENT_V2.md)，包含管理员初始化、1Panel/OpenResty、未来 Cloudflare Full (strict)、独立账号库备份和恢复。AI 使用服务器配置的兼容 Chat Completions 接口，未配置时仍可正常做题。

- [V2 优化报告](V2_OPTIMIZATION_REPORT.md)：完成内容、未实施项和确认边界。
- [本地数据架构](LOCAL_DATA_ARCHITECTURE.md)：加密、并发、备份、恢复与跨设备规则。
- [账号安全](ACCOUNT_SECURITY.md)：邀请、会话、权限、AI 限额与保护范围。
- [V1 数据迁移](DATA_MIGRATION.md)：只读源库、显式归属、加密导出与回退。
- [多设备测试](MOBILE_TABLET_TEST_REPORT.md)：10 个宽度、横竖屏及实机限制。
- [测试结果](TEST_REPORT.md)与[实施计划](PLAN_V2.md)。

第一版完整保留于 [v1.0.0](https://github.com/Oblivionis7999/history-study/tree/v1.0.0)。V2 在 `feature/multi-user-local-first-v2`；正式合并和生产部署单独确认。旧 `PLAN.md` 仅供 V1 历史回溯。

## 题库与检查

题库为 300 单选、300 多选、100 判断，共 9 主题。来源与排版整理记录见 [导入报告](data/import-report.json)。V2 不修改原题库正文或答案；测试与 V1 标签的题库内容比较。答案有疑问可以标记并追问 AI，判分继续使用参考答案。

```powershell
.\.venv\Scripts\python.exe -m pytest tests -q
npm run build
npx playwright install chromium firefox webkit
npx playwright test
npx playwright test --config=playwright.production.config.ts
.\.venv\Scripts\python.exe scripts\check_repository.py
```

Playwright 开发与生产测试依次运行，使用隔离账号库与模拟 AI。生产 PWA 测试需要先构建；Windows 固定端口不可用时可设置 `PWA_TEST_PORT` 为可用回环端口。Linux CI 自动安装浏览器系统依赖并执行 Docker 集成检查。

提交前执行 `python scripts/check_repository.py --staged` 检查实际暂存内容。`.env`、密钥、数据库、备份、日志、恢复密钥、原始 DOCX、构建产物和机器路径均不应上传。可运行 `python scripts/package_deploy.py` 生成只含 Git 跟踪源码、文档与生产构建的部署包。
