/**
 * What a finished route rescale (/rescale-route) changes on a gaussian node besides its ply: the hand adjustments
 * of the clips added at the route's ends keep right / up / forward in metres, and a rebuild from the node's source
 * clips takes its unit from routeSettings -- both follow the new unit, so later runs keep the shape. Mirrors
 * canvas_mcp_server._route_scaled_data.
 */
export interface RouteScaleResult {
  scale?: number;
  metres_per_unit?: number;
}

export interface RouteScaleFields {
  routeExtendAdjust?: Record<string, Record<string, number>>;
  routeSettings?: Record<string, number | boolean>;
}

const METRE_KEYS = ['right', 'up', 'forward'];

export function routeScaledData(data: RouteScaleFields, result: RouteScaleResult | null | undefined): RouteScaleFields {
  const k = result?.scale;
  if (typeof k !== 'number' || !(k > 0)) return {};
  const out: RouteScaleFields = {};
  const adj = data.routeExtendAdjust;
  if (adj && Object.keys(adj).length) {
    out.routeExtendAdjust = Object.fromEntries(Object.entries(adj).map(([url, a]) => [url,
      Object.fromEntries(Object.entries(a || {}).map(([key, v]) => [key, METRE_KEYS.includes(key) ? v * k : v]))]));
  }
  if (data.routeSettings && typeof result?.metres_per_unit === 'number') {
    out.routeSettings = { ...data.routeSettings, metres_per_unit: result.metres_per_unit };
  }
  return out;
}
