// Reads a 3D gaussian PLY straight into the arrays of gsplat.js's SplatData, for the gaussian viewer.
//
// gsplat's PLYLoader parses every row through per-property closures and four typed-array views per splat, then copies
// the rows into SplatData once more. This does the same arithmetic in one loop: the same float64 expressions, the
// same Uint8Clamped rounding, the rotation through the same 8-bit step, so the arrays come out bit for bit as gsplat's
// (test_gs_ply_loader.py). It covers the usual layout -- every property a float; x y z, f_dc_0-2, opacity, scale_0-2,
// rot_0-3 (or gsplat's other names for them), anything else ignored -- and returns null for every other file, which
// the caller then gives to gsplat's own loader.
(function () {
    const SH_C0 = 0.28209479177387814;
    // The property names gsplat reads, by what they fill. null: gsplat reads it into the colour too; not covered here.
    const SLOT = new Map(Object.entries({
        x: 'x', y: 'y', z: 'z',
        scale_0: 's0', scaling_0: 's0', scale_1: 's1', scaling_1: 's1', scale_2: 's2', scaling_2: 's2',
        f_dc_0: 'c0', features_0: 'c0', f_dc_1: 'c1', features_1: 'c1', f_dc_2: 'c2', features_2: 'c2',
        opacity: 'a', opacity_0: 'a',
        rot_0: 'qw', rotation_0: 'qw', rot_1: 'qx', rotation_1: 'qx', rot_2: 'qy', rotation_2: 'qy',
        rot_3: 'qz', rotation_3: 'qz',
        red: null, green: null, blue: null, f_dc_3: null,
    }));
    const NEEDED = ['x', 'y', 'z', 's0', 's1', 's2', 'c0', 'c1', 'c2', 'a', 'qw', 'qx', 'qy', 'qz'];
    const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

    // -> { vertexCount, positions, rotations, scales, colors } (new SplatData(...) takes them in that order), or null
    function parseGaussianPly(buffer) {
        const bytes = new Uint8Array(buffer);
        if (!LITTLE_ENDIAN || bytes.length < 4 || bytes[0] !== 112 || bytes[1] !== 108 || bytes[2] !== 121 || bytes[3] !== 10)
            return null;
        // The header the way gsplat reads it: the first 10 KB, every "property " line in order, its index as the offset.
        const head = new TextDecoder().decode(bytes.subarray(0, 10240));
        const end = head.indexOf('end_header\n');
        const vertices = /element vertex (\d+)\n/.exec(head);
        if (end < 0 || !vertices) return null;
        const n = parseInt(vertices[1]);
        const col = {};
        let stride = 0;
        for (const line of head.slice(0, end).split('\n')) {
            if (!line.startsWith('property ')) continue;
            const [, type, name] = line.split(' ');
            if (type !== 'float') return null;
            if (SLOT.has(name)) {
                const slot = SLOT.get(name);
                if (slot === null || slot in col) return null;
                col[slot] = stride / 4;
            }
            stride += 4;
        }
        if (NEEDED.some((slot) => !(slot in col))) return null;
        const start = end + 'end_header\n'.length;
        if (start + n * stride > buffer.byteLength) return null;
        const f = start % 4 === 0 ? new Float32Array(buffer, start, n * stride / 4)
                                  : new Float32Array(buffer.slice(start, start + n * stride));

        const positions = new Float32Array(3 * n), scales = new Float32Array(3 * n), rotations = new Float32Array(4 * n);
        const colors = new Uint8Array(4 * n), colorsClamped = new Uint8ClampedArray(colors.buffer);
        const q = new Uint8ClampedArray(4);
        const S = stride / 4;
        const { x, y, z, s0, s1, s2, c0, c1, c2, a, qw, qx, qy, qz } = col;
        for (let i = 0, o = 0; i < n; i++, o += S) {
            const i3 = 3 * i, i4 = 4 * i;
            positions[i3] = f[o + x];
            positions[i3 + 1] = f[o + y];
            positions[i3 + 2] = f[o + z];
            scales[i3] = Math.exp(f[o + s0]);
            scales[i3 + 1] = Math.exp(f[o + s1]);
            scales[i3 + 2] = Math.exp(f[o + s2]);
            colorsClamped[i4] = (0.5 + SH_C0 * f[o + c0]) * 255;
            colorsClamped[i4 + 1] = (0.5 + SH_C0 * f[o + c1]) * 255;
            colorsClamped[i4 + 2] = (0.5 + SH_C0 * f[o + c2]) * 255;
            colorsClamped[i4 + 3] = 1 / (1 + Math.exp(-f[o + a])) * 255;
            // gsplat: Quaternion(x, y, z, w).normalize(), stored as w x y z in bytes (v * 128 + 128), read back as (b - 128) / 128
            const rx = f[o + qx], ry = f[o + qy], rz = f[o + qz], rw = f[o + qw];
            const len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
            q[0] = rw / len * 128 + 128;
            q[1] = rx / len * 128 + 128;
            q[2] = ry / len * 128 + 128;
            q[3] = rz / len * 128 + 128;
            rotations[i4] = (q[0] - 128) / 128;
            rotations[i4 + 1] = (q[1] - 128) / 128;
            rotations[i4 + 2] = (q[2] - 128) / 128;
            rotations[i4 + 3] = (q[3] - 128) / 128;
        }
        return { vertexCount: n, positions, rotations, scales, colors };
    }

    globalThis.parseGaussianPly = parseGaussianPly;
})();
