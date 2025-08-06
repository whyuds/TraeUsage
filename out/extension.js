"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const axios_1 = require("axios");
class TraeUsageProvider {
    constructor(context) {
        this.context = context;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.usageData = null;
        this.refreshTimer = null;
        this.retryTimer = null;
        this.isManualRefresh = false;
        this.startAutoRefresh();
        this.fetchUsageData();
    }
    refresh() {
        this.isManualRefresh = true;
        this.fetchUsageData();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
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
            const items = [];
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
                items.push(new UsageItem(`${statusIcon} 订阅包 ${index + 1}`, statusText, vscode.TreeItemCollapsibleState.Expanded, undefined, `pack-${index}`));
            });
            return Promise.resolve(items);
        }
        else if (element.contextValue?.startsWith('pack-')) {
            // 订阅包详情
            const packIndex = parseInt(element.contextValue.split('-')[1]);
            const pack = this.usageData.user_entitlement_pack_list[packIndex];
            if (!pack) {
                return Promise.resolve([]);
            }
            const usage = pack.usage;
            const quota = pack.entitlement_base_info.quota;
            const items = [];
            // Premium Fast Request
            if (quota.premium_model_fast_request_limit !== 0) {
                const limit = quota.premium_model_fast_request_limit === -1 ? '无限制' : quota.premium_model_fast_request_limit.toString();
                const used = usage.premium_model_fast_request_usage;
                const remaining = quota.premium_model_fast_request_limit === -1 ? '无限制' : (quota.premium_model_fast_request_limit - used).toString();
                items.push(new UsageItem('⚡ Premium Fast Request', `已用: ${used} | 剩余: ${remaining}`, vscode.TreeItemCollapsibleState.None));
            }
            // Premium Slow Request
            if (quota.premium_model_slow_request_limit !== 0) {
                const limit = quota.premium_model_slow_request_limit === -1 ? '无限制' : quota.premium_model_slow_request_limit.toString();
                const used = usage.premium_model_slow_request_usage;
                const remaining = quota.premium_model_slow_request_limit === -1 ? '无限制' : (quota.premium_model_slow_request_limit - used).toString();
                items.push(new UsageItem('🐌 Premium Slow Request', `已用: ${used} | 剩余: ${remaining}`, vscode.TreeItemCollapsibleState.None));
            }
            // Auto Completion
            if (quota.auto_completion_limit !== 0) {
                const limit = quota.auto_completion_limit === -1 ? '无限制' : quota.auto_completion_limit.toString();
                const used = usage.auto_completion_usage;
                const remaining = quota.auto_completion_limit === -1 ? '无限制' : (quota.auto_completion_limit - used).toString();
                items.push(new UsageItem('🔧 Auto Completion', `已用: ${used} | 剩余: ${remaining}`, vscode.TreeItemCollapsibleState.None));
            }
            // Advanced Model
            if (quota.advanced_model_request_limit !== 0) {
                const limit = quota.advanced_model_request_limit === -1 ? '无限制' : quota.advanced_model_request_limit.toString();
                const used = usage.advanced_model_request_usage;
                const remaining = quota.advanced_model_request_limit === -1 ? '无限制' : (quota.advanced_model_request_limit - used).toString();
                items.push(new UsageItem('🚀 Advanced Model', `已用: ${used} | 剩余: ${remaining}`, vscode.TreeItemCollapsibleState.None));
            }
            if (usage.is_flash_consuming) {
                items.push(new UsageItem('⚡ Flash消费中', '', vscode.TreeItemCollapsibleState.None));
            }
            return Promise.resolve(items);
        }
        return Promise.resolve([]);
    }
    async fetchUsageData(retryCount = 0) {
        try {
            const config = vscode.workspace.getConfiguration('traeUsage');
            const authToken = config.get('authToken');
            if (!authToken) {
                if (this.isManualRefresh) {
                    vscode.window.showWarningMessage('请先设置Trae AI认证Token', '设置Token').then(selection => {
                        if (selection === '设置Token') {
                            vscode.commands.executeCommand('traeUsage.updateToken');
                        }
                    });
                }
                this.isManualRefresh = false;
                return;
            }
            const response = await axios_1.default.post('https://api-sg-central.trae.ai/trae/api/v1/pay/user_current_entitlement_list', {}, {
                headers: {
                    'authorization': `Cloud-IDE-JWT ${authToken}`,
                    'Host': 'api-sg-central.trae.ai',
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
            this.usageData = response.data;
            if (this.usageData?.code === 1001) {
                if (this.isManualRefresh) {
                    vscode.window.showErrorMessage('Trae AI认证已失效，请更新Token', '更新Token').then(selection => {
                        if (selection === '更新Token') {
                            vscode.commands.executeCommand('traeUsage.updateToken');
                        }
                    });
                }
            }
            this._onDidChangeTreeData.fire();
            this.isManualRefresh = false;
        }
        catch (error) {
            console.error('获取使用量数据失败:', error);
            // 如果是手动刷新失败，通知用户
            if (this.isManualRefresh) {
                vscode.window.showErrorMessage(`获取使用量数据失败: ${error}`);
                this.isManualRefresh = false;
                return;
            }
            // 后台自动重试逻辑，最多重试2次
            if (retryCount < 2) {
                console.log(`API调用失败，将在10秒后进行第${retryCount + 1}次重试`);
                this.retryTimer = setTimeout(() => {
                    this.fetchUsageData(retryCount + 1);
                }, 10000);
            }
            else {
                console.log('API调用失败，已达到最大重试次数，停止重试');
            }
        }
    }
    startAutoRefresh() {
        const config = vscode.workspace.getConfiguration('traeUsage');
        const intervalMinutes = config.get('refreshInterval', 5);
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        this.refreshTimer = setInterval(() => {
            this.fetchUsageData();
        }, intervalMinutes * 60 * 1000);
    }
    dispose() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
        }
    }
}
class UsageItem extends vscode.TreeItem {
    constructor(label, description, collapsibleState, command, contextValue) {
        super(label, collapsibleState);
        this.label = label;
        this.description = description;
        this.collapsibleState = collapsibleState;
        this.command = command;
        this.contextValue = contextValue;
        this.description = description;
        this.tooltip = `${this.label}: ${this.description}`;
    }
}
function activate(context) {
    const provider = new TraeUsageProvider(context);
    // 注册树视图
    vscode.window.createTreeView('traeUsageView', {
        treeDataProvider: provider,
        showCollapseAll: true
    });
    // 注册刷新命令
    const refreshCommand = vscode.commands.registerCommand('traeUsage.refresh', () => {
        provider.refresh();
        vscode.window.showInformationMessage('使用量数据已刷新');
    });
    // 注册更新Token命令
    const updateTokenCommand = vscode.commands.registerCommand('traeUsage.updateToken', async () => {
        const token = await vscode.window.showInputBox({
            prompt: '请输入Trae AI认证Token (不包含"Cloud-IDE-JWT "前缀)',
            placeHolder: 'eyJhbGciOi...',
            password: true
        });
        if (token) {
            const config = vscode.workspace.getConfiguration('traeUsage');
            await config.update('authToken', token, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('Token已更新');
            provider.refresh();
        }
    });
    context.subscriptions.push(refreshCommand, updateTokenCommand, provider);
    // 显示激活消息
    vscode.window.showInformationMessage('Trae Usage Monitor已激活');
}
function deactivate() { }
//# sourceMappingURL=extension.js.map