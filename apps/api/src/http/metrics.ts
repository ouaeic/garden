/**
 * What the box will admit about its own traffic, counted per route pattern.
 *
 * The pattern and never the URL: a path parameter is an identifier and a query string is not
 * guaranteed not to be one. `/metrics` is on the public path list because a scraper has no
 * session, and it answers in the Prometheus text format so nothing has to be installed to read
 * it. The response hook and the route it feeds live together so a counter cannot be recorded in
 * one shape and served in another.
 */

import type { ServerBase } from './server-context.js';

export const registerMetrics = (context: ServerBase): void => {
  const { log, app, requestStarted, requestMetrics } = context;
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const key = `${request.method}|${route}|${reply.statusCode}`;
    const metric = requestMetrics.get(key) ?? { count: 0, durationMs: 0 };
    metric.count += 1;
    const durationMs = Math.max(
      0,
      performance.now() - (requestStarted.get(request) ?? performance.now())
    );
    metric.durationMs += durationMs;
    requestMetrics.set(key, metric);
    // The route pattern, never the URL: a path parameter is an identifier, a query string is not
    // guaranteed to be one. Per-request lines are for a diagnosis session, not for standing use.
    log.debug('http.request', {
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs: Math.round(durationMs)
    });
  });
  app.get('/metrics', async (_request, reply) => {
    const lines = [
      '# HELP garden_http_requests_total Content-free HTTP request count',
      '# TYPE garden_http_requests_total counter'
    ];
    for (const [key, metric] of requestMetrics) {
      const [method, route, status] = key.split('|');
      const labels = `method=${JSON.stringify(method)},route=${JSON.stringify(route)},status=${JSON.stringify(status)}`;
      lines.push(
        `garden_http_requests_total{${labels}} ${metric.count}`,
        `garden_http_request_duration_milliseconds_sum{${labels}} ${metric.durationMs.toFixed(3)}`
      );
    }
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });
};
