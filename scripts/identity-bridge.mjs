#!/usr/bin/env node
/**
 * OpenMAIC identity bridge (docs/auth-signed-identity.md, design
 * docs/designs/tailscale-identity-login.md §8).
 *
 *   tailscale serve (root) ──▶ this bridge (127.0.0.1:3001) ──▶ OpenMAIC (127.0.0.1:3000)
 *
 * For every request it:
 *   1. accepts the connection only when the peer socket belongs to uid 0
 *      (`tailscaled`), read from /proc/net/tcp{,6}; anything else gets 403;
 *   2. refuses service (503) while any running container uses host
 *      networking without being listed in BRIDGE_TRUSTED_HOST_NET: such a
 *      container's root processes would pass the uid check (decisions D16/D25);
 *   3. drops every inbound X-OpenMAIC-Identity-* header;
 *   4. turns Tailscale-User-Login/-Name/-Profile-Pic into the signed,
 *      provider-neutral identity headers the app verifies.
 *
 * Requests without Tailscale identity (tagged devices) are forwarded
 * unsigned: the app answers them with its sign-in notice. Bodies stream in
 * both directions (SSE included) and WebSocket upgrades pass through.
 *
 * No dependencies; Node >= 22. Never logs identities or the secret.
 *
 * Environment:
 *   AUTH_IDENTITY_SECRET     required, >= 32 bytes, identical to the app's
 *   BRIDGE_LISTEN_HOST       default 127.0.0.1
 *   BRIDGE_LISTEN_PORT       default 3001
 *   BRIDGE_UPSTREAM          default http://127.0.0.1:3000
 *   BRIDGE_TRUSTED_HOST_NET  comma-separated container names allowed to use host networking
 *   BRIDGE_DOCKER_GUARD      "off" disables the host-network guard (hosts without Docker only)
 *   BRIDGE_DOCKER_BIN        default "docker"
 *   BRIDGE_ALLOW_ANY_PEER    "1" skips the uid check (development only; required off Linux)
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const IDENTITY_HEADERS = {
  login: 'x-openmaic-identity-login',
  name: 'x-openmaic-identity-name',
  avatar: 'x-openmaic-identity-avatar',
  timestamp: 'x-openmaic-identity-timestamp',
  signature: 'x-openmaic-identity-signature',
};
const IDENTITY_PREFIX = 'x-openmaic-identity-';
const TAILSCALE_PREFIX = 'tailscale-user-';
const MIN_SECRET_BYTES = 32;

// ─── Signing (must match lib/server/auth/signed-identity.ts) ────────────────

export function normalizeLogin(login) {
  return String(login).trim().toLowerCase();
}

export function signIdentity(values, secret) {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`v1\n${values.login}\n${values.name}\n${values.avatar}\n${values.timestamp}`, 'utf8')
    .digest('hex');
}

/** Decode RFC 2047 encoded-words (`=?utf-8?b?…?=`, `=?utf-8?q?…?=`); plain text passes through. */
export function decodeRfc2047(value) {
  if (typeof value !== 'string' || !value.includes('=?')) return value ?? '';
  const words = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  // Whitespace between two adjacent encoded-words is not part of the text.
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replace(words, (match, charset, encoding, text) => {
    const cs = String(charset).toLowerCase().split('*')[0];
    const enc =
      cs === 'utf-8' || cs === 'utf8'
        ? 'utf8'
        : cs === 'iso-8859-1' || cs === 'latin1'
          ? 'latin1'
          : null;
    if (!enc) return match;
    try {
      if (encoding.toLowerCase() === 'b') return Buffer.from(text, 'base64').toString(enc);
      const bytes = [];
      const q = text.replace(/_/g, ' ');
      for (let i = 0; i < q.length; i += 1) {
        if (q[i] === '=' && /^[0-9a-fA-F]{2}$/.test(q.slice(i + 1, i + 3))) {
          bytes.push(parseInt(q.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(q.charCodeAt(i) & 0xff);
        }
      }
      return Buffer.from(bytes).toString(enc);
    } catch {
      return match;
    }
  });
}

function single(value) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The outgoing header object for one request: inbound identity headers and
 * Tailscale identity headers removed, signed identity added when Tailscale
 * named a user. `now` is epoch seconds.
 */
export function transformHeaders(inbound, secret, now = Math.floor(Date.now() / 1000)) {
  /** @type {Record<string, string | string[] | undefined>} */
  const out = {};
  for (const [name, value] of Object.entries(inbound)) {
    const lower = name.toLowerCase();
    if (lower.startsWith(IDENTITY_PREFIX) || lower.startsWith(TAILSCALE_PREFIX)) continue;
    out[name] = value;
  }
  const rawLogin = single(inbound['tailscale-user-login']);
  const login = rawLogin ? normalizeLogin(rawLogin) : '';
  if (!login) return out;
  const decodedName = decodeRfc2047(single(inbound['tailscale-user-name']) ?? '').trim();
  const values = {
    login,
    name: decodedName ? encodeURIComponent(decodedName) : '',
    avatar: single(inbound['tailscale-user-profile-pic']) ?? '',
    timestamp: String(now),
  };
  out[IDENTITY_HEADERS.login] = values.login;
  out[IDENTITY_HEADERS.name] = values.name;
  out[IDENTITY_HEADERS.avatar] = values.avatar;
  out[IDENTITY_HEADERS.timestamp] = values.timestamp;
  out[IDENTITY_HEADERS.signature] = signIdentity(values, secret);
  return out;
}

// ─── Peer uid (Linux) ────────────────────────────────────────────────────────

const hexPort = (port) => port.toString(16).toUpperCase().padStart(4, '0');

/**
 * The uid owning the peer end of a local TCP connection, from the text of
 * /proc/net/tcp and /proc/net/tcp6: the peer's own row has local port = its
 * port and remote port = our listening port.
 */
export function findPeerUid(tables, peerPort, ourPort) {
  const local = hexPort(peerPort);
  const remote = hexPort(ourPort);
  for (const text of tables) {
    for (const line of String(text).split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 8) continue;
      if (cols[1].split(':').pop() === local && cols[2].split(':').pop() === remote) {
        const uid = Number(cols[7]);
        return Number.isInteger(uid) ? uid : null;
      }
    }
  }
  return null;
}

function readProcTables() {
  const tables = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      tables.push(readFileSync(file, 'utf8'));
    } catch {
      // IPv6 may be disabled.
    }
  }
  return tables;
}

// ─── Host-network guard ──────────────────────────────────────────────────────

/**
 * Refuses service while any running container uses host networking without
 * being trusted, and while it cannot tell (not yet synced, or the docker
 * events stream is down). Sources are injected so this is testable.
 *
 *   listHostNetworkContainers(): Promise<string[]>   names using host networking
 *   subscribeEvents(onEvent, onEnd): () => void      starts the events stream
 */
export class HostNetworkGuard {
  /**
   * @param {{
   *   listHostNetworkContainers: () => Promise<string[]>,
   *   subscribeEvents: (onEvent: () => void, onEnd: () => void) => () => void,
   *   trusted?: string[],
   *   resyncMs?: number,
   *   reconnectMs?: number,
   *   log?: (message: string) => void,
   * }} options
   */
  constructor({
    listHostNetworkContainers,
    subscribeEvents,
    trusted = [],
    resyncMs = 60_000,
    reconnectMs = 2_000,
    log = () => {},
  }) {
    this.list = listHostNetworkContainers;
    this.subscribe = subscribeEvents;
    this.trusted = new Set(trusted);
    this.resyncMs = resyncMs;
    this.reconnectMs = reconnectMs;
    this.log = log;
    this.state = { status: 'starting', violations: [] };
    this.streamUp = false;
    this.timers = new Set();
    this.stopped = false;
    this.syncing = null;
  }

  get allowed() {
    return this.state.status === 'ok';
  }

  start() {
    this.connect();
    const interval = setInterval(() => void this.resync(), this.resyncMs);
    interval.unref?.();
    this.timers.add(interval);
    return this.resync();
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    this.unsubscribe?.();
  }

  connect() {
    if (this.stopped) return;
    this.unsubscribe = this.subscribe(
      () => {
        this.streamUp = true;
        void this.resync();
      },
      () => {
        this.streamUp = false;
        this.setState({ status: 'lost', violations: [] });
        if (this.stopped) return;
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.connect();
          void this.resync();
        }, this.reconnectMs);
        timer.unref?.();
        this.timers.add(timer);
      },
    );
    this.streamUp = true;
  }

  resync() {
    this.syncing ??= (async () => {
      try {
        const names = await this.list();
        const violations = names.filter((name) => !this.trusted.has(name));
        if (!this.streamUp) this.setState({ status: 'lost', violations });
        else this.setState({ status: violations.length ? 'violated' : 'ok', violations });
      } catch (error) {
        this.setState({ status: 'lost', violations: [] });
        this.log(`host-network guard: docker unavailable (${error.message})`);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  setState(next) {
    const changed =
      next.status !== this.state.status ||
      next.violations.join(',') !== this.state.violations.join(',');
    this.state = next;
    if (changed) {
      this.log(
        next.status === 'ok'
          ? 'host-network guard: ok, serving'
          : `host-network guard: ${next.status}${next.violations.length ? ` (${next.violations.join(', ')})` : ''}, refusing service`,
      );
    }
  }
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `${bin} exited ${code}`)),
    );
  });
}

export function dockerSources(bin = 'docker') {
  return {
    async listHostNetworkContainers() {
      const ids = (await run(bin, ['ps', '-q'])).split('\n').filter(Boolean);
      if (ids.length === 0) return [];
      const lines = await run(bin, [
        'inspect',
        '--format',
        '{{.Name}} {{.HostConfig.NetworkMode}}',
        ...ids,
      ]);
      return lines
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([, mode]) => mode === 'host')
        .map(([name]) => name.replace(/^\//, ''));
    },
    subscribeEvents(onEvent, onEnd) {
      const child = spawn(
        bin,
        [
          'events',
          '--filter',
          'type=container',
          '--filter',
          'type=network',
          '--filter',
          'event=start',
          '--filter',
          'event=connect',
          '--format',
          '{{.Type}} {{.Action}}',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        onEnd();
      };
      createInterface({ input: child.stdout }).on('line', () => onEvent());
      child.on('error', end);
      child.on('close', end);
      return () => {
        ended = true;
        child.kill();
      };
    },
  };
}

// ─── Proxy ───────────────────────────────────────────────────────────────────

function sendPlain(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`${text}\n`);
}

/**
 * Build the bridge server. `peerCheck(socket)` answers whether a connection
 * may be served; `guard` exposes `allowed` and `state`.
 */
export function createBridge({ upstream, secret, peerCheck, guard, log = () => {} }) {
  const target = new URL(upstream);
  const allowedSockets = new WeakMap();
  const socketAllowed = (socket) => {
    if (!allowedSockets.has(socket)) allowedSockets.set(socket, peerCheck(socket));
    return allowedSockets.get(socket);
  };

  const server = http.createServer((req, res) => {
    if (!socketAllowed(req.socket)) return sendPlain(res, 403, 'Forbidden');
    if (req.url === '/__bridge/health') {
      res.writeHead(guard.allowed ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ ok: guard.allowed, guard: guard.state.status }) + '\n');
      return;
    }
    if (!guard.allowed)
      return sendPlain(res, 503, 'Service unavailable: identity bridge guard is not satisfied');

    const upstreamReq = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: req.url,
        headers: transformHeaders(req.headers, secret),
      },
      (upstreamRes) => {
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          upstreamRes.statusMessage,
          upstreamRes.headers,
        );
        // SSE and long responses: stream without buffering.
        res.flushHeaders();
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on('error', (error) => {
      log(`upstream error: ${error.code ?? error.message}`);
      if (!res.headersSent) sendPlain(res, 502, 'Bad gateway');
      else res.destroy();
    });
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
  });

  server.on('upgrade', (req, socket, head) => {
    if (!socketAllowed(req.socket) || !guard.allowed) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
      return;
    }
    const headers = transformHeaders(req.headers, secret);
    const upstreamSocket = net.connect(Number(target.port || 80), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    const close = () => {
      socket.destroy();
      upstreamSocket.destroy();
    };
    // Either side ending ends the tunnel. HTTP server sockets allow half-open
    // connections, so waiting for 'close' alone would leak both sockets.
    for (const side of [socket, upstreamSocket]) {
      side.on('error', close);
      side.on('end', close);
      side.on('close', close);
    }
  });

  return server;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const log = (message) => console.log(`[identity-bridge] ${message}`);
  const secret = process.env.AUTH_IDENTITY_SECRET ?? '';
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    console.error(
      `[identity-bridge] AUTH_IDENTITY_SECRET must be at least ${MIN_SECRET_BYTES} bytes`,
    );
    process.exit(1);
  }
  const anyPeer = process.env.BRIDGE_ALLOW_ANY_PEER === '1';
  if (process.platform !== 'linux' && !anyPeer) {
    console.error(
      '[identity-bridge] the peer uid check needs Linux; set BRIDGE_ALLOW_ANY_PEER=1 for development only',
    );
    process.exit(1);
  }
  if (anyPeer)
    log('WARNING: BRIDGE_ALLOW_ANY_PEER=1, any local process can obtain a signed identity');

  const guardOff = process.env.BRIDGE_DOCKER_GUARD === 'off';
  const guard = guardOff
    ? { allowed: true, state: { status: 'off', violations: [] }, start: async () => {}, stop() {} }
    : new HostNetworkGuard({
        ...dockerSources(process.env.BRIDGE_DOCKER_BIN || 'docker'),
        trusted: (process.env.BRIDGE_TRUSTED_HOST_NET ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        log,
      });
  if (guardOff) log('WARNING: host-network guard disabled (BRIDGE_DOCKER_GUARD=off)');

  const host = process.env.BRIDGE_LISTEN_HOST || '127.0.0.1';
  const port = Number(process.env.BRIDGE_LISTEN_PORT || 3001);
  const server = createBridge({
    upstream: process.env.BRIDGE_UPSTREAM || 'http://127.0.0.1:3000',
    secret,
    guard,
    log,
    peerCheck: anyPeer
      ? () => true
      : (socket) => {
          const uid = findPeerUid(readProcTables(), socket.remotePort, socket.localPort);
          if (uid !== 0) log(`refused a connection from a non-root peer (uid ${uid ?? 'unknown'})`);
          return uid === 0;
        },
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;
  void guard.start();
  server.listen(port, host, () => log(`listening on ${host}:${port}`));
  const shutdown = () => {
    guard.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
