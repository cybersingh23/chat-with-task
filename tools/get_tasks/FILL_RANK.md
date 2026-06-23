# fill_rank.py

Builds a `rank.json` (full attempter A/B submission: metadata, model names, trajectory +
container-snapshot URLs, grading, failure modes, preference rating, rationales) and downloads
both trajectories for one or more tasks.

## Prerequisite

```bash
export REDASH_API_KEY=...   # must be set in your environment
```

## Usage

```bash
# Single task (hex id, task-NNN-... folder name, or bare NNN)
python3 fill_rank.py 6a108ffc3319ef4abee22e59

# Batch
python3 fill_rank.py <id1> <id2> <id3>

# Offline: render JSON from a saved before-blob / task doc (no network)
python3 fill_rank.py --from-file validation_node/response_example.json
```

## Output

One folder per task:

```
ranks/<task_id>/
  a.json        # Model Alpha trajectory
  b.json        # Model Beta trajectory
  rank.json     # assembled submission
```
