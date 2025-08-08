// app.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const qs = require('qs');
const crypto = require('crypto');
const path = require('path');

const supabase = require('./db'); // 你現有的 Supabase client

const app = express();
const PORT = process.env.PORT || 3000;

// ================== 共用中介層與靜態 ==================
app.use((req, res, next) => {
  console.log(`[INCOMING] ${req.method} ${req.originalUrl} - ${new Date().toISOString()}`);
  next();
});
app.use(cors({
  origin: ['https://leimaitech.com', 'https://www.leimaitech.com']
}));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.send('API is working!'));
app.get('/subscribe', (req, res) => res.sendFile(path.join(__dirname, 'subscribe.html')));

// ================== 小工具 ==================
function addDays(d, days) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + days);
  return x;
}
function yyyymmdd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function aesEncrypt(obj, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  let enc = cipher.update(qs.stringify(obj), 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
}
function aesDecryptHexToText(hex, key, iv) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  decipher.setAutoPadding(true);
  let out = decipher.update(hex, 'hex', 'utf8');
  out += decipher.final('utf8');
  return out;
}

// ================== 註冊（沿用） ==================
app.post('/api/register', async (req, res) => {
  console.log(`[API] /api/register`, req.body);
  try {
    const { userId, displayName, email, phone } = req.body;
    const { data: user } = await supabase.from('users').select('id').eq('id', userId).single();
    if (user) {
      console.log(`[REGISTER] 用戶已註冊: ${userId}`);
      return res.json({ message: '已註冊' });
    }
    const now = new Date();
    const { error: insertError } = await supabase.from('users').insert([{
      id: userId,
      display_name: displayName || null,
      email: email || null,
      phone: phone || null,
      created_at: now.toISOString(),
    }]);
    if (insertError) throw insertError;
    console.log(`[REGISTER] 註冊成功: ${userId}`);
    res.json({ message: '註冊成功' });
  } catch (e) {
    console.error(`[REGISTER] Error:`, e);
    res.status(500).json({ error: 'Server error', detail: e.message });
  }
});

// ================== 建單（新增試用與首扣日邏輯） ==================
app.post('/api/subscribe', async (req, res) => {
  console.log(`[API] /api/subscribe`, req.body);
  try {
    const { userId, displayName, email, plan = 'pro', period = 'month' } = req.body;

    // 檢查用戶存在
    const { data: selfUser } = await supabase.from('users').select('*').eq('id', userId).single();
    if (!selfUser) {
      console.warn(`[SUBSCRIBE] 用戶不存在: ${userId}`);
      return res.status(400).json({ error: '用戶不存在' });
    }

    // 方案金額
    const Amt = period === 'year' ? 1999 : 199;
    const currency = 'TWD';

    // 試用與首扣
    const now = new Date();
    const trialDays = 10;
    const trialStart = now;
    const trialEnd = addDays(now, trialDays);      // 第 11 天首扣
    const firstChargeDate = trialEnd;              // 首扣日 = trialEnd

    // 定期定額參數（由「首扣日」決定週期點）
    let PeriodType = 'M';
    let PeriodPoint = String(firstChargeDate.getDate()).padStart(2, '0'); // 月繳用日
    if (period === 'year') {
      PeriodType = 'Y';
      const mm = String(firstChargeDate.getMonth() + 1).padStart(2, '0');
      const dd = String(firstChargeDate.getDate()).padStart(2, '0');
      PeriodPoint = `${mm}${dd}`; // 年繳用 MMDD
    }

    // 建立訂單
    const order_no = `LMAI${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const { error: orderErr } = await supabase.from('orders').insert([{
      order_no,
      user_id: userId,
      period,
      status: 'pending',
      amount: Amt,
      currency,
      email: email || null,
      trial_days: trialDays,
      trial_start: trialStart.toISOString(),
      trial_end: trialEnd.toISOString(),
      first_charge_date: yyyymmdd(firstChargeDate),
      period_type: PeriodType,
      period_point: PeriodPoint,
      created_at: now.toISOString(),
    }]);
    if (orderErr) {
      console.error('[SUBSCRIBE] 建單失敗:', orderErr);
      return res.status(500).json({ error: '建單失敗', detail: orderErr.message });
    }

    console.log(`[SUBSCRIBE] 訂單建立: ${order_no} 用戶: ${userId} 方案: ${plan} 周期: ${period} 首扣:${yyyymmdd(firstChargeDate)} PType:${PeriodType} PPoint:${PeriodPoint}`);
    res.json({ message: '訂單已建立', order_no });
  } catch (err) {
    console.error('[SUBSCRIBE] API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================== 產生定期定額表單（NDNP 建立委託） ==================
app.get('/pay', async (req, res) => {
  try {
    const { order_no } = req.query;
    if (!order_no) return res.status(400).send('缺少訂單編號');

    // 查訂單
    const { data: order } = await supabase.from('orders').select('*').eq('order_no', order_no).single();
    if (!order) return res.status(404).send('查無訂單');

    const Amt = order.period === 'year' ? 1999 : 199;
    const Desc = order.period === 'year' ? 'LeiMai Pro 進階訂閱（年繳）' : 'LeiMai Pro 進階訂閱（月繳）';

    // 用訂單已計算好的週期設定
    let PeriodType = order.period_type || (order.period === 'year' ? 'Y' : 'M');
    let PeriodPoint = order.period_point; // 月繳: 'DD'；年繳: 'MMDD'
    const TimeStamp = `${Math.floor(Date.now() / 1000)}`;
    const Email = order.email || 'test@example.com';

    // 關鍵：PeriodStartType=1（首扣延後到 PeriodPoint；刷卡僅建立委託）
    const periodInfoObj = {
      RespondType: 'JSON',
      TimeStamp,
      Version: '1.5',
      LangType: 'zh-Tw',
      MerOrderNo: order_no,
      ProdDesc: Desc,
      PeriodAmt: Amt,
      PeriodType: PeriodType,     // 'M' 或 'Y'
      PeriodPoint: PeriodPoint,   // 'DD' 或 'MMDD'
      PeriodStartType: '1',       // **不立即首扣**：第 11 天首扣（我們已把 PeriodPoint 設成 trialEnd）
      PeriodTimes: 999,           // 長期續扣（視你的商業邏輯可調整）
      PayerEmail: Email,
      EmailModify: 1,
      NotifyURL: process.env.PERIOD_NOTIFY_URL, // 例：https://<你的網域>/api/period-webhook
      ReturnURL: `https://leimaitech.com/payment-result.html?order_no=${order_no}`
    };

    const key = process.env.HASH_KEY;
    const iv = process.env.HASH_IV;
    const postDataEnc = aesEncrypt(periodInfoObj, key, iv);

    console.log('[PERIOD PAY] Params:', periodInfoObj);
    console.log('[PERIOD PAY] PostData_:', postDataEnc);

    // 測試環境：ccore
    res.send(`
      <form id="periodPayForm" method="POST" action="https://ccore.newebpay.com/MPG/period">
        <input type="hidden" name="MerchantID_" value="${process.env.MERCHANT_ID}">
        <input type="hidden" name="PostData_" value="${postDataEnc}">
      </form>
      <script>document.getElementById('periodPayForm').submit();</script>
    `);
  } catch (err) {
    console.error('[PERIOD PAY] error:', err);
    res.status(500).send('Server error');
  }
});

// ================== 訂單狀態查詢（結果頁輪詢用） ==================
app.get('/api/order-status', async (req, res) => {
  const { order_no } = req.query;
  console.log(`[API] /api/order-status`, req.query);
  if (!order_no) return res.status(400).json({ status: 'missing_order_no' });

  const { data: order } = await supabase.from('orders').select('*').eq('order_no', order_no).single();
  if (!order) {
    console.warn(`[ORDER-STATUS] 查無訂單: ${order_no}`);
    return res.status(404).json({ status: 'not_found' });
  }
  console.log(`[ORDER-STATUS] ${order_no} 狀態: ${order.status}`);
  res.json({ status: order.status, order });
});

// ================== 定期定額 Webhook（NDNP） ==================
app.post('/api/period-webhook', bodyParser.urlencoded({ extended: false, limit: '1mb' }), async (req, res) => {
  try {
    // 大部分情況 payload 是 x-www-form-urlencoded
    const payload = typeof req.body === 'string' ? qs.parse(req.body) : (req.body || {});
    console.log('[PERIOD WEBHOOK] headers:', req.headers);
    console.log('[PERIOD WEBHOOK] raw payload:', payload);

    const enc =
      payload.Period ||
      payload.period ||
      payload.PostData_ ||
      payload.TradeInfo || '';

    if (!enc) {
      console.warn('[PERIOD WEBHOOK] 缺少加密欄位(Period/PostData_/TradeInfo)');
      return res.status(400).send('Missing payload');
    }

    const key = process.env.HASH_KEY;
    const iv = process.env.HASH_IV;

    // 解密 → 嘗試 JSON，再退而求其次 querystring
    const decodedText = aesDecryptHexToText(enc, key, iv);
    let result;
    try { result = JSON.parse(decodedText); }
    catch { result = qs.parse(decodedText); }

    console.log('[PERIOD WEBHOOK] decoded:', result);

    // 記錄 webhook_event 以便稽核
    await supabase.from('webhook_events').insert([{
      event_source: 'newebpay_period',
      signature: payload?.TradeSha || null,
      payload: result,
      processed: false
    }]);

    // 取得訂單號（容錯不同格式）
    const merOrderNo =
      result?.MerOrderNo ||
      result?.MerchantOrderNo ||
      result?.Result?.MerOrderNo ||
      result?.Result?.MerchantOrderNo;

    if (!merOrderNo) {
      console.warn('[PERIOD WEBHOOK] 找不到 MerOrderNo / MerchantOrderNo');
      return res.status(400).send('Missing order no');
    }

    // 成功判斷（常見：Status === 'SUCCESS' 或 Result.RespondCode === '00'）
    const isSuccess =
      result?.Status === 'SUCCESS' ||
      result?.Result?.RespondCode === '00';

    // 可能回傳的週期識別碼（供存檔）
    const periodNo =
      result?.PeriodNo ||
      result?.Result?.PeriodNo ||
      result?.Result?.PeriodInfo ||
      null;

    // 更新訂單
    if (isSuccess) {
      const { error: updErr } = await supabase
        .from('orders')
        .update({
          status: 'paid',                 // 代表「建立委託成功」（首扣會在首扣日）
          paid_at: new Date().toISOString(),
          newebpay_period_no: periodNo
        })
        .eq('order_no', merOrderNo);
      if (updErr) {
        console.error('[PERIOD WEBHOOK] 更新訂單失敗:', updErr);
        return res.status(500).send('DB update error');
      }

      // 建立或更新 subscriptions（trialing → active 會在首扣日轉態；這裡先記 trial）
      const { data: order } = await supabase.from('orders').select('*').eq('order_no', merOrderNo).single();
      const subPayload = {
        user_id: order.user_id,
        plan: 'pro',
        period: order.period,
        status: 'trialing',
        trial_start: order.trial_start,
        trial_end: order.trial_end,
        current_period_start: order.trial_start,
        current_period_end: order.trial_end,
        period_type: order.period_type,
        period_point: order.period_point,
        period_times: 999,
        gateway: 'newebpay',
        gateway_period_no: periodNo
      };
      // 如果已存在同用戶未取消的訂閱就更新，否則新建
      const { data: existing } = await supabase
        .from('subscriptions')
        .select('id,status')
        .eq('user_id', order.user_id)
        .eq('plan', 'pro')
        .in('status', ['trialing', 'active', 'past_due'])
        .maybeSingle();

      if (existing?.id) {
        await supabase.from('subscriptions').update(subPayload).eq('id', existing.id);
      } else {
        await supabase.from('subscriptions').insert([subPayload]);
      }

      // 交易紀錄
      await supabase.from('transactions').insert([{
        order_no: merOrderNo,
        user_id: order.user_id,
        subscription_id: existing?.id || null,
        type: 'initial',
        status: 'succeeded',
        amount: order.amount,
        currency: order.currency,
        gateway_trade_no: periodNo || null,
        paid_at: new Date().toISOString(),
        raw_payload: result
      }]);

      // 把 webhook_event 標記 processed
      await supabase
        .from('webhook_events')
        .update({ processed: true })
        .eq('event_source', 'newebpay_period')
        .eq('signature', payload?.TradeSha || null);

      console.log(`[PERIOD WEBHOOK] 委託成功，訂單 ${merOrderNo} 已標記 paid；trial 至 ${order.trial_end}`);
    } else {
      await supabase.from('orders').update({ status: 'failed' }).eq('order_no', merOrderNo);
      await supabase.from('transactions').insert([{
        order_no: merOrderNo,
        type: 'initial',
        status: 'failed',
        raw_payload: result
      }]);
      console.log(`[PERIOD WEBHOOK] 委託失敗，訂單 ${merOrderNo} 標記 failed`);
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('[PERIOD WEBHOOK] error:', err);
    return res.status(500).send('Server Error');
  }
});

// ================== 啟動 ==================
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
