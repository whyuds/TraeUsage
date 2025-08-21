# Trae Usage Monitor

[English](README.en.md)

一个VSCode扩展，用于实时监控Trae AI的使用量统计。

<img src="img/image.png" alt="功能截图" height="300">

## 使用演示

<img src="img/traeusage_shot.gif" alt="功能截图" width="600">

## 安装和使用

### 1. 安装

Trae的应用市场搜索Trae Usage

### 2. 获取Session ID

**方法一：使用浏览器扩展（强烈推荐）**

**Chrome浏览器：**
1. 安装Chrome扩展：[Trae Usage Token Extractor](https://chromewebstore.google.com/detail/edkpaodbjadikhahggapfilgmfijjhei?utm_source=item-share-cb)

**Edge浏览器：**
1. 安装Edge扩展：[Trae Usage Token Extractor](https://microsoftedge.microsoft.com/addons/detail/trae-usage-token-extracto/leopdblngeedggognlgokdlfpiojalji)

**使用步骤：**
1. 安装后通过通知或TraeUsage窗口设置跳转安装Chrome扩展
2. 安装后在浏览器点击Chrome扩展图标，点击跳转按钮到Usage页面
3. 登录并浏览usage页面，自动获取Session ID
4. 点击Chrome扩展图标，自动复制Session ID至粘贴板
5. 返回Trae，Trae Usage扩展会自动识别粘贴板并配置Session ID

### 3. 查看使用量

配置完成后，在VSCode左侧的资源管理器面板中会出现 "Trae Usage" 视图，显示：

- ⚡ Premium Fast Request：快速请求的使用量和剩余配额
- 🐌 Premium Slow Request：慢速请求的使用量和剩余配额  
- 🔧 Auto Completion：自动补全的使用量和剩余配额
- 🚀 Advanced Model：高级模型的使用量和剩余配额


## 反馈与支持

如果您在使用过程中遇到问题或有功能建议，欢迎访问我们的GitHub项目页面：

🔗 **项目地址**：[https://github.com/whyuds/TraeUsage](https://github.com/whyuds/TraeUsage)

💬 **问题反馈**：如有问题请在GitHub上提交[Issues](https://github.com/whyuds/TraeUsage/issues)

## 许可证

MIT License