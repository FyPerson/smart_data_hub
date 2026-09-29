'use strict';
const acorn = require('acorn');

// A "string expression" is a string literal, a template literal, or a `+` chain with at least one
// string side. Static parts are folded into one SQL shape; any non-string operand or template
// expression is kept as a `${...}` placeholder so it stays visible as dynamic.
function isStringExpr(node) {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string';
  if (node.type === 'TemplateLiteral') return true;
  return node.type === 'BinaryExpression' && node.operator === '+' && (isStringExpr(node.left) || isStringExpr(node.right));
}
function foldShape(node, source) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') return source.slice(node.start + 1, node.end - 1);
  if (node.type === 'BinaryExpression' && node.operator === '+' && (isStringExpr(node.left) || isStringExpr(node.right))) {
    return foldShape(node.left, source) + foldShape(node.right, source);
  }
  return '${' + source.slice(node.start, node.end) + '}';
}
function ownerOf(ancestors) {
  for (const parent of ancestors.slice().reverse()) {
    if (parent.type === 'FunctionDeclaration' && parent.id) return {owner: parent.id.name, scope: parent};
    if (parent.type === 'CallExpression' && parent.callee.type === 'MemberExpression'
        && parent.callee.object.name === 'router' && parent.arguments[0]?.type === 'Literal') {
      return {owner: `router.${parent.callee.property.name} ${parent.arguments[0].value}`, scope: parent};
    }
  }
  return {owner: null, scope: null};
}

// Scope (user decision 2026-09-28): a regression guard for how this codebase actually writes SQL,
// not a completeness proof. Known shapes it does not see: a call hidden inside a template
// interpolation, SQL assembled by Array#join, SET fragments whose source changes content under a
// registered name (partly covered by [S②d] in the guard). Execution paths are proven by runtime cases.
//
// Every `UPDATE sys_issues SET` inside a folded string expression, anywhere in the string (so a
// leading SQL comment, `BEGIN;` or a split keyword does not hide it). kind:
//   status  — the SET clause assigns status literally;
//   dynamic — the SET clause is empty or contains a placeholder, so what it writes is decided at
//             run time; the guard requires every dynamic site to be registered by hand;
//   other   — a static SET clause that does not touch status.
function extractSysIssuesUpdates(source) {
  const tree = acorn.parse(source, {ecmaVersion: 'latest', locations: true});
  const sites = [];
  function walk(node, ancestors) {
    if (!node || typeof node.type !== 'string') return;
    const parent = ancestors[ancestors.length - 1];
    if (isStringExpr(node) && !(parent && isStringExpr(parent) && parent.type === 'BinaryExpression')) {
      const shape = foldShape(node, source).replace(/\s+/g, ' ');
      const re = /UPDATE\s+sys_issues\s+SET\b/gi;
      let m;
      while ((m = re.exec(shape))) {
        const rest = shape.slice(m.index);
        const semi = rest.indexOf(';');
        const sql = (semi < 0 ? rest : rest.slice(0, semi)).trim();
        const setBody = sql.replace(/^UPDATE\s+sys_issues\s+SET\b/i, '').split(/\s+WHERE\b/i)[0].trim();
        const kind = /\bstatus\s*=/i.test(setBody) ? 'status' : (setBody === '' || /\$\{/.test(setBody) ? 'dynamic' : 'other');
        const {owner, scope} = ownerOf(ancestors);
        sites.push({owner, sql, setBody, kind, line: node.loc.start.line, start: node.start, offset: m.index, scope, tree});
      }
      return;   // a folded root already covers its operands
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, [...ancestors, node]));
      else if (value && typeof value.type === 'string') walk(value, [...ancestors, node]);
    }
  }
  walk(tree, []);
  return sites.sort((a, b) => a.start - b.start || a.offset - b.offset);
}

// Status write sites keep the historical contract: literal status assignments plus the generic
// transition engine's `${setClause}`.
function extractStatusWriteSites(source) {
  return extractSysIssuesUpdates(source).filter(s => s.kind === 'status' || (s.kind === 'dynamic' && /\$\{setClause\}/.test(s.setBody)));
}
function extractDynamicSetSites(source) {
  return extractSysIssuesUpdates(source).filter(s => s.kind === 'dynamic');
}

// Independent text counter: comments blanked via the parser, then any `UPDATE sys_issues SET`
// whose SET clause assigns status, up to WHERE or a double quote / backtick. It shares no code
// with the folding extractor; the guard requires both counts to agree. It over-counts when a
// SET clause without WHERE is followed by an unrelated `status =` before the next quote — that
// fails closed (red), never green.
function countStatusWritesByText(source) {
  const comments = [];
  acorn.parse(source, {ecmaVersion: 'latest', onComment: (_block, _text, start, end) => comments.push({start, end})});
  let clean = '', offset = 0;
  for (const c of comments) {
    clean += source.slice(offset, c.start) + source.slice(c.start, c.end).replace(/[^\r\n]/g, ' ');
    offset = c.end;
  }
  clean += source.slice(offset);
  const re = /UPDATE\s+sys_issues\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|[`"])/gi;
  let count = 0, m;
  while ((m = re.exec(clean))) {
    const clause = m[1];
    if (/\bstatus\s*=/i.test(clause) || /\$\{setClause\}/.test(clause)) count++;
  }
  return count;
}

// Every string literal / template text under the single declaration of `name` in `source`.
// Returns null when the name is declared zero or several times, so callers can fail hard.
function declaredStrings(source, name) {
  const tree = acorn.parse(source, {ecmaVersion: 'latest'});
  const decls = [];
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name) decls.push(node);
    for (const v of Object.values(node)) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
  })(tree);
  if (decls.length !== 1 || !decls[0].init) return null;
  const out = [];
  (function collect(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Literal' && typeof node.value === 'string') out.push(node.value);
    if (node.type === 'TemplateElement') out.push(node.value.cooked);
    for (const v of Object.values(node)) { if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v.type === 'string') collect(v); }
  })(decls[0].init);
  return out;
}

module.exports = {extractStatusWriteSites, extractDynamicSetSites, extractSysIssuesUpdates, countStatusWritesByText, declaredStrings};
