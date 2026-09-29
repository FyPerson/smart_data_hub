'use strict';
const assert=require('assert/strict');
const {classifyReadStatus,parseNotifySentAt,DINGTALK_READ_QUERY_WINDOW_DAYS}=require('../utils/dingtalk-notify');
const now=Date.parse('2026-09-27T04:00:00Z'),day=86400000;
const recent='2026-09-26 12:00:00',old='2026-09-19 12:00:00';
const read={userId:'u',readStatus:'READ',readTimestamp:1234567890};
const unread={userId:'u',readStatus:'UNREAD'};
const tests=[
 ['READ', {readDetails:[read]},recent,{state:'read',readTimestamp:1234567890}],
 ['READ even after window',{readDetails:[read]},old,{state:'read',readTimestamp:1234567890}],
 ['READ before UNREAD priority',{readDetails:[unread,read]},recent,{state:'read',readTimestamp:1234567890}],
 ['READ missing timestamp',{readDetails:[{userId:'u',readStatus:'READ'}]},recent,{state:'read',readTimestamp:null}],
 ['UNREAD evidence',{readDetails:[unread]},recent,{state:'unread'}],
 ['UNREAD evidence after window',{readDetails:[unread]},old,{state:'unread'}],
 ['UNREAD outranks inconsistent ids',{readDetails:[unread],readUserIds:['u']},recent,{state:'unread'}],
 ['ids-only fallback',{readUserIds:['u']},recent,{state:'read',readTimestamp:null}],
 ['normalized ids',{readUserIds:[' u ']},recent,{state:'read',readTimestamp:null}],
 ['getReadStatus fallback shape',{readDetails:[],readUserIds:['u'],raw:{readUserIds:['u']}},recent,{state:'read',readTimestamp:null}],
 ['real empty list forbids ids fallback',{readDetails:[],readUserIds:['u'],raw:{messageReadInfoList:[]}},recent,{state:'unqueryable',reason:'not_listed'}],
 ['details forbid ids fallback',{readDetails:[{userId:'other',readStatus:'READ'}],readUserIds:['u']},recent,{state:'unqueryable',reason:'not_listed'}],
 ['non-empty raw list without recipient forbids ids fallback',{readDetails:[],readUserIds:['u'],raw:{messageReadInfoList:[{userId:'other',readStatus:'READ'}]}},recent,{state:'unqueryable',reason:'not_listed'}],
 ['listed recipient with unknown status is not overridden by ids',{readDetails:[{userId:'u',readStatus:'UNKNOWN'}],readUserIds:['u']},recent,{state:'unqueryable',reason:'not_listed'}],
 ['empty list in window',{readDetails:[]},recent,{state:'unqueryable',reason:'not_listed'}],
 ['empty list expired',{readDetails:[]},old,{state:'unqueryable',reason:'expired'}],
 ['6.99 days',{readDetails:[]},new Date(now-6.99*day).toISOString(),{state:'unqueryable',reason:'not_listed'}],
 ['7.0 days ISO',{readDetails:[]},'2026-09-20T04:00:00Z',{state:'unqueryable',reason:'expired'}],
 ['7.0 days local',{readDetails:[]},'2026-09-20 12:00:00',{state:'unqueryable',reason:'expired'}],
 ['notifiedAt null',{readDetails:[]},null,{state:'unqueryable',reason:'not_listed'}],
 ['notifiedAt malformed',{readDetails:[]},'not a date',{state:'unqueryable',reason:'not_listed'}],
 ['unknown recipient state',{readDetails:[{userId:'u',readStatus:'UNKNOWN'}]},recent,{state:'unqueryable',reason:'not_listed'}],
 ['missing response',null,recent,{state:'unqueryable',reason:'not_listed'}],
];
assert.equal(DINGTALK_READ_QUERY_WINDOW_DAYS,7);
for(const [name,result,sent,expected]of tests){assert.deepEqual(classifyReadStatus(result,'u',sent,now),expected,name);console.log('[OK] '+name);}
assert.deepEqual(classifyReadStatus({readUserIds:['']},null,recent,now),{state:'unqueryable',reason:'not_listed'},'empty recipient cannot be read');
assert.equal(parseNotifySentAt('2026-09-20 12:00:00'),Date.parse('2026-09-20T04:00:00Z'),'local parsing always +08');
assert.equal(parseNotifySentAt('2026-09-20T12:00:00+08:00'),Date.parse('2026-09-20T04:00:00Z'),'explicit ISO offset');
console.log('READ_STATUS PASS='+(tests.length+4)+' FAIL=0');   // table rows + window constant + empty recipient + two parse checks
