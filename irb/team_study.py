#!/usr/bin/env python3
"""Team formation study: randomize participants into study arms and build teams.

This script is NOT part of the dashboard. It runs offline on a CSV exported
from the dashboard and produces CSVs for the study records and a teams CSV
that can be imported on the dashboard (Teams page -> Import suggested teams).

Two steps, run separately so the assignment can be reviewed and archived
before any teams are made:

  1. assign   Read participants, classify each major as computing or
              non-computing by keyword match, then flip a fair coin per
              person for the arm: "same" (teammates share the major type)
              or "different" (teams mix major types).

                python3 irb/team_study.py assign participants.csv --out-dir out/

              Writes out/assignments.csv and out/majors.csv (every distinct
              major and how it was classified, for review).

  2. teams    Build teams of 3 or 4 inside each arm from assignments.csv.

                python3 irb/team_study.py teams out/assignments.csv --out-dir out/

              Writes out/teams.csv (one row per person; the "team" and
              "email" columns are what the dashboard import reads) and
              out/unassigned.csv for anyone who could not be placed.

Both steps take --seed. When it is left out a random seed is drawn and
printed, and it is written into every output row so a run can be repeated
exactly. Only the Python standard library is used.

Team rules:
  * Teams have 3 or 4 people, never 2 or 5. A pool of n people makes
    ceil(n / 4) teams; pools of 1, 2 or 5 cannot be split that way, so the
    people who don't fit are listed in unassigned.csv.
  * "same" arm: computing people are teamed with computing people and
    non-computing with non-computing, using every option first. Only the
    people left over after that are placed with others from the same arm.
  * "different" arm: every team gets people of both major types when the
    pool allows it, spread as evenly as possible.
"""

import argparse
import csv
import math
import os
import random
import re
import secrets
import sys

COMPUTING = "computing"
NON_COMPUTING = "non_computing"
UNKNOWN = "unknown"
SAME = "same"
DIFFERENT = "different"

# Whole-word, case-insensitive. A major is computing when any pattern matches.
# Edit this list (or pass --majors with overrides) and re-run step 1.
COMPUTING_PATTERNS = [
    r"comput\w*",  # computer science, computing, computational ..., computer engineering
    r"software",
    r"informatics",
    r"cyber\s*security|cybersecurity|cyber",
    r"data\s+science|data\s+analytics|data\s+engineering",
    r"information\s+(technology|systems|science)",
    r"artificial\s+intelligence",
    r"machine\s+learning",
    r"robotics",
    r"game\s+(design|development)",
    r"electrical\s+(and|&)\s+computer",
    r"cs",
    r"cse",
    r"ece",
    r"eecs",
    r"cics",
    r"it",
    r"ai",
]
COMPUTING_RE = re.compile(r"\b(" + "|".join(COMPUTING_PATTERNS) + r")\b", re.IGNORECASE)

TEAM_MIN = 3
TEAM_MAX = 4


# ---------------------------------------------------------------- reading


def read_csv(path):
    """Read a CSV into (header, rows as dicts). Handles the dashboard's BOM."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        return reader.fieldnames or [], list(reader)


def find_column(header, *patterns, required=True):
    """The first header matching any regex (case-insensitive)."""
    for pattern in patterns:
        for name in header:
            if re.search(pattern, name or "", re.IGNORECASE):
                return name
    if required:
        sys.exit("Couldn't find a column matching %s in: %s" % (" or ".join(patterns), ", ".join(header)))
    return None


def write_csv(path, header, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=header, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def normalize_major(text):
    return re.sub(r"\s+", " ", (text or "").strip())


def classify(major, overrides):
    """computing / non_computing / unknown for one major string."""
    key = normalize_major(major).lower()
    if key in overrides:
        return overrides[key]
    if not key or key in ("n/a", "na", "none", "-", "undecided", "undeclared"):
        return UNKNOWN
    return COMPUTING if COMPUTING_RE.search(key) else NON_COMPUTING


def read_overrides(path):
    """majors.csv from a previous run, edited by hand: major,major_type."""
    if not path:
        return {}
    header, rows = read_csv(path)
    major_col = find_column(header, r"^major$")
    type_col = find_column(header, r"^major_type$")
    out = {}
    for row in rows:
        value = (row.get(type_col) or "").strip().lower()
        if value not in (COMPUTING, NON_COMPUTING, UNKNOWN):
            sys.exit("majors file: %r has major_type %r (use computing, non_computing or unknown)" % (row.get(major_col), value))
        out[normalize_major(row.get(major_col)).lower()] = value
    return out


def consents(value):
    return bool(re.match(r"\s*yes\b", value or "", re.IGNORECASE))


# ---------------------------------------------------------------- step 1


def cmd_assign(args):
    seed = args.seed if args.seed is not None else secrets.randbelow(2**31)
    rng = random.Random(seed)
    header, rows = read_csv(args.participants)
    name_col = find_column(header, r"^name$", r"full name", r"name")
    email_col = find_column(header, r"^email$", r"email")
    major_col = find_column(header, r"^major$", r"major")
    consent_col = None if args.no_consent_filter else find_column(header, r"research", required=False)
    overrides = read_overrides(args.majors)

    seen = set()
    people, excluded = [], []
    for row in rows:
        email = (row.get(email_col) or "").strip().lower()
        base = {"name": (row.get(name_col) or "").strip(), "email": email, "major": normalize_major(row.get(major_col))}
        if not email:
            continue
        if email in seen:
            excluded.append(dict(base, reason="duplicate email"))
            continue
        seen.add(email)
        if consent_col and not consents(row.get(consent_col)):
            excluded.append(dict(base, reason="did not consent to the research study"))
            continue
        major_type = classify(base["major"], overrides)
        if major_type == UNKNOWN:
            if args.unknown == "exclude":
                excluded.append(dict(base, reason="major missing or unclear"))
                continue
            major_type = args.unknown
        people.append(dict(base, major_type=major_type))

    # Coin flip per person, in a fixed order so the seed reproduces it.
    people.sort(key=lambda p: p["email"])
    for p in people:
        p["arm"] = SAME if rng.random() < 0.5 else DIFFERENT
        p["seed"] = seed

    os.makedirs(args.out_dir, exist_ok=True)
    write_csv(os.path.join(args.out_dir, "assignments.csv"),
              ["name", "email", "major", "major_type", "arm", "seed"], people)
    if excluded:
        write_csv(os.path.join(args.out_dir, "excluded.csv"), ["name", "email", "major", "reason"], excluded)

    majors = {}
    for row in rows:
        major = normalize_major(row.get(major_col))
        entry = majors.setdefault(major.lower(), {"major": major, "major_type": classify(major, overrides), "people": 0})
        entry["people"] += 1
    write_csv(os.path.join(args.out_dir, "majors.csv"), ["major", "major_type", "people"],
              sorted(majors.values(), key=lambda m: (m["major_type"], m["major"].lower())))

    print("Seed: %d" % seed)
    print("Participants: %d (excluded %d)" % (len(people), len(excluded)))
    for arm in (SAME, DIFFERENT):
        for major_type in (COMPUTING, NON_COMPUTING):
            count = sum(1 for p in people if p["arm"] == arm and p["major_type"] == major_type)
            print("  %-9s arm, %-13s %d" % (arm, major_type + ":", count))
    for arm in (SAME, DIFFERENT):
        n = sum(1 for p in people if p["arm"] == arm)
        sizes = team_sizes(n)
        print("  %s arm: %d people -> %d teams (%s)%s" % (
            arm, n, len(sizes), describe_sizes(sizes),
            "" if sum(sizes) == n else ", %d can't be placed" % (n - sum(sizes))))
    print("Review %s before running the teams step." % os.path.join(args.out_dir, "majors.csv"))


# ---------------------------------------------------------------- team sizes


def team_sizes(n):
    """Sizes (3s and 4s) covering as many of n people as possible.

    ceil(n / 4) teams, with as few teams of 3 as needed: n = 3a + 4b.
    Pools of 1, 2 and 5 can't be covered exactly; they get the largest
    coverable part.
    """
    for covered in range(n, -1, -1):
        if covered == 0:
            return []
        teams = math.ceil(covered / TEAM_MAX)
        fours = covered - TEAM_MIN * teams
        if 0 <= fours <= teams:
            return [TEAM_MAX] * fours + [TEAM_MIN] * (teams - fours)
    return []


def describe_sizes(sizes):
    if not sizes:
        return "none"
    return ", ".join("%d of %d" % (sizes.count(s), s) for s in (TEAM_MAX, TEAM_MIN) if sizes.count(s))


# ---------------------------------------------------------------- step 2


def build_same_arm(people, rng):
    """Teams of one major type first; leftovers are then mixed in.

    Each major type is split into as many full 3/4 teams as it can fill on
    its own. The few people left over (a type with 1, 2 or 5 people) first
    join a team of 3 of their own type, then form or join mixed teams.
    """
    groups = {COMPUTING: [], NON_COMPUTING: []}
    for p in people:
        groups[p["major_type"]].append(p)
    teams, leftovers = [], []
    for major_type in (COMPUTING, NON_COMPUTING):
        pool = groups[major_type][:]
        rng.shuffle(pool)
        sizes = team_sizes(len(pool))
        for size in sizes:
            teams.append(pool[:size])
            pool = pool[size:]
        leftovers.extend(pool)

    # Keep teams single-type where possible: a leftover joins a team of 3 of
    # its own type.
    rest = []
    for p in leftovers:
        home = next((t for t in teams if len(t) < TEAM_MAX and all(m["major_type"] == p["major_type"] for m in t)), None)
        if home is not None:
            home.append(p)
        else:
            rest.append(p)
    return place_rest(teams, rest, rng)


def place_rest(teams, rest, rng):
    """Leftovers become new teams of 3/4 or fill any team of 3."""
    rng.shuffle(rest)
    sizes = team_sizes(len(rest))
    for size in sizes:
        teams.append(rest[:size])
        rest = rest[size:]
    unplaced = []
    for p in rest:
        home = next((t for t in teams if len(t) < TEAM_MAX), None)
        if home is not None:
            home.append(p)
        else:
            unplaced.append(p)
    # Every team is full and 1-2 people are left: take people from teams of
    # 4 (leaving valid teams of 3) to make one more team of 3.
    while unplaced and len(unplaced) < TEAM_MIN:
        donor = next((t for t in teams if len(t) == TEAM_MAX), None)
        if donor is None:
            break
        unplaced.append(donor.pop())
    if len(unplaced) == TEAM_MIN:
        teams.append(unplaced)
        unplaced = []
    return teams, unplaced


def build_different_arm(people, rng):
    """Teams of 3/4 that each mix major types as evenly as the pool allows.

    The minority type is dealt one per team first (so as many teams as
    possible get both types), then everyone else fills the teams.
    """
    sizes = team_sizes(len(people))
    groups = {COMPUTING: [], NON_COMPUTING: []}
    for p in people:
        groups[p["major_type"]].append(p)
    for pool in groups.values():
        rng.shuffle(pool)
    minority, majority = sorted(groups.values(), key=len)
    order = minority + majority
    teams = [[] for _ in sizes]
    # Deal round-robin, skipping full teams: the minority type lands one per
    # team before anyone doubles up, then the majority fills the rest.
    i = 0
    for p in order[:sum(sizes)]:
        while len(teams[i % len(teams)]) >= sizes[i % len(teams)]:
            i += 1
        teams[i % len(teams)].append(p)
        i += 1
    return teams, order[sum(sizes):]


def composition(team):
    c = sum(1 for m in team if m["major_type"] == COMPUTING)
    return "%dC/%dN" % (c, len(team) - c)


def cmd_teams(args):
    header, rows = read_csv(args.assignments)
    for col in ("name", "email", "major", "major_type", "arm", "seed"):
        if col not in header:
            sys.exit("assignments file is missing the %r column (use the file from the assign step)" % col)
    seed = args.seed if args.seed is not None else int(rows[0]["seed"]) if rows else 0
    rng = random.Random(seed + 1)  # a different stream from the coin flips

    by_arm = {SAME: [], DIFFERENT: []}
    for row in rows:
        if row["arm"] not in by_arm or row["major_type"] not in (COMPUTING, NON_COMPUTING):
            sys.exit("%s: arm must be same/different and major_type computing/non_computing" % row["email"])
        by_arm[row["arm"]].append(row)
    for arm in by_arm:
        by_arm[arm].sort(key=lambda p: p["email"])

    out, unplaced_all = [], []
    summary = []
    for arm, builder, prefix in ((SAME, build_same_arm, "S"), (DIFFERENT, build_different_arm, "D")):
        teams, unplaced = builder(by_arm[arm], rng)
        teams = [t for t in teams if t]
        for number, team in enumerate(teams, start=1):
            team_id = "%s%03d" % (prefix, number)
            kind = "single type" if len({m["major_type"] for m in team}) == 1 else "mixed"
            for member in team:
                out.append({
                    "team": team_id, "email": member["email"], "name": member["name"], "major": member["major"],
                    "major_type": member["major_type"], "arm": arm, "team_size": len(team),
                    "team_composition": composition(team), "team_kind": kind, "seed": seed,
                })
        for p in unplaced:
            unplaced_all.append(dict(p, reason="pool can't be split into teams of 3 or 4"))
        mismatched = sum(1 for t in teams if (arm == SAME) != (len({m["major_type"] for m in t}) == 1))
        summary.append((arm, len(by_arm[arm]), teams, unplaced, mismatched))

    os.makedirs(args.out_dir, exist_ok=True)
    write_csv(os.path.join(args.out_dir, "teams.csv"),
              ["team", "email", "name", "major", "major_type", "arm", "team_size", "team_composition", "team_kind", "seed"], out)
    write_csv(os.path.join(args.out_dir, "unassigned.csv"), ["name", "email", "major", "major_type", "arm", "reason"], unplaced_all)

    print("Seed: %d" % seed)
    for arm, n, teams, unplaced, mismatched in summary:
        sizes = [len(t) for t in teams]
        note = "mixed" if arm == SAME else "single type"
        print("%s arm: %d people -> %d teams (%s), %d unassigned, %d %s team(s) (pool couldn't avoid it)" % (
            arm, n, len(teams), describe_sizes(sizes), len(unplaced), mismatched, note))
    print("Wrote %s" % os.path.join(args.out_dir, "teams.csv"))


# ---------------------------------------------------------------- main


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    a = sub.add_parser("assign", help="classify majors and flip the arm coin")
    a.add_argument("participants", help="CSV exported from the dashboard (needs name, email and major columns)")
    a.add_argument("--out-dir", default="irb-out")
    a.add_argument("--seed", type=int)
    a.add_argument("--majors", help="majors.csv with corrected major_type values, to override the keyword match")
    a.add_argument("--unknown", choices=["exclude", COMPUTING, NON_COMPUTING], default="exclude",
                   help="what to do with a missing or unclear major (default: exclude and list in excluded.csv)")
    a.add_argument("--no-consent-filter", action="store_true",
                   help="keep everyone even if a research-study column says they did not consent")
    a.set_defaults(func=cmd_assign)

    t = sub.add_parser("teams", help="build teams of 3-4 inside each arm")
    t.add_argument("assignments", help="assignments.csv from the assign step")
    t.add_argument("--out-dir", default="irb-out")
    t.add_argument("--seed", type=int, help="defaults to the seed in assignments.csv")
    t.set_defaults(func=cmd_teams)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
