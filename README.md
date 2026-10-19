# Factory Desktop 简体中文语言包

为 **Windows x64 / Factory Desktop 0.201.0 标准安装版**提供常用界面汉化。通过客户端自己的 i18next 词典和语言切换机制加载中文。

**v0.1.0 覆盖主界面词典 4,519 / 17,851 条（25.3%），原生菜单、对话框 85 / 85 条。** 包括常用导航、按钮、登录、外观、声音、通知和会话默认设置。企业管理、课程、部分业务页面和硬编码文案尚未全部翻译；缺项继续显示英文。这是可使用的常用界面版，并非全量汉化。

![隔离客户端副本中的中文登录界面](docs/screenshots/login-zh-CN.png)

## 使用

1. 从 Releases 下载 `Factory-Desktop-zh-CN-v0.1.0.zip` 并解压到普通文件夹。
2. 正常退出 Factory，然后双击 `install.cmd`。
3. 重新打开 Factory。中文系统会按系统语言选择简体中文；如果已有其他语言偏好，在 **Settings → General → Language** 中选择 **简体中文**。

双击 `status.cmd` 查看状态；正常退出 Factory 后双击 `restore.cmd` 恢复原版。脚本不自动结束正在运行的会话。

已安装 Node.js 22 或更新版本时直接复用。否则脚本从 nodejs.org 下载固定版本的便携 Node.js，校验预置 SHA256 后缓存；无需全局安装，也不运行 npm install。运行语言包不需要翻译服务、API Key 或常驻调试端口。

命令行可显式指定 `app-x.y.z` 安装目录：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\factory-zh.ps1 -Action install -InstallDir "$env:LOCALAPPDATA\Factory\app-0.201.0"
```

`-Action` 支持 `install`、`status`、`restore`。只在启动本次脚本时使用 ExecutionPolicy 参数，不更改系统策略。

## 修改与恢复范围

安装时备份并修改安装目录内的 `resources/app.asar` 和 `factory-desktop.exe`。中文词典加入现有语言加载表，同时为登录前界面应用已保存的语言偏好。保留英文回退，不修改模型提示词、工具权限、命令、账户或会话内容。

Factory 启用了 ASAR 完整性验证，因此安装脚本会重新计算修改后资源的哈希，并更新 EXE 的 `ElectronAsar` 哈希记录，**不关闭完整性校验或修改 Electron fuses**。EXE 内容改变后，**原官方 Authenticode 签名会失效**；恢复备份后原文件和签名一并还原。当前版本不存在已确认的外部语言包导入目录，本项目需要登记并打包中文模块。

备份保存在当前 `app-x.y.z/.factory-zh-cn/`，约需 300 MB；安装时还需要临时空间。请保留该目录以便恢复。重复安装相同包只校验后跳过写入。更新汉化包会从已验证的原版备份重新生成，不叠加旧补丁。写入失败会尝试恢复到操作前的文件；异常中断造成已知的新旧文件混合时可运行 `restore.cmd` 恢复。断电遗留的 `install.lock` 必须在确认没有安装进程后移除。

仅接受适配清单中的完整版本和文件指纹。官方升级或第三方改动后会拒绝覆盖；不会用旧备份覆盖新版本，不关闭 Factory 的自动更新。首版不支持 Windows ARM64、macOS、MSIX / WindowsApps。

## 开发与验证

```powershell
npm ci
npm run extract
npm run build
npm run check
npm test
powershell.exe -NoProfile -File tools/package.ps1
```

提取和构建需要本机安装适配版本的原版 Factory。提取器只解析资源中的静态对象，不执行客户端代码。生成的英文参考词典保存在 `.local/`，不提交或随语言包分发。

`translations/phrases.tsv` 是共享译文，`translations/overrides.json` 是按键覆盖的界面译文，`translations/desktop.json` 是原生菜单译文。构建检查插值和富文本标签；`pack/zh-CN.json` 记录真实覆盖数量和构建指纹。

已在 Windows 原生环境中验证安装、重复安装、更新、恢复、中途失败回滚、未知文件拒绝和英文回退；客户端副本验证了中文登录页、英文/中文切换及重启后的偏好保留。隔离验收未登录真实账户，因此未对全部登录后业务页面做交互验收。GitHub Actions 运行 Windows 检查与打包，不使用 WSL。

分发包只包含本项目脚本、译文和版本清单，不包含 Factory EXE、ASAR、用户配置、凭据或会话。

技术依据：[Electron ASAR 完整性验证](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)、[i18next 资源配置](https://www.i18next.com/overview/configuration-options)。
