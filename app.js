require('dotenv').config();
const supabase = require('./db');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const qs = require('qs');

// 建立 Express app
const app = express();
const PORT = process.env.PORT || 3000;

// 跨域設定（允許你的主站呼叫這個 API）
app.use(cors({
  origin: [
    'https://leimaitech.com',
    'https://www.leimaitech.com'
  ]
}));

// 處理 JSON 和表單資料
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 測試 API 路由
app.get('/', (req, res) => {
  res.send('API is working!');
});

const path = require('path');
app.use(express.static(path.join(__dirname))); // 讓靜態檔案可直接存取

app.get('/subscribe', (req, res) => {
  res.sendFile(path.join(__dirname, 'subscribe.html'));
});

// 新增一個註冊 API（POST /api/register）
app.post('/api/register', async (req, res) => {
  try {
    const { userId, displayName, email, phone } = req.body;
    // 先檢查有沒有
    const { data: user, error } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .single();

    if (user) {
      return res.json({ message: '已註冊', invite_code: user.invite_code });
    }

    // 產生隨機推薦碼
    const invite_code = Math.random().toString(36).slice(-8).toUpperCase();
    const now = new Date();
    const trial_end = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

    const { data, error: insertError } = await supabase
      .from('users')
      .insert([{
        id: userId,
        display_name: displayName,
        email,
        phone,
        created_at: now.toISOString(),
        free_trial_start: now.toISOString(),
        free_trial_expiry: trial_end.toISOString(),
        invite_code: invite_code,
        invite_expiry: trial_end.toISOString(),
      }])
      .select();

    if (insertError) throw insertError;

    res.json({ message: '註冊成功', invite_code });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error', detail: e.message });
  }
});

app.post('/api/subscribe', async (req, res) => {
  try {
    const { userId, displayName, email, plan, invite_code } = req.body;

    // 先檢查用戶存在
    const { data: selfUser, error: selfErr } = await supabase
      .from('users').select('*').eq('id', userId).single();
    if (!selfUser) return res.status(400).json({ error: '用戶不存在' });

    // 檢查推薦碼資格
    if (invite_code) {
      const { data: inviter } = await supabase
        .from('users')
        .select('*')
        .eq('invite_code', invite_code)
        .single();

      if (!inviter) return res.status(400).json({ error: '推薦碼不存在' });

      const now = new Date();
      if (now > new Date(inviter.invite_expiry))
        return res.status(400).json({ error: '推薦碼已過期' });
      if (inviter.invite_count >= 2)
        return res.status(400).json({ error: '該推薦人已達邀請上限' });
      if (inviter.id === userId)
        return res.status(400).json({ error: '不能填自己的推薦碼' });
      if (selfUser.referred_by)
        return res.status(400).json({ error: '你已經填過推薦碼' });

      // 預先寫入 invites（狀態 pending）
      await supabase.from('invites').insert([{
        inviter_id: inviter.id,
        invitee_id: userId,
        invite_code: invite_code,
        status: 'pending',
        created_at: now.toISOString(),
      }]);
      // 更新自己的 referred_by
      await supabase.from('users').update({ referred_by: invite_code }).eq('id', userId);
    }

    // 產生訂單號（商家訂單編號）
    const order_no = `LMAI${Date.now()}${Math.floor(Math.random()*1000)}`;
    await supabase.from('orders').insert([{
      order_no,
      user_id: userId,
      invite_code: invite_code || null,
      status: 'pending',
      created_at: new Date().toISOString()
    }]);

    // 回傳訂單號給前端（讓前端帶到藍新付款）
    res.json({ message: '訂單已建立', order_no });

  } catch (err) {
    console.error('subscribe API error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/invite-status', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: '需帶 userId' });

  const { data: user, error } = await supabase.from('users').select('*').eq('id', userId).single();
  if (!user) return res.status(404).json({ error: '查無用戶' });

  res.json({
    invite_code: user.invite_code,
    invite_count: user.invite_count,
    free_trial_expiry: user.free_trial_expiry,
    invite_expiry: user.invite_expiry,
    trial_extended: user.trial_extended,
    trial_status: user.trial_status,
    referred_by: user.referred_by
  });
});

app.get('/pay', async (req, res) => {
  const { order_no } = req.query;
  // 1. 查你的 orders 表，取得金額等資料
  // 2. 組合藍新金流參數
  // 3. 計算 TradeInfo、TradeSha（用 hashKey/hashIV 加密）
  // 4. 自動產生 form 跳轉

  // 示意（需根據你訂單內容動態產生）
  const Amt = 199; // 假設月繳
  const ItemDesc = "LeiMai Pro 進階訂閱";
  const MerchantOrderNo = order_no;
  // ... 其他必要參數與加密
  res.send(`
    <form id="payForm" method="POST" action="https://ccore.newebpay.com/MPG/mpg_gateway">
      <input type="hidden" name="MerchantID" value="你的MerchantID">
      <input type="hidden" name="TradeInfo" value="加密後字串">
      <input type="hidden" name="TradeSha" value="SHA256後字串">
      <input type="hidden" name="Version" value="2.0">
      <!-- ... -->
    </form>
    <script>document.getElementById('payForm').submit();</script>
  `);
});

// app.js 內部

app.get('/api/order-status', async (req, res) => {
  const { order_no } = req.query;
  if (!order_no) return res.status(400).json({ status: 'missing_order_no' });
  // 查詢訂單
  const { data: order, error } = await supabase
    .from('orders')
    .select('*')
    .eq('order_no', order_no)
    .single();

  if (!order) return res.status(404).json({ status: 'not_found' });
  res.json({ status: order.status });  // status: paid / pending / failed / not_found
});

// 金流 webhook
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
    //const result = {
    //  MerchantOrderNo: req.body.MerchantOrderNo || "測試訂單編號"
    //};

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

    // 4. 推薦獎勵
    if (order.invite_code) {
      const { data: inviter } = await supabase
        .from('users')
        .select('*')
        .eq('invite_code', order.invite_code)
        .single();
      if (inviter && inviter.id !== order.user_id) {
        let newCount = inviter.invite_count + 1;
        let updates = { invite_count: newCount };
        const now = new Date();
        if (newCount === 2 && now <= new Date(inviter.invite_expiry)) {
          const newExpiry = new Date(inviter.free_trial_expiry);
          newExpiry.setDate(newExpiry.getDate() + 60);
          updates.trial_extended = true;
          updates.free_trial_expiry = newExpiry.toISOString();
          updates.trial_status = 'extended';
        }
        await supabase.from('users').update(updates).eq('id', inviter.id);

        // 寫 invites
        await supabase.from('invites').insert([{
          inviter_id: inviter.id,
          invitee_id: order.user_id,
          invite_code: order.invite_code,
          status: 'success',
          created_at: now.toISOString(),
          confirmed_at: now.toISOString(),
        }]);
      }
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Server Error');
  }
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
