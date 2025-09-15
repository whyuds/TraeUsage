import * as vscode from 'vscode';
import * as os from 'os';
import * as cp from 'child_process';
import axios from 'axios';
import { initializeI18n, t } from './i18n';
import { UsageDetailCollector } from './usageCollector';
import { UsageDashboardGenerator } from './dashboardGenerator';
import { disposeOutputChannel, getOutputChannel, logWithTime, formatTimestamp } from './utils';
import { getApiService } from './apiService';

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

export interface ApiResponse {
  code?: number;
  message?: string;
  is_pay_freshman: boolean;
  user_entitlement_pack_list: EntitlementPack[];
}

export interface TokenResponse {
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

// ==================== 常量定义 ====================
const DEFAULT_HOST = 'https://api-sg-central.trae.ai';
const FALLBACK_HOST = 'https://api-us-east.trae.ai';
const DOUBLE_CLICK_DELAY = 300;
const API_TIMEOUT = 3000;
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 1000;

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

// ==================== 主类 ====================
class TraeUsageProvider {
  private usageData: ApiResponse | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private clickTimer: NodeJS.Timeout | null = null;
  private statusBarItem: vscode.StatusBarItem;
  private apiService = getApiService();
  private clickCount = 0;
  private isRefreshing = false;
  private isManualRefresh = false;
  private usageDetailCollector: UsageDetailCollector;
  private dashboardGenerator: UsageDashboardGenerator;

  constructor(private context: vscode.ExtensionContext) {
    this.statusBarItem = this.createStatusBarItem();
    this.usageDetailCollector = new UsageDetailCollector(context);
    this.dashboardGenerator = new UsageDashboardGenerator(context);
    
    this.initialize();
  }

  public collectUsageDetails(): void {
    this.usageDetailCollector.collectUsageDetails();
  }

  public async showUsageDashboard(): Promise<void> {
    await this.dashboardGenerator.showDashboard();
  }

  public showOutput(): void {
    const outputChannel = getOutputChannel();
    outputChannel.show();
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
    // 同时执行收集数据的方法
    this.collectUsageDetails();
  }

  private setLoadingState(): void {
    this.statusBarItem.text = t('statusBar.loading');
    this.statusBarItem.tooltip = t('statusBar.refreshing');
    this.statusBarItem.color = undefined;
  }

  private clearCache(): void {
    this.apiService.clearCache();
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
    
    this.statusBarItem.text = `⚡ Fast: ${totalUsage}/${totalLimit} (${t('statusBar.remaining', { remaining: remaining.toString() })})`;
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

    const sections: string[] = [];

    const validPacks = this.usageData.user_entitlement_pack_list.filter(pack => 
      this.hasValidUsageData(pack)
    );

    if (validPacks.length === 0) {
      sections.push(t('tooltip.noValidPacks'));
    } else {
      // 只显示第一个有效订阅包的Premium Fast Request信息
      const pack = validPacks[0];
      const { usage, entitlement_base_info } = pack;
      const { quota } = entitlement_base_info;
      
      // 1. Premium Fast Request使用情况(带进度条)
      const fastUsed = usage.premium_model_fast_request_usage;
      const fastLimit = quota.premium_model_fast_request_limit;
      const percentage = Math.round((fastUsed / fastLimit) * 100);
      const progressBarLength = 25;
      const filledLength = Math.round((fastUsed / fastLimit) * progressBarLength);
      const progressBar = '█'.repeat(filledLength) + '░'.repeat(progressBarLength - filledLength);
      sections.push(`Expire: ${formatTimestamp(entitlement_base_info.end_time)} Usage: ${fastUsed}/${fastLimit} `)
      sections.push(`[${progressBar}]`);
      sections.push('');
    }
    
    // 最近更新时间
    const now = new Date();
    const updateTime = now.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(/\/(\d{2})\/(\d{2})/, '$1/$2').replace(/, /, ' ');
    sections.push(`Updated: ${updateTime}`);
    
    return sections.join('\n');
  }

  // ==================== API 调用 ====================
  private async getTokenFromSession(sessionId: string, retryCount = 0): Promise<string | null> {
    return this.apiService.getTokenFromSession(sessionId, retryCount);
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
    logWithTime('更新使用量数据');
    
    if (this.usageData?.code === 1001) {
      this.handleTokenExpired();
    }

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
    this.resetRefreshState();
    this.updateStatusBar();
    
    if (this.isManualRefresh) {
      // 手动刷新时显示更新Session对话框
      showUpdateSessionDialog();
    }
    this.isManualRefresh = false;
  }

  private handleFetchError(error: any, retryCount: number): void {
    logWithTime(`获取使用量数据失败 (尝试 ${retryCount + 1}/${MAX_RETRY_COUNT}): ${error}`);
    
    if (this.isManualRefresh) {
      if (this.apiService.isRetryableError(error)) {
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
      // 达到最大重试次数后，恢复状态栏状态
      this.resetRefreshState();
      this.updateStatusBar();
    }
  }

  private scheduleRetry(retryCount: number): void {
    logWithTime(`API调用失败，将在1秒后进行第${retryCount + 1}次重试`);
    this.retryTimer = setTimeout(() => {
      this.fetchUsageData(retryCount + 1);
    }, RETRY_DELAY);
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
    this.clearRefreshTimer();

    const config = vscode.workspace.getConfiguration('traeUsage');
    const intervalSeconds = config.get<number>('refreshInterval', 300);
    const intervalMilliseconds = intervalSeconds * 1000;
    
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
    disposeOutputChannel();
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
    }),
    vscode.commands.registerCommand('traeUsage.collectUsageDetails', () => {
      provider.collectUsageDetails();
    }),
    vscode.commands.registerCommand('traeUsage.showUsageDashboard', () => {
      provider.showUsageDashboard();
    }),
    vscode.commands.registerCommand('traeUsage.showOutput', () => {
      provider.showOutput();
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
