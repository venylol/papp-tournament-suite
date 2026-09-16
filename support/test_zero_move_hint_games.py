"""Exercise game-count validation without loading engines or hash routines."""
import ast
import csv
import io
import json
from pathlib import Path
import sys
import unittest

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "third_party/player-analysis-toolkit/scripts/analysis/run_player_investigation.py"
TOOLKIT_SRC = ROOT / "third_party/player-analysis-toolkit/src"
sys.path.insert(0, str(TOOLKIT_SRC))

from player_analysis_toolkit.investigation_eligibility import (
    actual_placement_count,
    validate_eligible_details,
)


class CsvSource:
    def __init__(self, text):
        self.text = text

    def open(self, *args, **kwargs):
        assert kwargs["encoding"] == "utf-8"
        return io.StringIO(self.text)


class GameCountTests(unittest.TestCase):
    def setUp(self):
        tree = ast.parse(SCRIPT.read_text(encoding="utf-8-sig"))
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name in {"hint_source_game_count", "run_safe_hints", "validate_group_placements"}]
        self.namespace = {"Path": Path, "csv": csv, "Run": object,
                          "read_json": lambda value: value,
                          "MODEL_ROOT": ROOT, "TOOLKIT_ROOT": ROOT}
        self.namespace["Any"] = object
        self.namespace["details"] = lambda bundle: bundle["details"]
        self.namespace["validate_eligible_details"] = validate_eligible_details
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(SCRIPT), "exec"), self.namespace)
        placements = [{"m": f"{chr(ord('a') + index % 8)}{index // 8 + 1}"} for index in range(16)]
        self.bundle = {"details": [
            {"id": "played", "position": {"moves": placements + [{"s": "LOSE:RESIGN"}]}},
        ]}
        self.short_bundle = {"details": [
            {"id": "resigned", "position": {"moves": [{"s": "LOSE:RESIGN"}]}},
        ]}

    def count(self, text, bundle=None):
        return self.namespace["hint_source_game_count"](CsvSource(text), bundle or self.bundle)

    def test_eligible_game_is_counted(self):
        self.assertEqual(self.count("game_id\nplayed\nplayed\n"), 1)

    def test_short_game_is_rejected_before_analysis(self):
        with self.assertRaisesRegex(ValueError, "at least 16 coordinate placements"):
            self.namespace["validate_group_placements"](self.short_bundle, {"resigned"})

    def test_sixteenth_placement_then_resign_is_eligible(self):
        self.assertEqual(actual_placement_count(self.bundle["details"][0]), 16)
        self.namespace["validate_group_placements"](self.bundle, {"played"})

    def test_missing_played_game_is_still_rejected(self):
        with self.assertRaisesRegex(ValueError, "missing=.*played"):
            self.count("game_id\n")

    def test_unexpected_game_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unexpected=.*extra"):
            self.count("game_id\nplayed\nextra\n")

    def test_all_short_games_fail_clearly(self):
        with self.assertRaisesRegex(ValueError, "at least 16 coordinate placements"):
            self.count("game_id\n", self.short_bundle)

    def test_cached_manifest_count_does_not_reach_assembly(self):
        commands = []
        class RunStub:
            config = {"account": "test", "reportedGameIds": ["played"],
                      "paths": {"engine": "engine"},
                      "parameters": {"hintHashLevel": 25, "hint1Workers": 1, "hint6Workers": 1}}

            def path(self, name):
                return ROOT / name

            def python(self):
                return "python"

            def run_stage(self, name, command, outputs, **kwargs):
                commands.append((name, command))

        self.namespace["read_json"] = lambda path: {"shape": {
            "games": 30, "rows": 1608, "placements": 1588, "passes": 20}}
        self.namespace["hint_source_game_count"] = lambda source, bundle: 29
        self.namespace["run_safe_hints"](RunStub())
        name, command = commands[-1]
        self.assertEqual(name, "hint_assembly")
        self.assertEqual(command[command.index("--expected-games") + 1], "29")
        self.assertEqual(command[command.index("--expected-rows") + 1], "1608")


class ProfileMembershipTests(unittest.TestCase):
    def setUp(self):
        script = ROOT / "third_party/player-analysis-toolkit/research/tcn_loss_model/scripts/data/materialize_oq_profile_context.py"
        tree = ast.parse(script.read_text(encoding="utf-8-sig"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and node.name == "align_game_metadata")
        namespace = {"pd": pd, "np": np}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(script), "exec"), namespace)
        self.align = namespace["align_game_metadata"]
        self.games = pd.DataFrame({"game_id": ["played", "empty"], "length": [60, 0]}).set_index("game_id")

    def test_only_zero_move_metadata_is_excluded(self):
        games, excluded = self.align(self.games, np.array(["played"]))
        self.assertEqual(list(games.index), ["played"])
        self.assertEqual(excluded, ["empty"])
        self.assertEqual(len(self.games), 2)

    def test_nonempty_game_cannot_disappear(self):
        with self.assertRaisesRegex(ValueError, "missing_model_games=.*played"):
            self.align(self.games, np.array(["empty"]))

    def test_missing_metadata_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "missing_metadata=.*unknown"):
            self.align(self.games, np.array(["played", "unknown"]))

    def test_unknown_length_does_not_enable_exclusion(self):
        with self.assertRaises(ValueError):
            self.align(self.games.drop(columns="length"), np.array(["played"]))

    def test_equal_membership_preserves_model_order(self):
        games, excluded = self.align(self.games, np.array(["empty", "played"]))
        self.assertEqual(list(games.index), ["empty", "played"])
        self.assertEqual(excluded, [])


if __name__ == "__main__":
    unittest.main()
