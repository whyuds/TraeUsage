import * as vscode from 'vscode';
import axios from 'axios';

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
    this.startAutoRefresh();
    this.fetchUsageData();
  }

  refresh(): void {
    this.isManualRefresh = true;
    this.fetchUsageData();
  }

  getTreeItem(element: UsageItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: UsageItem): Thenable<UsageItem[]> {
    const config = vscode.workspace.getConfiguration('traeUsage');
    const authToken = config.get<string>('authToken');
    
    if (!authToken) {
      return Promise.resolve([
        new UsageItem('⚠️ 未配置Token', '点击设置Token', vscode.TreeItemCollapsibleState.None, {
          command: 'traeUsage.updateToken',
          title: '设置Token'
        })
      ]);
    }
    
    if (!this.usageData) {
      return Promise.resolve([new UsageItem('正在加载...', '', vscode.TreeItemCollapsibleState.None)]);
    }

    if (this.usageData.code === 1001) {
      return Promise.resolve([
        new UsageItem('❌ 认证失效', '请更新Token', vscode.TreeItemCollapsibleState.None, {
          command: 'traeUsage.updateToken',
          title: '更新Token'
        })
      ]);
    }

    if (!element) {
      // 根节点
      const items: UsageItem[] = [];
      
      // 显示所有订阅包
      const allPacks = this.usageData.user_entitlement_pack_list;
      
      if (allPacks.length === 0) {
        items.push(new UsageItem('无订阅包', '', vscode.TreeItemCollapsibleState.None));
        return Promise.resolve(items);
      }

      allPacks.forEach((pack, index) => {
        const usage = pack.usage;
        const quota = pack.entitlement_base_info.quota;
        const statusText = pack.status === 1 ? '活跃' : pack.status === 0 ? '未激活' : '未知状态';
        const statusIcon = pack.status === 1 ? '🟢' : '🔴';
        const expireDate = this.formatTimestamp(pack.entitlement_base_info.end_time);
        const tooltip = `Expire at ${expireDate}`;
        
        items.push(new UsageItem(
          `${statusIcon} 订阅包 ${index + 1}`,
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
      const tooltip = `Expire at ${expireDate}`;
      const items: UsageItem[] = [];

      // Premium Fast Request
      if (quota.premium_model_fast_request_limit !== 0) {
        const used = usage.premium_model_fast_request_usage;
        const remaining = quota.premium_model_fast_request_limit === -1 ? '∞' : (quota.premium_model_fast_request_limit - used).toString();
        
        items.push(new UsageItem(
          `⚡ ${used} / ${remaining === '∞' ? '∞' : quota.premium_model_fast_request_limit}`,
          'Premium Fast Request',
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
          'Premium Slow Request',
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
          'Auto Completion',
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
          'Advanced Model',
          vscode.TreeItemCollapsibleState.None,
          undefined,
          undefined,
          tooltip
        ));
      }

      if (usage.is_flash_consuming) {
        items.push(new UsageItem(
          '⚡ Flash消费中',
          '',
          vscode.TreeItemCollapsibleState.None
        ));
      }

      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }

  private async getTokenFromSession(sessionId: string): Promise<string | null> {
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
          timeout: 10000
        }
      );

      return response.data.Result.Token;
    } catch (error) {
      console.error('获取Token失败:', error);
      return null;
    }
  }

  private async fetchUsageData(retryCount: number = 0): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('traeUsage');
      const sessionId = config.get<string>('sessionId');

      if (!sessionId) {
        if (this.isManualRefresh) {
          vscode.window.showWarningMessage('请先设置Trae AI Session ID', '设置Session ID').then(selection => {
            if (selection === '设置Session ID') {
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
          vscode.window.showErrorMessage('无法获取Token，请检查Session ID是否正确', '更新Session ID').then(selection => {
            if (selection === '更新Session ID') {
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
          timeout: 10000
        }
      );

      this.usageData = response.data;
      
      if (this.usageData?.code === 1001) {
        if (this.isManualRefresh) {
          vscode.window.showErrorMessage('Trae AI认证已失效，请更新Session ID', '更新Session ID').then(selection => {
            if (selection === '更新Session ID') {
              vscode.commands.executeCommand('traeUsage.updateSession');
            }
          });
        }
      }

      this._onDidChangeTreeData.fire();
      this.isManualRefresh = false;
    } catch (error) {
      console.error('获取使用量数据失败:', error);
      
      // 检查是否为超时错误
      const isTimeoutError = error && ((error as any).code === 'ECONNABORTED' || (error as any).message?.includes('timeout'));
      
      // 如果是手动刷新失败，只有非超时错误才通知用户
      if (this.isManualRefresh) {
        if (!isTimeoutError) {
          vscode.window.showErrorMessage(`获取使用量数据失败: ${error}`);
        }
        this.isManualRefresh = false;
        return;
      }
      
      // 后台自动重试逻辑，最多重试2次
      if (retryCount < 2) {
        console.log(`API调用失败，将在10秒后进行第${retryCount + 1}次重试`);
        this.retryTimer = setTimeout(() => {
          this.fetchUsageData(retryCount + 1);
        }, 10000);
      } else {
        console.log('API调用失败，已达到最大重试次数，停止重试');
      }
    }
  }

  private startAutoRefresh(): void {
    const config = vscode.workspace.getConfiguration('traeUsage');
    const intervalMinutes = config.get<number>('refreshInterval', 5);
    
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    this.refreshTimer = setInterval(() => {
      this.fetchUsageData();
    }, intervalMinutes * 60 * 1000);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
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
            `检测到剪贴板中的Session ID:\n${sessionId.substring(0, 20)}...\n\n是否更新为新的Session ID？`,
            '确认更新',
            '取消'
          );
          
          if (choice === '确认更新') {
            await config.update('sessionId', sessionId, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('Session ID已自动更新');
            provider.refresh();
          }
        } else {
          // 如果Session ID相同，提示用户识别到相同的Session ID
          vscode.window.showInformationMessage(
            `识别到相同的Session ID:\n${sessionId.substring(0, 20)}...\n\n不会进行更新`
          );
        }
      }
    } catch (error) {
      // 静默处理错误，避免干扰用户
      console.log('剪贴板检测失败:', error);
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

  // 注册刷新命令
  const refreshCommand = vscode.commands.registerCommand('traeUsage.refresh', () => {
    provider.refresh();
    vscode.window.showInformationMessage('使用量数据已刷新');
  });

  // 注册更新Session ID命令
  const updateSessionCommand = vscode.commands.registerCommand('traeUsage.updateSession', async () => {
    const config = vscode.workspace.getConfiguration('traeUsage');
    const currentSessionId = config.get<string>('sessionId');
    
    // 如果已经设置过session，提示跳转到官网usage页面
    if (currentSessionId) {
      const choice = await vscode.window.showInformationMessage(
        '已设置Session ID。失效可通过已安装Trae Usage浏览器扩展，访问官网获取最新Session ID。',
        '访问官网Usage页面',
        '重新设置Session ID'
      );
      
      if (choice === '访问官网Usage页面') {
        vscode.env.openExternal(vscode.Uri.parse('https://www.trae.ai/account-setting#usage'));
        return;
      }
      
      if (choice === '重新设置Session ID') {
        // 继续执行下面的设置流程
      } else {
        return;
      }
    }
    
    // 未设置session或选择重新设置时，提供扩展下载选项
    const choice = await vscode.window.showInformationMessage(
      '请先安装Trae Usage浏览器扩展获取Session ID，安装后访问官网会自动获取。返回VSCode时会自动识别剪贴板中的Session ID。',
      '安装Chrome扩展',
      '安装Edge扩展'
    );
    
    if (choice === '安装Chrome扩展') {
      vscode.env.openExternal(vscode.Uri.parse('https://chromewebstore.google.com/detail/edkpaodbjadikhahggapfilgmfijjhei?utm_source=item-share-cb'));
      return;
    }
    
    if (choice === '安装Edge扩展') {
      vscode.env.openExternal(vscode.Uri.parse('https://microsoftedge.microsoft.com/addons/detail/trae-usage-monitor/your-edge-extension-id'));
      return;
    }
  });

  context.subscriptions.push(refreshCommand, updateSessionCommand, provider, windowStateListener);
}

export function deactivate() {}