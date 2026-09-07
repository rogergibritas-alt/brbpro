(function () {
  'use strict';

  /* ---------- AUTO-ATUALIZAÇÃO ---------- */
  // Recarrega sozinho quando há um novo deploy (fim do Ctrl+F5).
  (function autoUpdate() {
    function checar() {
      fetch('/api/versao', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var nova = j.versao || '';
          var guardada = localStorage.getItem('art_versao_admin');
          if (!guardada) {
            localStorage.setItem('art_versao_admin', nova);
          } else if (guardada !== nova) {
            localStorage.setItem('art_versao_admin', nova);
            location.reload();
          }
        })
        .catch(function () { /* sem conexão: ignora */ });
    }
    setInterval(checar, 45000);
  })();

  /* ---------- Helpers ---------- */
  var $ = function (s) { return document.querySelector(s); };
  var token = null; // BRB Pro: agora usa cookie HttpOnly (credentials: include)

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtBRL(v) {
    return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
  }
  // Converte "12,50" ou "12.50" -> 12.5 (aceita vírgula ou ponto)
  function toFloat(s) {
    if (s === '' || s == null) return NaN;
    var str = String(s).trim().replace(',', '.');
    var n = parseFloat(str);
    return n;
  }
  function hojeISO(offset) {
    var d = new Date();
    if (offset) d.setDate(d.getDate() + offset);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function toast(msg) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  // Mostra qualquer erro de JavaScript (para diagnóstico visível)
  window.addEventListener('error', function (e) {
    try { toast('Erro: ' + (e.message || 'desconhecido')); } catch (_) {}
  });
  function modal(html) {
    var bg = $('#modalBg'), box = $('#modalBox');
    box.innerHTML = html;
    bg.hidden = false;
    return bg;
  }
  function fecharModal() { var bg = $('#modalBg'); if (bg) bg.hidden = true; }

  async function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    opts.credentials = 'include'; // BRB Pro: envia cookie __Host-brb_token
    var r = await fetch(url, opts);
    var j = await r.json().catch(function () { return {}; });
    if (r.status === 401) {
      // BRB Pro: limpa cookie no servidor via logout, aqui só redireciona

      window.location.href = '/admin/login.html';
      throw new Error('Não autorizado');
    }
    return j;
  }

  /* ---------- Autenticação inicial ---------- */
  // BRB Pro: auth via cookie — tenta /api/admin/me sem checar localStorage
  // if (!token) { window.location.href = '/admin/login.html'; return; }
  var ME = null;
  var EU_SOU_MASTER = false;
  api('/api/admin/me').then(function (j) {
    if (!j.ok) { window.location.href = '/admin/login.html'; return; }
    ME = j.user || {};
    EU_SOU_MASTER = (ME.role === 'master');
    // Mostra a aba de gestão de clientes/barbearias apenas para o master
    if (EU_SOU_MASTER) { var t = document.getElementById('tabBtnClientesPlataforma'); if (t) t.hidden = false; }
  }).catch(function(){ window.location.href = '/admin/login.html'; });

  /* ---------- Navegação ---------- */
  var titulos = { dashboard: 'Visão geral', agenda: 'Agenda', importar: 'Importar agenda', clientes: 'Clientes', caixa: 'Fluxo de caixa', estoque: 'Estoque', servicos: 'Serviços & preços', galeria: 'Galeria', faq: 'Dúvidas frequentes', relatorio: 'Relatório', auditoria: 'Auditoria', config: 'Configurações' };
  document.querySelectorAll('.nav-item[data-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.nav-item[data-tab]').forEach(function (b) { b.classList.remove('ativo'); });
      btn.classList.add('ativo');
      var tab = btn.getAttribute('data-tab');
      document.querySelectorAll('main section').forEach(function (s) { s.hidden = true; });
      $('#tab-' + tab).hidden = false;
      $('#titulo').textContent = titulos[tab];
      carregarTab(tab);
    });
  });
  $('#btnSair').addEventListener('click', async function () {
    try { await fetch('/api/admin/logout', { method:'POST', credentials:'include' }); } catch(_){}
    // limpa legacy
    try { localStorage.removeItem('art_token'); localStorage.removeItem('art_nome'); } catch(_){}
    // Vai direto para o site público (em vez de ficar preso na tela de login)
    window.location.href = '/';
  });
  $('#modalBg').addEventListener('click', function (e) { if (e.target === this) fecharModal(); });
  $('#hoje').textContent = 'Hoje: ' + hojeISO().split('-').reverse().join('/');

  function carregarTab(tab) {
    if (tab === 'dashboard') carregarDashboard();
    if (tab === 'agenda') carregarAgenda();
    if (tab === 'importar') { /* não faz nada até o usuário colar e analisar */ }
    if (tab === 'clientes') carregarClientes();
    if (tab === 'caixa') carregarCaixa();
    if (tab === 'estoque') carregarEstoque();
    if (tab === 'servicos') carregarServicos();
    if (tab === 'galeria') carregarGaleria();
    if (tab === 'faq') carregarFaq();
    if (tab === 'relatorio') { carregarRelatorio(); carregarRelatorioMensal(); }
    if (tab === 'auditoria') carregarAuditoria();
    if (tab === 'clientesPlataforma') carregarClientesPlataforma();
  }

  /* ============================================================
     DELEGAÇÃO DE EVENTOS (substitui todos os onclick inline)
     ============================================================ */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var a = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');

    switch (a) {
      case 'fechar-modal': fecharModal(); break;
      case 'novo-agendamento': formAgendamento(btn.getAttribute('data-data'), btn.getAttribute('data-horario'), null); break;
      case 'editar-agendamento': editarAgendamento(parseInt(id, 10)); break;
      case 'cancelar-agendamento': cancelarAgendamento(parseInt(id, 10)); break;
      case 'receber': abrirReceber(parseInt(id, 10)); break;
      case 'excluir-cliente': excluirCliente(parseInt(id, 10)); break;
      case 'excluir-lancamento': excluirLancamento(parseInt(id, 10)); break;
      case 'ajustar-estoque': ajustarEstoque(parseInt(id, 10), parseInt(btn.getAttribute('data-atual'), 10), parseInt(btn.getAttribute('data-delta'), 10)); break;
      case 'excluir-estoque': excluirEstoque(parseInt(id, 10)); break;
      case 'editar-servico': editarServico(parseInt(id, 10)); break;
      case 'remover-servico': removerServico(parseInt(id, 10)); break;
      case 'reativar-servico': reativarServico(parseInt(id, 10)); break;
      case 'excluir-foto': excluirFoto(parseInt(id, 10)); break;
      case 'editar-faq': editarFaq(parseInt(id, 10)); break;
      case 'excluir-faq': excluirFaq(parseInt(id, 10)); break;
    }
  });

  /* ---------- Dashboard ---------- */
  async function carregarDashboard() {
    var j = await api('/api/admin/resumo');
    var s = j.caixa || { entradas: 0, saidas: 0 };
    $('#stats').innerHTML =
      '<div class="stat"><div class="label">Agendamentos hoje</div><div class="valor">' + j.agendamentos.length + '</div></div>' +
      '<div class="stat"><div class="label">Entradas hoje</div><div class="valor green">' + fmtBRL(s.entradas) + '</div></div>' +
      '<div class="stat"><div class="label">Saídas hoje</div><div class="valor red">' + fmtBRL(s.saidas) + '</div></div>' +
      '<div class="stat"><div class="label">Clientes cadastrados</div><div class="valor gold">' + j.totalClientes + '</div></div>';

    $('#dashAgenda').innerHTML = j.agendamentos.length
      ? '<table class="tabela"><tr><th>Hora</th><th>Cliente</th><th>Serviço</th><th>Pagamento</th></tr>' +
        j.agendamentos.map(function (a) {
          var pg = a.pago
            ? '<span class="badge badge-ok">✅ ' + fmtBRL(a.valor) + '</span>'
            : '<span class="badge badge-alerta">pendente</span>';
          return '<tr><td><b>' + esc(a.horario) + '</b></td><td>' + esc(a.nome) + '</td><td>' + esc(a.servico) + (Number(a.num_slots) >= 2 ? ' <span class="badge badge-alerta">2h</span>' : '') + '</td><td>' + pg + '</td></tr>';
        }).join('') + '</table>'
      : '<p class="vazio">Nenhum agendamento para hoje ainda.</p>';

    $('#dashEstoque').innerHTML = j.estoqueBaixo.length
      ? '<table class="tabela"><tr><th>Produto</th><th>Qtd</th></tr>' +
        j.estoqueBaixo.map(function (e) { return '<tr><td>' + esc(e.produto) + '</td><td><span class="badge badge-baixo">' + e.quantidade + '</span></td></tr>'; }).join('') + '</table>'
      : '<p class="vazio">Nenhum produto com estoque baixo. 👍</p>';
  }

  /* ---------- Agenda ---------- */
  var servicosPublicos = ['Corte', 'Barba', 'Sobrancelha', 'Cavanhaque', 'Combo Corte + Barba', 'Pigmentação', 'Alisamento', 'Nevou', 'Reflexo'];
  var servicosDinamicos = null;
  var clientesCache = null;
  var agendaAtual = {}; // guarda os agendamentos do dia (id -> agendamento)

  async function garantirServicos() {
    var j = await api('/api/admin/servicos');
    servicosDinamicos = (j.servicos || []).filter(function (s) { return s.ativo; });
    if (!servicosDinamicos.length) servicosDinamicos = servicosPublicos.map(function (n) { return { nome: n, slots: 1, online: true, preco: null }; });
    return servicosDinamicos;
  }
  async function garantirClientes() {
    var j = await api('/api/admin/clientes');
    clientesCache = j.clientes || [];
    return clientesCache;
  }
  function precoDe(nome) {
    var s = (servicosDinamicos || []).find(function (x) { return x.nome === nome; });
    return s && s.preco != null ? s.preco : null;
  }

  async function carregarAgenda() {
    if (!$('#agendaData').value) $('#agendaData').value = hojeISO();
    var data = $('#agendaData').value;
    var [slots, ag] = await Promise.all([
      api('/api/slots?data=' + data),
      api('/api/admin/agenda?inicio=' + data + '&fim=' + data),
    ]);
    var porHora = {};
    (ag.agendamentos || []).forEach(function (a) { porHora[a.horario] = a; });
    agendaAtual = {};
    (ag.agendamentos || []).forEach(function (a) { agendaAtual[a.id] = a; });

    if (slots.fechado || !slots.slots.length) {
      $('#agendaSlots').innerHTML = '<p class="vazio">Barbearia fechada neste dia.</p>';
      return;
    }

    $('#agendaSlots').innerHTML = slots.slots.map(function (s) {
      var a = porHora[s.horario];
      if (a) {
        var pago = a.pago;
        var html = '<div class="slot ocupado' + (pago ? ' pago' : '') + '"><span class="hora">' + s.horario + '</span>' +
          '<span class="nome">' + esc(a.nome) + '</span>' +
          '<span class="svc">' + esc(a.servico) + (Number(a.num_slots) >= 2 ? ' · 2h' : '') + '</span>';
        if (pago) {
          html += '<span class="badge badge-ok" style="margin-top:.3rem;">✅ ' + fmtBRL(a.valor) + ' · ' + esc(a.forma_pagamento) + '</span>';
        } else {
          html += '<span class="valor-pendente" style="margin-top:.3rem;">💲 ' + (a.valor != null ? fmtBRL(a.valor) : 'valor a definir') + '</span>';
        }
        html += '<div class="mini-acoes">';
        if (pago) {
          html += '<button class="btn btn-ghost btn-sm" data-action="editar-agendamento" data-id="' + a.id + '">Editar</button>' +
            '<button class="btn btn-danger btn-sm" data-action="cancelar-agendamento" data-id="' + a.id + '">Cancelar</button>';
        } else {
          html += '<button class="btn btn-gold btn-sm" data-action="receber" data-id="' + a.id + '">💵 Receber</button>' +
            '<button class="btn btn-ghost btn-sm" data-action="editar-agendamento" data-id="' + a.id + '">Editar</button>' +
            '<button class="btn btn-danger btn-sm" data-action="cancelar-agendamento" data-id="' + a.id + '">✕</button>';
        }
        html += '</div></div>';
        return html;
      }
      // Sem agendamento direto neste horário:
      if (s.disponivel === false) {
        // 2º horário de um combo — bloqueado (não pode agendar)
        return '<div class="slot bloqueado"><span class="hora">' + s.horario + '</span>' +
          '<span class="svc">🔒 ocupado pelo combo</span></div>';
      }
      return '<div class="slot livre"><span class="hora">' + s.horario + '</span>' +
        '<span class="svc">livre</span>' +
        '<div class="mini-acoes"><button class="btn btn-gold btn-sm" data-action="novo-agendamento" data-data="' + data + '" data-horario="' + s.horario + '">+ Agendar</button></div></div>';
    }).join('');
  }
  $('#agendaData').addEventListener('change', carregarAgenda);

  async function formAgendamento(data, horario, a) {
    var svcs = await garantirServicos();
    var clientes = await garantirClientes();
    var opts = svcs.map(function (s) {
      return '<option' + (a && a.servico === s.nome ? ' selected' : '') + '>' + esc(s.nome) + '</option>';
    }).join('');
    var clientOpts = '<option value="">— sem vínculo —</option>' + clientes.map(function (c) {
      return '<option value="' + c.id + '"' + (a && a.cliente_id === c.id ? ' selected' : '') + '>' + esc(c.nome) + '</option>';
    }).join('');
    var valAtual = a && a.valor != null ? a.valor : '';
    modal(
      '<h3>' + (a ? 'Editar agendamento' : 'Novo agendamento — ' + horario) + '</h3>' +
      '<div class="form-grid">' +
      '<div class="form-row"><label class="field"><span>Data</span><input type="date" id="mData" value="' + data + '" disabled></label>' +
      '<label class="field"><span>Horário</span><input type="text" id="mHora" value="' + horario + '" disabled></label></div>' +
      '<label class="field"><span>Cliente cadastrado (opcional)</span><select id="mCliente">' + clientOpts + '</select></label>' +
      '<div id="mHistorico" style="font-size:.8rem;color:var(--muted);"></div>' +
      '<label class="field"><span>Nome</span><input type="text" id="mNome" value="' + esc(a ? a.nome : '') + '" placeholder="Nome do cliente"></label>' +
      '<label class="field"><span>WhatsApp</span><input type="text" id="mZap" value="' + esc(a ? a.whatsapp : '') + '" placeholder="(31) 99999-9999"></label>' +
      '<label class="field"><span>Serviço</span><select id="mServico">' + opts + '</select></label>' +
      '<label class="field"><span>Valor (R$) — preenchido automático, pode editar</span><input type="number" id="mValor" step="0.01" min="0" value="' + valAtual + '" placeholder="0.00"></label>' +
      '<label class="field"><span>Observações</span><input type="text" id="mObs" value="' + esc(a ? a.obs : '') + '"></label>' +
      '<div class="modal-acoes"><button class="btn btn-ghost" data-action="fechar-modal">Cancelar</button>' +
      '<button class="btn btn-gold" id="mSalvar">' + (a ? 'Salvar' : 'Agendar') + '</button></div>' +
      '</div>'
    );

    function autopreencherValor() {
      var s = $('#mServico').value;
      var p = precoDe(s);
      if (p != null && $('#mValor').value === '') $('#mValor').value = p;
    }
    $('#mServico').addEventListener('change', autopreencherValor);
    if ($('#mValor').value === '') autopreencherValor();

    async function aoSelecionarCliente() {
      var cid = $('#mCliente').value;
      if (!cid) { $('#mHistorico').innerHTML = ''; return; }
      try {
        var j = await api('/api/admin/clientes/' + cid);
        var cli = j.cliente;
        if ($('#mNome').value === '') $('#mNome').value = cli.nome || '';
        if ($('#mZap').value === '') $('#mZap').value = cli.whatsapp || '';
        var hist = j.historico || [];
        if (hist.length) {
          $('#mHistorico').innerHTML = '<b>Histórico:</b> ' + hist.slice(0, 5).map(function (h) {
            return String(h.data).slice(0, 10).split('-').reverse().join('/') + ' ' + esc(h.servico) + (h.pago ? ' ✅' : '');
          }).join(' · ');
        } else {
          $('#mHistorico').innerHTML = '<b>Sem histórico ainda.</b>';
        }
      } catch (e) { $('#mHistorico').innerHTML = ''; }
    }
    $('#mCliente').addEventListener('change', aoSelecionarCliente);
    if (a && a.cliente_id) aoSelecionarCliente();

    $('#mSalvar').onclick = async function () {
      var body = {
        nome: $('#mNome').value, whatsapp: $('#mZap').value,
        servico: $('#mServico').value, obs: $('#mObs').value,
        data: data, horario: horario,
        valor: $('#mValor').value === '' ? null : toFloat($('#mValor').value),
        cliente_id: $('#mCliente').value || null,
      };
      var j = a
        ? await api('/api/admin/agendamento/' + a.id, { method: 'PUT', body: JSON.stringify(body) })
        : await api('/api/admin/agendamento', { method: 'POST', body: JSON.stringify(body) });
      if (j.ok) { toast('Agendamento salvo! 💈'); fecharModal(); carregarAgenda(); }
      else { toast(j.error || 'Erro ao salvar.'); }
    };
  }

  function editarAgendamento(id) {
    var a = agendaAtual[id];
    if (!a) { toast('Agendamento não encontrado. Recarregue a página.'); return; }
    formAgendamento(a.data, a.horario, a);
  }
  function cancelarAgendamento(id) {
    if (!confirm('Cancelar este agendamento?')) return;
    api('/api/admin/agendamento/' + id, { method: 'DELETE' }).then(function (j) {
      if (j.ok) { toast('Agendamento cancelado.'); carregarAgenda(); }
      else toast(j.error || 'Erro ao cancelar.');
    }).catch(function () { toast('Erro de conexão ao cancelar.'); });
  }
  function abrirReceber(id) {
    var a = agendaAtual[id];
    if (!a) { toast('Agendamento não encontrado. Recarregue a página.'); return; }
    var valInicial = a.valor > 0 ? a.valor : '';
    modal(
      '<h3>💵 Receber pagamento</h3>' +
      '<p style="color:var(--muted);font-size:.9rem;margin-bottom:1rem;">' + esc(a.nome) + ' — ' + esc(a.servico) + '</p>' +
      '<div class="form-grid">' +
      '<label class="field"><span>Valor (R$)</span><input type="number" id="rValor" step="0.01" min="0" value="' + valInicial + '" placeholder="0.00" autofocus></label>' +
      '<label class="field"><span>Forma de pagamento</span>' +
      '<select id="rForma"><option>Pix</option><option>Dinheiro</option><option>Cartão de débito</option><option>Cartão de crédito</option><option>Outro</option></select></label>' +
      '<div class="modal-acoes"><button class="btn btn-ghost" data-action="fechar-modal">Voltar</button>' +
      '<button class="btn btn-gold" id="rConfirma">Confirmar recebimento</button></div>' +
      '</div>'
    );
    $('#rConfirma').onclick = async function () {
      var v = toFloat($('#rValor').value);
      var f = $('#rForma').value;
      if (!(v >= 0) || $('#rValor').value === '') { toast('Informe o valor.'); return; }
      var jj = await api('/api/admin/agendamento/' + id + '/receber', { method: 'POST', body: JSON.stringify({ valor: v, forma_pagamento: f }) });
      if (jj.ok) { toast('Recebido! ' + fmtBRL(v) + ' lançado no caixa. 💰'); fecharModal(); carregarAgenda(); }
      else toast(jj.error || 'Erro.');
    };
  }

  /* ---------- Clientes ---------- */
  async function carregarClientes() {
    var j = await api('/api/admin/clientes');
    $('#clientesLista').innerHTML = j.clientes.length
      ? '<table class="tabela"><tr><th>Nome</th><th>WhatsApp</th><th>Observações</th><th></th></tr>' +
        j.clientes.map(function (c) {
          return '<tr><td><b>' + esc(c.nome) + '</b></td><td>' + esc(c.whatsapp) + '</td><td>' + esc(c.observacoes) + '</td>' +
            '<td class="acoes"><button class="btn btn-danger btn-sm" data-action="excluir-cliente" data-id="' + c.id + '">Excluir</button></td></tr>';
        }).join('') + '</table>'
      : '<p class="vazio">Nenhum cliente cadastrado ainda.</p>';
  }
  $('#clienteSalvar').onclick = async function () {
    var nome = $('#clienteNome').value.trim();
    if (nome.length < 2) { toast('Informe o nome.'); return; }
    var j = await api('/api/admin/clientes', { method: 'POST', body: JSON.stringify({ nome: nome, whatsapp: $('#clienteZap').value, observacoes: $('#clienteObs').value }) });
    if (j.ok) { toast('Cliente salvo!'); $('#clienteNome').value = ''; $('#clienteZap').value = ''; $('#clienteObs').value = ''; carregarClientes(); }
    else toast(j.error || 'Erro.');
  };
  async function excluirCliente(id) {
    if (!confirm('Excluir este cliente?')) return;
    await api('/api/admin/clientes/' + id, { method: 'DELETE' });
    toast('Cliente removido.'); carregarClientes();
  }

  /* ---------- Caixa ---------- */
  async function carregarCaixa() {
    if (!$('#caixaData').value) $('#caixaData').value = hojeISO();
    if (!$('#caixaInicio').value) $('#caixaInicio').value = hojeISO();
    if (!$('#caixaFim').value) $('#caixaFim').value = hojeISO();
    var ini = $('#caixaInicio').value, fim = $('#caixaFim').value;
    var j = await api('/api/admin/caixa?inicio=' + ini + '&fim=' + fim);
    $('#caixaResumo').innerHTML =
      '<div class="stat"><div class="label">Entradas</div><div class="valor green">' + fmtBRL(j.resumo.entradas) + '</div></div>' +
      '<div class="stat"><div class="label">Saídas</div><div class="valor red">' + fmtBRL(j.resumo.saidas) + '</div></div>' +
      '<div class="stat"><div class="label">Saldo</div><div class="valor ' + (j.resumo.saldo >= 0 ? 'gold' : 'red') + '">' + fmtBRL(j.resumo.saldo) + '</div></div>';
    $('#caixaLista').innerHTML = j.lancamentos.length
      ? '<table class="tabela"><tr><th>Data</th><th>Tipo</th><th>Categoria</th><th>Descrição</th><th>Valor</th><th></th></tr>' +
        j.lancamentos.map(function (l) {
          return '<tr><td>' + String(l.data).slice(0, 10).split('-').reverse().join('/') + '</td>' +
            '<td><span class="badge badge-' + l.tipo + '">' + (l.tipo === 'entrada' ? 'Entrada' : 'Saída') + '</span></td>' +
            '<td>' + esc(l.categoria) + '</td><td>' + esc(l.descricao) + '</td>' +
            '<td><b>' + fmtBRL(l.valor) + '</b></td>' +
            '<td class="acoes"><button class="btn btn-danger btn-sm" data-action="excluir-lancamento" data-id="' + l.id + '">Excluir</button></td></tr>';
        }).join('') + '</table>'
      : '<p class="vazio">Nenhum lançamento neste período.</p>';
  }
  $('#caixaSalvar').onclick = async function () {
    var valor = toFloat($('#caixaValor').value);
    if (!(valor > 0)) { toast('Informe um valor válido.'); return; }
    var j = await api('/api/admin/caixa', { method: 'POST', body: JSON.stringify({ data: $('#caixaData').value, tipo: $('#caixaTipo').value, categoria: $('#caixaCat').value, descricao: $('#caixaDesc').value, valor: valor }) });
    if (j.ok) { toast('Lançamento registrado!'); $('#caixaCat').value = ''; $('#caixaDesc').value = ''; $('#caixaValor').value = ''; carregarCaixa(); }
    else toast(j.error || 'Erro.');
  };
  $('#caixaInicio').addEventListener('change', carregarCaixa);
  $('#caixaFim').addEventListener('change', carregarCaixa);
  async function excluirLancamento(id) {
    if (!confirm('Excluir este lançamento?')) return;
    await api('/api/admin/caixa/' + id, { method: 'DELETE' });
    toast('Lançamento removido.'); carregarCaixa();
  }

  /* ---------- Estoque ---------- */
  async function carregarEstoque() {
    var j = await api('/api/admin/estoque');
    $('#estoqueLista').innerHTML = j.itens.length
      ? '<table class="tabela"><tr><th>Produto</th><th>Qtd</th><th>Mínimo</th><th>Custo</th><th>Venda</th><th></th></tr>' +
        j.itens.map(function (e) {
          var baixo = Number(e.quantidade) <= Number(e.quantidade_minima);
          return '<tr><td><b>' + esc(e.produto) + '</b>' + (baixo ? ' <span class="badge badge-baixo">baixo</span>' : '') + '</td>' +
            '<td>' + e.quantidade + '</td><td>' + e.quantidade_minima + '</td>' +
            '<td>' + (e.custo != null ? fmtBRL(e.custo) : '—') + '</td><td>' + (e.preco_venda != null ? fmtBRL(e.preco_venda) : '—') + '</td>' +
            '<td class="acoes">' +
            '<button class="btn btn-ghost btn-sm" data-action="ajustar-estoque" data-id="' + e.id + '" data-atual="' + e.quantidade + '" data-delta="-1">−</button>' +
            '<button class="btn btn-ghost btn-sm" data-action="ajustar-estoque" data-id="' + e.id + '" data-atual="' + e.quantidade + '" data-delta="1">+</button>' +
            '<button class="btn btn-danger btn-sm" data-action="excluir-estoque" data-id="' + e.id + '">✕</button></td></tr>';
        }).join('') + '</table>'
      : '<p class="vazio">Nenhum produto cadastrado.</p>';
  }
  $('#estoqueSalvar').onclick = async function () {
    var nome = $('#estoqueProduto').value.trim();
    if (nome.length < 2) { toast('Informe o produto.'); return; }
    var custo = $('#estoqueCusto').value;
    var preco = $('#estoquePreco').value;
    if (custo !== '' && isNaN(toFloat(custo))) { toast('Custo inválido.'); return; }
    if (preco !== '' && isNaN(toFloat(preco))) { toast('Preço de venda inválido.'); return; }
    var j = await api('/api/admin/estoque', { method: 'POST', body: JSON.stringify({ produto: nome, quantidade: $('#estoqueQtd').value, quantidade_minima: $('#estoqueMin').value, custo: custo === '' ? '' : toFloat(custo), preco_venda: preco === '' ? '' : toFloat(preco) }) });
    if (j.ok) { toast('Produto adicionado!'); $('#estoqueProduto').value = ''; $('#estoqueQtd').value = 0; $('#estoqueMin').value = 0; $('#estoqueCusto').value = ''; $('#estoquePreco').value = ''; carregarEstoque(); }
    else toast(j.error || 'Erro.');
  };
  async function ajustarEstoque(id, atual, delta) {
    await api('/api/admin/estoque/' + id, { method: 'PUT', body: JSON.stringify({ quantidade: atual + delta }) });
    carregarEstoque();
  }
  async function excluirEstoque(id) {
    if (!confirm('Excluir este produto?')) return;
    await api('/api/admin/estoque/' + id, { method: 'DELETE' });
    toast('Produto removido.'); carregarEstoque();
  }

  /* ---------- Serviços & preços ---------- */
  async function carregarServicos() {
    var j = await api('/api/admin/servicos');
    var servicos = j.servicos || [];
    $('#servicosLista').innerHTML = servicos.length
      ? '<table class="tabela"><tr><th>Serviço</th><th>Preço</th><th>Horários</th><th>Online</th><th></th></tr>' +
        servicos.map(function (s) {
          var ativo = s.ativo;
          var acoes = ativo
            ? '<button class="btn btn-ghost btn-sm" data-action="editar-servico" data-id="' + s.id + '">Editar</button>' +
              '<button class="btn btn-danger btn-sm" data-action="remover-servico" data-id="' + s.id + '">Remover</button>'
            : '<button class="btn btn-ghost btn-sm" data-action="reativar-servico" data-id="' + s.id + '">Reativar</button>';
          return '<tr style="' + (ativo ? '' : 'opacity:.45;') + '"><td><b>' + esc(s.nome) + '</b>' + (ativo ? '' : ' <span class="badge badge-saida">desativado</span>') + '</td>' +
            '<td>' + (s.preco != null ? fmtBRL(s.preco) : 'sob consulta') + '</td>' +
            '<td>' + s.slots + (Number(s.slots) >= 2 ? ' (2 seguidos)' : '') + '</td>' +
            '<td>' + (s.online ? '<span class="badge badge-ok">sim</span>' : '<span class="badge badge-alerta">contato</span>') + '</td>' +
            '<td class="acoes">' + acoes + '</td></tr>';
        }).join('') + '</table>'
      : '<p class="vazio">Nenhum serviço cadastrado.</p>';
  }

  function formServico(a) {
    modal(
      '<h3>' + (a ? 'Editar serviço' : 'Novo serviço') + '</h3>' +
      '<div class="form-grid">' +
      '<label class="field"><span>Nome</span><input type="text" id="sNome" value="' + esc(a ? a.nome : '') + '"></label>' +
      '<label class="field"><span>Preço (R$) — vazio = sob consulta</span><input type="number" id="sPreco" step="0.01" min="0" value="' + (a && a.preco != null ? a.preco : '') + '"></label>' +
      '<label class="field"><span>Horários que ocupa</span><select id="sSlots"><option value="1"' + (a && Number(a.slots) === 1 ? ' selected' : '') + '>1 horário</option><option value="2"' + (a && Number(a.slots) === 2 ? ' selected' : '') + '>2 horários seguidos</option></select></label>' +
      '<label class="field"><span>Agendável pelo site?</span><select id="sOnline"><option value="true"' + (a && a.online ? ' selected' : '') + '>Sim</option><option value="false"' + (a && !a.online ? ' selected' : '') + '>Não (só por contato)</option></select></label>' +
      '<div class="modal-acoes"><button class="btn btn-ghost" data-action="fechar-modal">Cancelar</button>' +
      '<button class="btn btn-gold" id="sSalvar">Salvar</button></div>' +
      '</div>'
    );
    $('#sSalvar').onclick = async function () {
      var body = { nome: $('#sNome').value, preco: $('#sPreco').value === '' ? null : toFloat($('#sPreco').value), slots: parseInt($('#sSlots').value, 10), online: $('#sOnline').value === 'true' };
      if (a) body.ativo = a.ativo;
      var j = a
        ? await api('/api/admin/servicos/' + a.id, { method: 'PUT', body: JSON.stringify(body) })
        : await api('/api/admin/servicos', { method: 'POST', body: JSON.stringify(body) });
      if (j.ok) { toast('Serviço salvo! 💈'); fecharModal(); carregarServicos(); }
      else toast(j.error || 'Erro ao salvar.');
    };
  }

  $('#svcSalvar').onclick = async function () {
    var nome = $('#svcNome').value.trim();
    if (nome.length < 2) { toast('Informe o nome do serviço.'); return; }
    var j = await api('/api/admin/servicos', { method: 'POST', body: JSON.stringify({ nome: nome, preco: $('#svcPreco').value === '' ? null : toFloat($('#svcPreco').value), slots: parseInt($('#svcSlots').value, 10), online: $('#svcOnline').value === 'true' }) });
    if (j.ok) { toast('Serviço adicionado!'); $('#svcNome').value = ''; $('#svcPreco').value = ''; carregarServicos(); }
    else toast(j.error || 'Erro.');
  };

  async function editarServico(id) {
    var j = await api('/api/admin/servicos');
    var s = (j.servicos || []).find(function (x) { return x.id === id; });
    if (s) formServico(s);
  }
  async function removerServico(id) {
    var j = await api('/api/admin/servicos');
    var s = (j.servicos || []).find(function (x) { return x.id === id; });
    var nome = s ? s.nome : 'este serviço';
    if (!confirm('Remover o serviço "' + nome + '"?')) return;
    await api('/api/admin/servicos/' + id, { method: 'DELETE' });
    toast('Serviço removido.'); carregarServicos();
  }
  async function reativarServico(id) {
    var j = await api('/api/admin/servicos');
    var s = (j.servicos || []).find(function (x) { return x.id === id; });
    if (s) { await api('/api/admin/servicos/' + id, { method: 'PUT', body: JSON.stringify({ nome: s.nome, preco: s.preco, slots: s.slots, online: s.online, ativo: true }) }); toast('Serviço reativado!'); carregarServicos(); }
  }

  /* ---------- Relatório ---------- */
  async function carregarRelatorio() {
    if (!$('#relData').value) $('#relData').value = hojeISO();
    var data = $('#relData').value;
    var j = await api('/api/admin/relatorio?data=' + data);
    $('#relStats').innerHTML =
      '<div class="stat"><div class="label">Entradas</div><div class="valor green">' + fmtBRL(j.entradas) + '</div></div>' +
      '<div class="stat"><div class="label">Saídas</div><div class="valor red">' + fmtBRL(j.saidas) + '</div></div>' +
      '<div class="stat"><div class="label">Saldo do dia</div><div class="valor ' + (j.entradas - j.saidas >= 0 ? 'gold' : 'red') + '">' + fmtBRL(j.entradas - j.saidas) + '</div></div>' +
      '<div class="stat"><div class="label">Atendimentos pagos</div><div class="valor">' + j.agendamentosPagos + '</div></div>';

    $('#relForma').innerHTML = j.porForma.length
      ? '<table class="tabela"><tr><th>Forma</th><th>Total</th><th>%</th></tr>' +
        j.porForma.map(function (f) {
          var pct = j.entradas > 0 ? Math.round((f.total / j.entradas) * 100) : 0;
          return '<tr><td><b>' + esc(f.forma) + '</b></td><td>' + fmtBRL(f.total) + '</td><td>' + pct + '%</td></tr>';
        }).join('') + '</table>'
      : '<p class="vazio">Nenhuma entrada registrada neste dia.</p>';

    $('#relCategoria').innerHTML = j.porCategoria.length
      ? '<table class="tabela"><tr><th>Categoria</th><th>Total</th></tr>' +
        j.porCategoria.map(function (c) {
          return '<tr><td><b>' + esc(c.categoria) + '</b></td><td>' + fmtBRL(c.total) + '</td></tr>';
        }).join('') + '</table>'
      : '<p class="vazio">Nenhuma categoria registrada.</p>';
  }
  $('#relGerar').onclick = carregarRelatorio;
  $('#relData').addEventListener('change', carregarRelatorio);

  /* ---------- Relatório mensal ---------- */
  function mesAtual() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  async function carregarRelatorioMensal() {
    if (!$('#relMes').value) $('#relMes').value = mesAtual();
    var mes = $('#relMes').value;
    var j = await api('/api/admin/relatorio-mensal?mes=' + mes);

    $('#relMesStats').innerHTML =
      '<div class="stat"><div class="label">Entradas no mês</div><div class="valor green">' + fmtBRL(j.totalEntradas) + '</div></div>' +
      '<div class="stat"><div class="label">Saídas no mês</div><div class="valor red">' + fmtBRL(j.totalSaidas) + '</div></div>' +
      '<div class="stat"><div class="label">Saldo do mês</div><div class="valor ' + (j.saldo >= 0 ? 'gold' : 'red') + '">' + fmtBRL(j.saldo) + '</div></div>' +
      '<div class="stat"><div class="label">Atendimentos</div><div class="valor">' + j.totalServicos + '</div></div>';

    if (!j.porDia.length) {
      $('#relMesTabela').innerHTML = '<p class="vazio">Nenhum movimento registrado neste mês.</p>';
      return;
    }

    var linhas = j.porDia.map(function (d) {
      var dataFmt = d.data.split('-').reverse().join('/');
      var diaSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][new Date(d.data + 'T12:00:00').getDay()];
      var servicosHtml = d.servicos.length
        ? d.servicos.map(function (s) {
            return '<span class="svc-chip">' + esc(s.servico) + ' ×' + s.qtd + ' (' + fmtBRL(s.total) + ')</span>';
          }).join(' ')
        : '<span class="muted">—</span>';
      return '<tr>' +
        '<td><b>' + dataFmt + '</b> <span class="muted">(' + diaSemana + ')</span></td>' +
        '<td class="green">' + (d.entradas > 0 ? '+' + fmtBRL(d.entradas) : '—') + '</td>' +
        '<td class="red">' + (d.saidas > 0 ? '−' + fmtBRL(d.saidas) : '—') + '</td>' +
        '<td><b>' + fmtBRL(d.entradas - d.saidas) + '</b></td>' +
        '<td>' + servicosHtml + '</td>' +
        '</tr>';
    }).join('');

    $('#relMesTabela').innerHTML =
      '<table class="tabela">' +
      '<tr><th>Dia</th><th>Entradas</th><th>Saídas</th><th>Saldo</th><th>Serviços do dia</th></tr>' +
      linhas +
      '</table>';
  }
  $('#relMesGerar').onclick = carregarRelatorioMensal;
  $('#relMes').addEventListener('change', carregarRelatorioMensal);

  /* ---------- Galeria ---------- */
  var fotoDataUrl = null;
  var fotoTipo = 'imagem';

  async function carregarGaleria() {
    var j = await api('/api/admin/fotos');
    var fotos = j.fotos || [];

    var cats = {};
    fotos.forEach(function (f) { cats[f.categoria] = true; });
    $('#categoriasExistentes').innerHTML = Object.keys(cats).map(function (c) {
      return '<option value="' + esc(c) + '"></option>';
    }).join('');

    var porCategoria = {};
    fotos.forEach(function (f) {
      if (!porCategoria[f.categoria]) porCategoria[f.categoria] = [];
      porCategoria[f.categoria].push(f);
    });

    var catsLista = Object.keys(porCategoria).sort();
    if (!catsLista.length) {
      $('#fotosLista').innerHTML = '<p class="vazio">Nenhuma foto publicada ainda. Publique a primeira acima. 📸</p>';
      return;
    }

    $('#fotosLista').innerHTML = catsLista.map(function (cat) {
      var fotosCat = porCategoria[cat];
      var thumbs = fotosCat.map(function (f) {
        var ehVideo = f.tipo === 'video';
        var midia = ehVideo
          ? '<div class="foto-video-wrap"><video src="/api/foto/' + f.id + '" muted playsinline preload="metadata"></video><span class="foto-video-badge">▶</span></div>'
          : '<img src="/api/foto/' + f.id + '" loading="lazy" alt="' + esc(cat) + '" />';
        return '<div class="foto-item">' + midia +
          '<button class="foto-del" data-action="excluir-foto" data-id="' + f.id + '" title="Excluir">✕</button>' +
          '</div>';
      }).join('');
      return '<div class="foto-grupo"><h3>' + esc(cat) + ' <span class="muted">(' + fotosCat.length + ')</span></h3>' +
        '<div class="foto-grid">' + thumbs + '</div></div>';
    }).join('');
  }

  function redimensionarImagem(file, cb) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var max = 1400;
        var w = img.width, h = img.height;
        if (w > max || h > max) {
          if (w >= h) { h = Math.round(h * max / w); w = max; }
          else { w = Math.round(w * max / h); h = max; }
        }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        cb(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  $('#fotoArquivo').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    var ehVideo = file.type.indexOf('video/') === 0;
    fotoTipo = ehVideo ? 'video' : 'imagem';

    if (ehVideo) {
      // vídeo: lê como data URL (sem redimensionar)
      var reader = new FileReader();
      reader.onload = function (e) {
        fotoDataUrl = e.target.result;
        var kb = Math.round(fotoDataUrl.length * 0.75 / 1024);
        if (kb > 20 * 1024) { toast('Vídeo muito grande (máx. 20MB).'); fotoDataUrl = null; return; }
        $('#fotoPreview').style.display = 'block';
        $('#fotoPreviewImg').style.display = 'none';
        $('#fotoPreviewVideo').style.display = 'block';
        $('#fotoPreviewVideo').src = fotoDataUrl;
        $('#fotoPreviewInfo').textContent = 'Vídeo — ' + (kb / 1024).toFixed(1) + ' MB';
      };
      reader.readAsDataURL(file);
    } else {
      // imagem: redimensiona pra otimizar
      redimensionarImagem(file, function (dataUrl) {
        fotoDataUrl = dataUrl;
        $('#fotoPreview').style.display = 'block';
        $('#fotoPreviewImg').style.display = 'block';
        $('#fotoPreviewVideo').style.display = 'none';
        $('#fotoPreviewImg').src = dataUrl;
        var kb = Math.round(dataUrl.length * 0.75 / 1024);
        $('#fotoPreviewInfo').textContent = 'Foto — ' + kb + ' KB (já otimizada)';
      });
    }
  });

  $('#fotoSalvar').onclick = async function () {
    var cat = $('#fotoCategoria').value.trim();
    if (cat.length < 2) { toast('Informe a categoria.'); return; }
    if (!fotoDataUrl) { toast('Escolha uma foto ou vídeo primeiro.'); return; }
    var j = await api('/api/admin/fotos', { method: 'POST', body: JSON.stringify({ categoria: cat, imagem: fotoDataUrl, tipo: fotoTipo }) });
    if (j.ok) {
      toast(fotoTipo === 'video' ? 'Vídeo publicado! 🎬' : 'Foto publicada! 📸');
      $('#fotoCategoria').value = '';
      $('#fotoArquivo').value = '';
      $('#fotoPreview').style.display = 'none';
      $('#fotoPreviewImg').style.display = 'none';
      $('#fotoPreviewVideo').style.display = 'none';
      $('#fotoPreviewVideo').src = '';
      fotoDataUrl = null;
      fotoTipo = 'imagem';
      carregarGaleria();
    } else toast(j.error || 'Erro ao publicar.');
  };

  async function excluirFoto(id) {
    if (!confirm('Excluir esta foto?')) return;
    await api('/api/admin/fotos/' + id, { method: 'DELETE' });
    toast('Foto excluída.'); carregarGaleria();
  }

  /* ---------- FAQ ---------- */
  var faqCache = [];
  async function carregarFaq() {
    var j = await api('/api/admin/faq');
    faqCache = j.faq || [];
    $('#faqListaAdmin').innerHTML = faqCache.length
      ? '<table class="tabela"><tr><th>Pergunta</th><th>Resposta</th><th></th></tr>' +
        faqCache.map(function (f) {
          return '<tr><td><b>' + esc(f.pergunta) + '</b></td><td>' + esc(f.resposta) + '</td>' +
            '<td class="acoes">' +
            '<button class="btn btn-ghost btn-sm" data-action="editar-faq" data-id="' + f.id + '">Editar</button>' +
            '<button class="btn btn-danger btn-sm" data-action="excluir-faq" data-id="' + f.id + '">Excluir</button>' +
            '</td></tr>';
        }).join('') + '</table>'
      : '<p class="vazio">Nenhuma pergunta cadastrada.</p>';
  }

  function formFaq(a) {
    modal(
      '<h3>' + (a ? 'Editar pergunta' : 'Nova pergunta') + '</h3>' +
      '<div class="form-grid">' +
      '<label class="field"><span>Pergunta</span><input type="text" id="fPergunta" value="' + esc(a ? a.pergunta : '') + '"></label>' +
      '<label class="field"><span>Resposta</span><textarea id="fResposta" rows="4">' + esc(a ? a.resposta : '') + '</textarea></label>' +
      '<div class="modal-acoes"><button class="btn btn-ghost" data-action="fechar-modal">Cancelar</button>' +
      '<button class="btn btn-gold" id="fSalvar">Salvar</button></div>' +
      '</div>'
    );
    $('#fSalvar').onclick = async function () {
      var body = { pergunta: $('#fPergunta').value, resposta: $('#fResposta').value };
      var j = a
        ? await api('/api/admin/faq/' + a.id, { method: 'PUT', body: JSON.stringify(body) })
        : await api('/api/admin/faq', { method: 'POST', body: JSON.stringify(body) });
      if (j.ok) { toast('Pergunta salva!'); fecharModal(); carregarFaq(); }
      else toast(j.error || 'Erro ao salvar.');
    };
  }

  $('#faqSalvar').onclick = async function () {
    var pergunta = $('#faqPergunta').value.trim();
    var resposta = $('#faqResposta').value.trim();
    if (pergunta.length < 5) { toast('Escreva a pergunta.'); return; }
    if (resposta.length < 5) { toast('Escreva a resposta.'); return; }
    var j = await api('/api/admin/faq', { method: 'POST', body: JSON.stringify({ pergunta: pergunta, resposta: resposta }) });
    if (j.ok) { toast('Pergunta adicionada!'); $('#faqPergunta').value = ''; $('#faqResposta').value = ''; carregarFaq(); }
    else toast(j.error || 'Erro.');
  };

  function editarFaq(id) {
    var f = faqCache.find(function (x) { return x.id === id; });
    if (f) formFaq(f);
  }
  async function excluirFaq(id) {
    if (!confirm('Excluir esta pergunta?')) return;
    await api('/api/admin/faq/' + id, { method: 'DELETE' });
    toast('Pergunta excluída.'); carregarFaq();
  }

  /* ---------- Importar agenda ---------- */
  var importItens = [];

  $('#importAnalisar').onclick = async function () {
    var texto = $('#importTexto').value;
    if (!texto.trim()) { toast('Cole o texto da agenda primeiro.'); return; }
    var j = await api('/api/admin/importar-agenda/preview', { method: 'POST', body: JSON.stringify({ texto: texto }) });
    importItens = j.itens || [];
    var ignorados = j.itensIgnorados || [];

    if (!importItens.length && !ignorados.length) {
      toast('Não encontrei nenhum horário com nome no texto.');
      $('#importResultadoCard').style.display = 'none';
      return;
    }

    var resumo = importItens.length + ' agendamento(s) identificado(s) para esta semana.';
    if (ignorados.length) {
      resumo += ' ' + ignorados.length + ' ignorado(s) — dia da semana que já passou.';
    }
    $('#importResumo').textContent = resumo;

    var html = '';
    if (importItens.length) {
      html += '<table class="tabela"><tr><th>Dia</th><th>Data</th><th>Horário</th><th>Nome</th></tr>' +
        importItens.map(function (i) {
          var dataFmt = i.data.split('-').reverse().join('/');
          return '<tr><td>' + esc(i.diaTexto) + '</td><td>' + dataFmt + '</td><td><b>' + i.horario + '</b></td><td>' + esc(i.nome) + '</td></tr>';
        }).join('') + '</table>';
    }
    if (ignorados.length) {
      html += '<p style="margin-top:.8rem;font-size:.82rem;color:var(--vermelho);">⚠️ Ignorados (já passou nesta semana):</p>';
      html += '<table class="tabela" style="opacity:.6;"><tr><th>Dia</th><th>Horário</th><th>Nome</th></tr>' +
        ignorados.map(function (i) {
          return '<tr><td>' + esc(i.diaTexto) + '</td><td><b>' + i.horario + '</b></td><td>' + esc(i.nome) + '</td></tr>';
        }).join('') + '</table>';
    }
    $('#importTabela').innerHTML = html;
    $('#importResultadoCard').style.display = 'block';
  };

  $('#importConfirmar').onclick = async function () {
    if (!importItens.length) { toast('Analise primeiro.'); return; }
    var j = await api('/api/admin/importar-agenda', { method: 'POST', body: JSON.stringify({ agendamentos: importItens }) });
    if (j.ok) {
      toast('✅ ' + j.inseridos + ' agendados! ' + (j.conflitos ? '(' + j.conflitos + ' já existiam)' : ''));
      $('#importTexto').value = '';
      $('#importResultadoCard').style.display = 'none';
      importItens = [];
    } else {
      toast(j.error || 'Erro ao importar.');
    }
  };

  /* ---------- Auditoria ---------- */
  async function carregarAuditoria() {
    var tipo = $('#audTipo').value;
    var url = '/api/admin/logs?limite=300' + (tipo ? '&tipo=' + encodeURIComponent(tipo) : '');
    var j = await api(url);
    var logs = j.logs || [];
    $('#audLista').innerHTML = logs.length
      ? '<table class="tabela"><tr><th>Data/Hora</th><th>Tipo</th><th>Ação</th><th>Detalhe</th><th>Usuário</th></tr>' +
        logs.map(function (l) {
          var dt = new Date(l.criado_em);
          var dataFmt = dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR');
          return '<tr><td style="white-space:nowrap;">' + dataFmt + '</td>' +
            '<td><span class="badge badge-alerta">' + esc(l.tipo) + '</span></td>' +
            '<td><b>' + esc(l.acao) + '</b></td>' +
            '<td>' + esc(l.detalhe) + '</td>' +
            '<td class="muted">' + esc(l.usuario) + '</td></tr>';
        }).join('') + '</table>'
      : '<p class="vazio">Nenhum registro de auditoria ainda.</p>';
  }
  $('#audGerar').onclick = carregarAuditoria;
  $('#audTipo').addEventListener('change', carregarAuditoria);

  /* ---------- Config ---------- */
  $('#cfgSalvar').onclick = async function () {
    var atual = $('#cfgAtual').value, nova = $('#cfgNova').value, nova2 = $('#cfgNova2').value;
    if (nova.length < 6) { toast('A nova senha precisa de 6+ caracteres.'); return; }
    if (nova !== nova2) { toast('As senhas não conferem.'); return; }
    var j = await api('/api/admin/trocar-senha', { method: 'POST', body: JSON.stringify({ senhaAtual: atual, novaSenha: nova }) });
    if (j.ok) { toast('Senha alterada com sucesso! 🔒'); $('#cfgAtual').value = ''; $('#cfgNova').value = ''; $('#cfgNova2').value = ''; }
    else toast(j.error || 'Erro ao alterar.');
  };

  /* ---------- MASTER: Gestão de clientes (barbearias) ---------- */
  // Lista todas as barbearias da plataforma e permite ATIVAR/BLOQUEAR/CRIAR.
  async function carregarClientesPlataforma() {
    if (!EU_SOU_MASTER) { toast('Apenas o gestor (master) pode acessar.'); return; }
    var j = await api('/api/master/tenants');
    var t = $('#tblClientesPlataforma');
    var corpo = $('#clientesPlataformaCorpo');
    if (!corpo) return;
    if (!j.ok || !j.tenants || !j.tenants.length) { corpo.innerHTML = '<tr><td colspan="5" class="vazio">Nenhuma barbearia cadastrada ainda.</td></tr>'; return; }
    corpo.innerHTML = j.tenants.map(function (x) {
      var ativo = !!x.ativo;
      return '<tr>' +
        '<td><b>' + esc(x.nome) + '</b><div class="muted">' + esc(x.slug) + '.brbpro.com.br</div></td>' +
        '<td>' + esc(x.cidade || '—') + '</td>' +
        '<td>' + esc(x.plano || 'pro') + '</td>' +
        '<td>' + (ativo ? '<span class="badge badge-entrada">ATIVO</span>' : '<span class="badge badge-saida">BLOQUEADO</span>') + '</td>' +
        '<td class="acao">' +
          (ativo
            ? '<button class="btn btn-ghost btn-sm" data-master-block="' + esc(x.id) + '">🔒 Bloquear</button>'
            : '<button class="btn btn-gold btn-sm" data-master-activate="' + esc(x.id) + '">✅ Ativar</button>') +
          '<button class="btn btn-ghost btn-sm" data-master-custom="' + esc(x.id) + '">🎨 Personalizar</button>' +
          '<button class="btn btn-ghost btn-sm" data-master-plano="' + esc(x.id) + '">⚙️ Plano</button>' +
          '<button class="btn btn-ghost btn-sm" data-master-reset="' + esc(x.id) + '">🔑 Reset senha</button>' +
          '<button class="btn btn-ghost btn-sm" data-master-del="' + esc(x.id) + '">🗑️ Excluir</button>' +
        '</td></tr>';
    }).join('');
    // Ações (delegado)
    corpo.querySelectorAll('[data-master-activate]').forEach(function (b) {
      b.onclick = async function () { await setTenantAtivo(b.getAttribute('data-master-activate'), true); };
    });
    corpo.querySelectorAll('[data-master-block]').forEach(function (b) {
      b.onclick = async function () { await setTenantAtivo(b.getAttribute('data-master-block'), false); };
    });
    corpo.querySelectorAll('[data-master-custom]').forEach(function (b) {
      b.onclick = async function () { await abrirPersonalizacao(b.getAttribute('data-master-custom')); };
    });
    corpo.querySelectorAll('[data-master-plano]').forEach(function (b) {
      b.onclick = async function () {
        var id = b.getAttribute('data-master-plano');
        var plano = prompt('Plano (essencial / pro / premium):', 'pro');
        if (!plano) return;
        if (!['essencial', 'pro', 'premium'].includes(plano)) { toast('Plano inválido.'); return; }
        var r = await api('/api/master/tenants/' + id, { method: 'PUT', body: JSON.stringify({ ativo: true, plano: plano }) });
        toast(r.ok ? 'Plano atualizado!' : (r.error || 'Erro.'));
        carregarClientesPlataforma();
      };
    });
    corpo.querySelectorAll('[data-master-reset]').forEach(function (b) {
      b.onclick = async function () {
        var id = b.getAttribute('data-master-reset');
        // Passo 1: confirma
        if (!confirm('Resetar a senha do administrador deste cliente? Uma nova senha será gerada.')) return;
        var r = await api('/api/master/tenants/' + id + '/reset-senha', { method: 'POST' });
        if (!r.ok) { toast(r.error || 'Não foi possível resetar.'); carregarClientesPlataforma(); return; }
        // Passo 2: modal de escolha (quem recebe + meio)
        var emailOwner = r.email || '';
        var whats = r.whatsapp || '';
        var h = '<h3>🔑 Nova senha gerada para <span style="color:#C9A86A">' + esc(r.nome) + '</span></h3>' +
          '<div class="campo-senha" style="margin-bottom:1rem;">' +
            '<div style="font-size:1.6rem;font-weight:800;color:#C9A86A;letter-spacing:1px;user-select:all;cursor:pointer;" id="senhaGerada">' + esc(r.senha) + '</div>' +
            '<button class="btn btn-ghost btn-sm" style="margin-top:.4rem;" data-copiar-senha>📋 Copiar apenas a senha</button>' +
          '</div>' +
          '<label style="display:block;margin:.4rem 0 .2rem;"><span class="muted" style="font-size:.82rem">Quem recebe (e-mail do admin):</span></label>' +
          '<select id="selDest" style="width:100%;padding:.5rem;">' +
            '<option value="' + esc(emailOwner) + '">' + esc(emailOwner) + ' (' + esc(r.nome) + ')</option>' +
            '<option value="__outro__">✏️ Outro e-mail…</option>' +
          '</select>' +
          '<input id="outroEmail" placeholder="Digite o e-mail de destino" style="width:100%;padding:.5rem;margin-top:.4rem;display:none;" />' +
          '<label style="display:block;margin:.9rem 0 .2rem;"><span class="muted" style="font-size:.82rem">Meio de envio:</span></label>' +
          '<div style="display:flex;gap:.6rem;flex-wrap:wrap;">' +
            '<button class="btn btn-gold" data-enviar-whats>📱 Enviar pelo WhatsApp</button>' +
            '<button class="btn btn-ghost" data-enviar-email>✉️ Abrir e-mail</button>' +
            '<button class="btn btn-ghost" data-copiar-msg>💬 Copiar mensagem</button>' +
          '</div>' +
          '<div style="margin-top:.5rem;text-align:right;"><button class="btn btn-ghost" data-fechar-reset>Fechar</button></div>';
        modal(h);
        var sel = document.querySelector('#selDest');
        var outro = document.querySelector('#outroEmail');
        sel.addEventListener('change', function(){ outro.style.display = (sel.value==='__outro__') ? 'block' : 'none'; });
        function dest(){ return (sel.value==='__outro__') ? (outro.value || emailOwner) : sel.value; }
        function montarMsg(destEmail){
          return 'Olá! ' + r.nome + ',\n\nSua área administrativa da barbearia:\n' + location.origin + '/admin/\nE-mail: ' + destEmail + '\nSenha: ' + r.senha + '\n\nEntre e, se quiser, troque a senha em Configurações.\n— ' + (window.BRB_TENANT&&window.BRB_TENANT.nome||'BRB Pro');
        }
        function copiar(txt){ var done=function(){toast('Copiado! 📋');}; var fail=function(){toast('Selecione e copie.');}; if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(done).catch(fail);} else { try{var ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);done();}catch(e){fail();} } }
        document.querySelector('[data-copiar-senha]').onclick = function(){ copiar(r.senha); };
        document.querySelector('[data-copiar-msg]').onclick = function(){ copiar(montarMsg(dest())); };
        document.querySelector('[data-enviar-whats]').onclick = function(){
          var num = (whats||'').replace(/\D/g,''); if(!num){toast('Cliente sem WhatsApp cadastrado.');return;}
          var msg = encodeURIComponent(montarMsg(dest()));
          window.open('https://wa.me/'+num+'?text='+msg,'_blank');
        };
        document.querySelector('[data-enviar-email]').onclick = function(){
          var d = dest(); var subj=encodeURIComponent('Seus dados de acesso'); var b=encodeURIComponent(montarMsg(d));
          window.location.href='mailto:'+d+'?subject='+subj+'&body='+b;
        };
        document.querySelector('[data-fechar-reset]').onclick = function(){ fecharModal(); };
        toast('Senha resetada!');
        carregarClientesPlataforma();
      };
    });
    corpo.querySelectorAll('[data-master-del]').forEach(function (b) {
      b.onclick = async function () {
        var id = b.getAttribute('data-master-del');
        var nome = (b.closest('tr') || {}).querySelector ? '' : '';
        if (!confirm('⚠️ EXCLUIR este cliente PERMANENTEMENTE?\n\nTodos os dados (site, agenda, clientes, fotos, caixa, estoque) serão apagados.\nEsta ação NÃO pode ser desfeita.')) return;
        if (!confirm('Tem certeza? Digite OK para confirmar. (Isso apaga tudo)')) return;
        var r = await api('/api/master/tenants/' + id, { method: 'DELETE' });
        toast(r.ok ? 'Cliente excluído. 🗑️' : (r.error || 'Erro ao excluir.'));
        carregarClientesPlataforma();
      };
    });
  }

  // Abre o modal de PERSONALIZAÇÃO completa do site do cliente
  async function abrirPersonalizacao(id) {
    var j = await api('/api/master/tenants/' + id);
    if (!j.ok) { toast(j.error || 'Erro ao carregar.'); return; }
    var t = j.tenant || {};
    var h = '<h3>🎨 Personalizar site</h3>' +
      '<div class="form-grid" style="max-height:62vh;overflow:auto;padding-right:6px;">' +
      '<label class="field"><span>Nome / marca</span><input id="pNome" value="' + esc(t.nome||'') + '" /></label>' +
      '<label class="field"><span>WhatsApp (com DDD)</span><input id="pWhats" value="' + esc(t.whatsapp||'') + '" /></label>' +
      '<label class="field"><span>Instagram (@usuario)</span><input id="pInsta" value="' + esc(t.instagram||'') + '" /></label>' +
      '<label class="field"><span>Endereço</span><input id="pEnd" value="' + esc(t.endereco||'') + '" /></label>' +
      '<label class="field"><span>Cidade</span><input id="pCidade" value="' + esc(t.cidade||'') + '" /></label>' +
      '<label class="field"><span>Slogan / frase</span><input id="pSlogan" value="' + esc(t.slogan||'') + '" /></label>' +
      '<label class="field"><span>Título do topo</span><input id="pHeroT" value="' + esc(t.hero_titulo||'') + '" placeholder="Nome da barbearia" /></label>' +
      '<label class="field"><span>Subtítulo do topo</span><input id="pHeroS" value="' + esc(t.hero_sub||'') + '" /></label>' +
      '<label class="field"><span>Texto "sobre"</span><textarea id="pSobre" rows="3">' + esc(t.sobre_texto||'') + '</textarea></label>' +
      '<div style="display:flex;gap:.6rem;flex-wrap:wrap;">' +
        '<label class="field" style="flex:1;min-width:120px;"><span>Cor principal</span><input type="color" id="pCorP" value="' + esc(t.cor_primaria||'#C9A86A') + '" /></label>' +
        '<label class="field" style="flex:1;min-width:120px;"><span>Cor secundária</span><input type="color" id="pCorS" value="' + esc(t.cor_secundaria||'#B08D57') + '" /></label>' +
      '</div>' +
      '<label class="field"><span>Logo (clique p/ enviar)</span><input type="file" id="pLogo" accept="image/*" /></label>' +
      '<label class="field"><span>Imagem de fundo (topo)</span><input type="file" id="pHeroImg" accept="image/*" /></label>' +
      '<label class="field"><span>Vídeo de fundo (opcional, até ~15MB)</span><input type="file" id="pVideo" accept="video/*" /></label>' +
      '<label class="field"><span>Vídeo de introdução (até ~20MB)</span><input type="file" id="pIntro" accept="video/*" /></label>' +
      '</div>' +
      '<div style="margin-top:1rem;display:flex;gap:.6rem;justify-content:flex-end;">' +
        '<button class="btn btn-ghost" data-custom-cancel>Cancelar</button>' +
        '<button class="btn btn-gold" data-custom-save>💾 Salvar e publicar</button>' +
      '</div>';
    modal(h);
    document.querySelector('[data-custom-cancel]').onclick = function(){ fecharModal(); };
    document.querySelector('[data-custom-save]').onclick = async function () {
      var body = { nome: val('#pNome'), whatsapp: val('#pWhats'), instagram: val('#pInsta'), endereco: val('#pEnd'), cidade: val('#pCidade'), slogan: val('#pSlogan'), hero_titulo: val('#pHeroT'), hero_sub: val('#pHeroS'), sobre_texto: val('#pSobre'), cor_primaria: val('#pCorP'), cor_secundaria: val('#pCorS'), tema: 'dark' };
      toast('Enviando e publicando...');
      try {
        body.logo = await lerArquivo('#pLogo', 250000);       // comprimido p/ ~600px, ~180KB
        body.hero_imagem = await lerArquivo('#pHeroImg', 1500000); // comprimido p/ ~1600px
        body.video_hero = await lerArquivo('#pVideo', 15000000);   // vídeos até ~15MB
        body.intro_video = await lerArquivo('#pIntro', 20000000);  // vídeo de intro até ~20MB
      } catch (e) { toast(e.message); return; }
      var r = await api('/api/master/tenants/' + id + '/personalizar', { method: 'PUT', body: JSON.stringify(body) });
      if (r.ok) { toast('Site personalizado e publicado! ✅'); fecharModal(); }
      else toast(r.error || 'Erro ao salvar.');
    };
    // helpers locais
    function val(sel){ var e=document.querySelector(sel); return e ? e.value : ''; }
    function lerArquivo(sel, max){
      return new Promise(function(res, rej){
        var e=document.querySelector(sel);
        if (!e || !e.files || !e.files[0]) return res(undefined);
        var f=e.files[0];
        // Se for imagem: lê como data URL (permitido pela CSP) e comprime/redimensiona
        if (/^image\//.test(f.type)) {
          var fr=new FileReader();
          fr.onload=function(){
            var dataUrl=fr.result;
            var img=new Image();
            img.onload=function(){
              try {
                var maxDim = (sel === '#pHeroImg' || sel === '#pHeroImg') ? 1600 : 600;
                var scale=Math.min(1, maxDim/Math.max(img.width, img.height));
                var cw=Math.round(img.width*scale), ch=Math.round(img.height*scale);
                var cv=document.createElement('canvas'); cv.width=cw; cv.height=ch;
                var cx=cv.getContext('2d');
                // fundo claro para PNG transparente não virar preto no JPEG
                cx.fillStyle='#ffffff'; cx.fillRect(0,0,cw,ch);
                cx.drawImage(img,0,0,cw,ch);
                var out=cv.toDataURL('image/jpeg',0.82);
                if (out.length > max) { out=cv.toDataURL('image/jpeg',0.55); }
                res(out);
              } catch (e2) { rej(new Error('Não foi possível processar a imagem.')); }
            };
            img.onerror=function(){ rej(new Error('Não foi possível ler a imagem. Use um arquivo JPG ou PNG comum.')); };
            img.src=dataUrl;
          };
          fr.onerror=function(){ rej(new Error('Erro ao ler o arquivo.')); };
          fr.readAsDataURL(f);
          return;
        }
        // Vídeo: valida tamanho e lê como base64
        if (f.size > max) return rej(new Error('Vídeo muito grande (máx ' + Math.round(max/1024/1024) + 'MB). Comprima-o ou use um mais curto.'));
        var frv=new FileReader();
        frv.onload=function(){ res(frv.result); };
        frv.onerror=function(){ rej(new Error('Erro ao ler o arquivo.')); };
        frv.readAsDataURL(f);
      });
    }
  }
  async function setTenantAtivo(id, ativo) {
    if (!EU_SOU_MASTER) return;
    var ok = confirm(ativo ? 'Autorizar/ativar esta barbearia?' : 'BLOQUEAR esta barbearia? O site dela sairá do ar.');
    if (!ok) return;
    var r = await api('/api/master/tenants/' + id, { method: 'PUT', body: JSON.stringify({ ativo: ativo, plano: 'pro' }) });
    toast(r.ok ? (ativo ? 'Barbearia ativada! ✅' : 'Barbearia bloqueada! 🔒') : (r.error || 'Erro.'));
    carregarClientesPlataforma();
  }
  // Criar nova barbearia (master) — com personalização inicial
  var btnCriar = $('#btnCriarClientePlataforma');
  if (btnCriar) btnCriar.onclick = async function () {
    var h = '<h3>➕ Nova barbearia</h3><div class="form-grid">' +
      '<label class="field"><span>Slug (endereço final)*</span><input id="cSlug" placeholder="joao" /></label>' +
      '<label class="field"><span>Nome / marca*</span><input id="cNome" placeholder="Barbearia do João" /></label>' +
      '<label class="field"><span>WhatsApp (com DDD)</span><input id="cWhats" placeholder="31999998888" /></label>' +
      '<label class="field"><span>Cidade</span><input id="cCidade" placeholder="Ouro Preto" /></label>' +
      '<label class="field"><span>Slogan (frase do topo)</span><input id="cSlogan" placeholder="Estilo que define você" /></label>' +
      '<label class="field"><span>Cor principal</span><input type="color" id="cCor" value="#C9A86A" /></label>' +
      '<label class="field"><span>Plano</span><select id="cPlano"><option value="pro">pro</option><option value="essencial">essencial</option><option value="premium">premium</option></select></label>' +
      '</div>' +
      '<div style="margin-top:1rem;display:flex;gap:.6rem;justify-content:flex-end;">' +
        '<button class="btn btn-ghost" data-criar-cancel>Cancelar</button>' +
        '<button class="btn btn-gold" data-criar-go>Criar barbearia</button></div>';
    modal(h);
    document.querySelector('[data-criar-cancel]').onclick = function(){ fecharModal(); };
    document.querySelector('[data-criar-go]').onclick = async function () {
      var slug = (document.querySelector('#cSlug').value||'').trim().toLowerCase().replace(/[^a-z0-9-]/g,'');
      var nome = (document.querySelector('#cNome').value||'').trim();
      if (!slug) { toast('Informe o slug.'); return; }
      if (!nome) { toast('Informe o nome.'); return; }
      var whatsapp = (document.querySelector('#cWhats').value||'').replace(/\D/g,'');
      var cidade = (document.querySelector('#cCidade').value||'').trim();
      var slogan = (document.querySelector('#cSlogan').value||'').trim();
      var cor = (document.querySelector('#cCor').value||'#C9A86A');
      var plano = (document.querySelector('#cPlano').value||'pro');
      var r = await api('/api/master/tenants', { method: 'POST', body: JSON.stringify({ slug: slug, nome: nome, whatsapp: whatsapp, cidade: cidade, plano: plano }) });
      if (r.ok) {
        // já aplica slogan e cor na criação
        await api('/api/master/tenants/' + r.id + '/personalizar', { method: 'PUT', body: JSON.stringify({ slogan: slogan, cor_primaria: cor, cor_secundaria: cor }) });
        toast('Barbearia "' + nome + '" criada! Agora clique em 🎨 Personalizar para logo/fotos. ✅');
        fecharModal();
        carregarClientesPlataforma();
      } else toast(r.error || 'Erro.');
    };
  };

  /* ---------- Init ---------- */
  carregarDashboard();
  // Pré-carrega serviços e clientes (para Editar/Agendar abrirem na hora)
  try { garantirServicos(); garantirClientes(); } catch (_) {}
  // Prelo, se master, carrega a lista de clientes da plataforma
  if (EU_SOU_MASTER) carregarClientesPlataforma();
})();
