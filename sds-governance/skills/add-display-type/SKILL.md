# Skill: add-display-type

**Triggers on:** a new visualization / encoding (e.g. faceted small-multiples).

## Steps
1. Extend `DisplaySpec` / `DisplayEncoding` (types.ts + appstate) with the new
   encoding fields; keep them serializable so they persist into the `.zarr.zip`.
2. Render it from the shared canvas core so a snapshot can reproduce it; capture
   the new fields in `snapshots.save_snapshot`'s view-state.
3. Surface the new state in the data manifest (Images/Displays contributor) so the
   agent knows it exists.
4. `make check` — R13 (snapshots share the render core; assets content-hashed).

**Satisfies:** R13.
