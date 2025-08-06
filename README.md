# Trae Usage Monitor

一个VSCode扩展，用于实时监控Trae AI的使用量统计。

## 功能特性

- 🔄 自动刷新：VSCode启动时自动获取数据，每5分钟自动刷新
- 📊 实时显示：在侧边栏显示各种服务的使用量和剩余配额
- 🔐 认证管理：Token失效时自动提醒用户更新
- ⚙️ 可配置：支持自定义刷新间隔

## 安装和使用

### 1. 安装依赖

```bash
npm install
```

### 2. 编译扩展

```bash
npm run compile
```

### 3. 在VSCode中测试

按 `F5` 启动扩展开发主机，或者：

1. 打开VSCode
2. 按 `Ctrl+Shift+P` 打开命令面板
3. 输入 "Developer: Reload Window" 重新加载窗口

### 4. 配置认证Token

首次使用时，扩展会提示设置认证Token：

1. 点击侧边栏的 "Trae Usage Monitor" 面板
2. 如果提示设置Token，点击 "设置Token"
3. 输入你的Trae AI认证Token（不包含 "Cloud-IDE-JWT " 前缀）

你也可以手动配置：

1. 打开VSCode设置 (`Ctrl+,`)
2. 搜索 "trae usage"
3. 在 "Auth Token" 字段中输入你的Token

### 5. 查看使用量

配置完成后，在VSCode左侧的资源管理器面板中会出现 "Trae Usage Monitor" 视图，显示：

- ⚡ Premium Fast Request：快速请求的使用量和剩余配额
- 🐌 Premium Slow Request：慢速请求的使用量和剩余配额  
- 🔧 Auto Completion：自动补全的使用量和剩余配额
- 🚀 Advanced Model：高级模型的使用量和剩余配额

## 配置选项

在VSCode设置中可以配置以下选项：

- `traeUsage.authToken`: Trae AI认证Token
- `traeUsage.refreshInterval`: 自动刷新间隔（分钟，默认5分钟）

## 命令

- `Trae Usage: Refresh Usage Data`: 手动刷新使用量数据
- `Trae Usage: Update Auth Token`: 更新认证Token

## 故障排除

### Token失效

如果看到 "❌ 认证失效" 提示：

1. 点击提示或使用命令 "Update Auth Token"
2. 输入新的有效Token
3. 数据会自动刷新

### 网络错误

如果无法获取数据，请检查：

1. 网络连接是否正常
2. Token是否正确
3. Trae AI服务是否可用

## 开发

### 项目结构

```
├── src/
│   └── extension.ts    # 主扩展代码
├── package.json        # 扩展配置和依赖
├── tsconfig.json      # TypeScript配置
└── README.md          # 说明文档
```

### 构建命令

- `npm run compile`: 编译TypeScript代码
- `npm run watch`: 监听文件变化并自动编译

## 发布流程

本项目使用 GitHub Actions 自动化发布流程。当推送版本标签时，会自动构建并发布到 VSCode 插件市场。

### 自动发布

1. **使用发布脚本（推荐）**：
   ```bash
   # Windows PowerShell
   .\scripts\release.ps1 -Version "1.0.1"
   
   # Linux/macOS
   ./scripts/release.sh 1.0.1
   ```

2. **手动发布**：
   ```bash
   # 更新package.json中的版本号
   # 提交更改
   git add package.json
   git commit -m "chore: bump version to 1.0.1"
   
   # 创建并推送标签
   git tag v1.0.1
   git push origin main
   git push origin v1.0.1
   ```

### GitHub Secrets 配置

为了自动发布到插件市场，需要在 GitHub 仓库设置中配置以下 secrets：

- `VSCE_PAT`: VSCode Marketplace 发布令牌
- `OVSX_PAT`: OpenVSX Registry 发布令牌

详细配置说明请参考 [.github/workflows/README.md](.github/workflows/README.md)

## 许可证

MIT License