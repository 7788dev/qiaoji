# 发布指南

发布工作流为 [`.github/workflows/release.yml`](../.github/workflows/release.yml)，由 `vX.Y.Z` 标签触发。构建目标是 Windows amd64、当前用户安装。

## 准备

1. 完成 [贡献指南](../CONTRIBUTING.md#修改与验证) 中的质量检查与桌面验证。
2. 更新 `wails.json` 版本、[更新日志](../CHANGELOG.md) 和受影响的截图。
3. 审查工作区，提交源代码、生成绑定及文档；不要提交构建输出和临时文件。
4. 推送分支后，在该提交上创建并推送尚未使用的版本标签。

## 构建与发布

工作流安装锁定依赖并执行 TypeScript、Vitest、前端构建、`go vet` 和 `go test`，然后使用 Wails 2.13.0 与 NSIS 构建：

```text
Qiaoji-<版本>-windows-amd64-setup.exe
SHA256SUMS.txt
```

版本同时注入应用版本信息和安装包元数据。工作流将安装包与校验文件上传到对应 GitHub Release；发布说明应概括用户可见变化，并注明实际验证范围。

## 更新清单

应用更新器从 `main` 分支的 [`version.json`](../version.json) 获取版本和安装包信息。**先发布并验证安装包，再更新清单。**

1. 确认 Release 工作流成功，下载该版本安装包和 `SHA256SUMS.txt`。
2. 用 `Get-FileHash <安装包路径> -Algorithm SHA256` 核对实际下载文件与校验清单。
3. 更新 `version.json` 的版本、Release 页面、安装包 URL 和实际 SHA-256。
4. 单独提交并推送清单，核对远端文件和 Release 资产均可访问。

发布工作流不会自动提交 `version.json`。不得提前指向尚不存在的安装包，或使用另一轮本地构建的哈希替代已发布资产的哈希。
