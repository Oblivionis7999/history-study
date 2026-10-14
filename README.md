# 史纲 Study

基于《中国近现代史纲要（2023版）》题库的个人复习网站。700 道题、九个历史主题，界面按提供的 Apple 风格提示词实现。

完整需求与实施计划见 [PLAN.md](PLAN.md)。

## 仓库隐私检查

仓库包含源码、题库和空配置模板。本机学习记录、数据库备份、日志、密钥环境文件、原始文档、依赖与打包产物均由Git忽略规则排除。

提交前可以运行以下检查，扫描Git暂存区的实际内容。发现可疑内容时仅显示文件、行号与类别：

~~~powershell
.\.venv\Scripts\python.exe scripts\check_repository.py --staged
~~~

## 已实现

| 入口 | 内容 |
| --- | --- |
| 通刷 | 全部700题，按主题顺序，每20题提示小结，保存每轮进度 |
| 80题随机卷 | 35单选、35多选、10判断，同卷不重复 |
| 20题小卷 | 9单选、9多选、2判断，适合短时复习 |
| 分类练习 | 九个主题、三种题型，顺序或随机题序 |
| 我的复习 | 错题、不确定题、收藏，可写笔记和手动确认掌握 |
| AI侧栏 | 按题自动带入上下文，讲解、选项分析、提示、记忆方法与追问 |

单选、判断点击后判分；多选选择完后提交，必须完整选对。随机卷可选整卷自测，交卷前隐藏判分、笔记与完整解析，只提供 AI 提示。每题等权，正确率分母为全卷题数；未答题单独统计。

答对后自动下一题默认关闭，开启后保存成功并等待1.5秒；答错、AI打开、笔记展开、小结弹窗或回看旧题时不会自动跳题。刷新、关闭后再进入仍保留卷子名单、选项顺序与进度。

## 技术和资源

React / TypeScript / Vite，FastAPI / HTTPX，SQLite WAL，Nginx，Docker Compose。AI由外部接口提供；服务器运行网站与数据库。

部署配置面向已确定的4核4GB服务器：单个API进程，API内存上限768MB，网页容器128MB。构建阶段另有临时内存需求；这些上限是配置值，尚未在你的服务器测量实际占用。

## Linux服务器部署

需要 Docker Engine 与 Docker Compose v2。解压部署包后在项目目录执行：

~~~bash
cp .env.example .env
docker compose build
docker compose run --rm --no-deps api python -m backend.password
~~~

最后一条会要求输入两次访问密码，输出密码哈希和会话密钥。将输出的两行填入 `.env` 对应位置。密码哈希务必保留外层单引号，使其中的美元符号原样传入容器。[Docker环境变量说明](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)

如果需要AI，再填写：

~~~dotenv
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY='填入实际密钥'
AI_MODEL='填入供应商提供的模型名称'
AI_STREAM=1
~~~

`AI_BASE_URL`填写包含版本路径的根地址；程序追加 `/chat/completions`。支持采用 Chat Completions 请求与流式格式的兼容接口。可将 `AI_STREAM=0` 用于仅支持完整响应的接口。未配置时，网站正常做题，侧栏显示“尚未连接”。

接口协议参考 [Chat Completions官方文档](https://platform.openai.com/docs/api-reference/chat)。使用其他供应商时，以其兼容接口文档及可用模型为准。

然后启动：

~~~bash
chmod 600 .env
docker compose up -d
docker compose ps
curl http://127.0.0.1:8080/api/health
~~~

健康接口应返回 `ok: true` 和 `bank_count: 700`。

网页端口默认只监听服务器本机 `127.0.0.1:8080`。在服务器现有的 Nginx、Caddy 或面板中，将你的 HTTPS 域名反向代理到这个地址；Nginx示例在 [deploy/host-nginx.conf.example](deploy/host-nginx.conf.example)。替换域名和证书路径，保留 Host 头并关闭代理缓冲，以便流式回答及时显示。

生产登录使用 Secure Cookie，需要 HTTPS 访问。服务器已有的80/443入口可以继续承担HTTPS；Compose中的8080可在 `.env` 通过 `PORT` 修改。需要在同一台服务器的HTTPS代理中允许20MB请求体，支持学习备份恢复。

配置正确后，通过HTTPS域名输入访问密码即可进入。手机和电脑用同一密码进入，数据保存在同一服务器。

## 更新和运行维护

更新源码或修改AI配置后：

~~~bash
docker compose up -d --build
docker compose logs --tail=100 api
~~~

普通停止或重建容器保留数据。数据存储在命名卷 `history-study_study-data`，包括 SQLite数据库和备份目录。删除该数据卷会清除记录。

每天北京时间03:00使用SQLite在线备份，保留最近7份。03:00之后启动服务时会补做一次备份；手动恢复前也会新增备份。日志每个容器最多保留3份10MB文件。

在网站“设置与数据”中，可以导出并恢复JSON记录，包含题组、作答、笔记、收藏、偏好、AI对话与解析。备份不包含AI密钥或登录凭据。恢复先校验完整内容与题库版本，再备份并替换当前记录；失败时保留原记录。

如数据库损坏、网站无法打开，可以在停服务期间恢复数据库文件：

~~~bash
docker compose stop api
docker compose run --rm --no-deps api python -m backend.restore_sqlite --list
docker compose run --rm --no-deps api python -m backend.restore_sqlite history-替换为上一步列出的文件名.sqlite
docker compose up -d api
~~~

此恢复命令检查SQLite完整性与记录格式，先保存当前数据库的副本，再恢复指定文件。只使用上一步列出的文件名。

## 本地运行

Python 3.12及以上，Node.js 22.12及以上或24。首次安装：

~~~powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
npm ci
~~~

在两个终端中分别运行：

~~~powershell
$env:DEV_MODE='1'
$env:DATABASE_PATH=(Join-Path (Get-Location) '.runtime\history.sqlite')
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8765
~~~

~~~powershell
npm run dev
~~~

访问 `http://127.0.0.1:5173`。本地开发仅允许回环地址并跳过访问密码；Compose强制使用生产认证。

当前工作区已安装本地依赖，也可以在项目目录执行：

~~~powershell
.\start-local.ps1
~~~

脚本启动本机预览，日志写入 `.runtime`。使用 `.\start-local.ps1 -Stop` 停止它启动的进程；不要同时使用两个终端方式占用相同端口。

## 题库来源和整理

导入报告在 [data/import-report.json](data/import-report.json)。原文件300单选、300多选、100判断，全量保留原参考答案，整理为九个复习主题。

识别并处理了全角答案字母、同段多个选项、缺少分隔符，以及第254道单选原编号重复为154的问题。稳定ID按真实顺序生成，来源编号单独保存。正文和答案只存于后端题库文件，前端题目接口在作答前去掉答案和含答案的原始题干。

重新导入原DOCX：

~~~powershell
.\.venv\Scripts\python.exe scripts\import_bank.py "原DOCX的完整路径"
~~~

题目答案存在疑问时，可标记“答案疑问”并向AI追问，判分继续采用题库参考答案。

## 验证

~~~powershell
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest tests -q
npm run build
npx playwright install chromium
npx playwright test
~~~

后端测试覆盖题库数量、组卷比例、固定卷子续做、多选精确判分、重复提交、首答统计、独立通刷轮次、自测隔离、版本冲突、重启持久化、认证、AI模拟流与错误、JSON及SQLite恢复。

页面测试使用独立测试数据库和端口，覆盖桌面/390px手机、红绿反馈、多选提交、整卷自测、自动下一题、断网草稿、笔记收藏和AI按题切换。AI测试使用模拟响应，没有调用真实供应商。

本机没有Docker运行环境，容器与HTTPS实际启动验证需在目标服务器完成。当前也未连接你的服务器，未填真实AI密钥。
