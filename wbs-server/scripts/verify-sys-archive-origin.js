'use strict';
const assert = require('node:assert/strict');
const startFixture = require('./lib/sys-archive-origin-fixture');
const { SAFE_PORT_MIN, SAFE_PORT_MAX } = require('./lib/listen-safe-port');
const expected = ['new_business','process_improvement','rule_change','system_defect','external_system','historical_data','operation_process','routine_maintenance','other'];

(async () => {
  const f = await startFixture(); let pass = 0;
  const check = (name, yes) => { assert.ok(yes, name); pass++; console.log('[OK] ' + name); };
  const snapshot = async id => ({ issue: await f.get('SELECT * FROM sys_issues WHERE id=?', [id]), events: await f.all('SELECT * FROM sys_issue_timeline WHERE issue_id=? ORDER BY id', [id]) });
  try {
    check('独占测试端口避开Fetch禁止端口', Number(new URL(f.base).port) >= SAFE_PORT_MIN && Number(new URL(f.base).port) <= SAFE_PORT_MAX);
    const meta = await f.api('GET', '/sys-issues/meta');
    assert.deepEqual(meta.body.archiveOriginReasons.map(r => r.code), expected); check('九类原因不缺不多', true);
    for (const type of ['bug','feature','improvement','config']) {
      const id = await f.seed(type);
      for (const [body, code] of [[{},'ARCHIVE_ORIGIN_REQUIRED'], [{archive_origin_code:''},'ARCHIVE_ORIGIN_REQUIRED'], [{archive_origin_code:'invented'},'ARCHIVE_ORIGIN_INVALID'], [{archive_origin_code:1},'ARCHIVE_ORIGIN_INVALID'], [{archive_origin_code:'other',archive_origin_note:' \n '},'ARCHIVE_ORIGIN_NOTE_REQUIRED'], [{archive_origin_code:'other',archive_origin_note:[]},'ARCHIVE_ORIGIN_NOTE_INVALID'], [{archive_origin_code:'new_business',archive_origin_note:null},'ARCHIVE_ORIGIN_NOTE_INVALID'], [{archive_origin_code:'new_business',archive_origin_note:'😀'.repeat(501)},'ARCHIVE_ORIGIN_NOTE_TOO_LONG']]) {
        const before = await snapshot(id); const result = await f.api('POST', `/sys-issues/${id}/close`, body);
        check(type + ' 拒绝 ' + code, result.status === 400 && result.body.code === code);
        assert.deepEqual(await snapshot(id), before); check(type + ' 拒绝零写入', true);
      }
      for (const code of expected) {
        const item = await f.seed(type); const note = code === 'other' ? '1' : '';
        const result = await f.api('POST', `/sys-issues/${item}/close`, { archive_origin_code: code, archive_origin_note: note });
        check(type + ' ' + code + ' 可归档', result.status === 200);
        const state = await snapshot(item); const closes = state.events.filter(e => e.action_code === 'close');
        check('归档状态/人/时间及唯一事件', state.issue.status === '已关闭' && !!state.issue.closed_at && closes.length === 1 && closes[0].operator_id === 1 && !!closes[0].created_at);
        assert.deepEqual(JSON.parse(closes[0].payload_json).archive_origin, { version: 1, code, label: meta.body.archiveOriginReasons.find(r => r.code === code).label, note }); check('结构化快照精确一致', true);
        const detail = await f.api('GET', `/sys-issues/${item}`); check('详情可读归档快照', detail.status === 200 && detail.body.timeline.some(e => e.id === closes[0].id && e.payload_json === closes[0].payload_json));
      }
    }
    const noAuthId = await f.seed(); const initial = await snapshot(noAuthId);
    check('非管理员不得归档', (await f.api('POST', `/sys-issues/${noAuthId}/close`, { archive_origin_code:'new_business' }, 5)).status === 403);
    check('未登录不得归档', (await f.api('POST', `/sys-issues/${noAuthId}/close`, { archive_origin_code:'new_business' }, 0)).status === 401);
    assert.deepEqual(await snapshot(noAuthId), initial); check('权限失败零写入', true);
    await f.run("UPDATE sys_issues SET post_release_acceptance='pending' WHERE id=?", [noAuthId]);
    const pending = await snapshot(noAuthId); const blocked = await f.api('POST', `/sys-issues/${noAuthId}/close`, {});
    check('待补验收原错误优先保留', blocked.status === 409 && blocked.body.code === 'POST_ACCEPTANCE_PENDING');
    assert.deepEqual(await snapshot(noAuthId), pending); check('待补验收零写入', true);
    const invalidId = await f.seed('bug','待处理'); const badState = await snapshot(invalidId);
    check('非法源态保持拒绝', (await f.api('POST', `/sys-issues/${invalidId}/close`, { archive_origin_code:'other',archive_origin_note:'x' })).body.code === 'INVALID_TRANSITION');
    assert.deepEqual(await snapshot(invalidId), badState); check('非法源态零写入', true);
    const faultId = await f.seed(); const beforeFault = await snapshot(faultId);
    await f.run("CREATE TEMP TRIGGER fail_archive BEFORE INSERT ON sys_issue_timeline WHEN NEW.action_code='close' BEGIN SELECT RAISE(ABORT,'archive test fault'); END");
    const failed = await f.api('POST', `/sys-issues/${faultId}/close`, { archive_origin_code:'system_defect' });
    await f.run('DROP TRIGGER fail_archive');
    check('留痕失败返回500', failed.status === 500); assert.deepEqual(await snapshot(faultId), beforeFault); check('留痕失败回滚状态和时间', true);
    const raceId = await f.seed(); const responses = await Promise.all(['new_business','system_defect'].map(code => f.api('POST', `/sys-issues/${raceId}/close`, { archive_origin_code:code })));
    check('并发归档仅一次成功', responses.filter(r => r.status === 200).length === 1 && responses.filter(r => r.body.code === 'INVALID_TRANSITION').length === 1);
    check('并发只有一条归档快照', (await snapshot(raceId)).events.filter(e => e.action_code === 'close').length === 1);
    const cycleId = await f.seed();
    await f.run("INSERT INTO sys_issue_dev_assignees(issue_id,user_id,user_name) VALUES(?,5,'归档测试开发')", [cycleId]);
    await f.api('POST', `/sys-issues/${cycleId}/close`, { archive_origin_code:'other',archive_origin_note:'😀'.repeat(500) });
    const firstClose = (await snapshot(cycleId)).events.find(e => e.action_code === 'close'); check('500码点允许', !!firstClose);
    const reopened = await f.api('POST', `/sys-issues/${cycleId}/reopen`, { reason:'合成回归' });
    check('既有重开可用 ' + JSON.stringify(reopened), reopened.status === 200);
    await f.run("UPDATE sys_issues SET status='已上线' WHERE id=?", [cycleId]);
    check('再归档仍需重新选择', (await f.api('POST', `/sys-issues/${cycleId}/close`, {})).body.code === 'ARCHIVE_ORIGIN_REQUIRED');
    check('再归档新原因可存', (await f.api('POST', `/sys-issues/${cycleId}/close`, {archive_origin_code:'rule_change'})).status === 200);
    const cycles = (await snapshot(cycleId)).events.filter(e => e.action_code === 'close'); assert.deepEqual(cycles[0],firstClose); check('两轮快照独立旧行不改', cycles.length === 2 && JSON.parse(cycles[1].payload_json).archive_origin.code === 'rule_change');
    const legacy = await f.seed('feature','已关闭');
    await f.run("INSERT INTO sys_issue_timeline(issue_id,event_type,action_code,from_status,to_status,operator_id,operator_name) VALUES(?,'status_change','close','已上线','已关闭',1,'历史测试管理员')", [legacy]);
    const legacyDetail = await f.api('GET', `/sys-issues/${legacy}`); check('历史无原因归档正常读取不回填', legacyDetail.status === 200 && legacyDetail.body.timeline.find(e => e.action_code === 'close').payload_json === null);
    console.log(`PASS=${pass} FAIL=0`);
  } finally { await f.stop(); }
})().catch(e => { console.error(e); console.log('PASS=0 FAIL=1'); process.exitCode = 1; });
