'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function fail(code, message) { return Object.assign(new Error(message), { code }); }
function part(name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw fail('UNSAFE_PATH', '附件路径包含不安全的目录段');
    return name;
}
function existing(value, kind) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw fail('ABSOLUTE_PATH_REQUIRED', '须显式指定绝对路径');
    const file = path.resolve(value); const root = path.parse(file).root; let cursor = root;
    for (const component of file.slice(root.length).split(path.sep).filter(Boolean)) {
        part(component); cursor = path.join(cursor, component);
        if (fs.lstatSync(cursor).isSymbolicLink()) throw fail('LINK_PATH', '附件存档路径不能经过链接或 junction');
    }
    const stat = fs.lstatSync(file);
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw fail('UNSAFE_FILE_TYPE', '须使用普通目录或独立普通文件');
    return file;
}
function relative(value) {
    if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value)) throw fail('UNSAFE_PATH', '附件相对路径无效');
    value.split('/').forEach(part); return value;
}
function child(root, rel) { const value = relative(rel); const file = path.join(root, ...value.split('/')); existing(file, 'file'); return file; }
function within(parent, value) { const rel = path.relative(parent.toLowerCase(), value.toLowerCase()); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); }
function walk(root) {
    const files = []; const names = new Set();
    function visit(directory, prefix) {
        for (const name of fs.readdirSync(directory).sort()) {
            part(name); const rel = prefix ? prefix + '/' + name : name; const file = path.join(directory, name);
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) throw fail('LINK_PATH', '源目录包含链接，拒绝猜测归档范围');
            const key = rel.normalize('NFC').toLowerCase();
            if (names.has(key)) throw fail('PATH_COLLISION', '附件路径存在大小写或 Unicode 碰撞'); names.add(key);
            if (stat.isDirectory()) visit(file, rel);
            else if (stat.isFile() && stat.nlink === 1) files.push({ rel, file, size: stat.size });
            else throw fail('UNSAFE_FILE_TYPE', '源目录含非常规文件或 hardlink');
        }
    }
    visit(root, ''); return files;
}
async function hash(file) { const digest = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) digest.update(chunk); return digest.digest('hex'); }
function json(file) { if (fs.statSync(file).size > 64 * 1024 * 1024) throw fail('JSON_TOO_LARGE', '存档索引或快照过大'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
module.exports = { fail, part, existing, relative, child, within, walk, hash, json };
