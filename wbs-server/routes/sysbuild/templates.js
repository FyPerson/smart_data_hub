// routes/sysbuild/templates.js — 项目管理（系统建设记录）模块：默认批次与节点模板（C3a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.3（默认批次）、§3（节点模板与环节映射）、§6.2（sysbuild_batches / sysbuild_nodes）。
//   派单 = docs/local/系统建设记录/送审准备/C3a_批次节点排期_派单_20261030.md §3.3。
//
// 本文件 = 纯数据（节点模板、G 环节取值集合）+ 一个事务内助手 seedProjectStructure。
//   seedProjectStructure 只在建项事务（projects.js 的 POST /sysbuild/projects）里、ensurePmMemberRow 之后调用，与建项同一事务：
//   建项失败整体回滚，不会留下只有项目没有批次 / 节点的半成品。
// 第一期不生成 G7 后评价节点（方案 §3.2、D35）；项目层节点的采购与合同只在外包 / 采购两类建设方式生成。
'use strict';
const { makeError } = require('./db');
const { writeEvent } = require('./events');

// 自定义节点可选的 g_stage 取值集合（单值，可空）。合并节点的 g_stage（如 'G2+G3'）只来自模板，不对自定义节点开放。
const G_STAGES = Object.freeze(['G0', 'CONTRACT', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);

// 项目层节点（batch_id 为空）。sort_order 固定 10/20/30/40：自研没有 p_contract 时留空档，位置不随建设方式移动。
const PROJECT_NODES = Object.freeze([
  Object.freeze({ key: 'p_initiation', name: '立项与授权', g: 'G0', sort: 10, types: Object.freeze(['outsource', 'procurement', 'inhouse']) }),
  Object.freeze({ key: 'p_contract', name: '采购与合同', g: 'CONTRACT', sort: 20, types: Object.freeze(['outsource', 'procurement']) }),
  Object.freeze({ key: 'p_overall', name: '总体范围与批次规划', g: 'G1', sort: 30, types: Object.freeze(['outsource', 'procurement', 'inhouse']) }),
  Object.freeze({ key: 'p_closing', name: '整体验收结项', g: 'G6', sort: 40, types: Object.freeze(['outsource', 'procurement', 'inhouse']) }),
]);

// 批次层节点（挂默认批次）。顺序即 sort_order 10、20…；milestone = 正式上线里程碑（每批恰一个）。
const n = (key, name, g, milestone) => Object.freeze({ key, name, g, milestone: milestone === true });
const BATCH_NODES = Object.freeze({
  outsource: Object.freeze([
    n('b_req', '需求确认', 'G1'),
    n('b_design', '原型 / 设计确认', 'G2'),
    n('b_dev', '开发完成', 'G3'),
    n('b_test', '测试完成', 'G4'),
    n('b_uat', '用户验收测试', 'G4'),
    n('b_golive', '上线', 'G5'),
    n('b_trial', '试运行结束（正式上线）', 'G5', true),
  ]),
  procurement: Object.freeze([
    n('b_req', '需求调研', 'G1'),
    n('b_config', '系统配置（含设计与开发）', 'G2+G3'),
    n('b_training', '用户培训（含测试与验收）', 'G4'),
    n('b_golive', '上线', 'G5'),
    n('b_trial', '试运行结束（正式上线）', 'G5', true),
  ]),
  inhouse: Object.freeze([
    n('b_req', '需求确认', 'G1'),
    n('b_dev', '开发完成（含设计）', 'G2+G3'),
    n('b_golive', '上线（含测试与验收）', 'G4+G5', true),
  ]),
});

const DEFAULT_BATCH_NAME = '第 1 批';

// 在建项事务里带出默认批次 + 项目层节点 + 默认批次的批次层节点，并各写事件。q = withWriteTxn 回调给的查询助手。
//   事件：batch_created ×1；node_created × 节点数（payload：template_key、name、g_stage、batch_id、is_golive_milestone、source='template'）。
async function seedProjectStructure(q, args) {
  const { projectId, buildType, operatorId, operatorName } = args;
  if (!Object.prototype.hasOwnProperty.call(BATCH_NODES, buildType)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：建设方式没有节点模板');
  const bIns = await q.run(
    "INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, 1, ?, 1, 'planning')",
    [projectId, DEFAULT_BATCH_NAME]
  );
  const batchId = bIns.lastID;
  await writeEvent(q, {
    projectId, objectType: 'batch', objectId: batchId, eventType: 'batch_created',
    payload: { seq: 1, name: DEFAULT_BATCH_NAME, is_default: true }, operatorId, operatorName,
  });
  const insertNode = async (batchRef, def, sortOrder, milestone) => {
    const ins = await q.run(
      'INSERT INTO sysbuild_nodes (project_id, batch_id, template_key, name, g_stage, sort_order, is_golive_milestone) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [projectId, batchRef, def.key, def.name, def.g, sortOrder, milestone ? 1 : 0]
    );
    await writeEvent(q, {
      projectId, objectType: 'node', objectId: ins.lastID, eventType: 'node_created',
      payload: { template_key: def.key, name: def.name, g_stage: def.g, batch_id: batchRef, is_golive_milestone: milestone, source: 'template' },
      operatorId, operatorName,
    });
    return ins.lastID;
  };
  for (const def of PROJECT_NODES) {
    if (def.types.includes(buildType)) await insertNode(null, def, def.sort, false);
  }
  let order = 0;
  for (const def of BATCH_NODES[buildType]) {
    order += 10;
    await insertNode(batchId, def, order, def.milestone);
  }
  return batchId;
}

module.exports = { G_STAGES, PROJECT_NODES, BATCH_NODES, DEFAULT_BATCH_NAME, seedProjectStructure };
