// routes/it-ledger/invariants.js — 信息化资产轻量台账「一处真相」不变量模块（长任务 D · C2）
//   业务方案 SSOT = docs/local/信息化资产_轻量版/信息化资产轻量台账_方案_20260918_v0.7.md
//   §2.1（类别×允许字段矩阵）/ §2.1.1（slot_count/u_height 边界）/ §2.7（attrs 冻结键集合）/
//   §5（登记 placement 六分支 + peer_versions 协议）/ §2.2b（rooms 元素校验）
//   执行 agent spec = docs/local/信息化资产_轻量版/_agent_specs/C2_登记编辑机柜楼层_spec.md
//
// 本文件是**纯函数模块**：不 require db / express / sqlite3，不访问任何全局状态。所有需要读库
// 才能得到的上下文（机柜 u_total、同柜在位区间、宿主行、楼层 rooms、随装子盘列表）由调用方
// （routes/it-ledger/index.js）在事务内查询后，通过 ctx 参数传入。
//
// CATEGORY_VALUES / STATUS_VALUES 与 index.js 的同名常量重复声明（两处都是方案 §2.1/§2.6 冻结
// 的枚举值，DB CHECK 约束的同源枚举在 index.js）——这是有意的小范围重复，代价是"若未来枚举值
// 变化需要同步改两处"，换来的是本文件保持零依赖、可独立单测/静态变异（spec §0 要求"无 db、
// 无 express"）。回报中已列为已知取舍，不是遗漏。
//
// 契约裁定（Opus 复看第7批，2026-09）：**宿主状态域（PARENT_ALLOWED_STATUSES）是「装盘」这个
// 动作的前置条件，不是资产行必须永远满足的不变量**——曾经把它塞进 HOST_SLOT 当成硬盘行的恒定
// 校验，后果是宿主一旦 retired，它已有的子盘从此任何编辑都过不了校验（与 HOST_DISK_STATUS_SYNC
// 「子盘 status 必须等于宿主 status」互相矛盾，对 retired 宿主的子盘行形成无出口受困态）。
// invariants.js 里的两条 HOST_SLOT/HOST_DISK_STATUS_SYNC 现在只负责"行内自洽"（disk.status
// 与 parent.status 同步，含双方都 retired 的情况），"宿主是否允许被新装盘"这一次性判断挪到
// 调用方在装盘动作发生前单独做（见 PARENT_ALLOWED_STATUSES 定义处的详细注释）。
'use strict';

const CATEGORY_VALUES = ['server', 'disk', 'laptop', 'desktop', 'ap', 'software', 'subscription', 'other'];
const HARDWARE_STATUSES = ['in_service', 'in_depot', 'faulty', 'to_retire', 'retired'];
const SOFTWARE_STATUSES = ['active', 'cancelled'];
const SOFTWARE_LIKE = new Set(['software', 'subscription']);
// HARDWARE_CATEGORIES（M11，主会话第3批裁定）：硬件类别正向白名单，供 index.js 的
//   mark_status/retire 动作适用判定改用"正向枚举硬件类别"而非"排除软件类别"（同一份判据的
//   两种写法，正向枚举更直接反映方案 §4"任意硬件类别"的字面表述）。
const HARDWARE_CATEGORIES = ['server', 'disk', 'laptop', 'desktop', 'ap', 'other'];
const DEPOT_STATUSES = ['in_depot', 'faulty', 'to_retire'];

// §2.7 attrs 冻结键集合（方案原文逐字）。
const ATTRS_ALLOWED_KEYS = {
  server: ['ip', 'purpose', 'os'],
  disk: ['capacity', 'interface', 'form_factor'],
  laptop: ['cpu', 'ram', 'os'],
  desktop: ['cpu', 'ram', 'os'],
  ap: ['ssid_group', 'mgmt_ip'],
  other: ['subtype', 'ip'],
  software: ['version', 'license_count', 'installed_on'],
  subscription: ['cycle', 'account_name', 'renew_method', 'vendor_portal'],
};

// placement 子对象键白名单（方案 §5 逐分支）。
const PLACEMENT_KIND_ALLOWED_KEYS = {
  rack: ['kind', 'rack_id', 'u_start'],
  host: ['kind', 'parent_asset_id', 'slot_no'],
  custodian: ['kind', 'custodian_user_id', 'custodian_name', 'location_text'],
  place: ['kind', 'location_text'],
  room: ['kind', 'floor_id', 'room_id', 'pos'],
  depot: ['kind', 'status'],
};

// ============================================================
// 一、通用助手
// ============================================================

function isValidYmd(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  if (d < 1) return false;
  // 该月最后一天（UTC 计算，避免本地时区跨日问题）。
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

function badField(field, message, extra) {
  return Object.assign({ ok: false, code: 'LEDGER_BAD_REQUEST', field, message, status: 400 }, extra || {});
}

// 规则违反对象的简写（rule 内部用；顶层字段与 badField 同形，故意不复用 badField 的 ok:false
// 键，因为 validateAssetInvariants 的返回契约是"null=通过，否则是违反对象本身"，不带 ok 字段）。
function v(field, message, extra) {
  return Object.assign({ code: 'LEDGER_BAD_REQUEST', field, message, status: 400 }, extra || {});
}

// ============================================================
// 二、normalizeAssetFields（登记/编辑共用，只校验"给出的键"，不做默认值填充——
//   默认值由调用方决定：登记传 {} / null 等默认后调用；编辑只传本次请求体里出现的键）
// ============================================================
// S-H3（Opus 预筛 2026-09-19）：字符串或 null 的通用字段闸——对象/数组/数字等非字符串非 null
//   值一律 400。这些字段本身没有格式约束（不像 sn/asset_no 需要 trim+归一），只需要类型正确。
const STRING_OR_NULL_FIELDS = ['brand', 'model', 'note', 'owner_name', 'owner_dept', 'fin_vendor', 'fin_contract_no'];

function normalizeAssetFields(category, fields) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);

  if (has('name')) {
    const nameVal = fields.name;
    if (typeof nameVal !== 'string' || nameVal.trim() === '') return badField('name', 'name 必须是非空字符串');
    out.name = nameVal;
  }
  for (const f of STRING_OR_NULL_FIELDS) {
    if (has(f)) {
      const val = fields[f];
      if (val !== null && typeof val !== 'string') return badField(f, `${f} 必须是字符串或 null`);
      out[f] = val;
    }
  }
  // S-L10：custodian_name 空串在写入路径归一为 null（下游 CUSTODIAN_CONDITIONAL 规则只认
  //   null，不再自己特判空串）。
  if (has('custodian_name')) {
    let cn = fields.custodian_name;
    if (cn !== null) {
      if (typeof cn !== 'string') return badField('custodian_name', 'custodian_name 必须是字符串或 null');
      cn = cn.trim();
      cn = cn === '' ? null : cn;
    }
    out.custodian_name = cn;
  }
  if (has('fin_amount')) {
    const val = fields.fin_amount;
    if (val !== null && (typeof val !== 'number' || !Number.isFinite(val))) {
      return badField('fin_amount', 'fin_amount 必须是数值或 null');
    }
    out.fin_amount = val;
  }

  if (has('sn')) {
    let sn = fields.sn;
    if (sn !== null) {
      if (typeof sn !== 'string') return badField('sn', 'sn 必须是字符串或 null');
      sn = sn.trim();
      sn = sn === '' ? null : sn.toUpperCase();
    }
    out.sn = sn;
  }
  if (has('asset_no')) {
    let assetNo = fields.asset_no;
    if (assetNo !== null) {
      if (typeof assetNo !== 'string') return badField('asset_no', 'asset_no 必须是字符串或 null');
      assetNo = assetNo.trim();
      assetNo = assetNo === '' ? null : assetNo;
    }
    out.asset_no = assetNo;
  }
  if (has('attrs')) {
    const attrs = fields.attrs;
    if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) {
      return badField('attrs', 'attrs 必须是对象');
    }
    const allowedKeys = ATTRS_ALLOWED_KEYS[category] || [];
    const extra = Object.keys(attrs).filter((k) => !allowedKeys.includes(k));
    if (extra.length > 0) return badField('attrs', `attrs 含该类别不允许的键: ${extra.join(',')}`);
    out.attrs = attrs;
  }
  for (const dateField of ['expires_at', 'purchased_at']) {
    if (has(dateField)) {
      const val = fields[dateField];
      if (val !== null && !isValidYmd(val)) {
        return badField(dateField, `${dateField} 必须是 null 或 YYYY-MM-DD 格式的合法日期`);
      }
      out[dateField] = val;
    }
  }
  for (const intField of ['slot_count', 'u_height']) {
    if (has(intField)) {
      const val = fields[intField];
      // S-M1（Opus 复看第5批）：Number.isInteger 允许超出安全范围的巨大浮点数（如 2**60），
      //   升级为 isSafeNonNegInt——与 invariants 层的 NUMERIC_DOMAIN 规则同一份判据。
      if (!isSafeNonNegInt(val)) return badField(intField, `${intField} 必须是安全整数(Number.isSafeInteger)且 ≥0`);
      out[intField] = val;
    }
  }
  return { ok: true, values: out };
}

// ============================================================
// 三、deriveInitialState（登记 placement 六分支，方案 §5 逐字）
// ============================================================
function emptyLocationState() {
  return {
    status: null, rack_id: null, u_start: null, location_text: null,
    floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null,
    custodian_user_id: null, custodian_name: null,
  };
}

function categoryAllowedKinds(category, uHeight) {
  switch (category) {
    case 'server': return ['rack', 'depot'];
    case 'disk': return ['host', 'depot'];
    case 'laptop':
    case 'desktop': return ['custodian', 'depot'];
    case 'ap': return ['room', 'depot'];
    case 'other': return (Number(uHeight) > 0) ? ['rack', 'depot'] : ['place', 'depot'];
    case 'software':
    case 'subscription': return [];
    default: return null;
  }
}

// deriveInitialState(category, placementInput, opts)
//   opts.uHeight：'other' 类别判宿主/机柜资格分支需要的已规范化 u_height 值。
//   返回 { ok:true, state, kind, needsHostStatus? } 或 { ok:false, code, field, message, status }。
//   kind='host' 时 state.status 恒为 null 且 needsHostStatus=true——disk 的最终 status 跟随宿主
//   实际状态，必须由调用方在事务内读到宿主行之后回填（方案 §5"硬盘 status 跟随宿主"），本函数
//   不访问数据库，无法在此刻决定该值。
function deriveInitialState(category, placementInput, opts) {
  opts = opts || {};
  if (!CATEGORY_VALUES.includes(category)) return badField('category', `未知类别: ${category}`);

  if (SOFTWARE_LIKE.has(category)) {
    if (placementInput !== undefined && placementInput !== null) {
      return badField('placement', 'software/subscription 不接受 placement');
    }
    const state = emptyLocationState();
    state.status = 'active';
    return { ok: true, state, kind: null };
  }

  const allowedKinds = categoryAllowedKinds(category, opts.uHeight);

  let placement = placementInput;
  if (placement === undefined || placement === null) {
    placement = { kind: 'depot', status: 'in_depot' };
  }
  if (typeof placement !== 'object' || Array.isArray(placement)) {
    return badField('placement', 'placement 必须是对象');
  }
  const kind = placement.kind;
  if (typeof kind !== 'string' || !PLACEMENT_KIND_ALLOWED_KEYS[kind]) {
    return badField('placement.kind', `未知 placement.kind: ${kind}`);
  }
  if (!allowedKinds.includes(kind)) {
    return badField('placement.kind', `类别 ${category} 不支持 placement.kind=${kind}`, { code: 'INVALID_PLACEMENT_COMBO' });
  }
  const allowedSubKeys = PLACEMENT_KIND_ALLOWED_KEYS[kind];
  const extraKeys = Object.keys(placement).filter((k) => !allowedSubKeys.includes(k));
  if (extraKeys.length > 0) return badField('placement', `placement 含未知键: ${extraKeys.join(',')}`);

  const state = emptyLocationState();

  if (kind === 'rack') {
    const { rack_id, u_start } = placement;
    if (!Number.isInteger(rack_id) || rack_id <= 0) return badField('placement.rack_id', 'rack_id 必须是正整数');
    // S-M1：u_start 属于五个数值域字段之一，升级为安全整数判据。
    if (!isSafePosInt(u_start)) return badField('placement.u_start', 'u_start 必须是安全整数(Number.isSafeInteger)且 ≥1');
    state.status = 'in_service';
    state.rack_id = rack_id;
    state.u_start = u_start;
    return { ok: true, state, kind };
  }

  if (kind === 'host') {
    const { parent_asset_id, slot_no } = placement;
    if (!Number.isInteger(parent_asset_id) || parent_asset_id <= 0) {
      return badField('placement.parent_asset_id', 'parent_asset_id 必须是正整数');
    }
    // S-M1：slot_no 同样升级为安全整数判据。
    if (!isSafePosInt(slot_no)) return badField('placement.slot_no', 'slot_no 必须是安全整数(Number.isSafeInteger)且 ≥1');
    state.parent_asset_id = parent_asset_id;
    state.slot_no = slot_no;
    state.status = null; // 调用方读宿主后回填
    return { ok: true, state, kind, needsHostStatus: true };
  }

  if (kind === 'custodian') {
    const { custodian_user_id, custodian_name, location_text } = placement;
    if (custodian_user_id !== undefined && custodian_user_id !== null
      && !(Number.isInteger(custodian_user_id) && custodian_user_id > 0)) {
      return badField('placement.custodian_user_id', 'custodian_user_id 必须是正整数');
    }
    if (custodian_name !== undefined && custodian_name !== null && typeof custodian_name !== 'string') {
      return badField('placement.custodian_name', 'custodian_name 必须是字符串');
    }
    if (location_text !== undefined && location_text !== null && typeof location_text !== 'string') {
      return badField('placement.location_text', 'location_text 必须是字符串');
    }
    state.status = 'in_service';
    state.custodian_user_id = custodian_user_id === undefined ? null : custodian_user_id;
    state.custodian_name = custodian_name === undefined ? null : custodian_name;
    state.location_text = location_text === undefined ? null : location_text;
    return { ok: true, state, kind };
  }

  if (kind === 'place') {
    const { location_text } = placement;
    if (typeof location_text !== 'string' || location_text.trim() === '') {
      return badField('placement.location_text', 'location_text 必须是非空字符串');
    }
    state.status = 'in_service';
    state.location_text = location_text;
    return { ok: true, state, kind };
  }

  if (kind === 'room') {
    const { floor_id, room_id } = placement;
    let pos = placement.pos;
    if (typeof floor_id !== 'string' || floor_id === '') return badField('placement.floor_id', 'floor_id 必须是非空字符串');
    if (typeof room_id !== 'string' || room_id === '') return badField('placement.room_id', 'room_id 必须是非空字符串');
    if (pos === undefined) pos = { x: 0.5, y: 0.5 };
    if (typeof pos !== 'object' || pos === null || Array.isArray(pos)) return badField('placement.pos', 'pos 必须是对象');
    const posKeys = Object.keys(pos);
    if (posKeys.length !== 2 || !('x' in pos) || !('y' in pos)) return badField('placement.pos', 'pos 必须恰含 x/y');
    for (const k of ['x', 'y']) {
      const val = pos[k];
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) {
        return badField('placement.pos', `pos.${k} 必须是 [0,1] 闭区间有限数`);
      }
    }
    state.status = 'in_service';
    state.floor_id = floor_id;
    state.room_id = room_id;
    state.pos = pos;
    return { ok: true, state, kind };
  }

  if (kind === 'depot') {
    const status = placement.status === undefined ? 'in_depot' : placement.status;
    if (!DEPOT_STATUSES.includes(status)) {
      return badField('placement.status', `depot 的 status 必须 ∈ {${DEPOT_STATUSES.join(',')}}`);
    }
    state.status = status;
    return { ok: true, state, kind };
  }

  return badField('placement.kind', `未处理的 kind: ${kind}`);
}

// ============================================================
// 四、validatePeerVersions（方案 §5"placement=host 的版本闭环"）
// ============================================================
function validatePeerVersions(kind, peerVersions, parentAssetId) {
  const isHost = kind === 'host';
  if (!isHost) {
    // S-L1（Opus 复看第5批）：非 host 分支只认"字面缺省"（undefined）为省略——此前 null 被当成
    //   等价于 undefined 静默放行，改为只有 undefined 才算缺省，null/数组/非空对象一律 400。
    //   空对象 {} 仍按方案字面"必须缺省或为空对象"放行。
    if (peerVersions === undefined) return { ok: true };
    if (peerVersions !== null && typeof peerVersions === 'object' && !Array.isArray(peerVersions)
      && Object.keys(peerVersions).length === 0) {
      return { ok: true };
    }
    return badField('peer_versions', '非 host placement 下 peer_versions 必须缺省(undefined)或为空对象，null/数组/非空对象均不允许');
  }
  if (peerVersions === undefined || peerVersions === null
    || typeof peerVersions !== 'object' || Array.isArray(peerVersions)) {
    return badField('peer_versions', 'placement=host 时 peer_versions 必填');
  }
  const keys = Object.keys(peerVersions);
  if (keys.length !== 1 || keys[0] !== String(parentAssetId)) {
    return badField('peer_versions', `peer_versions 必须恰含 parent_asset_id(${parentAssetId}) 一键`);
  }
  const versionVal = peerVersions[keys[0]];
  if (!Number.isInteger(versionVal)) return badField('peer_versions', 'peer_versions 的版本值必须是整数');
  return { ok: true, expectedVersion: versionVal };
}

// ============================================================
// 五、validateRoomsArray（方案 §2.2b rooms 元素校验）
// ============================================================
const ROOM_ALLOWED_KEYS = ['id', 'name', 'w', 'h', 'corridor'];
function validateRoomsArray(rooms) {
  if (!Array.isArray(rooms)) return badField('rooms', 'rooms 必须是数组');
  const seenIds = new Set();
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) return badField(`rooms[${i}]`, 'room 元素必须是对象');
    const extra = Object.keys(r).filter((k) => !ROOM_ALLOWED_KEYS.includes(k));
    if (extra.length > 0) return badField(`rooms[${i}]`, `room 含未知键: ${extra.join(',')}`);
    if (typeof r.id !== 'string' || r.id === '') return badField(`rooms[${i}].id`, 'id 必须是非空字符串');
    if (seenIds.has(r.id)) return badField(`rooms[${i}].id`, 'id 楼层内必须唯一');
    seenIds.add(r.id);
    if (typeof r.name !== 'string' || r.name === '') return badField(`rooms[${i}].name`, 'name 必须是非空字符串');
    for (const k of ['w', 'h']) {
      const v = r[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 500) {
        return badField(`rooms[${i}].${k}`, `${k} 必须是 0–500 之间的有限正数（单位：米）`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(r, 'corridor') && typeof r.corridor !== 'boolean') {
      return badField(`rooms[${i}].corridor`, 'corridor 必须是布尔');
    }
  }
  return { ok: true };
}

// ============================================================
// 六、validateAssetInvariants（一处真相，方案 §2.1/§2.1.1/§2.7 全量不变量）
// ============================================================
// 类别字段族矩阵（非 other，other 按 u_height 动态分两支，见 resolveFieldFamily）。
const FIELD_FAMILY_MATRIX = {
  server: { rack: true, location: false, floorFamily: false, parentFamily: false, custodianFamily: false },
  disk: { rack: false, location: false, floorFamily: false, parentFamily: true, custodianFamily: false },
  laptop: { rack: false, location: true, floorFamily: false, parentFamily: false, custodianFamily: true },
  desktop: { rack: false, location: true, floorFamily: false, parentFamily: false, custodianFamily: true },
  ap: { rack: false, location: false, floorFamily: true, parentFamily: false, custodianFamily: false },
  software: { rack: false, location: false, floorFamily: false, parentFamily: false, custodianFamily: false },
  subscription: { rack: false, location: false, floorFamily: false, parentFamily: false, custodianFamily: false },
};

function isHostEligible(row) {
  return row.category === 'server' || (row.category === 'other' && row.u_height > 0);
}

// S-M1（Opus 复看第5批）：数值域安全判据——导出供 index.js 复用（机柜 u_total 等资源自身的
//   校验入口，不经过 validateAssetInvariants 的 row/ctx，需要同一份判据，不重复维护第二份）。
function isSafeNonNegInt(n) { return Number.isSafeInteger(n) && n >= 0; }
function isSafePosInt(n) { return Number.isSafeInteger(n) && n >= 1; }

// isRackEligible（C3，方案 §2.1/§4）：**机柜资格**——与 isHostEligible（宿主资格，装盘用）是
//   两种正交资格（方案 §2.1「两种资格正交」）。u_height>0 且类别 ∈ (server, other)。
//   不要把这个和 isHostEligible(slot_count>0) 搞混——名字容易撞，函数体完全不同。
function isRackEligible(row) {
  return row.u_height > 0 && (row.category === 'server' || row.category === 'other');
}

// ============================================================
// 六之前置：validateRowSchema（C3 首件，spec §1）——「完整行 + ctx」前置形态校验器。
//   一次性声明式管住 row 的完整列集合契约与 ctx 各元素形态，业务规则（RULES）不再各自分散
//   补数值域/ctx 元素形态/null-vs-undefined（C2 九批形态类 MED 连出三轮的根因）。
//   本函数是纯函数，不访问数据库；调用方（index.js）负责把"写入前的目标态完整行"与查库得到
//   的 ctx 传进来。返回 null=通过；否则 {rule:'ROW_SCHEMA', code:'LEDGER_INTERNAL', status:500,
//   field, message}——不匹配契约一律视为调用方编程错误（500），不是用户输入错误。
// ============================================================
const ASSET_ROW_KEYS = [
  'id', 'asset_no', 'category', 'name', 'brand', 'model', 'sn', 'status',
  'slot_count', 'u_height', 'u_start', 'rack_id', 'location_text', 'floor_id',
  'room_id', 'pos', 'parent_asset_id', 'slot_no', 'custodian_user_id', 'custodian_name',
  'purchased_at', 'expires_at', 'attrs', 'fin_amount', 'fin_vendor', 'fin_contract_no',
  'note', 'version', 'created_by', 'created_at', 'updated_at',
  'owner_name', 'owner_dept', 'asset_class',
];

// schemaViolation：category(1)(2)(3)(4)——完整行契约(键集合/undefined)与 ctx 元素形态——
//   一律 500 LEDGER_INTERNAL（调用方编程错误）。
function schemaViolation(field, message) {
  return { rule: 'ROW_SCHEMA', code: 'LEDGER_INTERNAL', field, message, status: 500 };
}
// columnTypeViolation：既有 RULES 未覆盖的列的类型校验——400 LEDGER_BAD_REQUEST（用户输入
//   形态错误，不是调用方编程错误；主会话 2026-09-20 裁定新增，与 schemaViolation 区分状态码）。
function columnTypeViolation(field, message) {
  return { rule: 'ROW_SCHEMA', code: 'LEDGER_BAD_REQUEST', field, message, status: 400 };
}

function isStringOrNull(val) { return val === null || typeof val === 'string'; }
function isNumberOrStringOrNull(val) {
  return val === null || typeof val === 'string' || (typeof val === 'number' && Number.isFinite(val));
}
function isNullOrPosInt(val) { return val === null || isSafePosInt(val); }

// ASSET_COLUMN_SCHEMA（主会话 2026-09-20 裁定 A，第3批 H2 补充）：**只排除既有 RULES 真正会
//   独占拦截其反例的列**——u_height / slot_count / u_start / slot_no（NUMERIC_DOMAIN 逐条覆盖）
//   与 status / category（STATUS_DOMAIN / CATEGORY_FIELD_MATRIX）六列**故意不在本表**，若本层
//   也复核这些列的值域，会导致 C2 守卫 J 组"原始独占 + 变异后放行"判定结构性失效（本层先一步
//   500 拦下，对应 RULE 永远无法独占触发反例）。这不是"本层疏漏"，是刻意的分工边界。
//   H2 新增 expires_at / rack_id / parent_asset_id / custodian_user_id / version 五列——
//   J 组现有 mutationCases 均不依赖这五列携带"非法类型"来触发其目标 RULE（触发条件都是合法
//   类型下的业务语义违反，如 disk 携带非 null rack_id 触发 CATEGORY_FIELD_MATRIX，rack_id
//   本身是安全正整数，不受本层新增类型检查影响），加回来不冲突。id 单独在 validateRowSchema
//   里处理（唯一允许 undefined 的键，且不做任何值域校验——同样不在本表）。
const ASSET_COLUMN_SCHEMA = {
  asset_no: isStringOrNull,
  name: isStringOrNull,
  brand: isStringOrNull,
  model: isStringOrNull,
  sn: isStringOrNull,
  location_text: isStringOrNull,
  floor_id: isStringOrNull,
  room_id: isStringOrNull,
  pos: (val) => val === null || (typeof val === 'object' && !Array.isArray(val)),
  custodian_name: isStringOrNull,
  purchased_at: isStringOrNull,
  expires_at: isStringOrNull,
  attrs: (val) => typeof val === 'object' && val !== null && !Array.isArray(val),
  fin_amount: isNumberOrStringOrNull,
  fin_vendor: isNumberOrStringOrNull,
  fin_contract_no: isNumberOrStringOrNull,
  note: isStringOrNull,
  rack_id: isNullOrPosInt,
  parent_asset_id: isNullOrPosInt,
  custodian_user_id: isNullOrPosInt,
  version: isSafePosInt,
  created_by: isNullOrPosInt,
  created_at: isStringOrNull,
  updated_at: isStringOrNull,
  owner_name: isStringOrNull,
  owner_dept: isStringOrNull,
  asset_class: isStringOrNull,
};

const CTX_ALLOWED_KEYS = ['rack', 'occupiedIntervals', 'parent', 'childDisks', 'floor'];

// ownKeysEqual（S-L1，第5批）：判"obj 的自身可枚举键集合恰等于 keys"——不用 `'k' in obj`
//   （会沿原型链查找，`Object.create({u_total:42}, {extra:{value:1,enumerable:true}})` 这类
//   对象 `Object.keys` 只列出 extra，'u_total' in obj 却因原型链返回 true，原判据
//   `Object.keys(r).length===1 && isSafePosInt(r.u_total)` 会被这种对象骗过：键数量对得上
//   （凑巧都是1个自身键），u_total 读到的是原型上注入的值）。改成直接比较 Object.keys 排序后
//   的数组，只要键名对不上就判形态非法，不给原型注入留任何可乘之机。
function ownKeysEqual(obj, keys) {
  const objKeys = Object.keys(obj).sort();
  const expected = [...keys].sort();
  if (objKeys.length !== expected.length) return false;
  for (let i = 0; i < objKeys.length; i++) {
    if (objKeys[i] !== expected[i]) return false;
  }
  return true;
}

function validateRowSchema(row, ctx) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return schemaViolation('row', 'row 必须是完整资产行对象');
  }
  const keys = Object.keys(row);
  const keySet = new Set(keys);
  const expectedSet = new Set(ASSET_ROW_KEYS);
  const missing = ASSET_ROW_KEYS.filter((k) => !keySet.has(k));
  const extra = keys.filter((k) => !expectedSet.has(k));
  if (missing.length > 0) return schemaViolation(missing.length === 1 ? missing[0] : 'row', `row 缺键: ${missing.join(',')}`);
  if (extra.length > 0) return schemaViolation(extra.length === 1 ? extra[0] : 'row', `row 含未声明列: ${extra.join(',')}`);
  // (1)(2) 完整行契约：除 id 外任一列 undefined → 500；id 只判"是否允许 undefined"，
  //   不做值域校验（数值域校验不在 ROW_SCHEMA 职责范围，见上方 ASSET_COLUMN_SCHEMA 注释）。
  for (const key of ASSET_ROW_KEYS) {
    if (key === 'id') continue; // 新建时唯一允许 undefined；有值时不做值域校验。
    const val = row[key];
    if (val === undefined) return schemaViolation(key, `${key} 不允许为 undefined（漏传或未回填默认值）`);
    const checker = ASSET_COLUMN_SCHEMA[key];
    if (checker && !checker(val)) return columnTypeViolation(key, `${key} 形态非法: ${JSON.stringify(val)}`);
  }
  // M8（主会话第3批裁定）：ctx 缺失不再静默放行——validateAssetInvariants 恒传对象（safeCtx =
  //   ctx || {}），本函数走到这里理应恒收到对象；undefined/null 只可能来自绕过
  //   validateAssetInvariants 的直调（如未来误用），fail-closed 判 500，不当空对象处理。
  if (ctx === undefined || ctx === null) return schemaViolation('ctx', 'ctx 必须是对象');
  if (typeof ctx !== 'object' || Array.isArray(ctx)) return schemaViolation('ctx', 'ctx 必须是对象');
  const ctxExtra = Object.keys(ctx).filter((k) => !CTX_ALLOWED_KEYS.includes(k));
  if (ctxExtra.length > 0) return schemaViolation('ctx', `ctx 含未知键: ${ctxExtra.join(',')}`);
  if ('rack' in ctx) {
    const r = ctx.rack;
    if (!r || typeof r !== 'object' || Array.isArray(r) || !ownKeysEqual(r, ['u_total']) || !isSafePosInt(r.u_total)) {
      return schemaViolation('rack', 'ctx.rack 必须恰含 {u_total:安全正整数}');
    }
  }
  if ('occupiedIntervals' in ctx) {
    const arr = ctx.occupiedIntervals;
    if (!Array.isArray(arr)) return schemaViolation('occupiedIntervals', 'ctx.occupiedIntervals 必须是数组');
    for (const el of arr) {
      if (!Array.isArray(el) || el.length !== 3) return schemaViolation('occupiedIntervals', '元素必须是 [lo,hi,id] 三元组');
      const [lo, hi, oid] = el;
      if (!isSafePosInt(lo) || !isSafePosInt(hi) || lo > hi || !isSafePosInt(oid)) {
        return schemaViolation('occupiedIntervals', '元素 lo/hi/id 必须是安全正整数且 lo<=hi');
      }
    }
  }
  if ('parent' in ctx) {
    const p = ctx.parent;
    if (!p || typeof p !== 'object' || Array.isArray(p) || !ownKeysEqual(p, ['slot_count', 'status', 'category'])) {
      return schemaViolation('parent', 'ctx.parent 必须恰含 {slot_count,status,category}');
    }
    if (!isSafePosInt(p.slot_count)) return schemaViolation('parent', 'ctx.parent.slot_count 必须是安全正整数');
    if (typeof p.status !== 'string') return schemaViolation('parent', 'ctx.parent.status 必须是字符串');
    if (typeof p.category !== 'string') return schemaViolation('parent', 'ctx.parent.category 必须是字符串');
  }
  if ('childDisks' in ctx) {
    const arr = ctx.childDisks;
    if (!Array.isArray(arr)) return schemaViolation('childDisks', 'ctx.childDisks 必须是数组');
    for (const child of arr) {
      if (!child || typeof child !== 'object' || Array.isArray(child) || !ownKeysEqual(child, ['slot_no', 'status'])) {
        return schemaViolation('childDisks', 'ctx.childDisks 元素必须恰含 {slot_no,status}（S-H1 起注释与本层实作一致，收掉 codex 28 号 LOW）');
      }
      if (!isSafePosInt(child.slot_no)) return schemaViolation('childDisks', 'ctx.childDisks 元素的 slot_no 必须是安全正整数');
      if (typeof child.status !== 'string') return schemaViolation('childDisks', 'ctx.childDisks 元素的 status 必须是字符串');
    }
  }
  if ('floor' in ctx) {
    const f = ctx.floor;
    if (!f || typeof f !== 'object' || Array.isArray(f) || !ownKeysEqual(f, ['rooms']) || !Array.isArray(f.rooms)) {
      return schemaViolation('floor', 'ctx.floor 必须恰含 {rooms:array}');
    }
  }
  return null;
}

function resolveFieldFamily(row) {
  if (row.category === 'other') {
    return row.u_height > 0
      ? { rack: true, location: false, floorFamily: false, parentFamily: false, custodianFamily: false }
      : { rack: false, location: true, floorFamily: false, parentFamily: false, custodianFamily: false };
  }
  return FIELD_FAMILY_MATRIX[row.category] || null;
}

// 规则0：NUMERIC_DOMAIN（S-M1，Opus 复看第5批）：u_height/slot_count/slot_no/u_start 四个
//   row 侧数值字段与 ctx.rack.u_total/ctx.parent.slot_count 两个 ctx 侧数值字段必须是安全整数
//   且落在合法范围，否则一律判违反——排在所有规则最前面，避免 NaN/Infinity/超出
//   Number.MAX_SAFE_INTEGER 的畸形数字混入后续区间比较产生误判（例如 NaN < x 恒为 false，会让
//   本该拦截的越界检查静默放行）。row 侧字段是用户输入派生值 → 400 LEDGER_BAD_REQUEST；ctx 侧
//   字段来自调用方查库结果，非法说明的是"调用方传的上下文本身是脏数据"，与其它 ctx 缺失场景
//   同源处理 → ctxMissing(500)。
function ruleNumericDomain(row, ctx) {
  // M10（第3批裁定）→ 第4批 MED-1（Opus 复看）：原 S2 在此区分"键缺失(undefined)"与"显式
  //   非法值"两类，前者 ctxMissing(500)。C3 的 validateRowSchema 现在恒先于 RULES 跑（见
  //   validateAssetInvariants 首行），已经把"除 id 外任一列 undefined"统一判 500 ROW_SCHEMA
  //   拦在最前——本函数跑到这里时 u_height/slot_count/u_start/slot_no 不可能再是 undefined，
  //   原本四个 `=== undefined` 分支已是不可达死代码，已删除（第3批）。
  //   ctx 侧（rack.u_total / parent.slot_count / occupiedIntervals 元素 / childDisks 元素）
  //   的四个 ctxMissing 分支本轮（第4批）**一并删除**——validateRowSchema 对这四类 ctx 元素的
  //   形态校验更严格且更早跑到（逐元素校验键集合恰含哪些键、每个数值字段的类型），本函数这里
  //   的判据是它的真子集，永远轮不到执行，同样是不可达死代码。**ctx 形态校验的职责已完全收拢
  //   到 ROW_SCHEMA 前置层**，本函数只保留"row 自身列值存在但非法"的判据。
  if (row.u_height === null || !isSafeNonNegInt(row.u_height)) {
    return v('u_height', 'u_height 必须是安全整数且 ≥0（不可为 null）');
  }
  if (row.slot_count === null || !isSafeNonNegInt(row.slot_count)) {
    return v('slot_count', 'slot_count 必须是安全整数且 ≥0（不可为 null）');
  }
  if (row.u_start !== null && !isSafePosInt(row.u_start)) {
    return v('u_start', 'u_start 必须是 null 或安全整数且 ≥1');
  }
  if (row.slot_no !== null && !isSafePosInt(row.slot_no)) {
    return v('slot_no', 'slot_no 必须是 null 或安全整数且 ≥1');
  }
  return null;
}

// 规则1：CATEGORY_FIELD_MATRIX
function ruleCategoryFieldMatrix(row) {
  const fam = resolveFieldFamily(row);
  if (!fam) return v('category', `未知类别: ${row.category}`);
  if (!fam.rack && (row.rack_id !== null || row.u_start !== null)) {
    return v('rack_id', '该类别不允许机柜位置字段非空');
  }
  if (!fam.location && row.location_text !== null) {
    return v('location_text', '该类别不允许 location_text 非空');
  }
  if (!fam.floorFamily && (row.floor_id !== null || row.room_id !== null || row.pos !== null)) {
    return v('floor_id', '该类别不允许楼层位置字段非空');
  }
  if (!fam.parentFamily && (row.parent_asset_id !== null || row.slot_no !== null)) {
    return v('parent_asset_id', '该类别不允许父子字段非空');
  }
  if (!fam.custodianFamily && (row.custodian_user_id !== null || row.custodian_name !== null)) {
    return v('custodian_user_id', '该类别不允许保管人字段非空');
  }
  if (!isHostEligible(row) && row.slot_count !== 0) {
    return v('slot_count', '该类别不具备宿主资格，slot_count 必须为 0');
  }
  return null;
}

// ctxMissing（S-H1，Opus 预筛 2026-09-19）：调用方按 row 形态本该传却没传 ctx 时的 fail-closed
//   返回——不是放行（旧实现"ctx 缺失就跳过校验"等价于对该分支彻底放弃校验，是静默降级为不设防）。
//   500，因为"该传的上下文没传"是调用方（index.js）的编程错误，不是用户输入错误。
function ctxMissing(field, message) {
  return { code: 'LEDGER_INTERNAL', field, message: message || 'ctx 缺失', status: 500 };
}

// 规则2：AP_LOCATION_FAMILY
function ruleApLocationFamily(row, ctx) {
  if (row.category !== 'ap') return null; // 非 AP 三列恒空已由规则1覆盖
  if (row.status === 'in_service') {
    if (row.floor_id === null || row.room_id === null || row.pos === null) {
      return v('floor_id', 'AP 在位时 floor_id/room_id/pos 必须完整非空');
    }
    const pos = row.pos;
    if (typeof pos !== 'object' || pos === null || Array.isArray(pos)) return v('pos', 'pos 必须是对象');
    const keys = Object.keys(pos);
    if (keys.length !== 2 || !('x' in pos) || !('y' in pos)) return v('pos', 'pos 必须恰含 x/y');
    for (const k of ['x', 'y']) {
      const val = pos[k];
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) {
        return v('pos', `pos.${k} 必须是 [0,1] 闭区间有限数`);
      }
    }
    // S-H1：AP 在位时房间归属校验必须有 ctx.floor{rooms} 可查，缺失即 fail-closed（不是跳过）。
    if (!ctx || !ctx.floor || !Array.isArray(ctx.floor.rooms)) {
      return ctxMissing('floor', 'AP 在位校验缺少 ctx.floor{rooms}');
    }
    const room = ctx.floor.rooms.find((r) => r.id === row.room_id);
    if (!room) return { code: 'LEDGER_BAD_REQUEST', field: 'room_id', message: 'room 不属于该楼层', status: 400 };
  } else if (row.floor_id !== null || row.room_id !== null || row.pos !== null) {
    return v('floor_id', 'AP 非在位状态三列必须全空');
  }
  return null;
}

// 规则3：RACK_INTERVAL
function ruleRackInterval(row, ctx) {
  // S-L8（Opus 预筛）：原有两行判据里第一行是死代码——不论第二个子句真假，只要
  // !isHostEligible(row) 成立，第二行 `if (!isHostEligible(row)) return null;` 恒会命中并返回
  // null，第一行的额外条件从未改变过任何一次判定结果，删除。
  if (!isHostEligible(row)) return null; // rack 字段已由规则1保证为空
  if (row.status === 'in_service') {
    if (row.rack_id === null || row.u_start === null) return v('rack_id', '在位机柜设备须 rack_id/u_start 非空');
  } else {
    if (row.rack_id !== null || row.u_start !== null) return v('rack_id', '非在位机柜设备须 rack_id/u_start 为空');
    return null;
  }
  // S-H2（Opus 预筛第4批）：u_start<1 与"越顶"原是同一条"区间越界"业务规则的两支，统一用
  //   U_INTERVAL_OUT_OF_RANGE。S-M1（Opus 复看第5批）新增的 NUMERIC_DOMAIN 规则排在 RULES
  //   最前面，已经对 row.u_start 做了"安全整数且 ≥1"的校验——本函数跑到这里时 u_start<1 的
  //   情形不可能再发生（NUMERIC_DOMAIN 会先判违反），原地留一份重复判断是死代码，已删除；
  //   "越顶"这一支（下方）需要 ctx.rack.u_total 才能判，NUMERIC_DOMAIN 覆盖不到，仍在本函数。
  // S-H1：在位机柜设备的区间校验必须有 ctx.rack{u_total} 与 ctx.occupiedIntervals 数组可查，
  //   缺失即 fail-closed（不是"没有就不比对"）。
  if (!ctx || !ctx.rack || typeof ctx.rack.u_total !== 'number' || !Array.isArray(ctx.occupiedIntervals)) {
    return ctxMissing('rack', '在位机柜设备校验缺少 ctx.rack{u_total} 或 ctx.occupiedIntervals');
  }
  const uTotal = ctx.rack.u_total;
  // R-M3（codex 22-R）：越顶判据从 `(u_start + u_height - 1) > uTotal` 改写为
  //   `u_height - 1 > uTotal - u_start`——代数等价，但不先做"两个可能很大的正整数相加"，改成
  //   "两者都先各自减小"，对潜在的超大 u_total/u_start 组合更不容易在中间步骤触及数值边界
  //   （NUMERIC_DOMAIN 已保证三者都是安全整数，这里是双重防线，不是唯一防线）。
  if (row.u_height - 1 > uTotal - row.u_start) {
    return { code: 'U_INTERVAL_OUT_OF_RANGE', field: 'u_start', message: '区间超出机柜总U数', status: 409 };
  }
  const lo = row.u_start; const hi = row.u_start + row.u_height - 1;
  // S-L9（Opus 预筛）留下的"端点脏数据 fail-closed"精神仍在，但具体校验已上收到 NUMERIC_DOMAIN
  //   （R-M3，排在本规则之前跑），这里可以直接信任 ctx.occupiedIntervals 的每个元素合法，专心
  //   做区间重叠判断。
  for (const [olo, ohi, oid] of ctx.occupiedIntervals) {
    if (oid !== undefined && row.id !== undefined && oid === row.id) continue;
    if (lo <= ohi && olo <= hi) {
      return { code: 'RACK_SLOT_OCCUPIED', field: 'u_start', message: '与在位设备区间重叠', status: 409 };
    }
  }
  return null;
}

// PARENT_ALLOWED_STATUSES（S-H1 → Opus 复看第7批契约裁定）：**这不是行不变量，是「装盘」这个
//   动作本身的前置条件**——宿主允许被装盘的状态域（retired 及任何域外值均拒绝新增装盘）。
//   曾经被错误地放进 HOST_SLOT 规则里当成硬盘行的恒定校验，后果是：宿主一旦 retired，连它
//   已有的子盘做任何编辑（哪怕只改 note）都会因为"宿主状态不在允许域"而 409，且与
//   HOST_DISK_STATUS_SYNC（要求子盘 status 与宿主 status 一致，retired 宿主的子盘理应也是
//   retired）互相矛盾——一个说"宿主 retired 时子盘不能是任何状态"，另一个说"子盘必须等于宿主
//   状态"，两条规则对 retired 宿主的子盘行永远判违反，形成无出口的受困态（子盘一旦跟着宿主
//   进入 retired，从此任何编辑都过不了 invariants）。
//   正确定位：这个状态域只在"要不要允许这次装盘动作发生"时刻检查一次（登记 host 分支、未来
//   C4 disk_mount 动作），不属于资产行本身必须永远满足的不变量。导出常量供调用方
//   （index.js 登记路径、未来 C4）在调用 validateAssetInvariants 之前单独校验。
const PARENT_ALLOWED_STATUSES = ['in_service', 'in_depot', 'faulty', 'to_retire'];

// 规则4：HOST_SLOT（硬盘行视角）——只保留"这一行本身内部自洽"的校验：parent 引用存在 / 禁
//   自引用 / slot 范围合法 / parent 有宿主资格 / disk.status 与 parent.status 同步（含双方
//   都是 retired 的情况——退役宿主的已有子盘保持"跟随退役"是自洽的，不该被拦）。宿主是否
//   处于"允许被新装盘"的状态域，是装盘动作的前置条件，已移交调用方（见上方 PARENT_ALLOWED_
//   STATUSES 注释），本规则不再判断。
function ruleHostSlot(row, ctx) {
  if (row.category !== 'disk') return null;
  const hasParent = row.parent_asset_id !== null;
  const hasSlot = row.slot_no !== null;
  if (hasParent !== hasSlot) return v('parent_asset_id', 'parent_asset_id 与 slot_no 必须同有同无');
  if (!hasParent) return null;
  if (row.id !== undefined && row.parent_asset_id === row.id) return v('parent_asset_id', '禁止自引用');
  if (row.slot_no < 1) return v('slot_no', 'slot_no 必须 ≥1');
  const parent = ctx && ctx.parent;
  // S-M4（Opus 复看第5批）：ctx.parent 缺失走统一的 ctxMissing fail-closed（500），不再用业务
  //   400（'宿主上下文缺失'原是 v() 默认 400 语义，但这是调用方没传 ctx 的编程错误，不是用户
  //   输入错误，应与其它 ctx 缺失场景同源处理）。
  if (!parent) return ctxMissing('parent', '宿主上下文缺失(ctx.parent)');
  if (!(parent.slot_count > 0)) return v('parent_asset_id', '宿主 slot_count 必须 >0');
  if (row.slot_no > parent.slot_count) return v('slot_no', 'slot_no 超出宿主 slot_count');
  // 硬盘 status 必须与宿主 status 同步（含双方都是 retired 的情况）——这是行内自洽的校验，
  //   与"宿主是否允许被新装盘"（PARENT_ALLOWED_STATUSES，动作前置条件）是两回事。
  if (row.status !== parent.status) {
    return { code: 'HOST_DISK_STATUS_SYNC', field: 'status', message: `硬盘 status(${row.status}) 必须与宿主 status(${parent.status}) 一致`, status: 409 };
  }
  return null;
}

// 规则X（新增）：HOST_DISK_STATUS_SYNC——宿主行自身视角的校验：其全部随装子盘的 status 必须
//   与宿主 status 一致（与 ruleHostSlot 是同一条业务约束的两个观察点：一个从子盘看父，一个从
//   父看全部子盘；独立规则名是为了 J 组变异测试能各自独占定位，coordinator 明确"选独立规则名
//   便于变异"）。
function ruleHostDiskStatusSync(row, ctx) {
  if (!isHostEligible(row)) return null;
  if (!ctx || !Array.isArray(ctx.childDisks)) {
    return ctxMissing('childDisks', '宿主资格校验缺少 ctx.childDisks 数组');
  }
  for (const child of ctx.childDisks) {
    if (typeof child.status !== 'string') {
      return ctxMissing('childDisks', '子盘上下文缺少 status 字段(ctx.childDisks 元素须为 {slot_no, status})');
    }
    if (child.status !== row.status) {
      return {
        code: 'HOST_DISK_STATUS_SYNC', field: 'slot_no',
        message: `子盘(slot_no=${child.slot_no}) status(${child.status}) 与宿主 status(${row.status}) 不一致`,
        status: 409,
      };
    }
  }
  return null;
}

// 规则5：CUSTODIAN_CONDITIONAL（终端在位无保管人 / 非在位带保管人均判 409，同 §13 group D 措辞）
function ruleCustodianConditional(row) {
  const eligible = row.category === 'laptop' || row.category === 'desktop';
  if (!eligible) return null;
  // S-L10（Opus 预筛）：'' 曾在这里被内联特判成"等同 null"——正确做法是在数据进入系统时（写入
  //   路径，见 normalizeAssetFields 的 custodian_name 分支）就把空串归一成 null，规则本身只认
  //   null，不再自己猜测"空串算不算有"。
  const hasCustodian = row.custodian_user_id !== null || row.custodian_name !== null;
  if (row.status === 'in_service') {
    if (!hasCustodian) return { code: 'CUSTODIAN_REQUIRED', field: 'custodian_user_id', message: '在位终端须指定保管人', status: 409 };
  } else if (hasCustodian) {
    return { code: 'CUSTODIAN_REQUIRED', field: 'custodian_user_id', message: '非在位终端不得带保管人', status: 409 };
  }
  return null;
}

// 规则6：SLOT_COUNT_FLOOR
function ruleSlotCountFloor(row, ctx) {
  if (!isHostEligible(row)) return null;
  // S-H1：宿主资格资产的 slot_count 下限校验必须有 ctx.childDisks 数组可查（登记路径无子盘时
  //   调用方应显式传 []，不是省略这个键）——缺失即 fail-closed，不是当空数组处理。
  if (!ctx || !Array.isArray(ctx.childDisks)) {
    return ctxMissing('childDisks', '宿主资格校验缺少 ctx.childDisks 数组（登记路径无子盘应传空数组）');
  }
  const childSlots = ctx.childDisks.map((d) => d.slot_no);
  const maxSlot = childSlots.length ? Math.max(...childSlots) : 0;
  if (row.slot_count < maxSlot) {
    return { code: 'SLOT_COUNT_BELOW_OCCUPIED', field: 'slot_count', message: 'slot_count 低于已占用最大 slot_no', status: 409 };
  }
  if (childSlots.length > 0 && row.slot_count === 0) {
    return { code: 'SLOT_COUNT_BELOW_OCCUPIED', field: 'slot_count', message: '带随装盘时 slot_count 不得为 0', status: 409 };
  }
  return null;
}

// 规则7：STATUS_DOMAIN
function ruleStatusDomain(row) {
  const isSoftwareLike = SOFTWARE_LIKE.has(row.category);
  const domain = isSoftwareLike ? SOFTWARE_STATUSES : HARDWARE_STATUSES;
  if (!domain.includes(row.status)) return v('status', 'status 不属于该类别允许的状态集合');
  return null;
}

// 规则8：EXPIRES_REQUIRED
function ruleExpiresRequired(row) {
  if (row.category === 'subscription' && !row.expires_at) return v('expires_at', 'subscription 必须填写 expires_at');
  return null;
}

// 规则9：U_HEIGHT_DOMAIN
function ruleUHeightDomain(row) {
  if (row.category === 'server') {
    if (!(row.u_height >= 1 && row.u_height <= 8)) return v('u_height', 'server 的 u_height 必须在 1–8 闭区间');
    return null;
  }
  if (row.category === 'other') {
    if (!(row.u_height >= 0)) return v('u_height', 'u_height 必须 ≥0');
    return null;
  }
  if (row.u_height !== 0) return v('u_height', '该类别 u_height 必须恒为 0');
  return null;
}

const RULES = [
  { name: 'NUMERIC_DOMAIN', fn: ruleNumericDomain },
  { name: 'CATEGORY_FIELD_MATRIX', fn: ruleCategoryFieldMatrix },
  { name: 'AP_LOCATION_FAMILY', fn: ruleApLocationFamily },
  { name: 'RACK_INTERVAL', fn: ruleRackInterval },
  { name: 'HOST_SLOT', fn: ruleHostSlot },
  { name: 'CUSTODIAN_CONDITIONAL', fn: ruleCustodianConditional },
  { name: 'SLOT_COUNT_FLOOR', fn: ruleSlotCountFloor },
  { name: 'HOST_DISK_STATUS_SYNC', fn: ruleHostDiskStatusSync },
  { name: 'STATUS_DOMAIN', fn: ruleStatusDomain },
  { name: 'EXPIRES_REQUIRED', fn: ruleExpiresRequired },
  { name: 'U_HEIGHT_DOMAIN', fn: ruleUHeightDomain },
];

// validateAssetInvariants(row, ctx) → null（通过）| 违反对象（{rule, code, field, message, status}）
//   row：完整资产行（写入前的目标态，含 id——新建时 undefined）。
//   ctx：{ rack?:{u_total}, occupiedIntervals?:[[lo,hi,assetId]], parent?:{slot_count,status,category},
//         floor?:{rooms:[...]}, childDisks?:[{slot_no, status}]（S-H1 起 status 必填，供
//         HOST_DISK_STATUS_SYNC 核对子盘状态与宿主一致） }
function validateAssetInvariants(row, ctx) {
  // LOW-2（第4批 Opus 复看）：不再用 `ctx || {}` 悄悄兜底——index.js 全部 7 个调用点（登记/
  // 编辑/finishHostSyncedAction 主行+子盘/rack_move/rack_relocate/retire）都显式传对象，
  // 从未依赖过这层兜底；透传原始 ctx，undefined/null 由 validateRowSchema（M8）判 500
  // ROW_SCHEMA field='ctx'，比"悄悄替换成空对象、让后续规则各自再猜"更 fail-closed。
  // C3 首件：先跑「完整行+ctx」前置形态校验器（不进 RULES 数组，J 组规则名对拍表零改动）。
  const schemaResult = validateRowSchema(row, ctx);
  if (schemaResult) return schemaResult;
  for (const rule of RULES) {
    const violation = rule.fn(row, ctx);
    if (violation) return Object.assign({ rule: rule.name }, violation);
  }
  return null;
}

module.exports = {
  CATEGORY_VALUES,
  HARDWARE_CATEGORIES,
  HARDWARE_STATUSES,
  SOFTWARE_STATUSES,
  DEPOT_STATUSES,
  ATTRS_ALLOWED_KEYS,
  PLACEMENT_KIND_ALLOWED_KEYS,
  ROOM_ALLOWED_KEYS,
  isValidYmd,
  normalizeAssetFields,
  deriveInitialState,
  validatePeerVersions,
  validateRoomsArray,
  validateAssetInvariants,
  isHostEligible,
  isRackEligible,
  isSafeNonNegInt,
  isSafePosInt,
  PARENT_ALLOWED_STATUSES,
  RULES,
  ASSET_ROW_KEYS,
  ASSET_COLUMN_SCHEMA,
  validateRowSchema,
};
