import * as vscode from 'vscode';
import * as os from 'os';
import { StoredUsageData } from './types';
import { logWithTime, formatTimestamp } from './utils';

export class UsageDashboardGenerator {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public async showDashboard(): Promise<void> {
    try {
      const latestData = await this.getLatestUsageData();
      if (!latestData) {
        const choice = await vscode.window.showWarningMessage(
          '未找到使用量数据，请先收集数据',
          '立即收集'
        );
        if (choice === '立即收集') {
          vscode.commands.executeCommand('traeUsage.collectUsageDetails');
        }
        return;
      }

      await this.generateAndShowDashboard(latestData);
    } catch (error) {
      logWithTime(`显示仪表板失败: ${error}`);
      vscode.window.showErrorMessage(`仪表板错误: ${error?.toString() || 'Unknown error'}`);
    }
  }

  private async getLatestUsageData(): Promise<StoredUsageData | null> {
    const config = vscode.workspace.getConfiguration('traeUsage');
    const lastDataFile = config.get<string>('lastUsageDataFile');
    
    if (!lastDataFile) {
      return null;
    }

    try {
      const fileUri = vscode.Uri.file(lastDataFile);
      const fileContent = await vscode.workspace.fs.readFile(fileUri);
      const jsonData = JSON.parse(fileContent.toString());
      return jsonData as StoredUsageData;
    } catch (error) {
      logWithTime(`读取使用量数据文件失败: ${error}`);
      return null;
    }
  }

  private async generateAndShowDashboard(data: StoredUsageData): Promise<void> {
    const htmlContent = this.generateDashboardHTML(data);
    const jsContent = this.generateDashboardJS(data);
    
    const panel = vscode.window.createWebviewPanel(
      'traeUsageDashboard',
      'Trae 使用量统计',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = htmlContent;
  }

  private generateDashboardHTML(data: StoredUsageData): string {
    const timeRange = `${formatTimestamp(data.start_time)} - ${formatTimestamp(data.end_time)}`;
    
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Trae 使用量统计</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
            padding: 20px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 8px;
        }
        .header h1 {
            margin: 0 0 10px 0;
            color: var(--vscode-textLink-foreground);
        }
        .time-range {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
        }
        .summary-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .card {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            border-radius: 8px;
            text-align: center;
            border: 1px solid var(--vscode-panel-border);
        }
        .card h3 {
            margin: 0 0 10px 0;
            font-size: 16px;
            color: var(--vscode-textLink-foreground);
        }
        .card .value {
            font-size: 24px;
            font-weight: bold;
            color: var(--vscode-textPreformat-foreground);
        }
        .chart-section {
            margin-bottom: 30px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            padding: 20px;
            border-radius: 8px;
            border: 1px solid var(--vscode-panel-border);
        }
        .chart-section h2 {
            margin-top: 0;
            color: var(--vscode-textLink-foreground);
        }
        .table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        .table th, .table td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .table th {
            background-color: var(--vscode-list-hoverBackground);
            font-weight: bold;
        }
        .table tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .progress-bar {
            width: 100%;
            height: 20px;
            background-color: var(--vscode-input-background);
            border-radius: 10px;
            overflow: hidden;
            margin: 5px 0;
        }
        .progress-fill {
            height: 100%;
            background-color: var(--vscode-progressBar-background);
            transition: width 0.3s ease;
        }
        .max-mode {
            color: #ff6b6b;
            font-weight: bold;
        }
        .normal-mode {
            color: #4ecdc4;
        }
        .details-table {
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🚀 Trae AI 使用量统计</h1>
        <div class="time-range">统计期间: ${timeRange}</div>
        <div class="time-range">生成时间: ${new Date(data.timestamp).toLocaleString('zh-CN')}</div>
    </div>

    <div class="summary-cards">
        <div class="card">
            <h3>总使用量</h3>
            <div class="value">${(data.summary.total_amount || 0).toFixed(2)}</div>
        </div>
        <div class="card">
            <h3>总费用</h3>
            <div class="value">$${(data.summary.total_cost || 0).toFixed(2)}</div>
        </div>
        <div class="card">
            <h3>会话数</h3>
            <div class="value">${data.summary.total_sessions}</div>
        </div>
        <div class="card">
            <h3>模型种类</h3>
            <div class="value">${Object.keys(data.summary.model_stats).length}</div>
        </div>
    </div>

    ${this.generateModelStatsTable(data)}
    ${this.generateModeStatsTable(data)}
    ${this.generateDailyStatsTable(data)}
    ${this.generateDetailsTable(data)}
</body>
</html>`;
  }

  private generateModelStatsTable(data: StoredUsageData): string {
    return `
    <div class="chart-section">
        <h2>📊 模型使用统计</h2>
        <table class="table">
            <thead>
                <tr>
                    <th>模型</th>
                    <th>使用次数</th>
                    <th>使用量</th>
                    <th>输入Token</th>
                    <th>输出Token</th>
                    <th>缓存读取</th>
                    <th>缓存写入</th>
                </tr>
            </thead>
            <tbody>
                ${Object.entries(data.summary.model_stats)
                  .sort(([,a], [,b]) => b.amount - a.amount)
                  .map(([model, stats]) => `
                    <tr>
                        <td><strong>${model}</strong></td>
                        <td>${stats.count}</td>
                        <td>${(stats.amount || 0).toFixed(2)}</td>
                        <td>${stats.input_tokens.toLocaleString()}</td>
                        <td>${stats.output_tokens.toLocaleString()}</td>
                        <td>${stats.cache_read_tokens.toLocaleString()}</td>
                        <td>${stats.cache_write_tokens.toLocaleString()}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>`;
  }

  private generateModeStatsTable(data: StoredUsageData): string {
    return `
    <div class="chart-section">
        <h2>⚡ 模式使用统计</h2>
        <table class="table">
            <thead>
                <tr>
                    <th>模式</th>
                    <th>使用次数</th>
                    <th>使用量</th>
                    <th>费用</th>
                    <th>占比</th>
                </tr>
            </thead>
            <tbody>
                ${Object.entries(data.summary.mode_stats)
                  .sort(([,a], [,b]) => b.amount - a.amount)
                  .map(([mode, stats]) => {
                    const percentage = ((stats.amount || 0) / (data.summary.total_amount || 1) * 100).toFixed(1);
                    const modeClass = mode === 'Max' ? 'max-mode' : 'normal-mode';
                    return `
                    <tr>
                        <td><span class="${modeClass}">${mode || 'Normal'}</span></td>
                        <td>${stats.count}</td>
                        <td>${(stats.amount || 0).toFixed(2)}</td>
                        <td>$${(stats.cost || 0).toFixed(2)}</td>
                        <td>
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${percentage}%"></div>
                            </div>
                            ${percentage}%
                        </td>
                    </tr>
                `;
                  }).join('')}
            </tbody>
        </table>
    </div>`;
  }

  private generateDailyStatsTable(data: StoredUsageData): string {
    return `
    <div class="chart-section">
        <h2>📅 每日使用统计</h2>
        <table class="table">
            <thead>
                <tr>
                    <th>日期</th>
                    <th>使用次数</th>
                    <th>使用量</th>
                    <th>费用</th>
                    <th>使用模型</th>
                </tr>
            </thead>
            <tbody>
                ${Object.entries(data.summary.daily_stats)
                  .sort(([a], [b]) => b.localeCompare(a))
                  .map(([date, stats]) => `
                    <tr>
                        <td>${date}</td>
                        <td>${stats.count}</td>
                        <td>${(stats.amount || 0).toFixed(2)}</td>
                        <td>$${(stats.cost || 0).toFixed(2)}</td>
                        <td>${(stats as any).models.join(', ')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>`;
  }

  private generateDetailsTable(data: StoredUsageData): string {
    return `
    <div class="chart-section">
        <h2>📋 明细记录</h2>
        <table class="table details-table">
            <thead>
                <tr>
                    <th>时间</th>
                    <th>模型</th>
                    <th>模式</th>
                    <th>使用量</th>
                    <th>费用</th>
                    <th>输入Token</th>
                    <th>输出Token</th>
                </tr>
            </thead>
            <tbody>
                ${data.usage_details
                  .sort((a, b) => b.usage_time - a.usage_time)
                  .slice(0, 1000)
                  .map(item => {
                    const modeClass = item.use_max_mode ? 'max-mode' : 'normal-mode';
                    const modeText = item.mode || 'Normal';
                    return `
                    <tr>
                        <td>${new Date(item.usage_time * 1000).toLocaleString('zh-CN')}</td>
                        <td>${item.model_name}</td>
                        <td><span class="${modeClass}">${modeText}</span></td>
                        <td>${(item.amount_float || 0).toFixed(2)}</td>
                        <td>$${(item.cost_money_float || 0).toFixed(2)}</td>
                        <td>${item.extra_info.input_token.toLocaleString()}</td>
                        <td>${item.extra_info.output_token.toLocaleString()}</td>
                    </tr>
                `;
                  }).join('')}
            </tbody>
        </table>
    </div>`;
  }

  private generateDashboardJS(data: StoredUsageData): string {
    return `
// Trae Usage Dashboard Data
// Generated at: ${new Date(data.timestamp).toISOString()}
// Time Range: ${formatTimestamp(data.start_time)} - ${formatTimestamp(data.end_time)}

const dashboardData = ${JSON.stringify(data, null, 2)};

// Dashboard update functions
function updateSummaryCards(data) {
    const summary = data.summary;
    console.log('Total Amount:', summary.total_amount);
    console.log('Total Cost:', summary.total_cost);
    console.log('Total Sessions:', summary.total_sessions);
    console.log('Model Types:', Object.keys(summary.model_stats).length);
}

function updateModelStats(data) {
    const modelStats = data.summary.model_stats;
    Object.entries(modelStats).forEach(([model, stats]) => {
        console.log(\`\${model}: \${stats.count} sessions, \${stats.amount} amount\`);
    });
}

function updateModeStats(data) {
    const modeStats = data.summary.mode_stats;
    Object.entries(modeStats).forEach(([mode, stats]) => {
        console.log(\`\${mode || 'Normal'}: \${stats.count} sessions, \${stats.amount} amount\`);
    });
}

function updateDailyStats(data) {
    const dailyStats = data.summary.daily_stats;
    Object.entries(dailyStats).forEach(([date, stats]) => {
        console.log(\`\${date}: \${stats.count} sessions, \${stats.amount} amount\`);
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        dashboardData,
        updateSummaryCards,
        updateModelStats,
        updateModeStats,
        updateDailyStats
    };
}
`;
  }

}
