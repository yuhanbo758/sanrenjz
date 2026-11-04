const assert=require('assert');
const {parse,localAddress,equal}=require('../app/remote/protocol');
assert(equal('abc','abc'));assert(!equal('abc','abcd'));assert(!equal('abc','xyz'));
assert.throws(()=>parse({v:1,id:'x',method:'execute-js'}));assert.throws(()=>parse({v:2,id:'x',method:'catalog'}));
for(const address of ['192.168.31.1','172.16.0.1','172.31.255.255','10.0.0.1','127.0.0.1','::ffff:192.168.0.1'])assert(localAddress(address));
for(const address of ['81.71.127.17','172.15.0.1','172.32.0.1','999.1.1.1','169.254.1.1','::1'])assert(!localAddress(address));
console.log('远程协议：接口白名单、身份比对、仅局域网地址通过');
