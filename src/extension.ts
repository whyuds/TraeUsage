import * as vscode from "vscode";
import * as os from "os";
import * as cp from "child_process";
import { initializeI18n, t } from "./i18n";
import { UsageDetailCollector } from "./usageCollector";
import { UsageDashboardGenerator } from "./dashboardGenerator";
import {
  disposeOutputChannel,
  getOutputChannel,
  logWithTime,
  formatTimestamp,
} from "./utils";
import { getApiService } from "./apiService";
import { ApiResponse, EntitlementPack, UsageData, QuotaData } from "./types";

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

type BrowserType = "chrome" | "edge" | "unknown";

// ==================== 常量定义 ====================
// 常量定义
const DOUBLE_CLICK_DELAY = 300;
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 1000;

// ==================== 浏览器检测 ====================
async function detectDefaultBrowser(): Promise<BrowserType> {
  const platform = os.platform();

  try {
    const command = getBrowserDetectionCommand(platform);
    if (!command) return "unknown";

    return new Promise((resolve) => {
      cp.exec(command, (error, stdout) => {
        if (error) {
          logWithTime(`检测浏览器失败: ${error.message}`);
          resolve("unknown");
          return;
        }

        const browserType = parseBrowserOutput(stdout.toLowerCase());
        resolve(browserType);
      });
    });
  } catch (error) {
    logWithTime(`检测浏览器异常: ${error}`);
    return "unknown";
  }
}

function getBrowserDetectionCommand(platform: string): string | null {
  switch (platform) {
    case "win32":
      return 'reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId';
    case "darwin":
      return 'defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers | grep -A 2 -B 2 "LSHandlerURLScheme.*http"';
    case "linux":
      return "xdg-settings get default-web-browser";
    default:
      return null;
  }
}

function parseBrowserOutput(output: string): BrowserType {
  if (output.includes("chrome")) return "chrome";
  if (output.includes("edge") || output.includes("msedge")) return "edge";
  return "unknown";
}

// ==================== 主类 ====================
export class TraeUsageProvider {
  private usageData: ApiResponse | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private clickTimer: NodeJS.Timeout | null = null;
  private statusBarItem: vscode.StatusBarItem;
  private apiService = getApiService();
  private clickCount = 0;
  private isRefreshing = false;
  private isManualRefresh = false;
  private isAuthFailed = false; // 新增：标识认证失败状态
  private usageDetailCollector: UsageDetailCollector;
  private usageDashboardGenerator: UsageDashboardGenerator;

  constructor(private context: vscode.ExtensionContext) {
    this.statusBarItem = this.createStatusBarItem();
    this.usageDetailCollector = new UsageDetailCollector(context);
    this.usageDashboardGenerator = new UsageDashboardGenerator(context);

    this.initialize();
  }

  public collectUsageDetails(): void {
    this.usageDetailCollector.collectUsageDetails();
  }

  public async showUsageDashboard(): Promise<void> {
    await this.usageDashboardGenerator.showDashboard();
  }

  public showOutput(): void {
    const outputChannel = getOutputChannel();
    outputChannel.show();
  }

  private createStatusBarItem(): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    item.command = "traeUsage.handleStatusBarClick";
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
      vscode.commands.executeCommand("traeUsage.updateSession");
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
    this.isAuthFailed = false; // 清除认证失败状态
    this.setLoadingState();
    this.clearCache();
    this.fetchUsageData();
    // 同时执行收集数据的方法
    this.collectUsageDetails();
  }

  private setLoadingState(): void {
    this.statusBarItem.text = t("statusBar.loading");
    this.statusBarItem.tooltip = t("statusBar.refreshing");
    this.statusBarItem.color = undefined;
  }

  private clearCache(): void {
    this.apiService.clearCache();
  }

  // ==================== 状态栏更新 ====================
  private updateStatusBar(): void {
    // 如果正在刷新或认证失败，显示相应状态
    if (this.isRefreshing) {
      this.setLoadingState();
      return;
    }

    if (this.isAuthFailed) {
      this.showAuthFailedStatus();
      return;
    }

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
    this.statusBarItem.text = t("statusBar.notConfigured");
    this.statusBarItem.color = undefined;
    this.statusBarItem.tooltip = `${t(
      "statusBar.clickToConfigureSession"
    )}\n\n${t("statusBar.clickInstructions")}`;
  }

  private showAuthFailedStatus(): void {
    this.statusBarItem.text = "⚠️ 认证失败";
    this.statusBarItem.color = "#ff6b6b"; // 红色提示
    this.statusBarItem.tooltip = `认证失败：Session ID可能无效或已过期\n请点击状态栏重新配置Session ID\n\n${t(
      "statusBar.clickInstructions"
    )}`;
  }

  private showUsageStatus(stats: UsageStats): void {
    // 找到活跃的订阅包（有基础额度的）
    const activePack = this.usageData?.user_entitlement_pack_list.find(pack => 
      pack.entitlement_base_info.quota.basic_usage_limit > 0 && pack.status === 1
    );

    if (activePack) {
      const basicUsed = activePack.usage.basic_usage_amount;
      const basicLimit = activePack.entitlement_base_info.quota.basic_usage_limit;
      const bonusUsed = activePack.usage.bonus_usage_amount;
      const bonusLimit = activePack.entitlement_base_info.quota.bonus_usage_limit;
      
      // 获取订阅类型名称
      const subscriptionType = TraeUsageProvider.getSubscriptionTypeLabel(activePack);
      
      // 构建状态栏文本
      let statusText = `⚡ ${subscriptionType}: `;
      
      if (basicUsed < basicLimit) {
        // 基础额度未用完
        statusText += `Basic: ${basicUsed.toFixed(2)}/${basicLimit}`;
      } else {
        // 基础额度已用完，显示基础和奖励额度
        statusText += `Basic: ${basicUsed.toFixed(2)}/${basicLimit} + Bonus: ${bonusUsed.toFixed(2)}`;
      }
      
      this.statusBarItem.text = statusText;
      this.statusBarItem.color = undefined;
      this.statusBarItem.tooltip = this.buildDetailedTooltip();
    } else {
      // 没有活跃的订阅包
      this.showNoActiveSubscriptionStatus();
    }
  }

  private showNoActiveSubscriptionStatus(): void {
    this.statusBarItem.text = t("statusBar.noActiveSubscription");
    this.statusBarItem.color = undefined;
    this.statusBarItem.tooltip = `${t(
      "statusBar.noActiveSubscriptionTooltip"
    )}\n\n${t("statusBar.clickInstructions")}`;
  }

  // ==================== 使用量统计 ====================
  private hasValidUsageData(pack: EntitlementPack): boolean {
    return TraeUsageProvider.hasValidUsageData(pack);
  }

  private calculateUsageStats(): UsageStats {
    let totalUsage = 0;
    let totalLimit = 0;
    let hasValidPacks = false;

    if (!this.usageData) {
      return { totalUsage, totalLimit, hasValidPacks };
    }

    this.usageData.user_entitlement_pack_list.forEach((pack) => {
      // 计算Token使用量（basic_usage + bonus_usage）
      const usage = pack.usage.basic_usage_amount + pack.usage.bonus_usage_amount;
      // 计算总限额（basic_usage_limit + bonus_usage_limit）
      const limit = pack.entitlement_base_info.quota.basic_usage_limit + pack.entitlement_base_info.quota.bonus_usage_limit;

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
    return TraeUsageProvider.buildTooltipFromData(this.usageData, new Date());
  }

  // 可测试的静态方法：根据数据构建 tooltip
  public static buildTooltipFromData(
    usageData: ApiResponse | null,
    currentTime?: Date
  ): string {
    if (!usageData || usageData.code === 1001) {
      return `${t("statusBar.clickToConfigureSession")}\n\n${t(
        "statusBar.clickInstructions"
      )}`;
    }

    const sections: string[] = [];
    const validPacks = TraeUsageProvider.getValidPacks(
      usageData.user_entitlement_pack_list
    );

    if (validPacks.length === 0) {
      sections.push(t("tooltip.noValidPacks"));
    } else {
      const packSections = TraeUsageProvider.buildPackSections(validPacks);
      sections.push(...packSections);
    }

    // 添加更新时间
    const timeSection = TraeUsageProvider.buildTimeSection(currentTime);
    sections.push("");
    sections.push(timeSection);

    return sections.join("\n");
  }

  // 获取有效的订阅包
  public static getValidPacks(packList: EntitlementPack[]): EntitlementPack[] {
    return packList.filter((pack) => TraeUsageProvider.hasValidUsageData(pack));
  }

  // 构建订阅包信息段落
  public static buildPackSections(validPacks: EntitlementPack[]): string[] {
    const sections: string[] = [];

    validPacks.forEach((pack, index) => {
      const { usage, entitlement_base_info } = pack;
      const { quota } = entitlement_base_info;

      // 获取订阅类型标识
      const subscriptionType = TraeUsageProvider.getSubscriptionTypeLabel(pack);

      // 显示订阅包标题
      const header = `${subscriptionType} ${usage.is_flash_consuming ? '(Consuming)' : ''}  Expire: ${formatTimestamp(
        entitlement_base_info.end_time
      )}`;
      sections.push(header);

      // 显示基础额度
      const basicUsed = usage.basic_usage_amount;
      const basicLimit = quota.basic_usage_limit;
      sections.push(`Basic: $${basicUsed.toFixed(2)} / $${basicLimit.toFixed(2)}`);
      
      // 构建基础额度进度条
      const basicProgressInfo = TraeUsageProvider.buildProgressBar(
        basicUsed,
        basicLimit
      );
      // 使用▒符号表示基础额度进度
      let basicProgressBar = basicProgressInfo.progressBar.replace(/█/g, "▒");
      
      // 调试：显示计算过程
      console.log(`Pack: ${subscriptionType}`);
      console.log(`Basic Used: ${basicUsed}, Basic Limit: ${basicLimit}`);
      console.log(`Filled Length: ${Math.round((basicUsed / basicLimit) * 25)}`);
      console.log(`Progress Bar: [${basicProgressBar}]`);
      
      // 如果有基础额度且基础额度已用完，显示组合进度条
      if (pack.entitlement_base_info.quota.basic_usage_limit > 0 && basicUsed >= basicLimit) {
        const bonusUsed = usage.bonus_usage_amount;
        const bonusLimit = quota.bonus_usage_limit;
        sections.push(`Bonus: +$${bonusUsed.toFixed(2)}`);
        
        // 构建组合进度条：根据总使用量的百分比显示
        if (bonusUsed > 0) {
          // 对于动态奖励额度，使用总使用量作为参考
          const totalUsed = basicUsed + bonusUsed;
          const progressBarLength = 25;
          
          // 计算基础部分的长度（固定为基础额度占比）
          const basicPercentage = basicUsed / totalUsed;
          const bonusPercentage = bonusUsed / totalUsed;
          const basicLength = Math.round(basicPercentage * progressBarLength);
          const bonusLength = Math.max(1, Math.round(bonusPercentage * progressBarLength)); // 至少显示1个字符
          
          // 确保总长度不超过进度条长度
          const totalLength = basicLength + bonusLength;
          const adjustLength = totalLength - progressBarLength;
          let finalBasicLength = basicLength;
          let finalBonusLength = bonusLength;
          
          if (adjustLength > 0) {
            // 调整长度，优先减少奖励部分
            finalBonusLength = Math.max(1, bonusLength - adjustLength);
          }
          
          // 构建组合进度条：基础额度（▒） + 空格 + 奖励额度（█）
          const basicPart = "▒".repeat(finalBasicLength);
          const bonusPart = "█".repeat(finalBonusLength);
          const combinedProgressBar = `${basicPart} ${bonusPart}`;
          
          sections.push(`[${combinedProgressBar}]`);
          // 调试：显示组合进度条
          console.log(`Total Used: ${totalUsed}`);
          console.log(`Basic Length: ${finalBasicLength}, Bonus Length: ${finalBonusLength}`);
          console.log(`Combined Progress Bar: [${combinedProgressBar}]`);
        } else {
          // 只有基础额度进度条
          sections.push(`[${basicProgressBar}]`);
        }
      } else {
        // 非Pro计划或基础额度未用完，只显示基础额度进度条
        sections.push(`[${basicProgressBar}]`);
      }

      // 如果不是最后一个订阅，添加分隔线
      if (index < validPacks.length - 1) {
        sections.push("");
      }
    });

    return sections;
  }

  // 构建进度条
  public static buildProgressBar(
    used: number,
    limit: number
  ): { progressBar: string; percentage: number } {
    const percentage = Math.min(100, Math.round((used / limit) * 100));
    const progressBarLength = 25;
    const filledLength = Math.min(progressBarLength, Math.round((used / limit) * progressBarLength));
    const progressBar =
      "█".repeat(filledLength) + "░".repeat(progressBarLength - filledLength);

    return { progressBar, percentage };
  }

  // 构建时间信息段落
  public static buildTimeSection(currentTime?: Date): string {
    const now = currentTime || new Date();
    const updateTime = now
      .toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
      .replace(/\/(\d{2})\/(\d{2})/, "$1/$2")
      .replace(/, /, " ");

    return `${" ".repeat(50)}🕐 ${updateTime}`;
  }

  // 检查订阅包是否有有效的使用数据
  public static hasValidUsageData(pack: EntitlementPack): boolean {
    const { quota } = pack.entitlement_base_info;
    return (
      quota.basic_usage_limit > 0 ||
      quota.bonus_usage_limit > 0 ||
      quota.premium_model_fast_request_limit > 0 ||
      quota.premium_model_slow_request_limit > 0 ||
      quota.auto_completion_limit > 0 ||
      quota.advanced_model_request_limit > 0
    );
  }

  // 获取订阅类型标签
  public static getSubscriptionTypeLabel(pack: EntitlementPack): string {
    const { entitlement_base_info } = pack;

    // 根据product_type判断订阅类型
    if (entitlement_base_info.product_type !== undefined) {
      const productType = entitlement_base_info.product_type;
      switch (productType) {
        case 1:
          return "Pro Plan";
        case 2:
          return "Extra Package";
        default:
          return "Unknown";
      }
    }

    // 如果没有product_type，根据其他特征判断
    const { quota } = entitlement_base_info;
    if (quota.premium_model_fast_request_limit === -1) {
      return "Unlimited";
    } else if (quota.premium_model_fast_request_limit > 1000) {
      return "Premium";
    } else {
      return "Basic";
    }
  }

  // ==================== API 调用 ====================
  private async getTokenFromSession(
    sessionId: string,
    retryCount = 0
  ): Promise<string | null> {
    return this.apiService.getTokenFromSession(
      sessionId,
      retryCount,
      this.isManualRefresh
    );
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

      const responseData = await this.callUsageApi(authToken);
      await this.handleApiResponse(responseData);
    } catch (error) {
      this.handleFetchError(error, retryCount);
    }
  }

  private getSessionId(): string | undefined {
    const config = vscode.workspace.getConfiguration("traeUsage");
    return config.get<string>("sessionId");
  }

  private async callUsageApi(authToken: string) {
    return this.apiService.getUserEntitlementList(authToken);
  }

  private async handleApiResponse(data: ApiResponse): Promise<void> {
    this.usageData = data;
    this.isAuthFailed = false; // 清除认证失败状态
    logWithTime("更新使用量数据");

    // 使用apiService的统一错误处理
    if (!this.apiService.isApiResponseSuccess(data)) {
      this.apiService.handleApiResponseError(data, "获取使用量数据");
      if (data?.code === 1001) {
        this.handleTokenExpired();
      }
    }

    this.resetRefreshState();
    this.updateStatusBar();
  }

  private handleTokenExpired(): void {
    logWithTime("Token已失效(code: 1001)，清除缓存");
    this.isAuthFailed = true; // 设置认证失败状态
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
    this.isAuthFailed = false; // 清除认证失败状态
    if (this.isManualRefresh) {
      this.showSetSessionMessage();
      this.resetRefreshState();
      this.updateStatusBar();
    }
    this.isManualRefresh = false;
  }

  private handleNoToken(): void {
    this.isAuthFailed = true; // 设置认证失败状态
    this.resetRefreshState();
    this.updateStatusBar();

    if (this.isManualRefresh) {
      // 手动刷新时显示更新Session对话框
      showUpdateSessionDialog();
    }
    this.isManualRefresh = false;
  }

  private handleFetchError(error: any, retryCount: number): void {
    logWithTime(
      `获取使用量数据失败 (尝试 ${retryCount + 1}/${MAX_RETRY_COUNT}): ${error}`
    );

    // 处理401认证失败情况
    if (error.response?.status === 401) {
      this.isAuthFailed = true;
      this.resetRefreshState();
      this.updateStatusBar();

      if (this.isManualRefresh) {
        vscode.window
          .showErrorMessage(
            "认证失败：Session ID可能无效或已过期，请更新Session ID",
            "更新Session ID"
          )
          .then((selection) => {
            if (selection === "更新Session ID") {
              vscode.commands.executeCommand("traeUsage.updateSession");
            }
          });
      } else {
        // 自动刷新时显示错误提示，但不阻塞流程
        vscode.window.showErrorMessage(
          "Trae Usage: 认证失败，请手动更新Session ID"
        );
      }
      return;
    }

    if (this.isManualRefresh) {
      if (this.apiService.isRetryableError(error)) {
        vscode.window.showErrorMessage(t("messages.networkUnstable"));
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
      logWithTime("API调用失败，已达到最大重试次数，停止重试");
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
    vscode.window
      .showWarningMessage(
        t("messages.pleaseSetSessionId"),
        t("messages.setSessionId")
      )
      .then((selection) => {
        if (selection === t("messages.setSessionId")) {
          vscode.commands.executeCommand("traeUsage.updateSession");
        }
      });
  }

  private showTokenErrorMessage(): void {
    vscode.window
      .showErrorMessage(
        t("messages.cannotGetToken"),
        t("messages.updateSessionId")
      )
      .then((selection) => {
        if (selection === t("messages.updateSessionId")) {
          vscode.commands.executeCommand("traeUsage.updateSession");
        }
      });
  }

  private showAuthExpiredMessage(): void {
    vscode.window
      .showErrorMessage(
        t("messages.authenticationExpired"),
        t("messages.updateSessionId")
      )
      .then((selection) => {
        if (selection === t("messages.updateSessionId")) {
          vscode.commands.executeCommand("traeUsage.updateSession");
        }
      });
  }

  private showFetchErrorMessage(error: any): void {
    vscode.window.showErrorMessage(
      t("messages.getUsageDataFailed", {
        error: error?.toString() || "Unknown error",
      })
    );
  }

  // ==================== 自动刷新 ====================
  public startAutoRefresh(): void {
    this.clearRefreshTimer();

    const config = vscode.workspace.getConfiguration("traeUsage");
    const intervalSeconds = config.get<number>("refreshInterval", 300);
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
    const config = vscode.workspace.getConfiguration("traeUsage");
    const currentSessionId = config.get<string>("sessionId");

    if (sessionId !== currentSessionId) {
      await this.promptUpdateSession(sessionId, config);
      this.lastNotifiedSessionId = null;
    } else if (this.lastNotifiedSessionId !== sessionId) {
      this.notifySameSession(sessionId);
      this.lastNotifiedSessionId = sessionId;
    }
  }

  private async promptUpdateSession(
    sessionId: string,
    config: vscode.WorkspaceConfiguration
  ): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      t("messages.clipboardSessionDetected", {
        sessionId: sessionId.substring(0, 20),
      }),
      t("messages.confirmUpdate"),
      t("messages.cancel")
    );

    if (choice === t("messages.confirmUpdate")) {
      await config.update(
        "sessionId",
        sessionId,
        vscode.ConfigurationTarget.Global
      );
      await getApiService().resetToDefaultHost();
      vscode.window.showInformationMessage(t("messages.sessionIdAutoUpdated"));
      vscode.commands.executeCommand("traeUsage.refresh");
    }
  }

  private notifySameSession(sessionId: string): void {
    vscode.window.showInformationMessage(
      t("messages.sameSessionIdDetected", {
        sessionId: sessionId.substring(0, 20),
      })
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

function registerCommands(
  context: vscode.ExtensionContext,
  provider: TraeUsageProvider
): void {
  const commands = [
    vscode.commands.registerCommand("traeUsage.handleStatusBarClick", () => {
      provider.handleStatusBarClick();
    }),
    vscode.commands.registerCommand("traeUsage.refresh", () => {
      provider.refresh();
    }),
    vscode.commands.registerCommand("traeUsage.updateSession", async () => {
      await showUpdateSessionDialog();
    }),
    vscode.commands.registerCommand("traeUsage.collectUsageDetails", () => {
      provider.collectUsageDetails();
    }),
    vscode.commands.registerCommand("traeUsage.showUsageDashboard", () => {
      provider.showUsageDashboard();
    }),
    vscode.commands.registerCommand("traeUsage.showOutput", () => {
      provider.showOutput();
    }),
  ];

  context.subscriptions.push(...commands);
}

function registerListeners(
  context: vscode.ExtensionContext,
  provider: TraeUsageProvider,
  clipboardMonitor: ClipboardMonitor
): void {
  const windowStateListener = vscode.window.onDidChangeWindowState(
    async (e) => {
      if (e.focused) {
        setTimeout(() => clipboardMonitor.checkForSession(), 500);
      }
    }
  );

  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("traeUsage.refreshInterval")) {
      provider.startAutoRefresh();
    }
    if (e.affectsConfiguration("traeUsage.language")) {
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
    t("messages.sessionConfigurationMessage"),
    t("messages.visitOfficialUsagePage"),
    t("messages.installBrowserExtension")
  );

  if (choice === t("messages.visitOfficialUsagePage")) {
    vscode.env.openExternal(
      vscode.Uri.parse("https://www.trae.ai/account-setting#usage")
    );
  } else if (choice === t("messages.installBrowserExtension")) {
    vscode.env.openExternal(vscode.Uri.parse(extensionUrl));
  }
}

function getBrowserExtensionUrl(browserType: BrowserType): string {
  return browserType === "edge"
    ? "https://microsoftedge.microsoft.com/addons/detail/trae-usage-token-extracto/leopdblngeedggognlgokdlfpiojalji"
    : "https://chromewebstore.google.com/detail/edkpaodbjadikhahggapfilgmfijjhei";
}

// ==================== 类型定义补充 ====================
interface UsageStats {
  totalUsage: number;
  totalLimit: number;
  hasValidPacks: boolean;
}

export function deactivate() {}
