/**
 * Mutex 单测（D3 模块 5 step-7）
 *
 * 验证 codex 十一审 #1 critical 修复的核心：
 *   - 等待者超时后必须从队列删除自己，不能 resolve 任何 Promise
 *   - 否则会让后续 waiter 越过仍在执行的持锁者，破坏全局互斥
 *
 * 用法：node scripts/test-mutex-unit.js
 */

'use strict';

const { _globalSmokeTestMutex: mu } = require('../utils/collab-submit-helpers');

let passed = 0, failed = 0;
const failures = [];

async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`✅ ${name}`);
    } catch (e) {
        failed++;
        failures.push({ name, error: e.message });
        console.log(`❌ ${name}: ${e.message}`);
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function main() {
    console.log('=== Mutex 单测（codex 十一审 #1 修复验证）===\n');

    // T1: 顺序拿锁
    await check('T1 顺序 acquire/release', async () => {
        const r1 = await mu.acquire(1000);
        assert(mu._stats().locked === true, 'locked should be true');
        r1();
        assert(mu._stats().locked === false, 'locked should be false after release');
    });

    // T2: 排队 FIFO
    await check('T2 排队 FIFO', async () => {
        const order = [];
        const rA = await mu.acquire(2000);
        order.push('A-acquired');

        const pB = (async () => {
            const r = await mu.acquire(2000);
            order.push('B-acquired');
            await delay(50);
            r();
            order.push('B-released');
        })();
        const pC = (async () => {
            await delay(20);  // 保证 C 排在 B 后面
            const r = await mu.acquire(2000);
            order.push('C-acquired');
            r();
            order.push('C-released');
        })();

        await delay(100);
        rA();
        order.push('A-released');
        await Promise.all([pB, pC]);

        // 期望顺序：A-acquired, A-released, B-acquired, B-released, C-acquired, C-released
        const expected = ['A-acquired', 'A-released', 'B-acquired', 'B-released', 'C-acquired', 'C-released'];
        assert(JSON.stringify(order) === JSON.stringify(expected),
            `order mismatch: ${JSON.stringify(order)}`);
    });

    // T3: 等待超时不破坏 FIFO（critical case）
    await check('T3 等待超时不让后续 waiter 越权', async () => {
        const rA = await mu.acquire(5000);
        assert(mu._stats().locked === true, 'A should hold lock');

        // B 等很短就超时
        const pB = mu.acquire(200).catch(e => `B-timeout-${e.code}`);
        // C 等更长，能等到 A release
        const pC = (async () => {
            const r = await mu.acquire(3000);
            const state = mu._stats();
            r();
            return { state, msg: 'C-acquired' };
        })();

        // 等到 B 已超时
        const bRes = await pB;
        assert(bRes === 'B-timeout-SMOKE_MUTEX_WAIT_TIMEOUT',
            `B should timeout: got ${bRes}`);

        // ⚠️ critical check：B 超时后 locked 仍必须为 true（A 还持锁）
        const midState = mu._stats();
        assert(midState.locked === true,
            `B 超时不能让 locked 变 false (got ${JSON.stringify(midState)})`);
        // C 仍在队列里等
        assert(midState.waiters === 1,
            `B 超时后 C 应仍在等（waiters=1，实际 ${midState.waiters}）`);

        // A 释放
        rA();
        const cRes = await pC;
        assert(cRes.msg === 'C-acquired', `C should be acquired after A release`);
        assert(mu._stats().locked === false, `final locked should be false`);
    });

    // T5: release 重复调用不会越锁（codex 十二审推荐补单测）
    await check('T5 release 重复调用不会唤醒多个 waiter', async () => {
        const rA = await mu.acquire(2000);
        assert(mu._stats().locked === true, 'A holds lock');

        // 后面排两个 waiter
        const acquiredOrder = [];
        const pB = (async () => {
            const r = await mu.acquire(2000);
            acquiredOrder.push('B');
            return r;
        })();
        const pC = (async () => {
            await delay(20);  // C 排 B 后
            const r = await mu.acquire(2000);
            acquiredOrder.push('C');
            return r;
        })();

        await delay(80);
        // 关键：连续多次调用 rA
        rA();
        rA();  // 重复调用应被 released 守卫拦截
        rA();  // 同上

        // B 应该拿到锁；C 仍在等
        const rB = await pB;
        assert(acquiredOrder.join(',') === 'B',
            `B 应该被唤醒一次，C 不应该越锁。实际 acquired: [${acquiredOrder.join(',')}]`);
        assert(mu._stats().locked === true, 'B should hold lock now');
        assert(mu._stats().waiters === 1, 'C should still be waiting');

        // B 释放，C 应该接力
        rB();
        rB();  // 重复释放也应被守卫拦截
        const rC = await pC;
        assert(acquiredOrder.join(',') === 'B,C', `final order should be B,C, got [${acquiredOrder.join(',')}]`);
        rC();
        assert(mu._stats().locked === false, 'final locked false');
    });

    // T4: 全程并发 invariant
    await check('T4 多 waiter 超时与持锁 invariant', async () => {
        const rA = await mu.acquire(3000);
        // 3 个 waiter，全部超时
        const promises = [];
        for (let i = 0; i < 3; i++) {
            promises.push(mu.acquire(100).catch(e => e.code));
        }
        const results = await Promise.all(promises);
        assert(results.every(r => r === 'SMOKE_MUTEX_WAIT_TIMEOUT'),
            `所有 waiter 应超时: ${JSON.stringify(results)}`);

        // 关键：3 个全超时后 A 仍持锁
        assert(mu._stats().locked === true, 'A should still hold lock');
        assert(mu._stats().waiters === 0, 'all timed-out waiters should be removed');

        rA();
        assert(mu._stats().locked === false, 'final locked false');
    });

    // T6: SCRIPT_READ_FAILED 不会占用 Mutex（codex 十二审推荐补单测）
    //    验证：文件读失败在拿锁之前发生，不会污染锁状态
    await check('T6 SCRIPT_READ_FAILED 发生在拿锁前，不占用 Mutex', async () => {
        const { runRealSmokeTest } = require('../utils/collab-submit-helpers');
        // 初始锁状态干净
        assert(mu._stats().locked === false, 'pre: locked should be false');

        const fakePool = { request: () => ({ timeout: 0, query: async () => ({ recordset: [] }) }) };
        const fakeCtx = {
            requestId: 99999,
            oldVer: 0,
            dbAsync: { runAsync: async () => ({ changes: 1 }) },
            logger: { info: () => {}, warn: () => {}, error: () => {} },
        };

        let thrown = null;
        try {
            await runRealSmokeTest('/no/such/path/should/not/exist.sql', fakePool, fakeCtx);
        } catch (e) {
            thrown = e;
        }
        assert(thrown !== null, 'should throw');
        assert(thrown.code === 'SCRIPT_READ_FAILED',
            `should throw SCRIPT_READ_FAILED, got ${thrown.code}: ${thrown.message}`);

        // 关键：文件读失败后 mutex 不应被占用
        assert(mu._stats().locked === false, 'mutex must NOT be held after SCRIPT_READ_FAILED');
        assert(mu._stats().waiters === 0, 'no waiters should remain');
    });

    // 汇总
    console.log(`\n=== 总数: ${passed + failed}, 通过: ${passed}, 失败: ${failed} ===`);
    if (failures.length > 0) {
        console.log('\n失败详情:');
        failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.error}`));
        process.exit(1);
    }
    console.log('\n全部通过 ✅');
}

main().catch(e => {
    console.error('测试异常:', e);
    process.exit(1);
});
