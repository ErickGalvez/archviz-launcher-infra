using CSMath;

namespace CadToFbx;

// A plain 3x3 (rotation/scale) + translation transform, composed by hand
// instead of reaching for a matrix library - this is the whole of what's
// needed to place block (INSERT) instances correctly, including nested
// blocks and non-default extrusion directions, without pulling in a general
// 3D math dependency for a handful of multiplications.
readonly struct AffineTransform
{
    public readonly double M11, M12, M13;
    public readonly double M21, M22, M23;
    public readonly double M31, M32, M33;
    public readonly double Tx, Ty, Tz;

    public static readonly AffineTransform Identity = new(
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
        0, 0, 0);

    public AffineTransform(
        double m11, double m12, double m13,
        double m21, double m22, double m23,
        double m31, double m32, double m33,
        double tx, double ty, double tz)
    {
        M11 = m11; M12 = m12; M13 = m13;
        M21 = m21; M22 = m22; M23 = m23;
        M31 = m31; M32 = m32; M33 = m33;
        Tx = tx; Ty = ty; Tz = tz;
    }

    public XYZ Apply(XYZ p)
    {
        double x = M11 * p.X + M12 * p.Y + M13 * p.Z + Tx;
        double y = M21 * p.X + M22 * p.Y + M23 * p.Z + Ty;
        double z = M31 * p.X + M32 * p.Y + M33 * p.Z + Tz;
        return new XYZ(x, y, z);
    }

    // this ∘ inner: apply inner first, then this (i.e. this = parent, inner = child)
    public AffineTransform Compose(AffineTransform inner)
    {
        double m11 = M11 * inner.M11 + M12 * inner.M21 + M13 * inner.M31;
        double m12 = M11 * inner.M12 + M12 * inner.M22 + M13 * inner.M32;
        double m13 = M11 * inner.M13 + M12 * inner.M23 + M13 * inner.M33;

        double m21 = M21 * inner.M11 + M22 * inner.M21 + M23 * inner.M31;
        double m22 = M21 * inner.M12 + M22 * inner.M22 + M23 * inner.M32;
        double m23 = M21 * inner.M13 + M22 * inner.M23 + M23 * inner.M33;

        double m31 = M31 * inner.M11 + M32 * inner.M21 + M33 * inner.M31;
        double m32 = M31 * inner.M12 + M32 * inner.M22 + M33 * inner.M32;
        double m33 = M31 * inner.M13 + M32 * inner.M23 + M33 * inner.M33;

        // translation: parent applied to the child's translation, then the
        // parent's own translation on top (child's rotation/scale doesn't
        // affect the parent's translation component).
        double tx = M11 * inner.Tx + M12 * inner.Ty + M13 * inner.Tz + Tx;
        double ty = M21 * inner.Tx + M22 * inner.Ty + M23 * inner.Tz + Ty;
        double tz = M31 * inner.Tx + M32 * inner.Ty + M33 * inner.Tz + Tz;

        return new AffineTransform(m11, m12, m13, m21, m22, m23, m31, m32, m33, tx, ty, tz);
    }

    public static AffineTransform Translation(double x, double y, double z) =>
        new(1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z);

    public static AffineTransform Scale(double sx, double sy, double sz) =>
        new(sx, 0, 0, 0, sy, 0, 0, 0, sz, 0, 0, 0);

    public static AffineTransform RotationZ(double radians)
    {
        double c = Math.Cos(radians), s = Math.Sin(radians);
        return new AffineTransform(c, -s, 0, s, c, 0, 0, 0, 1, 0, 0, 0);
    }

    // Autodesk's published "Arbitrary Axis Algorithm" for turning an
    // extrusion/normal direction into a full OCS basis - needed whenever an
    // INSERT (or any OCS-based entity) has a normal other than world +Z, or
    // its geometry is quietly placed/rotated wrong with no error to show for it.
    public static AffineTransform FromNormal(XYZ normal)
    {
        var n = Normalize(normal);
        XYZ worldUp = (Math.Abs(n.X) < 1.0 / 64.0 && Math.Abs(n.Y) < 1.0 / 64.0)
            ? new XYZ(0, 1, 0)
            : new XYZ(0, 0, 1);
        var ax = Normalize(Cross(worldUp, n));
        var ay = Normalize(Cross(n, ax));
        // columns = Ax, Ay, N
        return new AffineTransform(
            ax.X, ay.X, n.X,
            ax.Y, ay.Y, n.Y,
            ax.Z, ay.Z, n.Z,
            0, 0, 0);
    }

    static XYZ Cross(XYZ a, XYZ b) => new(
        a.Y * b.Z - a.Z * b.Y,
        a.Z * b.X - a.X * b.Z,
        a.X * b.Y - a.Y * b.X);

    static XYZ Normalize(XYZ v)
    {
        double len = Math.Sqrt(v.X * v.X + v.Y * v.Y + v.Z * v.Z);
        return len < 1e-12 ? new XYZ(0, 0, 1) : new XYZ(v.X / len, v.Y / len, v.Z / len);
    }
}
