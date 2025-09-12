import * as vscode from 'vscode';

// 语言类型定义
export type Language = 'zh-CN' | 'en';

// 翻译键类型定义
export interface Translations {
  // 状态栏相关
  statusBar: {
    notConfigured: string;
    clickToConfigureSession: string;
    noActiveSubscription: string;
    noActiveSubscriptionTooltip: string;
    remaining: string;
    used: string;
    totalQuota: string;
    usageRate: string;
    expireTime: string;
  };
  
  // 树视图相关
  treeView: {
    notConfiguredSessionId: string;
    pleaseConfigureSessionId: string;
    configurationGuide: string;
    installBrowserExtension: string;
    chromeExtension: string;
    clickToInstallChrome: string;
    edgeExtension: string;
    clickToInstallEdge: string;
    loading: string;
    authenticationExpired: string;
    pleaseUpdateSessionId: string;
    noSubscriptionPack: string;
    subscriptionPack: string;
    active: string;
    inactive: string;
    unknownStatus: string;
    flashConsuming: string;
    expireAt: string;
  };
  
  // 命令相关
  commands: {
    refreshUsageData: string;
    setSessionId: string;
    updateSessionId: string;
    refreshUsageDataTitle: string;
    usageDataRefreshed: string;
  };
  
  // 消息提示相关
  messages: {
    pleaseSetSessionId: string;
    setSessionId: string;
    cannotGetToken: string;
    checkSessionIdCorrect: string;
    updateSessionId: string;
    authenticationExpired: string;
    pleaseUpdateSessionId: string;
    getUsageDataFailed: string;
    sessionIdAlreadySet: string;
    sessionIdExpiredMessage: string;
    visitOfficialUsagePage: string;
    resetSessionId: string;
    pleaseInstallExtensionFirst: string;
    installChromeExtension: string;
    installEdgeExtension: string;
    clipboardSessionDetected: string;
    confirmUpdate: string;
    cancel: string;
    sessionIdAutoUpdated: string;
    sameSessionIdDetected: string;
    noUpdateNeeded: string;
  };
  
  // 配置相关
  configuration: {
    title: string;
    sessionIdDescription: string;
    refreshIntervalDescription: string;
  };
  
  // 服务类型相关
  serviceTypes: {
    premiumFastRequest: string;
    premiumSlowRequest: string;
    autoCompletion: string;
    advancedModel: string;
  };
  
  // 使用量收集器相关
  usageCollector: {
    alreadyCollecting: string;
    pleaseSetSessionId: string;
    cannotGetToken: string;
    cannotGetSubscription: string;
    loadExistingDataSuccess: string;
    createNewDataFile: string;
    cannotGetUsageDetails: string;
    startCollecting: string;
    collectingPage: string;
    userCancelled: string;
    collectedPage: string;
    collectionComplete: string;
    collectionCompleteMessage: string;
    viewDashboard: string;
    collectionError: string;
    requestPageData: string;
    fetchPageFailed: string;
    dataSaved: string;
    saveDataFailed: string;
    saveDataError: string;
    getTokenFailed: string;
    getSubscriptionFailed: string;
  };
}

// 当前语言
let currentLanguage: Language = 'zh-CN';

// 翻译数据存储
let translations: Record<Language, Translations> = {} as any;

/**
 * 初始化国际化系统
 */
export function initializeI18n(): void {
  // 获取VS Code的语言设置
  const vscodeLanguage = vscode.env.language;
  
  // 根据VS Code语言设置确定默认语言
  if (vscodeLanguage.startsWith('zh')) {
    currentLanguage = 'zh-CN';
  } else {
    currentLanguage = 'en';
  }
  
  // 加载翻译文件
  loadTranslations();
}

/**
 * 加载翻译文件
 */
function loadTranslations(): void {
  try {
    // 动态导入翻译文件
    translations['zh-CN'] = require('./locales/zh-CN.json');
    translations['en'] = require('./locales/en.json');
  } catch (error) {
    console.error('Failed to load translations:', error);
    // 如果加载失败，使用默认的中文翻译
    currentLanguage = 'zh-CN';
  }
}

/**
 * 获取翻译文本
 * @param key 翻译键路径，如 'statusBar.notConfigured'
 * @param params 参数对象，用于替换占位符
 * @returns 翻译后的文本
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const keys = key.split('.');
  let value: any = translations[currentLanguage];
  
  // 遍历键路径获取翻译值
  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      // 如果找不到翻译，尝试使用中文作为后备
      if (currentLanguage !== 'zh-CN') {
        value = translations['zh-CN'];
        for (const fallbackKey of keys) {
          if (value && typeof value === 'object' && fallbackKey in value) {
            value = value[fallbackKey];
          } else {
            value = key; // 最后的后备方案：返回键本身
            break;
          }
        }
      } else {
        value = key; // 返回键本身作为后备
      }
      break;
    }
  }
  
  // 如果value不是字符串，返回键本身
  if (typeof value !== 'string') {
    return key;
  }
  
  // 替换参数占位符
  if (params) {
    return value.replace(/\{(\w+)\}/g, (match, paramKey) => {
      return params[paramKey]?.toString() || match;
    });
  }
  
  return value;
}

/**
 * 设置当前语言
 * @param language 语言代码
 */
export function setLanguage(language: Language): void {
  currentLanguage = language;
}

/**
 * 获取当前语言
 * @returns 当前语言代码
 */
export function getCurrentLanguage(): Language {
  return currentLanguage;
}

/**
 * 获取支持的语言列表
 * @returns 支持的语言代码数组
 */
export function getSupportedLanguages(): Language[] {
  return ['zh-CN', 'en'];
}