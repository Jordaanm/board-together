# Spawnables

This page is a reference for every entity you can drop into a room from the host action bar's **Spawn Object** modal. Each section covers what the piece is, how it behaves in the simulation, what fields you can edit on it in the inspector, and the context-menu actions it exposes to players. For the editor UI itself see [hosting.md](./hosting.md); for the underlying entity / component model see [architecture.md](./architecture.md).

Spawnables are listed in the same categories the Spawn Object modal groups them under: **Boards**, **Dice**, **Tokens**, **Cards**, and **Zones**. The singleton **Table** is also documented at the end for completeness — it's hidden from the modal because every room already has one.

## Boards

### Board

**Type:** `board` &middot; **Category:** Boards &middot; **Default tags:** `board`

A flat, low-mass slab. Treat it as the canvas you build a game on: lay one down for the play area, attach surfaces and stickers to it through the editor, drop other pieces on top, and let physics keep everything in place. Boards are dynamic by default but heavy enough relative to dice and cards that they sit still under normal play.

Default appearance: 4 m × 0.05 m × 3 m, mossy green (`#2d5a27`), single `prim:cube` mesh.

**Inspector fields**

- Transform: position, rotation, scale.
- Mesh: `meshRef`, `color`, `width` / `height` / `depth`, `textureRefs.default`.
- Physics: `mass`, `friction`, `restitution`, `isLocked` (locking pins it in place and ignores collisions), `yawOnly` (when true, the body may only rotate about world +Y — defaults to `true` for board, deck, and card).

**Context-menu actions:** standard mesh actions (rotate, lock, delete, add surface). No board-specific behaviour beyond what mesh + physics already give you.

## Dice

### Die (D6)

**Type:** `die` &middot; **Category:** Dice &middot; **Default tags:** `die`

A six-sided cubic die. Carries a `dice` component that, on coming to rest, reads the rigid body's orientation and writes the up-facing pip count into a sibling `value` component. Scripts can subscribe to `value-changed` on the entity to react when a roll resolves.

Default appearance: 0.7 m chamfered cube, off-white (`#fafafa`), `prim:d6` mesh with pip overlays.

**Inspector fields**

- Transform, Mesh, Physics as above.
- Value: current face number (read-only at runtime — `dice` rewrites it on rest).

**Context-menu actions**

- **Value: N** — read-only display of the current face.
- **Roll** — applies a random angular and linear impulse so the die tumbles and lands on a new face.
- **Rotate** / **Rotate Counter Clockwise** — step the face up or down (with wraparound) and snap the model to the orientation that shows the new value. Useful for setting a die to a specific result without rolling.

### Die (D20)

**Type:** `d20` &middot; **Category:** Dice &middot; **Default tags:** `die`

A twenty-sided icosahedral die. Same `dice` semantics as the D6 — orientation on rest determines the face — but with a 20-face lookup table and convex-hull physics shape. Default size is 1.4 m, mass 0.25.

Inspector fields and context-menu actions match the D6.

## Tokens

### Token

**Type:** `token` &middot; **Category:** Tokens &middot; **Default tags:** `token`

A generic upright marker, shaped like a meeple (capsule + sphere). Use one per player position, or as a counter for any "thing on a square" game. Light (mass 0.1), small (0.5 m × 0.75 m × 0.5 m), default blue (`#2266cc`).

Tokens carry no behavioural components beyond mesh + physics, so they're whatever you want them to be. The host can tag them, swap the mesh, recolour them, or lock them in place.

**Inspector fields:** Transform, Mesh, Physics.
**Context-menu actions:** standard mesh + physics actions only.

### Disc

**Type:** `disc` &middot; **Category:** Tokens &middot; **Default tags:** `disc`

A flat circular chip. Smaller and lower-profile than a token — meant for poker-style chips, victory-point markers, status discs. Default 0.32 m diameter, 0.05 m thick, terracotta (`#cc6622`).

Like Token, a Disc carries no behavioural components beyond the basics. Same inspector fields and same plain context menu.

## Cards

### Card

**Type:** `card` &middot; **Category:** Cards &middot; **Default tags:** `card`

A thin two-sided card. Mass 0.05, default 0.63 m × 0.01 m × 0.88 m — the standard playing-card aspect ratio. The `card` component owns `face`, `back`, and `category` strings and pushes the textures into the mesh's `face` (+Y) and `back` (-Y) material slots. When the card comes to rest the orientation determines which side is up, and the `flatview` component's `textureRef` is updated accordingly so hand-panel tiles and other 2D views show the correct side.

A card placed inside a **Hand** zone is marked private to that hand's owner — the engine blanks the face URL on the wire for non-owner peers, so a peer flying their camera around can't read your hand off the cached material.

**Inspector fields**

- Transform, Mesh, Physics.
- Card: `face` (image asset), `back` (image asset).
- Category is set by the source deck (or by a script); not exposed as an editable field.

**Context-menu actions:** standard mesh + physics actions. Most card-specific verbs (draw, deal, shuffle) live on the parent Deck, not on individual cards.

### Deck

**Type:** `deck` &middot; **Category:** Cards &middot; **Default tags:** `deck` &middot; **Internal — not in the Spawn Object modal**

A stack of `Card` entities. Decks are not spawned directly from the modal; they appear when you use **Generate Deck** in the action bar (see [hosting.md](./hosting.md#generate-deck)) or when a script or save file produces one. The deck owns `cards: string[]` (card IDs, top of the stack at index `0`) plus a `category` tag. As cards are added or removed, the deck's mesh height grows or shrinks (0.02 m per card), its mass scales accordingly, and the visible top-face / bottom-back textures track the actual top and bottom cards.

**Inspector fields:** Transform, Mesh, Physics. The card list itself is not exposed as an editable field — it's mutated through the context-menu verbs below or through script calls.

**Context-menu actions**

- **Draw N** — moves the top *N* cards into the right-clicking player's main hand. Disabled if the player has no seat. The 1 / 2 / 3 / 5 / Other… numeric submenu lets you pick a count.
- **Deal N** — deals the top *N* cards, one each, to every seated player's main hand. Same numeric submenu.
- **Shuffle** — randomises the deck's card order.
- **Spread deck** — fans the stack out across the table so every card is individually visible. Useful for a quick reveal or for sorting before re-collecting.

## Zones

### Zone

**Type:** `zone` &middot; **Category:** Zones &middot; **Default tags:** `zone`

A non-physical axis-aligned box volume that tracks which entities physically overlap it. Mounted as a kinematic Cannon sensor body — it doesn't push pieces around, it just records their membership in `containedIds` and replicates that to guests. Use a zone to mark a play area, a discard pile, a scoring region, or anywhere a game needs to react to "is X in here?".

Zones are invisible by default; only the host's **Show All Zones** toggle on the action bar renders them as tinted volumes for layout work. A zone with `isVisible: true` will always render its outline.

**Inspector fields**

- Transform: position, rotation, scale.
- Zone: `Half-extent X`, `Half-extent Y`, `Half-extent Z`, `isVisible` (always render the outline), plus optional `acceptTags` and `acceptComponents` filters that gate which entities the zone considers members.

**Context-menu actions:** none. Zones are observed by other components (Hand uses one) and by scripts via the `zone-enter` / `zone-exit` events.

### Hand

**Type:** `hand` &middot; **Category:** Zones &middot; **Default tags:** `hand`

A specialised Zone composed with seat ownership, privacy, and card-fan layout. When a card enters a hand:

- Its owner is set to the hand's owner.
- If `isPrivate` is on (default), the card is marked private to that seat — the face URL is blanked on the wire to other peers, and the bottom-of-screen hand panel only renders for the owner.
- All contained cards are tweened into a fan along the hand's local +X axis. A hand fills up to `0.63 m × cards` of width and then starts overlapping fan-style.

Every seat can have one **main** hand. The main hand is the one that **Draw N** and **Deal N** target. Setting `isMainHand` on one hand automatically clears it on any sibling hand owned by the same seat.

Default size: 1.0 m × 0.2 m × 0.3 m volume (half-extents `[0.5, 0.1, 0.15]`). Default `acceptComponents: ['flatview']` — only entities with a flat-view (i.e. cards) are accepted as members.

**Inspector fields**

- Transform, Zone (half-extents, isVisible, accept filters).
- Hand: `isMainHand` (visible only once the entity has an owner), `isPrivate`.

**Context-menu actions**

- **Tidy hand** — re-tween every contained card back into its computed slot pose. Use this if cards drift after manual edits or after a custom script rearrangement.

### Snap Marker

**Type:** `snap-marker` &middot; **Category:** Zones &middot; **Default tags:** `snap-marker`

A free-standing placement anchor. Carries only a `transform` and a `snap-points` component — no mesh, no physics. When a player releases a piece within a snap point's radius the host teleports the piece onto the point's pose (XZ position, optional Y, optional yaw) and zeros its velocity. Use snap markers for "deck goes here", "discard pile here", or edge-alignment rails for rows of pieces.

A fresh marker ships with one default point at its origin (radius 0.4, no rotation or Y snap). Add more points or tune the existing one in the inspector. Snap markers are invisible and uninteractive by default; the host's **Show Snap Points** action-bar toggle renders each point as a translucent green disc and makes the marker itself grabbable so you can re-position it. Guests never see snap points.

If you'd rather have snap points travel with an existing piece (a card snapping to a deck-shaped board, say), use the inspector's **Add Snap Markers** button on that entity instead — it attaches a `SnapPointsComponent` directly, no separate marker required.

**Inspector fields**

- Transform: position, rotation, scale.
- Snap Points: one numeric form per point — `x` / `y` / `z` / `yaw` (radians), plus `radius`, `snap yaw`, `snap y`, and a delete `×`. An **Add Snap Point** button appends another point at the entity's origin.

**Context-menu actions:** none.

## Fixtures

### Table

**Type:** `table` &middot; **Category:** Fixtures &middot; **Hidden — not normally spawnable**

The singleton table fixture. Every room ships with one Table already in the scene; the entry exists in the spawnable registry only so save files and scripts can re-add it if it somehow gets removed. The Table carries the room's `skydome` and `lighting` components, so editing it is how you change the room's sky texture, ambient colour, and light intensity.

Locking rules special-case the Table: you can't despawn it, drag it, gizmo it, or spawn a second one — every guard keys on the presence of the `TableComponent` rather than a magic ID, so the same locking pattern is reusable for future fixture-class entities.

Default appearance: 12 m × 0.3 m × 8 m rectangular table, default texture (`base:table/default`).

**Inspector fields**

- Transform, Mesh, Physics (`isLocked: true` by default, mass 0).
- Skydome: `textureUrl` (background image — accepts `base:*`, `custom:*`, or any image URL).
- Lighting: `color`, `intensity`.

**Context-menu actions:** none. All edits go through the inspector.

## See also

- [Hosting](./hosting.md) — the action bar, editor panel, and asset manager that you use to actually spawn and edit these entities.
- [Scripting](./scripting.md) — how a custom game extends `Game` and drives the scene programmatically.
- [Architecture](./architecture.md) — the entity / component model that every spawnable is built from.
