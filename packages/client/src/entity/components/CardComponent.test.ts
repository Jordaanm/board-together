import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl, type EntitySerialized } from '../Scene';
import { type SpawnContext } from '../EntityComponent';
import { TransformComponent } from './TransformComponent';
import { MeshComponent } from './MeshComponent';
import { PhysicsComponent } from './PhysicsComponent';
import { FlatViewComponent } from './FlatViewComponent';
import { CardComponent } from './CardComponent';
import { registerCorePrimitives } from '../spawnables';
import { PhysicsWorld } from '../../physics/PhysicsWorld';

let scene: SceneImpl;
let ctx: SpawnContext;

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
});

// Drive PhysicsComponent through one moving → stopped transition with the body
// at the supplied quaternion. Mirrors the helper in DiceComponent.test.ts.
function triggerStopAtOrientation(
  phys: PhysicsComponent,
  qx: number, qy: number, qz: number, qw: number,
): void {
  phys.body.quaternion.set(qx, qy, qz, qw);
  phys.body.velocity.set(1, 0, 0);
  phys.syncToTransform();
  phys.body.velocity.setZero();
  phys.body.angularVelocity.setZero();
  phys.syncToTransform();
}

describe('CardComponent — spawn-time mesh propagation', () => {
  test('face/back URLs propagate into mesh.textureRefs', () => {
    const e = scene.spawn('card', ctx);
    const card = e.getComponent(CardComponent)!;
    const mesh = e.getComponent(MeshComponent)!;
    card.setState({ face: 'face.png', back: 'back.png' });

    expect(mesh.state.textureRefs.face).toBe('face.png');
    expect(mesh.state.textureRefs.back).toBe('back.png');
  });
});

describe('CardComponent — initial FlatView from orientation', () => {
  test('face up at spawn → FlatView gets face URL', () => {
    const e = scene.spawn('card', ctx);
    const card     = e.getComponent(CardComponent)!;
    const flatview = e.getComponent(FlatViewComponent)!;
    card.setState({ face: 'face.png', back: 'back.png' });

    expect(flatview.state.textureRef).toBe('face.png');
  });

  test('face down at load → FlatView gets back URL', () => {
    scene = new SceneImpl();
    ctx = { ...ctx, entityScene: scene };
    const flippedQuat: [number, number, number, number] = [1, 0, 0, 0]; // 180° around X
    const snap: EntitySerialized = {
      id:            'card-1',
      type:          'card',
      name:          'Card-card-1',
      tags:          ['card'],
      owner:         null,
      privateToSeat: null,
      parentId:      null,
      children:      [],
      components: {
        transform: { position: [0, 0, 0], rotation: flippedQuat, scale: [1, 1, 1] },
        mesh:      { meshRef: 'prim:card', textureRefs: { face: '', back: '' }, color: '#fafafa', width: 0.63, height: 0.01, depth: 0.88 },
        physics:   { mass: 0.05, friction: 0.6, restitution: 0.1, isLocked: false, yawOnly: true },
        value:     { value: '', isNumeric: false },
        flatview:  { textureRef: '' },
        tween:     {},
        card:      { face: 'face.png', back: 'back.png', category: '' },
      },
    };

    const [e] = scene.load([snap], ctx);
    expect(e.getComponent(FlatViewComponent)!.state.textureRef).toBe('back.png');
  });
});

describe('CardComponent — physics stop-moving updates FlatView', () => {
  test('flipping to face down updates FlatView to back URL', () => {
    const e = scene.spawn('card', ctx);
    const card     = e.getComponent(CardComponent)!;
    const phys     = e.getComponent(PhysicsComponent)!;
    const flatview = e.getComponent(FlatViewComponent)!;
    card.setState({ face: 'face.png', back: 'back.png' });
    expect(flatview.state.textureRef).toBe('face.png');

    // 180° around X — face down
    triggerStopAtOrientation(phys, 1, 0, 0, 0);
    expect(flatview.state.textureRef).toBe('back.png');

    // Flip back upright
    triggerStopAtOrientation(phys, 0, 0, 0, 1);
    expect(flatview.state.textureRef).toBe('face.png');
  });
});

describe('CardComponent — round-trip', () => {
  test('face / back / category survive JSON serialise / deserialise', () => {
    const e = scene.spawn('card', ctx, { id: 'card-rt' });
    const card = e.getComponent(CardComponent)!;
    card.setState({ face: 'F.png', back: 'B.png', category: 'spades' });

    const cloned = JSON.parse(JSON.stringify(card.toJSON())) as CardComponent['state'];
    expect(cloned).toEqual({ face: 'F.png', back: 'B.png', category: 'spades' });
  });
});

describe('CardComponent — onDespawn unsubscribes', () => {
  test('post-despawn stop-moving event does not write into FlatView', () => {
    const e = scene.spawn('card', ctx);
    const card     = e.getComponent(CardComponent)!;
    const phys     = e.getComponent(PhysicsComponent)!;
    const flatview = e.getComponent(FlatViewComponent)!;
    card.setState({ face: 'face.png', back: 'back.png' });

    // Baseline — face up.
    expect(flatview.state.textureRef).toBe('face.png');

    scene.despawn(e.id, ctx);

    // After despawn the subscription must be gone — driving stop-moving with
    // a flipped orientation must NOT write back.png into FlatView.
    triggerStopAtOrientation(phys, 1, 0, 0, 0);
    expect(flatview.state.textureRef).toBe('face.png');
  });
});

describe('CardComponent — onPropertiesChanged', () => {
  test('changing face re-pushes to mesh and re-resolves FlatView', () => {
    const e = scene.spawn('card', ctx);
    const card     = e.getComponent(CardComponent)!;
    const mesh     = e.getComponent(MeshComponent)!;
    const flatview = e.getComponent(FlatViewComponent)!;
    card.setState({ face: 'old-face.png', back: 'back.png' });
    expect(flatview.state.textureRef).toBe('old-face.png');

    card.setState({ face: 'new-face.png' });
    expect(mesh.state.textureRefs.face).toBe('new-face.png');
    expect(flatview.state.textureRef).toBe('new-face.png');
  });

  test('changing back updates mesh; FlatView stays on face when face up', () => {
    const e = scene.spawn('card', ctx);
    const card     = e.getComponent(CardComponent)!;
    const mesh     = e.getComponent(MeshComponent)!;
    const flatview = e.getComponent(FlatViewComponent)!;
    card.setState({ face: 'face.png', back: 'old-back.png' });
    expect(flatview.state.textureRef).toBe('face.png');

    card.setState({ back: 'new-back.png' });
    expect(mesh.state.textureRefs.back).toBe('new-back.png');
    // Card still face up — FlatView shows face URL, unchanged.
    expect(flatview.state.textureRef).toBe('face.png');
  });
});
