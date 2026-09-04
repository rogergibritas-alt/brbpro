/* ============================================================
   Art na Régua — Interações do site público
   ============================================================ */

(function () {
  'use strict';

  /* ---------- AUTO-ATUALIZAÇÃO ---------- */
  // Verifica a versão do servidor a cada 45s; se mudou (novo deploy),
  // recarrega a página sozinho — fim do Ctrl+F5.
  (function autoUpdate() {
    function checar() {
      fetch('/api/versao', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var nova = j.versao || '';
          var guardada = localStorage.getItem('art_versao');
          if (!guardada) {
            localStorage.setItem('art_versao', nova);
          } else if (guardada !== nova) {
            localStorage.setItem('art_versao', nova);
            location.reload();
          }
        })
        .catch(function () { /* sem conexão: ignora */ });
    }
    setInterval(checar, 45000);
  })();

  /* ---------- INTRO EM VÍDEO ---------- */
  var intro = document.getElementById('intro');
  var introVideo = document.getElementById('introVideo');
  if (intro && introVideo) {
    var introFechada = false;
    var introTimer;
    function fecharIntro() {
      if (introFechada) return;
      introFechada = true;
      clearTimeout(introTimer);
      intro.classList.add('intro-fim');
      setTimeout(function () { intro.remove(); }, 650);
    }
    // Ao terminar o vídeo, revela o site direto (sem logo intermediária)
    introVideo.addEventListener('ended', fecharIntro);
    // Se o vídeo falhar ao carregar, não trava a entrada
    introVideo.addEventListener('error', fecharIntro);
    // Segurança: fecha sozinho após 12s se algo travar
    introTimer = setTimeout(fecharIntro, 12000);
    // Botão "Pular"
    var skip = document.getElementById('introSkip');
    if (skip) skip.addEventListener('click', fecharIntro);
    // Botão de som (autoplay com som é bloqueado pelo navegador)
    var som = document.getElementById('introSound');
    if (som) som.addEventListener('click', function () {
      if (introVideo.muted) {
        introVideo.muted = false;
        introVideo.play().catch(function () {});
        som.textContent = '🔊';
      } else {
        introVideo.muted = true;
        som.textContent = '🔇';
      }
    });
    // TENTA tocar COM SOM primeiro; se o navegador bloquear, cai pro mudo
    introVideo.muted = false;
    introVideo.play().then(function () {
      if (som) som.textContent = '🔊';
    }).catch(function () {
      introVideo.muted = true;
      introVideo.play().catch(function () {});
      if (som) som.textContent = '🔇';
    });
  }

  /* ---------- RÁDIO FUNK ---------- */
  var radioBtn = document.getElementById('radioBtn');
  var radioMute = document.getElementById('radioMute');
  var radioAudio = document.getElementById('radioAudio');
  var radioIcon = document.getElementById('radioIcon');
  if (radioBtn && radioAudio) {
    // Streams HTTPS de funk brasileiro mais "leve" (funk mainstream/melody/antigo,
    // sem funk proibidão). A 1ª é a principal; as demais são backup automático.
    var STREAMS = [
      'https://stream.zeno.fm/vqsnxuwkkzzuv',   // Rádio Trend - Funk (hits comerciais)
      'https://stream.zeno.fm/pq6w4fupdfhvv',   // Super Mix - funk da antiga (melódico)
      'https://stream.zeno.fm/z59qwbh8cchvv'    // Funk Atualizado
    ];
    var streamAtual = 0;
    var tocando = false;

    function carregarStream() {
      radioAudio.src = STREAMS[streamAtual];
      radioAudio.load();
      if (tocando) radioAudio.play().catch(function () {});
    }

    radioAudio.addEventListener('error', function () {
      // tenta o próximo stream
      streamAtual = (streamAtual + 1) % STREAMS.length;
      carregarStream();
    });

    function alternarRadio() {
      if (tocando) {
        radioAudio.pause();
        tocando = false;
        radioBtn.classList.remove('tocando');
        radioIcon.textContent = '🎵';
        radioMute.hidden = true;
        localStorage.setItem('radio_on', '0');
      } else {
        tocando = true;
        carregarStream();
        radioBtn.classList.add('tocando');
        radioIcon.textContent = '🎶';
        radioMute.hidden = false;
        localStorage.setItem('radio_on', '1');
      }
    }

    radioBtn.addEventListener('click', alternarRadio);

    if (radioMute) {
      radioMute.addEventListener('click', function () {
        if (radioAudio.muted) {
          radioAudio.muted = false;
          radioMute.textContent = '🔊';
        } else {
          radioAudio.muted = true;
          radioMute.textContent = '🔇';
        }
      });
    }
  }

  /* ---------- RELÓGIO (dia e hora ao vivo) ---------- */
  var clockEl = document.getElementById('topbarClock');
  if (clockEl) {
    var diasSemana = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    var meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    function atualizarRelogio() {
      var d = new Date();
      var diaSemana = diasSemana[d.getDay()];
      var dia = d.getDate();
      var mes = meses[d.getMonth()];
      var ano = d.getFullYear();
      var h = String(d.getHours()).padStart(2, '0');
      var m = String(d.getMinutes()).padStart(2, '0');
      var s = String(d.getSeconds()).padStart(2, '0');
      clockEl.textContent = diaSemana + ', ' + dia + ' de ' + mes + ' de ' + ano + ' · ' + h + ':' + m + ':' + s;
    }
    atualizarRelogio();
    setInterval(atualizarRelogio, 1000);
  }

  /* ---------- CONFIG (multi-tenant, vem do window.BRB_TENANT injetado pelo servidor) ---------- */
  // Fallback para quando não há tenant (ex.: preview local da landing vazia)
  var T = (window.BRB_TENANT || {});
  var CONFIG = {
    WHATSAPP: (T.whatsapp || '5531997816616'),
    NOME: (T.nome || 'Barbearia'),
    MSG_AGENDAR: 'Olá! Vim pelo site da ' + (T.nome || 'barbearia') + ' e quero agendar um horário. ✂️',
    MSG_CONTATO: 'Olá! Vim pelo site da ' + (T.nome || 'barbearia') + ' e quero falar com vocês.',
  };

  // Aplica TODA a marca/identidade do cliente ao site (nome, dados, logo, texto, cores, vídeo)
  (function aplicarMarcaTenant() {
    if (!T.nome) return;
    // 1) Dados de contato/marca
    var map = { '#brandNome': (T.hero_titulo || T.nome), '#brandCidade': (T.cidade || ''), '#brandEndereco': (T.endereco || ''), '#brandInstagram': (T.instagram || ''), '#brandWhatsapp': (T.whatsapp || '') };
    Object.keys(map).forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el && map[sel] !== undefined && map[sel] !== '') el.textContent = map[sel];
    });
    // 2) Hero: título, subtítulo e kicker (slogan)
    var setText = function (sel, v) { var el = document.querySelector(sel); if (el && v) el.textContent = v; };
    setText('.hero-title', (T.hero_titulo || T.nome));
    setText('.hero-desc', (T.hero_sub || ''));
    if (T.slogan) setText('.hero-kicker', T.slogan);
    else if (T.cidade) setText('.hero-kicker', 'Barbearia em ' + T.cidade);
    // 3) Sobre (parágrafo "Na ...")
    if (T.sobre_texto) { var s = document.querySelector('#sobreTexto, .section .cont p, section p'); }
    // 4) Logo do cliente (por URL)
    if (T.logo_url) {
      document.querySelectorAll('.logo-mark').forEach(function (img) { img.src = T.logo_url; });
      document.querySelectorAll('img[src="/images/logo-icon.png"], img[src="/images/logo-completa.png"]').forEach(function (img) { img.src = T.logo_url; });
      document.querySelectorAll('img[src^="/m/"], img[src="' + T.logo_url + '"]').forEach(function (img) { img.src = T.logo_url; });
    }
    // 5) Vídeo/imagem de fundo do hero (por URL)
    if (T.video_url) {
      var hero = document.querySelector('.hero-bg');
      if (hero) { hero.innerHTML = '<video class="hero-media" autoplay muted loop playsinline src="' + T.video_url + '"></video>'; }
    } else if (T.hero_url) {
      var hero2 = document.querySelector('.hero-bg');
      if (hero2) hero2.style.backgroundImage = 'url("' + T.hero_url + '")';
    }
    // 6) Cores do tema (CSS vars usadas no layout)
    if (T.cor_primaria) {
      document.documentElement.style.setProperty('--dourado', T.cor_primaria);
    }
    // 7) Remove/limpa qualquer texto residual "Art na Régua" que não tenha sido substituído
    try {
      document.querySelectorAll('body *').forEach(function (n) {
        if (n.children.length === 0 && /\bArt na R.égua\b|\bna régua\b/i.test(n.textContent || '')) {
          n.textContent = n.textContent.replace(/\bArt na R.égua\b/gi, T.nome || 'Barbearia');
        }
      });
    } catch (e) {}
  })();

  // Se o servidor injetou o tenant, busca a config dinâmica (horário/social) para preencher o que faltar
  if (!T.endereco) {
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && j.barbearia) {
        var b = j.barbearia;
        var set = function (sel, v) { var el = document.querySelector(sel); if (el && v) el.textContent = v; };
        set('#brandNome', b.nome || ''); set('#brandCidade', b.cidade || '');
        set('#brandEndereco', b.endereco || ''); set('#brandInstagram', b.instagram || '');
        set('#brandWhatsapp', b.whatsapp || '');
        document.querySelectorAll('[data-whatsapp]').forEach(function (el) {
          el.setAttribute('href', 'https://wa.me/' + (b.whatsapp || CONFIG.WHATSAPP) + '?text=' + encodeURIComponent(CONFIG.MSG_AGENDAR));
        });
      }
    }).catch(function () {});
  }

  function waLink(msg) {
    return 'https://wa.me/' + CONFIG.WHATSAPP + '?text=' + encodeURIComponent(msg);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- WhatsApp em todos os botões data-whatsapp ---------- */
  document.querySelectorAll('[data-whatsapp]').forEach(function (el) {
    el.setAttribute('href', waLink(CONFIG.MSG_AGENDAR));
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  });

  /* ---------- Menu mobile ---------- */
  var burger = document.getElementById('navBurger');
  var navLinks = document.getElementById('navLinks');
  if (burger && navLinks) {
    burger.addEventListener('click', function () {
      var aberto = navLinks.classList.toggle('aberto');
      burger.setAttribute('aria-expanded', aberto ? 'true' : 'false');
    });
    navLinks.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        navLinks.classList.remove('aberto');
        burger.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* ---------- Reveal on scroll ---------- */
  var reveals = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('visivel'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('visivel'); });
  }

  /* ---------- Título "smoky" ---------- */
  var title = document.getElementById('smokyTitle');
  if (title) {
    var text = title.textContent;
    title.textContent = '';
    text.split('').forEach(function (ch) {
      if (ch === ' ') { title.appendChild(document.createTextNode(' ')); return; }
      var s = document.createElement('span');
      s.className = 'smoke';
      s.textContent = ch;
      title.appendChild(s);
    });
  }

  /* ---------- Typewriter ---------- */
  var typed = document.querySelector('.typed');
  if (typed) {
    var words = [];
    try { words = JSON.parse(typed.getAttribute('data-words') || '[]'); } catch (e) { words = []; }
    var wi = 0, ci = 0, apagando = false;
    (function tick() {
      var palavra = words[wi] || '';
      if (!apagando) {
        ci++; typed.textContent = palavra.slice(0, ci);
        if (ci === palavra.length) { apagando = true; setTimeout(tick, 1600); return; }
      } else {
        ci--; typed.textContent = palavra.slice(0, ci);
        if (ci === 0) { apagando = false; wi = (wi + 1) % words.length; }
      }
      setTimeout(tick, apagando ? 45 : 90);
    })();
  }

  /* ---------- Toast ---------- */
  var toastEl = document.getElementById('toast');
  var toastTimer;
  function mostrarToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 3200);
  }

  function setMsg(el, texto, tipo) {
    if (!el) return;
    el.textContent = texto;
    el.className = 'form-msg ' + (tipo || '');
  }

  /* ---------- AGENDAMENTO (horários inteligentes) ---------- */
  var formAgendar = document.getElementById('formAgendar');
  var campoData = document.getElementById('campoData');
  var selServico = document.getElementById('selServico');
  var campoHorario = document.getElementById('campoHorario');
  var slotBotoes = document.getElementById('slotBotoes');
  var slotLabel = document.getElementById('slotLabel');
  var hintServico = document.getElementById('hintServico');
  var hintSlots = document.getElementById('hintSlots');

  function slotsNecessarios() {
    var opt = selServico && selServico.selectedOptions[0];
    return opt ? parseInt(opt.getAttribute('data-slots') || '1', 10) : 1;
  }

  async function carregarSlots() {
    if (!slotBotoes) return;
    var data = campoData.value;
    slotBotoes.innerHTML = '';
    campoHorario.value = '';
    hintSlots.textContent = '';
    if (!data) { slotLabel.textContent = 'Primeiro escolha a data acima.'; return; }

    slotLabel.textContent = 'Carregando horários...';
    try {
      var r = await fetch('/api/slots?data=' + encodeURIComponent(data));
      var j = await r.json();
      if (j.fechado) {
        slotLabel.textContent = 'Fechado neste dia (atendemos de terça a sábado).';
        return;
      }
      var n = slotsNecessarios();
      var slots = j.slots || [];
      slotLabel.textContent = n > 1 ? 'Escolha o 1º horário — este serviço ocupa 2 horários seguidos:' : 'Escolha um horário disponível:';

      slotBotoes.innerHTML = slots.map(function (s, i) {
        var livre = s.disponivel;
        if (n > 1) livre = s.disponivel && slots[i + 1] && slots[i + 1].disponivel;
        var cls = 'slot-btn' + (livre ? '' : ' indisponivel');
        var attr = livre ? ' data-horario="' + s.horario + '"' : ' disabled';
        return '<button type="button" class="' + cls + '"' + attr + '>' + s.horario + '</button>';
      }).join('');

      slotBotoes.querySelectorAll('.slot-btn:not(.indisponivel)').forEach(function (btn) {
        btn.addEventListener('click', function () {
          slotBotoes.querySelectorAll('.slot-btn').forEach(function (b) { b.classList.remove('sel'); });
          btn.classList.add('sel');
          campoHorario.value = btn.getAttribute('data-horario');
          if (n > 1) {
            var idx = slots.findIndex(function (s) { return s.horario === campoHorario.value; });
            var prox = slots[idx + 1];
            hintSlots.textContent = '✔ ' + campoHorario.value + ' + ' + (prox ? prox.horario : '') + ' reservados (2 horários seguidos).';
          } else {
            hintSlots.textContent = '✔ ' + campoHorario.value + ' selecionado.';
          }
        });
      });
    } catch (e) {
      slotLabel.textContent = 'Erro ao carregar horários. Tente novamente.';
    }
  }

  if (campoData) {
    // min = hoje
    var hoje = new Date();
    campoData.min = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0') + '-' + String(hoje.getDate()).padStart(2, '0');
    campoData.addEventListener('change', carregarSlots);
  }
  if (selServico) {
    selServico.addEventListener('change', function () {
      var n = slotsNecessarios();
      hintServico.textContent = n > 1 ? 'Este serviço ocupa 2 horários seguidos.' : '';
      carregarSlots();
    });
  }

  // Carregar serviços dinamicamente do banco (com preços e slots)
  async function carregarServicosPublico() {
    if (!selServico) return;
    try {
      var r = await fetch('/api/servicos');
      var j = await r.json();
      var svcs = (j.servicos || []).filter(function (s) { return s.online; });
      if (!svcs.length) return;
      var html = '<option value="">Selecione...</option>' + svcs.map(function (s) {
        var preco = s.preco != null ? ' — R$ ' + s.preco.toFixed(2).replace('.', ',') : '';
        return '<option data-slots="' + s.slots + '" value="' + s.nome.replace(/"/g, '&quot;') + '">' + s.nome + preco + '</option>';
      }).join('');
      selServico.innerHTML = html;
    } catch (e) { /* mantém opções padrão */ }
  }
  carregarServicosPublico();

  if (formAgendar) {
    formAgendar.addEventListener('submit', async function (e) {
      e.preventDefault();
      var msgEl = document.getElementById('formMsg');
      var d = new FormData(formAgendar);
      if (d.get('website')) return; // honeypot

      var dados = {
        nome: d.get('nome'), whatsapp: d.get('whatsapp'), servico: d.get('servico'),
        data: d.get('data'), horario: d.get('horario'), obs: d.get('obs') || '',
      };

      if (!dados.nome || dados.nome.trim().length < 2) { setMsg(msgEl, 'Informe seu nome.', 'erro'); return; }
      if (!/^\d{10,13}$/.test((dados.whatsapp || '').replace(/\D/g, ''))) { setMsg(msgEl, 'Informe um WhatsApp válido com DDD.', 'erro'); return; }
      if (!dados.servico) { setMsg(msgEl, 'Selecione um serviço.', 'erro'); return; }
      if (!dados.data) { setMsg(msgEl, 'Escolha uma data.', 'erro'); return; }
      if (!dados.horario) { setMsg(msgEl, 'Escolha um horário disponível.', 'erro'); return; }

      setMsg(msgEl, 'Reservando...', '');
      try {
        var r = await fetch('/api/agendar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dados),
        });
        var json = await r.json().catch(function () { return {}; });

        if (json.ok && json.recebido) {
          // formata a data para DD/MM/AAAA e monta a mensagem de confirmação
          var dataFmt = dados.data.split('-').reverse().join('/');
          var horariosTxt = (json.horarios || [dados.horario]).join(' e ');
          var msgTexto = 'Olá! Acabei de agendar pelo site da Art na Régua. 💈\n\n' +
            '👤 Nome: ' + dados.nome + '\n' +
            '💈 Serviço: ' + dados.servico + '\n' +
            '📅 Data: ' + dataFmt + '\n' +
            '⏰ Horário: ' + horariosTxt + '\n\n' +
            'Pode confirmar meu horário?';
          var linkW = waLink(msgTexto);
          msgEl.innerHTML =
            '<span style="color:#7fd98a;">✅ Agendado para ' + horariosTxt + '!</span>' +
            '<a class="btn btn-gold btn-block" style="margin-top:.7rem;" href="' + linkW + '" target="_blank" rel="noopener noreferrer">📲 Confirmar no WhatsApp</a>';
          mostrarToast('Horário reservado com sucesso! 💈');
          formAgendar.reset();
          hintServico.textContent = '';
          carregarSlots();
          return;
        }
        if (json.conflito) {
          setMsg(msgEl, '⚠️ ' + json.error, 'erro');
          carregarSlots(); // atualiza a grade
          return;
        }
        if (json.error) {
          setMsg(msgEl, json.error, 'erro');
          return;
        }
        // fallback: abre WhatsApp
        var msgW = waLink('Olá! Gostaria de agendar ' + dados.servico + ' no dia ' + dados.data + ' às ' + dados.horario + '. Meu nome é ' + dados.nome + '.');
        setMsg(msgEl, '📲 Abrindo WhatsApp para concluir...', '');
        window.open(msgW, '_blank');
      } catch (err) {
        setMsg(msgEl, '📲 Abrindo WhatsApp...', '');
        window.open(waLink(CONFIG.MSG_AGENDAR), '_blank');
      }
    });
  }

  /* ---------- Contato ---------- */
  var formContato = document.getElementById('formContato');
  if (formContato) {
    formContato.addEventListener('submit', async function (e) {
      e.preventDefault();
      var msgEl = document.getElementById('contatoMsg');
      var d = new FormData(formContato);
      if (d.get('website')) return;
      var dados = { nome: d.get('nome'), contato: d.get('contato'), mensagem: d.get('mensagem') };
      if (!dados.nome || dados.nome.trim().length < 2) { setMsg(msgEl, 'Informe seu nome.', 'erro'); return; }
      if (!dados.contato || dados.contato.trim().length < 5) { setMsg(msgEl, 'Informe telefone ou e-mail.', 'erro'); return; }
      if (!dados.mensagem || dados.mensagem.trim().length < 5) { setMsg(msgEl, 'Escreva sua mensagem.', 'erro'); return; }
      setMsg(msgEl, 'Enviando...', '');
      try {
        var r = await fetch('/api/contato', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados),
        });
        var json = await r.json();
        if (json.ok && json.recebido) { setMsg(msgEl, '✅ Mensagem enviada!', 'ok'); formContato.reset(); }
        else { setMsg(msgEl, '📲 Abrindo WhatsApp...', ''); window.open(waLink(CONFIG.MSG_CONTATO), '_blank'); }
      } catch (err) {
        window.open(waLink(CONFIG.MSG_CONTATO), '_blank');
      }
    });
  }

  /* ---------- FAQ (carregada do banco) ---------- */
  var faqLista = document.getElementById('faqLista');
  if (faqLista) {
    fetch('/api/faq')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var itens = j.faq || [];
        if (!itens.length) {
          faqLista.innerHTML = '<p class="categorias-carregando">Em breve, perguntas frequentes.</p>';
          return;
        }
        faqLista.innerHTML = itens.map(function (f) {
          return '<details class="faq-item"><summary>' + esc(f.pergunta) + '</summary><p>' + esc(f.resposta) + '</p></details>';
        }).join('');
      })
      .catch(function () {
        faqLista.innerHTML = '<p class="categorias-carregando">Não foi possível carregar as perguntas.</p>';
      });
  }

  /* ---------- GALERIA POR CATEGORIAS ---------- */
  var categoriasGrid = document.getElementById('categoriasGrid');
  var lightbox = document.getElementById('lightbox');
  var lightboxTitulo = document.getElementById('lightboxTitulo');
  var lightboxGrid = document.getElementById('lightboxGrid');
  var fotoCheia = document.getElementById('fotoCheia');
  var fotoCheiaImg = document.getElementById('fotoCheiaImg');

  async function carregarCategorias() {
    if (!categoriasGrid) return;
    try {
      var r = await fetch('/api/fotos/categorias');
      var j = await r.json();
      var cats = j.categorias || [];
      if (!cats.length) {
        categoriasGrid.innerHTML = '<p class="categorias-carregando">Em breve fotos dos nossos trabalhos. 📸</p>';
        return;
      }
      categoriasGrid.innerHTML = cats.map(function (c) {
        return '<div class="categoria-card" data-cat="' + esc(c.categoria) + '">' +
          '<img src="/api/foto/' + c.capa_id + '" alt="' + esc(c.categoria) + '" loading="lazy" />' +
          '<div class="cat-overlay"><span class="cat-nome">' + esc(c.categoria) + '</span>' +
          '<span class="cat-qtd">' + c.qtd + (Number(c.qtd) === 1 ? ' foto' : ' fotos') + '</span></div>' +
          '</div>';
      }).join('');
      categoriasGrid.querySelectorAll('.categoria-card').forEach(function (card) {
        card.addEventListener('click', function () { abrirCategoria(card.getAttribute('data-cat')); });
      });
    } catch (e) {
      categoriasGrid.innerHTML = '<p class="categorias-carregando">Não foi possível carregar a galeria.</p>';
    }
  }

  async function abrirCategoria(cat) {
    if (!lightbox) return;
    lightboxTitulo.textContent = cat;
    lightboxGrid.innerHTML = '<p class="lightbox-vazio">Carregando...</p>';
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    try {
      var r = await fetch('/api/fotos?categoria=' + encodeURIComponent(cat));
      var j = await r.json();
      var ids = j.fotos || [];
      if (!ids.length) {
        lightboxGrid.innerHTML = '<p class="lightbox-vazio">Nenhuma foto nesta categoria ainda.</p>';
        return;
      }
      lightboxGrid.innerHTML = ids.map(function (item) {
        if (item.tipo === 'video') {
          return '<div class="lightbox-video"><video src="/api/foto/' + item.id + '" controls playsinline preload="metadata"></video></div>';
        }
        return '<img src="/api/foto/' + item.id + '" alt="' + esc(cat) + '" loading="lazy" data-id="' + item.id + '" />';
      }).join('');
      lightboxGrid.querySelectorAll('img').forEach(function (img) {
        img.addEventListener('click', function () { ampliarFoto(img.src); });
      });
    } catch (e) {
      lightboxGrid.innerHTML = '<p class="lightbox-vazio">Erro ao carregar as fotos.</p>';
    }
  }

  function ampliarFoto(src) {
    if (!fotoCheia) return;
    fotoCheiaImg.src = src;
    fotoCheia.hidden = false;
  }
  function fecharFotoCheia() { if (fotoCheia) fotoCheia.hidden = true; }

  var lightboxFechar = document.getElementById('lightboxFechar');
  if (lightboxFechar) lightboxFechar.addEventListener('click', function () {
    lightbox.hidden = true;
    document.body.style.overflow = '';
  });
  var fotoCheiaFechar = document.getElementById('fotoCheiaFechar');
  if (fotoCheiaFechar) fotoCheiaFechar.addEventListener('click', fecharFotoCheia);
  if (fotoCheia) fotoCheia.addEventListener('click', function (e) { if (e.target === fotoCheia) fecharFotoCheia(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { fecharFotoCheia(); if (lightbox && !lightbox.hidden) { lightbox.hidden = true; document.body.style.overflow = ''; } }
  });

  carregarCategorias();

  /* ---------- Modal LGPD ---------- */
  var lgpdModal = document.getElementById('lgpdModal');
  var lgpdLink = document.getElementById('lgpd');
  function fecharLgpd() { if (lgpdModal) lgpdModal.hidden = true; }
  if (lgpdLink) lgpdLink.addEventListener('click', function (e) { e.preventDefault(); if (lgpdModal) lgpdModal.hidden = false; });
  var lgpdClose = document.getElementById('lgpdClose');
  var lgpdOk = document.getElementById('lgpdOk');
  if (lgpdClose) lgpdClose.addEventListener('click', fecharLgpd);
  if (lgpdOk) lgpdOk.addEventListener('click', fecharLgpd);
  if (lgpdModal) lgpdModal.addEventListener('click', function (e) { if (e.target === lgpdModal) fecharLgpd(); });
})();
// Cole este bloco no FINAL do seu js/main.js, antes do último "})();"
// HOTFIX BRB Pro — corrige textos sem precisar reescrever HTML agora
(function hotfixBRBPro(){
  function fixTexts(){
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const fixes = [
      { from: 'não serão permitidos atrasos', to: 'Tolerância de 10 min — após isso, reagendamos sem custo.' },
      { from: '(COMPLETAR com a informação real', to: 'Sim! Na R. Padre Rolim há vagas na rua em frente e nas transversais. Programe 5 min para estacionar.' },
      { from: 'Chegando 5 minutos antes já é o suficiente', to: 'Chegue 10 min antes. Tolerância de 10 min; após isso, reagendamos sem custo.' }
    ];
    // Varre textos e aplica
    let node;
    while(node = walker.nextNode()){
      for(const f of fixes){
        if(node.nodeValue.includes(f.from)){
          // Sobe para o elemento pai para permitir HTML
          const el = node.parentElement;
          if(el && el.textContent.includes(f.from)){
            if(f.from.includes('não serão permitidos')){
              el.innerHTML = '⏱️ Chegue com <b>10 min de antecedência</b>. Tolerância de <b>10 min</b> — após isso, reagendamos sem custo para não atrasar o próximo cliente. Avise no WhatsApp se precisar ajustar.';
            } else if(f.from.includes('COMPLETAR')){
              el.textContent = 'Sim! Na R. Padre Rolim há vagas na rua em frente e nas transversais. Chegando de carro, programe 5 min para estacionar — se estiver cheio, avise no WhatsApp que seguramos seu horário por 10 min.';
            } else if(f.from.includes('Chegando 5 minutos')){
              el.textContent = 'Chegue 10 min antes para preparar. Temos tolerância de 10 min; após isso, reagendamos sem custo para manter a pontualidade de todos. Se for atrasar, chama no WhatsApp que a gente remaneja.';
            }
          }
        }
      }
    }
    // Tooltip Nevou
    document.querySelectorAll('.servico').forEach(c=>{
      if(c.textContent.includes('Nevou')){
        c.setAttribute('title','Descoloração global — loiro platinado (Nevou)');
        if(!c.querySelector('.nevou-tip')){
          const tip = document.createElement('small');
          tip.className='nevou-tip';
          tip.style.cssText='display:block;font-size:11px;color:#9BA0AE;margin-top:4px';
          tip.textContent='Descoloração global — platinado';
          c.appendChild(tip);
        }
      }
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', fixTexts);
  else fixTexts();
  // Reaplica após 1s caso conteúdo seja injetado via JS
  setTimeout(fixTexts, 1000);
})();
