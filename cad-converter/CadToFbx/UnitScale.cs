using ACadSharp.Types.Units;

namespace CadToFbx;

// UE5's FBX importer trusts the file's own unit scale inconsistently across
// versions/import settings, so this converter always normalizes geometry to
// centimeters itself at write time rather than leaving it to chance.
static class UnitScale
{
    public static double ToCentimeters(UnitsType units) => units switch
    {
        UnitsType.Millimeters => 0.1,
        UnitsType.Centimeters => 1.0,
        UnitsType.Decimeters => 10.0,
        UnitsType.Meters => 100.0,
        UnitsType.Decameters => 1000.0,
        UnitsType.Hectometers => 10000.0,
        UnitsType.Kilometers => 100000.0,
        UnitsType.Inches or UnitsType.Mils => 2.54,
        UnitsType.Feet => 30.48,
        UnitsType.Yards => 91.44,
        UnitsType.Miles => 160934.4,
        UnitsType.Microinches => 2.54e-4,
        UnitsType.Microns => 1e-4,
        UnitsType.Nanometers => 1e-7,
        UnitsType.USSurveyInches => 2.540005,
        UnitsType.USSurveyFeet => 30.480061,
        UnitsType.USSurveyYards => 91.440183,
        UnitsType.USSurveyMiles => 160934.72,
        // Unitless and anything exotic (astronomical units, parsecs - DWG
        // technically allows setting these, nobody ever does) - 1:1 is the
        // least surprising fallback rather than guessing.
        _ => 1.0,
    };
}
