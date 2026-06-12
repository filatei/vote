# Load testing Torama Vote with k6

`k6-vote.js` exercises the endpoints a real election hits hardest: the landing
page, the ballot page, the public results page, and the `results.json` poll the
live tally fires every few seconds — plus, optionally, the full vote-casting
write path.

## Install k6

```bash
# macOS
brew install k6
# Debian/Ubuntu (e.g. the Linode host)
sudo gpg -k && sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

## Run

Read-only (safe against production — no data written):

```bash
k6 run -e BASE_URL=https://vote.torama.money -e ELECTION=<publicId> k6-vote.js
```

Include the write path (creates real ballots — use a **throwaway open election**):

```bash
k6 run -e BASE_URL=https://vote.torama.money \
       -e ELECTION=<publicId> -e OPTION=<optionId> \
       -e READ_VUS=200 -e VOTE_VUS=50 k6-vote.js
```

`<publicId>` is the id in the share link `…/e/<publicId>`. `<optionId>` is a
candidate's numeric id (view source on the ballot, or the codes/edit pages).
The vote scenario only runs when **both** `ELECTION` and `OPTION` are set, and
only makes sense for an **open** or **hybrid** election (its ballot is shown
directly without a code).

### Tunables (`-e`)

| Var          | Default | Meaning                                   |
|--------------|---------|-------------------------------------------|
| `BASE_URL`   | localhost:8090 | Target origin                      |
| `ELECTION`   | —       | Public id for the ballot/results paths    |
| `OPTION`     | —       | Option id to vote for (enables write path)|
| `READ_VUS`   | 200     | Peak concurrent readers                   |
| `VOTE_VUS`   | 50      | Peak concurrent voters                    |

## The rate-limit caveat (read this before blaming the app)

The app throttles **per client IP** (`RATE_LIMIT_GENERAL`, default 120/min;
`RATE_LIMIT_CODE`, default 20/10min). A single k6 machine shares one IP, so past
~2 req/s you'll see HTTP **429** responses — that's the limiter working, not the
app buckling. The script counts these separately (`http_429`) and does not treat
them as failures.

To measure real capacity from one source, temporarily raise the limits on the
server, run the test, then **revert**:

```bash
# on the host
cd /opt/vote
# add to .env:  RATE_LIMIT_GENERAL=100000   RATE_LIMIT_CODE=100000
sudo docker compose up -d --force-recreate vote_app
#  ... run k6 ...
# remove those two lines again, then:
sudo docker compose up -d --force-recreate vote_app
```

Alternatively drive the test from k6 Cloud or several regions so load arrives
from many IPs (closer to reality anyway).

## Reading the result

- `http_req_failed` — should stay under 2%. (429s are excluded as handled.)
- `http_req_duration p(95)` — 95th-percentile latency; threshold 1200 ms.
- `votes_cast` — ballots actually recorded by the write scenario.
- `checks` — share of assertions that passed (> 95%).

Watch the container while it runs: `docker stats vote_app vote_postgres vote_redis`.
The serializable cast transaction + hash-chain tail read is the main write
contention point — if `votes_cast` throughput plateaus while CPU on
`vote_postgres` climbs, that's the ceiling to note.
