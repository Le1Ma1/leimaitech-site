// db.js
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_KEY || '';

if (!/^https:\/\/.+\.supabase\.co$/.test(url)) {
  throw new Error('[Supabase] SUPABASE_URL 無效或未設定');
}
if (!key) {
  throw new Error('[Supabase] SUPABASE_KEY 未設定');
}

// 判斷金鑰型別：新制 vs 舊制
const isSecret = key.startsWith('sb_secret_');                // 新制 Server 金鑰
const isPublishable = key.startsWith('sbp_') || key.startsWith('sb_publishable_'); // 新制 Browser 金鑰
const looksJwt = key.split('.').length >= 3;                  // 舊制 service_role / anon

if (isPublishable) {
  throw new Error('[Supabase] 你提供的是 Publishable key，請改用 Secret key (sb_secret_...)');
}

// 舊制若能解出角色，提供提醒
if (looksJwt && !isSecret) {
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString('utf8'));
    const role = payload?.role || payload?.user_role || 'unknown';
    if (role !== 'service_role') {
      console.warn(`[Supabase] 警告：目前 JWT 角色為 "${role}"；建議在後端改用 Secret/Service-Role 金鑰`);
    }
  } catch { /* 忽略解析失敗 */ }
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = supabase;
