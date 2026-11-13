"""Tests for team_study.py. Run: python3 -m unittest irb/test_team_study.py"""

import csv
import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import team_study as ts  # noqa: E402


def people(computing, non_computing):
    out = []
    for i in range(computing):
        out.append({"email": "c%d@x.edu" % i, "name": "C%d" % i, "major": "Computer Science", "major_type": ts.COMPUTING})
    for i in range(non_computing):
        out.append({"email": "n%d@x.edu" % i, "name": "N%d" % i, "major": "Biology", "major_type": ts.NON_COMPUTING})
    return out


def kinds(team):
    return {m["major_type"] for m in team}


class TeamSizes(unittest.TestCase):
    def test_sizes_are_three_or_four_and_cover_everyone_possible(self):
        for n in range(0, 200):
            sizes = ts.team_sizes(n)
            self.assertTrue(all(s in (3, 4) for s in sizes), n)
            if n in (1, 2, 5):
                self.assertLess(sum(sizes), n)
            else:
                self.assertEqual(sum(sizes), n, n)
                self.assertEqual(len(sizes), -(-n // 4), "ceil(n/4) teams for %d" % n)


class Classify(unittest.TestCase):
    def test_keyword_match(self):
        computing = ["Computer Science", "CS", "Computer Engineering", "Informatics", "Data Science",
                     "Electrical and Computer Engineering", "Cybersecurity", "Information Technology", "CICS"]
        other = ["Biology", "Mathematics", "Mechanical Engineering", "Economics", "Political Science", "Statistics",
                 "Physics", "Business", "Digital Media"]
        for major in computing:
            self.assertEqual(ts.classify(major, {}), ts.COMPUTING, major)
        for major in other:
            self.assertEqual(ts.classify(major, {}), ts.NON_COMPUTING, major)
        self.assertEqual(ts.classify("", {}), ts.UNKNOWN)
        self.assertEqual(ts.classify("Undeclared", {}), ts.UNKNOWN)

    def test_overrides_win(self):
        self.assertEqual(ts.classify("Statistics", {"statistics": ts.COMPUTING}), ts.COMPUTING)


class SameArm(unittest.TestCase):
    def test_single_type_teams_first_and_valid_sizes(self):
        rng = random.Random(1)
        for c in range(0, 30):
            for n in range(0, 30):
                pool = people(c, n)
                teams, unplaced = ts.build_same_arm(pool, rng)
                teams = [t for t in teams if t]
                self.assertTrue(all(len(t) in (3, 4) for t in teams), (c, n))
                placed = sum(len(t) for t in teams)
                self.assertEqual(placed + len(unplaced), c + n)
                if c + n not in (1, 2, 5):
                    self.assertEqual(unplaced, [], (c, n))
                mixed = [t for t in teams if len(kinds(t)) > 1]
                # A type that can be split into 3s and 4s on its own is never mixed.
                if c not in (1, 2, 5) and n not in (1, 2, 5):
                    self.assertEqual(mixed, [], (c, n))
                self.assertLessEqual(len(mixed), 2, (c, n))


class DifferentArm(unittest.TestCase):
    def test_teams_mix_types_as_much_as_possible(self):
        rng = random.Random(2)
        for c in range(0, 30):
            for n in range(0, 30):
                pool = people(c, n)
                teams, unplaced = ts.build_different_arm(pool, rng)
                self.assertTrue(all(len(t) in (3, 4) for t in teams), (c, n))
                self.assertEqual(sum(len(t) for t in teams) + len(unplaced), c + n)
                if c + n not in (1, 2, 5):
                    self.assertEqual(unplaced, [], (c, n))
                mixed = sum(1 for t in teams if len(kinds(t)) > 1)
                self.assertEqual(mixed, min(len(teams), c, n), (c, n))


class EndToEnd(unittest.TestCase):
    def test_assign_then_teams(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "people.csv")
            majors = ["Computer Science", "Biology", "Informatics", "Economics", "", "Data Science", "Nursing"]
            with open(src, "w", newline="", encoding="utf-8-sig") as f:
                w = csv.writer(f)
                w.writerow(["Name", "Email", "University", "Major", "Optional research study"])
                for i in range(61):
                    consent = "No, do not use my data for research." if i == 3 else "Yes, I confirm and I agree to take part."
                    w.writerow(["P%d" % i, "p%d@x.edu" % i, "UMass", majors[i % len(majors)], consent])
            ts.main(["assign", src, "--out-dir", tmp, "--seed", "42"])
            first = open(os.path.join(tmp, "assignments.csv")).read()
            ts.main(["assign", src, "--out-dir", tmp, "--seed", "42"])
            self.assertEqual(first, open(os.path.join(tmp, "assignments.csv")).read(), "same seed, same arms")
            with open(os.path.join(tmp, "excluded.csv")) as f:
                reasons = [r["reason"] for r in csv.DictReader(f)]
            self.assertIn("did not consent to the research study", reasons)
            self.assertIn("major missing or unclear", reasons)

            ts.main(["teams", os.path.join(tmp, "assignments.csv"), "--out-dir", tmp])
            with open(os.path.join(tmp, "teams.csv")) as f:
                rows = list(csv.DictReader(f))
            with open(os.path.join(tmp, "assignments.csv")) as f:
                assigned = list(csv.DictReader(f))
            with open(os.path.join(tmp, "unassigned.csv")) as f:
                left = list(csv.DictReader(f))
            self.assertEqual(len(rows) + len(left), len(assigned))
            emails = [r["email"] for r in rows]
            self.assertEqual(len(emails), len(set(emails)), "nobody is on two teams")
            by_team = {}
            for r in rows:
                by_team.setdefault(r["team"], []).append(r)
            for team, members in by_team.items():
                self.assertIn(len(members), (3, 4), team)
                self.assertEqual(len({m["arm"] for m in members}), 1, "a team stays inside one arm")


if __name__ == "__main__":
    unittest.main()
