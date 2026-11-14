'use strict';
const fx = require('./_test-fixture');
const testEnv = require('./lib/test-env');
const suite = require('./lib/sysbuild-browser-suite');
(async () => {
    await fx.ready();
    let failed = 1;
    try {
        const flags = process.argv.slice(2);
        if (flags.length && (flags.length !== 1 || !['--self-test', '--keep-artifacts'].includes(flags[0]))) throw new Error('只支持 --self-test 或 --keep-artifacts');
        if (flags.includes('--self-test')) {
            const baseline = await suite.run({ fx, env: testEnv.env() });
            if (baseline.failures.length) throw new Error('未变异浏览器基线失败，停止自检');
            let red = 0;
            const subsetBaselines = new Set();
            for (const mutation of suite.FRONT_MUTATIONS) {
                if (typeof mutation.expectFailure !== 'string' || mutation.expectFailure.trim() === '') throw new Error('变异未声明目标失败：' + mutation.id);
                if (!subsetBaselines.has(mutation.expect)) {
                    const subset = await suite.run({ fx, env: testEnv.env(), caseName: mutation.expect });
                    if (subset.failures.length || subset.pageErrors.length || subset.passed !== 1) throw new Error('目标场景未变异基线异常：' + mutation.id);
                    subsetBaselines.add(mutation.expect);
                }
                const control = await suite.run({ fx, env: testEnv.env(), mutation, control: true });
                if (control.failures.length || control.pageErrors.length || control.passed !== 1) throw new Error('变异空跑对照异常：' + mutation.id);
                const result = await suite.run({ fx, env: testEnv.env(), mutation });
                const targetFailure = result.failures.length === 1 && result.failures[0].name === mutation.expect && result.failures[0].error.includes(mutation.expectFailure);
                if (targetFailure && result.pageErrors.length === 0 && result.selected.length === 1 && result.selected[0] === mutation.expect) {
                    red += 1; console.log('变异判红 ' + mutation.id);
                    if (result.out) suite.cleanupArtifacts(result.out);
                }
                else if (result.failures.length || result.pageErrors.length) throw new Error('变异异常（未命中目标失败，保留证据 ' + result.out + '）：' + mutation.id);
                else console.log('变异存活 ' + mutation.id);
            }
            console.log(`浏览器变异 ${red}/${suite.FRONT_MUTATIONS.length} 判红`);
            failed = red === suite.FRONT_MUTATIONS.length ? 0 : 1;
        } else {
            const result = await suite.run({ fx, env: testEnv.env(), keepArtifacts: flags.includes('--keep-artifacts') });
            failed = result.failures.length ? 1 : 0;
        }
    } finally {
        await fx.teardown();
    }
    fx.finish(failed);
})().catch(async (e) => {
    console.error('sysbuild 浏览器检查异常：' + e.message);
    try { await fx.teardown(); } catch (_) { /* retain failure */ }
    process.exitCode = 1;
});
