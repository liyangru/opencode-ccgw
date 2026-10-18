#!/usr/bin/env node
// Dedicated egress bridge: local HTTP CONNECT -> SOCKS5 (ssh -N -D) -> remote host.
//
// The gateway's egress relay (egress.mjs) speaks HTTP CONNECT to a loopback proxy.
// ssh only offers SOCKS5, so this process bridges the two. It is loopback-only,
// allowlists the CONNECT targets, and never touches system routing.
//
// Usage:
//   node egress-ssh.mjs --target user@vps --listen-port 41800
//   node egress-ssh.mjs --socks 127.0.0.1:1080 --listen-port 41800 --no-ssh
//   node egress-ssh.mjs --target user@vps --check
//   node egress-ssh.mjs --target user@vps --print-command
import net from 'node:net'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const out = {
    target: '',
    socksHost: '127.0.0.1',
    socksPort: 1080,
    listenHost: '127.0.0.1',
    listenPort: 41800,
    allow: ['opencode.ai:443'],
    check: false,
    printCommand: false,
    noSsh: false,
    sshArgs: [],
    connectTimeoutMs: 15000,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    if (a === '--target') out.target = next()
    else if (a === '--socks') {
      const [h, p] = next().split(':')
      out.socksHost = h
      out.socksPort = Number(p)
    } else if (a === '--socks-port') out.socksPort = Number(next())
    else if (a === '--listen') {
      const [h, p] = next().split(':')
      out.listenHost = h
      out.listenPort = Number(p)
    } else if (a === '--listen-port') out.listenPort = Number(next())
    else if (a === '--allow') out.allow = next().split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--check') out.check = true
    else if (a === '--print-command') out.printCommand = true
    else if (a === '--no-ssh') out.noSsh = true
    else if (a === '--ssh-arg') out.sshArgs.push(next())
    else if (a === '--timeout-ms') out.connectTimeoutMs = Number(next())
    else if (a === '--help' || a === '-h') {
      console.log('see the header of egress-ssh.mjs for usage')
      process.exit(0)
    } else throw new Error(`unknown argument: ${a}`)
  }
  if (!out.noSsh && !out.target) throw new Error('--target is required unless --no-ssh is set')
  return out
}

export function sshCommand(cfg) {
  const socks = `${cfg.socksHost}:${cfg.socksPort}`
  const args = [
    '-N',
    '-D', socks,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    ...cfg.sshArgs,
    cfg.target,
  ]
  return { command: 'ssh', args, display: `ssh ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}` }
}

// Minimal SOCKS5 CONNECT (no auth). Resolves with the connected socket.
export function socksConnect({ host, port, socksHost, socksPort, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: socksHost, port: socksPort })
    let phase = 'greeting'
    let buf = Buffer.alloc(0)
    let settled = false
    const timer = setTimeout(() => finish(new Error(`socks connect timeout after ${timeoutMs}ms`)), timeoutMs)

    function finish(err, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners('data')
      socket.removeAllListeners('error')
      if (err) {
        socket.destroy()
        reject(err)
      } else {
        resolve(value)
      }
    }

    socket.once('connect', () => {
      if (process.env.EGRESS_SSH_DEBUG) console.error(`[socks] tcp connected to ${socksHost}:${socksPort}`)
      socket.write(Buffer.from([0x05, 0x01, 0x00]))
    })
    socket.once('error', err => finish(err))
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      if (process.env.EGRESS_SSH_DEBUG) console.error(`[socks] phase=${phase} bytes=${buf.length}`)
      if (phase === 'greeting') {
        if (buf.length < 2) return
        if (buf[0] !== 0x05) return finish(new Error('socks: bad version'))
        if (buf[1] !== 0x00) return finish(new Error(`socks: auth method ${buf[1]} not supported`))
        buf = buf.subarray(2)
        phase = 'reply'
        const name = Buffer.from(host, 'utf8')
        if (name.length > 255) return finish(new Error('socks: hostname too long'))
        const req = Buffer.alloc(4 + 1 + name.length + 2)
        req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03
        req[4] = name.length
        name.copy(req, 5)
        req.writeUInt16BE(port, 5 + name.length)
        socket.write(req)
        return
      }
      if (phase === 'reply') {
        if (buf.length < 4) return
        if (buf[0] !== 0x05) return finish(new Error('socks: bad reply version'))
        const rep = buf[1]
        if (rep !== 0x00) {
          const names = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'ttl expired', 7: 'command not supported', 8: 'address type not supported' }
          return finish(new Error(`socks: ${names[rep] || `error ${rep}`}`))
        }
        const atyp = buf[3]
        const need = atyp === 0x01 ? 4 + 4 + 2 : atyp === 0x04 ? 4 + 16 + 2 : atyp === 0x03 ? 4 + 1 + buf[4] + 2 : -1
        if (need === -1) return finish(new Error('socks: bad address type'))
        if (buf.length < need) return
        const rest = buf.subarray(need)
        phase = 'done'
        if (rest.length) socket.unshift(rest)
        finish(null, socket)
      }
    })
  })
}

function allowed(hostPort, allow) {
  if (allow.includes('*')) return true
  return allow.includes(hostPort)
}

export function createBridge(cfg) {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('egress bridge: use CONNECT\n')
  })

  server.on('connect', (req, client, head) => {
    if (process.env.EGRESS_SSH_DEBUG) console.error(`[bridge] CONNECT ${req.url} from ${client.remoteAddress}`)
    const remote = client.remoteAddress || ''
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
    if (!loopback) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const target = String(req.url || '')
    if (!allowed(target, cfg.allow)) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const m = /^(.+):(\d+)$/.exec(target)
    if (!m) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    const host = m[1]
    const port = Number(m[2])

    socksConnect({ host, port, socksHost: cfg.socksHost, socksPort: cfg.socksPort, timeoutMs: cfg.connectTimeoutMs })
      .then(upstream => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head && head.length) upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
        const kill = () => { client.destroy(); upstream.destroy() }
        client.on('error', kill)
        upstream.on('error', kill)
        client.on('close', () => upstream.destroy())
        upstream.on('close', () => client.destroy())
      })
      .catch(err => {
        if (process.env.EGRESS_SSH_DEBUG) console.error(`[egress-ssh] connect ${target} failed: ${err.message}`)
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      })
  })

  return server
}

function waitForPort({ host, port, timeoutMs = 20000 }) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect({ host, port })
      const done = ok => {
        s.destroy()
        if (ok) resolve()
        else if (Date.now() > deadline) reject(new Error(`socks port ${host}:${port} did not open within ${timeoutMs}ms`))
        else setTimeout(attempt, 300)
      }
      s.once('connect', () => done(true))
      s.once('error', () => done(false))
    }
    attempt()
  })
}

async function checkOnce(cfg) {
  const server = createBridge(cfg)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.listenPort, cfg.listenHost, resolve)
  })
  const target = cfg.allow[0]
  const result = await new Promise(resolve => {
    const req = http.request({
      host: cfg.listenHost,
      port: cfg.listenPort,
      method: 'CONNECT',
      path: target,
      timeout: cfg.connectTimeoutMs,
    })
    req.on('connect', (res, socket) => {
      socket.destroy()
      resolve({ ok: res.statusCode === 200, status: res.statusCode })
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 'timeout' }) })
    req.on('error', err => resolve({ ok: false, status: err.message }))
    req.end()
  })
  server.close()
  return result
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2))
  if (cfg.printCommand) {
    console.log(sshCommand(cfg).display)
    return
  }

  let ssh = null
  let stopped = false

  const startSsh = () => {
    if (cfg.noSsh) return
    const { command, args, display } = sshCommand(cfg)
    console.log(JSON.stringify({ event: 'ssh-start', command: display }))
    ssh = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    ssh.stderr.on('data', d => process.stderr.write(`[ssh] ${d}`))
    ssh.on('exit', code => {
      if (stopped) return
      console.error(JSON.stringify({ event: 'ssh-exit', code }))
      process.exit(code || 1)
    })
  }

  startSsh()
  if (!cfg.noSsh) await waitForPort({ host: cfg.socksHost, port: cfg.socksPort })

  if (cfg.check) {
    const r = await checkOnce(cfg)
    console.log(JSON.stringify({ event: 'check', target: cfg.allow[0], ...r }))
    stopped = true
    if (ssh) ssh.kill()
    process.exit(r.ok ? 0 : 1)
  }

  const server = createBridge(cfg)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.listenPort, cfg.listenHost, resolve)
  })
  console.log(JSON.stringify({
    event: 'listening',
    listen: `${cfg.listenHost}:${cfg.listenPort}`,
    socks: `${cfg.socksHost}:${cfg.socksPort}`,
    allow: cfg.allow,
    ssh: cfg.noSsh ? null : cfg.target,
  }))

  const shutdown = () => {
    stopped = true
    server.close()
    if (ssh) ssh.kill()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(JSON.stringify({ event: 'fatal', message: err.message }))
    process.exit(1)
  })
}
