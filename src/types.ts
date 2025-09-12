export interface UsageDetailExtraInfo {
  cache_read_token: number;
  cache_write_token: number;
  input_token: number;
  output_token: number;
}

export interface UsageDetailItem {
  amount_float: number;
  cost_money_float: number;
  extra_info: UsageDetailExtraInfo;
  mode: string;
  model_name: string;
  product_type_list: number[];
  session_id: string;
  usage_time: number;
  use_max_mode: boolean;
}

export interface UsageDetailResponse {
  total: number;
  user_usage_group_by_sessions: UsageDetailItem[];
}

// 存储的数据结构
export interface StoredUsageData {
  last_update_time: number; // 最后更新时间
  start_time: number;       // 订阅开始时间
  end_time: number;         // 订阅结束时间
  usage_details: { [session_id: string]: UsageDetailItem }; // 按session_id存储
}

// 统计汇总数据结构
export interface ModelStats {
  count: number;
  amount: number;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface ModeStats {
  count: number;
  amount: number;
  cost: number;
}

export interface DailyStats {
  count: number;
  amount: number;
  cost: number;
  models: string[];
}

export interface UsageSummary {
  total_amount: number;
  total_cost: number;
  total_sessions: number;
  model_stats: { [key: string]: ModelStats };
  mode_stats: { [key: string]: ModeStats };
  daily_stats: { [key: string]: DailyStats };
}
