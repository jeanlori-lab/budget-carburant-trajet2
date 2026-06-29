/**
 * Relais Cloudflare Worker pour le calcul des péages via TollGuru.
 *
 * La clé API n'a pas accès à l'API v2 ("TollTally"), on utilise donc l'ancien
 * endpoint dev.api.tollguru.com/v1/calc/route. Comme la valeur exacte de
 * "source" attendue n'est pas certaine, le Worker essaie plusieurs variantes
 * et renvoie la première qui fonctionne, avec un diagnostic ("attempts").
 *
 * Réponse renvoyée au site :
 *   { "cost": <nombre €>|null, "source": "...", "attempts": [...] }
 *
 * Déploiement : Cloudflare → Workers & Pages → ton Worker → Edit code →
 *   coller TOUT ce fichier → Deploy.
 * (Recommandé : Settings → Variables → TOLLGURU_KEY = ta clé.)
 */

const DEFAULT_TOLLGURU_KEY = 'tg_F9E2FD106CAA46B38658750E2C0872E6';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });

    const key = (env && env.TOLLGURU_KEY) || DEFAULT_TOLLGURU_KEY;

    try {
      const { polyline, vehicleType } = await request.json();
      if (!polyline) return json({ error: 'missing polyline' }, 400);
      const vt = vehicleType || '2AxlesAuto';

      const attempts = [];

      // Différentes valeurs de "source" acceptées par l'ancien endpoint selon
      // le fournisseur de la polyline (ORS encode comme Google, précision 5).
      const sources = ['gmaps', 'here', 'google', 'osrm', 'mapbox'];

      for (const source of sources) {
        try {
          const r = await fetch('https://dev.api.tollguru.com/v1/calc/route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key },
            body: JSON.stringify({ source, polyline, vehicleType: vt }),
          });
          const text = await r.text();
          let data;
          try { data = JSON.parse(text); } catch (e) { data = text; }
          attempts.push({ source, status: r.status, body: String(text).slice(0, 250) });

          if (r.status === 200 && data && typeof data === 'object') {
            const route = data.route || (data.routes && data.routes[0]) || data;
            if (route && route.hasTolls === false) return json({ cost: 0, source, attempts }, 200);
            const cost = extractToll(route && route.costs);
            if (cost !== null) return json({ cost, source, attempts }, 200);
          }
        } catch (e) {
          attempts.push({ source, error: String(e) });
        }
      }

      // Aucune variante n'a donné de coût : on renvoie le diagnostic.
      return json({ cost: null, attempts }, 200);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};

function extractToll(costs) {
  if (!costs || typeof costs !== 'object') return null;
  const candidats = [
    costs.tag, costs.cash, costs.creditCard, costs.licensePlate,
    costs.minimumTollCost, costs.maximumTollCost, costs.prepaidCard,
  ];
  for (const c of candidats) {
    const n = parseFloat(c);
    if (c !== undefined && c !== null && !isNaN(n)) return n;
  }
  return null;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
