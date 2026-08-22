/* BRB Pro Landing — micro-interações (vanilla, sem dependências) */
(function () {
  // Reveal on scroll
  var els = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('vis'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    els.forEach(function (el) { io.observe(el); });
  } else {
    els.forEach(function (el) { el.classList.add('vis'); });
  }

  // Contador animado (prova imediata) — o HTML já traz o valor final ("+1.000");
  // a animação só roda se o elemento ENTRAR na viewport após o load (evita capturar "0" em snapshots)
  var counters = document.querySelectorAll('[data-count]');
  function animar(el) {
    var alvo = parseInt(el.getAttribute('data-count'), 10) || 0;
    var prefixo = el.getAttribute('data-prefix') || '';
    var t0 = null, dur = 1200;
    function passo(t) {
      if (!t0) t0 = t;
      var p = Math.min((t - t0) / dur, 1);
      var v = Math.floor(alvo * (1 - Math.pow(1 - p, 3)));
      el.textContent = prefixo + v.toLocaleString('pt-BR');
      if (p < 1) requestAnimationFrame(passo);
      else el.textContent = prefixo + alvo.toLocaleString('pt-BR');
    }
    requestAnimationFrame(passo);
  }
  if ('IntersectionObserver' in window && counters.length) {
    counters.forEach(function (el) {
      var r = el.getBoundingClientRect();
      // já visível no load? mantém o valor final estático (sem animação)
      if (r.top < window.innerHeight && r.bottom > 0) return;
      var io2 = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { animar(e.target); io2.disconnect(); }
        });
      }, { threshold: 0.4 });
      io2.observe(el);
    });
  }

  // CTA fixo no mobile após passar do hero
  var sticky = document.getElementById('stickyCta');
  var hero = document.querySelector('.hero');
  if (sticky && hero) {
    var tick = function () {
      var limiar = hero.getBoundingClientRect().bottom;
      sticky.classList.toggle('show', limiar < 0 && window.innerWidth < 901);
    };
    window.addEventListener('scroll', tick, { passive: true });
    window.addEventListener('resize', tick);
    tick();
  }
})();
