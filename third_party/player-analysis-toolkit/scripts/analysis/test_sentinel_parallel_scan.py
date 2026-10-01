"""Windows-spawn regression checks for deterministic parallel pseudo matching."""
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from player_analysis_toolkit import sentinel
from player_analysis_toolkit import sentinel_resources


def fixture():
    reference = []
    # A single-record interpolation cell must fall back after game exclusion;
    # both directed records of one game must be excluded together.
    for index in range(10):
        for color in ("black", "white"):
            lower = 1700 if index == 0 else 1600
            reference.append({
                "gameId": f"ref-{index}", "targetPlayerId": f"p-{index}",
                "targetColor": color, "analysisScope": sentinel.SCOPES[0],
                "targetEloBand": {"lower": lower}, "opponentEloBand": {"lower": 1600},
                "targetOldR": lower + 50, "opponentOldR": 1650,
                "formalReferenceEligible": True, "loss_ge4_rate": index / 20,
                "engine_wld_loss_total_from_ply39": float(index),
            })
    targets = []
    for index in range(8):
        targets.append({**reference[index], "gameId": f"target-{index}",
                        "targetOldR": 1700, "opponentOldR": 1700,
                        "created": "2026-10-01T00:00:00Z"})
    return sentinel.score_target_records(targets, reference), reference


class ParallelScanTests(unittest.TestCase):
    def test_resource_budget_uses_total_ram_and_physical_cores(self):
        gib = 1024 ** 3
        self.assertEqual(sentinel_resources.worker_limit(8, 16 * gib), 8)
        self.assertEqual(sentinel_resources.worker_limit(32, 16 * gib), 14)
        self.assertEqual(sentinel_resources.worker_limit(64, 32 * gib), 30)
        with self.assertRaisesRegex(ValueError, "50%"):
            sentinel_resources.worker_limit(4, 2 * gib)
        with patch.object(sentinel_resources, "device_resources", return_value=(8, 16 * gib)):
            self.assertEqual(sentinel_resources.resolve_workers(None), 8)
            self.assertEqual(sentinel_resources.resolve_workers(4), 4)
            self.assertEqual(sentinel_resources.resolve_workers(100), 8)

    def test_automatic_worker_selection_preserves_results(self):
        scores, reference = fixture()
        expected = sentinel.run_pseudo_scan(scores, reference, replicates=30, bootstrap=30, workers=1)
        with patch.object(sentinel, "resolve_workers", return_value=2) as selected:
            actual = sentinel.run_pseudo_scan(scores, reference, replicates=30, bootstrap=30)
        selected.assert_called_once_with(None)
        self.assertEqual(actual, expected)

    def test_same_seed_exact_output_with_fallback_and_global_exclusion(self):
        scores, reference = fixture()
        scores["excludedReferenceGameIds"] = ["ref-3"]
        for seed in (20260814, 19):
            with self.subTest(seed=seed):
                serial = sentinel.run_pseudo_scan(scores, reference, replicates=80, bootstrap=100, seed=seed, workers=1)
                parallel = sentinel.run_pseudo_scan(scores, reference, replicates=80, bootstrap=100, seed=seed, workers=4)
                self.assertEqual(serial, parallel)

    def test_empty_calibratable_set(self):
        scores, reference = fixture()
        for row in scores["scores"]:
            row["calibratable"] = False
        self.assertEqual(
            sentinel.run_pseudo_scan(scores, reference, replicates=2, bootstrap=2, workers=1),
            sentinel.run_pseudo_scan(scores, reference, replicates=2, bootstrap=2, workers=4),
        )

    def test_invalid_worker_count(self):
        scores, reference = fixture()
        with self.assertRaisesRegex(ValueError, "worker"):
            sentinel.run_pseudo_scan(scores, reference, workers=0)

    def test_worker_matching_error_is_propagated(self):
        scores, reference = fixture()
        scores["scores"] = [scores["scores"][0]]
        with self.assertRaisesRegex(ValueError, "leave-one-game matching failed"):
            sentinel.run_pseudo_scan(scores, reference[:1], replicates=1, bootstrap=1, workers=4)

    def test_worker_keeps_custom_elo_bounds(self):
        old = (sentinel.MIN_ELO, sentinel.MAX_ELO, sentinel.ELO_WIDTH)
        try:
            sentinel.configure_elo_bounds(1600, 2686, 100)
            scores, reference = fixture()
            # The wider final band changes interpolation weights in workers.
            for index, row in enumerate(reference):
                row["targetEloBand"] = {"lower": 2400 if index % 3 else 2300}
            for row in scores["scores"]:
                row["targetOldR"] = 2450
            scores = sentinel.score_target_records(scores["scores"], reference)
            self.assertEqual(
                sentinel.run_pseudo_scan(scores, reference, replicates=20, bootstrap=20, workers=1),
                sentinel.run_pseudo_scan(scores, reference, replicates=20, bootstrap=20, workers=4),
            )
        finally:
            sentinel.configure_elo_bounds(*old)


if __name__ == "__main__":
    unittest.main()
