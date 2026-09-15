/* ============================================================
 * 黑客监控窗 · NovelAI 生图监控扩展  v3.0
 * SillyTavern 第三方扩展（manifest.json + index.js）
 * 作者：千千 & 小克老师
 * v3.0：常驻可拖动【悬浮按钮】→ 打开【监控浮窗】（图/心率情绪/设置全在浮窗里）
 *       + 可选每条AI回复末尾也内嵌一个监控窗
 * 出图走酒馆同源 /api/novelai/generate-image（NAI key 存酒馆 API连接→NovelAI）
 * ============================================================ */

// 用酒馆标准模块导入（和其它能跑的扩展一致），不依赖 window.SillyTavern.getContext
import { chat, event_types, eventSource, saveSettingsDebounced, getRequestHeaders, generateQuietPrompt } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";

const MODULE = 'nai_monitor';
// 兼容层：保持后面代码 getCtx().xxx 的写法不变
function getCtx() {
  return { chat, generateQuietPrompt, getRequestHeaders, saveSettingsDebounced, eventSource, event_types, eventTypes: event_types, extensionSettings: extension_settings };
}

const DEF_INST =
`你是一套隐蔽监控系统的【画面分析模块】。下面会给你角色扮演的最新正文和历史片段。
请根据场景自动判断此刻最该被监控拍到的一个主体（可能是某个角色，也可能是用户）。
只输出一个 JSON 对象（不要解释、不要代码块、不要多余文字），字段如下：
{
  "prompt": "用英文danbooru标签描述该主体此刻的监控画面，逗号分隔；含人物特征/表情/动作/镜头视角/环境/光线；像监控或偷拍视角",
  "negative": "此画面额外不想出现的英文标签，可空",
  "subject": "画面主体是谁，中文简短",
  "mood": "该主体当前情绪，中文2-4字",
  "heart_rate": 该主体大致心率数字(50-160)，判断不了给 "--",
  "target": "此刻监控锁定目标，中文简短",
  "status": "一句话监控备注，黑客/系统口吻，中文，20字内",
  "threat": 掌控度或危险度 0-100 的数字
}`;

const DEFAULTS = {
  enabled: true, inline: true, fab: true,
  route: 'relay', key: '', proxy: '',
  model: 'nai-diffusion-4-5-full',
  size: '832x1216', w: 832, h: 1216,
  sampler: 'k_euler_ancestral', sched: 'karras', steps: 28, scale: 5,
  seed: '', variety: false, sm: false, smdyn: false, decr: false,
  pos: 'best quality, amazing quality, very aesthetic, absurdres',
  neg: 'lowres, worst quality, bad quality, bad anatomy, bad hands, missing fingers, extra digits, text, watermark, signature, jpeg artifacts, blurry',
  api: 'main', aurl: '', akey: '', amodel: '', asrc: 'openai',
  hist: 2, temp: 0.7, inst: DEF_INST,
  trig: 'auto', markerOnly: false, showhr: true, accent: '#38f0c8'
};

let _LOCAL = null;
function S() {
  const c = getCtx();
  if (c && c.extensionSettings) {
    c.extensionSettings[MODULE] = Object.assign({}, DEFAULTS, c.extensionSettings[MODULE] || {});
    return c.extensionSettings[MODULE];
  }
  if (!_LOCAL) _LOCAL = Object.assign({}, DEFAULTS);
  return _LOCAL;
}
function saveS() { const c = getCtx(); if (c && c.saveSettingsDebounced) c.saveSettingsDebounced(); }

/* ---------------- 工具 ---------------- */
const clean = s => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/[|{}]/g, '').replace(/"/g, '').replace(/\s+/g, ' ').trim();
const stripTags = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/[<＜]监控窗[^]*?[>＞]/g, ' ').replace(/\s+/g, ' ').trim();
function parseJSON(t) {
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) {}
  const m = String(t).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}
function sizeWH() { const s = S(); if (s.size === 'custom') return { w: parseInt(s.w) || 832, h: parseInt(s.h) || 1216 }; const p = (s.size || '832x1216').split('x'); return { w: parseInt(p[0]), h: parseInt(p[1]) }; }
function seedVal() { const s = S(); const v = parseInt(s.seed); return (s.seed !== '' && !isNaN(v)) ? v : Math.floor(Math.random() * 4294967295); }
function latestAiId() { const c = getCtx(); const chat = c && c.chat || []; for (let i = chat.length - 1; i >= 0; i--) if (chat[i] && !chat[i].is_user) return i; return -1; }

/* ---------------- 样式 ---------------- */
const CSS = `
.nm-root{--acc:#38f0c8;--acc2:#7dffb0;--amber:#ffb02e;--rec:#ff2d40;--pnl:#0a1114;--line:#12211f;--txt:#b8ffe0;--mut:#5a7d73;--dim:#22403a;
  display:block;font-family:ui-monospace,"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;color:var(--txt)}
.nm-root *{box-sizing:border-box}
.nm-inline{margin-top:10px}
.nm-frame{position:relative;max-width:440px;margin:0 auto;background:linear-gradient(180deg,#0b1417,#060c0e);border:1px solid var(--line);border-radius:12px;padding:10px;box-shadow:0 0 0 1px #000 inset,0 10px 30px rgba(0,0,0,.5);overflow:hidden}
.nm-top{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.5px;color:var(--mut);padding:2px 2px 8px;border-bottom:1px dashed var(--line)}
.nm-rec{color:var(--rec);font-weight:700;display:flex;align-items:center;gap:4px}
.nm-rec i{width:8px;height:8px;border-radius:50%;background:var(--rec);box-shadow:0 0 8px var(--rec);animation:nmblink 1.1s steps(1) infinite}
@keyframes nmblink{50%{opacity:.15}}
.nm-cam{color:var(--acc);opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nm-clock{margin-left:auto;color:var(--acc2);font-variant-numeric:tabular-nums}
.nm-sig{display:inline-flex;align-items:flex-end;gap:2px;height:12px}
.nm-sig b{width:3px;background:var(--acc);border-radius:1px}
.nm-sig b:nth-child(1){height:4px}.nm-sig b:nth-child(2){height:7px}.nm-sig b:nth-child(3){height:10px}
.nm-sig b.off{background:var(--dim);height:12px}
.nm-gear,.nm-min{cursor:pointer;font-size:15px;color:var(--mut);padding:3px 5px;border-radius:6px}
.nm-gear:active,.nm-min:active{color:var(--acc);background:#0c1a16}
.nm-screen{position:relative;aspect-ratio:4/5;margin:8px 0;border-radius:8px;overflow:hidden;background:radial-gradient(120% 90% at 50% 20%,#0a1a18,#020505);border:1px solid var(--line)}
.nm-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .5s;filter:contrast(1.05) saturate(1.05)}
.nm-img.show{opacity:1}
.nm-scan{position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 1px,transparent 1px 3px)}
.nm-scan::after{content:"";position:absolute;left:0;right:0;height:32%;top:-32%;background:linear-gradient(180deg,transparent,rgba(125,255,176,.06),transparent);animation:nmsweep 4.5s linear infinite}
@keyframes nmsweep{0%{top:-32%}100%{top:100%}}
.nm-vig{position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 50px rgba(0,0,0,.75)}
.nm-rt{position:absolute;width:16px;height:16px;border:2px solid var(--acc);opacity:.85}
.nm-rt.tl{top:8px;left:8px;border-right:0;border-bottom:0}.nm-rt.tr{top:8px;right:8px;border-left:0;border-bottom:0}
.nm-rt.bl{bottom:8px;left:8px;border-right:0;border-top:0}.nm-rt.br{bottom:8px;right:8px;border-left:0;border-top:0}
.nm-cross{position:absolute;inset:0;pointer-events:none;opacity:.35}
.nm-cross i,.nm-cross b{position:absolute;background:var(--acc)}
.nm-cross i{left:50%;top:44%;width:1px;height:12%;transform:translateX(-.5px)}
.nm-cross b{top:50%;left:44%;height:1px;width:12%;transform:translateY(-.5px)}
.nm-hud{position:absolute;font-size:9px;letter-spacing:.5px;color:var(--acc2);text-shadow:0 0 4px #000;background:rgba(0,0,0,.35);padding:2px 5px;border-radius:3px;max-width:70%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.nm-hud.tlh{top:8px;left:28px}.nm-hud.trh{top:8px;right:28px;color:var(--amber)}.nm-hud.blh{bottom:8px;left:28px}.nm-hud.brh{bottom:8px;right:28px;color:var(--rec)}
.nm-load{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(2,6,7,.55)}
.nm-load.hide{display:none}
.nm-spin{width:34px;height:34px;border:2px solid var(--dim);border-top-color:var(--acc);border-radius:50%;animation:nmsp .8s linear infinite}
@keyframes nmsp{100%{transform:rotate(360deg)}}
.nm-lt{font-size:11px;letter-spacing:2px;color:var(--acc);animation:nmblink 1.4s steps(1) infinite;text-align:center;padding:0 10px}
.nm-bar{width:60%;height:3px;background:var(--dim);border-radius:2px;overflow:hidden}
.nm-bar i{display:block;height:100%;width:8%;background:var(--acc);box-shadow:0 0 8px var(--acc);transition:width .3s}
.nm-read{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:2px 0 6px}
.nm-read.hide{display:none}
.nm-cell{position:relative;background:var(--pnl);border:1px solid var(--line);border-radius:6px;padding:6px 8px;overflow:hidden}
.nm-cell::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--acc);opacity:.7}
.nm-k{display:block;font-size:8.5px;letter-spacing:1px;color:var(--mut)}
.nm-v{display:flex;align-items:baseline;gap:3px;margin-top:1px}
.nm-v em{font-style:normal;font-size:19px;font-weight:700;color:var(--acc2);line-height:1;font-variant-numeric:tabular-nums}
.nm-v em.txt{font-size:14px}
.nm-v small{font-size:9px;color:var(--mut)}
.nm-ecg{position:absolute;right:6px;bottom:5px;width:56px;height:16px;opacity:.8}
.nm-ecg polyline{fill:none;stroke:var(--rec);stroke-width:1.5;stroke-dasharray:260;stroke-dashoffset:260;animation:nmecg 1.4s linear infinite}
@keyframes nmecg{100%{stroke-dashoffset:0}}
.nm-tbar{margin-top:5px;height:4px;background:var(--dim);border-radius:2px;overflow:hidden}
.nm-tbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--acc),var(--amber));transition:width .6s}
.nm-log{font-size:10px;color:var(--acc);background:#020706;border:1px solid var(--line);border-radius:5px;padding:5px 8px;min-height:24px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.nm-foot{display:flex;align-items:center;gap:8px;margin-top:7px;font-size:10px;color:var(--mut)}
.nm-node{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nm-btns{margin-left:auto;display:flex;gap:6px}
.nm-b{cursor:pointer;font-size:11px;color:var(--acc);background:#08130f;border:1px solid var(--dim);border-radius:5px;padding:6px 10px;letter-spacing:.5px}
.nm-b:active{transform:translateY(1px)}
.nm-brand{text-align:center;font-size:8px;letter-spacing:2px;color:var(--dim);margin-top:6px}
/* 内嵌设置面板 */
.nm-cfg{position:absolute;inset:0;z-index:9;background:linear-gradient(180deg,#060d0f,#03080a);border-radius:12px;display:flex;flex-direction:column}
.nm-cfg.hide{display:none}
.nm-cfg-h{display:flex;align-items:center;justify-content:space-between;padding:11px 13px;border-bottom:1px solid var(--line);font-size:13px;color:var(--acc);letter-spacing:1px}
.nm-x{cursor:pointer;color:var(--mut);font-size:18px;padding:0 6px}
.nm-cfg-b{flex:1;overflow-y:auto;padding:9px 12px;-webkit-overflow-scrolling:touch}
.nm-cfg h4{margin:11px 0 3px;font-size:12px;color:var(--acc2)}
.nm-cfg label{display:flex;flex-direction:column;gap:3px;font-size:10.5px;color:var(--mut);margin:6px 0}
.nm-cfg input,.nm-cfg select,.nm-cfg textarea{background:#02100c;border:1px solid var(--dim);border-radius:5px;color:var(--txt);font-size:12px;padding:7px 8px;width:100%}
.nm-cfg textarea{resize:vertical;line-height:1.4;min-height:46px}
.nm-cfg input[type=color]{padding:2px;height:32px}
.nm-cfg .row{display:flex;gap:8px}.nm-cfg .row>label{flex:1}
.nm-cfg .ck{flex-direction:row!important;align-items:center;gap:6px!important;font-size:11px;color:var(--txt)}
.nm-cfg .ck input{width:auto}
.nm-cfg .hint{font-size:9.5px;color:var(--dim);line-height:1.4}
.nm-cfg-f{display:flex;gap:8px;padding:9px 12px;border-top:1px solid var(--line)}
.nm-cfg-f .nm-b{flex:1;text-align:center;padding:9px}
/* 悬浮按钮 + 浮窗 */
#nm-fab{position:fixed;right:14px;bottom:96px;z-index:99998;width:46px;height:46px;border-radius:50%;
  background:radial-gradient(circle at 32% 30%,#0e2a24,#05100d);border:1px solid #38f0c8;color:#38f0c8;
  display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer;touch-action:none;user-select:none;
  box-shadow:0 4px 16px rgba(0,0,0,.55),0 0 14px rgba(56,240,200,.35)}
#nm-fab .dot{position:absolute;top:7px;right:7px;width:8px;height:8px;border-radius:50%;background:#ff2d40;box-shadow:0 0 6px #ff2d40;animation:nmblink 1.1s steps(1) infinite}
#nm-float{position:fixed;right:12px;bottom:150px;z-index:99999;width:min(93vw,430px);display:none}
#nm-float.show{display:block}
#nm-float .nm-frame{margin:0;max-width:none;box-shadow:0 12px 40px rgba(0,0,0,.7),0 0 20px rgba(56,240,200,.12)}
#nm-float .nm-cfg-b{max-height:60vh}
#nm-float .nm-screen{max-height:52vh}
`;

function injectStyle() {
  if (document.getElementById('nai-mon-style')) return;
  const s = document.createElement('style'); s.id = 'nai-mon-style'; s.textContent = CSS; document.head.appendChild(s);
}

/* ---------------- 监控窗核心 DOM（不含设置） ---------------- */
const CORE = `
<div class="nm-frame">
  <div class="nm-top nm-handle">
    <span class="nm-rec"><i></i>REC</span>
    <span class="nm-cam">CAM_07 · TARGET_LOCK</span>
    <span class="nm-clock">--:--:--</span>
    <span class="nm-sig"><b></b><b></b><b></b><b class="off"></b></span>
    <span class="nm-gear" title="设置">⚙</span>
    <span class="nm-min" title="收起" data-min>▾</span>
  </div>
  <div class="nm-screen">
    <img class="nm-img" alt=""/>
    <div class="nm-scan"></div><div class="nm-vig"></div>
    <span class="nm-rt tl"></span><span class="nm-rt tr"></span><span class="nm-rt bl"></span><span class="nm-rt br"></span>
    <div class="nm-cross"><i></i><b></b></div>
    <div class="nm-hud tlh nm-subj">SUBJECT: ---</div>
    <div class="nm-hud trh nm-model">NAI</div>
    <div class="nm-hud blh nm-stamp">--:--:-- · 34.5°N</div>
    <div class="nm-hud brh">◉ LIVE</div>
    <div class="nm-load"><div class="nm-spin"></div><div class="nm-lt">SIGNAL ACQUIRING…</div><div class="nm-bar"><i></i></div></div>
  </div>
  <div class="nm-read">
    <div class="nm-cell"><span class="nm-k">HEART RATE</span><span class="nm-v"><em class="nm-hr">--</em><small>bpm</small></span>
      <svg class="nm-ecg" viewBox="0 0 120 24" preserveAspectRatio="none"><polyline points="0,12 20,12 26,4 32,20 38,12 60,12 66,6 72,18 78,12 120,12"/></svg></div>
    <div class="nm-cell"><span class="nm-k">MOOD</span><span class="nm-v"><em class="nm-mood txt">待机</em></span></div>
    <div class="nm-cell"><span class="nm-k">TARGET</span><span class="nm-v"><em class="nm-target txt">---</em></span></div>
    <div class="nm-cell"><span class="nm-k">CONTROL</span><span class="nm-v"><em class="nm-threatn txt">--%</em></span><div class="nm-tbar"><i></i></div></div>
  </div>
  <div class="nm-log"><span class="nm-status">// system idle. awaiting feed…</span></div>
  <div class="nm-foot"><span class="nm-node">NODE 10.7.•.• · TRACE:OFF</span>
    <span class="nm-btns"><button class="nm-b nm-gen">▶ 生成</button><button class="nm-b nm-re">🔄 重截</button></span></div>
  <div class="nm-brand">NAI-SURVEILLANCE · v3.0</div>
</div>`;

/* ---------------- 设置面板 HTML（浮窗内嵌，单实例） ---------------- */
function cfgHTML() {
  const s = S();
  const sel = (arr, cur) => arr.map(v => `<option value="${v}"${v === cur ? ' selected' : ''}>${v}</option>`).join('');
  const L = (t, h) => `<label>${t}${h}</label>`;
  return `
  <div class="nm-cfg hide">
    <div class="nm-cfg-h"><span>监控窗 · 设置</span><span class="nm-x" data-cfgclose>✕</span></div>
    <div class="nm-cfg-b">
      <h4>▍出图 / NovelAI</h4>
      ${L('出图方式', `<select data-k="route"><option value="relay"${s.route==='relay'?' selected':''}>酒馆中转（推荐·稳定）</option><option value="direct"${s.route==='direct'?' selected':''}>直连NovelAI（需代理·高级）</option></select>`)}
      <p class="hint">中转：NAI key 填在酒馆「API连接→NovelAI」连一次即可。直连：key填下面，通常要填代理前缀绕过跨域。</p>
      ${L('NAI Key（仅直连用）', `<input type="password" data-k="key" value="${s.key||''}" autocomplete="off">`)}
      ${L('代理前缀（仅直连用，可空）', `<input data-k="proxy" value="${s.proxy||''}" placeholder="https://你的代理/">`)}
      ${L('模型', `<select data-k="model">${sel(['nai-diffusion-4-5-full','nai-diffusion-4-5-curated','nai-diffusion-5-full','nai-diffusion-5-curated','nai-diffusion-4-full','nai-diffusion-4-curated','nai-diffusion-3','nai-diffusion-furry-3'],s.model)}</select>`)}
      <div class="row">${L('尺寸', `<select data-k="size">${sel(['832x1216','1216x832','1024x1024','512x768','custom'],s.size)}</select>`)}${L('宽', `<input type="number" data-k="w" value="${s.w}">`)}${L('高', `<input type="number" data-k="h" value="${s.h}">`)}</div>
      <div class="row">${L('采样器', `<select data-k="sampler">${sel(['k_euler_ancestral','k_euler','k_dpmpp_2m','k_dpmpp_2m_sde','k_dpmpp_sde','k_dpmpp_2s_ancestral','k_dpm_2','ddim_v3'],s.sampler)}</select>`)}${L('噪声调度', `<select data-k="sched">${sel(['karras','native','exponential','polyexponential'],s.sched)}</select>`)}</div>
      <div class="row">${L('步数', `<input type="number" data-k="steps" value="${s.steps}">`)}${L('引导 scale', `<input type="number" step="0.5" data-k="scale" value="${s.scale}">`)}</div>
      <div class="row">${L('种子（空=随机）', `<input data-k="seed" value="${s.seed||''}" placeholder="随机">`)}<label class="ck"><input type="checkbox" data-k="variety"${s.variety?' checked':''}>variety+</label></div>
      <div class="row"><label class="ck"><input type="checkbox" data-k="sm"${s.sm?' checked':''}>SMEA</label><label class="ck"><input type="checkbox" data-k="smdyn"${s.smdyn?' checked':''}>SMEA DYN</label><label class="ck"><input type="checkbox" data-k="decr"${s.decr?' checked':''}>decrisper</label></div>
      ${L('正面质量前缀', `<textarea data-k="pos">${s.pos}</textarea>`)}
      ${L('负面 / UC', `<textarea data-k="neg">${s.neg}</textarea>`)}
      <h4>▍提示词生成（读正文→出tags）</h4>
      ${L('用哪个API分析正文', `<select data-k="api"><option value="main"${s.api==='main'?' selected':''}>主API（酒馆当前接的）</option><option value="custom"${s.api==='custom'?' selected':''}>副API（自定义）</option></select>`)}
      ${L('副API 地址', `<input data-k="aurl" value="${s.aurl||''}" placeholder="https://api.xxx.com/v1">`)}
      ${L('副API Key', `<input type="password" data-k="akey" value="${s.akey||''}" autocomplete="off">`)}
      <div class="row">${L('副API 模型', `<input data-k="amodel" value="${s.amodel||''}" placeholder="gpt-4o-mini / deepseek-chat">`)}${L('历史楼层数', `<input type="number" data-k="hist" value="${s.hist}">`)}</div>
      ${L('温度', `<input type="number" step="0.1" data-k="temp" value="${s.temp}">`)}
      ${L('分析指令', `<textarea data-k="inst" style="min-height:120px">${s.inst}</textarea>`)}
      <h4>▍监控 / 显示</h4>
      ${L('触发方式', `<select data-k="trig"><option value="auto"${s.trig==='auto'?' selected':''}>自动（最新楼层出图）</option><option value="manual"${s.trig==='manual'?' selected':''}>手动（点▶生成）</option></select>`)}
      <label class="ck"><input type="checkbox" data-k="inline"${s.inline?' checked':''}>每条AI回复末尾也内嵌一个监控窗</label>
      <label class="ck"><input type="checkbox" data-k="markerOnly"${s.markerOnly?' checked':''}>内嵌时仅在带 &lt;监控窗&gt; 标记的回复显示</label>
      <label class="ck"><input type="checkbox" data-k="showhr"${s.showhr?' checked':''}>显示心率/情绪读数</label>
      <label class="ck"><input type="checkbox" data-k="fab"${s.fab?' checked':''}>显示屏幕上的悬浮按钮</label>
      ${L('主题色', `<input type="color" data-k="accent" value="${s.accent}">`)}
    </div>
    <div class="nm-cfg-f"><button class="nm-b" data-cfgclose>关闭</button><button class="nm-b" data-cfggen>保存并生成</button></div>
  </div>`;
}

function wireCfg(scope, mon) {
  scope.querySelectorAll('[data-k]').forEach(el => {
    el.addEventListener('change', () => {
      const st = S(); const k = el.getAttribute('data-k');
      st[k] = (el.type === 'checkbox') ? el.checked : el.value;
      saveS();
      if (k === 'accent' && mon) mon.setAccent(st.accent);
      if (k === 'fab') updateFab();
    });
  });
  scope.querySelectorAll('[data-cfgclose]').forEach(b => b.addEventListener('click', () => scope.querySelector('.nm-cfg').classList.add('hide')));
  const gen = scope.querySelector('[data-cfggen]');
  if (gen) gen.addEventListener('click', () => { scope.querySelector('.nm-cfg').classList.add('hide'); if (mon) { mon.applyView(); mon.run(true); } });
}

/* ---------------- 监控窗实例 ---------------- */
class Monitor {
  constructor(root, mesId) { this.r = root; this.id = mesId; this.busy = false; }
  q(s) { return this.r.querySelector(s); }
  log(m, c) { const e = this.q('.nm-status'); if (e) { e.textContent = m; e.style.color = c || 'var(--acc)'; } }
  setAccent(c) { this.r.style.setProperty('--acc', c); this.r.style.setProperty('--acc2', c); }
  applyView() { const s = S(); this.setAccent(s.accent); const rd = this.q('.nm-read'); if (rd) rd.classList.toggle('hide', !s.showhr); }
  progress(p) { const b = this.q('.nm-bar i'); if (b) b.style.width = p + '%'; }
  showLoad(t) { this.q('.nm-load').classList.remove('hide'); this.q('.nm-img').classList.remove('show'); if (t) this.q('.nm-lt').textContent = t; this.progress(8); }
  tick() { const d = new Date(), p = n => ('0' + n).slice(-2); const t = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); const c = this.q('.nm-clock'), st = this.q('.nm-stamp'); if (c) c.textContent = t; if (st) st.textContent = t + ' · 34.5°N'; }

  render(data) {
    if (!data) return;
    if (data.img) { const im = this.q('.nm-img'); im.src = data.img; im.classList.add('show'); this.q('.nm-load').classList.add('hide'); }
    const j = data.j || {};
    if (j.subject) this.q('.nm-subj').textContent = 'SUBJECT: ' + j.subject;
    if (j.mood) this.q('.nm-mood').textContent = j.mood;
    if (j.target) this.q('.nm-target').textContent = j.target;
    this.q('.nm-model').textContent = (S().model || 'NAI').toUpperCase().replace('NAI-DIFFUSION', 'NAI');
    let hr = j.heart_rate; if (hr == null || hr === '') hr = '--'; this.q('.nm-hr').textContent = hr;
    let th = parseInt(j.threat); if (isNaN(th)) th = 0;
    this.q('.nm-tbar i').style.width = Math.max(0, Math.min(100, th)) + '%';
    this.q('.nm-threatn').textContent = (isNaN(parseInt(j.threat)) ? '--' : th) + '%';
    if (j.status) this.log('// ' + j.status);
  }

  getFloor() {
    const c = getCtx(); if (!c) return { text: '', hist: '' };
    const s = S(); const chat = c.chat || [];
    if (this.id == null || this.id < 0 || !chat[this.id]) return { text: '', hist: '' };
    const cur = stripTags(chat[this.id].mes);
    let hist = '';
    if (s.hist > 0) { const from = Math.max(0, this.id - s.hist); const arr = []; for (let i = from; i < this.id; i++) if (chat[i]) arr.push(stripTags(chat[i].mes)); hist = arr.join('\n---\n'); }
    return { text: cur, hist };
  }
  cacheGet() { const c = getCtx(); if (!c || !c.chat) return null; const m = c.chat[this.id]; return (m && m.extra && m.extra.nai_mon) || null; }
  cacheSet(data) { const c = getCtx(); if (!c || !c.chat) return; const m = c.chat[this.id]; if (!m) return; m.extra = m.extra || {}; m.extra.nai_mon = { img: data.img, j: data.j }; try { c.saveChat && c.saveChat(); } catch (e) {} }

  async genPrompt(floor) {
    const s = S(), c = getCtx();
    const sys = s.inst || DEF_INST;
    const usr = '【本轮正文】\n' + floor.text + (floor.hist ? ('\n\n【历史片段】\n' + floor.hist) : '') + '\n\n只输出上面要求的 JSON。';
    if (s.api === 'custom') {
      if (!s.aurl) throw new Error('副API地址没填');
      const url = s.aurl.replace(/\/+$/, '') + '/chat/completions';
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.akey }, body: JSON.stringify({ model: s.amodel, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], temperature: parseFloat(s.temp) || 0.7, stream: false }) });
      if (!r.ok) throw new Error('副API ' + r.status + '：' + (await r.text()).slice(0, 120));
      const d = await r.json();
      return d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : JSON.stringify(d);
    } else {
      if (!c.generateQuietPrompt) throw new Error('找不到 generateQuietPrompt');
      return await c.generateQuietPrompt(sys + '\n\n' + usr, false, true);
    }
  }
  makePrompt(j) { const s = S(); const body = clean(j && j.prompt || 'a person, indoor, surveillance camera view, dim light'); const pos = clean(s.pos); return (pos ? pos + ', ' : '') + body; }
  makeNeg(j) { const s = S(); const extra = clean(j && j.negative || ''); const neg = clean(s.neg); return neg + (extra ? ', ' + extra : ''); }

  async naiRelay(prompt, neg) {
    const s = S(), c = getCtx(); const wh = sizeWH();
    const headers = (c.getRequestHeaders ? c.getRequestHeaders() : { 'Content-Type': 'application/json' });
    const body = { prompt, model: s.model, negative_prompt: neg, width: wh.w, height: wh.h, scale: parseFloat(s.scale) || 5, seed: seedVal(), sampler: s.sampler, scheduler: s.sched, steps: parseInt(s.steps) || 28, sm: !!s.sm, sm_dyn: !!s.smdyn, decrisper: !!s.decr, variety_boost: !!s.variety, upscale_ratio: 0 };
    const r = await fetch('/api/novelai/generate-image', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('酒馆中转 ' + r.status + '：' + (await r.text()).slice(0, 140));
    let b64 = (await r.text()).replace(/^"|"$/g, '').trim();
    return 'data:image/png;base64,' + b64;
  }
  loadFflate() { return new Promise((res, rej) => { if (window.fflate) return res(window.fflate); const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/fflate/0.8.2/umd/index.js'; sc.onload = () => res(window.fflate); sc.onerror = () => rej(new Error('fflate加载失败(需联网)')); document.head.appendChild(sc); }); }
  async naiDirect(prompt, neg) {
    const s = S(); const wh = sizeWH(), sd = seedVal();
    const params = { params_version: 4, width: wh.w, height: wh.h, scale: parseFloat(s.scale) || 5, sampler: s.sampler, steps: parseInt(s.steps) || 28, seed: sd, n_samples: 1, ucPreset: 3, qualityToggle: false, sm: !!s.sm, sm_dyn: !!s.smdyn, dynamic_thresholding: !!s.decr, controlnet_strength: 1, legacy: false, add_original_image: false, cfg_rescale: 0, noise_schedule: s.sched, legacy_v3_extend: false, uncond_scale: 1, negative_prompt: neg, prompt, extra_noise_seed: sd, v4_prompt: { use_coords: false, use_order: true, caption: { base_caption: prompt, char_captions: [] } }, v4_negative_prompt: { use_coords: false, use_order: false, caption: { base_caption: neg, char_captions: [] } } };
    const payload = { input: prompt, model: s.model, action: 'generate', parameters: params };
    const url = (s.proxy || '') + 'https://image.novelai.net/ai/generate-image';
    const r = await fetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + s.key, 'Content-Type': 'application/json', 'Accept': 'application/x-zip-compressed' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error('NAI ' + r.status + '：' + (await r.text()).slice(0, 140));
    const buf = await r.arrayBuffer(); const ff = await this.loadFflate();
    const files = ff.unzipSync(new Uint8Array(buf)); const name = Object.keys(files).find(n => /\.png$/i.test(n)) || Object.keys(files)[0];
    return URL.createObjectURL(new Blob([files[name]], { type: 'image/png' }));
  }

  async run(force) {
    if (this.busy) return; const s = S();
    if (this.id == null || this.id < 0) { this.log('⚠ 还没有可分析的AI楼层', 'var(--rec)'); return; }
    const floor = this.getFloor();
    if (!floor.text) { this.log('⚠ 读不到正文', 'var(--rec)'); return; }
    if (!force) { const cc = this.cacheGet(); if (cc) { this.render(cc); this.log('// 已用缓存画面', 'var(--mut)'); return; } }
    this.busy = true; this.showLoad('ANALYZING FEED…'); this.log('// 分析正文中…'); this.progress(20);
    try {
      const raw = await this.genPrompt(floor);
      const j = parseJSON(typeof raw === 'string' ? raw : (raw && raw.content)) || {};
      this.render({ j });
      this.progress(45); this.showLoad('RENDERING IMAGE…'); this.log('// 拼提示词 → NovelAI 出图…');
      const p = this.makePrompt(j), n = this.makeNeg(j);
      const img = s.route === 'direct' ? await this.naiDirect(p, n) : await this.naiRelay(p, n);
      this.progress(100);
      const data = { img, j }; this.cacheSet(data); this.render(data);
      this.log('// ' + (j.status || 'feed captured'));
    } catch (e) { this.q('.nm-load').classList.add('hide'); this.log('✕ ' + (e && e.message || e), 'var(--rec)'); }
    this.busy = false;
  }

  wireCommon() {
    this.applyView();
    this.q('.nm-node').textContent = 'NODE 10.7.' + (Math.floor(Math.random() * 90) + 10) + '.' + (Math.floor(Math.random() * 90) + 10) + ' · TRACE:OFF';
    this.tick(); this._iv = setInterval(() => this.tick(), 1000);
    this.q('.nm-gen').addEventListener('click', () => this.run(true));
    this.q('.nm-re').addEventListener('click', () => { const c = getCtx(); const m = c.chat && c.chat[this.id]; if (m && m.extra) delete m.extra.nai_mon; this.run(true); });
  }
}

/* ---------------- 悬浮按钮 + 浮窗（常驻，单实例） ---------------- */
let FLOAT = null, FLOATMON = null;
function buildFloat() {
  if (document.getElementById('nm-float')) return;
  injectStyle();
  // 按钮
  const fab = document.createElement('div'); fab.id = 'nm-fab'; fab.innerHTML = '📡<span class="dot"></span>';
  document.body.appendChild(fab);
  // 浮窗
  const float = document.createElement('div'); float.id = 'nm-float';
  const root = document.createElement('div'); root.className = 'nm-root';
  root.innerHTML = CORE + cfgHTML();
  float.appendChild(root); document.body.appendChild(float);
  FLOAT = float;
  const mon = new Monitor(root, latestAiId());
  FLOATMON = mon;
  mon.wireCommon();
  wireCfg(root, mon);
  mon.q('.nm-gear').addEventListener('click', () => root.querySelector('.nm-cfg').classList.remove('hide'));
  const minBtn = mon.q('[data-min]'); if (minBtn) minBtn.addEventListener('click', () => toggleFloat(false));
  // 悬浮按钮：点击开关 + 拖动
  makeDraggable(fab, fab, () => toggleFloat());
  // 浮窗顶栏拖动
  makeDraggable(float, mon.q('.nm-handle'));
  // 启动显示缓存
  const cc = mon.cacheGet(); if (cc) mon.render(cc); else mon.log('// 待机 · 点 ▶ 生成 / 或发一条回复');
  updateFab();
}
function toggleFloat(show) {
  if (!FLOAT) return;
  const willShow = (show === undefined) ? !FLOAT.classList.contains('show') : show;
  FLOAT.classList.toggle('show', willShow);
  if (willShow && FLOATMON) { FLOATMON.id = latestAiId(); const cc = FLOATMON.cacheGet(); if (cc) FLOATMON.render(cc); }
}
function updateFab() { const fab = document.getElementById('nm-fab'); if (fab) fab.style.display = (S().fab ? 'flex' : 'none'); }
function openFloatSettings() { toggleFloat(true); if (FLOAT) { const cfg = FLOAT.querySelector('.nm-cfg'); if (cfg) cfg.classList.remove('hide'); } }

/* 通用拖动（触摸/鼠标）；无移动则视为点击 */
function makeDraggable(moveEl, handle, onClick) {
  let sx, sy, ox, oy, moved, dragging = false;
  const start = (x, y) => { dragging = true; moved = false; sx = x; sy = y; const r = moveEl.getBoundingClientRect(); ox = r.left; oy = r.top; };
  const move = (x, y) => {
    if (!dragging) return; const dx = x - sx, dy = y - sy;
    if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    moveEl.style.left = Math.max(0, Math.min(window.innerWidth - 40, ox + dx)) + 'px';
    moveEl.style.top = Math.max(0, Math.min(window.innerHeight - 40, oy + dy)) + 'px';
    moveEl.style.right = 'auto'; moveEl.style.bottom = 'auto';
  };
  const end = () => { if (dragging && !moved && onClick) onClick(); dragging = false; };
  handle.addEventListener('touchstart', e => { const t = e.touches[0]; start(t.clientX, t.clientY); }, { passive: true });
  handle.addEventListener('touchmove', e => { const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
  handle.addEventListener('touchend', end);
  handle.addEventListener('mousedown', e => { start(e.clientX, e.clientY); const mm = ev => move(ev.clientX, ev.clientY); const mu = () => { end(); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); }; document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu); });
}

/* ---------------- 每条AI回复内嵌 ---------------- */
function injectInline(mesId) {
  const c = getCtx(); if (!c) return; const s = S();
  if (!s.enabled || !s.inline) return;
  if (mesId == null) return;
  const chat = c.chat || []; const msg = chat[mesId]; if (!msg || msg.is_user) return;
  if (s.markerOnly && !/[<＜]监控窗[>＞]/.test(msg.mes || '')) return;
  const mesEl = document.querySelector('.mes[mesid="' + mesId + '"]'); if (!mesEl) return;
  const textEl = mesEl.querySelector('.mes_text'); if (!textEl) return;
  if (textEl.querySelector('.nm-root')) return;
  const root = document.createElement('div'); root.className = 'nm-root nm-inline'; root.innerHTML = CORE;
  textEl.appendChild(root);
  const mon = new Monitor(root, mesId);
  mon.wireCommon();
  mon.q('.nm-gear').addEventListener('click', () => openFloatSettings());
  const minb = mon.q('[data-min]'); if (minb) minb.style.display = 'none';
  const cc = mon.cacheGet();
  const isLatest = mesId === latestAiId();
  if (cc) { mon.render(cc); mon.log('// 已用缓存画面', 'var(--mut)'); }
  else if (s.trig === 'auto' && isLatest) setTimeout(() => mon.run(false), 300);
  else { mon.q('.nm-lt').textContent = '点 ▶ 生成'; mon.log('// 点 ▶ 生成'); }
}

/* ---------------- 启动 ---------------- */
// —— 模块一加载就先把悬浮按钮建出来（不依赖酒馆上下文，纯探针）——
尝试 { 注入样式(); 构建浮动(); }
捕获 (e) { 控制台.错误('[NAIMon UI]', e); }

函数 启动() {
  常量 c = 获取上下文();
  如果 (!c) { setTimeout(boot, 600); 返回; }               // 等待上下文以挂载事件
  // 上下文就绪：刷新浮窗对准的楼层 + 显示缓存
  尝试 { 如果 (FLOATMON) { FLOATMON.id = latestAiId(); 常量 cc = FLOATMON.缓存获取(); 如果 (cc) FLOATMON.渲染(cc); } } 捕获 (e) {}
  // 事件系统：新旧名字都兼容（eventTypes / event_types）
  try {
    const ET = c.eventTypes || c.event_types;
    if (c.eventSource && ET) {
      如果 (ET.CHARACTER_MESSAGE_RENDERED)ceventSource为真，id => {尝试注入内联数字; FLOATMON = 最新AI ID}catcheconsoleerror'[NAIMon]'';
      如果 (ET.MESSAGE_RECEIVED) c.eventSource.为(ET.MESSAGE_RECEIVED, () => { 如果 (FLOATMON) FLOATMON.id = latestAiId(); });
      如果 (ET.CHAT_CHANGED)当ceventSource为真时，则使用setTimeout{documentquerySelectorAll'.mes[mesid]'遍历每个元素并执行injectInline数字getAttribute'mesid'; FLOATMONid = latestAiId}500;
    } 否则 {
      控制台.警告('[NAIMon] 事件系统不可用，改用轮询兜底');
      setInterval(() => { try { document.querySelectorAll('.mes[mesid]').forEach(el => injectInline(Number(el.getAttribute('mesid')))); if (FLOATMON) FLOATMON.id = latestAiId(); } catch (e) {} }, 2500);
    }
  } catch (e) { console.error('[NAIMon events]', e); }
  console.log('[NAIMon] 黑客监控窗 v2.1 已加载');
  如果 (window.toastr && window.toastr.成功) window.toastr.成功('黑客监控窗已就绪，右下角有  按钮', '监控窗');
}
启动();
