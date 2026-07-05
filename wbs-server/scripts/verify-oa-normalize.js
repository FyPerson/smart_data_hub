/**
 * verify-oa-normalize.js（v1.99.0 OA 流程号三模块统一）
 *
 * 验证 OA 流程号归一逻辑（三模块前端 + collab 后端共用同一套正则）：
 *   oaCore(raw)            → 去掉 OA-/TEST-OA-/oa- 前缀取核心
 *   formatOaNo(raw)        → 展示用：核心非空则拼 'OA-' + 核心；空则返回 '' （不显示裸 'OA-'）
 *   canonicalizeCollabOa(raw) → collab 存储用：核心非空则规范化回 'OA-' + 核心（= 现状存储格式，零迁移）
 *
 * 这是纯逻辑单测，不需要起服务。运行：node scripts/verify-oa-normalize.js
 *
 * ⚠️ 数据修正建单字段体系优化 A 块（2026-07-05）后，Data_Correction.html 的 formatOaNo 在此基础上
 *    多加了一条 datafix- 占位号原样直显分支（详见该文件 oaCore/formatOaNo 注释），三模块不再字节一致，
 *    是有意的超集分叉，非漂移。datafix 分支的独立单测见 verify-correction-datafix-e2e.js。
 */

// —— 与两处实现保持字节一致（Data_Collab/Issue_Tracker.html + server.js；Data_Correction.html 另加 datafix 分支）——
function oaCore(raw) {
    if (raw === null || raw === undefined) return '';
    return String(raw).trim().replace(/^(test-)?oa-?/i, '').trim();
}
function formatOaNo(raw) {
    const core = oaCore(raw);
    return core ? 'OA-' + core : '';
}
function canonicalizeCollabOa(raw) {
    const core = oaCore(raw);
    return core ? 'OA-' + core : '';
}

let pass = 0, fail = 0;
function eq(actual, expected, name) {
    if (actual === expected) { pass++; }
    else { fail++; console.error(`  ✗ ${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`); }
}

// ===== formatOaNo：展示归一 =====
eq(formatOaNo('364265'), 'OA-364265', '纯数字→拼前缀');
eq(formatOaNo('OA-364265'), 'OA-364265', '已带前缀→幂等（不双前缀）');
eq(formatOaNo('oa-364265'), 'OA-364265', '小写前缀→归一');
eq(formatOaNo('OA364265'), 'OA-364265', '无连字符前缀→归一');
eq(formatOaNo('TEST-OA-123456'), 'OA-123456', 'TEST-OA- 前缀→归一');
eq(formatOaNo('test-oa-99'), 'OA-99', 'test-oa- 小写→归一');
eq(formatOaNo('C6B-001'), 'OA-C6B-001', '字母数字 OA（真实存在）→拼前缀');
eq(formatOaNo('OA-C6B-001'), 'OA-C6B-001', '字母数字已带前缀→幂等');

// ===== 空值：必须返回空白，绝不返回裸 'OA-'（用户明确要求 #5）=====
eq(formatOaNo(''), '', '空串→空白');
eq(formatOaNo(null), '', 'null→空白');
eq(formatOaNo(undefined), '', 'undefined→空白');
eq(formatOaNo('   '), '', '纯空白→空白');
eq(formatOaNo('OA-'), '', '只有前缀无核心→空白（不显示裸 OA-）');
eq(formatOaNo('oa'), '', '只有 oa 无核心→空白');
eq(formatOaNo('TEST-OA-'), '', 'TEST-OA- 无核心→空白');

// ===== oaCore：编辑回填显示核心（输入框只填数字）=====
eq(oaCore('OA-364265'), '364265', '回填取核心（带前缀）');
eq(oaCore('364265'), '364265', '回填取核心（纯数字）');
eq(oaCore('TEST-OA-123456'), '123456', '回填取核心（TEST-OA-）');
eq(oaCore(null), '', '回填 null→空');

// ===== canonicalizeCollabOa：collab 存储归一（保持现状带前缀格式）=====
eq(canonicalizeCollabOa('364265'), 'OA-364265', 'collab 纯数字→存带前缀');
eq(canonicalizeCollabOa('OA-364265'), 'OA-364265', 'collab 已带前缀→幂等（关键：不破坏历史数据/既有测试）');
eq(canonicalizeCollabOa('TEST-OA-123456'), 'OA-123456', 'collab TEST-OA-→归一');
eq(canonicalizeCollabOa(''), '', 'collab 空→空（由必填闸门拦截）');
eq(canonicalizeCollabOa('OA-'), '', 'collab 只前缀→空（必填闸门拦截）');

// ===== 唯一性收益：不同格式的同一 OA 经 canonicalize 后相等（建单防同号重复）=====
eq(canonicalizeCollabOa('364265') === canonicalizeCollabOa('OA-364265'), true, '同号不同格式→canonical 相等（唯一索引正确拦重复）');

console.log(`\nverify-oa-normalize: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
