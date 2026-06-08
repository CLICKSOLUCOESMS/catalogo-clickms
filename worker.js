/*
 * Cloudflare Worker para o catálogo Click Soluções.
 *
 * Faz duas coisas:
 *   1. Serve a foto de um aparelho específico em /foto/{deviceId}[/{index}]
 *      (decodifica base64 do catalogo.json e devolve como imagem real)
 *   2. Quando catalogo.html é aberto com ?aparelho=ID, reescreve as meta tags
 *      Open Graph (og:image, og:title, og:description) — assim WhatsApp,
 *      Instagram, Facebook etc. mostram a foto + nome + preço do aparelho
 *      em vez da logo genérica.
 *
 * Importante: para evitar parsear o JSON inteiro (que pode ter ~10MB com
 * fotos em base64), fazemos uma busca textual pelo ID do aparelho e
 * extraímos só o objeto daquele dispositivo via brace-matching.
 */

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1) Endpoint de foto: /foto/{deviceId} ou /foto/{deviceId}/{index}
    if (url.pathname.startsWith('/foto/')) {
      return servePhoto(url, env);
    }

    // Para todo o resto: delega aos arquivos estáticos
    const assetResponse = await env.ASSETS.fetch(request);

    // 2) Reescreve meta tags só quando catalogo.html (ou raiz) é aberto com ?aparelho=ID
    const aparelhoId = url.searchParams.get('aparelho');
    if (!aparelhoId) return assetResponse;

    const isHtml = (assetResponse.headers.get('content-type') || '').includes('text/html');
    if (!isHtml) return assetResponse;

    const product = await findProduct(env, url.origin, aparelhoId);
    if (!product) return assetResponse;

    return rewriteHtml(assetResponse, product, url, aparelhoId);
  }
};

/* -------- HTML rewriter: troca og:title, og:description, og:image -------- */

function rewriteHtml(response, product, url, aparelhoId) {
  const priceFmt = Number(product.price || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const titleParts = [product.model, product.storage, product.color]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = (titleParts || 'Aparelho') + ' — Click Soluções';

  const descParts = [];
  if (priceFmt !== '0,00') descParts.push(`R$ ${priceFmt} à vista`);
  if (product.battery) descParts.push(`Bateria ${product.battery}%`);
  if (product.warranty) descParts.push(`Garantia ${product.warranty}`);
  const description = descParts.join(' · ') || 'Aparelho semi-novo revisado.';

  // URL da foto servida pelo próprio worker (endpoint /foto/{id})
  const imageUrl = `${url.origin}/foto/${encodeURIComponent(aparelhoId)}`;
  const canonical = url.toString();

  const set = (attr, value) => ({
    element(el) { el.setAttribute(attr, value); },
  });

  return new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', set('content', description))
    .on('meta[property="og:type"]', set('content', 'product'))
    .on('meta[property="og:title"]', set('content', title))
    .on('meta[property="og:description"]', set('content', description))
    .on('meta[property="og:image"]', set('content', imageUrl))
    .on('meta[property="og:url"]', set('content', canonical))
    .on('meta[name="twitter:card"]', set('content', 'summary_large_image'))
    .on('meta[name="twitter:title"]', set('content', title))
    .on('meta[name="twitter:description"]', set('content', description))
    .on('meta[name="twitter:image"]', set('content', imageUrl))
    .transform(response);
}

/* -------- Endpoint /foto/{id}[/{index}] -------- */

async function servePhoto(url, env) {
  const parts = url.pathname.split('/').filter(Boolean); // ['foto', id, index?]
  const deviceId = parts[1] ? decodeURIComponent(parts[1]) : '';
  const index = parts[2] ? Math.max(0, parseInt(parts[2], 10) || 0) : 0;
  if (!deviceId) return new Response('Bad request', { status: 400 });

  const product = await findProduct(env, url.origin, deviceId);
  if (!product) {
    return fallbackToLogo(url, env);
  }

  const photos = Array.isArray(product.photos) ? product.photos.filter(Boolean) : [];
  if (photos.length === 0) {
    return fallbackToLogo(url, env);
  }

  const photo = photos[Math.min(index, photos.length - 1)] || photos[0];

  // URL externa → redireciona
  if (!photo.startsWith('data:')) {
    return Response.redirect(photo, 302);
  }

  // data:image/...;base64,XXX → decodifica e devolve como imagem
  const m = photo.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return fallbackToLogo(url, env);

  let mime = m[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) mime = 'image/jpeg';
  const b64 = m[2];

  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, {
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}

async function fallbackToLogo(url, env) {
  // Última opção: serve a logo da loja
  const logoReq = new Request(`${url.origin}/logo.png`);
  return env.ASSETS.fetch(logoReq);
}

/* -------- Busca eficiente do produto no catalogo.json -------- */

async function findProduct(env, origin, deviceId) {
  try {
    const res = await env.ASSETS.fetch(new Request(`${origin}/catalogo.json`));
    if (!res.ok) return null;
    const text = await res.text();
    return findProductInText(text, deviceId);
  } catch (e) {
    return null;
  }
}

/* Procura o objeto JSON com "id":"X" usando text search + brace matching.
   Assim evitamos JSON.parse no catálogo inteiro (que pode ter dezenas de MB
   com fotos em base64) — parseamos apenas o objeto do dispositivo encontrado. */
function findProductInText(text, deviceId) {
  // Escapa para casar com "id":"<deviceId>"
  const safeId = deviceId.replace(/[\\"]/g, m => '\\' + m);
  const needle = `"id":"${safeId}"`;
  const idx = text.indexOf(needle);
  if (idx === -1) return null;

  // Anda pra trás até encontrar a abertura '{' do objeto que contém esse id
  let start = idx;
  while (start >= 0 && text[start] !== '{') start--;
  if (start < 0) return null;

  // Anda pra frente equilibrando { } e respeitando strings JSON
  let depth = 0;
  let i = start;
  let inStr = false;
  let escaped = false;
  while (i < text.length) {
    const c = text[i];
    if (escaped) {
      escaped = false;
    } else if (inStr) {
      if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
    i++;
  }
  return null;
}
