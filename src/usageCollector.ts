import * as vscode from 'vscode';
import * as os from 'os';
import axios from 'axios';
import { 
  UsageDetailItem, 
  UsageDetailResponse, 
  StoredUsageData
} from './types';
import { logWithTime, formatTimestamp } from './utils';
import { ApiResponse, TokenResponse } from './extension';
import { t } from './i18n';
import { getApiService } from './apiService';

const DEFAULT_HOST = 'https://api-sg-central.trae.ai';
const API_TIMEOUT = 3000;
const USAGE_DATA_FILE = 'usage_data.json';
const MAX_RETRIES = 5; // 最大重试次数
const RETRY_DELAY = 1000; // 重试延迟（毫秒）

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

  // 带重试机制的通用API请求函数
  private async apiRequestWithRetry<T>(
    requestFn: () => Promise<T>,
    operationName: string,
    maxRetries: number = MAX_RETRIES
  ): Promise<T> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await requestFn();
        if (attempt > 1) {
          logWithTime(`${operationName} 在第${attempt}次尝试后成功`);
        }
        return result;
      } catch (error) {
        lastError = error;
        logWithTime(`${operationName} 第${attempt}次尝试失败: ${String(error)}`);
        
        if (attempt < maxRetries) {
          const delay = RETRY_DELAY * attempt; // 递增延迟
          logWithTime(`等待${delay}ms后进行第${attempt + 1}次重试`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw new Error(`${operationName} 在${maxRetries}次重试后仍然失败: ${String(lastError)}`);
  }

  private async getSubscriptionTimeRange(authToken: string): Promise<{ start_time: number; end_time: number } | null> {
    try {
      const result = await this.apiRequestWithRetry(async () => {
        const currentHost = this.getHost();
        const response = await axios.post<ApiResponse>(
          `${currentHost}/trae/api/v1/pay/user_current_entitlement_list`,
          {},
          {
            headers: {
              'authorization': `Cloud-IDE-JWT ${authToken}`,
              'Host': new URL(currentHost).hostname,
              'Content-Type': 'application/json'
            },
            timeout: API_TIMEOUT
          }
        );

        if (response.data.user_entitlement_pack_list?.length > 0) {
          const pack = response.data.user_entitlement_pack_list[0];
          return {
            start_time: pack.entitlement_base_info.start_time,
            end_time: pack.entitlement_base_info.end_time
          };
        }
        throw new Error('No entitlement pack found');
      }, '获取订阅时间范围');

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
      const result = await this.apiRequestWithRetry(async () => {
        const currentHost = this.getHost();
        const url = `${currentHost}/trae/api/v1/pay/query_user_usage_group_by_session`;
        const requestBody = {
          start_time,
          end_time,
          page_size: pageSize,
          page_num: pageNum
        };
        const headers = {
          'authorization': `Cloud-IDE-JWT ${authToken}`,
          'Host': new URL(currentHost).hostname,
          'Content-Type': 'application/json'
        };

        logWithTime(t('usageCollector.requestPageData', { page: pageNum, url }));

        const response = await axios.post<UsageDetailResponse>(
          url,
          requestBody,
          {
            headers,
            timeout: 10000
          }
        );

        return response.data;
      }, `获取第${pageNum}页使用详情`);

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
      logWithTime(t('usageCollector.dataSaved', { path: dataPath.fsPath }));
      
    } catch (error) {
      logWithTime(t('usageCollector.saveDataFailed', { error: String(error) }));
      throw new Error(t('usageCollector.saveDataError', { error: String(error) }));
    }
  }

  private getSessionId(): string | undefined {
    const config = vscode.workspace.getConfiguration('traeUsage');
    return config.get<string>('sessionId');
  }

  private getHost(): string {
    const config = vscode.workspace.getConfiguration('traeUsage');
    return config.get<string>('host') || DEFAULT_HOST;
  }

  private async getAuthToken(sessionId: string): Promise<string | null> {
    try {
      const result = await this.apiService.getTokenWithRetry(sessionId, MAX_RETRIES);
      return result;
    } catch (error) {
      logWithTime(t('usageCollector.getTokenFailed', { error: String(error) }));
      return null;
    }
  }
}
