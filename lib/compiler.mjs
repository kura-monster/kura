// SPDX-License-Identifier: MIT OR Apache-2.0
import path from 'node:path';

const KEYWORDS = new Set(['fn','let','const','if','else','while','for','in','return','true','false','null','struct','enum','match','import','from','export','async','await','trait','impl','where','pure','kernel','comptime']);

export class KuraCompileError extends Error {
  constructor(message, file = '<input>', line = 1, column = 1) { super(`${file}:${line}:${column}: ${message}`); this.name='KuraCompileError'; this.file=file; this.line=line; this.column=column; }
}

export function tokenize(source, file='<input>') {
  const tokens=[]; let i=0,line=1,column=1;
  const push=(type,value,l=line,c=column)=>tokens.push({type,value,line:l,column:c});
  while(i<source.length){
    const c=source[i], startLine=line,startCol=column;
    if(c===' '||c==='\t'||c==='\r'){i++;column++;continue;}
    if(c==='\n'){i++;line++;column=1;continue;}
    if(c==='/'&&source[i+1]==='/'){while(i<source.length&&source[i]!=='\n'){i++;column++;}continue;}
    if(c==='/'&&source[i+1]==='*'){i+=2;column+=2;while(i<source.length&&!(source[i]==='*'&&source[i+1]==='/')){if(source[i]==='\n'){line++;column=1;i++;}else{i++;column++;}}if(i>=source.length)throw new KuraCompileError('unterminated block comment',file,startLine,startCol);i+=2;column+=2;continue;}
    if(c==='"'||c==="'"){const quote=c;let value=c;i++;column++;let closed=false;while(i<source.length){const ch=source[i];value+=ch;i++;column++;if(ch==='\\'&&i<source.length){value+=source[i];i++;column++;continue;}if(ch===quote){closed=true;break;}if(ch==='\n'){line++;column=1;}}if(!closed)throw new KuraCompileError('unterminated string',file,startLine,startCol);push('string',value,startLine,startCol);continue;}
    if(/[0-9]/.test(c)){let value='';while(i<source.length&&/[0-9A-Fa-f_xX.bBoO]/.test(source[i])){value+=source[i++];column++;}push('number',value,startLine,startCol);continue;}
    if(/[A-Za-z_]/.test(c)){let value='';while(i<source.length&&/[A-Za-z0-9_]/.test(source[i])){value+=source[i++];column++;}push(KEYWORDS.has(value)?'keyword':'identifier',value,startLine,startCol);continue;}
    const three=source.slice(i,i+3),two=source.slice(i,i+2);
    if(['...'].includes(three)){push('symbol',three,startLine,startCol);i+=3;column+=3;continue;}
    if(['->','=>','==','!=','<=','>=','&&','||','+=','-=','*=','/=','::','?.','??'].includes(two)){push('symbol',two,startLine,startCol);i+=2;column+=2;continue;}
    if('{}()[];,:.+-*/%<>=!&|?'.includes(c)){push('symbol',c,startLine,startCol);i++;column++;continue;}
    throw new KuraCompileError(`unexpected character ${JSON.stringify(c)}`,file,startLine,startCol);
  }
  push('eof','',line,column); return tokens;
}

class Parser {
  constructor(tokens,file){this.t=tokens;this.i=0;this.file=file;}
  cur(){return this.t[this.i];} next(){return this.t[this.i++];} at(v){return this.cur().value===v;} match(v){if(this.at(v)){this.i++;return true;}return false;}
  expect(v){const t=this.cur();if(t.value!==v)throw new KuraCompileError(`expected '${v}', found '${t.value||'end of file'}'`,this.file,t.line,t.column);return this.next();}
  expectId(){const t=this.cur();if(t.type!=='identifier')throw new KuraCompileError(`expected identifier, found '${t.value||'end of file'}'`,this.file,t.line,t.column);return this.next().value;}
  parse(){const body=[];while(this.cur().type!=='eof'){body.push(this.decl());}return {kind:'Program',body};}
  decl(){let exported=this.match('export');let async=this.match('async');let pure=this.match('pure');let kernel=this.match('kernel');if(this.match('fn'))return this.fn(exported,async,pure,kernel);if(this.match('struct'))return this.struct(exported);if(this.match('enum'))return this.enumDecl(exported);if(this.match('import'))return this.importDecl();return this.statement();}
  fn(exported,async,pure,kernel){const name=this.expectId();this.expect('(');const params=[];while(!this.at(')')){const p=this.expectId();let type=null;if(this.match(':'))type=this.typeName();params.push({name:p,type});if(!this.match(','))break;}this.expect(')');let returnType=null;if(this.match('->'))returnType=this.typeName();const body=this.block();return {kind:'Function',name,params,body,returnType,exported,async,pure,kernel};}
  struct(exported){const name=this.expectId();this.expect('{');const fields=[];while(!this.at('}')){const n=this.expectId();this.expect(':');const type=this.typeName();this.match(',');this.match(';');fields.push({name:n,type});}this.expect('}');return {kind:'Struct',name,fields,exported};}
  enumDecl(exported){const name=this.expectId();this.expect('{');const variants=[];while(!this.at('}')){const n=this.expectId();let fields=[];if(this.match('(')){while(!this.at(')')){fields.push(this.typeName());if(!this.match(','))break;}this.expect(')');}variants.push({name:n,fields});this.match(',');}this.expect('}');return {kind:'Enum',name,variants,exported};}
  importDecl(){const names=[];if(this.match('{')){while(!this.at('}')){names.push(this.expectId());if(!this.match(','))break;}this.expect('}');}else names.push(this.expectId());this.expect('from');const src=this.next();if(src.type!=='string'&&src.type!=='identifier')throw new KuraCompileError('expected import source',this.file,src.line,src.column);this.match(';');return {kind:'Import',names,source:src.value};}
  typeName(){let out='';let depth=0;while(true){const t=this.cur();if(t.type==='eof')break;if(depth===0&&[',',')','{',';','=','}'].includes(t.value))break;if(t.value==='<')depth++;if(t.value==='>')depth--;out+=this.next().value;if(depth<0)break;}return out||'unknown';}
  block(){this.expect('{');const body=[];while(!this.at('}')){if(this.cur().type==='eof')throw new KuraCompileError('unterminated block',this.file,this.cur().line,this.cur().column);body.push(this.decl());}this.expect('}');return body;}
  statement(){if(this.match('let')||this.match('const')){const keyword=this.t[this.i-1].value;const name=this.expectId();let type=null;if(this.match(':'))type=this.typeNameUntil(new Set(['=',';']));let init=null;if(this.match('='))init=this.expr();this.match(';');return {kind:'Variable',keyword,name,type,init};}if(this.match('return')){const value=this.at(';')?null:this.expr();this.match(';');return {kind:'Return',value};}if(this.match('if')){const test=this.parenOrExpr();const consequent=this.block();let alternate=null;if(this.match('else'))alternate=this.at('if')?[this.statement()]:this.block();return {kind:'If',test,consequent,alternate};}if(this.match('while')){const test=this.parenOrExpr();return {kind:'While',test,body:this.block()};}if(this.match('for')){const name=this.expectId();this.expect('in');const iterable=this.expr();return {kind:'For',name,iterable,body:this.block()};}const e=this.expr();this.match(';');return {kind:'ExpressionStatement',expression:e};}
  typeNameUntil(stop){let out='';while(this.cur().type!=='eof'&&!stop.has(this.cur().value))out+=this.next().value;return out;}
  parenOrExpr(){if(this.match('(')){const e=this.expr();this.expect(')');return e;}return this.expr();}
  expr(min=0){let left=this.prefix();const prec={'=':1,'??':2,'||':3,'&&':4,'==':5,'!=':5,'<':6,'>':6,'<=':6,'>=':6,'+':7,'-':7,'*':8,'/':8,'%':8};while(true){const op=this.cur().value,p=prec[op]??-1;if(p<min)break;this.next();const right=this.expr(p+(op==='='?0:1));left={kind:'Binary',op,left,right};}return left;}
  prefix(){const t=this.next();let node;if(t.value==='!'||t.value==='-'||t.value==='+'){node={kind:'Unary',op:t.value,value:this.expr(9)};}else if(t.value==='await'){node={kind:'Await',value:this.expr(9)};}else if(t.type==='number'||t.type==='string'||['true','false','null'].includes(t.value)){node={kind:'Literal',value:t.value};}else if(t.type==='identifier'||t.type==='keyword'){node={kind:'Identifier',name:t.value};}else if(t.value==='('){node=this.expr();this.expect(')');}else if(t.value==='['){const items=[];while(!this.at(']')){items.push(this.expr());if(!this.match(','))break;}this.expect(']');node={kind:'Array',items};}else throw new KuraCompileError(`unexpected token '${t.value}'`,this.file,t.line,t.column);
    while(true){if(this.match('(')){const args=[];while(!this.at(')')){args.push(this.expr());if(!this.match(','))break;}this.expect(')');node={kind:'Call',callee:node,args};continue;}if(this.match('.')){const prop=this.expectId();node={kind:'Member',object:node,property:prop};continue;}if(this.match('[')){const index=this.expr();this.expect(']');node={kind:'Index',object:node,index};continue;}break;}return node;}
}

export function parse(source, options={}) { const file=options.file??'<input>'; return new Parser(tokenize(source,file),file).parse(); }

const ind=n=>'  '.repeat(n);

function literalValue(node){
  if(node?.kind!=='Literal')return {known:false,value:undefined};
  try{return {known:true,value:Function(`\"use strict\";return (${node.value});`)()};}catch{return {known:false,value:undefined};}
}

function serializeLiteral(value){
  if(typeof value==='number'&&Number.isFinite(value))return String(value);
  if(typeof value==='string')return JSON.stringify(value);
  if(typeof value==='boolean')return value?'true':'false';
  if(value===null)return 'null';
  return null;
}

function foldExpr(node){
  if(!node)return node;
  if(node.kind==='Array')return {...node,items:node.items.map(foldExpr)};
  if(node.kind==='Unary'){
    const value=foldExpr(node.value);const known=literalValue(value);
    if(known.known){
      let result;
      if(node.op==='!')result=!known.value;
      else if(node.op==='-')result=-known.value;
      else if(node.op==='+')result=+known.value;
      const encoded=serializeLiteral(result);if(encoded!==null)return {kind:'Literal',value:encoded};
    }
    return {...node,value};
  }
  if(node.kind==='Binary'){
    const left=foldExpr(node.left),right=foldExpr(node.right);
    const a=literalValue(left),b=literalValue(right);
    if(a.known&&b.known&&node.op!=='='){
      let result;
      switch(node.op){
        case'+':result=a.value+b.value;break;case'-':result=a.value-b.value;break;case'*':result=a.value*b.value;break;
        case'/':result=a.value/b.value;break;case'%':result=a.value%b.value;break;case'==':result=a.value===b.value;break;
        case'!=':result=a.value!==b.value;break;case'<':result=a.value<b.value;break;case'>':result=a.value>b.value;break;
        case'<=':result=a.value<=b.value;break;case'>=':result=a.value>=b.value;break;case'&&':result=a.value&&b.value;break;
        case'||':result=a.value||b.value;break;case'??':result=a.value??b.value;break;default:return {...node,left,right};
      }
      const encoded=serializeLiteral(result);if(encoded!==null)return {kind:'Literal',value:encoded};
    }
    return {...node,left,right};
  }
  if(node.kind==='Await')return {...node,value:foldExpr(node.value)};
  if(node.kind==='Call')return {...node,callee:foldExpr(node.callee),args:node.args.map(foldExpr)};
  if(node.kind==='Member')return {...node,object:foldExpr(node.object)};
  if(node.kind==='Index')return {...node,object:foldExpr(node.object),index:foldExpr(node.index)};
  return node;
}

function optimizeStatements(body){
  const output=[];
  for(const node of body){
    if(node.kind==='Function')output.push({...node,body:optimizeStatements(node.body)});
    else if(node.kind==='Variable')output.push({...node,init:foldExpr(node.init)});
    else if(node.kind==='Return')output.push({...node,value:foldExpr(node.value)});
    else if(node.kind==='ExpressionStatement')output.push({...node,expression:foldExpr(node.expression)});
    else if(node.kind==='While')output.push({...node,test:foldExpr(node.test),body:optimizeStatements(node.body)});
    else if(node.kind==='For')output.push({...node,iterable:foldExpr(node.iterable),body:optimizeStatements(node.body)});
    else if(node.kind==='If'){
      const test=foldExpr(node.test),known=literalValue(test);
      if(known.known){output.push(...optimizeStatements(known.value?node.consequent:(node.alternate||[])));continue;}
      output.push({...node,test,consequent:optimizeStatements(node.consequent),alternate:node.alternate?optimizeStatements(node.alternate):null});
    }else output.push(node);
  }
  return output;
}

function optimizeAst(ast){return {...ast,body:optimizeStatements(ast.body)};}

function emitExpr(n){switch(n.kind){case'Literal':return n.value;case'Identifier':return builtin(n.name);case'Array':return`[${n.items.map(emitExpr).join(', ')}]`;case'Unary':return`${n.op}${emitExpr(n.value)}`;case'Await':return`await ${emitExpr(n.value)}`;case'Binary':return`${emitExpr(n.left)} ${n.op} ${emitExpr(n.right)}`;case'Call':return`${emitExpr(n.callee)}(${n.args.map(emitExpr).join(', ')})`;case'Member':return`${emitExpr(n.object)}.${n.property}`;case'Index':return`${emitExpr(n.object)}[${emitExpr(n.index)}]`;default:throw new Error(`unknown expression ${n.kind}`);}}
function builtin(name){return ({println:'console.log',print:'process.stdout.write',len:'__kr_len',str:'String',int:'Number',float:'Number',range:'__kr_range',panic:'__kr_panic'}[name]??name);}
function isRangeCall(n){return n?.kind==='Call'&&n.callee?.kind==='Identifier'&&n.callee.name==='range'&&n.args.length===2;}
function emitStmt(n,d=0){const p=ind(d);switch(n.kind){case'Function':return`${p}${n.exported?'export ':''}${n.async?'async ':''}function ${n.name}(${n.params.map(x=>x.name).join(', ')}) {\n${n.body.map(x=>emitStmt(x,d+1)).join('\n')}\n${p}}`;case'Variable':return`${p}${n.keyword==='const'?'const':'let'} ${n.name}${n.init?` = ${emitExpr(n.init)}`:''};`;case'Return':return`${p}return${n.value?` ${emitExpr(n.value)}`:''};`;case'If':return`${p}if (${emitExpr(n.test)}) {\n${n.consequent.map(x=>emitStmt(x,d+1)).join('\n')}\n${p}}${n.alternate?` else {\n${n.alternate.map(x=>emitStmt(x,d+1)).join('\n')}\n${p}}`:''}`;case'While':return`${p}while (${emitExpr(n.test)}) {\n${n.body.map(x=>emitStmt(x,d+1)).join('\n')}\n${p}}`;case'For':{if(isRangeCall(n.iterable)){const [start,end]=n.iterable.args;const stop=`__kr_end_${n.name}_${d}`;return`${p}for (let ${n.name} = ${emitExpr(start)}, ${stop} = ${emitExpr(end)}; ${n.name} < ${stop}; ${n.name}++) {\n${n.body.map(x=>emitStmt(x,d+1)).join('\n')}\n${p}}`;}return`${p}for (const ${n.name} of ${emitExpr(n.iterable)}) {\n${n.body.map(x=>emitStmt(x,d+1)).join('\n')}\n${p}}`;}case'ExpressionStatement':return`${p}${emitExpr(n.expression)};`;case'Struct':return`${p}${n.exported?'export ':''}class ${n.name} { constructor(${n.fields.map(f=>f.name).join(', ')}) { ${n.fields.map(f=>`this.${f.name}=${f.name};`).join(' ')} } }`;case'Enum':return`${p}${n.exported?'export ':''}const ${n.name}=Object.freeze({${n.variants.map(v=>`${v.name}:${v.fields.length?`(...values)=>({tag:${JSON.stringify(v.name)},values})`:`{tag:${JSON.stringify(v.name)}}`}`).join(',')}});`;case'Import':{const src=n.source.startsWith('"')||n.source.startsWith("'")?n.source:JSON.stringify(n.source);return`${p}import { ${n.names.join(', ')} } from ${src};`;}default:throw new Error(`unknown statement ${n.kind}`);}}

function walkExpr(node,visit){if(!node)return;visit(node);switch(node.kind){case'Array':node.items.forEach(x=>walkExpr(x,visit));break;case'Unary':case'Await':walkExpr(node.value,visit);break;case'Binary':walkExpr(node.left,visit);walkExpr(node.right,visit);break;case'Call':walkExpr(node.callee,visit);node.args.forEach(x=>walkExpr(x,visit));break;case'Member':walkExpr(node.object,visit);break;case'Index':walkExpr(node.object,visit);walkExpr(node.index,visit);break;}}
function walkStatements(body,visit){for(const node of body){visit(node);if(node.kind==='Function'||node.kind==='While'||node.kind==='For')walkStatements(node.body,visit);if(node.kind==='If'){walkStatements(node.consequent,visit);if(node.alternate)walkStatements(node.alternate,visit);}for(const key of ['init','value','expression','test','iterable'])walkExpr(node[key],visit);}}
function buildPrelude(body){const lines=[];if(body.includes('__kr_len'))lines.push('const __kr_len = value => value.length;');if(body.includes('__kr_range'))lines.push('const __kr_range = (start, end) => ({[Symbol.iterator]: function*(){for(let i=start;i<end;i++)yield i;}});');if(body.includes('__kr_panic'))lines.push('const __kr_panic = message => { throw new Error(String(message)); };');return lines.join('\n');}

export function compile(source, options={}) {
  const parsed=parse(source,options);const ast=options.optimize?optimizeAst(parsed):parsed;
  const body=ast.body.map(x=>emitStmt(x,0)).join(options.compact?'\n':'\n\n');
  const prelude=buildPrelude(body);const hasMain=ast.body.some(x=>x.kind==='Function'&&x.name==='main');const benchFunction=ast.body.find(x=>x.kind==='Function'&&x.kernel);
  const exports=[];if(hasMain&&options.exposeMain)exports.push('main as __kr_main');if(benchFunction&&options.exposeBenchmark)exports.push(`${benchFunction.name} as __kr_bench`);const expose=exports.length?`\nexport { ${exports.join(', ')} };`:'';
  const autoRun=options.autoRun!==false;
  const epilogue=hasMain&&autoRun?'\n\nconst __kr_result = await main();\nif (typeof __kr_result === \'number\') process.exitCode = __kr_result;':'';
  const banner=options.banner===false?'':`// Generated by Kura v1.0.0${options.optimize?' Velocity Engine':''}\n`;
  const sections=[banner.trimEnd(),prelude,body+expose+epilogue].filter(Boolean);
  return {ast,code:sections.join(options.compact?'\n':'\n\n')+'\n',target:options.target??'node',optimized:Boolean(options.optimize)};
}

export function format(source, options={}) { const {ast}=compile(source,options); return ast.body.map(x=>formatStmt(x,0)).join('\n\n')+'\n'; }
function formatExpr(n){return emitExpr(n);}
function formatStmt(n,d){const p=ind(d);switch(n.kind){case'Function':return`${p}${n.exported?'export ':''}${n.async?'async ':''}fn ${n.name}(${n.params.map(x=>x.name+(x.type?`: ${x.type}`:'')).join(', ')})${n.returnType?` -> ${n.returnType}`:''} {\n${n.body.map(x=>formatStmt(x,d+1)).join('\n')}\n${p}}`;case'Variable':return`${p}${n.keyword} ${n.name}${n.type?`: ${n.type}`:''}${n.init?` = ${formatExpr(n.init)}`:''};`;case'Return':return`${p}return${n.value?` ${formatExpr(n.value)}`:''};`;case'ExpressionStatement':return`${p}${formatExpr(n.expression)};`;case'If':return`${p}if (${formatExpr(n.test)}) {\n${n.consequent.map(x=>formatStmt(x,d+1)).join('\n')}\n${p}}${n.alternate?` else {\n${n.alternate.map(x=>formatStmt(x,d+1)).join('\n')}\n${p}}`:''}`;case'While':return`${p}while (${formatExpr(n.test)}) {\n${n.body.map(x=>formatStmt(x,d+1)).join('\n')}\n${p}}`;case'For':return`${p}for ${n.name} in ${formatExpr(n.iterable)} {\n${n.body.map(x=>formatStmt(x,d+1)).join('\n')}\n${p}}`;case'Struct':return`${p}${n.exported?'export ':''}struct ${n.name} {\n${n.fields.map(f=>`${ind(d+1)}${f.name}: ${f.type},`).join('\n')}\n${p}}`;case'Enum':return`${p}${n.exported?'export ':''}enum ${n.name} {\n${n.variants.map(v=>`${ind(d+1)}${v.name}${v.fields.length?`(${v.fields.join(', ')})`:''},`).join('\n')}\n${p}}`;case'Import':return`${p}import { ${n.names.join(', ')} } from ${n.source};`;default:return p;}}

export function diagnose(source, options={}) { try { const result=compile(source,options); const messages=[]; const main=result.ast.body.filter(x=>x.kind==='Function'&&x.name==='main'); if(main.length>1)messages.push({severity:'error',message:'multiple main functions'}); return {ok:messages.every(x=>x.severity!=='error'),messages,ast:result.ast}; } catch(error){return {ok:false,messages:[{severity:'error',message:error instanceof Error?error.message:String(error)}]};} }
