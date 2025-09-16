import * as vscode from 'vscode';
import axios from 'axios';
import { logWithTime } from './utils';
import { TokenResponse } from './extension';
import { t } from './i18n';
import { UsageDetailResponse } from './types';

// 常量定义
const DEFAULT_HOST = 'https://api-sg-central.trae.ai';
const FALLBACK_HOST = 'https://api-us-east.trae.ai';
const API_TIMEOUT = 3000;
const MAX_RETRY_COUNT = 5;
const RETRY_DELAY = 1000;
const TOKEN_ERROR_CODE = '20310';

/**
 * 统一的API服务类，管理GetUserToken接口调用
 */
export class ApiService {
  private static instance: ApiService;
  private cachedToken: string | null = null;
  private cachedSessionId: string | null = null;
  private hasSwitchedHost: boolean = false;
  private currentHost: string = DEFAULT_HOST;

  private constructor() {}

  public static getInstance(): ApiService {
    if (!ApiService.instance) {
      ApiService.instance = new ApiService();
    }
    return ApiService.instance;
  }

  /**
   * 获取用户Token（带缓存功能）
   * @param sessionId 会话ID
   * @param retryCount 重试次数
   * @returns Promise<string | null>
   */
  public async getTokenFromSession(sessionId: string, retryCount = 0): Promise<string | null> {
    // 检查缓存
    if (this.cachedToken && this.cachedSessionId === sessionId) {
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

      logWithTime('更新Token');
      this.cachedToken = response.data.Result.Token;
      this.cachedSessionId = sessionId;
      return this.cachedToken;
    } catch (error) {
      return this.handleTokenError(error, sessionId, retryCount, currentHost);
    }
  }

  /**
   * 获取用户Token（带重试机制，无缓存）
   * @param sessionId 会话ID
   * @param maxRetries 最大重试次数
   * @returns Promise<string | null>
   */
  public async getTokenWithRetry(sessionId: string, maxRetries: number = MAX_RETRY_COUNT): Promise<string | null> {
    return this.apiRequestWithRetry(async () => {
      const currentHost = this.getHost();
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
    }, '获取认证Token', maxRetries);
  }

  /**
   * 清除缓存的Token
   */
  public clearCache(): void {
    this.cachedToken = null;
    this.cachedSessionId = null;
    this.hasSwitchedHost = false;
    this.currentHost = DEFAULT_HOST;
  }

  /**
   * 处理Token获取错误
   */
  private async handleTokenError(
    error: any, 
    sessionId: string, 
    retryCount: number, 
    currentHost: string
  ): Promise<string | null> {
    logWithTime(`获取Token失败 (尝试 ${retryCount + 1}/${MAX_RETRY_COUNT}): ${error.code}, ${error.message}`);
    
    // 核心修改：处理Token错误（支持双向切换主机）
    if (this.isTokenError(error)) {
      if (!this.hasSwitchedHost) {
        // 未切换过主机：切换到另一个主机（默认 ↔ 备用互切）
        const otherHost = currentHost === DEFAULT_HOST ? FALLBACK_HOST : DEFAULT_HOST;
        logWithTime(`检测到错误代码${TOKEN_ERROR_CODE}，尝试切换到备用主机: ${otherHost}`);
        await this.setHost(otherHost); // 切换到另一个主机
        this.hasSwitchedHost = true; // 标记为已切换
        return this.getTokenFromSession(sessionId, 0); // 重置重试次数，重试获取Token
      } else {
        // 已切换过主机仍失败：通知用户无法获取Token
        vscode.window.showErrorMessage(t('messages.cannotGetToken'));
        return null;
      }
    }
    
    // 原有可重试错误逻辑（不变）
    if (this.isRetryableError(error) && retryCount < MAX_RETRY_COUNT) {
      logWithTime(`Token获取失败，将在1秒后进行第${retryCount + 1}次重试`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return this.getTokenFromSession(sessionId, retryCount + 1);
    }
    
    // 重试后网络仍有问题（不变）
    if (this.isRetryableError(error) && retryCount >= MAX_RETRY_COUNT) {
      vscode.window.showErrorMessage(t('messages.networkUnstable'));
    }
    
    return null;
  }



  /**
   * 带重试机制的通用API请求函数
   */
  private async apiRequestWithRetry<T>(
    requestFn: () => Promise<T>,
    operationName: string,
    maxRetries: number = MAX_RETRY_COUNT
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

  /**
   * 检查是否是Token错误
   */
  private isTokenError(error: any): boolean {
    return error?.response?.data?.ResponseMetadata?.Error?.Code === TOKEN_ERROR_CODE;
  }

  /**
   * 检查是否是可重试的错误
   */
  public isRetryableError(error: any): boolean {
    return error && (
      error.code === 'ECONNABORTED' || 
      error.message?.includes('timeout') ||
      error.code === 'ENOTFOUND' ||
      error.code === 'ECONNRESET' ||
      error.message?.includes('Failed to establish a socket connection to proxies') ||
      error.message?.includes('proxy')
    );
  }

  /**
   * 统一的错误处理方法
   * @param error 错误对象
   * @param operationName 操作名称
   * @param showUserMessage 是否显示用户消息
   */
  public handleApiError(error: any, operationName: string, showUserMessage: boolean = false): void {
    const errorMessage = `${operationName}失败: ${String(error)}`;
    logWithTime(errorMessage);
    
    if (showUserMessage) {
      if (this.isRetryableError(error)) {
        vscode.window.showErrorMessage(t('messages.networkUnstable'));
      } else if (this.isTokenError(error)) {
        vscode.window.showErrorMessage(t('messages.cannotGetToken'));
      } else {
        vscode.window.showErrorMessage(`${operationName}失败，请稍后重试`);
      }
    }
  }

  /**
   * 检查API响应是否成功
   * @param response API响应
   * @returns boolean
   */
  public isApiResponseSuccess(response: any): boolean {
    return response && (!response.code || response.code === 0);
  }

  /**
   * 处理API响应错误
   * @param response API响应
   * @param operationName 操作名称
   */
  public handleApiResponseError(response: any, operationName: string): void {
    if (response?.code === 1001) {
      logWithTime(`${operationName}: Token已失效(code: 1001)`);
      this.clearCache();
      vscode.window.showErrorMessage(t('messages.tokenExpired'));
    } else if (response?.code) {
      logWithTime(`${operationName}: API返回错误码 ${response.code}, 消息: ${response.message || 'Unknown error'}`);
      vscode.window.showErrorMessage(`${operationName}失败: ${response.message || 'Unknown error'}`);
    }
  }

  /**
   * 获取当前主机地址
   */
  private getHost(): string {
    return this.currentHost;
  }

  /**
   * 设置主机地址
   */
  public async setHost(host: string): Promise<void> {
    this.currentHost = host;
    logWithTime(`主机地址已更新为: ${host}`);
  }

  /**
   * 重置为默认主机地址
   */
  public async resetToDefaultHost(): Promise<void> {
    this.hasSwitchedHost = false;
    await this.setHost(DEFAULT_HOST);
  }

  /**
   * 获取用户当前权益列表
   * @param authToken 认证Token
   * @returns Promise<any | null>
   */
  public async getUserEntitlementList(authToken: string): Promise<any | null> {
    try {
      const result = await this.apiRequestWithRetry(async () => {
        const currentHost = this.getHost();
        const response = await axios.post(
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

        return response.data;
      }, '获取用户权益列表');

      return result;
    } catch (error) {
      logWithTime(`获取用户权益列表失败: ${error}`);
      throw error;
    }
  }

  /**
   * 获取订阅时间范围
   * @param authToken 认证Token
   * @returns Promise<{ start_time: number; end_time: number } | null>
   */
  public async getSubscriptionTimeRange(authToken: string): Promise<{ start_time: number; end_time: number } | null> {
    try {
      const result = await this.getUserEntitlementList(authToken);
      
      if (result?.user_entitlement_pack_list?.length > 0) {
        const pack = result.user_entitlement_pack_list[0];
        return {
          start_time: pack.entitlement_base_info.start_time,
          end_time: pack.entitlement_base_info.end_time
        };
      }
      
      throw new Error('No entitlement pack found');
    } catch (error) {
      logWithTime(`获取订阅时间范围失败: ${error}`);
      return null;
    }
  }

  /**
   * 查询用户使用详情（按会话分组）
   * @param authToken 认证Token
   * @param start_time 开始时间
   * @param end_time 结束时间
   * @param pageNum 页码
   * @param pageSize 页大小
   * @returns Promise<UsageDetailResponse | null>
   */
  public async queryUserUsageGroupBySession(
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

        logWithTime(`请求第${pageNum}页使用详情数据: ${url}`);

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
      logWithTime(`获取第${pageNum}页使用详情失败: ${error}`);
      return null;
    }
  }
}

/**
 * 获取API服务实例的便捷函数
 */
export function getApiService(): ApiService {
  return ApiService.getInstance();
}