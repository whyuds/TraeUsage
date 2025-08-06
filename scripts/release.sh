#!/bin/bash

# Trae Usage Monitor 发布脚本
# 用法: ./scripts/release.sh 1.0.1

set -e

# 检查参数
if [ $# -eq 0 ]; then
    echo "错误: 请提供版本号"
    echo "用法: $0 <version>"
    echo "示例: $0 1.0.1"
    exit 1
fi

VERSION=$1

# 验证版本格式
if ! [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "错误: 版本格式错误。请使用语义化版本格式，例如: 1.0.1"
    exit 1
fi

# 检查是否在正确的目录
if [ ! -f "package.json" ]; then
    echo "错误: 请在项目根目录运行此脚本"
    exit 1
fi

# 读取当前版本
CURRENT_VERSION=$(node -p "require('./package.json').version")

echo "当前版本: $CURRENT_VERSION"
echo "新版本: $VERSION"

# 确认发布
read -p "确认发布版本 $VERSION 吗? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "发布已取消"
    exit 0
fi

echo "更新package.json版本号..."
# 使用node来更新package.json
node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "提交版本更改..."
git add package.json
git commit -m "chore: bump version to $VERSION"

echo "创建版本标签..."
git tag "v$VERSION"

echo "推送到远程仓库..."
git push origin main
git push origin "v$VERSION"

echo "✅ 发布流程已启动!"
echo "请查看 GitHub Actions 页面监控构建和发布进度:"
echo "https://github.com/whyuds/TraeUsage/actions"