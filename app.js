require('dotenv').config();
const supabase = require('./db');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const qs = require('qs');

const app = express();
const PORT = process.env.PORT || 3000;

// 允許主站跨域
app.use(cors({
  origin: [
    'https://leimaitech.com',
    'https://www.leimaitech.com'
  ]
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const path = require('path');
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.send('API is working!');
});

// 前端訂閱頁
app.get('/subscribe', (req, res) => {
  res.sendFile(path.join(__dirname, 'subscribe.html'));
});

// **純註冊 API**
app.post('/api/register', async (req, res) => {
  try {
    const { userId, displayName, email, phone } = req.body;
    // 查有沒有這個用戶
    const { data: user, error } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .single();

    if (user) return res.json({ message: '已註冊' });

    const now = new Date();

    // 只插入基本資料
    const { data, error: insertError } = await supabase
      .from('users')
      .insert([{
        id: userId,
        display_name: displayName,
        email,
        phone,
        created_at: now.toISOString(),
        trial_status: 'registered'   // 可自訂初始狀態
      }])
      .select();

    if (insertError) throw insertError;
    res.json({ message: '註冊成功' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error', detail: e.message });
  }
});

// **純訂閱，不帶推薦碼**
app.post('/api/subscribe', async (req, res) => {
  try {
    const { userId, displayName, email, plan, period } = req.body;

    // 檢查用戶存在
    const { data: selfUser, error: selfErr } = await supabase
      .from('users').select('*').eq('id', userId).single();
    if (!selfUser) return res.status(400).json({ error: '用戶不存在' });

    // 產生訂單號
    const order_no = `LMAI${Date.now()}${Math.floor(Math.random()*1000)}`;
    await supabase.from('orders').insert([{
      order_no,
      user_id: userId,
      period,
      status: 'pending',
      created_at: new Date().toISOString()
    }]);

    res.json({ message: '訂單已建立', order_no });
  } catch (err) {
    console.error('subscribe API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 付款、金流、webhook流程都**保留原有設計**，只移除推薦獎勵
app.get('/pay', async (req, res) => {
  try {
    const { order_no } = req.query;
    if (!order_no) return res.status(400).send('缺少訂單編號');

    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('order_no', order_no)
      .single();
    if (!order) return res.status(404).send('查無訂單');

    let Amt = 199;
    let ItemDesc = "LeiMai Pro 進階訂閱（月繳）";
    if (order.period === 'year') {
      Amt = 1999;
      ItemDesc = "LeiMai Pro 進階訂閱（年繳）";
    }

    const Email = "test@example.com";
    const TimeStamp = `${Math.floor(Date.now() / 1000)}`;

    const tradeInfoObj = {
      MerchantID: process.env.MERCHANT_ID,
      RespondType: 'JSON',
      TimeStamp,
      Version: '2.0',
      MerchantOrderNo: order_no,
      Amt,
      ItemDesc,
      Email,
      NotifyURL: 'https://leimaitech-site.onrender.com/api/webhook',
      ReturnURL: 'https://leimaitech.com/payment-result.html?order_no=' + order_no,
    };

    function aesEncrypt(data, key, iv) {
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let enc = cipher.update(qs.stringify(data), 'utf8', 'hex');
      enc += cipher.final('hex');
      return enc;
    }
    function shaEncrypt(tradeInfo, key, iv) {
      const str = `HashKey=${key}&${tradeInfo}&HashIV=${iv}`;
      return crypto.createHash('sha256').update(str).digest('hex').toUpperCase();
    }

    const key = process.env.HASH_KEY;
    const iv = process.env.HASH_IV;

    const tradeInfoEnc = aesEncrypt(tradeInfoObj, key, iv);
    const tradeSha = shaEncrypt(tradeInfoEnc, key, iv);

    res.send(`
      <form id="payForm" method="POST" action="https://ccore.newebpay.com/MPG/mpg_gateway">
        <input type="hidden" name="MerchantID" value="${process.env.MERCHANT_ID}">
        <input type="hidden" name="TradeInfo" value="${tradeInfoEnc}">
        <input type="hidden" name="TradeSha" value="${tradeSha}">
        <input type="hidden" name="Version" value="2.0">
      </form>
      <script>document.getElementById('payForm').submit();</script>
    `);
  } catch (err) {
    console.error('pay error:', err);
    res.status(500).send('Server error');
  }
});

app.get('/api/order-status', async (req, res) => {
  const { order_no } = req.query;
  if (!order_no) return res.status(400).json({ status: 'missing_order_no' });

  const { data: order, error } = await supabase
    .from('orders')
    .select('*')
    .eq('order_no', order_no)
    .single();

  if (!order) return res.status(404).json({ status: 'not_found' });
  res.json({ status: order.status });
});

// webhook 不再處理推薦獎勵
app.post('/api/webhook', async (req, res) => {
  try {
    const { TradeInfo, TradeSha } = req.body;
    const key = process.env.HASH_KEY;
    const iv = process.env.HASH_IV;
    const sha256 = (str, key, iv) => {
      const toHash = `HashKey=${key}&${str}&HashIV=${iv}`;
      return crypto.createHash('sha256').update(toHash).digest('hex').toUpperCase();
    };
    if (sha256(TradeInfo, key, iv) !== TradeSha) {
      return res.status(400).send('驗證失敗');
    }
    function decryptTradeInfo(tradeInfo, key, iv) {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      decipher.setAutoPadding(true);
      let decoded = decipher.update(tradeInfo, 'hex', 'utf8');
      decoded += decipher.final('utf8');
      return qs.parse(decoded);
    }
    const result = decryptTradeInfo(TradeInfo, key, iv);

    // 1. 查訂單
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('order_no', result.MerchantOrderNo)
      .single();

    if (!order) return res.status(400).send('查無訂單');

    // 2. 訂單狀態設為 paid
    await supabase
      .from('orders')
      .update({ status: 'paid' })
      .eq('order_no', result.MerchantOrderNo);

    // 3. 會員開通
    await supabase
      .from('users')
      .update({ trial_status: 'paid' })
      .eq('id', order.user_id);

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
