import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { routeScaledData } from './routeScale';

describe('routeScaledData', () => {
  it('scales the metres of hand adjustments and the rebuild unit, nothing else', () => {
    const out = routeScaledData(
      { routeExtendAdjust: { '/uploads/a.mp4': { scale: 1.1, yaw: 3, right: 2, up: -1, forward: 0.5 } },
        routeSettings: { metres_per_unit: 30.5, mask_people: true } },
      { scale: 0.5, metres_per_unit: 15.25 });
    assert.deepEqual(out.routeExtendAdjust, { '/uploads/a.mp4': { scale: 1.1, yaw: 3, right: 1, up: -0.5, forward: 0.25 } });
    assert.deepEqual(out.routeSettings, { metres_per_unit: 15.25, mask_people: true });
  });

  it('leaves a node alone when the result is not a rescale', () => {
    assert.deepEqual(routeScaledData({ routeSettings: { metres_per_unit: 30.5 } }, { metres_per_unit: 30.5 }), {});
    assert.deepEqual(routeScaledData({}, null), {});
  });
});
