#!/usr/bin/env node
/**
 * 平台 API 调用工具（解决 Windows bash + curl 中文乱码问题）
 *
 * 用法：
 *   node scripts/api-call.js <method> <path> [json_file]
 *
 * 示例：
 *   node scripts/api-call.js GET /api/metrics
 *   node scripts/api-call.js PUT /api/metrics/69 payload.json
 *   echo '{"biz_def":"中文内容"}' | node scripts/api-call.js PUT /api/metrics/69
 *
 * 环境变量：
 *   API_HOST     默认 192.168.1.100
 *   API_PORT     默认 3000
 *   API_USER     默认 admin
 *   API_PASSWORD 默认 change_me_on_first_login
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.API_HOST || '192.168.1.100';
const PORT = parseInt(process.env.API_PORT || '3000');
const USER = process.env.API_USER || 'admin';
const PASS = process.env.API_PASSWORD || 'change_me_on_first_login';

function httpRequest(method, reqPath, headers, body) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: HOST,
            port: PORT,
            path: reqPath,
            method: method,
            headers: headers || {}
        };
        const req = http.request(opts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, body: raw });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function getToken() {
    const payload = JSON.stringify({ username: USER, password: PASS });
    const res = await httpRequest('POST', '/api/auth/login', {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
    }, payload);

    const data = JSON.parse(res.body);
    if (!data.token) {
        throw new Error(`登录失败: ${res.body}`);
    }
    return data.token;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('用法: node api-call.js <METHOD> <PATH> [json_file]');
        console.error('示例: node api-call.js GET /api/metrics');
        console.error('示例: node api-call.js PUT /api/metrics/69 payload.json');
        console.error('也支持 stdin: echo \'{"key":"val"}\' | node api-call.js PUT /path');
        process.exit(1);
    }

    const method = args[0].toUpperCase();
    const apiPath = args[1];
    let bodyStr = null;

    // 读取请求体：从文件或 stdin
    if (args[2]) {
        const filePath = path.resolve(args[2]);
        bodyStr = fs.readFileSync(filePath, 'utf8');
    } else if (['POST', 'PUT', 'PATCH'].includes(method)) {
        // 检查 stdin 是否有数据（非 TTY 时读取）
        if (!process.stdin.isTTY) {
            bodyStr = await new Promise((resolve) => {
                const chunks = [];
                process.stdin.on('data', c => chunks.push(c));
                process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            });
        }
    }

    // 获取 token
    const token = await getToken();

    // 发送请求
    const headers = {
        'Authorization': `Bearer ${token}`
    };
    if (bodyStr) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const res = await httpRequest(method, apiPath, headers, bodyStr);

    // 美化输出 JSON
    try {
        const parsed = JSON.parse(res.body);
        console.log(JSON.stringify(parsed, null, 2));
    } catch {
        console.log(res.body);
    }

    if (res.status >= 400) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('错误:', err.message);
    process.exit(1);
});
