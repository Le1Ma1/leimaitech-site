const express = require('express');
const path = require('path');
const app = express();
// 靜態資源
app.use(express.static(path.join(__dirname, '.')));
// (預留未來API，現在不用寫)
// app.use('/api', require('./api'));
// catch-all (for SPA routes)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.listen(process.env.PORT || 3000, () => {
  console.log('Server running...');
});
