import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TraeUsageProvider, ApiResponse } from '../../extension';

// 模拟 i18n 函数
const mockT = (key: string): string => {
  const translations: { [key: string]: string } = {
    'statusBar.clickToConfigureSession': '点击配置会话',
    'statusBar.clickInstructions': '点击说明',
    'tooltip.noValidPacks': '无有效订阅包'
  };
  return translations[key] || key;
};

// 模拟 formatTimestamp 函数
const mockFormatTimestamp = (timestamp: number): string => {
  return new Date(timestamp * 1000).toLocaleDateString();
};

// 模拟全局函数
(global as any).t = mockT;
(global as any).formatTimestamp = mockFormatTimestamp;

suite('BuildDetailedTooltip Test Suite', () => {
  let testDataPath: string;

  suiteSetup(() => {
    testDataPath = path.join(__dirname, '../../../test/data');
  });

  test('无订阅情况测试', () => {
    // 读取测试数据
    const noSubscriptionData: ApiResponse = JSON.parse(
      fs.readFileSync(path.join(testDataPath, 'no_subscription.json'), 'utf8')
    );

    // 固定时间用于测试
    const fixedTime = new Date('2025-08-15 10:30:00');

    // 调用静态方法
    const result = TraeUsageProvider.buildTooltipFromData(noSubscriptionData, fixedTime);

    // 打印结果供人工检查
    console.log('\n=== 无订阅情况测试结果 ===');
    console.log(result);
    console.log('=== 测试结束 ===\n');
  });

  test('单个订阅情况测试', () => {
    // 读取测试数据
    const oneSubscriptionData: ApiResponse = JSON.parse(
      fs.readFileSync(path.join(testDataPath, 'one_subscription.json'), 'utf8')
    );

    // 固定时间用于测试
    const fixedTime = new Date('2025-08-15 10:30:00');

    // 调用静态方法
    const result = TraeUsageProvider.buildTooltipFromData(oneSubscriptionData, fixedTime);

    // 打印结果供人工检查
    console.log('\n=== 单个订阅情况测试结果 ===');
    console.log(result);
    console.log('=== 测试结束 ===\n');
  });

  test('多个订阅情况测试', () => {
    // 读取测试数据
    const multiSubscriptionData: ApiResponse = JSON.parse(
      fs.readFileSync(path.join(testDataPath, 'multi_subscription.json'), 'utf8')
    );

    // 固定时间用于测试
    const fixedTime = new Date('2025-08-15 10:30:00');

    // 调用静态方法
    const result = TraeUsageProvider.buildTooltipFromData(multiSubscriptionData, fixedTime);

    // 打印结果供人工检查
    console.log('\n=== 多个订阅情况测试结果 ===');
    console.log(result);
    console.log('=== 测试结束 ===\n');
  });
});