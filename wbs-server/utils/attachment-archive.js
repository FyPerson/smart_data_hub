// utils/attachment-archive.js — 压缩包附件扩展名 + 大小上限共享真相源（方案 D1）
//   系统迭代 / 数据修正 / 数据协作三模块的压缩包规则表 + 校验器均从本文件派生，禁手写字面量
//   （既有的 ISSUE_LITE_ALLOWED_EXTS / QUICK_LOG_ALLOWED_EXTS 里的 '.zip'/'.rar'/'.7z' 字面量豁免——
//   两模块本次不动，见方案 D1 已决边界，不得为满足禁令扩大修改面）。
//   三个静态 HTML 前端页面无法 require，各自写一份同值字面量常量，由静态守卫脚本对拍本文件。
'use strict';

// 单文件 ≤50MB（50×1024×1024，精确字节，方案诉求原话）。
const ARCHIVE_MAX_SIZE = 52428800;

// 三扩展名，冻结防误改（方案 D1：不含 .tar.gz/.tgz/.7zip）。
const ARCHIVE_EXTS = Object.freeze(['.zip', '.rar', '.7z']);

// 按扩展名派生的大小映射（键=带点小写扩展名，值=字节），供 sizeByExt 规则表直接展开使用。
const ARCHIVE_SIZE_BY_EXT = Object.freeze(
  Object.fromEntries(ARCHIVE_EXTS.map((ext) => [ext, ARCHIVE_MAX_SIZE]))
);

// 判断入参扩展名（须已 normalize 成带点小写，如 '.zip'）是否属于压缩包类型。严格比对，不做归一化。
function isArchiveExt(ext) {
  return ARCHIVE_EXTS.includes(ext);
}

module.exports = { ARCHIVE_EXTS, ARCHIVE_MAX_SIZE, ARCHIVE_SIZE_BY_EXT, isArchiveExt };
