# @cirrobio/studio-ui

Spatial Data Studio's display settings (the View / Cells / Image panel on the Studio's
canvas) and the pickers it is built from. The Studio app ([`frontend/`](../../frontend/README.md))
and Spatial Data Studio for Cirro ([`cirro-studio/`](../../cirro-studio/README.md)) both
import it, so both show the same controls under the same names. It is a private
workspace package and is not published.

## What's in it

- `SpatialSettings` / `EmbeddingSettings`: the panel for a canvas from
  [`@cirrobio/spatial-viewer`](../viewer/README.md), filled in from what the canvas
  hands its `controls` slot. By default the panel floats over the canvas and shrinks to a
  gear (`collapsed`, `onCollapse`), as in the Studio. With `docked` it renders flat, for a
  host that puts it in a panel of its own.
- `ColorBySelect`, `ObsFieldSelect`, `VarNameSelect`, `ColorSwatchPicker`, `PanelTabs`
  and `useClickOutside`: the pickers and pieces the panel uses, which the apps also use
  on their own.

## Using it

Floating over the canvas, as the Studio does (`frontend/src/components/canvas/StudioSpatialCanvas.tsx`):

```tsx
const [collapsed, setCollapsed] = useState(false);
<SpatialCanvas display={display} sessionId={id}
  controls={(api) => <SpatialSettings api={api} collapsed={collapsed} onCollapse={setCollapsed} />} />
```

Docked in a host's own panel, as the web app does in its Display drawer
(`cirro-studio/src/item/LensCanvas.tsx`):

```tsx
<SpatialCanvas display={display} sessionId={id}
  controls={(api) => drawer && createPortal(<SpatialSettings api={api} docked />, drawer)} />
```

## Styling

The components are styled with Tailwind classes. A host needs three things for them to
look as they do in the Studio:

- **The preset and the sources.** Use `tailwind.preset.js` as a preset (it names the
  Studio's colors and fonts), and list `packages/studio-ui/src/**/*.{ts,tsx}` in
  Tailwind's `content` so the classes these files use are generated.
- **The color tokens.** The preset's colors are `--color-*` RGB channels (`bg`,
  `surface`, `border`, `text`, `muted`, `accent`, `on-accent`, `accent-lo`, `success`,
  `warn`, `danger`) that the host defines for each of its themes, so the panel follows
  the host's light and dark themes. The Studio sets them in `frontend/src/index.css`, the
  web app in `cirro-studio/src/styles/tokens.css`.
- **Tailwind's base styles (preflight).** The Studio uses them across the page. The web
  app has base styles of its own, so it turns preflight off and applies the part these
  controls need only inside elements with the `studio-ui` class
  (`cirro-studio/src/styles/studio-ui.css`).

## Changing it

A change here changes both apps, and it is part of the Studio's own bundle: its version
moves with the Studio's, and it ships with the Studio's next release tag. The panel
carries the Studio tour's `display-settings` anchor, so `npm run check:tours` in
`frontend/` reads this package's sources too.
