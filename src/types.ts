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
  /** v2：归属渠道（可空，表示直销/自营） */
  channel_id: string | null;
  /** v2：结算单价（单位：分） */
  unit_price: number;
};

/** 渠道 / 分销商 */
export type ChannelRow = {
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
  /** v2：来源渠道（可空，表示直销） */
  channel_id: string | null;
  /** v2：结算单价（单位：分），激活时从 CDK 批次继承 */
  unit_price: number;
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
