using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.Tables;
using CSMath;
using SharpAssimp;

namespace CadToFbx;

// Converts the subset of DWG/DXF entities that actually carry real,
// readable 3D geometry (Mesh, PolyfaceMesh, Face3D, and INSERT instances of
// blocks built from those) into a SharpAssimp scene, which SharpAssimp then
// writes out as real binary FBX. True ACIS solids (3DSOLID, REGION,
// SURFACE) are deliberately out of scope: ACadSharp currently reads them as
// opaque, geometry-less objects (confirmed by inspecting the library
// directly - Solid3D/Region expose no vertex data at all), so there is
// nothing to tessellate. Flat 2D drafting entities (LINE, LWPOLYLINE,
// circles/arcs) are skipped too - they're drawing annotations, not volumes,
// and silently "extruding" them would invent geometry that was never there.
class SceneConverter
{
    readonly double _scaleToCm;
    readonly Scene _scene = new();
    readonly Dictionary<string, int> _materialIndexByColor = new();
    readonly HashSet<BlockRecord> _activeBlockStack = new(); // guards against circular block references

    public int ConvertedEntityCount { get; private set; }
    public int TriangleCount { get; private set; }
    public Dictionary<string, int> SkippedByType { get; } = new();

    public SceneConverter(double scaleToCm)
    {
        _scaleToCm = scaleToCm;
    }

    public Scene Convert(CadDocument doc)
    {
        _scene.RootNode = new Node("ModelSpace");
        var identity = AffineTransform.Identity;
        foreach (var entity in doc.Entities)
        {
            var node = ConvertEntity(entity, identity);
            if (node != null) _scene.RootNode.Children.Add(node);
        }
        return _scene;
    }

    Node? ConvertEntity(Entity entity, AffineTransform transform)
    {
        switch (entity)
        {
            case Insert insert:
                return ConvertInsert(insert, transform);
            case ACadSharp.Entities.Mesh mesh:
                return BuildMeshNode(mesh, TriangulateMesh(mesh), transform, "Mesh");
            case PolyfaceMesh pface:
                return BuildMeshNode(pface, TriangulatePolyfaceMesh(pface), transform, "PolyfaceMesh");
            case Face3D face:
                return BuildMeshNode(face, TriangulateFace3D(face), transform, "Face3D");
            default:
                var typeName = entity.GetType().Name;
                SkippedByType[typeName] = SkippedByType.GetValueOrDefault(typeName) + 1;
                return null;
        }
    }

    Node? ConvertInsert(Insert insert, AffineTransform parentTransform)
    {
        var block = insert.Block;
        if (block == null || _activeBlockStack.Contains(block)) return null; // no geometry, or a circular reference

        // translate * (block normal orientation) * rotateZ * scale, all in the parent's space.
        var local = AffineTransform.Translation(insert.InsertPoint.X, insert.InsertPoint.Y, insert.InsertPoint.Z)
            .Compose(AffineTransform.FromNormal(insert.Normal))
            .Compose(AffineTransform.RotationZ(insert.Rotation))
            .Compose(AffineTransform.Scale(insert.XScale, insert.YScale, insert.ZScale));

        var combined = parentTransform.Compose(local);

        var node = new Node(string.IsNullOrEmpty(block.Name) ? "Insert" : block.Name);
        _activeBlockStack.Add(block);
        try
        {
            foreach (var child in block.Entities)
            {
                var childNode = ConvertEntity(child, combined);
                if (childNode != null) node.Children.Add(childNode);
            }
        }
        finally
        {
            _activeBlockStack.Remove(block);
        }

        return node.Children.Count > 0 ? node : null;
    }

    // ── Triangulation per entity type ───────────────────────────
    // Each returns a flat list of (triangle) vertex positions already in
    // the entity's own local space - transform + unit scale are applied
    // once, uniformly, in BuildMeshNode.

    static List<XYZ> TriangulateMesh(ACadSharp.Entities.Mesh mesh)
    {
        var tris = new List<XYZ>();
        foreach (var face in mesh.Faces)
            FanTriangulate(face.Select(i => mesh.Vertices[i]).ToList(), tris);
        return tris;
    }

    static List<XYZ> TriangulatePolyfaceMesh(PolyfaceMesh pface)
    {
        var verts = pface.Vertices.Select(v => v.Location).ToList();
        var tris = new List<XYZ>();
        foreach (var face in pface.Faces)
        {
            var indices = new[] { face.Index1, face.Index2, face.Index3, face.Index4 }
                .Where(i => i != 0)
                .Select(i => Math.Abs(i) - 1) // 1-based, sign flags an invisible edge - not a different vertex
                .Where(i => i >= 0 && i < verts.Count)
                .Select(i => verts[i])
                .ToList();
            FanTriangulate(indices, tris);
        }
        return tris;
    }

    static List<XYZ> TriangulateFace3D(Face3D face)
    {
        var tris = new List<XYZ>();
        // A 3DFACE is a quad (or triangle, when the 4th corner repeats the 3rd).
        var corners = new List<XYZ> { face.FirstCorner, face.SecondCorner, face.ThirdCorner };
        if (face.FourthCorner != face.ThirdCorner) corners.Add(face.FourthCorner);
        FanTriangulate(corners, tris);
        return tris;
    }

    static void FanTriangulate(IReadOnlyList<XYZ> polygon, List<XYZ> outTriangles)
    {
        if (polygon.Count < 3) return;
        for (int i = 1; i < polygon.Count - 1; i++)
        {
            outTriangles.Add(polygon[0]);
            outTriangles.Add(polygon[i]);
            outTriangles.Add(polygon[i + 1]);
        }
    }

    // ── Assimp scene assembly ───────────────────────────────────

    Node? BuildMeshNode(Entity sourceEntity, List<XYZ> triangles, AffineTransform transform, string entityTypeLabel)
    {
        if (triangles.Count == 0 || triangles.Count % 3 != 0) return null;

        var mesh = new SharpAssimp.Mesh(entityTypeLabel, PrimitiveType.Triangle)
        {
            MaterialIndex = GetOrCreateMaterial(sourceEntity)
        };

        for (int i = 0; i < triangles.Count; i += 3)
        {
            int baseIndex = mesh.VertexCount;
            var corners = new System.Numerics.Vector3[3];
            for (int k = 0; k < 3; k++)
            {
                var p = transform.Apply(triangles[i + k]);
                // CAD/architectural data is Z-up; Assimp's FBX exporter writes
                // vertex data through unchanged but still declares the file
                // Y-up, so every consumer (Blender, UE5) then "corrects" data
                // that was never actually Y-up, mirroring the whole scene.
                // Pre-rotating -90 about X here (x,y,z) -> (x,z,-y) cancels
                // that out - verified end-to-end via Blender's own FBX reader.
                corners[k] = new System.Numerics.Vector3(
                    (float)(p.X * _scaleToCm),
                    (float)(p.Z * _scaleToCm),
                    (float)(-p.Y * _scaleToCm));
                mesh.Vertices.Add(corners[k]);
            }
            mesh.Faces.Add(new Face(new[] { baseIndex, baseIndex + 1, baseIndex + 2 }));

            // Flat (per-face) normal, duplicated across all 3 corners - correct
            // and simple for hard-surface CAD geometry with no smoothing-group
            // data to begin with.
            var normal = System.Numerics.Vector3.Normalize(
                System.Numerics.Vector3.Cross(corners[1] - corners[0], corners[2] - corners[0]));
            if (float.IsNaN(normal.X)) normal = System.Numerics.Vector3.UnitZ;
            mesh.Normals.Add(normal);
            mesh.Normals.Add(normal);
            mesh.Normals.Add(normal);
        }

        _scene.Meshes.Add(mesh);
        TriangleCount += mesh.Faces.Count;
        ConvertedEntityCount++;

        var node = new Node(entityTypeLabel);
        node.MeshIndices.Add(_scene.Meshes.Count - 1);
        return node;
    }

    int GetOrCreateMaterial(Entity entity)
    {
        var color = entity.Color;
        var layerName = entity.Layer?.Name ?? "0";
        // ByLayer/ByBlock entities don't carry a usable color of their own -
        // Color.R/G/B on those reads as black, which would paint everything
        // on a default-colored layer solid black instead of falling back to
        // the layer's actual color.
        if ((color.IsByLayer || color.IsByBlock) && entity.Layer != null) color = entity.Layer.Color;

        var key = $"{layerName}#{color.R:x2}{color.G:x2}{color.B:x2}";
        if (_materialIndexByColor.TryGetValue(key, out var idx)) return idx;

        // A flat per-layer/per-color material is a reasonable, honest
        // stand-in - DWG/DXF carries no PBR data, so this is the most that
        // can be inferred automatically. Real materials are expected to be
        // reassigned by hand once the mesh is in UE5.
        var material = new Material { Name = layerName };
        material.ColorDiffuse = new System.Numerics.Vector4(color.R / 255f, color.G / 255f, color.B / 255f, 1f);

        _scene.Materials.Add(material);
        _materialIndexByColor[key] = _scene.Materials.Count - 1;
        return _scene.Materials.Count - 1;
    }
}
