using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.Tables;
using ACadSharp.IO;
using ACadSharp.Types.Units;
using CSMath;

namespace CadToFbx;

// Builds a tiny, deliberately simple DXF test fixture using ACadSharp's own
// writer - not hand-authored DXF text - so the file used to validate this
// converter is guaranteed well-formed, independent of this project's own
// reading logic. Covers the two load-bearing code paths: a block instanced
// twice with a different translate/rotate/scale each time (INSERT +
// AffineTransform), and a plain top-level 3DFACE (no block at all).
static class GenerateTestFixture
{
    public static void Write(string path)
    {
        var doc = new CadDocument();
        doc.Header.InsUnits = UnitsType.Meters;

        var panelBlock = new BlockRecord("PANEL");
        doc.BlockRecords.Add(panelBlock);
        panelBlock.Entities.Add(new Face3D
        {
            FirstCorner = new XYZ(0, 0, 0),
            SecondCorner = new XYZ(1, 0, 0),
            ThirdCorner = new XYZ(1, 1, 0),
            FourthCorner = new XYZ(0, 1, 0),
        });

        // Untransformed instance - should land exactly at the block's own coordinates.
        doc.Entities.Add(new Insert(panelBlock) { InsertPoint = new XYZ(0, 0, 0) });

        // Translated +5m in X, rotated 90deg, stretched 2x in X - exercises
        // every term in the AffineTransform composition at once.
        doc.Entities.Add(new Insert(panelBlock)
        {
            InsertPoint = new XYZ(5, 0, 0),
            Rotation = Math.PI / 2,
            XScale = 2,
            YScale = 1,
            ZScale = 1,
        });

        // A direct, non-block entity floating at Z=3m.
        doc.Entities.Add(new Face3D
        {
            FirstCorner = new XYZ(0, 0, 3),
            SecondCorner = new XYZ(1, 0, 3),
            ThirdCorner = new XYZ(1, 1, 3),
            FourthCorner = new XYZ(0, 1, 3),
        });

        using var writer = new DxfWriter(path, doc, false);
        writer.Write();
    }
}
