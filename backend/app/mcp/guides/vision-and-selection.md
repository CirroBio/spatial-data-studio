# Vision and selection — seeing the tissue and acting on what you see

Read this before using `view_display`, `annotate_region`, or `subset_to_region`.
The whole point: what you *see* in a render and what you *do* with polygons happen
in one shared coordinate system, and the tools give you everything needed to move
between image pixels and that system exactly.

## The coordinate contract

`view_display` returns two things: the PNG, and a metadata block with:

- `pixel_to_world`: an affine `[A,B,C,D,E,F]` mapping *PNG pixels* to *world
  coordinates*: for pixel column `px` (from the left) and row `py` (from the top),
  `world_x = A*px + B*py + C`, `world_y = D*px + E*py + F`.
- `corner_world_coords` / `world_window`: the world coordinates of the image
  corners — use these to sanity-check orientation (world y usually *decreases*
  going down the image, since the canvas is y-up; never assume, read them).
- `grid`: the world interval of the labeled gridlines drawn on the image
  (`include_grid=True`, the default). The tick labels along the bottom/left edges
  are world x/y values — you can read coordinates directly off the image.
- `space`: which system this is. For a `spatial_canvas` it is **world space** — the
  exact space `annotate_region`/`subset_to_region`/`inspect_region` polygons and
  `add_shape_annotation` points use. For an `embedding_canvas` it is that
  embedding's component space — selections there must go through
  `space='embedding'` (resolved to cell indices) instead.

"World" = `obsm['spatial']` after the dataset's points→global alignment — the same
space the user's canvas operates in. It is unit-agnostic (often µm or pixels of the
source platform); treat scales as relative unless the user tells you units.

## The verify-then-act loop (always follow this)

1. **Survey**: `view_display(viewport="fit")` — the whole section, with grid.
2. **Zoom**: compute a viewport around the structure of interest:
   `target=[wx, wy]` (world center), and `zoom` such that the window spans your
   region (`width_px / 2**zoom` world units across; e.g. 1024 px wide at zoom −2
   shows 4096 world units). Render again and confirm the framing.
3. **Draft the selection**: build a polygon in world coordinates (from gridline
   readings or `pixel_to_world` applied to the pixel outline of what you see).
   Polygons are `[[x,y], [x,y], ...]` rings (≥3 vertices, no need to close).
4. **Mark and look**: re-render with `mark_polygons=[{"points": ring, "label":
   "tumor?"}]` (and `mark_points` for landmarks). The overlay is drawn from your
   *world* coordinates — if it doesn't hug the structure you meant, your
   coordinates are off; fix them *before* touching the data.
5. **Check numerically**: `inspect_region(polygons=…)` — cell count, composition by
   the relevant obs column, mean expression of marker genes inside vs outside. A
   selection with the wrong composition is the wrong selection.
6. **Act**: `annotate_region` (labels cells; every display recolors to the region
   set) or `subset_to_region` (child session; **parent closes** — checkpoint
   first). Then `view_display` once more to confirm the result looks right.

Membership nuance: `inspect_region`/`annotate_region` test cell *centroids* against
the polygon; `subset_to_region` keeps any cell whose *geometry* intersects it (on
spot data, the spot circle) — so a subset can contain slightly more cells than the
inspect count. Expected, not an error.

## Making patterns visible before you look

A render only shows what the encoding shows. Before hunting for a pattern:

- `update_display(color_by="X:<gene>")` for expression; `"obs:<col>"` for labels/QC.
- Numeric coloring uses viridis (dark→bright = low→high, min–max scaled).
  Categorical uses a fixed 15-color palette; `category_colors` can pin colors.
- Sparse imaging panels: single-gene plots are speckly — expect salt-and-pepper;
  judge density patterns, not individual dots. Consider `sc.tl.score_genes` for a
  gene-set score column instead.
- Adjust `point_size`/`opacity` when density hides structure; `background:"light"`
  can help on faint signals; `render_mode:"points+shapes"` shows true cell
  boundaries once zoomed in.
- The tissue image itself: `image_layer` picks the raster; H&E shows morphology.
  If the image dominates, hide it (`{"image_layer": null}`) and read the points.

## Reading renders accurately (vision-model discipline)

- Ground every location claim against the gridlines/labels, not gut feel; state
  world coordinates when you describe a location to the user.
- The render is a *sample*: at fit zoom, thousands of cells collapse to few pixels.
  Zoom before judging fine structure; `render.cells_in_view` in the metadata tells
  you how many cells the window holds.
- Colors mix where points overlap; a "new" hue in a dense area is usually
  overplotting, not a new population — check with `inspect_region`.
- Non-square windows never distort: x and y share one scale (equal-aspect), so
  shapes on screen are shapes in the tissue.

## Embedding views

`view_display` on an `embedding_canvas` works the same way, but its space is the
embedding — spatially meaningless. Select there with `space='embedding'`
(inspect/annotate/subset resolve your embedding-space polygons to cell indices).
The powerful move is cross-view: select a cluster on the UMAP, then `view_display`
on the spatial canvas (the annotation recolors it) to see *where* those cells live.

## Worked example

Goal: label a dense cellular island around world (4200, 2800), roughly 800×600.

1. `view_display(viewport={"target":[4200,2800],"zoom":-0.5})` → confirm framing.
2. Ring: `[[3800,2500],[4600,2500],[4600,3100],[3800,3100]]`.
3. `view_display(... mark_polygons=[{"points": ring, "label":"island"}])` → overlay
   hugs the island? If it sits offset, re-read the gridlines and adjust.
4. `inspect_region(polygons=[ring], genes=["EPCAM"])` → 1,240 cells, 78% cluster 3,
   EPCAM 2.1 vs 0.4 elsewhere → plausibly the epithelial island.
5. `annotate_region("tissue_region", "epithelial_island", polygons=[ring],
   color="#c1432b")` → displays recolor; `view_display` to confirm; tell the user.
