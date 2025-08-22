import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
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

// 检测默认浏览器类型
async function detectDefaultBrowser(): Promise<'chrome' | 'edge' | 'unknown'> {
  const platform = os.platform();
  
  try {
    if (platform === 'win32') {
      // Windows: 通过注册表查询默认浏览器
      return new Promise((resolve) => {
        cp.exec('reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId', 
          (error, stdout) => {
            if (error) {
              logWithTime(`检测浏览器失败: ${error.message}`);
              resolve('unknown');
              return;
            }
            
            const progId = stdout.toLowerCase();
            if (progId.includes('chrome')) {
              resolve('chrome');
            } else if (progId.includes('edge') || progId.includes('msedge')) {
              resolve('edge');
            } else {
              resolve('unknown');
            }
          });
      });
    } else if (platform === 'darwin') {
      // macOS: 通过系统偏好设置查询
      return new Promise((resolve) => {
        cp.exec('defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers | grep -A 2 -B 2 "LSHandlerURLScheme.*http"', 
          (error, stdout) => {
            if (error) {
              logWithTime(`检测浏览器失败: ${error.message}`);
              resolve('unknown');
              return;
            }
            
            const output = stdout.toLowerCase();
            if (output.includes('chrome')) {
              resolve('chrome');
            } else if (output.includes('edge') || output.includes('msedge')) {
              resolve('edge');
            } else {
              resolve('unknown');
            }
          });
      });
    } else {
      // Linux: 通过环境变量或xdg查询
      return new Promise((resolve) => {
        cp.exec('xdg-settings get default-web-browser', (error, stdout) => {
          if (error) {
            logWithTime(`检测浏览器失败: ${error.message}`);
            resolve('unknown');
            return;
          }
          
          const browser = stdout.toLowerCase();
          if (browser.includes('chrome')) {
            resolve('chrome');
          } else if (browser.includes('edge') || browser.includes('msedge')) {
            resolve('edge');
          } else {
            resolve('unknown');
          }
        });
      });
    }
  } catch (error) {
    logWithTime(`检测浏览器异常: ${error}`);
    return 'unknown';
  }
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

class TraeUsageProvider {

  private usageData: ApiResponse | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private isManualRefresh: boolean = false;
  private statusBarItem: vscode.StatusBarItem;
  private cachedToken: string | null = null;
  private cachedSessionId: string | null = null;
  
  // 单击/双击检测相关
  private clickTimer: NodeJS.Timeout | null = null;
  private clickCount: number = 0;
  private readonly DOUBLE_CLICK_DELAY = 300; // 双击检测延迟 (毫秒)
  
  // Loading 状态相关
  private isRefreshing: boolean = false;

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
    this.statusBarItem.command = 'traeUsage.handleStatusBarClick';  // 使用新的点击处理命令
    this.statusBarItem.show();
    this.updateStatusBar();
    
    this.startAutoRefresh();
    this.fetchUsageData();
  }

  // 处理状态栏点击事件
  handleStatusBarClick(): void {
    // 如果正在刷新，禁用点击
    if (this.isRefreshing) {
      return;
    }
    
    this.clickCount++;
    
    if (this.clickTimer) {
      // 如果已有定时器，说明这是第二次点击（双击）
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
      this.clickCount = 0;
      
      // 执行双击操作：打开设置
      this.openSettings();
    } else {
      // 第一次点击，启动定时器
      this.clickTimer = setTimeout(() => {
        if (this.clickCount === 1) {
          // 单击操作：刷新
          this.refresh();
        }
        this.clickCount = 0;
        this.clickTimer = null;
      }, this.DOUBLE_CLICK_DELAY);
    }
  }

  // 打开设置
  private openSettings(): void {
    vscode.commands.executeCommand('traeUsage.updateSession');
  }

  refresh(): void {
    this.isManualRefresh = true;
    this.isRefreshing = true;
    
    // 设置 loading 状态
    this.setLoadingState();
    
    // 手动刷新时清除token缓存，确保获取最新数据
    this.cachedToken = null;
    this.cachedSessionId = null;
    this.fetchUsageData();
  }

  // 设置 loading 状态
  private setLoadingState(): void {
    this.statusBarItem.text = t('statusBar.loading');
    this.statusBarItem.tooltip = t('statusBar.refreshing');
    this.statusBarItem.color = undefined;
  }

  // 构建详细的 tooltip 信息
  private buildDetailedTooltip(): string {
    if (!this.usageData || this.usageData.code === 1001) {
      return t('statusBar.clickToConfigureSession') + '\n\n' + t('statusBar.clickActions');
    }

    const sections: string[] = [];
    
    // 标题
    sections.push('🚀 Trae AI 使用量详情');
    sections.push('═'.repeat(30));

    // 遍历所有订阅包
    this.usageData.user_entitlement_pack_list.forEach((pack, index) => {
      const usage = pack.usage;
      const quota = pack.entitlement_base_info.quota;
      const statusText = pack.status === 1 ? '🟢 活跃' : '🔴 未激活';
      const expireDate = this.formatTimestamp(pack.entitlement_base_info.end_time);
      
      sections.push(`📦 订阅包 ${index + 1} (${statusText})`);
      sections.push(`⏰ 过期时间: ${expireDate}`);
      sections.push('');

      // Premium Fast Request
      if (quota.premium_model_fast_request_limit !== 0) {
        const used = usage.premium_model_fast_request_usage;
        const limit = quota.premium_model_fast_request_limit;
        const remaining = limit === -1 ? '∞' : (limit - used);
        const percentage = limit === -1 ? 0 : Math.round((used / limit) * 100);
        sections.push(`⚡ Premium Fast Request:`);
        sections.push(`   已使用: ${used} | 总配额: ${limit === -1 ? '∞' : limit} | 剩余: ${remaining}`);
        if (limit !== -1) {
          sections.push(`   使用率: ${percentage}%`);
        }
      }

      // Premium Slow Request
      if (quota.premium_model_slow_request_limit !== 0) {
        const used = usage.premium_model_slow_request_usage;
        const limit = quota.premium_model_slow_request_limit;
        const remaining = limit === -1 ? '∞' : (limit - used);
        const percentage = limit === -1 ? 0 : Math.round((used / limit) * 100);
        sections.push(`🐌 Premium Slow Request:`);
        sections.push(`   已使用: ${used} | 总配额: ${limit === -1 ? '∞' : limit} | 剩余: ${remaining}`);
        if (limit !== -1) {
          sections.push(`   使用率: ${percentage}%`);
        }
      }

      // Auto Completion
      if (quota.auto_completion_limit !== 0) {
        const used = usage.auto_completion_usage;
        const limit = quota.auto_completion_limit;
        const remaining = limit === -1 ? '∞' : (limit - used);
        const percentage = limit === -1 ? 0 : Math.round((used / limit) * 100);
        sections.push(`🔧 Auto Completion:`);
        sections.push(`   已使用: ${used} | 总配额: ${limit === -1 ? '∞' : limit} | 剩余: ${remaining}`);
        if (limit !== -1) {
          sections.push(`   使用率: ${percentage}%`);
        }
      }

      // Advanced Model
      if (quota.advanced_model_request_limit !== 0) {
        const used = usage.advanced_model_request_usage;
        const limit = quota.advanced_model_request_limit;
        const remaining = limit === -1 ? '∞' : (limit - used);
        const percentage = limit === -1 ? 0 : Math.round((used / limit) * 100);
        sections.push(`🚀 Advanced Model:`);
        sections.push(`   已使用: ${used} | 总配额: ${limit === -1 ? '∞' : limit} | 剩余: ${remaining}`);
        if (limit !== -1) {
          sections.push(`   使用率: ${percentage}%`);
        }
      }

      // Flash Consuming 状态
      if (usage.is_flash_consuming) {
        sections.push(`⚡ Flash 消费中`);
      }

      // 订阅包分隔线
      if (this.usageData && index < this.usageData.user_entitlement_pack_list.length - 1) {
        sections.push('');
        sections.push('-'.repeat(30));
        sections.push('');
      }
    });

    // 操作提示
    sections.push('');
    sections.push('═'.repeat(30));
    sections.push(t('statusBar.clickActions'));

    return sections.join('\n');
  }

  private updateStatusBar(): void {
    if (!this.usageData || this.usageData.code === 1001) {
      this.statusBarItem.text = t('statusBar.notConfigured');
      this.statusBarItem.color = undefined;
      this.statusBarItem.tooltip = t('statusBar.clickToConfigureSession') + '\n\n' + t('statusBar.clickActions');
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
      
      // 只为闪电图标部分设置颜色，其余文本保持默认
      const lightningIcon = '⚡';
      const textPart = ` Fast: ${totalUsage}/${totalLimit} (${t('statusBar.remaining', { remaining: remaining.toString() })})`;
      this.statusBarItem.text = lightningIcon + textPart;
      this.statusBarItem.color = undefined;
      // 构建详细的 tooltip 信息
      let detailsTooltip = this.buildDetailedTooltip();
      this.statusBarItem.tooltip = detailsTooltip;
    } else {
      this.statusBarItem.text = t('statusBar.noActiveSubscription');
      this.statusBarItem.color = undefined;
      this.statusBarItem.tooltip = t('statusBar.noActiveSubscriptionTooltip') + '\n\n' + t('statusBar.clickActions');
    }
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

  async fetchUsageData(retryCount: number = 0): Promise<void> {
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
          this.isRefreshing = false;  // 重置 loading 状态
          this.updateStatusBar();  // 恢复正常状态栏显示
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
          this.isRefreshing = false;  // 重置 loading 状态
          this.updateStatusBar();  // 恢复正常状态栏显示
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
          this.isRefreshing = false;  // 重置 loading 状态
        }
      }

      this.updateStatusBar();
      this.isManualRefresh = false;
      this.isRefreshing = false;  // 重置 loading 状态
    } catch (error) {
      logWithTime(`获取使用量数据失败 (尝试 ${retryCount + 1}/5): ${error}`);
      
      // 检查是否为超时错误
      const isTimeoutError = error && ((error as any).code === 'ECONNABORTED' || (error as any).message?.includes('timeout'));
      
      // 如果是手动刷新失败，通知用户并重置状态
      if (this.isManualRefresh) {
        vscode.window.showErrorMessage(t('messages.getUsageDataFailed', { error: error?.toString() || 'Unknown error' }));
        this.isManualRefresh = false;
        this.isRefreshing = false;  // 重置 loading 状态
        this.updateStatusBar();  // 恢复正常状态栏显示
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
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
    }
    if (this.statusBarItem) {
      this.statusBarItem.dispose();
    }
  }
}



export function activate(context: vscode.ExtensionContext) {
  // 初始化国际化系统
  initializeI18n();
  
  const provider = new TraeUsageProvider(context);

  // 记录已经提醒过的相同Session ID，避免重复提醒
  let lastNotifiedSameSessionId: string | null = null;

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
          // 重置已提醒的Session ID，因为检测到了不同的Session ID
          lastNotifiedSameSessionId = null;
        } else {
          // 如果Session ID相同，且之前没有提醒过这个Session ID，则提示用户
          if (lastNotifiedSameSessionId !== sessionId) {
            vscode.window.showInformationMessage(
              t('messages.sameSessionIdDetected', { sessionId: sessionId.substring(0, 20) })
            );
            // 记录已经提醒过的Session ID
            lastNotifiedSameSessionId = sessionId;
          }
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
      // 重新获取数据以更新状态栏显示
      provider.fetchUsageData();
    }
  });

  // 注册状态栏点击处理命令
  const handleStatusBarClickCommand = vscode.commands.registerCommand('traeUsage.handleStatusBarClick', () => {
    provider.handleStatusBarClick();
  });

  // 注册刷新命令
  const refreshCommand = vscode.commands.registerCommand('traeUsage.refresh', () => {
    provider.refresh();
    // 移除成功通知，只在失败时通知用户
  });

  // 注册更新Session ID命令
  const updateSessionCommand = vscode.commands.registerCommand('traeUsage.updateSession', async () => {
    // 检测默认浏览器
    const defaultBrowser = await detectDefaultBrowser();
    logWithTime(`更新Session时检测到默认浏览器: ${defaultBrowser}`);
    
    // 根据默认浏览器设置扩展链接
    let extensionUrl: string;
    if (defaultBrowser === 'edge') {
      extensionUrl = 'https://microsoftedge.microsoft.com/addons/detail/trae-usage-token-extracto/leopdblngeedggognlgokdlfpiojalji';
    } else {
      // Chrome 或未知浏览器默认使用 Chrome 扩展
      extensionUrl = 'https://chromewebstore.google.com/detail/edkpaodbjadikhahggapfilgmfijjhei';
    }
    
    // 显示简化的通知
    const choice = await vscode.window.showInformationMessage(
      t('messages.sessionConfigurationMessage'),
      t('messages.visitOfficialUsagePage'),
      t('messages.installBrowserExtension')
    );
    
    if (choice === t('messages.visitOfficialUsagePage')) {
      vscode.env.openExternal(vscode.Uri.parse('https://www.trae.ai/account-setting#usage'));
      return;
    }
    
    if (choice === t('messages.installBrowserExtension')) {
      vscode.env.openExternal(vscode.Uri.parse(extensionUrl));
      return;
    }
  });

  context.subscriptions.push(handleStatusBarClickCommand, refreshCommand, updateSessionCommand, provider, windowStateListener, configListener);
}

export function deactivate() {}