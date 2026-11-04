import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';

const EXT='littlepet';
const defaults={enabled:true,jellyOn:true,jellyScope:'local',jellyTap:true,jellyDrag:true,jellyShake:false,jellyStrength:'mid',jellyBrush:.075,feedbackRange:100,interactionMode:'selection',fixedBottom:26};
function ddCfg(){
 if(!extension_settings[EXT])extension_settings[EXT]={};
 const c=extension_settings[EXT];
 for(const k of Object.keys(defaults))if(c[k]===undefined)c[k]=defaults[k];
 // 旧版只存一张上传图 ballCustom，迁移成列表
 if(c.ballCustom){if(!Array.isArray(c.ballCustoms))c.ballCustoms=[];if(!c.ballCustoms.length)c.ballCustoms.push({id:'u1',url:c.ballCustom});if(c.ballIcon==='custom')c.ballIcon='custom:'+c.ballCustoms[0].id;delete c.ballCustom;}
 if(!Array.isArray(c.ballCustoms))c.ballCustoms=[];
 // 没手动挑过图标的人，自动换成内置的果冻图标
 if(c.ballIcon==='default'&&!c.ballIconPicked&&typeof DD_BUILTIN_ICONS!=='undefined'&&DD_BUILTIN_ICONS.includes('jelly.png'))c.ballIcon='jelly.png';
 return c;
}
const ddSave=()=>{try{saveSettingsDebounced();}catch{}};

// ===== 放大图小互动（果冻）：范围（局部 / 抹开 / 全屏）× 选区（可选）× 交互（点击 / 拖动 / 摇晃） =====
// 弹簧动画只在触摸 / 拖动 / 摇晃时跑，松手停稳后自动结束；选区只在放大图打开期间保留。
const DD_JELLY_MW=48,DD_JELLY_MH=48;
function ddJellyCfg(){
 const c=ddCfg();
 if(typeof c.jellyOn!=='boolean'){
  const m=c.jellyMode;
  c.jellyOn=['squish','pull','both','wobble'].includes(m);
  c.jellyTap=m!=='pull';c.jellyDrag=m!=='squish';
 }
 if(typeof c.jellyTap!=='boolean')c.jellyTap=true;
 if(typeof c.jellyDrag!=='boolean')c.jellyDrag=true;
 if(typeof c.jellyShake!=='boolean')c.jellyShake=false;
 return {on:c.jellyOn,scope:'local',tap:true,drag:c.jellyDrag,shake:c.jellyShake,mode:c.interactionMode==='icon'?'icon':'selection',fixedBottom:Math.max(0,Math.min(70,Number(c.fixedBottom??26)||0)),amp:{soft:.35,mid:.5,bouncy:.65}[c.jellyStrength]||.5};
}
function ddJellyBrush(){const b=Number(ddCfg().jellyBrush);return Number.isFinite(b)&&b>0?Math.max(.02,Math.min(.2,b)):.075;}
function ddJellyState(img){
 if(!img._ddJ)img._ddJ={mask:new Float32Array(DD_JELLY_MW*DD_JELLY_MH),has:false,selecting:false};
 return img._ddJ;
}
function ddJellyClearSelection(img){
 if(!img)return;const S=ddJellyState(img);S.mask.fill(0);S.has=false;S.selecting=false;
}
async function ddJellyEnableMotion(setMsg){
 const say=t=>{try{setMsg&&setMsg(t);}catch{}};
 if(typeof DeviceMotionEvent==='undefined'){say('此浏览器不支持摇晃感应');return false;}
 if(typeof DeviceMotionEvent.requestPermission==='function'){
  try{const r=await DeviceMotionEvent.requestPermission();if(r!=='granted'){say('没有拿到动作传感器权限');return false;}}
  catch{say('请求动作传感器权限失败');return false;}
 }
 let got=false;const h=()=>{got=true;};window.addEventListener('devicemotion',h);
 setTimeout(()=>{window.removeEventListener('devicemotion',h);say(got?'摇晃已就绪：晃一晃手机试试':'没收到传感器数据：请确认是用 http://127.0.0.1 或 https 打开的酒馆，并且系统没有关闭动作传感器');},1500);
 return true;
}
function ddAttachJelly(img){
 if(!img)return;
 const S=ddJellyState(img),conf=ddJellyCfg(),amp=conf.amp,scope=conf.scope;
 img._ddJellyAbort?.abort();img._ddJellyAbort=null;
 img.style.transform='';img.style.touchAction='';img.style.willChange='';
 if(!conf.on){S.selecting=false;return;}
 if(scope==='whole'&&!S.has&&!conf.shake&&!S.selecting)return ddAttachJellyWhole(img,conf);
 let probeOk=false;
 try{const pc=document.createElement('canvas');probeOk=!!(pc.getContext('webgl')||pc.getContext('experimental-webgl'));}catch{}
 if(!probeOk)return ddAttachJellyWhole(img,conf);
 const ac=new AbortController();img._ddJellyAbort=ac;const sig={signal:ac.signal};
 const wantPointer=conf.tap||conf.drag||S.selecting;
 if(wantPointer){img.draggable=false;img.style.touchAction='none';img.style.webkitUserDrag='none';}
 const MW=DD_JELLY_MW,MH=DD_JELLY_MH;
 let canvas=null,selCv=null,gl=null,prog=null,posBuf=null,idxCount=0,tex=null,texSrc='',cols=0,rows=0,pos=null,locPos=0,locSize=null,boxW=0,boxH=0,failed=false;
 let raf=0,press=null,cx=0,cy=0,lx=0,ly=0,ofx=null,ofy=null,ovx=null,ovy=null,mv=null,shw=null,baseX=null,baseY=null,localW=null,localW2=null,activeRanges=[],shown=false;const originalVisibility=img.style.visibility;
 const dep={x:0,v:0,t:0,k:.3,d:.6},ox={x:0,v:0,t:0,k:.3,d:.7},oy={x:0,v:0,t:0,k:.3,d:.7};
 const aff={x:[0,0,1,1,0],v:[0,0,0,0,0],t:[0,0,1,1,0]};
 const shk={x:0,y:0,vx:0,vy:0};
 const iconWobble={r:0,vr:0,s:0,vs:0};
 const destroy=()=>{cancelAnimationFrame(raf);raf=0;img.style.visibility=originalVisibility;try{canvas?.remove();}catch{}try{selCv?.remove();}catch{}canvas=null;selCv=null;gl=null;};
 ac.signal.addEventListener('abort',destroy);
 const box=()=>{
  // 使用未受 CSS transform 缩放的布局尺寸；浮窗缩放时不能拿屏幕像素尺寸重复缩放画布。
  const cs=getComputedStyle(img);
  const f=n=>parseFloat(cs[n])||0;
  const l=f('paddingLeft')+f('borderLeftWidth'),t=f('paddingTop')+f('borderTopWidth'),rr=f('paddingRight')+f('borderRightWidth'),b=f('paddingBottom')+f('borderBottomWidth');
  return {left:l,top:t,w:Math.max(10,img.offsetWidth-l-rr),h:Math.max(10,img.offsetHeight-t-b)};
 };
 const compile=(type,src)=>{const sh=gl.createShader(type);gl.shaderSource(sh,src);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw new Error('shader');return sh;};
 // 选区采样（双线性），返回 0~1
 const maskAt=(u,v)=>{
  const gx=Math.max(0,Math.min(MW-1,u*(MW-1))),gy=Math.max(0,Math.min(MH-1,v*(MH-1)));
  const x0=Math.floor(gx),y0=Math.floor(gy),x1=Math.min(MW-1,x0+1),y1=Math.min(MH-1,y0+1),fx=gx-x0,fy=gy-y0,m=S.mask;
  return (m[y0*MW+x0]*(1-fx)+m[y0*MW+x1]*fx)*(1-fy)+(m[y1*MW+x0]*(1-fx)+m[y1*MW+x1]*fx)*fy;
 };
 const rebuildWeights=()=>{
  if(!mv)return;
  const iconMode=ddCfg().interactionMode==='icon',fixed=Math.max(0,Math.min(70,Number(ddCfg().fixedBottom??26)||0))/100,boundary=1-fixed,band=Math.max(.012,1/Math.max(16,rows));
  for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
   const k=j*(cols+1)+i,u=i/cols,v=j/rows;
   if(iconMode){
    // Duang 图标模式：底部比例完全固定，上方区域可形变；过渡只发生在固定线以上。
    const t=Math.max(0,Math.min(1,(boundary-v)/band)),w=t*t*(3-2*t);
    mv[k]=w;shw[k]=w;
   }else{
    mv[k]=S.has?maskAt(u,v):1;
    shw[k]=S.has?mv[k]:Math.pow(Math.sin(Math.PI*u),.6)*Math.pow(Math.sin(Math.PI*v),.6);
   }
  }
 };
 // 选区显示层：低分辨率画布放大，边缘自带柔化
 let accent=null;
 const accentRgb=()=>[255,64,129]; // 选区固定用醒目的玫红，不随主题变化，放在各种图上都看得清
 const paintSel=()=>{
  if(!selCv)return;
  const x=selCv.getContext('2d'),id=x.createImageData(MW,MH),[r,g,b]=accentRgb();
  for(let k=0;k<MW*MH;k++){id.data[k*4]=r;id.data[k*4+1]=g;id.data[k*4+2]=b;id.data[k*4+3]=Math.round(Math.min(1,S.mask[k])*175);}
  x.putImageData(id,0,0);
 };
 const placeOverlays=bx=>{
  const l=(img.offsetLeft+bx.left)+'px',t=(img.offsetTop+bx.top)+'px',w=bx.w+'px',h=bx.h+'px';
  for(const c of [canvas,selCv]){if(!c)continue;c.style.left=l;c.style.top=t;c.style.width=w;c.style.height=h;}
 };
 const ensure=()=>{
  if(failed)return false;
  try{
   const bx=box();
   if(!canvas){
    const host=img.offsetParent||img.parentElement;if(!host)throw new Error('no host');
    canvas=document.createElement('canvas');canvas.className='dd-jelly-canvas';canvas.style.cssText='position:absolute;pointer-events:none;display:none;z-index:2;';
    host.appendChild(canvas);
    selCv=document.createElement('canvas');selCv.className='dd-jelly-sel';selCv.width=MW;selCv.height=MH;selCv.style.cssText='position:absolute;pointer-events:none;z-index:3;display:none;';
    host.appendChild(selCv);
    gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:true})||canvas.getContext('experimental-webgl');
    if(!gl)throw new Error('no gl');
    prog=gl.createProgram();
    gl.attachShader(prog,compile(gl.VERTEX_SHADER,'attribute vec2 aPos;attribute vec2 aUv;uniform vec2 uSize;varying vec2 vUv;void main(){vUv=aUv;gl_Position=vec4(aPos.x/uSize.x*2.0-1.0,1.0-aPos.y/uSize.y*2.0,0.0,1.0);}'));
    gl.attachShader(prog,compile(gl.FRAGMENT_SHADER,'precision mediump float;uniform sampler2D uTex;varying vec2 vUv;void main(){gl_FragColor=texture2D(uTex,vUv);}'));
    gl.linkProgram(prog);if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw new Error('link');
    gl.useProgram(prog);
    tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    posBuf=gl.createBuffer();
    locPos=gl.getAttribLocation(prog,'aPos');locSize=gl.getUniformLocation(prog,'uSize');
   }
   const dpr=Math.min(2,window.devicePixelRatio||1);
   if(Math.abs(bx.w-boxW)>.5||Math.abs(bx.h-boxH)>.5||!pos){
    boxW=bx.w;boxH=bx.h;canvas.width=Math.round(bx.w*dpr);canvas.height=Math.round(bx.h*dpr);
    cols=32;rows=Math.max(16,Math.min(56,Math.round(cols*bx.h/bx.w)));
    const n=(cols+1)*(rows+1);pos=new Float32Array(n*2);const uvs=new Float32Array(n*2);
    ofx=new Float32Array(n);ofy=new Float32Array(n);ovx=new Float32Array(n);ovy=new Float32Array(n);mv=new Float32Array(n);shw=new Float32Array(n);baseX=new Float32Array(n);baseY=new Float32Array(n);localW=new Float32Array(n);localW2=new Float32Array(n);activeRanges=[];
    const idx=[];
    for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){const k=j*(cols+1)+i;const x=i/cols*boxW,y=j/rows*boxH;baseX[k]=x;baseY[k]=y;pos[k*2]=x;pos[k*2+1]=y;uvs[k*2]=i/cols;uvs[k*2+1]=j/rows;}
    gl.bindBuffer(gl.ARRAY_BUFFER,posBuf);gl.bufferData(gl.ARRAY_BUFFER,pos,gl.DYNAMIC_DRAW);
    for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){const a=j*(cols+1)+i,b=a+1,c=a+cols+1,d=c+1;idx.push(a,b,c,b,d,c);}
    idxCount=idx.length;
    const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(idx),gl.STATIC_DRAW);
    const ub=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,ub);gl.bufferData(gl.ARRAY_BUFFER,uvs,gl.STATIC_DRAW);
    const locUv=gl.getAttribLocation(prog,'aUv');gl.enableVertexAttribArray(locUv);gl.vertexAttribPointer(locUv,2,gl.FLOAT,false,0,0);
    gl.viewport(0,0,canvas.width,canvas.height);
    rebuildWeights();paintSel();
   }
   placeOverlays(bx);
   if(texSrc!==(img.currentSrc||img.src)){
    gl.bindTexture(gl.TEXTURE_2D,tex);
    // PNG 透明边缘先做预乘 Alpha，避免 WebGL 线性采样把透明像素的白色 RGB 混进轮廓。
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);
    texSrc=img.currentSrc||img.src;
   }
   return true;
  }catch(e){failed=true;destroy();console.warn('[小小桌宠] 局部互动不可用，改用整图弹动',e);return false;}
 };
 // 图片载入后预热 WebGL、纹理与网格，避免把初始化成本压在第一次触摸上。
 img._ddJellyPrepare=()=>ensure();
 const buildLocalInfluence=()=>{
  activeRanges=[];if(!baseX||!localW)return;
  const m=Math.min(boxW,boxH),feedback=Math.max(.1,Math.min(2.5,Number(ddCfg().feedbackRange||100)/100)),R=.17*m*feedback,R2=.22*m*feedback,RR=R*R,RR2=R2*R2,limit=2*R2,limit2=limit*limit;
  for(let j=0;j<=rows;j++){
   const dy=baseY[j*(cols+1)]-cy;if(Math.abs(dy)>limit)continue;
   let start=-1,end=-1;
   for(let i=0;i<=cols;i++){
    const k=j*(cols+1)+i,dx=baseX[k]-cx,d2=dx*dx+dy*dy;
    if(d2>limit2)continue;
    localW[k]=Math.exp(-d2/RR)*mv[k];localW2[k]=Math.exp(-d2/RR2)*mv[k];
    if(start<0)start=i;end=i;
   }
   if(start>=0)activeRanges.push({row:j,start,end});
  }
 };
 const restoreActiveMesh=()=>{
  if(!gl||!posBuf||!baseX||!activeRanges.length)return;
  gl.bindBuffer(gl.ARRAY_BUFFER,posBuf);
  for(const r of activeRanges){const first=r.row*(cols+1)+r.start,last=r.row*(cols+1)+r.end;
   for(let k=first;k<=last;k++){pos[k*2]=baseX[k];pos[k*2+1]=baseY[k];}
   gl.bufferSubData(gl.ARRAY_BUFFER,first*8,pos.subarray(first*2,(last+1)*2));
  }
  activeRanges=[];
 };
 const draw=()=>{
  const m=Math.min(boxW,boxH),feedback=Math.max(.1,Math.min(2.5,Number(ddCfg().feedbackRange||100)/100)),R=.17*m*feedback,R2=.22*m*feedback,RR=R*R,RR2=R2*R2,shAmp=.05*m*amp;
  const useLocal=scope!=='whole',useAff=scope==='whole';
  const [tx,ty,sx,sy,rot]=aff.x,cr=Math.cos(rot*Math.PI/180),sr=Math.sin(rot*Math.PI/180),mx0=boxW/2,my0=boxH/2;
  const shOn=Math.abs(shk.x)>.0005||Math.abs(shk.y)>.0005;
  gl.bindBuffer(gl.ARRAY_BUFFER,posBuf);
  if(scope==='local'&&activeRanges.length){
   for(const r of activeRanges){const first=r.row*(cols+1)+r.start,last=r.row*(cols+1)+r.end;
    for(let i=r.start;i<=r.end;i++){
     const k=r.row*(cols+1)+i,px=baseX[k],py=baseY[k],dx=px-cx,dy=py-cy,w=localW[k],w2=localW2[k],f=1-dep.x*w;
     let x=cx+dx*f+ox.x*w2+ofx[k],y=cy+dy*f+oy.x*w2+ofy[k];
     if(shOn){const q=shw[k];x+=shk.x*shAmp*q*(1+.6*(py/boxH-.5));y+=shk.y*shAmp*q*(1+.4*(px/boxW-.5));}
     pos[k*2]=Math.max(0,Math.min(boxW,x));pos[k*2+1]=Math.max(0,Math.min(boxH,y));
    }
    gl.bufferSubData(gl.ARRAY_BUFFER,first*8,pos.subarray(first*2,(last+1)*2));
   }
  }else{
   for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
    const k=j*(cols+1)+i,px=baseX[k],py=baseY[k],m1=mv[k];let x=px,y=py;
    if(useLocal){const dx=px-cx,dy=py-cy,d2=dx*dx+dy*dy,w=Math.exp(-d2/RR)*m1,w2=Math.exp(-d2/RR2)*m1,f=1-dep.x*w;x=cx+dx*f+ox.x*w2+ofx[k];y=cy+dy*f+oy.x*w2+ofy[k];}
    if(useAff){const dxc=px-mx0,dyc=py-my0,X=mx0+tx+(dxc*cr-dyc*sr)*sx,Y=my0+ty+(dxc*sr+dyc*cr)*sy;x=px+(X-px)*m1;y=py+(Y-py)*m1;}
    if(ddCfg().interactionMode==='icon'){
     // 复刻 Duang 原版：底层保持原位，上层以底边中点为轴 skewX + scaleY。
     const fixed=Math.max(0,Math.min(70,Number(ddCfg().fixedBottom??26)||0))/100,pivotY=boxH*(1-fixed),w=mv[k];
     if(w>0){const dx=x-boxW/2,dy=y-pivotY,rad=(-iconWobble.r)*Math.PI/180,cs=Math.cos(rad),sn=Math.sin(rad),sx=1-iconWobble.s*.5,sy=1+iconWobble.s;
      const skewX=Math.tan(rad);const tx=dx*sx+dy*skewX,ty=dy*sy;
      x=boxW/2+(dx+(tx-dx)*w);y=pivotY+(dy+(ty-dy)*w);
     }
    }else if(shOn){const q=shw[k];x+=shk.x*shAmp*q*(1+.6*(py/boxH-.5));y+=shk.y*shAmp*q*(1+.4*(px/boxW-.5));}
    pos[k*2]=Math.max(0,Math.min(boxW,x));pos[k*2+1]=Math.max(0,Math.min(boxH,y));
   }
   gl.bufferSubData(gl.ARRAY_BUFFER,0,pos);
  }
  gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enableVertexAttribArray(locPos);gl.vertexAttribPointer(locPos,2,gl.FLOAT,false,0,0);
  gl.uniform2f(locSize,boxW,boxH);
  gl.drawElements(gl.TRIANGLES,idxCount,gl.UNSIGNED_SHORT,0);
 };
 const step=s=>{s.v+=(s.t-s.x)*s.k;s.v*=s.d;s.x+=s.v;return Math.abs(s.v)>.002||Math.abs(s.t-s.x)>.002;};
 const resetAll=()=>{
  dep.x=dep.v=ox.x=ox.v=oy.x=oy.v=0;aff.x=[0,0,1,1,0];aff.v=[0,0,0,0,0];aff.t=[0,0,1,1,0];shk.x=shk.y=shk.vx=shk.vy=0;iconWobble.r=iconWobble.vr=iconWobble.s=iconWobble.vs=0;
  if(ofx){ofx.fill(0);ofy.fill(0);ovx.fill(0);ovy.fill(0);}
 };
 const K=.16,D=.80;
 const tick=()=>{
  if(!canvas||!gl){raf=0;return;}
  let live=false;
  live=step(dep)||live;live=step(ox)||live;live=step(oy)||live;
  for(let i=0;i<5;i++){
   if(press&&!press.paint&&i<4&&scope==='whole'){aff.x[i]=aff.t[i];aff.v[i]=0;}
   else{aff.v[i]+=(aff.t[i]-aff.x[i])*K;aff.v[i]*=D;aff.x[i]+=aff.v[i];}
   if(Math.abs(aff.v[i])>.002||Math.abs(aff.t[i]-aff.x[i])>.002)live=true;
  }
  shk.vx+=-shk.x*.1;shk.vx*=.9;shk.x+=shk.vx;shk.vy+=-shk.y*.1;shk.vy*=.9;shk.y+=shk.vy;
  if(Math.abs(shk.x)>.002||Math.abs(shk.vx)>.002||Math.abs(shk.y)>.002||Math.abs(shk.vy)>.002)live=true;
  // Duang 原版图标弹簧：角度与纵向挤压分别回弹。
  iconWobble.vr+=-iconWobble.r*.1;iconWobble.vr*=.9;iconWobble.r+=iconWobble.vr;
  iconWobble.vs+=-iconWobble.s*.14;iconWobble.vs*=.86;iconWobble.s+=iconWobble.vs;
  if(Math.abs(iconWobble.r)+Math.abs(iconWobble.vr)+Math.abs(iconWobble.s*30)+Math.abs(iconWobble.vs*30)>.08)live=true;
  if(ofx){for(let k=0;k<ofx.length;k++){if(!press||!press.smudging){ovx[k]+=(0-ofx[k])*.12;ovy[k]+=(0-ofy[k])*.12;ovx[k]*=.8;ovy[k]*=.8;ofx[k]+=ovx[k];ofy[k]+=ovy[k];}if(Math.abs(ofx[k])>.02||Math.abs(ofy[k])>.02||Math.abs(ovx[k])>.01||Math.abs(ovy[k])>.01)live=true;}}
  draw();
  if(live||(press&&!press.paint))raf=requestAnimationFrame(tick);
  else{raf=0;restoreActiveMesh();canvas.style.display='none';img.style.visibility=originalVisibility;shown=false;resetAll();}
 };
 const show=()=>{if(canvas&&!shown){canvas.style.display='block';img.style.visibility='hidden';shown=true;}};
 const kick=()=>{if(!raf)raf=requestAnimationFrame(tick);};
 const local=e=>{const r=img.getBoundingClientRect(),bx=box(),sx=img.offsetWidth/Math.max(1,r.width),sy=img.offsetHeight/Math.max(1,r.height);return [Math.max(0,Math.min(boxW,(e.clientX-r.left)*sx-bx.left)),Math.max(0,Math.min(boxH,(e.clientY-r.top)*sy-bx.top))];};
 // 涂选区：自由手绘，高斯笔刷取最大值，边缘柔和
 const paintAt=(x,y)=>{
  const erase=S.tool==='erase',u=x/boxW,v=y/boxH,rad=ddJellyBrush()*Math.min(boxW,boxH),rr=rad*rad*1.3;
  for(let j=0;j<MH;j++){const dy=(j/(MH-1)-v)*boxH;if(Math.abs(dy)>rad*2.2)continue;
   for(let i=0;i<MW;i++){const dx=(i/(MW-1)-u)*boxW;if(Math.abs(dx)>rad*2.2)continue;
    const w=Math.exp(-(dx*dx+dy*dy)/rr);{const q=j*MW+i;if(erase)S.mask[q]=Math.max(0,S.mask[q]-w*1.3);else if(w>S.mask[q])S.mask[q]=Math.min(1,w*1.15);}}}
  if(erase){let any=false;for(let q=0;q<S.mask.length;q++){if(S.mask[q]<.04)S.mask[q]=0;else any=true;}S.has=any;}else S.has=true;
  paintSel();rebuildWeights();ddPersistMask(img,S);
 };
 img.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse'&&e.button!==0)return;
  if(!S.selecting&&!conf.tap&&!conf.drag)return;
  if(!ensure()){if(failed)ddAttachJellyWhole(img,conf);return;}
  const [px,py]=local(e);
  try{img.setPointerCapture(e.pointerId);}catch{}
  e.preventDefault();
  if(S.selecting){
   press={id:e.pointerId,paint:true};selCv.style.display='block';paintAt(px,py);return;
  }
  if(scope==='local'&&activeRanges.length)restoreActiveMesh();
  cx=px;cy=py;lx=px;ly=py;if(scope==='local')buildLocalInfluence();
  press={id:e.pointerId,x:e.clientX,y:e.clientY,t:Date.now(),moved:false,smudging:false};
  show();
  Object.assign(dep,{k:.3,d:.6});Object.assign(ox,{k:.3,d:.7});Object.assign(oy,{k:.3,d:.7});
  ox.t=ox.x=0;oy.t=oy.x=0;ox.v=oy.v=0;
  if(scope!=='whole'&&conf.tap)dep.t=Math.min(.5,.3*amp);
  kick();
 },sig);
 img.addEventListener('pointermove',e=>{
  if(!press||e.pointerId!==press.id||!canvas)return;
  if(press.paint){const [px,py]=local(e);paintAt(px,py);return;}
  const dx=e.clientX-press.x,dy=e.clientY-press.y;
  if(!press.moved&&Math.hypot(dx,dy)<6)return;
  press.moved=true;press.dx=dx;
  if(!conf.drag)return;
  if(scope==='whole'){
   const damp=v=>Math.sign(v)*Math.pow(Math.abs(v),.82)*.55;
   const w=boxW,h=boxH,ax=Math.abs(dx)/w,ay=Math.abs(dy)/h;
   const stX=Math.min(.38,ax*.9*amp),stY=Math.min(.38,ay*.9*amp);
   aff.t[0]=damp(dx);aff.t[1]=damp(dy);aff.t[2]=(1+stX)*(1-stY*.45);aff.t[3]=(1+stY)*(1-stX*.45);aff.t[4]=Math.max(-6,Math.min(6,dx/w*5*amp));
   kick();return;
  }
  dep.t=0;
  if(scope==='smudge'){
   // 抹开：手指划过的地方（笔刷半径内）的像素被带着走，松手后各点自己弹回原位。
   const [nx,ny]=local(e);
   const mx=nx-lx,my=ny-ly;lx=nx;ly=ny;cx=nx;cy=ny;press.smudging=true;
   const Rb=.12*Math.min(boxW,boxH),RRb=Rb*Rb,lim=.12*Math.min(boxW,boxH)*amp;
   for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
    const k=j*(cols+1)+i,ddx=i/cols*boxW-nx,ddy=j/rows*boxH-ny,w=Math.exp(-(ddx*ddx+ddy*ddy)/RRb)*mv[k];
    if(w<.02)continue;
    ofx[k]=Math.max(-lim,Math.min(lim,ofx[k]+mx*w*.9));ofy[k]=Math.max(-lim,Math.min(lim,ofy[k]+my*w*.9));ovx[k]=0;ovy[k]=0;
   }
   kick();return;
  }
  const damp=v=>Math.sign(v)*Math.pow(Math.abs(v),.8)*.7*amp;
  ox.t=damp(dx);oy.t=damp(dy);kick();
 },sig);
 const end=e=>{
  if(!press||(e&&e.pointerId!==press.id))return;
  const p=press;press=null;p.smudging=false;try{img.releasePointerCapture(p.id);}catch{}
  if(p.paint){return;}
  Object.assign(dep,{k:.15,d:.78});Object.assign(ox,{k:.13,d:.8});Object.assign(oy,{k:.13,d:.8});
  dep.t=0;ox.t=0;oy.t=0;
  if(scope==='whole'){
   const quick=Date.now()-p.t<450&&!p.moved;
   if(quick&&conf.tap){aff.x[2]=1+.11*amp;aff.x[3]=1-.14*amp;aff.v[2]=0;aff.v[3]=0;}
   else if(p.moved&&conf.drag){aff.v[2]-=(aff.x[2]-1)*.35;aff.v[3]-=(aff.x[3]-1)*.35;}
   aff.t=[0,0,1,1,0];
  }
  kick();
 };
 img.addEventListener('pointerup',end,sig);img.addEventListener('pointercancel',end,sig);
 img.addEventListener('contextmenu',e=>{if(press)e.preventDefault();},sig);
 if(S.selecting&&ensure()){selCv.style.display='block';paintSel();}
 // 摇晃手机：加速度推着选区（没选区时是整张图、边缘不动）晃，停了弹簧自己回来。
 if(conf.shake&&!S.selecting){
  let gx=0,gy=0,primed=false;
  window.addEventListener('devicemotion',e=>{
   if(press)return;
   let ax=0,ay=0;const a=e.acceleration;
   if(a&&(a.x!=null||a.y!=null)){ax=a.x||0;ay=a.y||0;}
   else{const g=e.accelerationIncludingGravity||{};const vx=g.x||0,vy=g.y||0;if(!primed){gx=vx;gy=vy;primed=true;}gx=gx*.9+vx*.1;gy=gy*.9+vy*.1;ax=vx-gx;ay=vy-gy;}
   if(Math.abs(ax)+Math.abs(ay)<1.2)return;
   if(!ensure())return;
   show();
   if(ddCfg().interactionMode==='icon'){
    // 直接采用原版 ddStartBallShake 的受力方向、力度上限与弹簧输入。
    const k=ddJellyCfg().amp/.5,cl=(v,m)=>Math.max(-m,Math.min(m,v));
    iconWobble.vr+=cl(-ax*.45*k,5*k);iconWobble.vs+=cl(ay*.012*k,.05*k);
    iconWobble.r=cl(iconWobble.r,20);iconWobble.s=cl(iconWobble.s,.25);
   }else{
    shk.vx+=Math.max(-1.2,Math.min(1.2,-ax*.025*amp));shk.vy+=Math.max(-1.2,Math.min(1.2,ay*.025*amp));
    shk.x=Math.max(-1.6,Math.min(1.6,shk.x));shk.y=Math.max(-1.6,Math.min(1.6,shk.y));
   }
   kick();
  },sig);
 }
 img._ddJellyRehost=()=>{
  const host=img.offsetParent||img.parentElement;
  if(!host)return false;
  if(canvas&&canvas.parentElement!==host)host.appendChild(canvas);
  if(selCv&&selCv.parentElement!==host)host.appendChild(selCv);
  if(canvas){const bx=box();placeOverlays(bx);}
  return true;
 };
}
function ddAttachJellyWhole(img,conf){
 if(!img)return;
 conf=conf||ddJellyCfg();const amp=conf.amp;
 // 每次打开都按当前设置重新决定是否启用；上一次绑的监听用 AbortController 统一撤掉。
 img._ddJellyAbort?.abort();img._ddJellyAbort=null;
 img.style.transform='';img.style.touchAction='';img.style.transformOrigin='';
 if(!conf.on||(!conf.tap&&!conf.drag))return;
 const ac=new AbortController();img._ddJellyAbort=ac;const sig={signal:ac.signal};
 img.draggable=false;img.style.touchAction='none';img.style.willChange='transform';img.style.webkitUserDrag='none';
 // 状态：x=[tx,ty,sx,sy,rot]，v=速度，t=目标
 const st={x:[0,0,1,1,0],v:[0,0,0,0,0],t:[0,0,1,1,0]};
 let raf=0,drag=null;
 const K=.16,D=.80;
 const apply=()=>{img.style.transform='translate('+st.x[0].toFixed(2)+'px,'+st.x[1].toFixed(2)+'px) rotate('+st.x[4].toFixed(3)+'deg) scale('+st.x[2].toFixed(4)+','+st.x[3].toFixed(4)+')';};
 const tick=()=>{
  let moving=false;
  for(let i=0;i<5;i++){
   if(drag&&i<4){st.x[i]=st.t[i];st.v[i]=0;}
   else{st.v[i]+=(st.t[i]-st.x[i])*K;st.v[i]*=D;st.x[i]+=st.v[i];}
   if(Math.abs(st.v[i])>.0008||Math.abs(st.t[i]-st.x[i])>.0008)moving=true;
  }
  apply();
  if(moving||drag)raf=requestAnimationFrame(tick);
  else{raf=0;st.x=[0,0,1,1,0];st.v=[0,0,0,0,0];img.style.transform='';}
 };
 const kick=()=>{if(!raf)raf=requestAnimationFrame(tick);};
 const rest=()=>{st.t=[0,0,1,1,0];};
 const squish=()=>{st.x[2]=1+.11*amp;st.x[3]=1-.14*amp;st.v[2]=0;st.v[3]=0;rest();kick();};
 img.addEventListener('pointerdown',e=>{
  if(e.pointerType==='mouse'&&e.button!==0)return;
  drag={id:e.pointerId,x:e.clientX,y:e.clientY,t:Date.now(),moved:false};
  try{img.setPointerCapture(e.pointerId);}catch{}
  e.preventDefault();
 },sig);
 img.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.id)return;
  const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  if(!drag.moved&&Math.hypot(dx,dy)<6)return;
  drag.moved=true;
  if(!conf.drag)return;
  const w=img.clientWidth||300,h=img.clientHeight||300;
  // 沿拖动方向拉伸、垂直方向收窄，图片中心跟着手指走一小段（橡皮筋式阻尼）。
  const damp=v=>Math.sign(v)*Math.pow(Math.abs(v),.82)*.55;
  const ax=Math.abs(dx)/w,ay=Math.abs(dy)/h;
  const stretchX=Math.min(.38,ax*.9*amp),stretchY=Math.min(.38,ay*.9*amp);
  st.t[0]=damp(dx);st.t[1]=damp(dy);
  st.t[2]=(1+stretchX)*(1-stretchY*.45);st.t[3]=(1+stretchY)*(1-stretchX*.45);
  st.t[4]=Math.max(-6,Math.min(6,dx/w*5*amp));
  kick();
 },sig);
 const end=e=>{
  if(!drag||(e&&e.pointerId!==drag.id))return;
  const d=drag;drag=null;try{img.releasePointerCapture(d.id);}catch{}
  const quick=Date.now()-d.t<450&&!d.moved;
  if(quick&&conf.tap){squish();return;}
  if(d.moved&&conf.drag){
   // 松手：保留当前拉伸状态，并给一点反向速度，弹簧会带来 Q 弹的过冲。
   st.v[2]-=(st.x[2]-1)*.35;st.v[3]-=(st.x[3]-1)*.35;rest();kick();return;
  }
  rest();kick();
 };
 img.addEventListener('pointerup',end,sig);img.addEventListener('pointercancel',end,sig);
 img.addEventListener('contextmenu',e=>{if(drag)e.preventDefault();},sig);
}
function ddBuildBar(overlay,mountPoint=overlay){

   // 放大图下方的果冻面板：范围 / 选区 / 交互，不用回设置页。
   const bar=document.createElement('div');bar.className='dd-jelly-bar';bar.setAttribute('role','group');bar.setAttribute('aria-label','果冻互动');
   bar.innerHTML='<div class="dd-jb-head"><button type="button" data-jb="power"></button><button type="button" data-jb="more">设置 ▴</button><button type="button" data-jb-tool="add" aria-label="增加选区（画笔）" title="增加选区" hidden><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z"/><path d="M14 7l3 3"/></svg></button><button type="button" data-jb-tool="erase" aria-label="擦除选区（橡皮）" title="擦除选区" hidden><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 20h12"/><path d="M5 15l8-8a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3l-6 6H9z"/><path d="M9 11l6 6"/></svg></button><button type="button" data-jb="clr" aria-label="清除全部选区" title="清除全部选区" hidden><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg></button><button type="button" data-jb="done" aria-label="完成选区" title="完成" hidden><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg></button><label class="dd-jb-brush" hidden title="画笔粗细"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/></svg><input type="range" min="2" max="20" step="1" data-jb-brush aria-label="画笔粗细"></label></div>'
    +'<div class="dd-jb-panel" hidden><div class="dd-jb-row"><b>模式</b><button type="button" data-jb-mode="selection">选区模式</button><button type="button" data-jb-mode="icon">Duang 图标模式</button></div>' 
    +'<div class="dd-jb-row" data-jb-fixed-row hidden><b>底部固定</b><label class="dd-jb-fixed"><input type="range" min="0" max="70" step="2" data-jb-fixed aria-label="底部固定比例"><output data-jb-fixed-value>26%</output></label><em class="dd-jb-hint" data-jb-icon-hint>底部保持不动，上方可拉扯和摇晃；形变可以越过固定线</em></div>'
    +'<div class="dd-jb-row" data-jb-selection-row><b>选区</b><button type="button" data-jb="sel">✎ 涂选区</button><button type="button" data-jb="clr2">清除</button><em class="dd-jb-hint"></em></div>'
    +'<div class="dd-jb-row"><b>反馈</b><label class="dd-jb-feedback"><input type="range" min="10" max="250" step="5" data-jb-feedback aria-label="反馈范围"><output data-jb-feedback-value>100%</output></label></div>'
    +'<div class="dd-jb-row"><b>交互</b><button type="button" data-jb-in="drag">拖动</button><button type="button" data-jb-in="shake">摇晃</button>'
    +'<span class="dd-jb-dd"><button type="button" class="dd-jb-dd-btn" data-jb-dd aria-haspopup="listbox" aria-expanded="false"><span data-jb-dd-label>Q弹</span> ▾</button><span class="dd-jb-dd-list" role="listbox" hidden><button type="button" role="option" data-jb-strength="soft">软糯</button><button type="button" role="option" data-jb-strength="mid">Q弹</button><button type="button" role="option" data-jb-strength="bouncy">DUANG</button></span></span></div>'
    +'<div class="dd-jb-msg" role="status"></div></div>';
   const $b=sel=>bar.querySelector(sel);
   const setMsg=t=>{$b('.dd-jb-msg').textContent=t||'';};
   const feedbackInput=$b('[data-jb-feedback]');const syncFeedbackRange=input=>{if(!input)return;$b('[data-jb-feedback-value]').textContent=input.value+'%';};const showFeedbackPreview=(input)=>{const img=overlay.querySelector('img');if(!img)return;const host=img.parentElement;if(!host)return;let ring=host.querySelector('.dd-jb-feedback-ring');if(!ring){ring=document.createElement('div');ring.className='dd-jb-feedback-ring';host.append(ring);}const feedback=Math.max(.1,Math.min(2.5,Number(input.value||100)/100));const diameter=.34*Math.min(img.clientWidth,img.clientHeight)*feedback;ring.style.width=diameter+'px';ring.style.height=diameter+'px';ring.hidden=false;};const hideFeedbackPreview=()=>{const ring=overlay.querySelector('.dd-jb-feedback-ring');if(ring)ring.hidden=true;};if(feedbackInput){feedbackInput.value=String(ddCfg().feedbackRange||100);syncFeedbackRange(feedbackInput);}
   const paintBar=()=>{
    const c=ddJellyCfg(),img=overlay.querySelector('img'),S=img?ddJellyState(img):{has:false,selecting:false},mode=ddCfg().interactionMode==='icon'?'icon':'selection',fixed=Math.max(0,Math.min(70,Number(ddCfg().fixedBottom??26)||0));
    bar.querySelectorAll('[data-jb-mode]').forEach(b=>b.classList.toggle('is-active',b.dataset.jbMode===mode));
    $b('[data-jb-fixed-row]').hidden=mode!=='icon';$b('[data-jb-selection-row]').hidden=mode!=='selection';
    $b('[data-jb-fixed]').value=String(fixed);$b('[data-jb-fixed-value]').textContent=fixed+'%';
    $b('[data-jb=power]').textContent=c.on?'果冻：开':'果冻：关';$b('[data-jb=power]').classList.toggle('is-active',c.on);
    bar.classList.toggle('is-off',!c.on);bar.classList.toggle('is-selecting',!!S.selecting);
    const ins={tap:c.tap,drag:c.drag,shake:c.shake};const stv=['soft','bouncy'].includes(ddCfg().jellyStrength)?ddCfg().jellyStrength:'mid';bar.querySelectorAll('[data-jb-strength]').forEach(b=>b.classList.toggle('is-active',b.dataset.jbStrength===stv));{const lab=$b('[data-jb-dd-label]');if(lab)lab.textContent={soft:'软糯',mid:'Q弹',bouncy:'DUANG'}[stv];}bar.querySelectorAll('[data-jb-in]').forEach(b=>b.classList.toggle('is-active',!!ins[b.dataset.jbIn]));
    $b('[data-jb=sel]').classList.toggle('is-active',!!S.selecting);
    $b('.dd-jb-hint').textContent=S.has?'已选区（只有选中的地方会动）':'未选区（整张图都会动）';
    $b('.dd-jb-brush').hidden=!S.selecting||mode!=='selection';bar.querySelectorAll('[data-jb-tool]').forEach(t=>{t.hidden=!S.selecting||mode!=='selection';t.classList.toggle('is-active',(S.tool||'add')===t.dataset.jbTool);});$b('[data-jb=power]').hidden=!!S.selecting;{const bi=$b('[data-jb-brush]');if(bi&&document.activeElement!==bi)bi.value=String(Math.round(ddJellyBrush()*100));}
    $b('[data-jb=done]').hidden=!S.selecting||mode!=='selection';$b('[data-jb=clr]').hidden=!S.selecting||mode!=='selection';$b('[data-jb=more]').hidden=!!S.selecting;
    if(S.selecting)$b('.dd-jb-panel').hidden=true;
    $b('[data-jb=more]').textContent=$b('.dd-jb-panel').hidden?'设置 ▴':'收起 ▾';
   };
   const syncSettings=()=>{const sel=document.querySelector('#dd-strength');if(sel)sel.value=['soft','bouncy'].includes(ddCfg().jellyStrength)?ddCfg().jellyStrength:'mid';};
   const rebind=()=>{const img=overlay.querySelector('img');ddAttachJelly(img);img?._ddJellyPrepare?.();paintBar();syncSettings();};
   bar.addEventListener('input',e=>{
    const fi=e.target.closest('[data-jb-feedback]');if(fi){ddCfg().feedbackRange=Number(fi.value);ddSave();syncFeedbackRange(fi);showFeedbackPreview(fi);return;}
    const fixed=e.target.closest('[data-jb-fixed]');if(fixed){$b('[data-jb-fixed-value]').textContent=fixed.value+'%';return;}
    const bi=e.target.closest('[data-jb-brush]');if(!bi)return;e.stopPropagation();
    ddCfg().jellyBrush=Number(bi.value)/100;ddSave();
    // 临时画一个圈让你看到当前粗细
    const img=overlay.querySelector('img'),host=img.offsetParent||img.parentElement;if(!host)return;
    let ring=host.querySelector('.dd-jb-ring');if(!ring){ring=document.createElement('div');ring.className='dd-jb-ring';host.appendChild(ring);}
    const d=2.2*ddJellyBrush()*Math.min(img.clientWidth,img.clientHeight);
    ring.style.cssText='position:absolute;pointer-events:none;z-index:4;border-radius:50%;border:2px solid #ff4081;background:rgba(255,64,129,.25);width:'+d+'px;height:'+d+'px;left:'+(img.offsetLeft+img.clientWidth/2-d/2)+'px;top:'+(img.offsetTop+img.clientHeight/2-d/2)+'px';
    clearTimeout(ring._t);ring._t=setTimeout(()=>ring.remove(),800);
   });
   bar.addEventListener('change',e=>{if(e.target.closest('[data-jb-feedback]'))hideFeedbackPreview();const fixed=e.target.closest('[data-jb-fixed]');if(fixed){ddCfg().fixedBottom=Number(fixed.value);ddSave();rebind();}});
   bar.addEventListener('pointerup',e=>{if(e.target.closest('[data-jb-feedback]'))hideFeedbackPreview();});
   bar.addEventListener('pointercancel',e=>{if(e.target.closest('[data-jb-feedback]'))hideFeedbackPreview();});
   bar.addEventListener('touchend',e=>{if(e.target.closest('[data-jb-feedback]'))hideFeedbackPreview();},{passive:true});
   bar.addEventListener('touchcancel',e=>{if(e.target.closest('[data-jb-feedback]'))hideFeedbackPreview();},{passive:true});
   bar.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b)return;e.preventDefault();e.stopPropagation();
    const c=ddCfg(),img=overlay.querySelector('img'),S=ddJellyState(img),d=b.dataset;
    if(d.jbMode){c.interactionMode=d.jbMode;S.selecting=false;ddSave();rebind();return;}
    if(d.jb==='power'){ddJellyCfg();c.jellyOn=!c.jellyOn;if(!c.jellyOn)S.selecting=false;ddSave();rebind();return;}
    if(d.jb==='more'){const p=$b('.dd-jb-panel');p.hidden=!p.hidden;paintBar();return;}
    if(d.jb==='sel'){ddJellyCfg();if(!c.jellyOn){c.jellyOn=true;ddSave();}S.selecting=true;S.tool='add';rebind();return;}
    if(d.jbTool){S.tool=d.jbTool;paintBar();return;}
    if(d.jb==='done'){S.selecting=false;rebind();return;}
    if(d.jb==='clr'||d.jb==='clr2'){ddJellyClearSelection(img);ddPersistMask(img,S);if(d.jb==='clr')S.selecting=true;rebind();return;}
    if(d.jbDd!==undefined){const l=$b('.dd-jb-dd-list'),p=$b('.dd-jb-panel');l.hidden=!l.hidden;p.classList.toggle('is-dd-open',!l.hidden);b.setAttribute('aria-expanded',String(!l.hidden));return;}
    if(d.jbStrength){c.jellyStrength=d.jbStrength;ddSave();{const l=$b('.dd-jb-dd-list'),p=$b('.dd-jb-panel');l.hidden=true;p.classList.remove('is-dd-open');$b('[data-jb-dd]').setAttribute('aria-expanded','false');}rebind();return;}
    if(d.jbIn){
     ddJellyCfg();const key={tap:'jellyTap',drag:'jellyDrag',shake:'jellyShake'}[d.jbIn];c[key]=!c[key];if(c[key])c.jellyOn=true;ddSave();
     if(d.jbIn==='shake'&&c.jellyShake){setMsg('');await ddJellyEnableMotion(setMsg);}
     else if(d.jbIn==='shake')setMsg('');
     rebind();
    }
   });
   overlay._ddPaintBar=paintBar;overlay._ddMsg=setMsg;mountPoint.append(bar);
  
 return bar;
}

// ===== 放大弹窗 =====

const DB_NAME='little-pet-assets';
function openAssetDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>req.result.createObjectStore('assets');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function dbGet(key){const db=await openAssetDB();return new Promise((resolve,reject)=>{const tx=db.transaction('assets','readonly'),r=tx.objectStore('assets').get(key);r.onsuccess=()=>{db.close();resolve(r.result||null);};r.onerror=()=>{db.close();reject(r.error);};});}
async function dbPut(key,value){const db=await openAssetDB();return new Promise((resolve,reject)=>{const tx=db.transaction('assets','readwrite');tx.objectStore('assets').put(value,key);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};});}
async function dbDelete(key){const db=await openAssetDB();return new Promise((resolve,reject)=>{const tx=db.transaction('assets','readwrite');tx.objectStore('assets').delete(key);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};});}
let maskSaveTimer=0;
function ddPersistMask(img,S){if(!img||!S)return;clearTimeout(maskSaveTimer);maskSaveTimer=setTimeout(()=>{dbPut('pet-mask',{mask:Array.from(S.mask),has:S.has}).catch(e=>console.warn('[小小桌宠] 选区保存失败',e));},180);}
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
let petUrl='',petRoot=null,petImage=null,petFloat=null,petFloatState=null,petBlob=null,petEraser=null,petEraserHistory=[];
function saveCfg(){try{saveSettingsDebounced();}catch{}}
function toast(t){const el=document.querySelector('#lp-toast');if(!el)return;el.textContent=t;el.classList.add('is-visible');clearTimeout(el._timer);el._timer=setTimeout(()=>el.classList.remove('is-visible'),2100);}
function detachPet(){if(petImage)petImage._ddJellyAbort?.abort();if(petFloat)petFloat.remove();petFloat=null;petFloatState=null;petRoot?.remove();petRoot=null;petImage=null;}
function restoreMask(img){return dbGet('pet-mask').then(saved=>{const S=ddJellyState(img);if(saved&&Array.isArray(saved.mask)&&saved.mask.length===S.mask.length){S.mask.set(saved.mask);S.has=!!saved.has;}else{S.mask.fill(0);S.has=false;}ddAttachJelly(img);});}
function makePetRoot(url){const root=document.createElement('div');root.className='lp-interaction';root.innerHTML='<div class="lp-image-host"><img alt="小小桌宠" draggable="false"></div>';const img=root.querySelector('img');img.src=url;return {root,img};}
async function setPetImage(blob){
 if(!blob)return;if(petEraser)await ddSetEraser(false);detachPet();petBlob=blob;petEraserHistory=[];await dbPut('pet-image',blob);if(petUrl)URL.revokeObjectURL(petUrl);petUrl=URL.createObjectURL(blob);
 const made=makePetRoot(petUrl);petRoot=made.root;petImage=made.img;const stage=document.querySelector('#lp-stage');stage.replaceChildren(petRoot);
 await new Promise((resolve,reject)=>{petImage.onload=resolve;petImage.onerror=()=>reject(new Error('图片载入失败'));});
 ddBuildBar(petRoot,document.querySelector('#lp-jelly-slot'));petRoot._ddPaintBar?.();await restoreMask(petImage);petImage._ddJellyPrepare?.();petRoot._ddPaintBar?.();document.querySelector('#lp-empty').hidden=true;
}

function canvasToBlob(canvas){return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG 保存失败')),'image/png'));}
function ddEraserPoint(canvas,e){const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)/Math.max(1,r.width)*canvas.width,y:(e.clientY-r.top)/Math.max(1,r.height)*canvas.height};}
function ddEraserStamp(ctx,x,y,canvas){
 const radius=Math.max(1,Math.min(canvas.width,canvas.height)*Number(document.querySelector('#lp-eraser-size')?.value||7)/200);
 const softness=Number(document.querySelector('#lp-eraser-soft')?.value??65);
 ctx.save();ctx.globalCompositeOperation='destination-out';
 if(softness<=0){ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();}
 else{const inner=radius*(1-softness/100),g=ctx.createRadialGradient(x,y,inner,x,y,radius);g.addColorStop(0,'rgba(0,0,0,1)');g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();}
 ctx.restore();
}
function ddEraserLine(ctx,a,b,canvas){const radius=Math.max(1,Math.min(canvas.width,canvas.height)*Number(document.querySelector('#lp-eraser-size')?.value||7)/200),dist=Math.hypot(b.x-a.x,b.y-a.y),steps=Math.max(1,Math.ceil(dist/Math.max(1,radius*.22)));for(let i=1;i<=steps;i++){const t=i/steps;ddEraserStamp(ctx,a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,canvas);}}
async function ddSetEraser(enabled){
 const tools=document.querySelector('#lp-eraser-tools'),toggle=document.querySelector('#lp-eraser-toggle');
 if(!petImage)return;
 if(!enabled){
  if(!petEraser)return;
  const state=petEraser;petEraser=null;state.canvas.remove();petImage.style.visibility=state.visibility||'';
  if(petBlob){if(petUrl)URL.revokeObjectURL(petUrl);petUrl=URL.createObjectURL(petBlob);petImage.src=petUrl;await new Promise(resolve=>{if(petImage.complete)resolve();else{petImage.onload=resolve;petImage.onerror=resolve;}});}
  tools.hidden=true;toggle?.classList.remove('is-active');toggle?.setAttribute('aria-pressed','false');
  ddAttachJelly(petImage);petImage._ddJellyPrepare?.();petRoot?._ddPaintBar?.();return;
 }
 if(petEraser||petFloat)return;
 const img=petImage,host=img.parentElement;if(!host)return;
 img._ddJellyAbort?.abort();
 const canvas=document.createElement('canvas');canvas.className='lp-eraser-canvas';canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
 canvas.style.left=img.offsetLeft+'px';canvas.style.top=img.offsetTop+'px';canvas.style.width=img.offsetWidth+'px';canvas.style.height=img.offsetHeight+'px';
 const ctx=canvas.getContext('2d',{willReadFrequently:false});ctx.drawImage(img,0,0);
 const state={canvas,ctx,visibility:img.style.visibility,active:null};petEraser=state;host.append(canvas);img.style.visibility='hidden';
 const finishStroke=async stroke=>{
  if(!stroke||!stroke.ready)return;
  const blob=await canvasToBlob(canvas);
  petEraserHistory.push(stroke.before);if(petEraserHistory.length>8)petEraserHistory.shift();
  petBlob=blob;await dbPut('pet-image',blob);
  const undo=document.querySelector('#lp-eraser-undo');if(undo)undo.disabled=!petEraserHistory.length;
 };
 canvas.addEventListener('pointerdown',async e=>{
  if(e.pointerType==='mouse'&&e.button!==0)return;e.preventDefault();if(state.active)return;
  try{canvas.setPointerCapture(e.pointerId);}catch{}
  const stroke={id:e.pointerId,ready:false,points:[ddEraserPoint(canvas,e)],before:null,pendingEnd:false};state.active=stroke;
  try{stroke.before=await canvasToBlob(canvas);stroke.ready=true;for(let i=1;i<stroke.points.length;i++)ddEraserLine(ctx,stroke.points[i-1],stroke.points[i],canvas);ddEraserStamp(ctx,stroke.points[0].x,stroke.points[0].y,canvas);if(stroke.pendingEnd){state.active=null;await finishStroke(stroke);}}
  catch(err){state.active=null;toast(err.message||'橡皮擦初始化失败');}
 });
 canvas.addEventListener('pointermove',e=>{
  const stroke=state.active;if(!stroke||stroke.id!==e.pointerId)return;e.preventDefault();const p=ddEraserPoint(canvas,e);stroke.points.push(p);if(stroke.ready){const n=stroke.points.length;ddEraserLine(ctx,stroke.points[n-2],p,canvas);}
 });
 const end=async e=>{const stroke=state.active;if(!stroke||stroke.id!==e.pointerId)return;try{canvas.releasePointerCapture(e.pointerId);}catch{}if(!stroke.ready){stroke.pendingEnd=true;return;}state.active=null;await finishStroke(stroke);};
 canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
 tools.hidden=false;toggle?.classList.add('is-active');toggle?.setAttribute('aria-pressed','true');
 const size=document.querySelector('#lp-eraser-size'),soft=document.querySelector('#lp-eraser-soft');
 document.querySelector('#lp-eraser-size-value').textContent=size.value+'%';document.querySelector('#lp-eraser-soft-value').textContent=soft.value+'%';
 document.querySelector('#lp-eraser-undo').disabled=true;
}

function mount(){
 if(document.querySelector('#little-pet-root'))return;
 const root=document.createElement('div');root.id='little-pet-root';
 root.innerHTML='<section id="lp-panel" class="lp-panel" aria-hidden="true"><header class="lp-header"><div><b>小小桌宠</b><small>摸摸它，看看会不会 DUANG</small></div><button class="lp-close" type="button">×</button></header><div class="lp-image-actions" aria-label="图片操作"><button id="lp-change-image" class="lp-icon-button" type="button" aria-label="更换图片" title="更换图片"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20M15 4l5 5"/></svg></button><button id="lp-remove-image" class="lp-icon-button is-danger" type="button" aria-label="移除图片" title="移除图片"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></svg></button><button id="lp-eraser-toggle" class="lp-icon-button" type="button" aria-label="橡皮擦" title="橡皮擦"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 15 9-9a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-5 5H8z"/><path d="m8 20 7-7"/></svg></button><input id="lp-file" type="file" accept="image/png,image/webp,image/jpeg" hidden></div><div id="lp-stage" class="lp-stage"><div id="lp-empty" class="lp-empty"><b>放一张图片进来</b><small>支持 PNG、WebP、JPG，建议透明背景立绘</small><button id="lp-upload" type="button">选择图片</button></div></div><div id="lp-eraser-tools" class="lp-eraser-tools" hidden><label>笔刷大小 <input id="lp-eraser-size" type="range" min="1" max="20" value="7"><output id="lp-eraser-size-value">7%</output></label><label>软度 <input id="lp-eraser-soft" type="range" min="0" max="100" value="65"><output id="lp-eraser-soft-value">65%</output></label><div><button id="lp-eraser-undo" type="button">撤销</button><button id="lp-eraser-done" type="button">完成</button></div></div><div id="lp-controls" class="lp-controls"><div id="lp-jelly-slot" class="lp-jelly-slot"></div><div class="lp-toolbar"><button id="lp-reset" type="button">恢复互动状态</button><button id="lp-release" type="button">放出桌宠</button></div></div><div id="lp-toast" role="status"></div></section>';
 document.body.append(root);
 const panel=root.querySelector('#lp-panel');
 // 将操作面板直接挂到 body，脱离酒馆可能带有 transform 的扩展容器，避免 fixed 定位偏移。
 document.body.append(panel);
 const rememberFloatState=f=>{if(!f)return;const r=f.getBoundingClientRect();petFloatState={left:r.left,top:r.top,width:r.width,height:r.height,scale:f._lpCurrentScale||1};};
 const returnPetToEditor=()=>{if(!petFloat||!petRoot)return false;rememberFloatState(petFloat);petFloat.remove();petFloat=null;petRoot.style.transform='';petRoot.style.transformOrigin='';panel.querySelector('#lp-stage').append(petRoot);petImage._ddJellyRehost?.();petRoot._ddPaintBar?.();return true;};
 const open=()=>{if(petFloat)returnPetToEditor();panel.classList.add('is-open');panel.setAttribute('aria-hidden','false');requestAnimationFrame(()=>petImage?._ddJellyRehost?.());};
 const close=()=>{if(petEraser)ddSetEraser(false);panel.classList.remove('is-open');panel.setAttribute('aria-hidden','true');};
 const injectWandButton=()=>{
  const menu=document.querySelector('#extensionsMenu');if(!menu)return false;
  if(menu.querySelector('#little_pet_wand'))return true;
  const container=document.createElement('div');container.id='little_pet_wand_container';container.className='extension_container';
  const item=document.createElement('div');item.id='little_pet_wand';item.className='list-group-item flex-container flexGap5';
  const icon=document.createElement('div');icon.className='fa-solid fa-paw extensionsMenuExtensionButton';
  item.append(icon,document.createTextNode('小小桌宠'));
  item.addEventListener('click',()=>panel.classList.contains('is-open')?close():open());
  container.append(item);menu.append(container);return true;
 };
 if(!injectWandButton()){const observer=new MutationObserver(()=>{if(injectWandButton())observer.disconnect();});observer.observe(document.body,{childList:true,subtree:true});}
 panel.querySelector('.lp-close').addEventListener('click',close);
 panel.querySelector('#lp-upload').addEventListener('click',()=>panel.querySelector('#lp-file').click());
 panel.querySelector('#lp-change-image').addEventListener('click',()=>panel.querySelector('#lp-file').click());
 panel.querySelector('#lp-file').addEventListener('change',async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;try{await setPetImage(f);toast('图片已保存');}catch(err){toast(err.message||'图片载入失败');}});
 panel.querySelector('#lp-eraser-toggle').addEventListener('click',()=>{if(petEraser)ddSetEraser(false);else ddSetEraser(true);});
 panel.querySelector('#lp-eraser-size').addEventListener('input',e=>{panel.querySelector('#lp-eraser-size-value').textContent=e.target.value+'%';});
 panel.querySelector('#lp-eraser-soft').addEventListener('input',e=>{panel.querySelector('#lp-eraser-soft-value').textContent=e.target.value+'%';});
 panel.querySelector('#lp-eraser-done').addEventListener('click',()=>ddSetEraser(false));
 panel.querySelector('#lp-eraser-undo').addEventListener('click',async()=>{
  if(!petEraser||!petEraserHistory.length)return;
  const blob=petEraserHistory.pop(),bitmap=await createImageBitmap(blob),c=petEraser.canvas,ctx=petEraser.ctx;
  ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(bitmap,0,0);bitmap.close?.();
  petBlob=await canvasToBlob(c);await dbPut('pet-image',petBlob);
  panel.querySelector('#lp-eraser-undo').disabled=!petEraserHistory.length;
 });

 panel.querySelector('#lp-release').addEventListener('click',async()=>{
  if(petEraser)await ddSetEraser(false);
  if(!petRoot||!petImage)return toast('请先选择桌宠图片');
  if(petFloat)return;
  const f=document.createElement('div');f.id='lp-float';
  const content=document.createElement('div');content.className='lp-float-content';f.append(content);document.body.append(f);petFloat=f;
  petRoot.style.transform='';petRoot.style.transformOrigin='';content.append(petRoot);
  requestAnimationFrame(()=>{
   const contentRect=content.getBoundingClientRect();
   const base={width:contentRect.width,height:contentRect.height,contentWidth:contentRect.width,contentHeight:contentRect.height,ratio:contentRect.width/Math.max(1,contentRect.height)};
   f._lpResizeBase=base;f._lpCurrentScale=1;
   if(petFloatState){
    const initialScale=clamp(petFloatState.scale||1,.01,Math.max(.01,Math.min((innerWidth-16)/base.width,(innerHeight-16)/base.height)));
    f.style.width=base.width*initialScale+'px';f.style.height=base.height*initialScale+'px';
    content.style.width=base.contentWidth*initialScale+'px';content.style.height=base.contentHeight*initialScale+'px';
    petRoot.style.transformOrigin='center center';petRoot.style.transform='scale('+initialScale+')';f._lpCurrentScale=initialScale;
    f.style.left=clamp(petFloatState.left,0,innerWidth-f.offsetWidth)+'px';f.style.top=clamp(petFloatState.top,0,innerHeight-f.offsetHeight)+'px';
   }else{
    f.style.left=Math.max(8,innerWidth-f.offsetWidth-24)+'px';f.style.top=Math.max(8,innerHeight-f.offsetHeight-100)+'px';
   }
   const dragZone=document.createElement('div');dragZone.className='lp-float-drag';dragZone.setAttribute('aria-label','移动桌宠');f.append(dragZone);
   let move=null;
   dragZone.addEventListener('pointerdown',e=>{e.preventDefault();move={id:e.pointerId,x:e.clientX-f.getBoundingClientRect().left,y:e.clientY-f.getBoundingClientRect().top};dragZone.setPointerCapture(e.pointerId);});
   dragZone.addEventListener('pointermove',e=>{if(!move||move.id!==e.pointerId)return;f.style.left=clamp(e.clientX-move.x,0,innerWidth-f.offsetWidth)+'px';f.style.top=clamp(e.clientY-move.y,0,innerHeight-f.offsetHeight)+'px';rememberFloatState(f);});
   const moveEnd=e=>{if(move&&move.id===e.pointerId){move=null;rememberFloatState(f);}};dragZone.addEventListener('pointerup',moveEnd);dragZone.addEventListener('pointercancel',moveEnd);
   ['nw','ne','sw','se'].forEach(handle=>{
    const grip=document.createElement('div');grip.className='lp-float-resize lp-resize-'+handle;grip.dataset.handle=handle;grip.setAttribute('aria-label','调整桌宠大小');f.append(grip);
    grip.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();const r=f.getBoundingClientRect();f._lpResizeDrag={id:e.pointerId,x:e.clientX,y:e.clientY,left:r.left,top:r.top,width:r.width,height:r.height,scale:f._lpCurrentScale||1};grip.setPointerCapture(e.pointerId);});
    grip.addEventListener('pointermove',e=>{
     const q=f._lpResizeDrag;if(!q||q.id!==e.pointerId)return;
     const dx=e.clientX-q.x,dy=e.clientY-q.y,sign=handle.includes('w')?-1:1,vertical=handle.includes('n')?-1:1;
     const delta=Math.abs(dx)>Math.abs(dy)*base.ratio?dx*sign:dy*vertical*base.ratio;
     const minScale=.01,maxScale=Math.max(.01,Math.min((innerWidth-16)/base.width,(innerHeight-16)/base.height));
     const scale=clamp(q.scale+delta/base.width,minScale,maxScale),w=base.width*scale,h=base.height*scale;
     f.style.width=w+'px';f.style.height=h+'px';content.style.width=base.contentWidth*scale+'px';content.style.height=base.contentHeight*scale+'px';
     petRoot.style.transformOrigin='center center';petRoot.style.transform='scale('+scale+')';f._lpCurrentScale=scale;
     const left=handle.includes('w')?q.left+q.width-w:q.left,top=handle.includes('n')?q.top+q.height-h:q.top;
     f.style.left=clamp(left,0,innerWidth-w)+'px';f.style.top=clamp(top,0,innerHeight-h)+'px';rememberFloatState(f);
    });
    const finish=e=>{if(f._lpResizeDrag?.id===e.pointerId){f._lpResizeDrag=null;rememberFloatState(f);}};grip.addEventListener('pointerup',finish);grip.addEventListener('pointercancel',finish);
   });
   petImage._ddJellyRehost?.();petRoot._ddPaintBar?.();rememberFloatState(f);
  });
  close();
 });
 panel.querySelector('#lp-reset').addEventListener('click',()=>{if(!petImage)return;petImage._ddJellyAbort?.abort();ddJellyClearSelection(petImage);ddPersistMask(petImage,ddJellyState(petImage));ddAttachJelly(petImage);petImage._ddJellyPrepare?.();toast('互动状态已复位');});
 panel.querySelector('#lp-remove-image').addEventListener('click',async()=>{if(petEraser)await ddSetEraser(false);detachPet();petBlob=null;petEraserHistory=[];await dbDelete('pet-image');await dbDelete('pet-mask');const stage=panel.querySelector('#lp-stage');stage.replaceChildren(panel.querySelector('#lp-empty'));panel.querySelector('#lp-empty').hidden=false;panel.querySelector('#lp-jelly-slot').replaceChildren();toast('图片已移除');});
 // 编辑器入口由酒馆魔法棒菜单提供；不再创建悬浮球。
 dbGet('pet-image').then(blob=>{if(blob)setPetImage(blob).catch(e=>toast(e.message));}).catch(e=>console.warn('[小小桌宠] 恢复图片失败',e));
}
function init(){if(window.__littlePetReady)return;window.__littlePetReady=true;mount();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
