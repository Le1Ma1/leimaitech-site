// Main script for the LeiMai Tech homepage.
// This file initialises the particle background and handles smooth scrolling.

document.addEventListener('DOMContentLoaded', () => {
  // Configure particles.js for a galaxy‑like background
  if (window.particlesJS) {
    particlesJS('particles-js', {
      particles: {
        number: {
          value: 80,
          density: {
            enable: true,
            value_area: 800
          }
        },
        color: {
          value: ['#5a5aff', '#00c2ff', '#7f5cff']
        },
        shape: {
          type: 'circle'
        },
        opacity: {
          value: 0.6,
          random: true
        },
        size: {
          value: 3,
          random: true
        },
        line_linked: {
          enable: true,
          distance: 120,
          color: '#5a5aff',
          opacity: 0.25,
          width: 1
        },
        move: {
          enable: true,
          speed: 0.3,
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
});