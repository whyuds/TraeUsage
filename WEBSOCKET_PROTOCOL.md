# TraeUsage WebSocket 协议文档

## 概述

TraeUsage 扩展支持通过 WebSocket 连接实时向服务端投递用户使用量数据。这使得服务端可以构建看板来监控各个客户端的在线状态和使用情况。

## 配置

### VSCode 设置

在 VSCode 设置中配置以下选项：

- `traeUsage.websocketUrl`: WebSocket 服务器地址 (例如: `ws://localhost:8080/ws`)
- `traeUsage.enableWebsocket`: 启用/禁用 WebSocket 实时数据投递

### 默认行为

- 默认情况下，WebSocket 功能是禁用的 (`enableWebsocket: false`)
- 默认 WebSocket 地址为空字符串
- 只有当地址非空且功能启用时，才会尝试连接

## 消息协议

所有 WebSocket 消息都是 JSON 格式，包含以下通用字段：

```typescript
interface BaseMessage {
  type: string;        // 消息类型
  timestamp: number;   // 时间戳 (毫秒)
  clientId: string;    // 客户端唯一标识
}
```

### 客户端标识

客户端 ID 格式：`vscode-{machineId}-{timestamp}`

其中：
- `machineId`: VSCode 的机器标识
- `timestamp`: 扩展启动时的时间戳

### 用户信息结构

```typescript
interface UserInfo {
  machineId: string;      // 机器标识
  platform: string;      // 操作系统平台
  vsCodeVersion: string;  // VSCode 版本
  extensionVersion: string; // 扩展版本
}
```

## 消息类型

### 1. 客户端连接消息 (client_connect)

客户端成功连接到 WebSocket 服务器时发送。

```typescript
interface WebSocketConnectMessage {
  type: 'client_connect';
  timestamp: number;
  clientId: string;
  sessionId: string;    // Trae Session ID
  userInfo: UserInfo;
}
```

**示例：**
```json
{
  "type": "client_connect",
  "timestamp": 1703664000000,
  "clientId": "vscode-abc123-1703664000000",
  "sessionId": "session_abc123...",
  "userInfo": {
    "machineId": "abc123-def456-ghi789",
    "platform": "win32",
    "vsCodeVersion": "1.85.0",
    "extensionVersion": "1.2.8"
  }
}
```

### 2. 使用量更新消息 (usage_update)

每次获取到新的使用量数据时发送。

```typescript
interface WebSocketUsageMessage {
  type: 'usage_update';
  timestamp: number;
  clientId: string;
  sessionId: string;
  usageData: ApiResponse;  // Trae API 返回的完整使用量数据
  userInfo: UserInfo;
}
```

**示例：**
```json
{
  "type": "usage_update",
  "timestamp": 1703664300000,
  "clientId": "vscode-abc123-1703664000000",
  "sessionId": "session_abc123...",
  "usageData": {
    "code": 200,
    "is_pay_freshman": false,
    "user_entitlement_pack_list": [
      {
        "entitlement_base_info": {
          "end_time": 1735200000,
          "quota": {
            "premium_model_fast_request_limit": 500,
            "premium_model_slow_request_limit": 50,
            "auto_completion_limit": 1000,
            "advanced_model_request_limit": 100
          }
        },
        "usage": {
          "premium_model_fast_request_usage": 245,
          "premium_model_slow_request_usage": 12,
          "auto_completion_usage": 350,
          "advanced_model_request_usage": 25,
          "is_flash_consuming": false
        },
        "status": 1
      }
    ]
  },
  "userInfo": {
    "machineId": "abc123-def456-ghi789",
    "platform": "win32",
    "vsCodeVersion": "1.85.0",
    "extensionVersion": "1.2.8"
  }
}
```

### 3. 心跳消息 (ping)

客户端每 30 秒发送一次心跳消息以维持连接。

```typescript
interface WebSocketPingMessage {
  type: 'ping';
  timestamp: number;
  clientId: string;
}
```

**示例：**
```json
{
  "type": "ping",
  "timestamp": 1703664600000,
  "clientId": "vscode-abc123-1703664000000"
}
```

### 4. 客户端断开消息 (client_disconnect)

客户端主动断开连接前发送。

```typescript
interface WebSocketDisconnectMessage {
  type: 'client_disconnect';
  timestamp: number;
  clientId: string;
}
```

**示例：**
```json
{
  "type": "client_disconnect",
  "timestamp": 1703667200000,
  "clientId": "vscode-abc123-1703664000000"
}
```

## 连接行为

### 连接时机

- 扩展启动时，如果 WebSocket 功能已启用且地址已配置
- 配置更改时，如果启用了 WebSocket 功能

### 重连机制

- 连接断开时会自动重连
- 最多重连 5 次，每次间隔 5 秒
- 重连次数达到上限后停止尝试

### 错误处理

- 连接失败时会在 VSCode 中显示错误消息
- 前 3 次重连失败会显示重连通知
- 所有 WebSocket 相关日志会输出到控制台

## 服务端实现建议

### 基本结构

```javascript
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

// 存储活跃客户端
const activeClients = new Map();

wss.on('connection', (ws) => {
  let clientInfo = null;
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(ws, message);
    } catch (error) {
      console.error('解析消息失败:', error);
    }
  });
  
  ws.on('close', () => {
    if (clientInfo) {
      activeClients.delete(clientInfo.clientId);
      console.log('客户端断开:', clientInfo.clientId);
    }
  });
});

function handleMessage(ws, message) {
  switch (message.type) {
    case 'client_connect':
      handleClientConnect(ws, message);
      break;
    case 'usage_update':
      handleUsageUpdate(message);
      break;
    case 'ping':
      handlePing(ws, message);
      break;
    case 'client_disconnect':
      handleClientDisconnect(message);
      break;
  }
}
```

### 数据存储建议

根据业务需求，可以将接收到的数据存储到：

- **实时监控**: Redis 或内存存储，用于看板显示
- **历史数据**: 数据库 (MySQL/PostgreSQL)，用于统计分析
- **日志系统**: 文件或日志服务，用于审计追踪

### 看板功能

基于接收的数据，可以构建以下监控功能：

1. **在线客户端列表**
   - 显示当前连接的所有客户端
   - 客户端基本信息 (平台、VSCode版本等)
   - 最后活跃时间

2. **使用量统计**
   - 实时使用量数据
   - 使用趋势图表
   - 配额使用率

3. **告警功能**
   - 配额即将耗尽告警
   - 客户端离线告警
   - 异常使用模式检测

## 安全考虑

1. **身份验证**: 可以通过 sessionId 验证客户端身份
2. **速率限制**: 限制客户端消息发送频率
3. **数据验证**: 验证接收数据的格式和内容
4. **访问控制**: 限制 WebSocket 服务器的访问权限

## 故障排除

### 常见问题

1. **连接失败**
   - 检查 WebSocket 服务器是否运行
   - 确认地址格式正确 (ws:// 或 wss://)
   - 检查网络连接和防火墙设置

2. **数据不更新**
   - 确认 WebSocket 功能已启用
   - 检查 sessionId 是否正确配置
   - 查看 VSCode 开发者控制台的错误信息

3. **频繁重连**
   - 检查服务器稳定性
   - 确认心跳处理正确
   - 调整重连参数

### 调试方法

1. 打开 VSCode 开发者工具 (Ctrl+Shift+I)
2. 查看控制台日志，搜索 "WebSocket" 相关信息
3. 使用网络抓包工具检查 WebSocket 流量
4. 在服务端添加详细日志记录

## 版本历史

- **1.2.8**: 初始 WebSocket 功能实现
  - 支持实时使用量数据推送
  - 客户端连接状态管理
  - 自动重连机制

