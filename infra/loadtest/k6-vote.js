/* Torama Vote — k6 load test.
 *
 * Two scenarios:
 *   read  — hammers the public read paths a popular election generates the most
 *           of: landing page, ballot page, results page and the live results.json
 *           poll. Always runs.
 *   vote  — full cast flow against an OPEN/HYBRID election: GET the ballot, pull
 *           the CSRF token, POST /cast with a UNIQUE User-Agent per iteration so
 *           each request is a distinct "device" and actually records a ballot.
 *           Runs only when ELECTION and OPTION are provided.
 *
 * Usage:
 *   # read-only smoke (safe against production):
 *   k6 run -e BASE_URL=https://vote.torama.money -e ELECTION=<publicId> infra/loadtest/k6-vote.js
 *
 *   # include the write path (use a THROWAWAY open election — it creates real votes):
 *   k6 run -e BASE_URL=https://vote.torama.money \
 *          -e ELECTION=<publicId> -e OPTION=<optionId> \
 *          -e READ_VUS=200 -e VOTE_VUS=50 infra/loadtest/k6-vote.js
 *
 * IMPORTANT — rate limiting: the app throttles per client IP (RATE_LIMIT_GENERAL,
 * default 120/min). A single k6 box shares one IP, so beyond ~2 req/s you will
 * see HTTP 429s that are the limiter doing its job, not the app failing. To push
 * real concurrency from one source, temporarily raise the limits on the server:
 *     RATE_LIMIT_GENERAL=100000  RATE_LIMIT_CODE=100000
 * (set in /opt/vote/.env, `docker compose up -d --force-recreate vote_app`),
 * run the test, then REVERT. Or drive the test from k6 Cloud / multiple regions.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:8090').replace(/\/$/, '');
const ELECTION = __ENV.ELECTION || '';
const OPTION = __ENV.OPTION || '';
const READ_VUS = Number(__ENV.READ_VUS || 200);
const VOTE_VUS = Number(__ENV.VOTE_VUS || 50);

const votesCast = new Counter('votes_cast');
const voteRejected = new Rate('vote_rejected');
const rateLimited = new Counter('http_429');

const scenarios = {
  read: {
    executor: 'ramping-vus',
    exec: 'readFlow',
    startVUs: 0,
    stages: [
      { duration: '30s', target: READ_VUS },
      { duration: '1m30s', target: READ_VUS },
      { duration: '20s', target: 0 },
    ],
  },
};

// Only load-test the write path when a target election + option are supplied.
if (ELECTION && OPTION) {
  scenarios.vote = {
    executor: 'ramping-vus',
    exec: 'voteFlow',
    startVUs: 0,
    stages: [
      { duration: '30s', target: VOTE_VUS },
      { duration: '1m', target: VOTE_VUS },
      { duration: '20s', target: 0 },
    ],
  };
}

export const options = {
  scenarios,
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<1200'],
    checks: ['rate>0.95'],
  },
};

function note429(res) {
  if (res.status === 429) rateLimited.add(1);
}

export function readFlow() {
  let res = http.get(`${BASE}/`, { tags: { name: 'landing' } });
  check(res, { 'landing 200': (r) => r.status === 200 || r.status === 429 });
  note429(res);

  if (ELECTION) {
    res = http.get(`${BASE}/e/${ELECTION}`, { tags: { name: 'ballot' } });
    check(res, { 'ballot ok': (r) => r.status === 200 || r.status === 429 });
    note429(res);

    res = http.get(`${BASE}/e/${ELECTION}/results`, { tags: { name: 'results' } });
    check(res, { 'results ok': (r) => r.status === 200 || r.status === 429 });
    note429(res);

    // The live poll the results page fires every 4s — the hottest read path.
    res = http.get(`${BASE}/e/${ELECTION}/results.json`, {
      headers: { Accept: 'application/json' },
      tags: { name: 'results.json' },
    });
    check(res, { 'results.json ok': (r) => r.status === 200 || r.status === 429 });
    note429(res);
  }
  sleep(1);
}

export function voteFlow() {
  // Unique UA per iteration → unique device fingerprint → each ballot counts.
  const ua = `k6-loadtest/${__VU}-${__ITER}-${Date.now()}`;
  const params = { headers: { 'User-Agent': ua }, tags: { name: 'cast' } };

  const ballot = http.get(`${BASE}/e/${ELECTION}`, {
    headers: { 'User-Agent': ua },
    tags: { name: 'ballot-get' },
  });
  note429(ballot);
  const m = ballot.body && ballot.body.match(/name="_csrf"\s+value="([^"]+)"/);
  const token = m ? m[1] : '';
  if (!check(ballot, { 'ballot loaded': (r) => r.status === 200, 'csrf present': () => !!token })) {
    sleep(1);
    return;
  }

  const res = http.post(
    `${BASE}/cast`,
    { _csrf: token, election: ELECTION, option: OPTION, code: '' },
    params,
  );
  note429(res);
  const ok = res.status === 200;
  // 409 = device already voted, 429 = rate limited — both are "handled", not errors.
  check(res, { 'cast handled': (r) => [200, 409, 429].includes(r.status) });
  if (ok) votesCast.add(1);
  voteRejected.add(!ok && res.status !== 429);
  sleep(1);
}
