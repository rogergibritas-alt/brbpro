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

  // Contador animado (prova imediata)
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
    }
    requestAnimationFrame(passo);
  }
  if ('IntersectionObserver' in window && counters.length) {
    var io2 = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { animar(e.target); io2.unobserve(e.target); }
      });
    }, { threshold: 0.5 });
    counters.forEach(function (el) { io2.observe(el); });
  } else {
    counters.forEach(function (el) { el.textContent = (el.getAttribute('data-prefix') || '') + parseInt(el.getAttribute('data-count'), 10).toLocaleString('pt-BR'); });
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
