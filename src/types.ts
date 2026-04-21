export interface UsageDetailExtraInfo {
  cache_read_token: number;
  cache_write_token: number;
  input_token: number;
  output_token: number;
}

export interface UsageDetailItem {
  amount_float: number;
  cost_money_float: number;
  dollar_float: number;
  extra_info: UsageDetailExtraInfo;
  mode: string;
  model_name: string;
  product_type_list: number[];
  session_id: string;
  usage_source: number;
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

// 新的计费相关类型
export interface TrialStatus {
  is_eligible_for_trial: boolean;
  is_in_trial: boolean;
  trial_end_time: number;
}

export interface QuotaData {
  advanced_model_request_limit: number;
  auto_completion_limit: number;
  basic_usage_limit: number;
  bonus_usage_limit: number;
  enable_early_access: boolean;
  enable_solo_agent: boolean;
  enable_solo_builder: boolean;
  enable_solo_builder_v1: boolean;
  enable_solo_coder: boolean;
  enable_solo_lite: boolean;
  enable_solo_web: boolean;
  enable_super_model: boolean;
  no_bonus_quota: boolean;
  premium_model_fast_request_limit: number;
  premium_model_slow_request_limit: number;
  solo_agent_parallel_limit: number;
}

export interface UsageData {
  advanced_model_amount: number;
  advanced_model_request_usage: number;
  auto_completion_amount: number;
  auto_completion_usage: number;
  basic_usage_amount: number;
  bonus_usage_amount: number;
  is_flash_consuming: boolean;
  premium_model_fast_amount: number;
  premium_model_fast_request_usage: number;
  premium_model_slow_amount: number;
  premium_model_slow_request_usage: number;
}

export interface EntitlementBaseInfo {
  charge_amount: number;
  currency: number;
  end_time: number;
  ent_status: number;
  entitlement_id: string;
  product_extra: any;
  product_id: number;
  product_type: number;
  quota: QuotaData;
  start_time: number;
  user_id: string;
}

export interface EntitlementPack {
  display_desc: string;
  entitlement_base_info: EntitlementBaseInfo;
  expire_time: number;
  is_hide: boolean;
  is_last_period: boolean;
  next_billing_time: number;
  source_id: string;
  status: number;
  usage: UsageData;
  yearly_expire_time: number;
}

export interface ApiResponse {
  code?: number;
  message?: string;
  is_dollar_usage_billing: boolean;
  is_pay_freshman: boolean;
  trial_status: TrialStatus;
  user_entitlement_pack_list: EntitlementPack[];
}
