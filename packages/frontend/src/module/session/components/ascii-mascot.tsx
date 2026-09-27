export { AsciiMascot }

import { useEffect, useRef } from "react"
import { Future, type Cancel } from "@lib/future"
import { Just, Nothing, catMaybes, fromNullable, fromOptional, type Maybe } from "@lib/maybe"
import { cn } from "@components/utils"

const MONO = '"Space Mono", ui-monospace, monospace'
/** Brightness ramp, empty to dense. */
const RAMP = " .·:-=+*#%@"
/** Glyphs a torn row shows. */
const SCRAMBLE = "abcdefghijklmnopqrstuvwxyz0123456789/+-=_<>{}[]#%@"
/** Characters across the panel; sets the font size, clamped to 5.5–12px. */
const DENSITY = 56
/** The head builds from the bottom up in this long; hover, peel and glitch wait for it. */
const REVEAL_MS = 1500
const TEAR_MS = 450
/** One character peels off the edge this often. */
const PEEL_EVERY_MS = 140
/** A peeled cell redraws with a flash this long. */
const FLASH_MS = 180
/** Reduced motion draws this moment: the head built, the scan band off-screen. */
const STILL_AT = 9450

type Point = { readonly x: number; readonly y: number }

type Grid = {
  readonly width: number
  readonly height: number
  readonly cw: number
  readonly ch: number
  readonly cols: number
  readonly rows: number
}

/** One drawable character of the head; empty positions are dropped when sampling. */
type Cell = {
  readonly x: number
  readonly y: number
  readonly cx: number
  readonly cy: number
  /** Mascot brightness under the cell: 0 empty, 1 the white face. */
  readonly v: number
  readonly char: string
  readonly alpha: number
  /** Stable per-cell noise in [0, 1). */
  readonly seed: number
  /** When the cell appears, counted from the start of a build. */
  readonly delay: number
}

type Scene = {
  readonly grid: Grid
  readonly cells: ReadonlyArray<Cell>
  /** Brightness of every grid position, row-major; the double-click hit test reads it. */
  readonly brightness: ReadonlyArray<number>
  /** Indices into `cells` on the silhouette edge, where characters peel from. */
  readonly edge: ReadonlyArray<number>
}

type Stage = { readonly ctx: CanvasRenderingContext2D; readonly scene: Scene }

type Glitch = { readonly type: "idle" } | { readonly type: "tearing"; readonly at: number }

/** A character lifting off the edge; its path is a function of the time since `at`. */
type Peel = {
  readonly cell: number
  readonly at: number
  readonly life: number
  readonly vx: number
  readonly vy: number
}

type Motion = {
  /** Pointer position, eased toward the real one. */
  readonly pointer: Point
  /** Hover strength: eases to 1 while the pointer is over the panel and back to 0 after. */
  readonly weight: number
  readonly glitch: Glitch
  /** Start of the current build: 0 on mount, the end of the last tear after a glitch. */
  readonly builtAt: number
  readonly peels: ReadonlyArray<Peel>
  /** Last peel slot spawned, so each slot spawns once. */
  readonly slot: number
}

/** What to draw for one character: glyph, opacity and top-left position. */
type Look = { readonly glyph: string; readonly alpha: number; readonly x: number; readonly y: number }

const REST: Motion = { pointer: { x: 0, y: 0 }, weight: 0, glitch: { type: "idle" }, builtAt: 0, peels: [], slot: 0 }

/** The sign-in panel: the mascot head in ASCII. Characters slide away from the pointer and peel off the edge; a double-click on the head tears it and it rebuilds. */
function AsciiMascot({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(
    () =>
      fromNullable(canvasRef.current).maybe<Cancel | undefined>(undefined, (canvas) => {
        let stop: Cancel = () => {}
        // Decorative: if the mascot fails to load, the panel stays black.
        const cancel = loadMascot().fork(
          () => {},
          (img) => {
            stop = run(canvas, img)
          }
        )
        return () => {
          cancel()
          stop()
        }
      }),
    []
  )

  return (
    <div aria-hidden className={cn("relative overflow-hidden bg-black select-none", className)}>
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      {/* The brand's dark lockup, split to the corners: the wordmark asset itself and the tagline set as in og-image.svg.
          The panel is black in both themes, so both keep the dark variant's #f8f8f2 ink and #7da75b green (identity artwork, design-system.md:73).
          pointer-events-none keeps hover and double-click on the canvas. */}
      <div className="pointer-events-none absolute inset-x-5 top-4.5 flex items-center justify-between gap-3">
        <img src={`${import.meta.env.BASE_URL}brand/wordmark-dark.svg`} alt="" className="h-3.5 w-auto" />
        <p className="font-mono text-[11px] text-[#f8f8f2]/70">
          your <span className="font-bold text-[#7da75b]">job</span> search, made{" "}
          <span className="font-bold text-[#7da75b]">simpler</span>.
        </p>
      </div>
    </div>
  )
}

/* ---------- loading: the one place Promises become a Future ---------- */

/** The mascot, minus the `<style>` whose dark-scheme keyline would brighten its outlines, once Space Mono is ready to measure too. */
function loadMascot(): Future<Error, HTMLImageElement> {
  return Future.both(
    fetchMascot().chain((svg) => Future.attemptP(() => decodeSvg(svg.replace(/<style>[\s\S]*?<\/style>/, "")))),
    Future.attemptP(() => document.fonts.load(`12px ${MONO}`))
  ).map(([img]) => img)
}

/** The mascot's fetch boundary. Cancelling aborts the request. */
function fetchMascot(): Future<Error, string> {
  return Future.create<Error, string>((reject, resolve) => {
    const controller = new AbortController()
    fetch(`${import.meta.env.BASE_URL}brand/mascot-mark.svg`, { signal: controller.signal })
      .then((res) => res.text())
      .then(resolve)
      .catch((err: unknown) => {
        // An abort is our own cancel, not a failure anyone is still listening for.
        if (!controller.signal.aborted) reject(err instanceof Error ? err : new Error(String(err)))
      })
    return () => controller.abort()
  })
}

async function decodeSvg(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))
  const img = new Image()
  img.src = url
  try {
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

/* ---------- staging: canvas and pixels in, a Scene out ---------- */

/** Sizes the canvas to its box at device resolution and samples the mascot into it. Nothing while the panel is hidden below md. */
function stage(canvas: HTMLCanvasElement, img: HTMLImageElement): Maybe<Stage> {
  const { width, height } = canvas.getBoundingClientRect()
  if (width === 0 || height === 0) return Nothing()
  return fromNullable(canvas.getContext("2d")).chain((ctx) => {
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const fontPx = Math.max(5.5, Math.min(12, width / DENSITY))
    ctx.font = `${fontPx}px ${MONO}`
    ctx.textBaseline = "top"
    const cw = ctx.measureText("M").width
    const ch = Math.round(fontPx * 1.4)
    const grid: Grid = { width, height, cw, ch, cols: Math.ceil(width / cw), rows: Math.ceil(height / ch) }
    return rasterize(img, grid).map((pixels) => ({ ctx, scene: sample(pixels, grid) }))
  })
}

/** The mascot at panel size: a touch wider than the panel and anchored to the bottom, so a taller panel only adds black above. */
function rasterize(img: HTMLImageElement, grid: Grid): Maybe<ImageData> {
  const off = document.createElement("canvas")
  off.width = Math.ceil(grid.width)
  off.height = Math.ceil(grid.height)
  return fromNullable(off.getContext("2d", { willReadFrequently: true })).map((octx) => {
    const size = Math.min(grid.width * 1.02, grid.height * 0.78)
    octx.drawImage(img, grid.width / 2 - size / 2, grid.height - size * 0.97, size, size)
    return octx.getImageData(0, 0, off.width, off.height)
  })
}

/** A character for every lit grid position: the white face goes dense, the black hair and outlines a dim texture. */
function sample(pixels: ImageData, grid: Grid): Scene {
  const { cw, ch, cols, rows } = grid
  const brightness = Array.from({ length: cols * rows }, (_, i) =>
    cellBrightness(pixels, grid, i % cols, Math.floor(i / cols))
  )
  const vAt = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= cols || y >= rows ? 0 : (brightness[y * cols + x] ?? 0)
  const cells = brightness.flatMap((v, i): Cell[] => {
    const x = i % cols
    const y = Math.floor(i / cols)
    const seed = noise(x, y)
    const ramp = RAMP.charAt(Math.round(Math.pow(v, 0.85) * (RAMP.length - 1)))
    // A few stray dots keep the black from reading flat.
    const [char, alpha]: [string, number] =
      ramp !== " " ? [ramp, 0.14 + 0.86 * v * v]
      : seed < 0.05 ? [".", 0.12]
      : [" ", 0]
    return char === " " ?
        []
      : [
          {
            x,
            y,
            cx: (x + 0.5) * cw,
            cy: (y + 0.5) * ch,
            v,
            char,
            alpha,
            seed,
            delay: (1 - y / rows) * 1100 + noise(y, x) * 350,
          },
        ]
  })
  // The silhouette edge: a solid cell beside an empty one.
  const edge = cells.flatMap((c, i) =>
    c.v > 0.3 && [vAt(c.x, c.y - 1), vAt(c.x + 1, c.y), vAt(c.x - 1, c.y), vAt(c.x, c.y + 1)].some((n) => n < 0.12) ?
      [i]
    : []
  )
  return { grid, cells, brightness, edge }
}

/** Mean of every other pixel under one cell: alpha-weighted, lightness squared so the face separates from the ink. */
function cellBrightness({ data, width, height }: ImageData, grid: Grid, x: number, y: number): number {
  let sum = 0
  let n = 0
  for (let py = y * grid.ch; py < Math.min(height, (y + 1) * grid.ch); py += 2) {
    for (let px = Math.floor(x * grid.cw); px < Math.min(width, Math.floor((x + 1) * grid.cw)); px += 2) {
      const i = (py * width + px) * 4
      const lum = ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 765
      sum += ((data[i + 3] ?? 0) / 255) * (0.1 + 0.9 * lum * lum)
      n++
    }
  }
  return n === 0 ? 0 : sum / n
}

/* ---------- motion: pure transitions ---------- */

/** Advances what moves on its own: hover easing, the tear and rebuild, the peels. */
function step(scene: Scene, motion: Motion, target: Maybe<Point>, t: number): Motion {
  const { glitch, builtAt } = settle(motion, t)
  const slot = Math.floor(t / PEEL_EVERY_MS)
  const alive = motion.peels.filter((p) => t - p.at < p.life + FLASH_MS)
  const fresh = t - builtAt > REVEAL_MS && slot > motion.slot ? spawnPeel(scene, alive, slot, t) : Nothing<Peel>()
  return {
    pointer: target.maybe(motion.pointer, (p) => ({
      x: motion.pointer.x + (p.x - motion.pointer.x) * 0.35,
      y: motion.pointer.y + (p.y - motion.pointer.y) * 0.35,
    })),
    weight: motion.weight + (target.maybe(0, () => 1) - motion.weight) * 0.12,
    glitch,
    builtAt,
    peels: fresh.maybe(alive, (p) => [...alive, p]),
    slot,
  }
}

/** A tear that has run its course becomes a rebuild from the bottom. */
function settle(motion: Motion, t: number): Pick<Motion, "glitch" | "builtAt"> {
  const { glitch } = motion
  switch (glitch.type) {
    case "idle":
      return { glitch, builtAt: motion.builtAt }
    case "tearing":
      return t - glitch.at < TEAR_MS ? { glitch, builtAt: motion.builtAt } : { glitch: { type: "idle" }, builtAt: t }
    default: {
      const _exhaustiveCheck: never = glitch
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

/** Lifts the edge character this slot's noise picks, unless it is already airborne. */
function spawnPeel(scene: Scene, peels: ReadonlyArray<Peel>, slot: number, t: number): Maybe<Peel> {
  return fromOptional(scene.edge[Math.floor(noise(slot, 1) * scene.edge.length)]).chain<Peel>((cell) =>
    peels.some((p) => p.cell === cell) ? Nothing() : (
      Just({
        cell,
        at: t,
        life: 2400 + noise(slot, 2) * 1600,
        vx: 10 + noise(slot, 3) * 22,
        vy: -(6 + noise(slot, 4) * 16),
      })
    )
  )
}

/** A double-click on the head, once it is built and not already tearing, starts a tear. */
function tear(scene: Scene, motion: Motion, at: Point, t: number): Motion {
  const { cw, ch, cols } = scene.grid
  const col = Math.floor(at.x / cw)
  const row = Math.floor(at.y / ch)
  const onHead = [-1, 0, 1].some((j) =>
    [-1, 0, 1].some((i) => col + i >= 0 && col + i < cols && (scene.brightness[(row + j) * cols + col + i] ?? 0) > 0.08)
  )
  return motion.glitch.type === "idle" && t - motion.builtAt > REVEAL_MS && onHead ?
      { ...motion, glitch: { type: "tearing", at: t } }
    : motion
}

/* ---------- looks: pure, one character at time t ---------- */

/** How one cell draws at `t`, or Nothing while it is unbuilt or peeled away. `landed` is ms since its peel ended, negative while airborne. */
function look(scene: Scene, motion: Motion, cell: Cell, landed: Maybe<number>, t: number): Maybe<Look> {
  const age = t - motion.builtAt - cell.delay
  if (age < 0 || landed.maybe(false, (ms) => ms < 0)) return Nothing()
  const { cw, ch, rows, width } = scene.grid
  const tearStep = motion.glitch.type === "tearing" ? Just(Math.floor((t - motion.glitch.at) / 70)) : Nothing<number>()
  const shimmer = noise(cell.seed * 997, Math.floor(t / 260)) < 0.016 && cell.v > 0.12
  const glyph =
    age < 140 ?
      RAMP.charAt(1 + ((cell.x + cell.y + Math.floor(t / 40)) % (RAMP.length - 1))) // flickers in
    : tearStep instanceof Just && cell.v > 0.05 && cell.seed < 0.3 ?
      SCRAMBLE.charAt((tearStep.value * 7 + Math.floor(cell.seed * 997)) % SCRAMBLE.length)
    : shimmer ?
      RAMP.charAt(Math.max(1, Math.min(RAMP.length - 1, RAMP.indexOf(cell.char) + (cell.seed < 0.5 ? -1 : 1))))
    : cell.char
  const fromScan = Math.abs(cell.y - (((t / 7000) % 1.4) - 0.2) * rows)
  const alpha = Math.min(
    1,
    Math.max(cell.alpha, age < 140 ? 0.6 : 0) +
      (landed.maybe(false, (ms) => ms < FLASH_MS) ? 0.5 : 0) +
      (fromScan < 2.5 && cell.v > 0.05 ? 0.25 * (1 - fromScan / 2.5) : 0)
  )
  // Repel: pushed away from the eased pointer, scaled by the eased hover weight.
  const dx = cell.cx - motion.pointer.x
  const dy = cell.cy - motion.pointer.y
  const d = Math.hypot(dx, dy) || 1
  const reach = Math.max(80, width * 0.18)
  const push = t - motion.builtAt > REVEAL_MS && d < reach ? (motion.weight * (1 - d / reach)) ** 2 * 24 : 0
  const shift = tearStep.maybe(0, (s) => {
    const n = noise(cell.y, s)
    return n < 0.28 ? Math.round((n / 0.28 - 0.5) * 16) * cw : 0
  })
  return Just({ glyph, alpha, x: cell.x * cw + (dx / d) * push + shift, y: cell.y * ch + (dy / d) * push })
}

/** A peel in flight: drifting on a wind that picks up, thinning down the ramp, snapped to the grid so it stays ASCII. */
function peelLook(scene: Scene, peel: Peel, t: number): Maybe<Look> {
  const { cw, ch } = scene.grid
  const k = (t - peel.at) / peel.life
  const s = (t - peel.at) / 1000
  return k >= 1 ? Nothing() : (
      fromOptional(scene.cells[peel.cell]).map((cell) => ({
        glyph: RAMP.charAt(Math.max(1, Math.round(RAMP.indexOf(cell.char) * (1 - k)))),
        alpha: Math.max(0.35, cell.alpha) * (1 - k),
        x: Math.floor((cell.cx + peel.vx * s + 3 * s * s) / cw) * cw,
        y: Math.floor((cell.cy + peel.vy * s - 2 * s * s) / ch) * ch,
      }))
    )
}

/** Deterministic noise in [0, 1): the same head and the same effects on every visit. */
function noise(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return n - Math.floor(n)
}

/* ---------- the imperative shell ---------- */

function draw({ ctx, scene }: Stage, motion: Motion, t: number): void {
  ctx.clearRect(0, 0, scene.grid.width, scene.grid.height)
  const landed = new Map(motion.peels.map((p) => [p.cell, t - p.at - p.life]))
  const looks = catMaybes([
    ...scene.cells.map((cell, i) => look(scene, motion, cell, fromOptional(landed.get(i)), t)),
    ...motion.peels.map((p) => peelLook(scene, p, t)),
  ])
  for (const { glyph, alpha, x, y } of looks) {
    ctx.fillStyle = `rgba(255,255,255,${alpha})`
    ctx.fillText(glyph, x, y)
  }
}

/** Owns the canvas, the clock and the listeners until the returned cancel. Reduced motion gets one still frame per size and no listeners. */
function run(canvas: HTMLCanvasElement, img: HTMLImageElement): Cancel {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const origin = performance.now()
  let current = stage(canvas, img)
  let motion = REST
  let target: Maybe<Point> = Nothing()
  let raf = 0
  const clock = (now: number): number => (still ? STILL_AT : now - origin)

  const frame = (now: number): void => {
    raf = 0
    const staged = current
    if (!(staged instanceof Just)) return // hidden below md: no loop until a resize shows the panel
    const t = clock(now)
    if (!still) motion = step(staged.value.scene, motion, target, t)
    draw(staged.value, motion, t)
    if (!still) raf = requestAnimationFrame(frame)
  }
  const local = (e: MouseEvent): Point => {
    const box = canvas.getBoundingClientRect()
    return { x: e.clientX - box.left, y: e.clientY - box.top }
  }
  const onMove = (e: PointerEvent): void => {
    target = Just(local(e))
  }
  const onLeave = (): void => {
    target = Nothing()
  }
  const onDoubleClick = (e: MouseEvent): void => {
    const staged = current
    if (staged instanceof Just) motion = tear(staged.value.scene, motion, local(e), clock(performance.now()))
  }
  const resize = new ResizeObserver(() => {
    const { width, height } = canvas.getBoundingClientRect()
    if (current.maybe(false, ({ scene }) => scene.grid.width === width && scene.grid.height === height)) return
    current = stage(canvas, img)
    motion = { ...motion, peels: [] } // peel indices point into the old cells
    // Resizing the canvas cleared it after this frame's draw, and the observer runs before paint: redraw now or the frame paints blank.
    const staged = current
    if (staged instanceof Just) draw(staged.value, motion, clock(performance.now()))
    if (raf === 0) raf = requestAnimationFrame(frame)
  })

  if (!still) {
    canvas.addEventListener("pointermove", onMove)
    canvas.addEventListener("pointerleave", onLeave)
    canvas.addEventListener("dblclick", onDoubleClick)
  }
  resize.observe(canvas)
  raf = requestAnimationFrame(frame)

  return () => {
    cancelAnimationFrame(raf)
    resize.disconnect()
    canvas.removeEventListener("pointermove", onMove)
    canvas.removeEventListener("pointerleave", onLeave)
    canvas.removeEventListener("dblclick", onDoubleClick)
  }
}
