const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 模拟 vscode 模块
const vscode = {
  l10n: {
    t: (key, ...args) => {
      // 简单的本地化模拟
      const translations = {
        'subscription': '订阅',
        'package': '套餐',
        'expire': '到期',
        'usage': '使用量'
      };
      let result = translations[key] || key;
      args.forEach((arg, index) => {
        result = result.replace(`{${index}}`, arg);
      });
      return result;
    }
  }
};

// 在 require 之前设置模块解析
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'vscode') {
    return vscode;
  }
  return originalRequire.apply(this, arguments);
};

// 模拟全局函数
global.vscode = vscode;
global.__ = (key) => key; // 简单的国际化函数模拟

// 加载编译后的扩展代码
const extensionPath = path.join(__dirname, '../../out/extension.js');
const extension = require(extensionPath);

// 测试数据路径
const testDataPath = path.join(__dirname, 'data');

function loadTestData(filename) {
  const filePath = path.join(testDataPath, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runTest(testName, dataFile, expectedPatterns) {
  console.log(`\n=== ${testName} ===`);
  
  try {
    const data = loadTestData(dataFile);
    const result = extension.TraeUsageProvider.buildTooltipFromData(data);
    
    console.log('生成的工具提示:');
    console.log(result);
    console.log('---');
    
    // 验证结果包含预期的模式
    expectedPatterns.forEach(pattern => {
      if (typeof pattern === 'string') {
        assert(result.includes(pattern), `结果应包含: ${pattern}`);
      } else if (pattern instanceof RegExp) {
        assert(pattern.test(result), `结果应匹配正则: ${pattern}`);
      }
    });
    
    console.log(`✅ ${testName} 通过`);
    return true;
  } catch (error) {
    console.error(`❌ ${testName} 失败:`, error.message);
    return false;
  }
}

// 运行测试
console.log('开始轻量级单元测试...\n');

let passedTests = 0;
let totalTests = 0;

// 测试1: 无订阅情况
totalTests++;
if (runTest('无订阅情况测试', 'no_subscription.json', [
  /\[░+\]/,  // 应该有空的进度条
  /0%/       // 应该显示0%
])) {
  passedTests++;
}

// 测试2: 单个订阅情况
totalTests++;
if (runTest('单个订阅情况测试', 'one_subscription.json', [
  /\[█+░*\]/,  // 应该有部分填充的进度条
  /%/          // 应该显示百分比
])) {
  passedTests++;
}

// 测试3: 多个订阅情况
totalTests++;
if (runTest('多个订阅情况测试', 'multi_subscription.json', [
  /\[█+░*\]/,  // 应该有进度条
  /%/,         // 应该显示百分比
  /\(/         // 应该有使用量格式 (x/y)
])) {
  passedTests++;
}

// 输出测试结果
console.log(`\n=== 测试结果 ===`);
console.log(`通过: ${passedTests}/${totalTests}`);

if (passedTests === totalTests) {
  console.log('🎉 所有测试通过！');
  process.exit(0);
} else {
  console.log('❌ 部分测试失败');
  process.exit(1);
}