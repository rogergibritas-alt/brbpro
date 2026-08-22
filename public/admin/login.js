/* Painel BRB Pro — login (arquivo externo para CSP sem 'unsafe-inline') */
(function () {
  var form = document.getElementById('formLogin');
  var msg = document.getElementById('msg');
  if (!form) return;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    msg.textContent = 'Entrando...';
    msg.className = 'msg';
    try {
      var r = await fetch('/api/admin/login', {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email.value.trim(), senha: form.senha.value })
      });
      var j = await r.json();
      if (j.ok) {
        window.location.href = '/admin/';
      } else {
        msg.textContent = j.error || 'Erro ao entrar.';
        msg.className = 'msg erro';
      }
    } catch (err) {
      msg.textContent = 'Erro de conexão. Tente novamente.';
      msg.className = 'msg erro';
    }
  });
})();
