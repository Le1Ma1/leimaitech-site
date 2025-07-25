// 用於 Next js 動態載入的粒子背景腳本
// 這段程式碼僅在瀏覽器環境執行
if (typeof window !== 'undefined') {
  const canvas = document.createElement('canvas');
  canvas.id = 'particle-canvas';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let stars = [];
  const numStars = 200;
  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    stars = [];
    for (let i = 0; i < numStars; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 1.5 + 0.5,
        speed: Math.random() * 0.5 + 0.2,
      });
    }
  }
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const star of stars) {
      ctx.fillStyle = 'rgba(139, 92, 246, 0.8)';
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      ctx.fill();
      star.y += star.speed;
      if (star.y > canvas.height) {
        star.y = 0;
        star.x = Math.random() * canvas.width;
      }
    }
    requestAnimationFrame(animate);
  }
  resize();
  window.addEventListener('resize', resize);
  animate();
}