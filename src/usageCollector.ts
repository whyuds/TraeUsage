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

const DEFAULT_HOST = 'https://api-sg-central.trae.ai';
const API_TIMEOUT = 3000;
const USAGE_DATA_FILE = 'usage_data.json';

export class UsageDetailCollector {
  private context: vscode.ExtensionContext;
  private isCollecting = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public async collectUsageDetails(): Promise<void> {
    if (this.isCollecting) {
      logWithTime('收集操作已在进行中，跳过本次请求');
      vscode.window.showWarningMessage(t('usageCollector.alreadyCollecting'));
      return;
    }

    logWithTime('开始收集使用量详情');
    try {
      this.isCollecting = true;
      await this.startCollection();
      logWithTime('收集使用量详情完成');
    } catch (error) {
      logWithTime(`收集使用量详情失败: ${error}`);
      vscode.window.showErrorMessage(t('usageCollector.collectionError', { error: error?.toString() || 'Unknown error' }));
    } finally {
      this.isCollecting = false;
      logWithTime('重置收集状态为 false');
    }
  }

  private async startCollection(): Promise<void> {
    const sessionId = this.getSessionId();
    if (!sessionId) {
      vscode.window.showWarningMessage(t('usageCollector.pleaseSetSessionId'));
      return;
    }

    const authToken = await this.getAuthToken(sessionId);
    if (!authToken) {
      vscode.window.showErrorMessage(t('usageCollector.cannotGetToken'));
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
    
    // 直接调用收集函数，不显示进度通知
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
      return null;
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

    try {
      const firstPageResponse = await this.fetchUsageDetailsPage(authToken, start_time, end_time, pageNum, pageSize);
      if (!firstPageResponse) {
        throw new Error(t('usageCollector.cannotGetUsageDetails'));
      }

      totalRecords = firstPageResponse.total;
      const totalPages = Math.ceil(totalRecords / pageSize);
      logWithTime(t('usageCollector.startCollecting', { total: totalRecords, pages: totalPages }));

      // 处理第一页数据
      const { collected, updated } = this.processPageData(firstPageResponse.user_usage_group_by_sessions, existingData);
      collectedCount += collected;
      updatedCount += updated;

      // 处理剩余页面
      for (pageNum = 2; pageNum <= totalPages; pageNum++) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const pageResponse = await this.fetchUsageDetailsPage(authToken, start_time, end_time, pageNum, pageSize);
        if (pageResponse) {
          const { collected, updated } = this.processPageData(pageResponse.user_usage_group_by_sessions, existingData);
          collectedCount += collected;
          updatedCount += updated;
          
          logWithTime(t('usageCollector.collectedPage', { page: pageNum, collected, updated }));
        }
      }

      // 更新数据并保存
      existingData.last_update_time = Math.floor(Date.now() / 1000);
      existingData.start_time = subscriptionRange.start_time;
      existingData.end_time = subscriptionRange.end_time;
      
      await this.saveUsageData(existingData);
      
      // 只在收集完成后显示通知
      const choice = await vscode.window.showInformationMessage(
        t('usageCollector.collectionCompleteMessage', { 
          collected: collectedCount, 
          updated: updatedCount, 
          total: Object.keys(existingData.usage_details).length 
        }),
        t('usageCollector.viewDashboard')
      );

      if (choice === t('usageCollector.viewDashboard')) {
        vscode.commands.executeCommand('traeUsage.showUsageDashboard');
      }

    } catch (error) {
      logWithTime(t('usageCollector.collectionError', { error: String(error) }));
      throw error;
    }
  }

  private processPageData(items: UsageDetailItem[], existingData: StoredUsageData): { collected: number; updated: number } {
    let collected = 0;
    let updated = 0;

    items.forEach(item => {
      const sessionId = item.session_id;
      if (existingData.usage_details[sessionId]) {
        // 检查是否需要更新（比较usage_time）
        if (existingData.usage_details[sessionId].usage_time !== item.usage_time) {
          existingData.usage_details[sessionId] = item;
          updated++;
        }
      } else {
        existingData.usage_details[sessionId] = item;
        collected++;
      }
    });

    return { collected, updated };
  }

  private async fetchUsageDetailsPage(
    authToken: string,
    start_time: number,
    end_time: number,
    pageNum: number,
    pageSize: number
  ): Promise<UsageDetailResponse | null> {
    try {
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
    const currentHost = this.getHost();
    
    try {
      const response = await axios.post<TokenResponse>(
        `${currentHost}/cloudide/api/v3/common/GetUserToken`,
        {},
        {
          headers: {
            'Cookie': `X-Cloudide-Session=${sessionId}`,
            'Host': new URL(currentHost).hostname,
            'Content-Type': 'application/json'
          },
          timeout: API_TIMEOUT
        }
      );

      return response.data.Result.Token;
    } catch (error) {
      logWithTime(t('usageCollector.getTokenFailed', { error: String(error) }));
      return null;
    }
  }
}
