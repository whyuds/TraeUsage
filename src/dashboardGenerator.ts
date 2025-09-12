import * as vscode from 'vscode';
import * as os from 'os';
import { StoredUsageData, UsageDetailItem, UsageSummary, ModelStats, ModeStats, DailyStats } from './types';
import { logWithTime, formatTimestamp } from './utils';

const USAGE_DATA_FILE = 'usage_data.json';

export class UsageDashboardGenerator {
  private context: vscode.ExtensionContext;
  private panel: vscode.WebviewPanel | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  public async showDashboard(): Promise<void> {
    try {
      const rawData = await this.loadUsageData();
      if (!rawData || Object.keys(rawData.usage_details).length === 0) {
        const choice = await vscode.window.showWarningMessage(
          'No usage data found, please collect data first',
          'Collect Now'
        );
        if (choice === 'Collect Now') {
          vscode.commands.executeCommand('traeUsage.collectUsageDetails');
        }
        return;
      }

      await this.generateAndShowDashboard(rawData);
    } catch (error) {
      logWithTime(`Failed to display dashboard: ${error}`);
      vscode.window.showErrorMessage(`Dashboard error: ${error?.toString() || 'Unknown error'}`);
    }
  }

  private async loadUsageData(): Promise<StoredUsageData | null> {
    const dataPath = vscode.Uri.joinPath(this.context.globalStorageUri, USAGE_DATA_FILE);
    
    try {
      const fileContent = await vscode.workspace.fs.readFile(dataPath);
      const jsonData = JSON.parse(fileContent.toString());
      return jsonData as StoredUsageData;
    } catch (error) {
      logWithTime(`Failed to read usage data file: ${error}`);
      return null;
    }
  }

  private filterUsageDetails(usageDetails: UsageDetailItem[], startDate?: string, endDate?: string): UsageDetailItem[] {
    if (!startDate && !endDate) {
      return usageDetails;
    }

    return usageDetails.filter(item => {
      const itemDate = new Date(item.usage_time * 1000).toISOString().split('T')[0];
      if (startDate && itemDate < startDate) return false;
      if (endDate && itemDate > endDate) return false;
      return true;
    });
  }

  private generateSummary(usageDetails: UsageDetailItem[]): UsageSummary {
    const summary: UsageSummary = {
      total_amount: 0,
      total_cost: 0,
      total_sessions: usageDetails.length,
      model_stats: {},
      mode_stats: {},
      daily_stats: {}
    };

    usageDetails.forEach(item => {
      summary.total_amount += item.amount_float;
      summary.total_cost += item.cost_money_float;

      // Model statistics
      const modelName = item.model_name;
      if (!summary.model_stats[modelName]) {
        summary.model_stats[modelName] = {
          count: 0,
          amount: 0,
          cost: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0
        };
      }
      const modelStats = summary.model_stats[modelName];
      modelStats.count++;
      modelStats.amount += item.amount_float;
      modelStats.cost += item.cost_money_float;
      modelStats.input_tokens += item.extra_info.input_token;
      modelStats.output_tokens += item.extra_info.output_token;
      modelStats.cache_read_tokens += item.extra_info.cache_read_token;
      modelStats.cache_write_tokens += item.extra_info.cache_write_token;

      // Mode statistics
      const mode = item.use_max_mode ? 'Max' : 'Normal';
      if (!summary.mode_stats[mode]) {
        summary.mode_stats[mode] = { count: 0, amount: 0, cost: 0 };
      }
      summary.mode_stats[mode].count++;
      summary.mode_stats[mode].amount += item.amount_float;
      summary.mode_stats[mode].cost += item.cost_money_float;

      // Daily statistics
      const date = new Date(item.usage_time * 1000).toISOString().split('T')[0];
      if (!summary.daily_stats[date]) {
        summary.daily_stats[date] = { count: 0, amount: 0, cost: 0, models: [] };
      }
      summary.daily_stats[date].count++;
      summary.daily_stats[date].amount += item.amount_float;
      summary.daily_stats[date].cost += item.cost_money_float;
      if (!summary.daily_stats[date].models.includes(modelName)) {
        summary.daily_stats[date].models.push(modelName);
      }
    });

    return summary;
  }

  private async generateAndShowDashboard(rawData: StoredUsageData): Promise<void> {
    const allUsageDetails = Object.values(rawData.usage_details);
    const initialSummary = this.generateSummary(allUsageDetails);
    
    if (this.panel) {
      this.panel.dispose();
    }
    
    this.panel = vscode.window.createWebviewPanel(
      'traeUsageDashboard',
      'Trae Usage Statistics',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    // Listen for messages from webview
    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'filter':
          const filteredDetails = this.filterUsageDetails(allUsageDetails, message.startDate, message.endDate);
          const filteredSummary = this.generateSummary(filteredDetails);
          
          this.panel?.webview.postMessage({
            command: 'updateData',
            summary: filteredSummary,
            details: filteredDetails
          });
          break;
          
        case 'export':
          const exportDetails = this.filterUsageDetails(allUsageDetails, message.startDate, message.endDate);
          await this.exportData(exportDetails, message.startDate, message.endDate);
          break;
      }
    });

    this.panel.webview.html = this.generateDashboardHTML(rawData, initialSummary, allUsageDetails);
  }

  private async exportData(filteredDetails: UsageDetailItem[], startDate?: string, endDate?: string): Promise<void> {
    try {
      const csvContent = this.generateCSV(filteredDetails);
      const dateRange = startDate && endDate ? `_${startDate}_to_${endDate}` : '';
      const fileName = `trae_usage_export${dateRange}_${new Date().toISOString().split('T')[0]}.csv`;
      
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(fileName),
        filters: {
          'CSV Files': ['csv']
        }
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(csvContent, 'utf8'));
        vscode.window.showInformationMessage(`Data exported to: ${uri.fsPath}`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Export failed: ${error}`);
    }
  }

  private generateCSV(details: UsageDetailItem[]): string {
    const headers = [
      'Time', 'Model', 'Mode', 'Usage', 'Cost', 'Input Tokens', 'Output Tokens', 'Cache Read Tokens', 'Cache Write Tokens', 'Session ID'
    ];
    
    const rows = details.map(item => [
      new Date((item.usage_time || 0) * 1000).toLocaleString('en-US'),
      item.model_name || '',
      item.use_max_mode ? 'Max' : 'Normal',
      (item.amount_float || 0).toString(),
      (item.cost_money_float || 0).toString(),
      (item.extra_info?.input_token || 0).toString(),
      (item.extra_info?.output_token || 0).toString(),
      (item.extra_info?.cache_read_token || 0).toString(),
      (item.extra_info?.cache_write_token || 0).toString(),
      item.session_id || ''
    ]);

    return [headers, ...rows].map(row => row.join(',')).join('\n');
  }

  private generateDashboardHTML(rawData: StoredUsageData, summary: UsageSummary, allUsageDetails: UsageDetailItem[]): string {
    const timeRange = `${formatTimestamp(rawData.start_time)} - ${formatTimestamp(rawData.end_time)}`;
    
    // Get date range for filter
    const dates = allUsageDetails.map(item => new Date(item.usage_time * 1000).toISOString().split('T')[0]);
    const minDate = Math.min(...dates.map(d => new Date(d).getTime()));
    const maxDate = Math.max(...dates.map(d => new Date(d).getTime()));
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Trae Usage Statistics</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
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
        .time-range {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
        }
        .controls {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            align-items: center;
            flex-wrap: wrap;
        }
        .controls input, .controls button {
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
        }
        .controls button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
        }
        .controls button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .quick-filters {
            display: flex;
            gap: 8px;
            margin-left: 10px;
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
        .chart-container {
            position: relative;
            height: 400px;
            margin-bottom: 20px;
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
        .max-mode {
            color: #ff6b6b;
            font-weight: bold;
        }
        .normal-mode {
            color: #4ecdc4;
        }
        .filter-info {
            background-color: var(--vscode-textBlockQuote-background);
            padding: 10px;
            border-radius: 4px;
            margin-bottom: 20px;
            border-left: 4px solid var(--vscode-textLink-foreground);
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="time-range">Statistics Period: ${timeRange}</div>
        <div class="time-range">Last Updated: ${new Date(rawData.last_update_time * 1000).toLocaleString('en-US')}</div>
        <div class="time-range">Total Records: ${Object.keys(rawData.usage_details).length}</div>
    </div>

    <div class="controls">
        <label>Start Date:</label>
        <input type="date" id="startDate" value="${new Date(minDate).toISOString().split('T')[0]}">
        <label>End Date:</label>
        <input type="date" id="endDate" value="${new Date(maxDate).toISOString().split('T')[0]}">
        <button onclick="applyFilter()">Filter</button>
        <button onclick="resetFilter()">Reset</button>
        
        <!-- Quick Filter Buttons -->
        <div class="quick-filters">
            <button onclick="filterLast1Day()">Last 1 Day</button>
            <button onclick="filterLast7Days()">Last 7 Days</button>
            <button onclick="filterLast30Days()">Last 30 Days</button>
        </div>

        <button onclick="exportData()">Export Data</button>
    </div>

    <div id="filterInfo" class="filter-info" style="display: none;">
        <span id="filterText"></span>
    </div>

    <div id="summaryCards" class="summary-cards">
        ${this.generateSummaryCards(summary)}
    </div>

    <div class="chart-section">
        <h2>📈 Daily Usage Trend</h2>
        <div class="chart-container">
            <canvas id="dailyTrendChart"></canvas>
        </div>
    </div>

    <div id="modelStats" class="chart-section">
        <h2>📊 Model Usage Statistics</h2>
        ${this.generateModelStatsTable(summary)}
    </div>

    <div id="modeStats" class="chart-section">
        <h2>⚡ Mode Usage Statistics</h2>
        ${this.generateModeStatsTable(summary)}
    </div>

    <div id="dailyStats" class="chart-section">
        <h2>📅 Daily Usage Statistics</h2>
        ${this.generateDailyStatsTable(summary)}
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentSummary = ${JSON.stringify(summary)};
        let currentDetails = ${JSON.stringify(allUsageDetails)};
        let dailyChart;
        const originalMinDate = '${new Date(minDate).toISOString().split('T')[0]}';
        const originalMaxDate = '${new Date(maxDate).toISOString().split('T')[0]}';

        // Initialize chart
        function initDailyChart(summary) {
            const ctx = document.getElementById('dailyTrendChart').getContext('2d');
            const dailyData = Object.entries(summary.daily_stats).sort(([a], [b]) => a.localeCompare(b));
            
            if (dailyChart) {
                dailyChart.destroy();
            }
            
            dailyChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: dailyData.map(([date]) => date),
                    datasets: [{
                        label: 'Usage',
                        data: dailyData.map(([, stats]) => stats.amount),
                        borderColor: '#4ecdc4',
                        backgroundColor: 'rgba(78, 205, 196, 0.1)',
                        tension: 0.4,
                        fill: true
                    }, {
                        label: 'Cost ($)',
                        data: dailyData.map(([, stats]) => stats.cost),
                        borderColor: '#ff6b6b',
                        backgroundColor: 'rgba(255, 107, 107, 0.1)',
                        tension: 0.4,
                        yAxisID: 'y1'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top'
                        }
                    },
                    scales: {
                        y: {
                            type: 'linear',
                            display: true,
                            position: 'left',
                            title: {
                                display: true,
                                text: 'Usage'
                            }
                        },
                        y1: {
                            type: 'linear',
                            display: true,
                            position: 'right',
                            title: {
                                display: true,
                                text: 'Cost ($)'
                            },
                            grid: {
                                drawOnChartArea: false,
                            },
                        }
                    }
                }
            });
        }

        function applyFilter() {
            const startDate = document.getElementById('startDate').value;
            const endDate = document.getElementById('endDate').value;
            
            // Show filter info
            updateFilterInfo(startDate, endDate);
            
            vscode.postMessage({
                command: 'filter',
                startDate: startDate,
                endDate: endDate
            });
        }

        function resetFilter() {
            document.getElementById('startDate').value = originalMinDate;
            document.getElementById('endDate').value = originalMaxDate;
            
            // Hide filter info
            document.getElementById('filterInfo').style.display = 'none';
            
            applyFilter();
        }

        // Quick Filter Functions
        function filterLast1Day() {
            const today = new Date().toISOString().split('T')[0];
            document.getElementById('startDate').value = today;
            document.getElementById('endDate').value = today;
            applyFilter();
        }

        function filterLast7Days() {
            const endDate = new Date().toISOString().split('T')[0];
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - 6); // Include today + previous 6 days = 7 days total
            startDate.setHours(0, 0, 0, 0);
            document.getElementById('startDate').value = startDate.toISOString().split('T')[0];
            document.getElementById('endDate').value = endDate;
            applyFilter();
        }

        function filterLast30Days() {
            const endDate = new Date().toISOString().split('T')[0];
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - 29); // Include today + previous 29 days = 30 days total
            startDate.setHours(0, 0, 0, 0);
            document.getElementById('startDate').value = startDate.toISOString().split('T')[0];
            document.getElementById('endDate').value = endDate;
            applyFilter();
        }

        function updateFilterInfo(startDate, endDate) {
            const filterInfo = document.getElementById('filterInfo');
            const filterText = document.getElementById('filterText');
            
            if (startDate === originalMinDate && endDate === originalMaxDate) {
                filterInfo.style.display = 'none';
            } else {
                filterInfo.style.display = 'block';
                filterText.textContent = \`Current Filter Range: \${startDate} to \${endDate}\`;
            }
        }

        function exportData() {
            const startDate = document.getElementById('startDate').value;
            const endDate = document.getElementById('endDate').value;
            
            vscode.postMessage({
                command: 'export',
                startDate: startDate,
                endDate: endDate
            });
        }

        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateData':
                    currentSummary = message.summary;
                    currentDetails = message.details;
                    updateUI(currentSummary);
                    break;
            }
        });

        function updateUI(summary) {
            // Update summary cards
            document.getElementById('summaryCards').innerHTML = generateSummaryCards(summary);
            
            // Update statistics tables
            document.getElementById('modelStats').innerHTML = '<h2>📊 Model Usage Statistics</h2>' + generateModelStatsTable(summary);
            document.getElementById('modeStats').innerHTML = '<h2>⚡ Mode Usage Statistics</h2>' + generateModeStatsTable(summary);
            document.getElementById('dailyStats').innerHTML = '<h2>📅 Daily Usage Statistics</h2>' + generateDailyStatsTable(summary);
            
            // Update chart
            initDailyChart(summary);
        }

        // Frontend generation functions
        function generateSummaryCards(summary) {
            return \`
                <div class="card">
                    <h3>Total Usage</h3>
                    <div class="value">\${(summary.total_amount || 0).toFixed(2)}</div>
                </div>
                <div class="card">
                    <h3>Total Cost</h3>
                    <div class="value">\${(summary.total_cost || 0).toFixed(2)}$</div>
                </div>
                <div class="card">
                    <h3>Total Sessions</h3>
                    <div class="value">\${summary.total_sessions}</div>
                </div>
                <div class="card">
                    <h3>Model Types</h3>
                    <div class="value">\${Object.keys(summary.model_stats).length}</div>
                </div>\`;
        }

        function generateModelStatsTable(summary) {
            const rows = Object.entries(summary.model_stats)
                .sort(([,a], [,b]) => b.amount - a.amount)
                .map(([model, stats]) => \`
                    <tr>
                        <td><strong>\${model}</strong></td>
                        <td>\${stats.count}</td>
                        <td>\${(stats.amount || 0).toFixed(2)}</td>
                        <td>\${(stats.cost || 0).toFixed(2)}$</td>
                        <td>\${stats.input_tokens.toLocaleString()}</td>
                        <td>\${stats.output_tokens.toLocaleString()}</td>
                        <td>\${stats.cache_read_tokens.toLocaleString()}</td>
                        <td>\${stats.cache_write_tokens.toLocaleString()}</td>
                    </tr>
                \`).join('');
            
            return \`
                <table class="table">
                    <thead>
                        <tr>
                            <th>Model</th>
                            <th>Usage Count</th>
                            <th>Usage</th>
                            <th>Cost</th>
                            <th>Input Tokens</th>
                            <th>Output Tokens</th>
                            <th>Cache Read</th>
                            <th>Cache Write</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${rows}
                    </tbody>
                </table>\`;
        }

        function generateModeStatsTable(summary) {
            const rows = Object.entries(summary.mode_stats)
                .sort(([,a], [,b]) => b.amount - a.amount)
                .map(([mode, stats]) => {
                    const percentage = ((stats.amount || 0) / (summary.total_amount || 1) * 100).toFixed(1);
                    const modeClass = mode === 'Max' ? 'max-mode' : 'normal-mode';
                    return \`
                    <tr>
                        <td><span class="\${modeClass}">\${mode}</span></td>
                        <td>\${stats.count}</td>
                        <td>\${(stats.amount || 0).toFixed(2)}</td>
                        <td>\${(stats.cost || 0).toFixed(2)}$</td>
                        <td>\${percentage}%</td>
                    </tr>
                \`;
                }).join('');
            
            return \`
                <table class="table">
                    <thead>
                        <tr>
                            <th>Mode</th>
                            <th>Usage Count</th>
                            <th>Usage</th>
                            <th>Cost</th>
                            <th>Percentage</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${rows}
                    </tbody>
                </table>\`;
        }

        function generateDailyStatsTable(summary) {
            const rows = Object.entries(summary.daily_stats)
                .sort(([a], [b]) => b.localeCompare(a))
                .map(([date, stats]) => \`
                    <tr>
                        <td>\${date}</td>
                        <td>\${stats.count}</td>
                        <td>\${(stats.amount || 0).toFixed(2)}</td>
                        <td>\${(stats.cost || 0).toFixed(2)}$</td>
                        <td>\${stats.models.join(', ')}</td>
                    </tr>
                \`).join('');
            
            return \`
                <table class="table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Usage Count</th>
                            <th>Usage</th>
                            <th>Cost</th>
                            <th>Models Used</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${rows}
                    </tbody>
                </table>\`;
        }

        // Initialize
        initDailyChart(currentSummary);
        updateFilterInfo(document.getElementById('startDate').value, document.getElementById('endDate').value);
    </script>
</body>
</html>`;
  }

  private generateSummaryCards(summary: UsageSummary): string {
    return `
        <div class="card">
            <h3>Total Usage</h3>
            <div class="value">${(summary.total_amount || 0).toFixed(2)}</div>
        </div>
        <div class="card">
            <h3>Total Cost</h3>
            <div class="value">$${(summary.total_cost || 0).toFixed(2)}</div>
        </div>
        <div class="card">
            <h3>Total Sessions</h3>
            <div class="value">${summary.total_sessions}</div>
        </div>
        <div class="card">
            <h3>Model Types</h3>
            <div class="value">${Object.keys(summary.model_stats).length}</div>
        </div>`;
  }

  private generateModelStatsTable(summary: UsageSummary): string {
    return `
        <table class="table">
            <thead>
                <tr>
                    <th>Model</th>
                    <th>Usage Count</th>
                    <th>Usage</th>
                    <th>Cost</th>
                    <th>Input Tokens</th>
                    <th>Output Tokens</th>
                    <th>Cache Read</th>
                    <th>Cache Write</th>
                </tr>
            </thead>
            <tbody>
                ${Object.entries(summary.model_stats)
                  .sort(([,a], [,b]) => b.amount - a.amount)
                  .map(([model, stats]) => `
                    <tr>
                        <td><strong>${model}</strong></td>
                        <td>${stats.count}</td>
                        <td>${(stats.amount || 0).toFixed(2)}</td>
                        <td>$${(stats.cost || 0).toFixed(2)}</td>
                        <td>${stats.input_tokens.toLocaleString()}</td>
                        <td>${stats.output_tokens.toLocaleString()}</td>
                        <td>${stats.cache_read_tokens.toLocaleString()}</td>
                        <td>${stats.cache_write_tokens.toLocaleString()}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
  }

  private generateModeStatsTable(summary: UsageSummary): string {
    return `
        <table class="table">
            <thead>
                <tr>
                    <th>Mode</th>
                    <th>Usage Count</th>
                    <th>Usage</th>
                    <th>Cost</th>
                    <th>Percentage</th>
                </tr>
            </thead>
            <tbody>
                ${Object.entries(summary.mode_stats)
                  .sort(([,a], [,b]) => b.amount - a.amount)
                  .map(([mode, stats]) => {
                    const percentage = ((stats.amount || 0) / (summary.total_amount || 1) * 100).toFixed(1);
                    const modeClass = mode === 'Max' ? 'max-mode' : 'normal-mode';
                    return `
                    <tr>
                        <td><span class="${modeClass}">${mode}</span></td>
                        <td>${stats.count}</td>
                        <td>${(stats.amount || 0).toFixed(2)}</td>
                        <td>$${(stats.cost || 0).toFixed(2)}</td>
                        <td>${percentage}%</td>
                    </tr>
                `;
                  }).join('')}
            </tbody>
        </table>`;
  }

  private generateDailyStatsTable(summary: UsageSummary): string {
    return `
        <table class="table">
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Usage Count</th>
                    <th>Usage</th>
                    <th>Cost</th>
                    <th>Models Used</th>
                </tr>
            </thead>
            <tbody>
                ${Object.entries(summary.daily_stats)
                  .sort(([a], [b]) => b.localeCompare(a))
                  .map(([date, stats]) => `
                    <tr>
                        <td>${date}</td>
                        <td>${stats.count}</td>
                        <td>${(stats.amount || 0).toFixed(2)}</td>
                        <td>$${(stats.cost || 0).toFixed(2)}</td>
                        <td>${stats.models.join(', ')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
  }
}
