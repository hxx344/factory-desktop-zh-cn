# Factory 维护方式与历史云端协议

## 当前方式：本地手动触发

按用户 2026-10-24 的要求，维护切回本地手动触发，不创建或恢复本地每日任务。用户在本项目聊天发送“检查 Factory 更新并汉化发布”后，才开始一次维护；切换维护方式本身不触发版本适配或发布。

1. 从本地仓库检查官方最新稳定版本、已有适配和正式 Release。没有新版本且没有未完成发布时结束。
2. 有变化时取得官方原版资源，复用已有译文，补齐新增及修改文案，保留旧版适配。
3. 在 Windows 原生环境中完成与改动相称的词典、安装、恢复、界面及打包验证，禁止使用 WSL；内容和环境不变时复用有效结果。
4. 通过本地 Git 保留用户作者身份及 Codex 署名，提交、推送并核实远端；等待必要的 `Windows checks` CI 后按既有流程正式发布并核实资产。

原托管每日计划 `6ad73ca5bae48191b9357c2c6d860017` 已核实为 `is_enabled=false`，配置与历史保留。专用的 `Cloud Factory maintenance` 工作流已禁用，正常的 `Windows checks` CI 保持启用。下述云端桥协议仅保留供以后明确恢复时参考，本地手动维护不使用 GitHub 连接器控制 Issue，也不复制本地登录令牌到云端。

## 历史云端每次运行

原每日调度在 ChatGPT 托管云端任务中设置为 `Asia/Shanghai` 上午 09:00，负责版本检查和 AI 适配；Windows Actions 负责独立验收、提交与正式发布。

1. 查询官方 `https://api.factory.ai/api/desktop/latest-version`，用 `https://downloads.factory.ai/factory-desktop/LATEST` 复核；对照 main、profiles、pack 和最新正式 Release。没有变化且没有未完成发布时安静结束。
2. 对新版本从官方完整 nupkg 取得资源。下载器读取版本目录的 `RELEASES`，校验大小与 SHA1，并在 Windows 验证签名和 profile 内 SHA256。Linux 云端可做静态分析；Windows 运行验收交给 Actions，禁止使用 WSL。
3. 按源文 SHA 复用完整词典，保留旧 source ID；补齐新增及修改原文、原生菜单、HTML 启动提示、显示边界硬编码和语言变化订阅。不能修改内部匹配键、协议、代码、命令、链接和用户内容，也不能用英文回退代替覆盖。
4. 更新版本和清单，运行必要检查。新版本资料和译文只进入 Git blob/tree，先不要通过连接器创建提交，因为连接器不能明确设置提交作者。
5. 向受限 Windows 执行入口提交候选树。等待控制 Issue 的结果；全部验证成功后，工作流保留 `charles` 作者和一次 Codex 署名，普通推送 main，并验证远端提交，再完成正式 Release 和资产校验。

## 控制请求

仅 `hxx344`（GitHub 用户 ID `26082889`）可以创建执行请求。Issue 作者、事件 sender 和 workflow actor 必须一致。标题必须以 `Factory cloud request:` 开头，body 必须是以下完整 JSON，不得带代码围栏或额外字段：

```json
{
  "schemaVersion": 1,
  "mode": "publish",
  "baseCommit": "当前main的40位提交SHA",
  "sourceTree": "已构造候选树的40位SHA",
  "packageVersion": "0.3.1"
}
```

`mode` 只接受 `validate`、`publish`。`validate` 验收但不提交或发布，适合验证执行环境。`publish` 有改动时必须提高三段正式包版本；若树未变化，只能发布当前版本，可用于恢复已经提交但尚未发布的版本。

从 GitHub 读取 main 的 commit 和 tree；为每个改变的文件调用连接器 `create_blob`，通过 `create_tree` 指定 base tree 与变化条目，得到候选 `sourceTree`。使用执行环境程序化传递文件内容，避免人工复制大型 JSON。当前连接器已实测接受完整 3.2 MB catalog，并返回与仓库一致的 Git blob SHA。删除文件使用 tree 条目的空 SHA；不要删除旧版适配能力。

然后用同一连接器创建控制 Issue。不得调用缺少作者参数的 `create_commit`、强制更新 ref 或将本地凭据上传。控制 Issue 属于执行记录，有新适配或待发布工作才创建，不为每日无变化检查创建 Issue。

## Windows 验证与发布

- `validate` job 只有只读代码权限。它从事件提交保留可信桥代码，验证原始事件和固定 schema，核对 main 基线，重建并校验精确候选 Git tree，然后运行必要检查、下载官方原版并验证安装、幂等、恢复、语言切换和重启偏好。
- 若候选树完全等于基线且该提交的 Windows checks 已成功，可复用静态检查结果；首次云端原生验收仍会执行。nupkg 缓存每次重校验，不缓存修改过的客户端目录。
- `publish` 使用全新 runner，重新校验原始事件、基线和精确树。写入令牌只交给可信桥脚本；不执行候选 npm 生命周期、JavaScript、PowerShell 或候选打包脚本。ZIP 由可信基线打包器生成，并逐项对照候选文件。
- 候选不能更改 `.github`、`.git*`、发布桥、下载/验收脚本、可信打包器及本说明。依赖与 npm scripts 也不能更改；此类基础设施升级应单独审查提交。
- 请求限制、普通文件模式、ASCII 安全路径、短文件名和大小写碰撞、blob 哈希、总大小、`git write-tree` 及物化文件与索引的一致性都在实际执行时校验。main 漂移时失败，不自动 rebase 后发布。
- 资产先上传到精确匹配的草稿，校验文件名、ZIP 内容、大小和 SHA256，再转正式发布。打包使用固定顺序、时间和属性的 stored ZIP，源文件时间、Windows 或压缩器版本变化不会改变相同内容的资产校验值。中断后允许补齐同目标草稿的缺失资产；错误目标或错误资产直接拒绝。

工作流将结果附在同一 Issue 的 `<!-- factory-cloud-result -->` 标记后，包含 run URL，以及发布成功后的 commit、Release URL 与 SHA256。成功请求自动关闭，失败请求保持打开。云端读取该结果和 CI 日志，不能把“创建 Issue”当成验证成功。

## 失败与恢复

若 main 已变化，重新读取最新 main，基于新基线重建候选并创建新请求。若代码已提交但发布未完成，先对照版本、tag 和草稿；用当前 main 和其 tree 提交零差异请求来恢复发布，不制造空版本。网络或验收失败时不发布不匹配内容。

恢复云端执行必须先取得用户明确指令，再复核托管计划、连接器权限、Windows 验收及发布通路。当前保持本地手动触发，不因保留历史配置或桥代码而恢复任何每日任务。
