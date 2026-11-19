// Porteiro da Margem Segura (Cloudflare Pages Functions).
// Libera o app só para quem comprou na Hotmart.
//
// Configuração no painel do Cloudflare (projeto Pages → Configurações):
//   Ligação KV:  ACESSOS         → lista de e-mails liberados e códigos de acesso
//   Segredos:    HOTTOK          → token "Hottok" do webhook da Hotmart
//                SESSION_SECRET  → frase longa e aleatória (assina o "lembrar aparelho")
//                RESEND_KEY      → chave da API do Resend (envio do código por e-mail)
//   Variáveis:   MAIL_FROM       → ex.: Margem Segura <acesso@margemsegura.app.br>
//                PRODUTO_ID      → (opcional) ID do produto na Hotmart; ignora outros produtos
//
// Na lista ACESSOS, cada comprador é uma chave "email:fulano@exemplo.com".
// Para liberar alguém à mão, crie essa chave com qualquer valor.

const LIVRES = [
  /^\/demo(\/.*)?$/,
  /^\/entrar(\.html)?$/,
  /^\/(icon-192|icon-512|apple-touch-icon)\.png$/,
  /^\/manifest\.webmanifest$/,
  /^\/favicon\.ico$/,
  /^\/robots\.txt$/,
];
const UM_ANO = 365 * 24 * 3600;
const COOKIE = 'ms_sess';

export async function onRequest(ctx) {
  const { request, env, next } = ctx;
  const url = new URL(request.url);
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    try {
      if (p === '/api/hotmart') return await hotmart(request, env);
      if (p === '/api/codigo') return await enviarCodigo(request, env);
      if (p === '/api/entrar') return await entrar(request, env);
      if (p === '/api/sair') return sair(url);
      return new Response('Não encontrado', { status: 404 });
    } catch (e) {
      return json({ ok: false, msg: 'Erro no servidor. Tente de novo em instantes.' }, 500);
    }
  }
  if (p.startsWith('/functions/') || p.startsWith('/.')) return new Response('Não encontrado', { status: 404 });
  if (LIVRES.some((r) => r.test(p))) return next();

  let email = null;
  try { email = await sessao(request, env); } catch (e) { email = null; }
  if (email) return next();

  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Acesso restrito', { status: 401 });
  const volta = p !== '/' && p !== '/index.html' ? '?volta=' + encodeURIComponent(p + url.search) : '';
  return new Response(null, { status: 302, headers: { Location: '/entrar' + volta, 'Cache-Control': 'no-store' } });
}

/* ---------- webhook da Hotmart ---------- */
const LIBERA = ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE', 'APPROVED', 'COMPLETE', 'COMPLETED'];
const BLOQUEIA = ['PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'PURCHASE_CANCELED', 'REFUNDED', 'CHARGEBACK', 'CANCELED', 'CANCELLED'];

async function hotmart(request, env) {
  if (request.method !== 'POST') return new Response('Webhook da Margem Segura ativo.', { status: 200 });
  const raw = await request.text();
  const tipo = request.headers.get('content-type') || '';
  let body = {};
  if (tipo.includes('json') || raw.trim().startsWith('{')) { try { body = JSON.parse(raw); } catch (e) { body = {}; } }
  else body = Object.fromEntries(new URLSearchParams(raw));

  const tok = request.headers.get('x-hotmart-hottok') || body.hottok || '';
  if (!env.HOTTOK || !(await iguais(String(tok), String(env.HOTTOK)))) return json({ ok: false, msg: 'token inválido' }, 401);

  const d = body.data || {};
  const evento = String(body.event || '').toUpperCase();
  const status = String((d.purchase && d.purchase.status) || body.status || '').toUpperCase();
  const email = normEmail((d.buyer && d.buyer.email) || body.email || '');
  if (!email) return json({ ok: true, ignorado: 'sem e-mail' });

  if (env.PRODUTO_ID) {
    const pid = String((d.product && d.product.id) || body.prod || '');
    if (pid && pid !== String(env.PRODUTO_ID)) return json({ ok: true, ignorado: 'outro produto' });
  }

  const quem = evento || status;
  if (LIBERA.includes(quem)) {
    await env.ACESSOS.put('email:' + email, JSON.stringify({ origem: 'hotmart', evento: quem, em: new Date().toISOString() }));
    return json({ ok: true, acao: 'liberado' });
  }
  if (BLOQUEIA.includes(quem)) {
    await env.ACESSOS.delete('email:' + email);
    return json({ ok: true, acao: 'bloqueado' });
  }
  return json({ ok: true, ignorado: quem || 'sem evento' });
}

/* ---------- envio do código ---------- */
async function enviarCodigo(request, env) {
  if (request.method !== 'POST') return json({ ok: false }, 405);
  const b = await request.json().catch(() => ({}));
  const email = normEmail(b.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, msg: 'Digite um e-mail válido.' }, 400);

  if (!(await env.ACESSOS.get('email:' + email))) {
    return json({ ok: false, msg: 'Não encontramos uma compra com este e-mail. Use o mesmo e-mail da compra na Hotmart.' }, 404);
  }
  const lk = 'lim:' + email;
  const n = Number(await env.ACESSOS.get(lk)) || 0;
  if (n >= 5) return json({ ok: false, msg: 'Muitos códigos pedidos. Espere 1 hora e tente de novo.' }, 429);
  await env.ACESSOS.put(lk, String(n + 1), { expirationTtl: 3600 });

  const codigo = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  await env.ACESSOS.put('cod:' + email, JSON.stringify({ c: codigo, t: 0 }), { expirationTtl: 900 });

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Margem Segura <acesso@margemsegura.app.br>',
      to: [email],
      subject: 'Seu código de acesso: ' + codigo,
      text: 'Seu código de acesso à Margem Segura é ' + codigo + '.\n\nEle vale por 15 minutos. Se não foi você que pediu, ignore este e-mail.',
      html: '<div style="font-family:Arial,sans-serif;font-size:16px;color:#142019">' +
        '<p>Seu código de acesso à <b>Margem Segura</b>:</p>' +
        '<p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#1D6B47">' + codigo + '</p>' +
        '<p>Ele vale por 15 minutos. Se não foi você que pediu, ignore este e-mail.</p></div>',
    }),
  });
  if (!r.ok) return json({ ok: false, msg: 'Não consegui enviar o e-mail agora. Tente de novo em instantes.' }, 502);
  return json({ ok: true });
}

/* ---------- conferir o código e lembrar o aparelho ---------- */
async function entrar(request, env) {
  if (request.method !== 'POST') return json({ ok: false }, 405);
  const b = await request.json().catch(() => ({}));
  const email = normEmail(b.email);
  const k = 'cod:' + email;
  let reg = null;
  try { reg = JSON.parse((await env.ACESSOS.get(k)) || 'null'); } catch (e) { reg = null; }
  if (!reg) return json({ ok: false, msg: 'O código expirou. Peça um novo.' }, 400);

  if (String(b.codigo || '').replace(/\D/g, '') !== reg.c) {
    reg.t = (reg.t || 0) + 1;
    if (reg.t >= 5) {
      await env.ACESSOS.delete(k);
      return json({ ok: false, msg: 'Muitas tentativas erradas. Peça um novo código.' }, 400);
    }
    await env.ACESSOS.put(k, JSON.stringify(reg), { expirationTtl: 900 });
    return json({ ok: false, msg: 'Código incorreto. Confira o e-mail e tente de novo.' }, 400);
  }
  await env.ACESSOS.delete(k);
  if (!(await env.ACESSOS.get('email:' + email))) return json({ ok: false, msg: 'Este e-mail não está mais liberado.' }, 403);

  const exp = Math.floor(Date.now() / 1000) + UM_ANO;
  const tok = await assinar(email, exp, env);
  return json({ ok: true }, 200, {
    'Set-Cookie': COOKIE + '=' + tok + '; Path=/; Max-Age=' + UM_ANO + '; HttpOnly; Secure; SameSite=Lax',
  });
}

function sair(url) {
  return new Response(null, {
    status: 302,
    headers: { Location: url.origin + '/entrar', 'Set-Cookie': COOKIE + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' },
  });
}

/* ---------- sessão assinada ---------- */
async function sessao(request, env) {
  const ck = request.headers.get('cookie') || '';
  const m = ck.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return null;
  const partes = m[1].split('.');
  if (partes.length !== 3) return null;
  const [e64, exp, sig] = partes;
  if (!(Number(exp) > Date.now() / 1000)) return null;
  const email = dec64(e64);
  const certo = await hmac(email + '|' + exp, env);
  if (!(await iguais(sig, certo))) return null;
  if (!(await env.ACESSOS.get('email:' + email))) return null; // reembolso ou chargeback tira o acesso
  return email;
}
async function assinar(email, exp, env) {
  return enc64(email) + '.' + exp + '.' + (await hmac(email + '|' + exp, env));
}
async function hmac(txt, env) {
  if (!env.SESSION_SECRET || String(env.SESSION_SECRET).length < 16) throw new Error('SESSION_SECRET ausente');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(txt));
  return b64url(new Uint8Array(s));
}
async function iguais(a, b) {
  const h = async (x) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)));
  const [x, y] = [await h(a), await h(b)];
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/* ---------- utilidades ---------- */
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function b64url(bytes) { let s = ''; bytes.forEach((b) => (s += String.fromCharCode(b))); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function enc64(txt) { return b64url(new TextEncoder().encode(txt)); }
function dec64(s) {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch (e) { return ''; }
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra) });
}
