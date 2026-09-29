// Frozen plan §12 order: 2 initialization + 6 classification + 5 parser +
// 3 state + 2 bulk/concurrency + 5 isolation + 1 export = 24? See note below.
'use strict';
// The plan calls this "23 groups" but enumerates 24 bullets (2+6+5+3+2+5+1).
// Pair owner-field visibility and finance-name completeness under RG22; preserve
// both distinct required evidence sets. No business case is removed.
const groups=[
 ['RG01','初始化幂等', [['组1: sqlite_master(表+索引)第二次跑前后完全不变',1],['组1: it_assets行数据逐行不变(含2条存量)',1]]],
 ['RG02','结构事务原子性', [['组7-第二列owner_dept失败: it_assets行数据快照不变',1],['组7-第三列asset_class失败: it_assets列定义快照不变',1]]],
 ['RG03','分类算术', [['R2三台账三册行算术及对称规范化',1]]],
 ['RG04','匹配规范化对称', [['R2三台账三册行算术及对称规范化',1]]],
 ['RG05','编号歧义完整快照', [['R2歧义全候选精确内容',1],['R2歧义不伪装asset或snapshot',1]]],
 ['RG06','歧义混合样本', [['R2两歧义组混合精确计数',1],['R2混合无册面重复组逐条册外',1]]],
 ['RG07','修正后重建及旧报告冻结', [['R2修正编号后重建成功',1],['R2旧批次全部明细永久不变',1]]],
 ['RG08','覆盖守恒', [['R2混合覆盖守恒且两引用集合互斥',1]]],
 ['RG09','脏表拒绝族', [['R2解析反例-',25],['R2数量合法/空默认1',1]]],
 ['RG10','编号前导零三样本', [['R2方案前导零三样本',3]]],
 ['RG11','金额转换', [['R2金额合法',8],['R2解析反例-金额￥',1],['R2解析反例-金额abc',1],['R2解析反例-金额-1',2]]],
 ['RG12','sheet两维度独立', [['R2低值与报废独立+unknown+统计',1],['R2四个非对账表完整不变',1]]],
 ['RG13','上传失败清理', [['R2数据库中途失败:六表零变化',1],['R2数据库中途失败:原件零新增',1],['R2坏工作簿:原件零新增',1]]],
 ['RG14','六条迁移与非法迁移', [['R3合法迁移',10],['R3第六合法迁移:status',1],['R3终态禁止再迁移',180]]],
 ['RG15','actual及DB形态约束', [['R3非法actual:精确状态/码',10],['R3found禁止actual出现:精确状态/码',3],['组4负向:',9]]],
 ['RG16','关闭与冻结', [['R3全终态普通关闭:status',1],['R3重复关闭不重算:六表全部行不变',1],['R3关闭后check冻结:精确状态/码',1],['R3force冻结未处置计数:status',1]]],
 ['RG17','批量原子和去重上限', [['R3五百行共享核对人时间且不限类别',1],['R3去重后501唯一超限:精确状态/码',1],['R3重复501次先去重可过:status',1]]],
 ['RG18','两种force锁顺序', [['R3次请求真实排队',2],['R3并发后请求按锁顺序',2],['R3并发summary冻结时机精确',2],['R3未处置不能普通关闭:精确状态/码',1]]],
 ['RG19','关闭流程不写台账', [['R4上传不写资产事件',1],...['check','bulk','close','export'].map(x=>['R4关闭路径'+x+':资产事件全行全等',1])]],
 ['RG20','删除流程不写台账', [['R4删除路径delete:资产事件全行全等',1],['R4删除路径文件消失且下载404',1]]],
 ['RG21','非admin真实财务隔离', [['R4非admin35列/七行/嵌套无财务',2],['R4admin金额对照真实非空',1],['R4 F1原件权限拒绝',4]]],
 ['RG22','owner保留及财务字段命名完整性', [['R4owner三列仍可见',2],['R4财务命名提醒',4],['R4财务集合手写全等',1]]],
 ['RG23','导出多来源证据', [['R4实际值/快照/当前三证据不混用',1],['R4无台账不按编号补关联',1],['R4歧义个数来自快照不随修复改变',1],['R4每行恰36键且表头无重名',1],['R4时间戳及冻结说明/已全核实',1]]]
];
function verify(observations,check){
 for(const [id,title,requirements]of groups){
  const missing=requirements.filter(([prefix,min])=>observations.filter(x=>x.ok&&x.name.startsWith(prefix)).length<min);
  check(id+' '+title+' 必要执行证据齐全',missing.length===0,JSON.stringify(missing));
 }
}
module.exports={groups,verify};
