/**
 * BRB Pro — Auth com Cookie HttpOnly (substitui localStorage)
 * 
 * Por que trocar:
 *  - localStorage = XSS rouba token com 1 linha de JS
 *  - Cookie HttpOnly = JS não lê, só servidor lê
 * 
 * Stack: Node + Express + jsonwebtoken + bcrypt
 * npm i jsonwebtoken bcrypt cookie-parser express-rate-limit
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');

const JWT_SECRET = process.env.JWT_SECRET || 'troque-esta-chave-em-producao-com-32-chars';
const JWT_EXPIRES = '15m';
const REFRESH_EXPIRES = '7d';

// Rate limit no login: 5 tentativas / 15 min / IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { ok: false, error: 'Muitas tentativas. Tente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function signToken(payload, expiresIn = JWT_EXPIRES) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

function setAuthCookies(res, user) {
  const token = signToken({ id: user.id, tenantId: user.tenant_id, role: user.role, email: user.email });
  const refresh = signToken({ id: user.id, type: 'refresh' }, REFRESH_EXPIRES);

  // Token curto — HttpOnly, Secure, SameSite=Lax
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('brb_token', token, {
    httpOnly: true,
    secure: isProd, // em dev http://localhost sem secure
    sameSite: 'lax',
    path: '/',
    maxAge: 15 * 60 * 1000, // 15 min
  });

  res.cookie('brb_refresh', refresh, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
  });

  return token;
}

function clearAuthCookies(res) {
  res.clearCookie('brb_token', { path: '/' });
  res.clearCookie('brb_refresh', { path: '/' });
}

// Middleware que lê cookie e injeta req.user
function requireAuth(req, res, next) {
  const token = req.cookies['brb_token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Não autorizado. Faça login novamente.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    // Tenta refresh silencioso
    const refresh = req.cookies['brb_refresh'];
    if (!refresh) return res.status(401).json({ ok: false, error: 'Sessão expirada. Faça login novamente.' });
    try {
      const r = jwt.verify(refresh, JWT_SECRET);
      if (r.type !== 'refresh') throw new Error('invalid refresh');
      // Reemite token (busque user no DB para pegar tenant/role atual)
      // const user = await db.query('SELECT * FROM users WHERE id=$1', [r.id])
      // const newToken = setAuthCookies(res, user.rows[0])
      // req.user = jwt.verify(newToken, JWT_SECRET)
      // next()
      return res.status(401).json({ ok: false, error: 'Sessão expirada. Faça login novamente.' });
    } catch {
      return res.status(401).json({ ok: false, error: 'Sessão expirada. Faça login novamente.' });
    }
  }
}

// Rota de login — substitui /api/admin/login antigo
// POST /api/admin/login { email, senha }  (ou { senha } para compatibilidade temporária)
async function handleLogin(req, res, db) {
  const { email, senha } = req.body;
  
  // Compatibilidade: se mandou só senha (fluxo antigo), busca usuário padrão do tenant
  let user;
  if (email) {
    const { rows } = await db.query('SELECT * FROM users WHERE email=$1 AND tenant_id=$2', [email, req.tenantId || 'artnaregua']);
    user = rows[0];
  } else if (senha) {
    // TEMP: mantém senha única até migrar todos
    // Em produção, remova este bloco e exija email+senha
    if (senha !== process.env.ADMIN_SENHA) return res.status(401).json({ ok: false, error: 'Senha incorreta.' });
    user = { id: 'legacy', tenant_id: req.tenantId || 'artnaregua', role: 'owner', email: 'legacy@brbpro.com.br' };
  }

  if (!user) return res.status(401).json({ ok: false, error: 'Usuário não encontrado.' });
  if (user.senha_hash) {
    const ok = await bcrypt.compare(senha, user.senha_hash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Senha incorreta.' });
  }

  setAuthCookies(res, user);
  res.json({ ok: true, nome: user.nome || user.email, tenant: user.tenant_id });
}

module.exports = { loginLimiter, requireAuth, setAuthCookies, clearAuthCookies, handleLogin };

/**
 * INTEGRAÇÃO:
 * 
 * const { loginLimiter, requireAuth, handleLogin } = require('./auth-cookie');
 * const { tenantResolver } = require('./tenant');
 * 
 * app.post('/api/admin/login', tenantResolver, loginLimiter, (req,res)=> handleLogin(req,res, db));
 * app.post('/api/admin/logout', (req,res)=> { clearAuthCookies(res); res.json({ok:true}) });
 * app.get('/api/admin/me', requireAuth, (req,res)=> res.json({ ok:true, user: req.user }));
 * app.use('/api/admin', requireAuth, adminRoutes);
 * 
 * FRONT: remova localStorage.setItem('art_token', ...) e use fetch com credentials:
 * 
 * // antes:
 * localStorage.setItem('art_token', j.token)
 * fetch('/api/admin/me', { headers: { Authorization: 'Bearer '+token } })
 * 
 * // depois:
 * fetch('/api/admin/login', { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email, senha}) })
 * fetch('/api/admin/me', { credentials:'include' })
 * 
 * // logout:
 * fetch('/api/admin/logout', { method:'POST', credentials:'include' })
 */
