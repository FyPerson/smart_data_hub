// 读取即将冻结的送审内容。动作标志和实际提交共享这一个结果。
'use strict';
const { makeError } = require('./db');
const materialsCore = require('./materials-core');
const { readAttachmentSet } = require('./attachments');
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

async function readSubmissionScope(q, pkg, ver) {
  const snapshot = materialsCore.snapshotObject(ver.snapshot_json);
  const materials = await materialsCore.selectedMaterials(q, pkg.project_id, snapshot, { usable: true });
  const owner = { ownerType: 'package_version', ownerId: ver.id };
  const rows = await readAttachmentSet(q, { ...owner, projectId: pkg.project_id });
  const hashes = Object.create(null);
  for (const attachment of [...rows, ...materials.flatMap((m) => m.frozen)]) {
    const { attachment_id, sha256 } = attachment;
    if (hasKey(hashes, attachment_id) && hashes[attachment_id] !== sha256) {
      throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：内容包重复附件的冻结hash不一致');
    }
    hashes[attachment_id] = sha256;
  }
  return { snapshot, materials, attachmentSources: [{ ...owner, rows }] };
}

module.exports = { readSubmissionScope };
