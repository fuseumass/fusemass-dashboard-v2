# IRB team formation study

Offline scripts for the team formation research study. **Not part of the
dashboard:** nothing here is imported by the backend or frontend, and the
dashboard never sees which study arm anyone is in. Python 3.8+, standard
library only.

## Workflow

1. **Export participants.** On the dashboard, open Admin → Team builder and
   download the "not on a team" CSV (`unteamed.csv`). Any CSV with name,
   email and major columns works. If it has a research-study column, only
   people whose answer starts with "Yes" are kept (`--no-consent-filter` keeps
   everyone).

2. **Assign arms.**

   ```sh
   python3 irb/team_study.py assign not-on-a-team.csv --out-dir irb-out/
   ```

   Each major is classified as computing or non-computing by keyword match
   (`COMPUTING_PATTERNS` in `team_study.py`). Each person then gets a fair
   coin flip for the arm: `same` (teammates share the major type) or
   `different` (teams mix major types).

   - `assignments.csv`: name, email, major, major_type, arm, seed.
   - `majors.csv`: every distinct major with its classification, for review.
     Fix any wrong row, then re-run with `--majors irb-out/majors.csv` and the
     same `--seed` to apply the corrections.
   - `excluded.csv`: duplicates, no consent, and missing or unclear majors
     (`--unknown computing|non_computing` keeps unclear majors instead).

   The seed is printed and stored in every row. Re-running with `--seed N`
   reproduces the exact same assignment.

3. **Build teams.**

   ```sh
   python3 irb/team_study.py teams irb-out/assignments.csv --out-dir irb-out/
   ```

   Teams have 3 or 4 people, never 2 or 5, and never cross arms. A pool of n
   people makes ceil(n / 4) teams.

   - **Same arm:** computing with computing, non-computing with
     non-computing. Every single-type option is used first. Only people left
     over (a type with 1, 2 or 5 people) are placed with others from the same
     arm.
   - **Different arm:** every team gets both major types when the pool allows
     it, spread as evenly as possible.

   - `teams.csv`: one row per person: team, email, name, major, major_type,
     arm, team_size, team_composition (for example `2C/2N`), team_kind, seed.
   - `unassigned.csv`: anyone who couldn't be placed (only possible when an
     arm has 1, 2 or 5 people in total).

4. **Import on the dashboard.** Admin → Teams → Import suggested teams, and
   upload `teams.csv`. Only the `team` and `email` columns are read. The
   preview shows what will happen before anything is sent. In each team the
   first person starts the team and everyone else gets an invite they can
   accept or decline. Team names are the default ("<first name>'s team"),
   never the study team id, so participants don't see their arm.

## Data handling

The output files contain names, emails and study arms. Keep `irb-out/` out
of git (it is in `.gitignore`) and store it where the IRB protocol says.

## Tests

```sh
python3 -m unittest irb/test_team_study.py
```
