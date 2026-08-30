'use client'

/**
 * MemorySynapseField —— 记忆突触场(demo-e 定稿算法,往 app 的迁移版)
 *
 * 漂移节点星群,靠近时扯出突触连线,信号弧沿连线奔流;候选亮点被最近节点
 * 缓慢拉近(「保留到画像」隐喻)。network 偏右,配合左侧容量文字的渐隐 mask。
 *
 * 色板取自 design tokens（鼠尾草 / 赤陶 / 赭石），与比赛版单一暖色主题一致；
 * MULTIPLY 混合在浅色底不糊;reduced-motion 渲染一帧静态。
 */
import { useEffect, useRef } from 'react'
import styles from './MemorySynapseField.module.css'

type Fam = 0 | 1 | 2

interface Node {
  x: number; y: number; ax: number; ay: number; seed: number; r: number; fam: Fam
}
interface Signal { a: number; b: number; u: number; v: number }
interface Cand { x: number; y: number; fam: Fam; age: number; life: number; wobble: number; target: number }

const NODES = 24
const LINK_D = 132
const SIGNALS = 16
const CANDS = 7

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 轻量 value-noise(节点漂移用,不必 p5 的 perlin)
function makeNoise(rand: () => number) {
  const perm = Array.from({ length: 512 }, (_, i) => (i < 256 ? rand() : 0))
  for (let i = 256; i < 512; i++) perm[i] = perm[i - 256]!
  const fade = (t: number) => t * t * (3 - 2 * t)
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y)
    const xf = x - xi, yf = y - yi
    const g = (ix: number, iy: number) => perm[((ix & 255) + ((iy & 255) << 8)) & 511]!
    const a = g(xi, yi), b = g(xi + 1, yi), c = g(xi, yi + 1), d = g(xi + 1, yi + 1)
    const u = fade(xf), v = fade(yf)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
  }
}

export function MemorySynapseField({ className = '' }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // 从 design tokens 取色(转 rgb 供 canvas alpha 合成)
    const css = getComputedStyle(document.documentElement)
    const read = (name: string, fallback: string) => {
      const v = css.getPropertyValue(name).trim()
      return v || fallback
    }
    const hexToRgb = (hex: string): [number, number, number] => {
      const h = hex.replace('#', '')
      const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    const fams: [number, number, number][] = [
      hexToRgb(read('--mem-fam-a', '#74806a')),
      hexToRgb(read('--mem-fam-b', read('--brand-primary', '#5d77ad'))),
      hexToRgb(read('--mem-fam-c', '#b58a57')),
    ]
    const linkRgb = hexToRgb(read('--mem-link', '#a66c58'))
    const bgRgb = hexToRgb(read('--paper', '#ffffff'))
    const fieldBlend: GlobalCompositeOperation = 'multiply'
    const boost = 1
    const boostFill = 1
    const trailCover = 56 / 255

    let width = host.clientWidth
    let height = host.clientHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)

    const rand = mulberry32(271828)
    const noise = makeNoise(rand)

    const famOf = (r: number): Fam => (r < 0.45 ? 0 : r < 0.78 ? 1 : 2)
    // 泊松盘采样:最小间距约束下的有机随机——间距受控(不碎)但形态天然(不呆板)
    const nodes: Node[] = []
    {
      const region = { x0: width * 0.36, x1: width - 22, y0: 18, y1: height - 18 }
      const minD = 96
      let guard = 0
      while (nodes.length < NODES && guard < 5000) {
        guard++
        const x = region.x0 + rand() * (region.x1 - region.x0)
        const y = region.y0 + rand() * (region.y1 - region.y0)
        if (nodes.every((n) => Math.hypot(n.x - x, n.y - y) >= minD)) {
          nodes.push({
            x, y, ax: x, ay: y,
            seed: rand() * 1000,
            r: 1.5 + rand() * 1.5,
            fam: famOf(rand()),
          })
        }
      }
      // 兜底:采样不足时补随机点(宽间距优先)
      while (nodes.length < NODES) {
        const x = region.x0 + rand() * (region.x1 - region.x0)
        const y = region.y0 + rand() * (region.y1 - region.y0)
        nodes.push({ x, y, ax: x, ay: y, seed: rand() * 1000, r: 1.5 + rand() * 1.5, fam: famOf(rand()) })
      }
    }
    const signals: Signal[] = Array.from({ length: SIGNALS }, () => ({
      a: -1, b: -1, u: rand(), v: 0.008 + rand() * 0.010,
    }))
    // 按距离权重随机选结合目标:近的大概率,但也会奔远处(更像记忆联想)
    const pickTarget = (cd: Cand): number => {
      let total = 0
      const weights = nodes.map((n) => {
        const d = Math.hypot(cd.x - n.x, cd.y - n.y)
        const w = 1 / (30 + d * d * 0.002)
        total += w
        return w
      })
      let r = rand() * total
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i]!
        if (r <= 0) return i
      }
      return weights.length - 1
    }
    const spawnCand = (anywhere: boolean): Cand => {
      const cd: Cand = {
        x: anywhere ? rand() * width * 0.9 : -30 + rand() * (width * 0.22 + 30),
        y: height * (0.2 + rand() * 0.6),
        fam: famOf(rand()),
        age: 0, life: 400 + rand() * 500,
        wobble: rand() * Math.PI * 2,
        target: -1,
      }
      cd.target = pickTarget(cd)
      return cd
    }
    const cands: Cand[] = Array.from({ length: CANDS }, () => spawnCand(true))

    const paintBase = (alpha: number) => {
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = `rgba(${bgRgb[0]},${bgRgb[1]},${bgRgb[2]},${alpha})`
      ctx.fillRect(0, 0, width, height)
    }

    let links: [number, number, number][] = []
    const frame = (t: number) => {
      paintBase(trailCover)

      // 节点慢漂移 + 漫游半径 tether(超出才被拉回,不散架不钉死)+ 微脉动(不冻结)
      for (const n of nodes) {
        const dxA = n.x - n.ax, dyA = n.y - n.ay
        const dA = Math.hypot(dxA, dyA)
        const tether = dA > 40 ? (dA - 40) * 0.03 : 0    // 漫游半径 40px;超出后拉力快速压过漂移
        n.x += (noise(n.seed, t * 0.26) - 0.5) * 0.7
          + Math.sin(t * 0.7 + n.seed) * 0.06
          - dxA * 0.0006 - (dxA / Math.max(1, dA)) * tether
        n.y += (noise(n.seed + 500, t * 0.26) - 0.5) * 0.7
          + Math.cos(t * 0.6 + n.seed * 1.3) * 0.06
          - dyA * 0.0006 - (dyA / Math.max(1, dA)) * tether
        // 网络限定右半区,不进左侧文字渐隐 mask
        n.x = Math.min(Math.max(n.x, width * 0.34), width - 20)
        n.y = Math.min(Math.max(n.y, 16), height - 16)
      }
      // 邻接(距离阈值)
      links = []
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i]!.x - nodes[j]!.x, dy = nodes[i]!.y - nodes[j]!.y
          const d = Math.hypot(dx, dy)
          if (d < LINK_D) links.push([i, j, d])
        }
      }
      // 保底连通:每个节点和它的最近邻连一条(无视距离)——网络永远是一张网,不碎
      for (let i = 0; i < nodes.length; i++) {
        let best = -1, bd = Infinity
        for (let j = 0; j < nodes.length; j++) {
          if (j === i) continue
          const d = Math.hypot(nodes[i]!.x - nodes[j]!.x, nodes[i]!.y - nodes[j]!.y)
          if (d < bd) { bd = d; best = j }
        }
        if (best >= 0 && !links.some(([a, b]) => (a === i && b === best) || (a === best && b === i))) {
          links.push([i, best, bd])
        }
      }
      ctx.globalCompositeOperation = fieldBlend
      // 突触连线
      for (const [i, j, d] of links) {
        const a = (52 - (d / LINK_D) * 45) * boost
        ctx.strokeStyle = `rgba(${linkRgb[0]},${linkRgb[1]},${linkRgb[2]},${Math.min(1, a / 255)})`
        ctx.lineWidth = 0.75
        ctx.beginPath()
        ctx.moveTo(nodes[i]!.x, nodes[i]!.y)
        ctx.lineTo(nodes[j]!.x, nodes[j]!.y)
        ctx.stroke()
      }
      // 信号沿突触传导
      for (const s of signals) {
        if (s.a < 0 || s.u >= 1) {
          if (links.length) {
            const L = links[Math.floor(rand() * links.length)]!
            s.a = L[0]; s.b = L[1]; s.u = 0; s.v = 0.008 + rand() * 0.010
          } else continue
        }
        s.u += s.v
        const A = nodes[s.a]!, B = nodes[s.b]!
        const head = Math.min(1, s.u), tail = Math.max(0, s.u - 0.18)
        const c = fams[B.fam]!
        for (let k = 0; k < 6; k++) {
          const u0 = tail + (head - tail) * (k / 6), u1 = tail + (head - tail) * ((k + 1) / 6)
          ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, ((18 + (k / 6) * 132) * boost) / 255)})`
          ctx.lineWidth = 0.7 + (k / 6) * 1.5
          ctx.beginPath()
          ctx.moveTo(A.x + (B.x - A.x) * u0, A.y + (B.y - A.y) * u0)
          ctx.lineTo(A.x + (B.x - A.x) * u1, A.y + (B.y - A.y) * u1)
          ctx.stroke()
        }
        ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, (140 * boostFill) / 255)})`
        ctx.beginPath()
        ctx.arc(A.x + (B.x - A.x) * head, A.y + (B.y - A.y) * head, 1.3, 0, Math.PI * 2)
        ctx.fill()
      }
      // 候选信号:亮、活,奔向一个(按距离权重随机的)目标节点
      for (let i = 0; i < cands.length; i++) {
        const cd = cands[i]!
        cd.age++
        const target = nodes[cd.target] ?? null
        if (target) {
          const pull = 0.010 + Math.min(0.02, cd.age * 0.00004)
          cd.x += (target.x - cd.x) * pull
          cd.y += (target.y - cd.y) * pull
        }
        // wobble 只作用于 y;x 由目标拉力主导,左侧有软回推——不被洗出左缘 mask
        cd.y += Math.cos(t * 1.7 + cd.wobble) * 0.45
        if (cd.x < width * 0.22) cd.x += 0.5
        cd.x = Math.min(Math.max(cd.x, 12), width - 12)
        cd.y = Math.min(Math.max(cd.y, 12), height - 12)
        const bd = target ? Math.hypot(cd.x - target.x, cd.y - target.y) : 1e9
        const fade = Math.min(1, cd.age / 50)
        const c = fams[cd.fam]!
        ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, (26 * fade * boostFill) / 255)})`
        ctx.beginPath(); ctx.arc(cd.x, cd.y, 6.5, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, (165 * fade * boostFill) / 255)})`
        ctx.beginPath(); ctx.arc(cd.x, cd.y, 1.7, 0, Math.PI * 2); ctx.fill()
        if (bd < 7 || cd.age > cd.life || cd.x > width + 30) cands[i] = spawnCand(false)
      }
      // 节点(呼吸)
      for (const n of nodes) {
        const c = fams[n.fam]!
        const pulse = 1 + Math.sin(t * 1.4 + n.seed) * 0.16
        ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${Math.min(1, (120 * boostFill) / 255)})`
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r * pulse, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    const resize = () => {
      width = host.clientWidth
      height = host.clientHeight
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    paintBase(1)

    if (reduced) {
      frame(3.2) // 静态一帧
      return
    }

    let raf = 0
    let t = 0
    let last: number | null = null
    const tick = (now: number) => {
      if (last === null) { last = now; raf = requestAnimationFrame(tick); return }
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      t += dt * 1.05
      frame(t)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const ro = new ResizeObserver(() => { resize(); paintBase(1) })
    ro.observe(host)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  return (
    <div ref={hostRef} className={`${styles.synapseHost} ${className}`} aria-hidden>
      <canvas ref={canvasRef} />
    </div>
  )
}
