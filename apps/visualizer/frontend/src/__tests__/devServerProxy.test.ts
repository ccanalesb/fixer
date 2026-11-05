// @vitest-environment node
import { createServer as createHttpServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer as createViteServer, type ViteDevServer } from 'vite'

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createNetServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const address = s.address()
      const port = typeof address === 'object' && address ? address.port : 0
      s.close(() => done(port))
    })
  })
}

function send(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume()
      done(res.statusCode ?? 0)
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      done(101)
    })
    req.on('error', fail)
    req.end()
  })
}

describe('dev server proxy', () => {
  let backendPort = 0
  let vitePort = 0
  let backend: Server
  let vite: ViteDevServer
  const seen: { path: string; host: string | undefined }[] = []
  const record = (path: string | undefined, headers: IncomingHttpHeaders) =>
    seen.push({ path: path ?? '', host: headers.host })

  beforeAll(async () => {
    backendPort = await freePort()
    vitePort = await freePort()
    backend = createHttpServer((req, res) => {
      record(req.url, req.headers)
      res.end('{}')
    })
    backend.on('upgrade', (req, socket) => {
      record(req.url, req.headers)
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
    await new Promise<void>((done) => backend.listen(backendPort, '127.0.0.1', done))

    process.env.VITE_BACKEND_PORT = String(backendPort)
    vite = await createViteServer({
      configFile: resolve(__dirname, '../../vite.config.ts'),
      root: resolve(__dirname, '../..'),
      logLevel: 'silent',
      server: { port: vitePort, strictPort: true, host: '127.0.0.1', hmr: false },
    })
    await vite.listen()
  })

  afterAll(async () => {
    delete process.env.VITE_BACKEND_PORT
    await vite?.close()
    await new Promise((done) => backend?.close(done))
  })

  it.each(['/api/jobs/active', '/socket.io/?EIO=4&transport=polling'])(
    'forwards %s with the backend’s own Host, which the backend requires',
    async (path) => {
      seen.length = 0
      expect(await send(vitePort, path)).toBe(200)
      expect(seen).toEqual([{ path, host: `localhost:${backendPort}` }])
    },
  )

  it('forwards the socket’s websocket upgrade with the backend’s own Host', async () => {
    seen.length = 0
    const path = '/socket.io/?EIO=4&transport=websocket'
    const status = await send(vitePort, path, {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    })
    expect(status).toBe(101)
    expect(seen).toEqual([{ path, host: `localhost:${backendPort}` }])
  })
})
