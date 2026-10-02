# CadToFbx

A standalone DWG/DXF → FBX converter. Pure .NET 8, no Autodesk software
required to build, run, or redistribute — everything it depends on is
MIT/BSD-licensed and open source:

- [ACadSharp](https://github.com/DomCr/ACadSharp) — reads DWG and DXF directly.
- [SharpAssimp](https://github.com/4XGaming/SharpAssimp) — a modern, maintained
  fork of Assimp's .NET bindings; writes real binary FBX.

## Usage

```
CadToFbx <input.dwg|input.dxf> <output.fbx>
CadToFbx --make-test-fixture <output.dxf>   # writes a tiny synthetic test file, no CAD software needed
```

## What it converts

Only entities that carry real, readable 3D geometry:

- `MESH` (AutoCAD's subdivision mesh)
- `POLYFACEMESH` (classic arbitrary mesh — the most common way exported/interop
  3D geometry shows up in a DWG)
- `3DFACE`
- `INSERT` (block references) — fully recursive, including nested blocks,
  non-uniform scale, rotation, and a non-default extrusion/normal direction
  (handled via the standard Arbitrary Axis Algorithm)

Everything else (lines, 2D polylines, circles/arcs, text, dimensions —
pure drafting/annotation entities) is intentionally skipped and reported as
such on the console, rather than guessing at an extrusion that was never
specified.

## What it does NOT convert (yet) — and why

**`3DSOLID` / `REGION` / `SURFACE` (true ACIS solid geometry) are not
supported.** This was checked directly, not assumed: ACadSharp's `Solid3D`
and `Region` classes currently expose no vertex/face data at all — the
library reads them as opaque objects with no tessellated geometry to pull
out. There is nothing to convert until ACadSharp (or a successor library)
adds ACIS support.

**Workaround**: if your source file uses real 3D solid modeling, re-export
it from the originating application as mesh/polyface geometry instead of
ACIS solids before running it through this converter. In AutoCAD, this is
the "Smoothness" / mesh conversion step, or exporting with the DWG
"Polyface Mesh" option rather than native solids. This is also the planned
path for Revit once a licensed copy is available for development (see
"Revit path" below) — Revit's own DWG exporter can be configured to emit
polymesh geometry instead of ACIS solids, which this converter already
handles correctly.

## Units and coordinate system

- Reads the source file's `$INSUNITS` header value and scales everything to
  **centimeters** (UE5's native unit) at write time — never left to the
  importer's own unit-detection, which varies across tools and import
  settings.
- Source geometry is assumed Z-up (the CAD/architectural convention).
  Assimp's FBX writer declares its output Y-up regardless of the input data,
  so this converter pre-rotates every vertex and normal (`x,y,z → x,z,-y`)
  to compensate. **Verified end-to-end**, not just by inspection: the
  generated FBX was independently re-imported in Blender (a from-scratch,
  unrelated FBX reader) and the resulting bounds were checked against
  hand-calculated expected values for a translated+rotated+scaled block
  instance — they matched exactly.

## Revit path (not started — blocked on licensing)

A Revit add-in (RevitAPI-based, same approach, different input) is the plan
for actually fixing the curtain-wall/window export problems that kicked off
this project — the add-in can walk `CurtainGrid` panels/mullions and
`FamilyInstance` geometry directly, instead of relying on Revit's own
built-in FBX exporter (the thing that's currently getting these wrong).
That work hasn't started: it requires a **licensed** Revit install for
development (a free 30-day trial is enough), not the current unlicensed one
on this machine.

## Testing

```
dotnet run -- --make-test-fixture test.dxf
dotnet run -- test.dxf test.fbx
```

The test fixture exercises both load-bearing code paths in one file: a
block instanced twice with a different translate/rotate/scale each time,
and a plain top-level entity with no block at all.
