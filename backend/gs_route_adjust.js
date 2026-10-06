// The hand adjustment of a clip added at a route's start or end, for the gaussian viewer's live preview: the same
// sums as route_gs.adjustment() (test_route_gs.AdjustParity checks one against the other). The backend writes the
// result; this only moves the clip's gaussians on screen while the sliders move.
//
// An adjustment {scale, yaw, pitch, roll, right, up, forward} is about the seam camera: pivot (its position) and
// axes (its camera-to-route rotation, rows of the 3x3 matrix; columns right / down / forward, OpenCV) in the
// splat's own units, unitsPerMetre the splat units of one metre. x -> pivot + s R (x - pivot) + offset; yaw turns
// the clip's far end to the right, pitch lifts it, roll lowers its right side.
(function () {
    function rot(axis, deg) {
        const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        if (axis === 'x') return [[1, 0, 0], [0, c, -s], [0, s, c]];
        if (axis === 'y') return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
        return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
    }
    const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
    const tr = (A) => [0, 1, 2].map((i) => [A[0][i], A[1][i], A[2][i]]);
    const mv = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

    // -> {s, R (rows), t}: x -> s R x + t
    function routeAdjustment(adj, pivot, axes, unitsPerMetre) {
        const a = adj || {};
        const s = num(a.scale, 1);
        const L = mul(mul(rot('y', num(a.yaw, 0)), rot('x', num(a.pitch, 0))), rot('z', num(a.roll, 0)));
        const R = mul(mul(axes, L), tr(axes));
        const off = mv(axes, [num(a.right, 0), -num(a.up, 0), num(a.forward, 0)]);
        const Rp = mv(R, pivot);
        const t = [0, 1, 2].map((i) => pivot[i] - s * Rp[i] + off[i] * unitsPerMetre);
        return { s, R, t };
    }

    function quat(m) {      // rotation matrix (rows) -> [x, y, z, w], as gsplat's Quaternion takes it
        const trace = m[0][0] + m[1][1] + m[2][2];
        let x, y, z, w, S;
        if (trace > 0) {
            S = Math.sqrt(trace + 1) * 2;
            w = 0.25 * S; x = (m[2][1] - m[1][2]) / S; y = (m[0][2] - m[2][0]) / S; z = (m[1][0] - m[0][1]) / S;
        } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
            S = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
            w = (m[2][1] - m[1][2]) / S; x = 0.25 * S; y = (m[0][1] + m[1][0]) / S; z = (m[0][2] + m[2][0]) / S;
        } else if (m[1][1] > m[2][2]) {
            S = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
            w = (m[0][2] - m[2][0]) / S; x = (m[0][1] + m[1][0]) / S; y = 0.25 * S; z = (m[1][2] + m[2][1]) / S;
        } else {
            S = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
            w = (m[1][0] - m[0][1]) / S; x = (m[0][2] + m[2][0]) / S; y = (m[1][2] + m[2][1]) / S; z = 0.25 * S;
        }
        return [x, y, z, w];
    }

    // The splat on screen was written with adjustment `cur`; showing `next` instead is x -> next(cur^-1(x)), as a
    // gsplat object transform: position, rotation [x, y, z, w], uniform scale (gsplat composes T R S).
    function routeAdjustDelta(next, cur, pivot, axes, unitsPerMetre) {
        const n = routeAdjustment(next, pivot, axes, unitsPerMetre);
        const c = routeAdjustment(cur, pivot, axes, unitsPerMetre);
        const s = n.s / c.s;
        const R = mul(n.R, tr(c.R));
        const Rt = mv(R, c.t);
        return { position: [0, 1, 2].map((i) => n.t[i] - s * Rt[i]), rotation: quat(R), scale: s, R };
    }

    globalThis.routeAdjustment = routeAdjustment;
    globalThis.routeAdjustDelta = routeAdjustDelta;
})();
