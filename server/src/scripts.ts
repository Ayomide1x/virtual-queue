/**
 * Lua scripts for every queue mutation. Redis executes a script atomically —
 * no other command runs while it is in progress — so these are the
 * concurrency boundary of the whole app.
 *
 * Every key a script writes gets an expiry in the same step, so no office key
 * can ever be left without a TTL (offices expire after a period of inactivity).
 *
 * Ticket/queue keys are derived inside the scripts from the office prefix
 * (fine for a single Redis instance; would need hash tags for Redis Cluster).
 *
 * Queue order: each service's queue is a sorted set scored by
 *
 *     tier * 1e15  +  orderAt * 100  +  seq % 100
 *
 * tier 0 = priority, 1 = regular. orderAt is the join time for walk-ins and
 * the slot start for appointments, so a checked-in appointment sits behind
 * people who joined before its slot and ahead of everyone who joined after.
 * seq breaks same-millisecond ties first-come, first-served. All values stay
 * below 2^53, so scores are exact. ZPOPMIN therefore always takes the right
 * ticket in one atomic step.
 */

const SCORE_FN = `
local function score(priority, orderAt, seq)
  local tier = 1
  if priority and priority ~= '' then tier = 0 end
  return tier * 1e15 + tonumber(orderAt) * 100 + (tonumber(seq) % 100)
end
`;

/**
 * KEYS[1] seq key
 * ARGV: prefix, id, name, service, code, joinedAt, seqTtl, ttl, lang
 * Returns the ticket number.
 */
export const JOIN = `${SCORE_FN}
local prefix, id, name, service, code, joinedAt, seqTtl, ttl, lang = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6], ARGV[7], ARGV[8], ARGV[9]
local seq = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], seqTtl)
local number = code .. '-' .. string.format('%03d', ((seq - 1) % 999) + 1)
local tk = prefix .. 'ticket:' .. id
redis.call('HSET', tk,
  'id', id, 'number', number, 'name', name, 'service', service, 'kind', 'walkin',
  'status', 'waiting', 'joinedAt', joinedAt, 'orderAt', joinedAt, 'seq', seq, 'recallCount', 0, 'lang', lang)
redis.call('EXPIRE', tk, ttl)
local q = prefix .. 'queue:' .. service
redis.call('ZADD', q, score(nil, joinedAt, seq), id)
redis.call('EXPIRE', q, ttl)
return number
`;

/**
 * KEYS[1] counters hash, KEYS[2] paused set, KEYS[3] recent list, KEYS[4] today's stats hash
 * ARGV: prefix, counter, now, recentMax, ttl, statsTtl, service1 [, service2, ...]
 * Picks the longest-waiting ticket among the given (unpaused) services.
 * Returns {'ok', ticketId} or {'err', code[, detail]}.
 */
export const CALL_NEXT = `
local prefix, counter, now, recentMax = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
local ttl, statsTtl = ARGV[5], ARGV[6]

local busy = redis.call('HGET', KEYS[1], counter)
if busy then
  if redis.call('HGET', prefix .. 'ticket:' .. busy, 'status') == 'called' then
    return {'err', 'counter_busy', busy}
  end
  redis.call('HDEL', KEYS[1], counter)
end

local open = {}
for i = 7, #ARGV do
  if redis.call('SISMEMBER', KEYS[2], ARGV[i]) == 0 then table.insert(open, ARGV[i]) end
end
if #open == 0 then return {'err', 'paused'} end

-- Loop only to skip stale entries (e.g. a ticket hash that expired).
for _ = 1, 1000 do
  local bestSvc, bestScore = nil, nil
  for _, svc in ipairs(open) do
    local head = redis.call('ZRANGE', prefix .. 'queue:' .. svc, 0, 0, 'WITHSCORES')
    if head[1] then
      local score = tonumber(head[2])
      if bestScore == nil or score < bestScore then bestSvc, bestScore = svc, score end
    end
  end
  if bestSvc == nil then return {'err', 'empty'} end

  local id = redis.call('ZPOPMIN', prefix .. 'queue:' .. bestSvc)[1]
  local tk = prefix .. 'ticket:' .. id
  local t = redis.call('HMGET', tk, 'status', 'joinedAt', 'number', 'lang')
  if t[1] == 'waiting' then
    redis.call('HSET', tk, 'status', 'called', 'counter', counter, 'calledAt', now)
    redis.call('EXPIRE', tk, ttl)
    redis.call('HSET', KEYS[1], counter, id)
    redis.call('EXPIRE', KEYS[1], ttl)
    redis.call('HINCRBY', KEYS[4], bestSvc .. ':waitSum', math.max(0, now - tonumber(t[2])))
    redis.call('HINCRBY', KEYS[4], bestSvc .. ':waitCount', 1)
    redis.call('EXPIRE', KEYS[4], statsTtl)
    redis.call('LPUSH', KEYS[3], cjson.encode({number = t[3], counter = tonumber(counter), service = bestSvc, at = now, lang = t[4] or nil}))
    redis.call('LTRIM', KEYS[3], 0, recentMax - 1)
    redis.call('EXPIRE', KEYS[3], ttl)
    -- Which counters serve which services, for wait estimates.
    local log = prefix .. 'calllog'
    redis.call('LPUSH', log, cjson.encode({c = tonumber(counter), s = bestSvc, at = now}))
    redis.call('LTRIM', log, 0, 199)
    redis.call('EXPIRE', log, ttl)
    return {'ok', id}
  end
end
return {'err', 'empty'}
`;

/**
 * Finish the ticket currently at a counter as served or no-show.
 * KEYS[1] counters hash, KEYS[2] today's stats hash, KEYS[3] counter-last hash
 * ARGV: prefix, counter, now, outcome, svcTimesMax, finishedTtl, expectedId ('' = any), ttl, statsTtl
 */
export const COMPLETE = `
local prefix, counter, now, outcome = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]
local svcMax, finishedTtl, expected, ttl, statsTtl = tonumber(ARGV[5]), ARGV[6], ARGV[7], ARGV[8], ARGV[9]

local id = redis.call('HGET', KEYS[1], counter)
if not id then return {'err', 'no_active'} end
if expected ~= '' and expected ~= id then return {'err', 'stale', id} end

local tk = prefix .. 'ticket:' .. id
local t = redis.call('HMGET', tk, 'status', 'service', 'calledAt', 'number')
redis.call('HDEL', KEYS[1], counter)
if t[1] ~= 'called' then return {'err', 'no_active', id} end

redis.call('HSET', tk, 'status', outcome, 'endedAt', now)
redis.call('EXPIRE', tk, finishedTtl)
-- The ticket has ended: its alert contact details go with it.
redis.call('DEL', prefix .. 'notify:' .. id)
redis.call('SREM', prefix .. 'notifyidx', id)
if outcome == 'served' then
  local svcKey = prefix .. 'svctimes:' .. t[2]
  -- "duration:endedAt", so estimates can use a rolling time window.
  redis.call('LPUSH', svcKey, math.max(0, now - tonumber(t[3])) .. ':' .. now)
  redis.call('LTRIM', svcKey, 0, svcMax - 1)
  redis.call('EXPIRE', svcKey, ttl)
  redis.call('HINCRBY', KEYS[2], t[2] .. ':served', 1)
else
  redis.call('HINCRBY', KEYS[2], t[2] .. ':noShow', 1)
end
redis.call('EXPIRE', KEYS[2], statsTtl)
redis.call('HSET', KEYS[3], counter, cjson.encode({number = t[4], outcome = outcome, at = now}))
redis.call('EXPIRE', KEYS[3], ttl)
return {'ok', id}
`;

/**
 * Resident leaves the line — whether still waiting or already called.
 * KEYS[1] counters hash, KEYS[2] today's stats hash, KEYS[3] counter-last hash
 * ARGV: prefix, id, now, finishedTtl, ttl, statsTtl
 * Returns {'ok', previousStatus} or {'err', code}.
 */
export const LEAVE = `
local prefix, id, now, finishedTtl, ttl, statsTtl = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4], ARGV[5], ARGV[6]
local tk = prefix .. 'ticket:' .. id
local t = redis.call('HMGET', tk, 'status', 'service', 'counter', 'number')
if not t[1] then return {'err', 'not_found'} end

if t[1] == 'waiting' then
  redis.call('ZREM', prefix .. 'queue:' .. t[2], id)
elseif t[1] == 'called' then
  if redis.call('HGET', KEYS[1], t[3]) == id then
    redis.call('HDEL', KEYS[1], t[3])
    redis.call('HSET', KEYS[3], t[3], cjson.encode({number = t[4], outcome = 'left', at = now}))
    redis.call('EXPIRE', KEYS[3], ttl)
  end
else
  return {'err', 'not_active', t[1]}
end

redis.call('HSET', tk, 'status', 'left', 'endedAt', now)
redis.call('EXPIRE', tk, finishedTtl)
redis.call('DEL', prefix .. 'notify:' .. id)
redis.call('SREM', prefix .. 'notifyidx', id)
redis.call('HINCRBY', KEYS[2], t[2] .. ':left', 1)
redis.call('EXPIRE', KEYS[2], statsTtl)
return {'ok', t[1]}
`;

/**
 * Re-announce the ticket currently at a counter.
 * KEYS[1] counters hash, KEYS[2] recent list
 * ARGV: prefix, counter, now, recentMax, ttl
 */
export const RECALL = `
local prefix, counter, now, recentMax, ttl = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5]
local id = redis.call('HGET', KEYS[1], counter)
if not id then return {'err', 'no_active'} end
local tk = prefix .. 'ticket:' .. id
local t = redis.call('HMGET', tk, 'status', 'number', 'service', 'lang')
if t[1] ~= 'called' then return {'err', 'no_active'} end
redis.call('HINCRBY', tk, 'recallCount', 1)
redis.call('HSET', tk, 'recalledAt', now)
redis.call('EXPIRE', tk, ttl)
redis.call('LPUSH', KEYS[2], cjson.encode({number = t[2], counter = tonumber(counter), service = t[3], at = now, recall = true, lang = t[4] or nil}))
redis.call('LTRIM', KEYS[2], 0, recentMax - 1)
redis.call('EXPIRE', KEYS[2], ttl)
return {'ok', id}
`;

/**
 * Refresh the inactivity TTL on every live key of an office: its metadata,
 * queues, counters, and the tickets still waiting or being served.
 * (Finished tickets and daily stats keep their own, shorter TTLs.)
 * ARGV: prefix, ttl, service1 [, service2, ...]
 */
export const TOUCH = `
local prefix, ttl = ARGV[1], ARGV[2]
local function touchTicket(id)
  redis.call('EXPIRE', prefix .. 'ticket:' .. id, ttl)
  redis.call('EXPIRE', prefix .. 'notify:' .. id, ttl)
  redis.call('EXPIRE', prefix .. 'alerts:' .. id, ttl)
end
for _, k in ipairs({'meta', 'counters', 'counterlast', 'paused', 'recent', 'calllog', 'notifyidx'}) do
  redis.call('EXPIRE', prefix .. k, ttl)
end
for i = 3, #ARGV do
  local q = prefix .. 'queue:' .. ARGV[i]
  redis.call('EXPIRE', q, ttl)
  redis.call('EXPIRE', prefix .. 'svctimes:' .. ARGV[i], ttl)
  for _, id in ipairs(redis.call('ZRANGE', q, 0, -1)) do touchTicket(id) end
end
for _, id in ipairs(redis.call('HVALS', prefix .. 'counters')) do touchTicket(id) end
return 1
`;

/**
 * Save office settings, refusing to remove a service that still has people in
 * line (or at a counter) or a counter that is serving someone.
 * KEYS[1] meta hash, KEYS[2] counters hash
 * ARGV: prefix, ttl, configJson, nRemovedServices, removedSvc..., removedCounter...
 */
export const SAVE_CONFIG = `
local prefix, ttl, json, nSvc = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4])
if redis.call('EXISTS', KEYS[1]) == 0 then return {'err', 'not_found'} end
local active = redis.call('HGETALL', KEYS[2])
for i = 5, 4 + nSvc do
  local svc = ARGV[i]
  local waiting = redis.call('ZCARD', prefix .. 'queue:' .. svc)
  if waiting > 0 then return {'err', 'service_busy', svc, tostring(waiting)} end
  for j = 2, #active, 2 do
    local t = redis.call('HMGET', prefix .. 'ticket:' .. active[j], 'service', 'status')
    if t[1] == svc and t[2] == 'called' then return {'err', 'service_busy', svc, '0'} end
  end
end
for i = 5 + nSvc, #ARGV do
  local id = redis.call('HGET', KEYS[2], ARGV[i])
  if id and redis.call('HGET', prefix .. 'ticket:' .. id, 'status') == 'called' then
    return {'err', 'counter_busy', ARGV[i]}
  end
end
redis.call('HSET', KEYS[1], 'config', json)
redis.call('EXPIRE', KEYS[1], ttl)
return {'ok'}
`;

/**
 * Fixed-window rate limiter.
 * KEYS[1] bucket key; ARGV: windowMs. Returns {count, msUntilReset}.
 */
export const RATE_LIMIT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}
`;

/**
 * Mark (or, with an empty reason, unmark) a waiting ticket as priority, found
 * by its public number. Rescoring keeps priority tickets in their own join order.
 * ARGV: prefix, number, reason, ttl, service1 [, service2, ...]
 * Returns {'ok', ticketId} or {'err', code}.
 */
export const SET_PRIORITY = `${SCORE_FN}
local prefix, number, reason, ttl = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
for i = 5, #ARGV do
  local q = prefix .. 'queue:' .. ARGV[i]
  for _, id in ipairs(redis.call('ZRANGE', q, 0, -1)) do
    local tk = prefix .. 'ticket:' .. id
    local t = redis.call('HMGET', tk, 'number', 'status', 'orderAt', 'joinedAt', 'seq')
    if t[1] == number then
      if t[2] ~= 'waiting' then return {'err', 'not_active'} end
      if reason == '' then redis.call('HDEL', tk, 'priority') else redis.call('HSET', tk, 'priority', reason) end
      redis.call('ZADD', q, 'XX', score(reason, t[3] or t[4], t[5] or 0), id)
      redis.call('EXPIRE', tk, ttl)
      return {'ok', id}
    end
  end
end
return {'err', 'not_found'}
`;

/**
 * Book an appointment slot, never exceeding its capacity.
 * KEYS[1] slot-count hash for the date, KEYS[2] appointments-by-date sorted set
 * ARGV: prefix, apptId, slotField, capacity, name, service, date, time, slotStart, now, ref, ttl, lang
 */
export const BOOK = `
local prefix, id, field, capacity = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4])
local ttl = ARGV[12]
local booked = tonumber(redis.call('HGET', KEYS[1], field) or '0')
if booked >= capacity then return {'err', 'slot_full'} end
redis.call('HINCRBY', KEYS[1], field, 1)
redis.call('EXPIRE', KEYS[1], ttl)
local ak = prefix .. 'appt:' .. id
redis.call('HSET', ak, 'id', id, 'ref', ARGV[11], 'name', ARGV[5], 'service', ARGV[6], 'date', ARGV[7], 'time', ARGV[8],
  'slotStart', ARGV[9], 'status', 'booked', 'createdAt', ARGV[10], 'lang', ARGV[13])
redis.call('EXPIRE', ak, ttl)
redis.call('ZADD', KEYS[2], ARGV[9], id)
redis.call('EXPIRE', KEYS[2], ttl)
return {'ok', id}
`;

/**
 * Cancel a booked appointment and free its place in the slot.
 * ARGV: prefix, apptId
 */
export const CANCEL_APPT = `
local prefix, id = ARGV[1], ARGV[2]
local ak = prefix .. 'appt:' .. id
local a = redis.call('HMGET', ak, 'status', 'date', 'time', 'service')
if not a[1] then return {'err', 'not_found'} end
if a[1] ~= 'booked' then return {'err', 'not_active', a[1]} end
redis.call('HSET', ak, 'status', 'cancelled')
redis.call('DEL', prefix .. 'notify:appt:' .. id)
redis.call('HINCRBY', prefix .. 'slots:' .. a[2], a[3] .. '|' .. a[4], -1)
return {'ok', id}
`;

/**
 * Check in for an appointment: within [slot - early, slot + late] it becomes a
 * ticket ordered as if it joined at the slot time. Later than that, it's missed.
 * Checking in twice returns the same ticket.
 * KEYS[1] seq key
 * ARGV: prefix, apptId, now, earlyMs, lateMs, ticketId, service, code, seqTtl, ttl
 */
export const CHECK_IN = `${SCORE_FN}
local prefix, apptId, now, early, late = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local ticketId, service, code, seqTtl, ttl = ARGV[6], ARGV[7], ARGV[8], ARGV[9], ARGV[10]
local ak = prefix .. 'appt:' .. apptId
local a = redis.call('HMGET', ak, 'status', 'service', 'name', 'slotStart', 'ticketId', 'lang')
if not a[1] then return {'err', 'not_found'} end
if a[1] == 'checked_in' then return {'ok', a[5], 'existing'} end
if a[1] ~= 'booked' then return {'err', 'not_active', a[1]} end
if a[2] ~= service then return {'err', 'invalid'} end
local slot = tonumber(a[4])
if now < slot - early then return {'err', 'too_early'} end
if now > slot + late then
  redis.call('HSET', ak, 'status', 'missed')
  redis.call('DEL', prefix .. 'notify:appt:' .. apptId)
  return {'err', 'missed'}
end

local seq = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], seqTtl)
local number = code .. '-' .. string.format('%03d', ((seq - 1) % 999) + 1)
local tk = prefix .. 'ticket:' .. ticketId
redis.call('HSET', tk,
  'id', ticketId, 'number', number, 'name', a[3], 'service', service, 'kind', 'appointment', 'appointmentId', apptId,
  'appointmentAt', slot, 'status', 'waiting', 'joinedAt', now, 'orderAt', slot, 'seq', seq, 'recallCount', 0, 'lang', a[6] or 'en')
redis.call('EXPIRE', tk, ttl)
local q = prefix .. 'queue:' .. service
redis.call('ZADD', q, score(nil, slot, seq), ticketId)
redis.call('EXPIRE', q, ttl)
redis.call('HSET', ak, 'status', 'checked_in', 'ticketId', ticketId, 'checkedInAt', now)
-- Alerts the resident asked for on their appointment now follow their ticket.
local nk = prefix .. 'notify:appt:' .. apptId
if redis.call('EXISTS', nk) == 1 then
  local tnk = prefix .. 'notify:' .. ticketId
  redis.call('RENAME', nk, tnk)
  redis.call('EXPIRE', tnk, ttl)
  redis.call('SADD', prefix .. 'notifyidx', ticketId)
  redis.call('EXPIRE', prefix .. 'notifyidx', ttl)
end
return {'ok', ticketId, 'new'}
`;

/**
 * Mark booked appointments whose check-in window has closed as missed.
 * KEYS[1] appointments-by-date sorted set; ARGV: prefix, cutoff (slotStart <= cutoff)
 */
export const EXPIRE_MISSED = `
local n = 0
for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])) do
  local ak = ARGV[1] .. 'appt:' .. id
  if redis.call('HGET', ak, 'status') == 'booked' then
    redis.call('HSET', ak, 'status', 'missed')
    redis.call('DEL', ARGV[1] .. 'notify:appt:' .. id)
    n = n + 1
  end
end
return n
`;

/**
 * Queue an alert exactly once. The HSETNX on the target's "alerted" hash is the
 * dedupe: repeated scans, or several server processes scanning at once, can
 * only ever create one set of jobs for a given alert.
 * KEYS[1] alerted hash, KEYS[2] contact hash, KEYS[3] global jobs sorted set
 * ARGV: field, now, ttl, pushJobJson ('' = none), emailJobJson ('' = none)
 * Returns the number of jobs queued (0 if already alerted or no contact).
 */
export const ENQUEUE_ALERT = `
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[3])
local n = 0
if ARGV[4] ~= '' and redis.call('HEXISTS', KEYS[2], 'push') == 1 then
  redis.call('ZADD', KEYS[3], ARGV[2], ARGV[4])
  n = n + 1
end
if ARGV[5] ~= '' and redis.call('HEXISTS', KEYS[2], 'email') == 1 then
  redis.call('ZADD', KEYS[3], ARGV[2], ARGV[5])
  n = n + 1
end
return n
`;

/**
 * Claim due jobs for this worker under a lease. Jobs whose lease ran out (a
 * worker crashed mid-send) go back to the queue first.
 * KEYS[1] jobs sorted set, KEYS[2] processing sorted set
 * ARGV: now, leaseMs, limit
 */
export const CLAIM_JOBS = `
local now, lease, limit = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
for _, m in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)) do
  redis.call('ZREM', KEYS[2], m)
  redis.call('ZADD', KEYS[1], now, m)
end
local ready = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, limit)
for _, m in ipairs(ready) do
  redis.call('ZREM', KEYS[1], m)
  redis.call('ZADD', KEYS[2], now + lease, m)
end
return ready
`;

/**
 * Change the language on an existing ticket or appointment hash. Never creates
 * the key (a plain HSET on an expired ticket would leave a key with no TTL).
 * KEYS[1] ticket or appointment hash. ARGV: lang. Returns 1 if updated.
 */
export const SET_LANG = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'lang', ARGV[1])
return 1
`;
