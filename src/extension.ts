import * as vscode from 'vscode';
import axios from 'axios';
import { initializeI18n, t } from './i18n';

// 全局日志函数
function logWithTime(message: string): void {
  const now = new Date();
  const timestamp = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  console.log(`[${timestamp}] ${message}`);
}

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

class TraeUsageProvider implements vscode.TreeDataProvider<UsageItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<UsageItem | undefined | null | void> = new vscode.EventEmitter<UsageItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<UsageItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private usageData: ApiResponse | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private isManualRefresh: boolean = false;
  private statusBarItem: vscode.StatusBarItem;
  private cachedToken: string | null = null;
  private cachedSessionId: string | null = null;

  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(/\//g, '/');
  }

  constructor(private context: vscode.ExtensionContext) {
    // 创建状态栏项
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = 'traeUsage.refresh';
    this.statusBarItem.show();
    this.updateStatusBar();
    
    this.startAutoRefresh();
    this.fetchUsageData();
  }

  refresh(): void {
    this.isManualRefresh = true;
    // 手动刷新时清除token缓存，确保获取最新数据
    this.cachedToken = null;
    this.cachedSessionId = null;
    this.fetchUsageData();
  }

  private updateStatusBar(): void {
    if (!this.usageData || this.usageData.code === 1001) {
      this.statusBarItem.text = t('statusBar.notConfigured');
      this.statusBarItem.tooltip = t('statusBar.clickToConfigureSession');
      return;
    }

    // 计算所有订阅包的Premium Fast Request总数据
    let totalUsage = 0;
    let totalLimit = 0;
    let hasValidPacks = false;
    const packDetails: string[] = [];

    this.usageData.user_entitlement_pack_list.forEach((pack, index) => {
      const usage = pack.usage.premium_model_fast_request_usage;
      const limit = pack.entitlement_base_info.quota.premium_model_fast_request_limit;
      
      if (limit > 0) {
        totalUsage += usage;
        totalLimit += limit;
        hasValidPacks = true;
        
        const expireDate = this.formatTimestamp(pack.entitlement_base_info.end_time);
        const status = pack.status === 1 ? t('treeView.active') : t('treeView.inactive');
        packDetails.push(`${t('treeView.subscriptionPack', { index: (index + 1).toString() })} (${status}): ${usage}/${limit} - ${t('statusBar.expireTime', { time: expireDate })}`);
      }
    });

    if (hasValidPacks) {
      const remaining = totalLimit - totalUsage;
      const percentage = totalLimit > 0 ? Math.round((totalUsage / totalLimit) * 100) : 0;
      
      this.statusBarItem.text = `$(zap) Fast: ${totalUsage}/${totalLimit} (${t('statusBar.remaining', { remaining: remaining.toString() })})`;
      this.statusBarItem.tooltip = `${t('serviceTypes.premiumFastRequest')} (${t('statusBar.totalQuota', { total: 'All Subscriptions' })})\n${t('statusBar.used', { used: totalUsage.toString() })}\n${t('statusBar.totalQuota', { total: totalLimit.toString() })}\n${t('statusBar.remaining', { remaining: remaining.toString() })}\n${t('statusBar.usageRate', { rate: percentage.toString() })}\n\n${packDetails.join('\n')}`;
    } else {
      this.statusBarItem.text = t('statusBar.noActiveSubscription');
      this.statusBarItem.tooltip = t('statusBar.noActiveSubscriptionTooltip');
    }
  }

  getTreeItem(element: UsageItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: UsageItem): Thenable<UsageItem[]> {
    const config = vscode.workspace.getConfiguration('traeUsage');
    const sessionId = config.get<string>('sessionId');
    
    if (!sessionId) {
      return Promise.resolve([
        new UsageItem(t('treeView.notConfiguredSessionId'), t('treeView.pleaseConfigureSessionId'), vscode.TreeItemCollapsibleState.None, {
          command: 'traeUsage.updateSession',
          title: t('commands.setSessionId')
        }),
        new UsageItem(t('treeView.configurationGuide'), t('treeView.installBrowserExtension'), vscode.TreeItemCollapsibleState.None),
        new UsageItem(t('treeView.chromeExtension'), t('treeView.clickToInstallChrome'), vscode.TreeItemCollapsibleState.None, {
          command: 'vscode.open',
          title: t('commands.setSessionId'),
          arguments: [vscode.Uri.parse('https://chromewebstore.google.com/detail/trae-ai-session-extractor/eejeaklkdnkdlcfnpbkdlbpbkdlbpbkd')]
        }),
        new UsageItem(t('treeView.edgeExtension'), t('treeView.clickToInstallEdge'), vscode.TreeItemCollapsibleState.None, {
          command: 'vscode.open',
          title: t('commands.setSessionId'),
          arguments: [vscode.Uri.parse('https://microsoftedge.microsoft.com/addons/detail/trae-ai-session-extractor/abcdefghijklmnopqrstuvwxyz123456')]
        })
      ]);
    }
    
    if (!this.usageData) {
      return Promise.resolve([new UsageItem(t('treeView.loading'), '', vscode.TreeItemCollapsibleState.None)]);
    }

    if (this.usageData.code === 1001) {
      return Promise.resolve([
        new UsageItem(t('treeView.authenticationExpired'), t('treeView.pleaseUpdateSessionId'), vscode.TreeItemCollapsibleState.None, {
          command: 'traeUsage.updateSession',
          title: t('commands.updateSessionId')
        })
      ]);
    }

    if (!element) {
      // 根节点
      const items: UsageItem[] = [];
      
      // 显示所有订阅包
      const allPacks = this.usageData.user_entitlement_pack_list;
      
      if (allPacks.length === 0) {
        items.push(new UsageItem(t('treeView.noSubscriptionPack'), '', vscode.TreeItemCollapsibleState.None));
        return Promise.resolve(items);
      }

      allPacks.forEach((pack, index) => {
        const usage = pack.usage;
        const quota = pack.entitlement_base_info.quota;
        const statusText = pack.status === 1 ? t('treeView.active') : pack.status === 0 ? t('treeView.inactive') : t('treeView.unknownStatus');
        const statusIcon = pack.status === 1 ? '🟢' : '🔴';
        const expireDate = this.formatTimestamp(pack.entitlement_base_info.end_time);
        const tooltip = t('treeView.expireAt', { time: expireDate });
        
        items.push(new UsageItem(
          `${statusIcon} ${t('treeView.subscriptionPack', { index: (index + 1).toString() })}`,
          statusText,
          vscode.TreeItemCollapsibleState.Expanded,
          undefined,
          `pack-${index}`,
          tooltip
        ));
      });

      return Promise.resolve(items);
    } else if (element.contextValue?.startsWith('pack-')) {
      // 订阅包详情
      const packIndex = parseInt(element.contextValue.split('-')[1]);
      const pack = this.usageData.user_entitlement_pack_list[packIndex];
      
      if (!pack) {
        return Promise.resolve([]);
      }

      const usage = pack.usage;
      const quota = pack.entitlement_base_info.quota;
      const expireDate = this.formatTimestamp(pack.entitlement_base_info.end_time);
      const tooltip = t('treeView.expireAt', { time: expireDate });
      const items: UsageItem[] = [];

      // Premium Fast Request
      if (quota.premium_model_fast_request_limit !== 0) {
        const used = usage.premium_model_fast_request_usage;
        const remaining = quota.premium_model_fast_request_limit === -1 ? '∞' : (quota.premium_model_fast_request_limit - used).toString();
        
        items.push(new UsageItem(
          `⚡ ${used} / ${remaining === '∞' ? '∞' : quota.premium_model_fast_request_limit}`,
          t('serviceTypes.premiumFastRequest'),
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          tooltip
        ));
      }

      // Premium Slow Request
      if (quota.premium_model_slow_request_limit !== 0) {
        const used = usage.premium_model_slow_request_usage;
        const remaining = quota.premium_model_slow_request_limit === -1 ? '∞' : (quota.premium_model_slow_request_limit - used).toString();
        
        items.push(new UsageItem(
          `🐌 ${used} / ${remaining === '∞' ? '∞' : quota.premium_model_slow_request_limit}`,
          t('serviceTypes.premiumSlowRequest'),
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          tooltip
        ));
      }

      // Auto Completion
      if (quota.auto_completion_limit !== 0) {
        const used = usage.auto_completion_usage;
        const remaining = quota.auto_completion_limit === -1 ? '∞' : (quota.auto_completion_limit - used).toString();
        
        items.push(new UsageItem(
          `🔧 ${used} / ${remaining === '∞' ? '∞' : quota.auto_completion_limit}`,
          t('serviceTypes.autoCompletion'),
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          tooltip
        ));
      }

      // Advanced Model
      if (quota.advanced_model_request_limit !== 0) {
        const used = usage.advanced_model_request_usage;
        const remaining = quota.advanced_model_request_limit === -1 ? '∞' : (quota.advanced_model_request_limit - used).toString();
        
        items.push(new UsageItem(
          `🚀 ${used} / ${remaining === '∞' ? '∞' : quota.advanced_model_request_limit}`,
          t('serviceTypes.advancedModel'),
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          tooltip
        ));
      }

      if (usage.is_flash_consuming) {
        items.push(new UsageItem(
          t('treeView.flashConsuming'),
          '',
          vscode.TreeItemCollapsibleState.None
        ));
      }

      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }

  private async getTokenFromSession(sessionId: string, retryCount: number = 0): Promise<string | null> {
    // 如果sessionId相同且已有缓存的token，直接返回缓存的token
    if (this.cachedToken && this.cachedSessionId === sessionId) {
      logWithTime('使用缓存的Token');
      return this.cachedToken;
    }

    try {
      const response = await axios.post<TokenResponse>(
        'https://api-sg-central.trae.ai/cloudide/api/v3/common/GetUserToken',
        {},
        {
          headers: {
            'Cookie': `X-Cloudide-Session=${sessionId}`,
            'Host': 'api-sg-central.trae.ai',
            'Content-Type': 'application/json'
          },
          timeout: 3000
        }
      );

      logWithTime('获取Token成功');
      // 缓存token和sessionId
      this.cachedToken = response.data.Result.Token;
      this.cachedSessionId = sessionId;
      return response.data.Result.Token;
    } catch (error) {
      logWithTime(`获取Token失败 (尝试 ${retryCount + 1}/5): ${error}`);
      
      // 检查是否为超时错误或网络错误
      const isRetryableError = error && (
        (error as any).code === 'ECONNABORTED' || 
        (error as any).message?.includes('timeout') ||
        (error as any).code === 'ENOTFOUND' ||
        (error as any).code === 'ECONNRESET'
      );
      
      // 如果是可重试的错误且未达到最大重试次数，则进行重试
      if (isRetryableError && retryCount < 5) {
        logWithTime(`Token获取失败，将在1秒后进行第${retryCount + 1}次重试`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.getTokenFromSession(sessionId, retryCount + 1);
      }
      
      return null;
    }
  }

  private async fetchUsageData(retryCount: number = 0): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('traeUsage');
      const sessionId = config.get<string>('sessionId');

      if (!sessionId) {
        if (this.isManualRefresh) {
          vscode.window.showWarningMessage(t('messages.pleaseSetSessionId'), t('messages.setSessionId')).then(selection => {
            if (selection === t('messages.setSessionId')) {
              vscode.commands.executeCommand('traeUsage.updateSession');
            }
          });
        }
        this.isManualRefresh = false;
        return;
      }

      // 通过Session ID获取Token
      const authToken = await this.getTokenFromSession(sessionId);
      if (!authToken) {
        if (this.isManualRefresh) {
          vscode.window.showErrorMessage(t('messages.cannotGetToken'), t('messages.updateSessionId')).then(selection => {
            if (selection === t('messages.updateSessionId')) {
              vscode.commands.executeCommand('traeUsage.updateSession');
            }
          });
        }
        this.isManualRefresh = false;
        return;
      }



      const response = await axios.post(
        'https://api-sg-central.trae.ai/trae/api/v1/pay/user_current_entitlement_list',
        {},
        {
          headers: {
            'authorization': `Cloud-IDE-JWT ${authToken}`,
            'Host': 'api-sg-central.trae.ai',
            'Content-Type': 'application/json'
          },
          timeout: 3000
        }
      );

      this.usageData = response.data;
      logWithTime('获取使用量数据成功');
      
      if (this.usageData?.code === 1001) {
        // Token失效，清除缓存
        logWithTime('Token已失效(code: 1001)，清除缓存');
        this.cachedToken = null;
        this.cachedSessionId = null;
        
        if (this.isManualRefresh) {
          vscode.window.showErrorMessage(t('messages.authenticationExpired'), t('messages.updateSessionId')).then(selection => {
            if (selection === t('messages.updateSessionId')) {
              vscode.commands.executeCommand('traeUsage.updateSession');
            }
          });
        }
      }

      this._onDidChangeTreeData.fire();
      this.updateStatusBar();
      this.isManualRefresh = false;
    } catch (error) {
      logWithTime(`获取使用量数据失败 (尝试 ${retryCount + 1}/5): ${error}`);
      
      // 检查是否为超时错误
      const isTimeoutError = error && ((error as any).code === 'ECONNABORTED' || (error as any).message?.includes('timeout'));
      
      // 如果是手动刷新失败，只有非超时错误才通知用户
      if (this.isManualRefresh) {
        if (!isTimeoutError) {
          vscode.window.showErrorMessage(t('messages.getUsageDataFailed', { error: error?.toString() || 'Unknown error' }));
        }
        this.isManualRefresh = false;
        return;
      }
      
      // 后台自动重试逻辑，最多重试5次
      if (retryCount < 5) {
        logWithTime(`API调用失败，将在1秒后进行第${retryCount + 1}次重试`);
        this.retryTimer = setTimeout(() => {
          this.fetchUsageData(retryCount + 1);
        }, 1000);
      } else {
        logWithTime('API调用失败，已达到最大重试次数，停止重试');
      }
    }
  }

  public startAutoRefresh(): void {
    const config = vscode.workspace.getConfiguration('traeUsage');
    const intervalSeconds = config.get<number>('refreshInterval', 300);
    const intervalMilliseconds = intervalSeconds * 1000;
    
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    // 确保间隔时间在32位有符号整数的安全范围内
    const maxInterval = 2147483647;
    const safeInterval = Math.min(intervalMilliseconds, maxInterval);

    this.refreshTimer = setInterval(() => {
      this.fetchUsageData();
    }, safeInterval);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    if (this.statusBarItem) {
      this.statusBarItem.dispose();
    }
  }
}

class UsageItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly contextValue?: string,
    public readonly customTooltip?: string
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.tooltip = customTooltip || `${this.label}: ${this.description}`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  // 初始化国际化系统
  initializeI18n();
  
  const provider = new TraeUsageProvider(context);
  
  // 注册树视图
  vscode.window.createTreeView('traeUsageView', {
    treeDataProvider: provider,
    showCollapseAll: true
  });

  // 剪贴板检测功能
  async function checkClipboardForSession() {
    try {
      const clipboardText = await vscode.env.clipboard.readText();
      const sessionMatch = clipboardText.match(/X-Cloudide-Session=([^\s;]+)/);
      
      if (sessionMatch && sessionMatch[1]) {
        const sessionId = sessionMatch[1];
        const config = vscode.workspace.getConfiguration('traeUsage');
        const currentSessionId = config.get<string>('sessionId');
        
        // 如果检测到的Session ID与当前配置不同，询问用户是否更新
        if (sessionId !== currentSessionId) {
          const choice = await vscode.window.showInformationMessage(
            t('messages.clipboardSessionDetected', { sessionId: sessionId.substring(0, 20) }),
            t('messages.confirmUpdate'),
            t('messages.cancel')
          );
          
          if (choice === t('messages.confirmUpdate')) {
            await config.update('sessionId', sessionId, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(t('messages.sessionIdAutoUpdated'));
            provider.refresh();
          }
        } else {
          // 如果Session ID相同，提示用户识别到相同的Session ID
          vscode.window.showInformationMessage(
            t('messages.sameSessionIdDetected', { sessionId: sessionId.substring(0, 20) })
          );
        }
      }
    } catch (error) {
      // 静默处理错误，避免干扰用户
      logWithTime(`剪贴板检测失败: ${error}`);
    }
  }

  // 监听窗口状态变化
  const windowStateListener = vscode.window.onDidChangeWindowState(async (e) => {
    if (e.focused) {
      // 延迟检测，避免频繁触发
      setTimeout(() => {
        checkClipboardForSession();
      }, 500);
    }
  });

  // 监听配置变化
  const configListener = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('traeUsage.refreshInterval')) {
      provider.startAutoRefresh();
    }
    if (e.affectsConfiguration('traeUsage.language')) {
      initializeI18n();
      provider.refresh();
    }
  });

  // 注册刷新命令
  const refreshCommand = vscode.commands.registerCommand('traeUsage.refresh', () => {
    provider.refresh();
    vscode.window.showInformationMessage(t('commands.usageDataRefreshed'));
  });

  // 注册更新Session ID命令
  const updateSessionCommand = vscode.commands.registerCommand('traeUsage.updateSession', async () => {
    const config = vscode.workspace.getConfiguration('traeUsage');
    const currentSessionId = config.get<string>('sessionId');
    
    // 如果已经设置过session，提示跳转到官网usage页面
    if (currentSessionId) {
      const choice = await vscode.window.showInformationMessage(
        t('messages.sessionIdExpiredMessage'),
        t('messages.visitOfficialUsagePage'),
        t('messages.resetSessionId')
      );
      
      if (choice === t('messages.visitOfficialUsagePage')) {
        vscode.env.openExternal(vscode.Uri.parse('https://www.trae.ai/account-setting#usage'));
        return;
      }
      
      if (choice === t('messages.resetSessionId')) {
        // 继续执行下面的设置流程
      } else {
        return;
      }
    }
    
    // 未设置session或选择重新设置时，提供扩展下载选项
    const choice = await vscode.window.showInformationMessage(
      t('messages.pleaseInstallExtensionFirst'),
      t('messages.installChromeExtension'),
      t('messages.installEdgeExtension')
    );
    
    if (choice === t('messages.installChromeExtension')) {
      vscode.env.openExternal(vscode.Uri.parse('https://chromewebstore.google.com/detail/edkpaodbjadikhahggapfilgmfijjhei'));
      return;
    }
    
    if (choice === t('messages.installEdgeExtension')) {
      vscode.env.openExternal(vscode.Uri.parse('https://microsoftedge.microsoft.com/addons/detail/trae-usage-monitor/your-edge-extension-id'));
      return;
    }
  });

  context.subscriptions.push(refreshCommand, updateSessionCommand, provider, windowStateListener, configListener);
}

export function deactivate() {}