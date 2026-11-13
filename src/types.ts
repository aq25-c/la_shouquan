/** 数据库行类型（与 SQLite 列名一一对应，snake_case 直接透传给前端）。 */

export type AdminRow = {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  role: string;
  status: string;
  created_at: string;
  last_login_at: string | null;
  /** v4：JSON { menus: string[], features: string[] } */
  permissions: string;
  /** v4：代理关联的代理（role = agent 时有值） */
  agent_id: string | null;
  /** v5：代理可售范围 JSON { product_ids[], module_ids[], term_types[] } */
  agent_profile: string;
};

export type SessionRow = {
  id: string;
  token_hash: string;
  subject_type: "admin" | "customer";
  subject_id: string;
  created_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  revoked_at: string | null;
};

export type ProductRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  /** v6：该产品的试用配置 JSON（空串 = 沿用全局默认） */
  trial_config: string;
};

export type ModuleRow = {
  id: string;
  product_id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
};

export type CustomerRow = {
  id: string;
  email: string | null;
  password_hash: string | null;
  name: string | null;
  company: string | null;
  phone: string | null;
  status: string;
  note: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

export type CdkBatchRow = {
  id: string;
  product_id: string;
  count: number;
  days: number;
  seats: number;
  module_ids: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  /** v2：归属代理（可空，表示直销/自营） */
  agent_id: string | null;
  /** v2：结算单价（单位：分） */
  unit_price: number;
  /** v4：计费类型（hour/day/month/year/count）与数量 */
  term_type: string;
  term_value: number | null;
};

/** 代理 / 分销商 */
export type AgentRow = {
  id: string;
  code: string;
  name: string;
  contact: string | null;
  phone: string | null;
  email: string | null;
  note: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  /** v4：卡密余额（单位：张），代理生成卡密时扣减 */
  credit: number;
  /** v5：账户余额（单位：分），代理按「单价 × 时长/次数 × 张数」扣费 */
  balance: number;
};

export type CdkRow = {
  id: string;
  code: string;
  batch_id: string | null;
  product_id: string;
  module_ids: string;
  days: number;
  seats: number;
  status: "unused" | "used" | "revoked";
  expires_at: string | null;
  customer_id: string | null;
  license_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  used_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  /** v4：计费类型与数量（生成时从批次继承） */
  term_type: string;
  term_value: number | null;
};

export type LicenseRow = {
  id: string;
  license_no: string;
  customer_id: string;
  product_id: string;
  cdk_id: string | null;
  module_ids: string;
  seats: number;
  status: "active" | "suspended" | "revoked";
  starts_at: string;
  expires_at: string;
  offline_grace_days: number;
  key_hash: string;
  note: string | null;
  created_at: string;
  updated_at: string;
  last_heartbeat_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  /** v2：来源代理（可空，表示直销） */
  agent_id: string | null;
  /** v2：结算单价（单位：分），激活时从 CDK 批次继承 */
  unit_price: number;
  /** v3：授权类型（paid = 正式 / trial = 试用） */
  kind: "paid" | "trial";
  /** v3：开通来源（cdk / manual / trial） */
  source: string;
  /** v4：计费类型与数量（hour/day/month/year/count） */
  term_type: string;
  term_value: number | null;
  /** v4：次数型授权的总额度（非次数型为 null） */
  max_usages: number | null;
  /** v8：该授权允许的最大到期时间（CDK 授予的实际到期时间），代理调整不得突破 */
  max_expires_at: string | null;
  /** v4：次数型授权已消耗次数 */
  used_usages: number;
};

export type DeviceRow = {
  id: string;
  license_id: string;
  device_id: string;
  device_name: string | null;
  platform: string | null;
  status: "active" | "released";
  first_seen_at: string;
  last_seen_at: string;
  released_at: string | null;
  last_ip: string | null;
};

export type AuditRow = {
  id: string;
  at: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  detail: string | null;
};

/** 授权的“计算状态”，到期是动态判定的，不写回数据库。 */
export type EffectiveLicenseStatus = "pending" | "active" | "expired" | "suspended" | "revoked";
