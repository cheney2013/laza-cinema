"""gs_ply_loader.js (the gaussian viewer's PLY parser) builds the same SplatData as gsplat.js's own PLYLoader, byte
for byte, and declines the layouts it does not cover. Runs both under Node; skipped without it."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

NODE = shutil.which("node")
BACKEND = Path(__file__).parent

HARNESS = r"""
import fs from 'node:fs';
import vm from 'node:vm';
const [bundlePath, loaderPath] = process.argv.slice(2);
vm.runInThisContext(fs.readFileSync(bundlePath, 'utf8') + '\nglobalThis.GSPLAT = GSPLAT;');
vm.runInThisContext(fs.readFileSync(loaderPath, 'utf8'));
const { PLYLoader, SplatData } = globalThis.GSPLAT;

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function value(name, i) {
    if (/^(x|y|z)$/.test(name)) return (rnd() - 0.5) * 200;
    if (/^(f_dc|features)_/.test(name)) return (rnd() - 0.5) * 8;                     // past both ends of 0..255
    if (/^opacity/.test(name)) return i % 50 === 1 ? 1000 : i % 50 === 2 ? -1000 : (rnd() - 0.5) * 30;
    if (/^scal/.test(name)) return i % 40 === 3 ? 100 : (rnd() - 0.5) * 20;         // exp(100) is no float32
    if (/^rot/.test(name)) return i % 97 === 5 ? 0 : (rnd() - 0.5) * 4;              // all zero: 0 / 0
    return rnd();
}
function ply(props, n, pad) {      // props: [type, name]; pad: a comment that moves the body off a 4-byte boundary
    let head = 'ply\nformat binary_little_endian 1.0\n' + (pad ? 'comment ' + 'p'.repeat(pad) + '\n' : '');
    head += `element vertex ${n}\n` + props.map(([t, nm]) => `property ${t} ${nm}\n`).join('') + 'end_header\n';
    const hb = new TextEncoder().encode(head);
    const size = { float: 4, uchar: 1 };
    const stride = props.reduce((s, [t]) => s + size[t], 0);
    const buf = new ArrayBuffer(hb.length + n * stride);
    new Uint8Array(buf).set(hb);
    const dv = new DataView(buf, hb.length);
    for (let i = 0, off = 0; i < n; i++)
        for (const [t, nm] of props) {
            if (t === 'float') dv.setFloat32(off, value(nm, i), true); else dv.setUint8(off, Math.floor(rnd() * 256));
            off += size[t];
        }
    return buf;
}
const f = (names) => names.map((nm) => ['float', nm]);
const SHARP = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2',
               'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const FULL = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2',
              ...Array.from({ length: 45 }, (_, k) => 'f_rest_' + k), 'opacity', 'scale_0', 'scale_1', 'scale_2',
              'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const ALIASES = ['rotation_3', 'features_1', 'z', 'scaling_2', 'opacity_0', 'x', 'rotation_0', 'features_0',
                 'scaling_0', 'rotation_2', 'y', 'features_2', 'scaling_1', 'rotation_1', 'normal_x'];
const same = [
    ['sharp 14 floats', f(SHARP), 0], ['body at offset +1', f(SHARP), 1], ['body at offset +2', f(SHARP), 2],
    ['body at offset +3', f(SHARP), 3], ['3dgs with normals and f_rest', f(FULL), 0], ['other names, any order', f(ALIASES), 1],
];
const declined = [
    ['colour as red/green/blue too', f([...SHARP, 'red', 'green', 'blue'])],
    ['a rotation missing', f(SHARP.slice(0, 13))],
    ['scale given twice', f([...SHARP, 'scaling_0'])],
    ['a uchar property', [...f(SHARP), ['uchar', 'flag']]],
];
const out = [];
for (const [name, props, pad] of same) {
    const buf = ply(props, 1000, pad);
    const ref = SplatData.Deserialize(new Uint8Array(PLYLoader._ParsePLYBuffer(buf, '')));
    const got = parseGaussianPly(buf);
    const diff = {};
    for (const k of ['positions', 'rotations', 'scales', 'colors']) {
        if (!got) { diff[k] = 'declined'; continue; }
        const a = new Uint8Array(ref[k].buffer, ref[k].byteOffset, ref[k].byteLength);
        const b = new Uint8Array(got[k].buffer, got[k].byteOffset, got[k].byteLength);
        let bad = a.length === b.length ? 0 : 'length ' + a.length + ' vs ' + b.length;
        if (bad === 0) for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) bad++;
        diff[k] = bad;
    }
    const nonFinite = got ? got.scales.filter((v) => !Number.isFinite(v)).length + got.rotations.filter((v) => v === -1).length : 0;
    out.push({ name, same: true, count: got ? got.vertexCount : null, diff, nonFinite });
}
for (const [name, props] of declined) out.push({ name, same: false, declined: parseGaussianPly(ply(props, 50, 0)) === null });
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class GsPlyLoader(unittest.TestCase):
    def test_same_splat_data_as_gsplat_and_declines_the_rest(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "harness.mjs").write_text(HARNESS, encoding="utf-8")
        proc = subprocess.run([NODE, str(tmp / "harness.mjs"), str(BACKEND / "gsplat-bundle.js"),
                               str(BACKEND / "gs_ply_loader.js")], capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        for case in json.loads(proc.stdout.strip().splitlines()[-1]):
            with self.subTest(case=case["name"]):
                if case["same"]:
                    self.assertEqual(case["count"], 1000, case)
                    self.assertEqual(case["diff"], {"positions": 0, "rotations": 0, "scales": 0, "colors": 0}, case)
                    self.assertGreater(case["nonFinite"], 0, case)      # the overflow and 0 / 0 rows were exercised
                else:
                    self.assertTrue(case["declined"], case)


if __name__ == "__main__":
    unittest.main()
