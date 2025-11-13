import * as vscode from 'vscode';
import { 
  UsageDetailItem, 
  UsageDetailResponse, 
  StoredUsageData
} from './types';
import { logWithTime, formatTimestamp } from './utils';
import { t } from './i18n';
import { getApiService } from './apiService';

const USAGE_DATA_FILE = 'usage_data.json';

export class UsageDetailCollector {
  private context: vscode.ExtensionContext;
  private apiService = getApiService();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public async collectUsageDetails(): Promise<void> {
    logWithTime('开始收集使用量详情');
    
    try {
      await this.startCollection();
      logWithTime('收集使用量详情完成');
    } catch (error) {
      logWithTime(`收集使用量详情失败: ${error}`);
      vscode.window.showErrorMessage(t('usageCollector.collectionError', { error: error?.toString() || 'Unknown error' }));
      throw error;
    }
  }

  private async startCollection(): Promise<void> {
    const sessionId = this.getSessionId();
    if (!sessionId) {
      return;
    }

    const authToken = await this.getAuthToken(sessionId);
    if (!authToken) {
      vscode.window.showErrorMessage('认证失败：无法获取Token，请检查Session ID是否正确');
      return;
    }

    const subscriptionTimeRange = await this.getSubscriptionTimeRange(authToken);
    if (!subscriptionTimeRange) {
      vscode.window.showErrorMessage(t('usageCollector.cannotGetSubscription'));
      return;
    }

    // 加载现有数据
    const existingData = await this.loadExistingData();
    
    // 计算收集时间范围
    const { start_time, end_time } = this.calculateCollectionTimeRange(existingData, subscriptionTimeRange);
    
    logWithTime(`开始增量收集，时间范围: ${formatTimestamp(start_time)} - ${formatTimestamp(end_time)}`);
    
    // 串行同步收集所有页面数据
    await this.collectAllPages(authToken, start_time, end_time, existingData, subscriptionTimeRange);
  }

  private async loadExistingData(): Promise<StoredUsageData> {
    const dataPath = vscode.Uri.joinPath(this.context.globalStorageUri, USAGE_DATA_FILE);
    
    try {
      const fileContent = await vscode.workspace.fs.readFile(dataPath);
      const data = JSON.parse(fileContent.toString()) as StoredUsageData;
      logWithTime(t('usageCollector.loadExistingDataSuccess', { count: Object.keys(data.usage_details).length }));
      return data;
    } catch (error) {
      logWithTime(t('usageCollector.createNewDataFile'));
      return {
        last_update_time: 0,
        start_time: 0,
        end_time: 0,
        usage_details: {}
      };
    }
  }

  private calculateCollectionTimeRange(
    existingData: StoredUsageData, 
    subscriptionRange: { start_time: number; end_time: number }
  ): { start_time: number; end_time: number } {
    const now = Math.floor(Date.now() / 1000);
    const end_time = Math.min(subscriptionRange.end_time, now);
    
    let start_time: number;
    
    if (existingData.last_update_time > 0) {
      // 增量收集：从上次更新时间前1小时开始
      start_time = existingData.last_update_time - 3600; // 减去1小时
    } else {
      // 首次收集：从订阅开始时间收集
      start_time = subscriptionRange.start_time;
    }
    
    return { start_time, end_time };
  }



  private async getSubscriptionTimeRange(authToken: string): Promise<{ start_time: number; end_time: number } | null> {
    try {
      const result = await this.apiService.getSubscriptionTimeRange(authToken);
      return result;
    } catch (error) {
      logWithTime(t('usageCollector.getSubscriptionFailed', { error: String(error) }));
      return null;
    }
  }

  private async collectAllPages(
    authToken: string, 
    start_time: number, 
    end_time: number, 
    existingData: StoredUsageData,
    subscriptionRange: { start_time: number; end_time: number }
  ): Promise<void> {
    let pageNum = 1;
    const pageSize = 50;
    let totalRecords = 0;
    let collectedCount = 0;
    let updatedCount = 0;

    // 创建数据的深拷贝，用于临时存储
    const tempData: StoredUsageData = {
      ...existingData,
      usage_details: { ...existingData.usage_details }
    };

    try {
      // 获取第一页数据以确定总页数
      const firstPageResponse = await this.fetchUsageDetailsPage(authToken, start_time, end_time, pageNum, pageSize);
      if (!firstPageResponse) {
        throw new Error(t('usageCollector.cannotGetUsageDetails'));
      }

      totalRecords = firstPageResponse.total;
      const totalPages = Math.ceil(totalRecords / pageSize);
      logWithTime(t('usageCollector.startCollecting', { total: totalRecords, pages: totalPages }));

      // 存储所有页面的数据
      const allPagesData: UsageDetailItem[] = [];
      
      // 添加第一页数据
      allPagesData.push(...firstPageResponse.user_usage_group_by_sessions);

      // 串行获取剩余页面数据
      for (pageNum = 2; pageNum <= totalPages; pageNum++) {
        // 添加延迟避免请求过于频繁
        await new Promise(resolve => setTimeout(resolve, 1000));

        const pageResponse = await this.fetchUsageDetailsPage(authToken, start_time, end_time, pageNum, pageSize);
        if (!pageResponse) {
          throw new Error(`获取第${pageNum}页数据失败`);
        }
        
        allPagesData.push(...pageResponse.user_usage_group_by_sessions);
        logWithTime(`成功获取第${pageNum}页数据，包含${pageResponse.user_usage_group_by_sessions.length}条记录`);
      }

      // 只有所有页面都成功获取后，才处理数据
      logWithTime(`所有${totalPages}页数据获取成功，开始处理数据`);
      
      // 处理所有数据
      allPagesData.forEach(item => {
        const sessionId = item.session_id;
        if (tempData.usage_details[sessionId]) {
          // 检查是否需要更新（比较usage_time）
          if (tempData.usage_details[sessionId].usage_time !== item.usage_time) {
            tempData.usage_details[sessionId] = item;
            updatedCount++;
          }
        } else {
          tempData.usage_details[sessionId] = item;
          collectedCount++;
        }
      });

      // 更新时间戳
      tempData.last_update_time = Math.floor(Date.now() / 1000);
      tempData.start_time = subscriptionRange.start_time;
      tempData.end_time = subscriptionRange.end_time;
      
      // 只有在所有数据都处理成功后才保存
      await this.saveUsageData(tempData);
      
      // 只在收集完成后显示通知
      const choice = await vscode.window.showInformationMessage(
        t('usageCollector.collectionCompleteMessage', { 
          collected: collectedCount, 
          updated: updatedCount, 
          total: Object.keys(tempData.usage_details).length 
        }),
        t('usageCollector.viewDashboard')
      );

      if (choice === t('usageCollector.viewDashboard')) {
        vscode.commands.executeCommand('traeUsage.showUsageDashboard');
      }

    } catch (error) {
      logWithTime(t('usageCollector.collectionError', { error: String(error) }));
      // 发生错误时不保存任何数据
      throw error;
    }
  }

  private async fetchUsageDetailsPage(
    authToken: string,
    start_time: number,
    end_time: number,
    pageNum: number,
    pageSize: number
  ): Promise<UsageDetailResponse | null> {
    try {
      const result = await this.apiService.queryUserUsageGroupBySession(
        authToken,
        start_time,
        end_time,
        pageNum,
        pageSize
      );
      return result;
    } catch (error: any) {
      logWithTime(t('usageCollector.fetchPageFailed', { page: pageNum, error: String(error) }));
      return null;
    }
  }

  private async saveUsageData(data: StoredUsageData): Promise<void> {
    const dataPath = vscode.Uri.joinPath(this.context.globalStorageUri, USAGE_DATA_FILE);

    try {
      // 确保存储目录存在
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      
      const jsonData = JSON.stringify(data, null, 2);
      await vscode.workspace.fs.writeFile(dataPath, Buffer.from(jsonData, 'utf8'));
      
    } catch (error) {
      logWithTime(t('usageCollector.saveDataFailed', { error: String(error) }));
      throw new Error(t('usageCollector.saveDataError', { error: String(error) }));
    }
  }

  private getSessionId(): string | undefined {
    const config = vscode.workspace.getConfiguration('traeUsage');
    return config.get<string>('sessionId');
  }

  private async getAuthToken(sessionId: string): Promise<string | null> {
    try {
      const result = await this.apiService.getTokenWithRetry(sessionId);
      return result;
    } catch (error) {
      logWithTime(t('usageCollector.getTokenFailed', { error: String(error) }));
      // 添加用户友好的错误提示
      vscode.window.showErrorMessage(
        '认证失败：无法获取Token，请检查Session ID是否正确或网络连接',
        '更新Session ID'
      ).then(selection => {
        if (selection === '更新Session ID') {
          vscode.commands.executeCommand('traeUsage.updateSession');
        }
      });
      return null;
    }
  }
}
