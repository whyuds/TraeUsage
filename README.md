# Trae Usage Monitor

一个VSCode扩展，用于实时监控Trae AI的使用量统计。

![image.png](img/img.png)

## 功能特性

- 🔄 自动刷新：VSCode启动时自动获取数据，每5分钟自动刷新
- 📊 实时显示：在侧边栏显示各种服务的使用量和剩余配额
- 🔐 认证管理：Token失效时自动提醒用户更新
- ⚙️ 可配置：支持自定义刷新间隔

## 安装和使用

### 1. 安装

Trae的应用市场搜索Trae Usage

### 2  获取认证Token
1. 在Trae.ai查看Usage时通过Chrome控制台找到API-/ide_user_pay_status并复制其中的authorization请求头参数
2. Chrome应用商店搜索Trae Usage Token Extractor并安装，官网查看一次Usage后，点击图标并复制

### 3. 配置认证Token

首次使用时，扩展会提示设置认证Token：

1. 点击侧边栏的 "Trae Usage Monitor" 面板
2. 输入你的Trae AI认证Token（不包含 "Cloud-IDE-JWT " 前缀）

你也可以手动配置：

1. 打开VSCode设置 (`Ctrl+,`)
2. 搜索 "trae usage"
3. 在 "Auth Token" 字段中输入你的Token

### 3. 查看使用量

配置完成后，在VSCode左侧的资源管理器面板中会出现 "Trae Usage" 视图，显示：

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

## 许可证

MIT License