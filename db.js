// db.js
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;

function decodeRole(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
    return payload?.role || payload?.user_role || null;
  } catch { return null; }
}

if (!url || !/^https:\/\/.+\.supabase\.co$/.test(url)) {
  throw new Error('[Supabase] SUPABASE_URL 無效或未設定');
}
if (!key || key.split('.').length < 3) {
  throw new Error('[Supabase] SUPABASE_KEY 缺失或格式錯誤（非 JWT）');
}
const role = decodeRole(key);
if (role && role !== 'service_role') {
  // 仍允許啟動，但給出清楚警告，避免用 anon key 造成 insert/select 失敗
  console.warn(`[Supabase] 警告：目前使用的金鑰角色為 "${role}"，建議改用 service_role`);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false }
});

module.exports = supabase;
