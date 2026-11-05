import http from 'node:http';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * A small forward proxy that only lets workers reach an allowlist of hosts.
 * Run it on a network that has internet access, and put the workers on a
 * network that does not: then nothing a worker runs (including shell commands)
 * can reach anywhere else, whatever proxy settings it ignores.
 *
 *  - allow entries are `host`, `host:port` or `*.domain[:port]`; the port
 *    defaults to 443.
 *  - destinations resolving to private, loopback or link-local addresses are
 *    refused (SSRF, cloud metadata) unless the entry is in `allowPrivate`.
 *  - the proxy connects to the address it resolved and checked, so a second DNS
 *    answer cannot redirect it.
 */
export interface EgressOptions {
  allow: string[];
  allowPrivate?: string[];
  maxConnections?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  log?: (message: string) => void;
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
}

const PRIVATE = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  PRIVATE.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(net6, prefix, 'ipv6');

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1] : address;
  const family = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
  return PRIVATE.check(ip, family);
}

interface Rule {
  host: string;
  wildcard: boolean;
  port: number;
}

function parseRule(entry: string): Rule {
  const m = /^(\*\.)?([a-z0-9.-]+?)(?::(\d{1,5}))?$/i.exec(entry.trim());
  if (!m) throw new Error(`Invalid egress rule: ${entry}`);
  return {
    host: m[2].toLowerCase(),
    wildcard: m[1] !== undefined,
    port: m[3] ? Number(m[3]) : 443,
  };
}

const matches = (rules: Rule[], host: string, port: number): boolean =>
  rules.some(
    (r) =>
      r.port === port &&
      (r.wildcard ? host.endsWith(`.${r.host}`) : host === r.host)
  );

function splitHostPort(
  target: string,
  defaultPort?: number
): { host: string; port: number } | null {
  const m = /^(\[[0-9a-f:.]+\]|[^:/\s]+)(?::(\d{1,5}))?$/i.exec(target);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!port || port > 65535) return null;
  return { host: m[1].replace(/^\[|\]$/g, '').toLowerCase(), port };
}

export function createEgressProxy(options: EgressOptions): http.Server {
  const allow = options.allow.map(parseRule);
  const allowPrivate = (options.allowPrivate ?? []).map(parseRule);
  const log = options.log ?? (() => {});
  const resolveHost =
    options.resolve ?? ((host: string) => lookup(host, { all: true }));
  const maxConnections = options.maxConnections ?? 64;
  const connectTimeout = options.connectTimeoutMs ?? 10_000;
  const idleTimeout = options.idleTimeoutMs ?? 5 * 60_000;
  let open = 0;

  /** The vetted address to connect to, or a reason to refuse. */
  async function authorize(
    host: string,
    port: number
  ): Promise<{ address: string } | { denied: string }> {
    if (!matches(allow, host, port) && !matches(allowPrivate, host, port))
      return { denied: 'not on the allowlist' };
    const privateOk = matches(allowPrivate, host, port);
    let addresses: { address: string }[];
    if (net.isIP(host)) addresses = [{ address: host }];
    else {
      try {
        addresses = await resolveHost(host);
      } catch {
        return { denied: 'does not resolve' };
      }
    }
    if (addresses.length === 0) return { denied: 'does not resolve' };
    if (!privateOk && addresses.some((a) => isPrivateAddress(a.address)))
      return { denied: 'resolves to a private address' };
    return { address: addresses[0].address };
  }

  const server = http.createServer(async (req, res) => {
    // Plain HTTP in absolute form (what HTTP_PROXY clients send for http:// URLs).
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end('Bad request');
      return;
    }
    const target = splitHostPort(url.host, 80);
    if (!target) {
      res.writeHead(400).end('Bad request');
      return;
    }
    const verdict = await authorize(target.host, target.port);
    if ('denied' in verdict) {
      log(`denied ${target.host}:${target.port} (${verdict.denied})`);
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (open >= maxConnections) {
      res.writeHead(503).end('Busy');
      return;
    }
    open++;
    const headers = { ...req.headers };
    for (const h of ['proxy-connection', 'proxy-authorization', 'connection'])
      delete headers[h];
    const upstream = http.request(
      {
        host: verdict.address,
        port: target.port,
        method: req.method,
        path: url.pathname + url.search,
        headers: { ...headers, host: url.host },
        timeout: connectTimeout,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end('Bad gateway');
      else res.destroy();
    });
    upstream.on('timeout', () => upstream.destroy());
    res.on('close', () => {
      open--;
      upstream.destroy();
    });
    req.pipe(upstream);
  });

  server.on('connect', async (req, client: Duplex, head: Buffer) => {
    const deny = (status: string) => {
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    client.on('error', () => client.destroy());
    const target = splitHostPort(req.url ?? '');
    if (!target) return deny('400 Bad Request');
    const verdict = await authorize(target.host, target.port);
    if ('denied' in verdict) {
      log(`denied ${target.host}:${target.port} (${verdict.denied})`);
      return deny('403 Forbidden');
    }
    if (open >= maxConnections) return deny('503 Service Unavailable');
    open++;
    const upstream = net.connect({
      host: verdict.address,
      port: target.port,
      timeout: connectTimeout,
    });
    let connected = false;
    const done = () => {
      open--;
      upstream.destroy();
      client.destroy();
    };
    upstream.once('connect', () => {
      connected = true;
      upstream.setTimeout(idleTimeout, () => done());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once('timeout', () => {
      if (!connected) {
        deny('504 Gateway Timeout');
        done();
      }
    });
    upstream.once('error', () => {
      if (!connected) deny('502 Bad Gateway');
      done();
    });
    upstream.once('close', done);
    client.once('close', done);
  });

  return server;
}
