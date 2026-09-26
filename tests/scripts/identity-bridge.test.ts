/**
 * The identity bridge (scripts/identity-bridge.mjs): shared vector parity with
 * the app verifier, the /proc/net/tcp peer parser, the host-network guard
 * state machine, and header/stream/upgrade behaviour through a live bridge.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createBridge,
  decodeRfc2047,
  findPeerUid,
  HostNetworkGuard,
  hostNetworkNames,
  procAddress,
  refusesCrossSite,
  transformHeaders,
} from '@/scripts/identity-bridge.mjs';
import vectors from '@/tests/fixtures/signed-identity-vectors.json';
import { verifySignedIdentity } from '@/lib/server/auth/signed-identity';

describe('bridge signing matches the app verifier', () => {
  const signable = vectors.vectors.filter((vector) => vector.tailscale);

  it.each(signable.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const tailscale = vector.tailscale as { login: string; name?: string; avatar?: string };
    const inbound: Record<string, string> = { 'tailscale-user-login': tailscale.login };
    if (tailscale.name !== undefined) inbound['tailscale-user-name'] = tailscale.name;
    if (tailscale.avatar !== undefined) inbound['tailscale-user-profile-pic'] = tailscale.avatar;
    const out = transformHeaders(inbound, vectors.secret, Number(vector.headers.timestamp));

    expect(out['x-openmaic-identity-login']).toBe(vector.headers.login);
    expect(out['x-openmaic-identity-name']).toBe(vector.headers.name);
    expect(out['x-openmaic-identity-avatar']).toBe(vector.headers.avatar);
    expect(out['x-openmaic-identity-signature']).toBe(vector.headers.signature);
    const verified = verifySignedIdentity(new Headers(out as Record<string, string>), {
      secret: vectors.secret,
      adminLogins: new Set(),
      now: vectors.now,
    });
    expect(verified).toMatchObject({ ok: true, identity: { login: vector.expect.login } });
  });

  it('drops forged identity and Tailscale headers, and signs nothing without a login', () => {
    const out = transformHeaders(
      {
        host: 'x',
        'x-openmaic-identity-login': 'parent@example.com',
        'X-OpenMAIC-Identity-Signature': 'f'.repeat(64),
        'tailscale-user-name': 'Someone',
      },
      vectors.secret,
    );
    expect(out).toEqual({ host: 'x' });
  });

  it('decodes RFC 2047 words, including Q encoding and adjacent words', () => {
    expect(decodeRfc2047('=?utf-8?b?6Zmz5aSn5paH?=')).toBe('陳大文');
    expect(decodeRfc2047('=?UTF-8?Q?Caf=C3=A9_Bar?=')).toBe('Café Bar');
    expect(decodeRfc2047('=?utf-8?b?6Zmz?= =?utf-8?b?5aSn5paH?=')).toBe('陳大文');
    expect(decodeRfc2047('Plain Name')).toBe('Plain Name');
  });
});

describe('peer uid from /proc/net/tcp', () => {
  // Columns: sl local rem st tx:rx tr:when retrnsmt uid timeout inode ...
  const header =
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const row = (local: string, remote: string, state: string, uid: number, inode: number) =>
    `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 ${inode} 1 0 20 4 30 10 -1`;
  const bridge = { ourAddress: '127.0.0.1', ourPort: 3001 };

  it('returns the uid of the live peer socket over IPv4 and IPv6', () => {
    const tcp = [header, row('0100007F:D2F0', '0100007F:0BB9', '01', 0, 42)].join('\n');
    const tcp6 = [
      header,
      row(
        '00000000000000000000000001000000:E000',
        '00000000000000000000000001000000:0BB9',
        '01',
        998,
        43,
      ),
    ].join('\n');
    expect(
      findPeerUid([tcp, tcp6], { ...bridge, peerAddress: '127.0.0.1', peerPort: 0xd2f0 }),
    ).toBe(0);
    expect(
      findPeerUid([tcp, tcp6], {
        peerAddress: '::1',
        peerPort: 0xe000,
        ourAddress: '::1',
        ourPort: 3001,
      }),
    ).toBe(998);
    expect(
      findPeerUid([tcp], { ...bridge, peerAddress: '127.0.0.1', peerPort: 0x1234 }),
    ).toBeNull();
  });

  it('is not fooled by a TIME_WAIT row or another loopback address on the same port', () => {
    const tcp = [
      header,
      // A closed attacker connection from 127.0.0.2:P, now TIME_WAIT: uid 0, inode 0.
      row('0200007F:D2F4', '0100007F:0BB9', '06', 0, 0),
      // tailscaled's live connection from 127.0.0.1:P.
      row('0100007F:D2F4', '0100007F:0BB9', '01', 0, 77),
      // The attacker's live connection from 127.0.0.3:P.
      row('0300007F:D2F4', '0100007F:0BB9', '01', 1001, 78),
    ].join('\n');
    expect(findPeerUid([tcp], { ...bridge, peerAddress: '127.0.0.3', peerPort: 0xd2f4 })).toBe(
      1001,
    );
    expect(
      findPeerUid([tcp], { ...bridge, peerAddress: '127.0.0.2', peerPort: 0xd2f4 }),
    ).toBeNull();
    expect(findPeerUid([tcp], { ...bridge, peerAddress: '127.0.0.1', peerPort: 0xd2f4 })).toBe(0);
  });

  it('encodes addresses the way the kernel prints them', () => {
    expect(procAddress('127.0.0.1')).toBe('0100007F');
    expect(procAddress('::1')).toBe('00000000000000000000000001000000');
    expect(procAddress('::ffff:127.0.0.1')).toBe('0000000000000000FFFF00000100007F');
    expect(procAddress('not-an-ip')).toBeNull();
  });
});

describe('host-network containers and cross-site requests', () => {
  it('flags host networking and containers joined to a host-network container', () => {
    expect(
      hostNetworkNames([
        { id: 'aaa111', name: 'hostnet', mode: 'host' },
        { id: 'bbb222', name: 'sidecar', mode: 'container:hostnet' },
        { id: 'ccc333', name: 'sidecar-by-id', mode: 'container:aaa1' },
        { id: 'ddd444', name: 'app', mode: 'openmaic_default' },
        { id: 'eee555', name: 'joined-bridge', mode: 'container:app' },
      ]),
    ).toEqual(['hostnet', 'sidecar', 'sidecar-by-id']);
  });

  it('refuses unsafe cross-site requests and allows same-origin and non-browser ones', () => {
    const host = { host: 'family.example.ts.net' };
    expect(refusesCrossSite('GET', { ...host, 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(refusesCrossSite('POST', { ...host, 'sec-fetch-site': 'cross-site' })).toBe(true);
    expect(refusesCrossSite('POST', { ...host, 'sec-fetch-site': 'same-site' })).toBe(true);
    expect(refusesCrossSite('POST', { ...host, 'sec-fetch-site': 'same-origin' })).toBe(false);
    expect(refusesCrossSite('DELETE', { ...host, origin: 'https://evil.example' })).toBe(true);
    expect(refusesCrossSite('PUT', { ...host, origin: 'https://family.example.ts.net' })).toBe(
      false,
    );
    expect(refusesCrossSite('POST', host)).toBe(false);
    expect(refusesCrossSite('GET', { ...host, origin: 'https://evil.example' }, true)).toBe(true);
  });
});

describe('host-network guard', () => {
  function harness(initial: string[], trusted: string[] = []) {
    let names = initial;
    let onEvent = () => {};
    let onEnd = () => {};
    const guard = new HostNetworkGuard({
      listHostNetworkContainers: async () => names,
      subscribeEvents: (event: () => void, end: () => void) => {
        onEvent = event;
        onEnd = end;
        return () => {};
      },
      trusted,
      resyncMs: 3_600_000,
      reconnectMs: 5,
    });
    return {
      guard,
      set: (next: string[]) => {
        names = next;
      },
      event: () => onEvent(),
      drop: () => onEnd(),
    };
  }

  it('starts refusing, serves once synced clean, and refuses on a host-network start event', async () => {
    const h = harness([]);
    expect(h.guard.allowed).toBe(false);
    await h.guard.start();
    expect(h.guard.allowed).toBe(true);

    h.set(['rogue']);
    h.event();
    await h.guard.resync();
    expect(h.guard.state).toEqual({ status: 'violated', violations: ['rogue'] });
    expect(h.guard.allowed).toBe(false);
    h.guard.stop();
  });

  it('allows listed containers and refuses while the events stream is lost', async () => {
    const h = harness(['trusted-one'], ['trusted-one']);
    await h.guard.start();
    expect(h.guard.allowed).toBe(true);
    h.drop();
    expect(h.guard.state.status).toBe('lost');
    expect(h.guard.allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.guard.resync();
    expect(h.guard.allowed).toBe(true);
    h.guard.stop();
  });

  it('re-lists when an event arrives during a listing', async () => {
    let calls = 0;
    let release: () => void = () => {};
    let onEvent = () => {};
    const guard = new HostNetworkGuard({
      listHostNetworkContainers: async () => {
        calls += 1;
        if (calls === 2) {
          // The listing an event raced: taken before the container started.
          await new Promise<void>((resolve) => (release = resolve));
          return [];
        }
        return calls >= 3 ? ['late-hostnet'] : [];
      },
      subscribeEvents: (event: () => void) => {
        onEvent = event;
        return () => {};
      },
      resyncMs: 3_600_000,
    });
    await guard.start();
    const inFlight = guard.resync();
    onEvent();
    release();
    await inFlight;
    expect(guard.state).toEqual({ status: 'violated', violations: ['late-hostnet'] });
    guard.stop();
  });

  it('refuses when docker cannot be asked', async () => {
    const guard = new HostNetworkGuard({
      listHostNetworkContainers: async () => {
        throw new Error('no docker');
      },
      subscribeEvents: () => () => {},
      resyncMs: 3_600_000,
    });
    await guard.start();
    expect(guard.state.status).toBe('lost');
    guard.stop();
  });
});

describe('live bridge', () => {
  const servers: Array<http.Server | net.Server> = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise((resolve) => {
            server.close(() => resolve(null));
            if (server instanceof http.Server) server.closeAllConnections();
          }),
      ),
    );
  });

  async function listen<T extends http.Server | net.Server>(server: T): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  async function start(options: { peerAllowed?: boolean; guardAllowed?: boolean } = {}) {
    const seen: http.IncomingHttpHeaders[] = [];
    const upstream = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 150);
        return;
      }
      res.end('ok');
    });
    upstream.on('upgrade', (req, socket) => {
      seen.push(req.headers);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n',
      );
      socket.on('data', (chunk) => socket.write(chunk));
      socket.on('end', () => socket.end());
    });
    const upstreamPort = await listen(upstream);
    const bridge = createBridge({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      secret: vectors.secret,
      peerCheck: () => options.peerAllowed ?? true,
      guard: { allowed: options.guardAllowed ?? true, state: { status: 'ok', violations: [] } },
    });
    const port = await listen(bridge);
    return { port, seen };
  }

  it('signs Tailscale identity and strips forged headers on the way through', async () => {
    const { port, seen } = await start();
    const response = await fetch(`http://127.0.0.1:${port}/api/x`, {
      headers: {
        'tailscale-user-login': 'Student@Example.com',
        'x-openmaic-identity-login': 'parent@example.com',
      },
    });
    expect(await response.text()).toBe('ok');
    expect(seen[0]['x-openmaic-identity-login']).toBe('student@example.com');
    expect(seen[0]['x-openmaic-identity-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0]['tailscale-user-login']).toBeUndefined();

    await fetch(`http://127.0.0.1:${port}/api/y`, {
      headers: { 'x-openmaic-identity-login': 'parent@example.com' },
    });
    expect(seen[1]['x-openmaic-identity-login']).toBeUndefined();
  });

  it('streams server-sent events without buffering', async () => {
    const { port } = await start();
    const response = await fetch(`http://127.0.0.1:${port}/sse`);
    const reader = response.body!.getReader();
    const started = Date.now();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('one');
    expect(Date.now() - started).toBeLessThan(140);
    let rest = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toContain('two');
  });

  it('passes WebSocket upgrades with the signed identity', async () => {
    const { port, seen } = await start();
    const socket = net.connect(port, '127.0.0.1');
    const received = await new Promise<string>((resolve) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('\r\n\r\n') && buffer.endsWith('ping')) resolve(buffer);
        else if (buffer.includes('101')) socket.write('ping');
      });
      socket.write(
        'GET /ws HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\ntailscale-user-login: kid@x.y\r\n\r\n',
      );
    });
    socket.destroy();
    expect(received).toContain('101 Switching Protocols');
    expect(seen.at(-1)?.['x-openmaic-identity-login']).toBe('kid@x.y');
  });

  it('refuses a cross-site POST before it reaches the app', async () => {
    const { port, seen } = await start();
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/sessions`, {
      method: 'POST',
      headers: { 'tailscale-user-login': 'kid@x.y', 'sec-fetch-site': 'cross-site' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('answers 403 to a refused peer and 503 while the guard refuses', async () => {
    const refused = await start({ peerAllowed: false });
    expect((await fetch(`http://127.0.0.1:${refused.port}/`)).status).toBe(403);
    expect(refused.seen).toHaveLength(0);

    const guarded = await start({ guardAllowed: false });
    expect((await fetch(`http://127.0.0.1:${guarded.port}/`)).status).toBe(503);
    const health = await fetch(`http://127.0.0.1:${guarded.port}/__bridge/health`);
    expect(health.status).toBe(503);
    expect(guarded.seen).toHaveLength(0);
  });
});
