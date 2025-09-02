import * as vscode from 'vscode';
import * as os from 'os';
import * as cp from 'child_process';
import axios from 'axios';
import WebSocket from 'ws';
import { initializeI18n, t } from './i18n';

// ==================== 类型定义 ====================
interface UsageData {
  advanced_model_amount: number;
  advanced_model_request_usage: number;
  auto_completion_amount: number;
  auto_completion_usage: number;
  is_flash_consuming: boolean;
  premium_model_fast_amount: number;
  premium_model_fast_request_usage: number;
  premium_model_slow_amount: number;
  premium_model_slow_request_usage: number;
}

interface QuotaData {
  advanced_model_request_limit: number;
  auto_completion_limit: number;
  premium_model_fast_request_limit: number;
  premium_model_slow_request_limit: number;
}

interface EntitlementPack {
  entitlement_base_info: {
    end_time: number;
    quota: QuotaData;
    user_id: string;
    start_time: number;
  };
  usage: UsageData;
  status: number;
}

interface ApiResponse {
  code?: number;
  message?: string;
  is_pay_freshman: boolean;
  user_entitlement_pack_list: EntitlementPack[];
}

interface TokenResponse {
  ResponseMetadata: {
    RequestId: string;
    TraceID: string;
    Action: string;
    Version: string;
    Source: string;
    Service: string;
    Region: string;
    WID: null;
    OID: null;
  };
  Result: {
    Token: string;
    ExpiredAt: string;
    UserID: string;
    TenantID: string;
  };
}

type BrowserType = 'chrome' | 'edge' | 'unknown';

// ==================== WebSocket类型定义 ====================
interface WebSocketHeartbeatMessage {
  type: 'heartbeat';
  timestamp: number;
  clientId: string;
  ip: string;
  machineId: string;
  premium_model_fast_request_limit: number;
  premium_model_fast_request_usage: number;
  user_id: string;
  start_time: number;
  end_time: number;
  group_id?: string;
}

// ==================== 常量定义 ====================
const DEFAULT_HOST = 'https://api-sg-central.trae.ai';
const FALLBACK_HOST = 'https://api-us-east.trae.ai';
const DOUBLE_CLICK_DELAY = 300;
const API_TIMEOUT = 3000;
const MAX_RETRY_COUNT = 5;
const RETRY_DELAY = 1000;
const TOKEN_ERROR_CODE = '20310';

// ==================== 工具函数 ====================
let outputChannel: vscode.OutputChannel;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Trae Usage');
  }
  return outputChannel;
}

function logWithTime(message: string): void {
  const timestamp = new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  getOutputChannel().appendLine(logMessage);
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).replace(/\//g, '/');
}

// ==================== 浏览器检测 ====================
async function detectDefaultBrowser(): Promise<BrowserType> {
  const platform = os.platform();
  
  try {
    const command = getBrowserDetectionCommand(platform);
    if (!command) return 'unknown';
    
    return new Promise((resolve) => {
      cp.exec(command, (error, stdout) => {
        if (error) {
          logWithTime(`检测浏览器失败: ${error.message}`);
          resolve('unknown');
          return;
        }
        
        const browserType = parseBrowserOutput(stdout.toLowerCase());
        resolve(browserType);
      });
    });
  } catch (error) {
    logWithTime(`检测浏览器异常: ${error}`);
    return 'unknown';
  }
}

function getBrowserDetectionCommand(platform: string): string | null {
  switch (platform) {
    case 'win32':
      return 'reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId';
    case 'darwin':
      return 'defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers | grep -A 2 -B 2 "LSHandlerURLScheme.*http"';
    case 'linux':
      return 'xdg-settings get default-web-browser';
    default:
      return null;
  }
}

function parseBrowserOutput(output: string): BrowserType {
  if (output.includes('chrome')) return 'chrome';
  if (output.includes('edge') || output.includes('msedge')) return 'edge';
  return 'unknown';
}

// ==================== WebSocket管理器 ====================
class WebSocketManager {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatInterval = 30000;
  private clientId: string;
  private url: string | null = null;
  private enabled = false;
  private cachedHeartbeatData: WebSocketHeartbeatMessage | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.clientId = this.generateClientId();
  }

  private generateClientId(): string {
    const machineId = vscode.env.machineId;
    const timestamp = Date.now();
    return `vscode-${machineId}-${timestamp}`;
  }

  public updateConfig(): void {
    const config = vscode.workspace.getConfiguration('traeUsage');
    const newUrl = config.get<string>('websocketUrl', '');
    const newEnabled = config.get<boolean>('enableWebsocket', false);

    this.url = newUrl;
    this.enabled = newEnabled;

    // 如果禁用了WebSocket，断开连接并停止心跳
    if (!this.enabled) {
      this.disconnect();
      this.stopHeartbeat();
    } else if (this.enabled && this.url) {
      // 如果启用了WebSocket，开始心跳定时器
      this.startHeartbeat();
    }
  }

  private async connectIfNeeded(): Promise<boolean> {
    if (!this.enabled || !this.url) {
      return false;
    }

    if (this.isConnected && this.ws) {
      return true;
    }

    return this.connect();
  }

  private async connect(): Promise<boolean> {
    const correctedUrl = this.validateAndCorrectUrl(this.url!);
    if (!correctedUrl) {
      logWithTime(`WebSocket URL 格式无效: ${this.url}`);
      return false;
    }

    // 清理旧连接
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }

    try {
      logWithTime(`尝试连接WebSocket: ${correctedUrl}`);
      this.ws = new WebSocket(correctedUrl);

      return new Promise<boolean>((resolve) => {
        const connectionTimeout = setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
            logWithTime('WebSocket连接超时');
            this.ws.terminate();
            resolve(false);
          }
        }, 10000);

        this.ws!.on('open', () => {
          clearTimeout(connectionTimeout);
          this.onOpen();
          resolve(true);
        });

        this.ws!.on('close', (code, reason) => {
          clearTimeout(connectionTimeout);
          this.onClose(code, reason);
          resolve(false);
        });

        this.ws!.on('error', (error) => {
          clearTimeout(connectionTimeout);
          this.onError(error);
          resolve(false);
        });
      });

    } catch (error) {
      logWithTime(`WebSocket连接异常: ${error}`);
      return false;
    }
  }

  private validateAndCorrectUrl(url: string): string | null {
    try {
      if (url.includes('0.0.0.0')) {
        const correctedUrl = url.replace('0.0.0.0', 'localhost');
        logWithTime(`URL已修正: ${url} -> ${correctedUrl}`);
        return correctedUrl;
      }

      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
        logWithTime(`不支持的协议: ${parsedUrl.protocol}`);
        return null;
      }

      return url;
    } catch (error) {
      logWithTime(`URL解析失败: ${error}`);
      return null;
    }
  }

  private onOpen(): void {
    this.isConnected = true;
    logWithTime(`WebSocket已连接: ${this.url}`);
  }

  private onClose(code?: number, reason?: Buffer): void {
    this.isConnected = false;
    
    const closeMessage = reason ? reason.toString() : '';
    logWithTime(`WebSocket连接已关闭 (代码: ${code}, 原因: ${closeMessage})`);
  }

  private onError(error: Error): void {
    const errorMessage = error.message;
    logWithTime(`WebSocket错误: ${errorMessage}`);
    
    this.isConnected = false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    // 立即尝试发送一次心跳
    this.sendHeartbeat();
    
    // 启动定时器
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.enabled || !this.cachedHeartbeatData) {
      return;
    }

    // 尝试连接（如果需要）
    const connected = await this.connectIfNeeded();
    if (!connected) {
      logWithTime('WebSocket连接失败，跳过心跳发送');
      return;
    }

    const heartbeatMessage: WebSocketHeartbeatMessage = {
      ...this.cachedHeartbeatData,
      timestamp: Date.now()
    };

    this.sendMessage(heartbeatMessage);
  }

  private async getClientIP(): Promise<string> {
    try {
      const response = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
      return response.data.ip;
    } catch (error) {
      logWithTime(`获取IP地址失败: ${error}`);
      return 'unknown';
    }
  }

  public async updateHeartbeatData(usageData: ApiResponse): Promise<void> {
    if (!usageData.user_entitlement_pack_list || usageData.user_entitlement_pack_list.length === 0) {
      return;
    }

    // 获取第一条订阅数据
    const firstPack = usageData.user_entitlement_pack_list[0];
    const ip = await this.getClientIP();
    const config = vscode.workspace.getConfiguration('traeUsage');
    const groupId = config.get<string>('websocketGroupId');

    this.cachedHeartbeatData = {
      type: 'heartbeat',
      timestamp: Date.now(),
      clientId: this.clientId,
      ip,
      machineId: vscode.env.machineId,
      premium_model_fast_request_limit: firstPack.entitlement_base_info.quota.premium_model_fast_request_limit,
      premium_model_fast_request_usage: firstPack.usage.premium_model_fast_request_usage,
      user_id: firstPack.entitlement_base_info.user_id,
      start_time: firstPack.entitlement_base_info.start_time,
      end_time: firstPack.entitlement_base_info.end_time
    };

    // 如果配置了group_id，则添加到心跳数据中
    if (groupId && groupId.trim() !== '') {
      this.cachedHeartbeatData.group_id = groupId.trim();
    }

    logWithTime(`心跳数据已更新: ${JSON.stringify(this.cachedHeartbeatData, null, 2)}`);

    // 心跳数据更新后，如果启用了WebSocket并且有URL，立即尝试发送一次心跳
    if (this.enabled && this.url) {
      this.sendHeartbeat();
    }
  }

  private sendMessage(message: WebSocketHeartbeatMessage): void {
    if (!this.ws || !this.isConnected) {
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      logWithTime(`WebSocket发送消息失败: ${error}`);
    }
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    
    logWithTime('WebSocket已断开连接');
  }

  public getConnectionStatus(): { enabled: boolean; connected: boolean; url: string | null } {
    return {
      enabled: this.enabled,
      connected: this.isConnected,
      url: this.url
    };
  }

  public dispose(): void {
    this.stopHeartbeat();
    this.disconnect();
  }
}

// ==================== 主类 ====================
class TraeUsageProvider {
  private usageData: ApiResponse | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private clickTimer: NodeJS.Timeout | null = null;
  private statusBarItem: vscode.StatusBarItem;
  private cachedToken: string | null = null;
  private cachedSessionId: string | null = null;
  private clickCount = 0;
  private isRefreshing = false;
  private isManualRefresh = false;
  private webSocketManager: WebSocketManager;

  constructor(private context: vscode.ExtensionContext) {
    this.statusBarItem = this.createStatusBarItem();
    this.webSocketManager = new WebSocketManager(context);
    this.initialize();
  }

  private createStatusBarItem(): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.command = 'traeUsage.handleStatusBarClick';
    item.show();
    return item;
  }

  private initialize(): void {
    const sessionId = this.getSessionId();

    if (sessionId) {
      this.isRefreshing = true;
      this.setLoadingState();
    } else {
      this.updateStatusBar();
    }

    this.webSocketManager.updateConfig();
    this.startAutoRefresh();
    this.fetchUsageData();
  }

  // ==================== 点击处理 ====================
  handleStatusBarClick(): void {
    if (this.isRefreshing) return;
    
    this.clickCount++;
    
    if (this.clickTimer) {
      this.clearClickTimer();
      vscode.commands.executeCommand('traeUsage.updateSession');
    } else {
      this.clickTimer = setTimeout(() => {
        if (this.clickCount === 1) {
          this.refresh();
        }
        this.clearClickTimer();
      }, DOUBLE_CLICK_DELAY);
    }
  }

  private clearClickTimer(): void {
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    this.clickCount = 0;
  }

  // ==================== 刷新逻辑 ====================
  refresh(): void {
    this.isManualRefresh = true;
    this.isRefreshing = true;
    this.setLoadingState();
    this.clearCache();
    this.fetchUsageData();
  }

  private setLoadingState(): void {
    this.statusBarItem.text = t('statusBar.loading');
    this.statusBarItem.tooltip = t('statusBar.refreshing');
    this.statusBarItem.color = undefined;
  }

  private clearCache(): void {
    this.cachedToken = null;
    this.cachedSessionId = null;
  }

  // ==================== 状态栏更新 ====================
  private updateStatusBar(): void {
    if (!this.usageData || this.usageData.code === 1001) {
      const sessionId = this.getSessionId();
      if (!sessionId) {
        this.showNotConfiguredStatus();
      }
      return;
    }

    const stats = this.calculateUsageStats();
    if (stats.hasValidPacks) {
      this.showUsageStatus(stats);
    } else {
      this.showNoActiveSubscriptionStatus();
    }
  }

  private showNotConfiguredStatus(): void {
    this.statusBarItem.text = t('statusBar.notConfigured');
    this.statusBarItem.color = undefined;
    this.statusBarItem.tooltip = `${t('statusBar.clickToConfigureSession')}\n\n${t('statusBar.clickInstructions')}`;
  }

  private showUsageStatus(stats: UsageStats): void {
    const { totalUsage, totalLimit } = stats;
    const remaining = totalLimit - totalUsage;
    
    // 获取WebSocket连接状态
    const wsStatus = this.webSocketManager.getConnectionStatus();
    let lightningIcon = '⚡'; // 默认闪电图标
    
    if (wsStatus.enabled && wsStatus.url) {
      if (wsStatus.connected) {
        lightningIcon = '⚡'; // 连接成功：正常闪电
      } else {
        lightningIcon = '🔌'; // 连接失败：插头图标
      }
    }
    
    this.statusBarItem.text = `${lightningIcon} Fast: ${totalUsage}/${totalLimit} (${t('statusBar.remaining', { remaining: remaining.toString() })})`;
    this.statusBarItem.color = undefined;
    this.statusBarItem.tooltip = this.buildDetailedTooltip();
  }

  private showNoActiveSubscriptionStatus(): void {
    this.statusBarItem.text = t('statusBar.noActiveSubscription');
    this.statusBarItem.color = undefined;
    this.statusBarItem.tooltip = `${t('statusBar.noActiveSubscriptionTooltip')}\n\n${t('statusBar.clickInstructions')}`;
  }

  // ==================== 使用量统计 ====================
  private hasValidUsageData(pack: EntitlementPack): boolean {
    const { quota } = pack.entitlement_base_info;
    return quota.premium_model_fast_request_limit > 0 ||
           quota.premium_model_slow_request_limit > 0 ||
           quota.auto_completion_limit > 0 ||
           quota.advanced_model_request_limit > 0;
  }

  private calculateUsageStats(): UsageStats {
    let totalUsage = 0;
    let totalLimit = 0;
    let hasValidPacks = false;

    if (!this.usageData) {
      return { totalUsage, totalLimit, hasValidPacks };
    }

    this.usageData.user_entitlement_pack_list.forEach(pack => {
      const usage = pack.usage.premium_model_fast_request_usage;
      const limit = pack.entitlement_base_info.quota.premium_model_fast_request_limit;
      
      if (limit > 0) {
        totalUsage += usage;
        totalLimit += limit;
        hasValidPacks = true;
      }
    });

    return { totalUsage, totalLimit, hasValidPacks };
  }

  // ==================== Tooltip 构建 ====================
  private buildDetailedTooltip(): string {
    if (!this.usageData || this.usageData.code === 1001) {
      return `${t('statusBar.clickToConfigureSession')}\n\n${t('statusBar.clickInstructions')}`;
    }

    const sections: string[] = [
      t('tooltip.title'),
      '═'.repeat(30)
    ];

    const validPacks = this.usageData.user_entitlement_pack_list.filter(pack => 
      this.hasValidUsageData(pack)
    );

    if (validPacks.length === 0) {
      sections.push(t('tooltip.noValidPacks'));
    } else {
      validPacks.forEach((pack, index) => {
        sections.push(...this.buildPackSection(pack, index));
        
        if (index < validPacks.length - 1) {
          sections.push('', '-'.repeat(30), '');
        }
      });
    }

    sections.push('', '═'.repeat(30), t('statusBar.clickInstructions'));
    return sections.join('\n');
  }

  private buildPackSection(pack: EntitlementPack, index: number): string[] {
    const sections: string[] = [];
    const { usage, entitlement_base_info } = pack;
    const { quota } = entitlement_base_info;
    
    const statusText = pack.status === 1 ? t('tooltip.packActive') : t('tooltip.packInactive');
    sections.push(
      t('tooltip.packTitle', { index: (index + 1).toString(), status: statusText }),
      t('tooltip.packExpireTime', { time: formatTimestamp(entitlement_base_info.end_time) }),
      ''
    );

    const usageTypes = [
      { 
        name: t('serviceTypes.premiumFastRequest'),
        icon: '⚡',
        used: usage.premium_model_fast_request_usage,
        limit: quota.premium_model_fast_request_limit
      },
      {
        name: t('serviceTypes.premiumSlowRequest'),
        icon: '🐌',
        used: usage.premium_model_slow_request_usage,
        limit: quota.premium_model_slow_request_limit
      },
      {
        name: t('serviceTypes.autoCompletion'),
        icon: '🔧',
        used: usage.auto_completion_usage,
        limit: quota.auto_completion_limit
      },
      {
        name: t('serviceTypes.advancedModel'),
        icon: '🚀',
        used: usage.advanced_model_request_usage,
        limit: quota.advanced_model_request_limit
      }
    ];

    usageTypes.forEach(type => {
      if (type.limit !== 0) {
        const limitText = type.limit === -1 ? '∞' : type.limit.toString();
        sections.push(`${type.icon} ${type.name}: ${type.used}/${limitText}`);
      }
    });

    if (usage.is_flash_consuming) {
      sections.push(t('tooltip.flashConsuming'));
    }

    return sections;
  }

  // ==================== API 调用 ====================
  private async getTokenFromSession(sessionId: string, retryCount = 0): Promise<string | null> {
    if (this.cachedToken && this.cachedSessionId === sessionId) {
      logWithTime('使用缓存的Token');
      return this.cachedToken;
    }

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

      logWithTime('获取Token成功');
      this.cachedToken = response.data.Result.Token;
      this.cachedSessionId = sessionId;
      return this.cachedToken;
    } catch (error) {
      return this.handleTokenError(error, sessionId, retryCount, currentHost);
    }
  }

  private async handleTokenError(error: any, sessionId: string, retryCount: number, currentHost: string): Promise<string | null> {
    logWithTime(`获取Token失败 (尝试 ${retryCount + 1}/${MAX_RETRY_COUNT}): ${error}`);
    
    if (this.isTokenError(error) && currentHost === DEFAULT_HOST) {
      logWithTime(`检测到错误代码${TOKEN_ERROR_CODE}，尝试切换到备用主机`);
      await this.setHost(FALLBACK_HOST);
      return this.getTokenFromSession(sessionId, 0);
    }
    
    if (this.isRetryableError(error) && retryCount < MAX_RETRY_COUNT) {
      logWithTime(`Token获取失败，将在1秒后进行第${retryCount + 1}次重试`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return this.getTokenFromSession(sessionId, retryCount + 1);
    }
    
    return null;
  }

  private isTokenError(error: any): boolean {
    return error?.response?.data?.ResponseMetadata?.Error?.Code === TOKEN_ERROR_CODE;
  }

  async fetchUsageData(retryCount = 0): Promise<void> {
    try {
      const sessionId = this.getSessionId();
      if (!sessionId) {
        this.handleNoSessionId();
        return;
      }

      const authToken = await this.getTokenFromSession(sessionId);
      if (!authToken) {
        this.handleNoToken();
        return;
      }

      const response = await this.callUsageApi(authToken);
      this.handleApiResponse(response.data);
    } catch (error) {
      this.handleFetchError(error, retryCount);
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

  private async setHost(host: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('traeUsage');
    await config.update('host', host, vscode.ConfigurationTarget.Global);
    logWithTime(`主机地址已更新为: ${host}`);
  }

  private async callUsageApi(authToken: string) {
    const currentHost = this.getHost();
    return axios.post(
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
  }

  private async handleApiResponse(data: ApiResponse): Promise<void> {
    this.usageData = data;
    logWithTime('获取使用量数据成功');
    
    if (this.usageData?.code === 1001) {
      this.handleTokenExpired();
    }

    // 更新WebSocket心跳数据
    await this.webSocketManager.updateHeartbeatData(data);

    this.updateStatusBar();
    this.resetRefreshState();
  }

  private handleTokenExpired(): void {
    logWithTime('Token已失效(code: 1001)，清除缓存');
    this.clearCache();
    
    if (this.isManualRefresh) {
      this.showAuthExpiredMessage();
    }
  }

  private resetRefreshState(): void {
    this.isManualRefresh = false;
    this.isRefreshing = false;
  }

  // ==================== 错误处理 ====================
  private handleNoSessionId(): void {
    if (this.isManualRefresh) {
      this.showSetSessionMessage();
      this.resetRefreshState();
      this.updateStatusBar();
    }
    this.isManualRefresh = false;
  }

  private handleNoToken(): void {
    if (this.isManualRefresh) {
      this.showTokenErrorMessage();
      this.resetRefreshState();
      this.updateStatusBar();
    }
    this.isManualRefresh = false;
  }

  private handleFetchError(error: any, retryCount: number): void {
    logWithTime(`获取使用量数据失败 (尝试 ${retryCount + 1}/${MAX_RETRY_COUNT}): ${error}`);
    
    if (this.isManualRefresh) {
      if (this.isRetryableError(error)) {
        vscode.window.showErrorMessage(t('messages.networkUnstable'));
      } else {
        this.showFetchErrorMessage(error);
      }
      this.resetRefreshState();
      this.updateStatusBar();
      return;
    }
    
    if (retryCount < MAX_RETRY_COUNT) {
      this.scheduleRetry(retryCount);
    } else {
      logWithTime('API调用失败，已达到最大重试次数，停止重试');
    }
  }

  private scheduleRetry(retryCount: number): void {
    logWithTime(`API调用失败，将在1秒后进行第${retryCount + 1}次重试`);
    this.retryTimer = setTimeout(() => {
      this.fetchUsageData(retryCount + 1);
    }, RETRY_DELAY);
  }

  private isRetryableError(error: any): boolean {
    return error && (
      error.code === 'ECONNABORTED' || 
      error.message?.includes('timeout') ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNRESET'
    );
  }

  // ==================== 消息显示 ====================
  private showSetSessionMessage(): void {
    vscode.window.showWarningMessage(
      t('messages.pleaseSetSessionId'), 
      t('messages.setSessionId')
    ).then(selection => {
      if (selection === t('messages.setSessionId')) {
        vscode.commands.executeCommand('traeUsage.updateSession');
      }
    });
  }

  private showTokenErrorMessage(): void {
    vscode.window.showErrorMessage(
      t('messages.cannotGetToken'), 
      t('messages.updateSessionId')
    ).then(selection => {
      if (selection === t('messages.updateSessionId')) {
        vscode.commands.executeCommand('traeUsage.updateSession');
      }
    });
  }

  private showAuthExpiredMessage(): void {
    vscode.window.showErrorMessage(
      t('messages.authenticationExpired'), 
      t('messages.updateSessionId')
    ).then(selection => {
      if (selection === t('messages.updateSessionId')) {
        vscode.commands.executeCommand('traeUsage.updateSession');
      }
    });
  }

  private showFetchErrorMessage(error: any): void {
    vscode.window.showErrorMessage(
      t('messages.getUsageDataFailed', { error: error?.toString() || 'Unknown error' })
    );
  }

  // ==================== 自动刷新 ====================
  public startAutoRefresh(): void {
    const config = vscode.workspace.getConfiguration('traeUsage');
    const intervalSeconds = config.get<number>('refreshInterval', 300);
    const intervalMilliseconds = intervalSeconds * 1000;
    
    this.clearRefreshTimer();

    const maxInterval = 2147483647;
    const safeInterval = Math.min(intervalMilliseconds, maxInterval);

    this.refreshTimer = setInterval(() => {
      this.fetchUsageData();
    }, safeInterval);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ==================== WebSocket配置更新 ====================
  public updateWebSocketConfig(): void {
    this.webSocketManager.updateConfig();
  }

  // ==================== 清理 ====================
  dispose(): void {
    this.clearRefreshTimer();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.clearClickTimer();
    if (this.statusBarItem) {
      this.statusBarItem.dispose();
    }
    this.webSocketManager.dispose();
    if (outputChannel) {
      outputChannel.dispose();
    }
  }
}

// ==================== 剪贴板监控 ====================
class ClipboardMonitor {
  private lastNotifiedSessionId: string | null = null;

  async checkForSession(): Promise<void> {
    try {
      const clipboardText = await vscode.env.clipboard.readText();
      const sessionMatch = clipboardText.match(/X-Cloudide-Session=([^\s;]+)/);
      
      if (sessionMatch?.[1]) {
        await this.handleSessionDetected(sessionMatch[1]);
      }
    } catch (error) {
      logWithTime(`剪贴板检测失败: ${error}`);
    }
  }

  private async handleSessionDetected(sessionId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('traeUsage');
    const currentSessionId = config.get<string>('sessionId');
    
    if (sessionId !== currentSessionId) {
      await this.promptUpdateSession(sessionId, config);
      this.lastNotifiedSessionId = null;
    } else if (this.lastNotifiedSessionId !== sessionId) {
      this.notifySameSession(sessionId);
      this.lastNotifiedSessionId = sessionId;
    }
  }

  private async promptUpdateSession(sessionId: string, config: vscode.WorkspaceConfiguration): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      t('messages.clipboardSessionDetected', { sessionId: sessionId.substring(0, 20) }),
      t('messages.confirmUpdate'),
      t('messages.cancel')
    );
    
    if (choice === t('messages.confirmUpdate')) {
      await config.update('sessionId', sessionId, vscode.ConfigurationTarget.Global);
      await config.update('host', DEFAULT_HOST, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(t('messages.sessionIdAutoUpdated'));
      vscode.commands.executeCommand('traeUsage.refresh');
    }
  }

  private notifySameSession(sessionId: string): void {
    vscode.window.showInformationMessage(
      t('messages.sameSessionIdDetected', { sessionId: sessionId.substring(0, 20) })
    );
  }
}

// ==================== 扩展激活 ====================
export function activate(context: vscode.ExtensionContext) {
  initializeI18n();
  
  const provider = new TraeUsageProvider(context);
  const clipboardMonitor = new ClipboardMonitor();

  registerCommands(context, provider);
  registerListeners(context, provider, clipboardMonitor);
  
  context.subscriptions.push(provider);
}

function registerCommands(context: vscode.ExtensionContext, provider: TraeUsageProvider): void {
  const commands = [
    vscode.commands.registerCommand('traeUsage.handleStatusBarClick', () => {
      provider.handleStatusBarClick();
    }),
    vscode.commands.registerCommand('traeUsage.refresh', () => {
      provider.refresh();
    }),
    vscode.commands.registerCommand('traeUsage.updateSession', async () => {
      await showUpdateSessionDialog();
    })
  ];
  
  context.subscriptions.push(...commands);
}

function registerListeners(context: vscode.ExtensionContext, provider: TraeUsageProvider, clipboardMonitor: ClipboardMonitor): void {
  const windowStateListener = vscode.window.onDidChangeWindowState(async (e) => {
    if (e.focused) {
      setTimeout(() => clipboardMonitor.checkForSession(), 500);
    }
  });

  const configListener = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('traeUsage.refreshInterval')) {
      provider.startAutoRefresh();
    }
    if (e.affectsConfiguration('traeUsage.language')) {
      initializeI18n();
      provider.fetchUsageData();
    }
    if (e.affectsConfiguration('traeUsage.websocketUrl') || e.affectsConfiguration('traeUsage.enableWebsocket')) {
      provider.updateWebSocketConfig();
    }
  });

  context.subscriptions.push(windowStateListener, configListener);
}

async function showUpdateSessionDialog(): Promise<void> {
  const defaultBrowser = await detectDefaultBrowser();
  logWithTime(`更新Session时检测到默认浏览器: ${defaultBrowser}`);
  
  const extensionUrl = getBrowserExtensionUrl(defaultBrowser);
  
  const choice = await vscode.window.showInformationMessage(
    t('messages.sessionConfigurationMessage'),
    t('messages.visitOfficialUsagePage'),
    t('messages.installBrowserExtension')
  );
  
  if (choice === t('messages.visitOfficialUsagePage')) {
    vscode.env.openExternal(vscode.Uri.parse('https://www.trae.ai/account-setting#usage'));
  } else if (choice === t('messages.installBrowserExtension')) {
    vscode.env.openExternal(vscode.Uri.parse(extensionUrl));
  }
}

function getBrowserExtensionUrl(browserType: BrowserType): string {
  return browserType === 'edge' 
    ? 'https://microsoftedge.microsoft.com/addons/detail/trae-usage-token-extracto/leopdblngeedggognlgokdlfpiojalji'
    : 'https://chromewebstore.google.com/detail/edkpaodbjadikhahggapfilgmfijjhei';
}

// ==================== 类型定义补充 ====================
interface UsageStats {
  totalUsage: number;
  totalLimit: number;
  hasValidPacks: boolean;
}

export function deactivate() {}
