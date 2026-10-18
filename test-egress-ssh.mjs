// Offline tests for the SSH egress bridge (zero-window/egress-ssh.mjs).
// A local SOCKS5 server stands in for `ssh -D`, so this needs no real SSH host.
import net from 'node:net'
import http from 'node:http'
import { createBridge, sshCommand } from './zero-window/egress-ssh.mjs'

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`) }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

// Minimal SOCKS5 (no auth) used as the ssh -D stand-in.
function startSocks(port) {
  const server = net.createServer(client => {
    let buf = Buffer.alloc(0)
    let phase = 'greeting'
    let upstream = null
    client.on('error', () => {})
    client.on('data', chunk => {
      if (upstream) { upstream.write(chunk); return }
      buf = Buffer.concat([buf, chunk])
      if (phase === 'greeting') {
        if (buf.length < 2) return
        if (buf[0] !== 0x05) { client.destroy(); return }
        const nmethods = buf[1]
        if (buf.length < 2 + nmethods) return
        client.write(Buffer.from([0x05, 0x00]))
        buf = buf.subarray(2 + nmethods)
        phase = 'request'
      }
      if (phase === 'request') {
        if (process.env.EGRESS_SSH_DEBUG) console.error(`[socks-test] request bytes=${buf.length} atyp=${buf[3]}`)
        if (buf.length < 5) return
        const atyp = buf[3]
        let host, port, need
        if (atyp === 0x01) {
          need = 4 + 4 + 2
          if (buf.length < need) return
          host = [...buf.subarray(4, 8)].join('.')
          port = buf.readUInt16BE(8)
        } else if (atyp === 0x03) {
          const len = buf[4]
          need = 4 + 1 + len + 2
          if (buf.length < need) return
          host = buf.subarray(5, 5 + len).toString('utf8')
          port = buf.readUInt16BE(5 + len)
        } else {
          client.destroy(); return
        }
        const rest = buf.subarray(need)
        phase = 'pipe'
        upstream = net.connect({ host, port }, () => {
          if (process.env.EGRESS_SSH_DEBUG) console.error(`[socks-test] upstream connected ${host}:${port}`)
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          if (rest.length) upstream.write(rest)
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.on('error', () => {
          if (process.env.EGRESS_SSH_DEBUG) console.error(`[socks-test] upstream error ${host}:${port}`)
          client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        })
        upstream.on('close', () => client.destroy())
        client.on('close', () => upstream.destroy())
      }
    })
  })
  return server
}

function connectThrough(port, target) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target, timeout: 4000 })
    let done = false
    const finish = v => { if (!done) { done = true; resolve(v) } }
    req.on('connect', (res, socket) => finish({ status: res.statusCode, socket }))
    req.on('response', res => { res.resume(); finish({ status: res.statusCode, socket: null }) })
    req.on('timeout', () => { req.destroy(); finish({ status: 'timeout', socket: null }) })
    req.on('error', err => finish({ status: err.message, socket: null }))
    req.end()
  })
}

function readHttp(socket) {
  return new Promise(resolve => {
    let data = ''
    socket.on('data', c => { data += c.toString('utf8') })
    socket.on('end', () => resolve(data))
    socket.on('error', () => resolve(data))
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
    setTimeout(() => resolve(data), 3000)
  })
}

async function main() {
  console.log('== ssh command ==')
  const cmd = sshCommand({ target: 'root@example.com', socksHost: '127.0.0.1', socksPort: 1080, sshArgs: [] })
  ok('uses -N', cmd.args.includes('-N'))
  ok('forwards dynamic socks', cmd.args.join(' ').includes('-D 127.0.0.1:1080'))
  ok('fails fast on forward error', cmd.args.includes('ExitOnForwardFailure=yes'))
  ok('keeps host key on first use', cmd.args.includes('StrictHostKeyChecking=accept-new'))
  ok('target is last', cmd.args[cmd.args.length - 1] === 'root@example.com')

  console.log('== bridge ==')
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('EGRESS-OK')
  })
  await listen(target, 18080)
  const socks = startSocks(11080)
  await listen(socks, 11080)

  const bridge = createBridge({
    socksHost: '127.0.0.1',
    socksPort: 11080,
    listenHost: '127.0.0.1',
    listenPort: 41801,
    allow: ['127.0.0.1:18080'],
    connectTimeoutMs: 4000,
  })
  await listen(bridge, 41801)

  const good = await connectThrough(41801, '127.0.0.1:18080')
  ok('allowed CONNECT returns 200', good.status === 200, String(good.status))
  if (good.socket) {
    const body = await readHttp(good.socket)
    ok('payload traverses the tunnel', body.includes('EGRESS-OK'), body.slice(0, 80))
    good.socket.destroy()
  } else {
    ok('payload traverses the tunnel', false, 'no socket')
  }

  const denied = await connectThrough(41801, '127.0.0.1:18081')
  ok('disallowed target returns 403', denied.status === 403, String(denied.status))

  const deadBridge = createBridge({
    socksHost: '127.0.0.1',
    socksPort: 11081,
    listenHost: '127.0.0.1',
    listenPort: 41802,
    allow: ['127.0.0.1:18080'],
    connectTimeoutMs: 2000,
  })
  await listen(deadBridge, 41802)
  const dead = await connectThrough(41802, '127.0.0.1:18080')
  ok('dead socks returns 502', dead.status === 502, String(dead.status))

  bridge.close()
  deadBridge.close()
  socks.close()
  target.close()
  await new Promise(r => setTimeout(r, 200))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(err => {
  console.error('FATAL', err)
  process.exit(1)
})
