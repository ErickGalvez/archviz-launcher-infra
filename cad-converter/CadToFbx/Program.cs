using ACadSharp.IO;
using CadToFbx;

if (args.Length == 2 && args[0] == "--make-test-fixture")
{
    GenerateTestFixture.Write(args[1]);
    Console.WriteLine($"Wrote test fixture: {args[1]}");
    return 0;
}

if (args.Length < 2)
{
    Console.WriteLine("Usage: CadToFbx <input.dwg|input.dxf> <output.fbx>");
    Console.WriteLine("       CadToFbx --make-test-fixture <output.dxf>   (self-check: writes a tiny synthetic DXF, no CAD software needed)");
    return 1;
}

string inputPath = args[0];
string outputPath = args[1];

if (!File.Exists(inputPath))
{
    Console.Error.WriteLine($"Input file not found: {inputPath}");
    return 1;
}

string ext = Path.GetExtension(inputPath).ToLowerInvariant();

try
{
    var doc = ext switch
    {
        ".dwg" => DwgReader.Read(inputPath),
        ".dxf" => DxfReader.Read(inputPath),
        _ => throw new NotSupportedException($"Unsupported input extension '{ext}'. Expected .dwg or .dxf."),
    };

    double scaleToCm = UnitScale.ToCentimeters(doc.Header.InsUnits);
    Console.WriteLine($"Source units: {doc.Header.InsUnits} (x{scaleToCm} -> cm)");

    var converter = new SceneConverter(scaleToCm);
    var scene = converter.Convert(doc);

    Console.WriteLine($"Converted {converter.ConvertedEntityCount} entities into {converter.TriangleCount} triangles.");
    if (converter.SkippedByType.Count > 0)
    {
        Console.WriteLine("Skipped (no readable 3D geometry for this entity type):");
        foreach (var kv in converter.SkippedByType.OrderByDescending(kv => kv.Value))
            Console.WriteLine($"  {kv.Key}: {kv.Value}");
    }

    if (converter.TriangleCount == 0)
    {
        Console.Error.WriteLine("No exportable geometry found. If this file uses 3DSOLID/REGION (ACIS) " +
            "entities, re-export it from the source application as Mesh/Polyface geometry instead.");
        return 2;
    }

    using var assimpContext = new SharpAssimp.AssimpContext();
    bool ok = assimpContext.ExportFile(scene, outputPath, "fbx");
    if (!ok)
    {
        Console.Error.WriteLine("FBX export failed.");
        return 1;
    }

    Console.WriteLine($"Wrote {outputPath}");
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"Conversion failed: {ex.Message}");
    return 1;
}
