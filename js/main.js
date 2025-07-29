// Main script for the LeiMai Tech homepage.
// This file initialises the particle background and handles smooth scrolling.

document.addEventListener('DOMContentLoaded', () => {
  // Configure particles.js for a galaxy‑like background
  if (window.particlesJS) {
    // Adjust particle density, size and colours to improve contrast and visibility
    particlesJS('particles-js', {
      particles: {
        number: {
          value: 120,
          density: {
            enable: true,
            value_area: 800
          }
        },
        color: {
          value: ['#6b6bff', '#00d4ff', '#a87fff']
        },
        shape: {
          type: 'circle'
        },
        opacity: {
          value: 0.8,
          random: true
        },
        size: {
          value: 3.5,
          random: true
        },
        line_linked: {
          enable: true,
          distance: 110,
          color: '#5a5aff',
          opacity: 0.4,
          width: 1
        },
        move: {
          enable: true,
          speed: 0.4,
          direction: 'none',
          random: false,
          straight: false,
          out_mode: 'out'
        }
      },
      interactivity: {
        detect_on: 'canvas',
        events: {
          onhover: {
            enable: true,
            mode: 'repulse'
          },
          onclick: {
            enable: false
          },
          resize: true
        },
        modes: {
          repulse: {
            distance: 100,
            duration: 0.4
          }
        }
      },
      retina_detect: true
    });
  }

  // Smooth scroll to services section when CTA button clicked
  const btn = document.getElementById('scrollBtn');
  const services = document.getElementById('services');
  if (btn && services) {
    btn.addEventListener('click', () => {
      services.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // IntersectionObserver to reveal elements on scroll
  const revealElements = document.querySelectorAll('.reveal, .timeline-item');
  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  revealElements.forEach(el => {
    observer.observe(el);
  });

  // Parallax effect on hero content based on mouse movement
  const hero = document.querySelector('header');
  const heroContent = document.querySelector('.hero-content');
  if (hero && heroContent) {
    hero.addEventListener('mousemove', (e) => {
      const rect = hero.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      heroContent.style.transform = `translate(${x * 20}px, ${y * 20}px)`;
    });
    hero.addEventListener('mouseleave', () => {
      heroContent.style.transform = '';
    });
  }

  // Back to top button behaviour
  const backToTop = document.getElementById('backToTop');
  const toggleBackToTop = () => {
    if (!backToTop) return;
    if (window.scrollY > window.innerHeight) {
      backToTop.classList.add('visible');
    } else {
      backToTop.classList.remove('visible');
    }
  };
  window.addEventListener('scroll', toggleBackToTop);
  if (backToTop) {
    backToTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
});
// Roadmap 進度點擊切換 (循環: 完成→開發中→計畫中)
document.querySelectorAll('.timeline-item').forEach((item) => {
  item.addEventListener('click', function(e) {
    let status = this.classList;
    if(status.contains('completed')) {
      status.remove('completed');
      status.add('developing');
    } else if(status.contains('developing')) {
      status.remove('developing');
      status.add('planning');
    } else if(status.contains('planning')) {
      status.remove('planning');
      status.add('completed');
    }
    // 強制重觸動畫
    let h3 = this.querySelector('h3');
    if(h3) {
      h3.classList.remove('animate-tick');
      void h3.offsetWidth; // 觸發reflow
      if(status.contains('completed')) h3.classList.add('animate-tick');
    }
  });
  // 鍵盤 Enter/Space 支援 (a11y)
  item.addEventListener('keydown', function(e) {
    if(e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.click();
    }
  });
});
