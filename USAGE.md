# 快速使用指南

## 1. 开发和测试扩展

### 方法一：使用F5快捷键
1. 在VSCode中打开此项目
2. 按 `F5` 启动扩展开发主机
3. 在新打开的VSCode窗口中测试扩展

### 方法二：使用命令面板
1. 按 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Developer: Reload Window" 重新加载

## 2. 配置认证Token

### 获取Token
1. 打开浏览器开发者工具
2. 访问 Trae AI 网站并登录
3. 在网络请求中找到包含 `authorization: Cloud-IDE-JWT` 的请求
4. 复制 `Cloud-IDE-JWT` 后面的Token部分（不包含前缀）

### 设置Token
1. 在VSCode中打开设置 (`Ctrl+,`)
2. 搜索 "trae usage"
3. 在 "Auth Token" 字段中粘贴Token

或者：
1. 点击侧边栏的 "Trae Usage Monitor" 面板
2. 如果提示设置Token，点击 "设置Token"
3. 输入Token

## 3. 查看使用量

配置完成后，在VSCode左侧的资源管理器面板中会出现 "Trae Usage Monitor" 视图，实时显示：

- ⚡ Premium Fast Request：快速请求使用量
- 🐌 Premium Slow Request：慢速请求使用量
- 🔧 Auto Completion：自动补全使用量
- 🚀 Advanced Model：高级模型使用量

## 4. 自动刷新

- 扩展会在VSCode启动时自动获取数据
- 默认每5分钟自动刷新一次
- 可以在设置中修改刷新间隔
- 点击刷新按钮可手动刷新

## 5. 故障排除

### Token失效
- 如果看到 "❌ 认证失效" 提示，点击更新Token
- 重新获取并设置新的Token

### 网络问题
- 检查网络连接
- 确认Trae AI服务可用
- 检查Token是否正确

## 6. 打包扩展（可选）

如果要将扩展打包为.vsix文件：

```bash
npm install -g vsce
vsce package
```

然后可以通过 "Extensions: Install from VSIX" 命令安装。