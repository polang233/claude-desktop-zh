# 内置补丁说明

「内置补丁（需管理员）」是插件提供的第三种汉化方式，用于「启动时加载」不可用的 Windows 机器。切换方式只保存选项；必须点击「应用中文补丁」并在 UAC 中确认才会执行。

## 来源与校验

- 上游：[javaht/claude-desktop-zh-cn](https://github.com/javaht/claude-desktop-zh-cn)
- 固定提交：`f23b0292646bdd912f759cec1096d9814ebb01ef`
- 安装器 SHA-256（统一 LF 换行后）：`5f844f1fc26006f28607290edb88a7247cfa8bc8b4ab1ccc08acebf167462f70`
- UAC 包装器 SHA-256（统一 LF 换行后）：`4ca3211a2724a4961cafdc3c35aec160585174ca73477d0dd32daa6366c4e69f`
- 恢复器 SHA-256（统一 LF 换行后）：`3ec318a61e6ed0c4ac833a77c5b16e0577b58b8d0b6c082b029f28cd2881f552`

安装器、恢复器、简繁中文资源、MIT 许可证和来源说明都位于 `vendor/javaht/`，随 npm 包一起分发。插件在显示状态和执行前核对三个脚本的哈希；缺失或哈希不符时不会执行。

## 应用

1. 保存「内置补丁（需管理员）」方式。
2. 用 Claude 的「文件 → 退出」完全退出，确认任务栏、托盘和 Cowork 服务都没有残留。
3. 点击「应用中文补丁」。插件会再次确认目标路径，并在执行前检查 `claude.exe`、`cowork-svc.exe` 是否仍在运行。
4. Windows 弹出 UAC 时授权。插件启动固定安装器，安装器会写入语言资源、同步 Claude 的程序完整性哈希，并从原入口重新打开 Claude。

补丁会就地改写应用文件，可能使 Claude 的 Authenticode 签名失效。官网 MSIX 安装可能要求接管程序目录所有权与 ACL；这会改变目录权限，恢复补丁不会自动还原这些权限。微软商店（Microsoft Store）版本受 Windows 保护，不应使用此方式。

## 恢复

点击「恢复原样」，完全退出 Claude，再确认 UAC。插件使用随包恢复器，从应用目录内的 `.zh-cn-backups` 备份集恢复 `ion-dist.asar`、`app.asar` 和 `Claude.exe`，并从 `init-backup` 恢复原始 `cowork-svc.exe`，移除中文资源，再把语言配置恢复为英文。恢复器会先停掉 Cowork 服务，完成后重新启动它。

恢复前会校验每个备份文件并计算恢复后的哈希；中途失败会尝试回滚已替换的文件。如果 Claude 已经升级、备份缺失或文件被其他工具改动，恢复可能拒绝或显示不完整状态。此时不要手工删除备份或覆盖新版本；先打开「资源维护」查看状态和状态目录中的日志。

## 日志

安装器和 UAC 包装器的输出保存在插件自己的状态目录：

`%LOCALAPPDATA%\claude-desktop-3p-zh\original\third-party\`

其中 `third-party-state.json` 是插件状态，`third-party-install-*.log`、`third-party-recover-*.log` 和 `third-party-recover-report.json` 记录最近一次安装或恢复。日志可能包含本机路径，反馈前请先检查。
