'use strict';
// 手机接口只解析数值四则运算，不能使用 Function/eval 或引用任何变量。
function calculate(input){
  if(typeof input!=='string'||input.length>2000)throw new Error('数值表达式过长');
  const source=input.replace(/\s/g,'');let offset=0,depth=0;
  function atom(){if(++depth>32)throw new Error('表达式嵌套过深');let value;
    if(source[offset]==='+'||source[offset]==='-'){const sign=source[offset++];value=atom()*(sign==='-'?-1:1);}
    else if(source[offset]==='('){offset++;value=sum();if(source[offset++]!==')')throw new Error('括号不匹配');}
    else{const number=source.slice(offset).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);if(!number)throw new Error('只支持数值四则运算');offset+=number[0].length;value=Number(number[0]);}
    depth--;return value;
  }
  function product(){let value=atom();while(['*','/','%'].includes(source[offset])){const op=source[offset++],next=atom();value=op==='*'?value*next:op==='/'?value/next:value%next;}return value;}
  function sum(){let value=product();while(['+','-'].includes(source[offset])){const op=source[offset++],next=product();value=op==='+'?value+next:value-next;}return value;}
  const value=sum();if(offset!==source.length||!Number.isFinite(value))throw new Error('表达式或计算结果无效');return String(value);
}
module.exports={calculate};
