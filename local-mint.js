(() => {
  const mint = null;
  const originalFetch = window.fetch.bind(window);
  window.__ZATOSHI_LOCAL_MINT__ = mint;

  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    if (method === 'GET' && url.includes('xqpxbvcguvsxqhbqehap.supabase.co/rest/v1/site_config')) {
      return Promise.resolve(new Response(JSON.stringify([{ mint, updated_at: new Date().toISOString() }]), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-range': '0-0/1',
        },
      }));
    }
    return originalFetch(input, init);
  };
})();
