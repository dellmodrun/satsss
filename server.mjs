import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4326);
const origin = 'https://zatoshi-model.com';
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function safeFile(pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
  let candidate = resolve(root, clean || 'index.html');
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  if (existsSync(candidate) && statSync(candidate).isDirectory()) candidate = join(candidate, 'index.html');
  if (!existsSync(candidate) && !extname(candidate)) candidate = join(candidate, 'index.html');
  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
}

async function proxyPublicApi(request, response, url) {
  try {
    if (url.pathname === '/api/public/price') {
      const mint = url.searchParams.get('mint');
      if (!mint) throw new Error('mint is required');
      const marketUrl = `${origin}/api/public/birdeye?endpoint=overview&mint=${encodeURIComponent(mint)}`;
      const marketResponse = await fetch(marketUrl, { headers: { accept: 'application/json' } });
      const market = await marketResponse.json();
      const data = market?.data;
      if (!marketResponse.ok || !data || !Number.isFinite(Number(data.price))) {
        throw new Error(market?.message || 'market overview unavailable');
      }
      const payload = Buffer.from(JSON.stringify({
        mint,
        price: Number(data.price),
        supply: Number(data.circulatingSupply ?? data.totalSupply),
        decimals: Number(data.decimals),
        symbol: data.symbol || null,
        name: data.name || null,
        // The mirrored UI expects a slot-like chain status value. The public
        // market endpoint confirms the token data but does not expose an RPC
        // slot, so report that confirmation instead of rendering "undefined".
        slot: 'confirmed',
        source: 'birdeye overview fallback',
      }));
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': payload.length,
      });
      return response.end(payload);
    }
    const upstream = await fetch(origin + url.pathname + url.search, {
      headers: { accept: request.headers.accept || 'application/json' },
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    response.end(body);
  } catch (error) {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: `upstream unavailable: ${error.message}` }));
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);
  if (url.pathname.startsWith('/api/public/')) return proxyPublicApi(request, response, url);
  if (url.pathname === '/~flock.js' || url.pathname.startsWith('/__l5e/events.')) {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    return response.end('/* analytics disabled in local preview */');
  }
  const file = safeFile(url.pathname);
  if (!file) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end('Not found');
  }
  response.writeHead(200, {
    'content-type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') return response.end();
  if (extname(file).toLowerCase() === '.html') {
    const html = readFileSync(file, 'utf8').replace('</head>', '<script src="/local-mint.js"></script></head>');
    return response.end(html);
  }
  createReadStream(file).pipe(response);
}).listen(port, host, () => {
  console.log(`zatoshi local frontend: http://${host}:${port}/`);
});
