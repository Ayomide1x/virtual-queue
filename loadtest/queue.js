// Load test: many residents joining and watching their place in line, across
// many offices, while staff call and serve tickets and lobby screens update.
//
//   ./scripts/loadtest.sh                 # starts a throwaway Redis + server and runs this
//   k6 run loadtest/queue.js -e BASE_URL=http://127.0.0.1:3100
//
// Residents talk Socket.IO's wire protocol (Engine.IO v4) over a raw WebSocket,
// so each one behaves like a real phone: connect, subscribe, answer heartbeats.
// The server must allow many office creations and joins from one IP (the
// script sets RATE_LIMIT_* for its own server).

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';
import { setTimeout, clearTimeout, setInterval, clearInterval } from 'k6/timers';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3100';
const WS = BASE.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
const OFFICES = Number(__ENV.OFFICES || 25);
const RESIDENTS = Number(__ENV.RESIDENTS || 500); // concurrent residents at peak
const COUNTERS = Number(__ENV.COUNTERS || 3); // staff calling, per office
const HOLD = __ENV.HOLD || '3m';

// ----------------------------------------------------------------- metrics

const callToPhone = new Trend('call_to_phone_ms', true); // staff presses Call Next → resident's phone hears "called"
const firstUpdate = new Trend('first_update_ms', true); // subscribe → first ticket view
const wsConnect = new Trend('ws_connect_ms', true);
const ticketUpdates = new Counter('ticket_updates');
const lobbyUpdates = new Counter('lobby_updates');
const staffUpdates = new Counter('staff_updates');
const residentsCalled = new Counter('residents_called');
const errors = new Rate('errors'); // any unexpected HTTP status or socket failure
const wsErrors = new Counter('ws_errors');

export const options = {
  scenarios: {
    residents: {
      executor: 'ramping-vus',
      exec: 'resident',
      startVUs: 0,
      stages: [
        { duration: '45s', target: RESIDENTS },
        { duration: HOLD, target: RESIDENTS },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
    staff: { executor: 'constant-vus', exec: 'staff', vus: OFFICES * COUNTERS, duration: `${65 + parseDuration(HOLD)}s` },
    screens: { executor: 'constant-vus', exec: 'screen', vus: OFFICES * 2, duration: `${65 + parseDuration(HOLD)}s` }, // a lobby TV and a staff console per office
  },
  thresholds: {
    errors: ['rate<0.01'],
    'http_req_duration{name:join}': ['p(95)<250'],
    'http_req_duration{name:call}': ['p(95)<250'],
    'http_req_duration{name:complete}': ['p(95)<250'],
    call_to_phone_ms: ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  // Optional DNS override, e.g. RESOLVE=queue.localhost=127.0.0.1 (testing through a local proxy).
  hosts: __ENV.RESOLVE ? Object.fromEntries([__ENV.RESOLVE.split('=')]) : undefined,
};

function parseDuration(d) {
  const m = /^(\d+)(s|m)$/.exec(d);
  return m ? Number(m[1]) * (m[2] === 'm' ? 60 : 1) : 180;
}

// ------------------------------------------------------------------ setup

export function setup() {
  const offices = [];
  for (let i = 0; i < OFFICES; i++) {
    const r = http.post(`${BASE}/api/offices`, JSON.stringify({ name: `Load Office ${i + 1}`, timezone: 'UTC' }), {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'create_office' },
    });
    if (r.status !== 201) throw new Error(`could not create office: ${r.status} ${r.body}`);
    const body = r.json();
    offices.push({ id: body.officeId, key: body.staffKey });
  }
  return { offices };
}

const SERVICES = ['license', 'registration', 'id'];
const json = { headers: { 'Content-Type': 'application/json' } };
// "Nobody waiting" / "resident already left" answers are normal for staff.
const staffOk = http.expectedStatuses(200, 409);

// ---------------------------------------------------- Socket.IO over WebSocket

/**
 * Open a Socket.IO connection, run `subs` subscriptions, and call onEvent for
 * each event. Returns a handle with close(). Handles the Engine.IO heartbeat.
 */
function socketio(subs, onEvent) {
  const started = Date.now();
  const ws = new WebSocket(WS);
  let open = false;
  ws.onmessage = (e) => {
    const msg = String(e.data);
    if (msg === '2') return ws.send('3'); // ping → pong
    if (msg[0] === '0') return ws.send('40'); // Engine.IO open → connect to "/"
    if (msg.startsWith('40')) {
      open = true;
      wsConnect.add(Date.now() - started);
      for (const s of subs) ws.send('42' + JSON.stringify(['subscribe', s]));
      return;
    }
    if (msg.startsWith('42')) {
      const [event, data] = JSON.parse(msg.slice(2));
      onEvent(event, data);
    }
  };
  ws.onerror = (e) => {
    wsErrors.add(1);
    errors.add(1);
    console.warn(`websocket error: ${e.error}`);
  };
  return {
    close: () => ws.close(),
    get open() {
      return open;
    },
  };
}

// --------------------------------------------------------------- residents

export function resident(data) {
  const office = data.offices[(__VU + __ITER) % data.offices.length];
  const service = SERVICES[Math.floor(Math.random() * SERVICES.length)];
  const joined = http.post(`${BASE}/api/o/${office.id}/tickets`, JSON.stringify({ name: `R${__VU}`, service, lang: Math.random() < 0.3 ? 'es' : 'en' }), {
    ...json,
    tags: { name: 'join' },
  });
  const ok = check(joined, { 'joined (201)': (r) => r.status === 201 });
  errors.add(!ok);
  if (!ok) {
    sleep(2);
    return;
  }
  const ticketId = joined.json('ticket.id');
  const subscribedAt = Date.now();
  let gotFirst = false;
  let called = false;
  let done = false;

  const subs = [{ officeId: office.id, role: 'ticket', ticketId }];
  if (Math.random() < 0.1) subs.push({ officeId: office.id, role: 'lobby' }); // some also watch the lobby feed

  const finish = (leave) => {
    if (done) return;
    done = true;
    clearTimeout(giveUp);
    clearInterval(poll);
    if (leave) {
      const r = http.del(`${BASE}/api/o/${office.id}/tickets/${ticketId}`, null, { tags: { name: 'leave' }, responseCallback: staffOk });
      errors.add(r.status !== 200 && r.status !== 409);
    }
    sock.close();
  };

  const sock = socketio(subs, (event, payload) => {
    if (event === 'lobby:state') return lobbyUpdates.add(1);
    if (event !== 'ticket:update' || payload.id !== ticketId) return;
    ticketUpdates.add(1);
    if (!gotFirst) {
      gotFirst = true;
      firstUpdate.add(Date.now() - subscribedAt);
    }
    const v = payload.view;
    if (!v) return finish(false);
    if (v.ticket.status === 'called' && !called) {
      called = true;
      residentsCalled.add(1);
      // Same machine, same clock: server's call time → when this phone heard it.
      callToPhone.add(Math.max(0, Date.now() - v.ticket.calledAt));
      setTimeout(() => finish(false), 1000 + Math.random() * 2000); // walks to the counter
    } else if (v.ticket.status !== 'waiting' && v.ticket.status !== 'called') {
      finish(false);
    }
  });

  // Some phones also refresh the page now and then (a plain GET).
  const poll = setInterval(() => {
    const r = http.get(`${BASE}/api/o/${office.id}/tickets/${ticketId}`, { tags: { name: 'ticket' } });
    errors.add(r.status !== 200);
  }, 20000 + Math.random() * 10000);
  // Not everyone waits: give up after 1–2 minutes.
  const giveUp = setTimeout(() => finish(true), 60000 + Math.random() * 60000);
}

// -------------------------------------------------------------------- staff

let myCounter = 0;

export function staff(data) {
  // Each staff VU works one counter at one office.
  const n = exec.vu.idInTest - 1;
  const office = data.offices[n % data.offices.length];
  if (!myCounter) myCounter = 1 + (Math.floor(n / data.offices.length) % COUNTERS);
  const headers = { 'Content-Type': 'application/json', 'X-Staff-Key': office.key };
  const r = http.post(`${BASE}/api/o/${office.id}/counters/${myCounter}/call`, '{}', { headers, tags: { name: 'call' }, responseCallback: staffOk });
  if (r.status === 409) {
    const code = r.json('error');
    // Another staff VU already uses this counter: move to the next one.
    if (code === 'counter_busy') myCounter = (myCounter % COUNTERS) + 1;
    errors.add(code !== 'empty' && code !== 'counter_busy' && code !== 'paused');
    sleep(1 + Math.random()); // nobody waiting: look again shortly
    return;
  }
  errors.add(r.status !== 200);
  sleep(3 + Math.random() * 5); // serving
  const outcome = Math.random() < 0.06 ? 'no-show' : 'served';
  const done = http.post(`${BASE}/api/o/${office.id}/counters/${myCounter}/${outcome}`, '{}', { headers, tags: { name: 'complete' }, responseCallback: staffOk });
  // 409 = the resident left while at the counter; that's normal.
  errors.add(done.status !== 200 && done.status !== 409);
  sleep(0.5);
}

// ------------------------------------------------- lobby TVs & staff consoles

export function screen(data) {
  const i = (exec.vu.idInTest - 1) % (data.offices.length * 2);
  const office = data.offices[i % data.offices.length];
  const sub = i < data.offices.length ? { officeId: office.id, role: 'lobby' } : { officeId: office.id, role: 'staff', staffKey: office.key };
  const sock = socketio([sub], (event) => {
    if (event === 'lobby:state') lobbyUpdates.add(1);
    else if (event === 'staff:state') staffUpdates.add(1);
  });
  // Screens stay on for the whole test; reconnect every few minutes like a TV would after a blip.
  setTimeout(() => sock.close(), 120000);
}
