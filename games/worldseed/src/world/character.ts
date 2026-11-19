import * as THREE from 'three'

/** A small cloaked figure built from primitives, with pivots for simple procedural animation. */
export interface Figure {
  root: THREE.Group
  body: THREE.Group
  legL: THREE.Group
  legR: THREE.Group
  armL: THREE.Group
  armR: THREE.Group
  cape: THREE.Group
  scarf: THREE.Mesh
  lamp: THREE.Mesh
  head: THREE.Group
}

export interface FigureColors {
  cloak: string
  trim: string
  skin: string
  scarf: string
  lamp: string
  hat?: 'hood' | 'wide' | 'pointed'
}

function std(
  color: string,
  extra: THREE.MeshStandardMaterialParameters = {}
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true, ...extra })
}

function m(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.set(x, y, z)
  mesh.castShadow = true
  return mesh
}

export function buildFigure(c: FigureColors): Figure {
  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)
  const cloak = std(c.cloak)
  const trim = std(c.trim)
  const skin = std(c.skin)

  const mkLeg = (x: number): THREE.Group => {
    const g = new THREE.Group()
    g.position.set(x, 0.85, 0)
    g.add(m(new THREE.BoxGeometry(0.2, 0.78, 0.22), trim, 0, -0.4, 0))
    g.add(m(new THREE.BoxGeometry(0.24, 0.14, 0.34), std('#2c241f'), 0, -0.8, 0.05))
    body.add(g)
    return g
  }
  const legL = mkLeg(-0.14)
  const legR = mkLeg(0.14)

  body.add(m(new THREE.CylinderGeometry(0.27, 0.42, 0.95, 8), cloak, 0, 1.28, 0))
  body.add(m(new THREE.CylinderGeometry(0.43, 0.45, 0.08, 8), trim, 0, 0.83, 0))

  const mkArm = (x: number): THREE.Group => {
    const g = new THREE.Group()
    g.position.set(x, 1.62, 0)
    g.add(m(new THREE.CylinderGeometry(0.08, 0.11, 0.62, 6), cloak, 0, -0.3, 0))
    g.add(m(new THREE.SphereGeometry(0.08, 6, 4), skin, 0, -0.64, 0))
    body.add(g)
    return g
  }
  const armL = mkArm(-0.36)
  const armR = mkArm(0.36)

  // Lantern hangs from the right hand.
  const lampMat = new THREE.MeshStandardMaterial({
    color: c.lamp,
    emissive: new THREE.Color(c.lamp),
    emissiveIntensity: 2.2
  })
  const lamp = m(new THREE.OctahedronGeometry(0.11, 0), lampMat, 0, -0.85, 0.06)
  lamp.castShadow = false
  armR.add(m(new THREE.BoxGeometry(0.03, 0.16, 0.03), trim, 0, -0.72, 0.06))
  armR.add(lamp)

  const hat = c.hat ?? 'hood'
  const head = new THREE.Group()
  head.position.set(0, 1.92, 0)
  head.add(m(new THREE.SphereGeometry(0.22, 10, 8), skin, 0, 0, 0.04))
  // The back of the head is covered (hair or hood lining), so it never pokes through the hood.
  head.add(m(new THREE.SphereGeometry(0.235, 10, 8), hat === 'hood' ? cloak : trim, 0, 0.02, -0.03))
  // Eyes: two dark dots give the figure a facing.
  const eye = std('#1a1414')
  head.add(m(new THREE.SphereGeometry(0.03, 5, 4), eye, -0.08, 0.02, 0.21))
  head.add(m(new THREE.SphereGeometry(0.03, 5, 4), eye, 0.08, 0.02, 0.21))
  if (hat === 'hood') {
    const hood = m(new THREE.ConeGeometry(0.3, 0.6, 8, 1, true), cloak, 0, 0.13, -0.05)
    hood.rotation.x = -0.35
    ;(hood.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide
    head.add(hood)
  } else if (hat === 'wide') {
    head.add(m(new THREE.CylinderGeometry(0.46, 0.46, 0.04, 12), trim, 0, 0.16, 0))
    head.add(m(new THREE.CylinderGeometry(0.16, 0.2, 0.26, 10), trim, 0, 0.3, 0))
  } else {
    head.add(m(new THREE.ConeGeometry(0.26, 0.7, 8), trim, 0, 0.42, 0))
    head.add(m(new THREE.CylinderGeometry(0.36, 0.36, 0.03, 12), trim, 0, 0.12, 0))
  }
  body.add(head)

  const scarf = m(new THREE.BoxGeometry(0.12, 0.55, 0.04), std(c.scarf), 0.12, -0.32, -0.2)
  const scarfPivot = new THREE.Group()
  scarfPivot.position.set(0, 1.72, -0.12)
  scarfPivot.add(scarf)
  body.add(scarfPivot)
  const collar = m(new THREE.TorusGeometry(0.2, 0.06, 5, 10), std(c.scarf), 0, 1.72, 0)
  collar.rotation.x = Math.PI / 2
  body.add(collar)

  const cape = new THREE.Group()
  cape.position.set(0, 1.7, -0.2)
  const capeGeo = new THREE.PlaneGeometry(0.8, 1.15, 1, 3)
  capeGeo.translate(0, -0.58, 0)
  const capeMesh = new THREE.Mesh(capeGeo, std(c.cloak, { side: THREE.DoubleSide }))
  capeMesh.castShadow = true
  cape.add(capeMesh)
  body.add(cape)

  return { root, body, legL, legR, armL, armR, cape, scarf, lamp, head }
}

/**
 * Animate a figure from its movement state. `stride` is distance walked (drives leg phase).
 */
export function animateFigure(
  f: Figure,
  t: number,
  speed: number,
  stride: number,
  state: { grounded: boolean; swimming: boolean; gliding: boolean }
): void {
  const moving = Math.min(1, speed / 7)
  const phase = stride * 1.25
  const swing = Math.sin(phase) * 0.75 * moving
  if (state.swimming) {
    f.legL.rotation.x = Math.sin(t * 6) * 0.4
    f.legR.rotation.x = -Math.sin(t * 6) * 0.4
    f.armL.rotation.set(-1.4 + Math.sin(t * 3) * 0.6, 0, -0.3)
    f.armR.rotation.set(-1.4 - Math.sin(t * 3) * 0.6, 0, 0.3)
    f.body.position.y = Math.sin(t * 2) * 0.05
    f.body.rotation.x = 0.5
  } else if (state.gliding) {
    f.legL.rotation.x = 0.3
    f.legR.rotation.x = 0.1
    f.armL.rotation.set(0, 0, -1.35)
    f.armR.rotation.set(0, 0, 1.35)
    f.body.rotation.x = 0.35
    f.body.position.y = 0
  } else if (!state.grounded) {
    f.legL.rotation.x = -0.6
    f.legR.rotation.x = 0.3
    f.armL.rotation.set(-0.9, 0, -0.3)
    f.armR.rotation.set(-0.9, 0, 0.3)
    f.body.rotation.x = 0.05
    f.body.position.y = 0
  } else {
    f.legL.rotation.x = swing
    f.legR.rotation.x = -swing
    f.armL.rotation.set(-swing * 0.8, 0, -0.08)
    f.armR.rotation.set(swing * 0.5 - 0.15 * moving, 0, 0.08)
    f.body.position.y =
      Math.abs(Math.cos(phase)) * 0.07 * moving + Math.sin(t * 1.8) * 0.012 * (1 - moving)
    f.body.rotation.x = 0.12 * moving
  }
  const flutter = Math.sin(t * 9 + stride) * 0.06
  f.cape.rotation.x = state.gliding
    ? 1.25 + flutter * 2
    : 0.08 + moving * 0.55 + flutter * moving + (state.grounded ? 0 : 0.5)
  f.scarf.parent!.rotation.x = 0.2 + moving * 0.9 + Math.sin(t * 7) * 0.12 * (0.3 + moving)
  f.head.rotation.y = Math.sin(t * 0.4) * 0.15 * (1 - moving)
}
