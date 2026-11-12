const nativeFetch = window.fetch.bind(window);
const rpcUrl = "https://solana.publicnode.com";
const geckoBase = "https://api.geckoterminal.com/api/v2";
const dexBase = "https://api.dexscreener.com/latest/dex/tokens";
const cache = new Map();

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function cached(key, ttl, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttl) return hit.value;
  const value = await loader();
  cache.set(key, { time: Date.now(), value });
  return value;
}

async function rpc(method, params) {
  const response = await nativeFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message || `RPC ${response.status}`);
  return body.result;
}

async function batchRpc(requests) {
  const response = await nativeFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requests.map((request, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: request.method,
      params: request.params,
    }))),
  });
  const body = await response.json();
  if (!response.ok || !Array.isArray(body)) throw new Error(`RPC batch ${response.status}`);
  return body.sort((a, b) => a.id - b.id).map(item => item.result ?? null);
}

async function market(mint) {
  return cached(`market:${mint}`, 15_000, async () => {
    const response = await nativeFetch(`${dexBase}/${encodeURIComponent(mint)}`);
    const body = await response.json();
    const pairs = (body.pairs || []).filter(pair => pair.chainId === "solana");
    pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    if (!pairs.length) throw new Error("No Solana market found");
    return pairs[0];
  });
}

async function pricePayload(mint) {
  const pair = await market(mint);
  const price = Number(pair.priceUsd);
  const valuation = Number(pair.marketCap || pair.fdv || 0);
  return {
    mint,
    price,
    supply: price > 0 ? valuation / price : 0,
    decimals: 6,
    symbol: pair.baseToken?.symbol || null,
    name: pair.baseToken?.name || null,
    slot: "confirmed",
    source: "DexScreener + Solana RPC",
  };
}

async function recentFills(mint) {
  const pair = await market(mint);
  const signatures = await rpc("getSignaturesForAddress", [pair.pairAddress, {
    limit: 20,
    commitment: "confirmed",
  }]);
  const transactions = [];
  for (const item of signatures) {
    try {
      transactions.push(await rpc("getTransaction", [item.signature, {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 1,
      }]));
    } catch {
      transactions.push(null);
    }
  }
  const items = [];
  transactions.forEach((transaction, index) => {
    if (!transaction?.meta || transaction.meta.err) return;
    const pre = new Map();
    const post = new Map();
    for (const balance of transaction.meta.preTokenBalances || []) {
      if (balance.mint === mint) pre.set(balance.accountIndex, balance);
    }
    for (const balance of transaction.meta.postTokenBalances || []) {
      if (balance.mint === mint) post.set(balance.accountIndex, balance);
    }
    const signerKeys = new Set((transaction.transaction?.message?.accountKeys || [])
      .filter(key => key?.signer)
      .map(key => String(key.pubkey)));
    const candidates = [];
    for (const accountIndex of new Set([...pre.keys(), ...post.keys()])) {
      const before = Number(pre.get(accountIndex)?.uiTokenAmount?.uiAmountString || 0);
      const after = Number(post.get(accountIndex)?.uiTokenAmount?.uiAmountString || 0);
      const delta = after - before;
      if (!Number.isFinite(delta) || delta === 0) continue;
      const owner = post.get(accountIndex)?.owner || pre.get(accountIndex)?.owner || "";
      candidates.push({ delta, owner });
    }
    const selected = candidates.find(candidate => signerKeys.has(candidate.owner))
      || candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
    if (!selected) return;
    items.push({
      txHash: signatures[index].signature,
      blockUnixTime: transaction.blockTime || signatures[index].blockTime,
      side: selected.delta > 0 ? "buy" : "sell",
      owner: selected.owner,
      from: {},
      to: { address: mint, uiAmount: Math.abs(selected.delta), price: Number(pair.priceUsd) },
    });
  });
  return { data: { items } };
}

async function minuteCandles(mint) {
  const pair = await market(mint);
  const response = await nativeFetch(
    `${geckoBase}/networks/solana/pools/${encodeURIComponent(pair.pairAddress)}/ohlcv/minute?aggregate=1&limit=100&currency=usd&token=base`,
  );
  const body = await response.json();
  if (!response.ok) throw new Error(`OHLCV ${response.status}`);
  const list = body?.data?.attributes?.ohlcv_list || [];
  return { data: { items: list.map(row => ({ unixTime: row[0], c: row[4] })) } };
}

async function holders(mint) {
  return { data: { items: [] } };
}

async function marketEndpoint(endpoint, mint) {
  const pair = await market(mint);
  if (endpoint === "txs") return recentFills(mint);
  if (endpoint === "ohlcv") return minuteCandles(mint);
  if (endpoint === "holders") return holders(mint);
  if (endpoint === "overview") return { data: {
    holder: null,
    liquidity: Number(pair.liquidity?.usd || 0),
    v24hUSD: Number(pair.volume?.h24 || 0),
    trade24h: Number(pair.txns?.h24?.buys || 0) + Number(pair.txns?.h24?.sells || 0),
  } };
  throw new Error(`Unsupported market endpoint: ${endpoint}`);
}

async function bitcoinTip() {
  const heightResponse = await nativeFetch("https://mempool.space/api/blocks/tip/height");
  const height = Number(await heightResponse.text());
  const hashResponse = await nativeFetch(`https://mempool.space/api/block-height/${height}`);
  return { height, hash: await hashResponse.text(), chainwork: null };
}

window.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url || "";
  const url = new URL(raw, window.location.href);
  try {
    if (url.pathname === "/api/public/price") return json(await pricePayload(url.searchParams.get("mint")));
    if (url.pathname === "/api/public/birdeye") {
      return json(await marketEndpoint(url.searchParams.get("endpoint"), url.searchParams.get("mint")));
    }
    if (url.pathname === "/api/public/bitcoin") return json(await bitcoinTip());
  } catch (error) {
    console.warn("public data adapter", error);
    return json({ error: error.message }, 502);
  }
  return nativeFetch(input, init);
};
