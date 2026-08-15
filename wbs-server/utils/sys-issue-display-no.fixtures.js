// utils/sys-issue-display-no.fixtures.js —— sysIssueDisplayNo 前后端一致性 fixture
//   （方案 20260813_v1.8 §15.3 helper 契约·S12-b 批·2026-08-14）
//
// 用途：本文件是 utils/sys-derive-numbering.js#sysIssueDisplayNo 的**唯一权威样例集**——后端 verify
//   （scripts/verify-sys-derive-numbering.js）require 本文件逐行跑断言；S13 前端 display-no helper
//   落地时应同样吃这份 fixture（跨端一致性断言的物理载体，不是"抄一份改一改"），保证前后端两份各自
//   独立实现的 helper 输出逐字相同，不因各自演进而悄悄漂移（同规则禁双实现精神——helper 本身允许两份
//   独立代码，但"正确答案"只能有一份）。
//
// S13 接线提示：前端若无法直接 require 本 CommonJS 文件（浏览器打包场景），可在构建期把 module.exports
//   的数组序列化成 JSON 供前端 fixture 消费，或直接复制本文件数组字面量（不复制判定逻辑，只复制数据）；
//   核心要求是"跑的是同一组 {input, expected} 对"，不要求两端引用同一个 JS 模块实例。
//
// 每条 { label, input, expected }：input 是 sysIssueDisplayNo 的入参（只含 id/derive_root_id/derive_seq
//   三字段，任何多余字段 sysIssueDisplayNo 都会忽略——同真实 sys_issues 整行直接传入的用法一致）。
'use strict';

module.exports = [
  {
    label: '根单（从未被派生过，root/seq 双 NULL）——回退 #id 是根单的正常展示形态，非异常兜底',
    input: { id: 201, derive_root_id: null, derive_seq: null },
    expected: '#201',
  },
  {
    label: '一级派生（root=201 的第 1 个派生单）',
    input: { id: 305, derive_root_id: 201, derive_seq: 1 },
    expected: '#201_1',
  },
  {
    label: '一级派生（同族第 2 个派生单，验证 seq 变化被正确反映，非恒定 _1）',
    input: { id: 306, derive_root_id: 201, derive_seq: 2 },
    expected: '#201_2',
  },
  {
    label: '二级派生（从一级派生单再派生出来的单——root 继承展平到顶层族根 201，不是中间单的 id；本单自身 id=512 但展示号与中间单无关）',
    input: { id: 512, derive_root_id: 201, derive_seq: 3 },
    expected: '#201_3',
  },
  {
    label: '缺省回退：root/seq 两个字段在 input 里完全不存在（undefined）',
    input: { id: 99 },
    expected: '#99',
  },
  {
    label: '缺省回退：root/seq 显式传 null（等同双空）',
    input: { id: 98, derive_root_id: null, derive_seq: null },
    expected: '#98',
  },
  {
    label: '半缺回退：仅 root 有值、seq 缺省（结构异常态——真实业务中理应被 classifySysDeriveNumbering 的 halfFilled 违例拦截熔断，但 sysIssueDisplayNo 本身只负责格式化不做校验，仍需给出不炸的确定性回退）',
    input: { id: 100, derive_root_id: 50 },
    expected: '#100',
  },
  {
    label: '半缺回退：仅 seq 有值、root 缺省',
    input: { id: 101, derive_seq: 2 },
    expected: '#101',
  },
  {
    label: '零值边界：derive_seq=0（非业务真实态，seq 恒从 1 起，见 planFirstBackfillAssignments；但 0 在 JS 里是 falsy，若实现误用真值判断会把它错误当成缺省回退成 #102；本用例断言 0 被当作有值正确纳入格式化，证明实现用的是严格 null/undefined 判空而非真值判断）',
    input: { id: 102, derive_root_id: 50, derive_seq: 0 },
    expected: '#50_0',
  },
  {
    // [S13-a·LOW-3] null 边界——不是「row 的某个字段」缺省，是「row 这个入参本身」缺省（后端实现首行即
    // `if (!row) return '';`，此前 9 条用例全部传的是有效对象，从未真正触达过这一支）。前端 helper 同样
    // 须实现该分支——DTO 缺列/接口异常/尚未加载完成时把 undefined/null 直接传进 helper 是真实会发生的
    // 调用形态（非臆造边界），两端都应回退空串而非抛错或拼出 "#undefined"/"#null" 这类脏文本。
    label: 'row 入参本身为 null（非字段缺省，是整个入参缺省）——两端均应回退空串，不抛错、不拼出脏文本',
    input: null,
    expected: '',
  },
];
