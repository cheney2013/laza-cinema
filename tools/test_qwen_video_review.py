import unittest

from qwen_video_review import (
    apply_gate_policy, parse_json_response, sample_times, smart_sample_times,
    sanitize_static_review,
)


class QwenVideoReviewTests(unittest.TestCase):
    def test_parse_fenced_json(self):
        self.assertEqual(
            parse_json_response('```json\n{"verdict":"pass"}\n```')["verdict"], "pass")

    def test_sample_times_are_ordered_and_inside_video(self):
        times = sample_times(80.0, 12)
        self.assertEqual(len(times), 12)
        self.assertEqual(times, sorted(times))
        self.assertTrue(0 <= times[0] < times[-1] <= 80)

    def test_unverifiable_blocker_is_downgraded_and_score_gate_passes(self):
        result = apply_gate_policy({
            "scores": {"overall": 7}, "verdict": "revise",
            "blocking_issues": [{"category": "technical", "evidence": "transition unclear"}],
            "warnings": [], "uncertainties": [],
        })
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(result["blocking_issues"], [])
        self.assertEqual(len(result["warnings"]), 1)
        self.assertEqual(result["model_verdict"], "revise")

    def test_visible_artifact_remains_blocking(self):
        result = apply_gate_policy({
            "scores": {"overall": 8}, "verdict": "pass",
            "blocking_issues": [
                {"category": "generation_artifact", "evidence": "extra limb"}],
        })
        self.assertEqual(result["verdict"], "revise")
        self.assertEqual(len(result["blocking_issues"]), 1)

    def test_chinese_artifact_category_remains_blocking(self):
        result = apply_gate_policy({
            "scores": {"overall": 8}, "verdict": "pass",
            "blocking_issues": [
                {"category": "畸形/融化/重复肢体", "evidence": "手臂变形"}],
        })
        self.assertEqual(result["verdict"], "revise")
        self.assertEqual(result["blocking_issues"][0]["category"], "generation_artifact")

    def test_wrong_seat_is_blocking(self):
        result = apply_gate_policy({
            "scores": {"overall": 9}, "verdict": "pass",
            "blocking_issues": [
                {"category": "座位错误", "evidence": "人物从前排副驾变到后排"}],
        })
        self.assertEqual(result["verdict"], "revise")
        self.assertEqual(result["blocking_issues"][0]["category"], "spatial_position")

    def test_generic_prop_spatial_error_is_blocking(self):
        result = apply_gate_policy({
            "scores": {"overall": 9}, "verdict": "pass",
            "blocking_issues": [{
                "category": "prop placement error",
                "evidence": "The gun is attached to the wrong character.",
            }],
        })
        self.assertEqual(result["verdict"], "revise")
        self.assertEqual(result["blocking_issues"][0]["category"], "spatial_position")

    def test_smart_sample_unions_regular_grid_and_cuts(self):
        from unittest.mock import patch
        with patch("qwen_video_review.detect_scene_cuts", return_value=[1.25, 2.0]):
            times, cuts = smart_sample_times(None, 3.0, 2.0, 0.35)
        self.assertEqual(cuts, [1.25, 2.0])
        self.assertEqual(times, [0.0, 0.5, 1.0, 1.25, 1.5, 2.0, 2.5])

    def test_static_review_filters_motion_claim_and_normalizes_frame(self):
        result = sanitize_static_review({
            "warnings": [
                {"frame_number": 1, "evidence": "第2帧嘴唇动作与预期不符"},
                {"frame_number": 1, "category": "畸形/融化",
                 "evidence": "第3帧嘴部有明显融化"},
            ],
            "blocking_issues": [], "uncertainties": ["无法确认动作流畅度"],
        })
        self.assertEqual(len(result["warnings"]), 1)
        self.assertEqual(result["warnings"][0]["frame_number"], 3)
        self.assertEqual(result["uncertainties"], [])


if __name__ == "__main__":
    unittest.main()
