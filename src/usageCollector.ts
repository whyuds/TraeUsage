import * as vscode from 'vscode';
import * as os from 'os';
import axios from 'axios';
import { 
  UsageDetailItem, 
  UsageDetailResponse, 
  StoredUsageData, 
  UsageSummary,
  ModelStats,
  ModeStats,
  DailyStats
} from './types';
import { logWithTime, formatTimestamp } from './utils';
import { ApiResponse, TokenResponse } from './extension';

const DEFAULT_HOST = 'https://api-sg-central.trae.ai';
const API_TIMEOUT = 3000;

export class UsageDetailCollector {
  private context: vscode.ExtensionContext;
  private isCollecting = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public async collectUsageDetails(): Promise<void> {
    if (this.isCollecting) {
      vscode.window.showWarningMessage('收集正在进行中，请稍候...');
      return;
    }

    try {
      this.isCollecting = true;
      await this.startCollection();
    } catch (error) {
      logWithTime(`收集使用量详情失败: ${error}`);
      vscode.window.showErrorMessage(`收集失败: ${error?.toString() || 'Unknown error'}`);
    } finally {
      this.isCollecting = false;
    }
  }

  private async startCollection(): Promise<void> {
    const sessionId = this.getSessionId();
    if (!sessionId) {
      vscode.window.showWarningMessage('请先设置Session ID');
      return;
    }

    const authToken = await this.getAuthToken(sessionId);
    if (!authToken) {
      vscode.window.showErrorMessage('无法获取认证Token');
      return;
    }

    const timeRange = await this.getSubscriptionTimeRange(authToken);
    if (!timeRange) {
      vscode.window.showErrorMessage('无法获取订阅信息');
      return;
    }

    const { start_time, end_time } = timeRange;
    
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: '正在收集使用量详情...',
      cancellable: true
    }, async (progress, token) => {
      return this.collectAllPages(authToken, start_time, end_time, progress, token);
    });
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
      logWithTime(`获取订阅信息失败: ${error}`);
      return null;
    }
  }

  private async collectAllPages(
    authToken: string, 
    start_time: number, 
    end_time: number, 
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const allUsageDetails: UsageDetailItem[] = [];
    let pageNum = 1;
    const pageSize = 50;
    let totalRecords = 0;

    try {
      const firstPageResponse = await this.fetchUsageDetailsPage(authToken, start_time, end_time, pageNum, pageSize);
      if (!firstPageResponse) {
        throw new Error('无法获取使用量详情');
      }

      totalRecords = firstPageResponse.total;
      allUsageDetails.push(...firstPageResponse.user_usage_group_by_sessions);

      const totalPages = Math.ceil(totalRecords / pageSize);
      logWithTime(`开始收集使用量详情，总记录数: ${totalRecords}, 总页数: ${totalPages}`);

      progress.report({ message: `收集第 1/${totalPages} 页 (${allUsageDetails.length}/${totalRecords})`, increment: 0 });

      for (pageNum = 2; pageNum <= totalPages; pageNum++) {
        if (token.isCancellationRequested) {
          throw new Error('用户取消了收集操作');
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        const pageResponse = await this.fetchUsageDetailsPage(authToken, start_time, end_time, pageNum, pageSize);
        if (pageResponse) {
          allUsageDetails.push(...pageResponse.user_usage_group_by_sessions);
          progress.report({ 
            message: `收集第 ${pageNum}/${totalPages} 页 (${allUsageDetails.length}/${totalRecords})`, 
            increment: 100 / totalPages 
          });
          logWithTime(`已收集第 ${pageNum} 页，当前总数: ${allUsageDetails.length}`);
        }
      }

      const summary = this.generateSummary(allUsageDetails);

      const storedData: StoredUsageData = {
        timestamp: Date.now(),
        start_time,
        end_time,
        total_records: totalRecords,
        usage_details: allUsageDetails,
        summary
      };

      await this.saveUsageData(storedData);
      
      progress.report({ message: '收集完成!', increment: 100 });
      
      const choice = await vscode.window.showInformationMessage(
        `收集完成！共 ${totalRecords} 条记录，总使用量: ${(summary.total_amount || 0).toFixed(2)}，总费用: $${(summary.total_cost || 0).toFixed(2)}`,
        '查看仪表板'
      );

      if (choice === '查看仪表板') {
        vscode.commands.executeCommand('traeUsage.showUsageDashboard');
      }

    } catch (error) {
      logWithTime(`收集过程中出错: ${error}`);
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

      // 打印请求信息
      logWithTime(`=== API请求调试信息 (第${pageNum}页) ===`);
      logWithTime(`请求URL: ${url}`);
      logWithTime(`请求体: ${JSON.stringify(requestBody, null, 2)}`);
      logWithTime(`请求头: ${JSON.stringify(headers, null, 2)}`);

      const response = await axios.post<UsageDetailResponse>(
        url,
        requestBody,
        {
          headers,
          timeout: 10000
        }
      );

      // 打印响应信息
      logWithTime(`响应状态: ${response.status}`);
      logWithTime(`响应头: ${JSON.stringify(response.headers, null, 2)}`);
      logWithTime(`响应数据: ${JSON.stringify(response.data, null, 2)}`);
      logWithTime(`=== API请求调试信息结束 ===`);

      return response.data;
    } catch (error: any) {
      // 打印详细错误信息
      logWithTime(`=== API请求错误信息 (第${pageNum}页) ===`);
      logWithTime(`错误类型: ${error.constructor.name}`);
      logWithTime(`错误消息: ${error.message}`);
      
      if (error.response) {
        logWithTime(`响应状态码: ${error.response.status}`);
        logWithTime(`响应状态文本: ${error.response.statusText}`);
        logWithTime(`响应头: ${JSON.stringify(error.response.headers, null, 2)}`);
        logWithTime(`响应数据: ${JSON.stringify(error.response.data, null, 2)}`);
      } else if (error.request) {
        logWithTime(`请求已发送但未收到响应`);
        logWithTime(`请求信息: ${JSON.stringify(error.request, null, 2)}`);
      } else {
        logWithTime(`请求配置错误: ${error.message}`);
      }
      
      if (error.config) {
        logWithTime(`请求配置: ${JSON.stringify({
          url: error.config.url,
          method: error.config.method,
          headers: error.config.headers,
          data: error.config.data,
          timeout: error.config.timeout
        }, null, 2)}`);
      }
      
      logWithTime(`=== API请求错误信息结束 ===`);
      logWithTime(`获取第 ${pageNum} 页使用量详情失败: ${error}`);
      return null;
    }
  }

  private generateSummary(usageDetails: UsageDetailItem[]): UsageSummary {
    const summary: UsageSummary = {
      total_amount: 0,
      total_cost: 0,
      total_sessions: usageDetails.length,
      model_stats: {},
      mode_stats: {},
      daily_stats: {}
    };

    usageDetails.forEach(item => {
      summary.total_amount += item.amount_float;
      summary.total_cost += item.cost_money_float;

      // 模型统计
      const modelName = item.model_name;
      if (!summary.model_stats[modelName]) {
        summary.model_stats[modelName] = {
          count: 0,
          amount: 0,
          cost: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0
        };
      }
      const modelStats = summary.model_stats[modelName];
      modelStats.count++;
      modelStats.amount += item.amount_float;
      modelStats.cost += item.cost_money_float;
      modelStats.input_tokens += item.extra_info.input_token;
      modelStats.output_tokens += item.extra_info.output_token;
      modelStats.cache_read_tokens += item.extra_info.cache_read_token;
      modelStats.cache_write_tokens += item.extra_info.cache_write_token;

      // 模式统计
      const mode = item.mode || 'Normal';
      if (!summary.mode_stats[mode]) {
        summary.mode_stats[mode] = { count: 0, amount: 0, cost: 0 };
      }
      summary.mode_stats[mode].count++;
      summary.mode_stats[mode].amount += item.amount_float;
      summary.mode_stats[mode].cost += item.cost_money_float;

      // 日期统计
      const date = new Date(item.usage_time * 1000).toISOString().split('T')[0];
      if (!summary.daily_stats[date]) {
        summary.daily_stats[date] = { count: 0, amount: 0, cost: 0, models: new Set() };
      }
      summary.daily_stats[date].count++;
      summary.daily_stats[date].amount += item.amount_float;
      summary.daily_stats[date].cost += item.cost_money_float;
      summary.daily_stats[date].models.add(modelName);
    });

    // 转换 Set 为数组以便序列化
    Object.keys(summary.daily_stats).forEach(date => {
      (summary.daily_stats[date] as any).models = Array.from(summary.daily_stats[date].models);
    });

    return summary;
  }

  private async saveUsageData(data: StoredUsageData): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const fileName = `usage_detail_${timestamp}_${data.timestamp}.json`;
    
    // 使用扩展的存储目录
    const targetPath = vscode.Uri.joinPath(this.context.globalStorageUri, fileName);

    try {
      // 确保存储目录存在
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      
      const jsonData = JSON.stringify(data, null, 2);
      await vscode.workspace.fs.writeFile(targetPath, Buffer.from(jsonData, 'utf8'));
      logWithTime(`使用量数据已保存到: ${targetPath.fsPath}`);
      
      const config = vscode.workspace.getConfiguration('traeUsage');
      await config.update('lastUsageDataFile', targetPath.fsPath, vscode.ConfigurationTarget.Global);
      
    } catch (error) {
      logWithTime(`保存使用量数据失败: ${error}`);
      throw new Error(`保存数据失败: ${error}`);
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
      logWithTime(`获取Token失败: ${error}`);
      return null;
    }
  }
}
