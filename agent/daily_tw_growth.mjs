#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const cheerio = await import('cheerio').then(m => m.default ?? m);
  const root = process.cwd();
  const SITE_URL = env('SITE_URL');
  const LINE = env('LINE_OA_ID');
  const GA = env('GA_MEASUREMENT_ID');
  const SB_DB = process.env.SUPABASE_DB_URL || '';
  const SB_URL = env('SUPABASE_URL');
  const SB_KEY = env('SUPABASE_ANON_KEY');
  await ensureIndex({ cheerio, root, SITE_URL, LINE, GA, SB_URL, SB_KEY });
  await ensurePayResult({ cheerio, root, GA });
  const kpi = SB_DB
    ? await kpis(SB_DB)
    : {
        sessions_tw: null,
        ctr_tw: null,
        cvr_tw: null,
        ctr_7d: null,
        cvr_7d: null,
        best_variant_7d: 'v1'
      };
  const decided = decideAB(kpi);
  await setAB({ cheerio, root, decided });
  await tg(report({ SITE_URL, LINE, kpi, decided }));
}

function env(k, f = '') {
  return (process.env[k] || '').trim() || f;
}

async function read(f) {
  try {
    return await fs.readFile(f, 'utf8');
  } catch {
    return '';
  }
}

async function ensureIndex({ cheerio, root, SITE_URL, LINE, GA, SB_URL, SB_KEY }) {
  const f = path.join(root, 'index.html');
  let html = await read(f);
  if (!html) return;
  const $ = cheerio.load(html, { decodeEntities: false });
  if (!$('html').attr('lang')) $('html').attr('lang', 'zh-Hant-TW');
  $('head').append(`\n            <link rel="canonical" href="${SITE_URL}/">\n            <meta property="og:locale" content="zh_TW">`);
  if (!$('script').filter((_, el) => ($(el).html() || '').includes('window.__AB_PREF')).length) {
    $('head').append(`<script>
              window.__SITE_TZ="Asia/Taipei";
              window.__LINE_OA_ID="${LINE}";
              window.__AB_PREF={"v1":0.5,"v2":0.5};
              window.__GA_MEASUREMENT_ID="${GA}";
              window.__SUPABASE_URL="${SB_URL}";
              window.__SUPABASE_ANON_KEY="${SB_KEY}";
              </script>`);
  }
  if (!$('script[src*="googletagmanager.com/gtag/js"]').length) {
    $('head').append(`<script async src="https://www.googletagmanager.com/gtag/js?id=${GA}"></script>
              <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};gtag('js',new Date());gtag('config','${GA}',{send_page_view:true});</script>`);
  }
  const h1 = $('body h1').first();
  if (h1.length && !h1.attr('data-agent')) {
    h1.attr('data-agent', 'headline');
    if (!(h1.html() || '').includes('AGENT:HEADLINE'))
      h1.html(`<!--AGENT:HEADLINE-->${h1.html()}<!--/AGENT:HEADLINE-->`);
  }
  const p = h1.nextAll('p').first();
  if (p.length && !p.attr('data-agent')) {
    p.attr('data-agent', 'subhead');
    if (!(p.html() || '').includes('AGENT:SUBHEAD'))
      p.html(`<!--AGENT:SUBHEAD-->${p.html()}<!--/AGENT:SUBHEAD-->`);
  }
  const cta = $('a[href*="line"], a:contains("LINE"), a:contains("加入")').first();
  if (cta.length) {
    if (!cta.attr('id')) cta.attr('id', 'btn-line');
    if (!cta.attr('data-variant')) cta.attr('data-variant', 'v1');
  }
  if (!$('script').filter((_, el) => ($(el).html() || '').includes('/*LEIMAI_TRACKING*/')).length) {
    $('body').append(`<script>
              /*LEIMAI_TRACKING*/
              (function(){
                var isMobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
                var LINE_M='line://ti/p/${LINE}', LINE_W='https://line.me/R/ti/p/${LINE}';
                var tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'', lang=(navigator.language||'').toLowerCase();
                var pref=window.__AB_PREF||{"v1":0.5,"v2":0.5};
                var sid=localStorage.getItem('sid')||(Date.now().toString(36)+Math.random().toString(36).slice(2,8)); localStorage.setItem('sid',sid);
                var key=new Date().toLocaleDateString('en-CA',{timeZone:(window.__SITE_TZ||'Asia/Taipei')});
                var exp=localStorage.getItem('ab_expire'), v=localStorage.getItem('ab_variant');
                if(!exp || exp!==key || !v){ var r=Math.random(),acc=0,pick='v1'; Object.keys(pref).forEach(k=>{acc+=+pref[k]||0; if(r<=acc && pick==='v1') pick=k;}); v=pick; localStorage.setItem('ab_variant',v); localStorage.setItem('ab_expire',key);} 
                var btn=document.getElementById('btn-line'); if(btn){ btn.href=isMobile?LINE_M:LINE_W; btn.setAttribute('data-variant',v); btn.addEventListener('click',function(){try{gtag('event','join_line_click',{method:isMobile?'mobile':'web',variant:v})}catch(e){} post({event_name:'join_line_click',method:isMobile?'mobile':'web',variant:v});});}
                var pool={ v1:{headline:'比特幣關鍵數據，一鍵推送到你的 LINE',subhead:'ETF 淨流入、巨鯨監控、六大持幣結構。台灣用戶 NT$199/月，可隨時取消。',cta:'加入 LINE 接收推播'},
                           v2:{headline:'每天 1 分鐘掌握 BTC 走勢｜LINE 即時通知',subhead:'追蹤巨鯨、ETF、庫存與礦工動態。199 元起，年繳更划算。',cta:'立即加入 LINE'}};
                var cfg=pool[v]||pool.v1; var H=document.querySelector('[data-agent="headline"]'); var P=document.querySelector('[data-agent="subhead"]');
                if(H) H.textContent=cfg.headline; if(P) P.textContent=cfg.subhead; if(btn) btn.textContent=cfg.cta;
                post({event_name:'page_view'});
                if(location.pathname.indexOf('payment-result')>=0){ try{gtag('event','payment_success',{value:1,currency:'TWD'})}catch(e){} post({event_name:'payment_success'}); }
                function post(payload){ try{ if(!window.__SUPABASE_URL||!window.__SUPABASE_ANON_KEY) return;
                  var body={ ts:new Date().toISOString(), session_id:sid, event_name:payload.event_name, page:location.pathname, variant:payload.variant||localStorage.getItem('ab_variant')||'v1', method:payload.method||null, lang:lang, tz:tz, country_guess:(tz==='Asia/Taipei'?'TW':null), referrer:document.referrer||null, meta:payload.meta||null };
                  fetch(window.__SUPABASE_URL+'/rest/v1/events',{method:'POST',headers:{'Content-Type':'application/json','apikey':window.__SUPABASE_ANON_KEY,'Authorization':'Bearer '+window.__SUPABASE_ANON_KEY,'Prefer':'return=representation'}, body:JSON.stringify(body)}).catch(()=>{});
                }catch(e){} }
              })();
              </script>`);
  }
  await fs.writeFile(f, $.html(), 'utf8');
  console.log('[ok] index.html');
}

async function ensurePayResult({ cheerio, root, GA }) {
  const f = path.join(root, 'payment-result.html');
  const html = await read(f);
  if (!html) return;
  const $ = cheerio.load(html, { decodeEntities: false });
  if (!$('script[src*="googletagmanager.com/gtag/js"]').length) {
    $('head').append(`<script async src="https://www.googletagmanager.com/gtag/js?id=${GA}"></script>
              <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)};gtag('js',new Date());gtag('config','${GA}',{send_page_view:true});</script>`);
  }
  if (!$('script').filter((_, el) => ($(el).html() || '').includes('payment_success')).length) {
    $('body').append(`<script>(function(){try{gtag('event','payment_success',{value:1,currency:'TWD'})}catch(e){} })();</script>`);
  }
  await fs.writeFile(f, $.html(), 'utf8');
  console.log('[ok] payment-result.html');
}

async function kpis(DB) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: DB, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async s => (await c.query(s)).rows?.[0]?.v ?? null;
  const out = {
    sessions_tw: await q(
      `select count(*)::int v from events where (country_guess='TW' or tz='Asia/Taipei' or lower(lang) like '%zh-tw%') and event_name='page_view' and ts::date=(now() at time zone 'Asia/Taipei')::date`
    ),
    ctr_tw: await q(
      `with b as (select sum(case when event_name='page_view' then 1 else 0 end)::numeric pv, sum(case when event_name='join_line_click' then 1 else 0 end)::numeric clk from events where (country_guess='TW' or tz='Asia/Taipei' or lower(lang) like '%zh-tw%') and ts::date=(now() at time zone 'Asia/Taipei')::date) select case when pv=0 then null else round(clk/pv,4) end v from b`
    ),
    cvr_tw: await q(
      `with b as (select sum(case when event_name='join_line_click' then 1 else 0 end)::numeric clk, sum(case when event_name='payment_success' then 1 else 0 end)::numeric pay from events where (country_guess='TW' or tz='Asia/Taipei' or lower(lang) like '%zh-tw%') and ts::date=(now() at time zone 'Asia/Taipei')::date) select case when clk=0 then null else round(pay/clk,4) end v from b`
    ),
    ctr_7d: await q(
      `with b as (select sum(case when event_name='page_view' then 1 else 0 end)::numeric pv, sum(case when event_name='join_line_click' then 1 else 0 end)::numeric clk from events where (country_guess='TW' or tz='Asia/Taipei' or lower(lang) like '%zh-tw%') and ts >= (now() at time zone 'Asia/Taipei')::date - interval '7 day') select case when pv=0 then null else round(clk/pv,4) end v from b`
    ),
    cvr_7d: await q(
      `with b as (select sum(case when event_name='join_line_click' then 1 else 0 end)::numeric clk, sum(case when event_name='payment_success' then 1 else 0 end)::numeric pay from events where (country_guess='TW' or tz='Asia/Taipei' or lower(lang) like '%zh-tw%') and ts >= (now() at time zone 'Asia/Taipei')::date - interval '7 day') select case when clk=0 then null else round(pay/clk,4) end v from b`
    ),
    best_variant_7d: await q(
      `with a as (select variant,sum(case when event_name='page_view' then 1 else 0 end)::numeric pv,sum(case when event_name='join_line_click' then 1 else 0 end)::numeric clk from events where (country_guess='TW' or tz='Asia/Taipei' or lower(lang) like '%zh-tw%') and ts >= (now() at time zone 'Asia/Taipei')::date - interval '7 day' group by 1) select coalesce((select variant from a where pv>0 order by (clk/pv) desc nulls last limit 1),'v1') v`
    )
  };
  await c.end();
  return out;
}

function decideAB(k) {
  const fall = k.ctr_tw == null || k.ctr_7d == null ? false : k.ctr_tw < k.ctr_7d * 0.85;
  return fall
    ? {
        ab: k.best_variant_7d === 'v2' ? { v1: 0.2, v2: 0.8 } : { v1: 0.8, v2: 0.2 },
        reason: 'ctr_drop_vs_7d'
      }
    : { ab: { v1: 0.5, v2: 0.5 }, reason: 'stable' };
}

async function setAB({ cheerio, root, decided }) {
  const f = path.join(root, 'index.html');
  let html = await read(f);
  if (!html) return;
  const $ = cheerio.load(html, { decodeEntities: false });
  const tag = $('script').filter((_, el) => ($(el).html() || '').includes('window.__AB_PREF'));
  if (tag.length) {
    const code = tag.html();
    tag.html(
      code.replace(/window.__AB_PREF\s*=\s*\{[^}]+\};/m, `window.__AB_PREF=${JSON.stringify(decided.ab)};`)
    );
    await fs.writeFile(f, $.html(), 'utf8');
    console.log('[ok] AB', decided.ab);
  }
}

function report({ SITE_URL, LINE, kpi, decided }) {
  const p = x => (x == null ? 'n/a' : (x * 100).toFixed(2) + '%');
  return `leimaitech.com 台灣日報\n站點：${SITE_URL}｜LINE OA：${LINE}\nTW 會話：${kpi.sessions_tw ?? 'n/a'}\nTW CTA CTR：${p(kpi.ctr_tw)}（7日均：${p(
    kpi.ctr_7d
  )}）\nTW 付款 CVR：${p(kpi.cvr_tw)}（7日均：${p(
    kpi.cvr_7d
  )}）\nAB 權重：${JSON.stringify(decided.ab)}（${decided.reason}）\n動作：已維護 head/OG/追蹤標籤，A/B 權重更新。`;
}

async function tg(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) {
    console.log('[warn] Telegram 未設定');
    return;
  }
  await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text })
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
