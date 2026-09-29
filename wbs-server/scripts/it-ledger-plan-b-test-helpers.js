'use strict';
// Older behavioral suites work on several inspection sections in one scenario.
// Exercise the real "全部展开" control before those actions; new Plan B suites verify the folded default separately.
async function expandInspectionForm(page) {
  const button = page.locator('#itlSheetExpandAll');
  if (await button.count() && (await button.textContent()) === '全部展开') await button.click();
}
module.exports = { expandInspectionForm };
