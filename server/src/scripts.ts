/**
 * Lua scripts for every queue mutation. Redis executes a script atomically —
 * no other command runs while it is in progress — so these are the
 * concurrency boundary of the whole app.
 *
 * Ticket/queue keys are derived inside the scripts from a prefix argument
 * (fine for a single Redis instance; would need hash tags for Redis Cluster).
 */

/**
 * KEYS[1] seq key
 * ARGV: prefix, id, name, service, code, joinedAt, seqTtlSec
 * Returns the ticket number.
 */
export const JOIN = `
local prefix, id, name, service, code, joinedAt, seqTtl = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6], ARGV[7]
local seq = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], seqTtl)
local number = code .. '-' .. string.format('%03d', ((seq - 1) % 999) + 1)
redis.call('HSET', prefix .. 'ticket:' .. id,
  'id', id, 'number', number, 'name', name, 'service', service,
  'status', 'waiting', 'joinedAt', joinedAt, 'recallCount', 0)
-- Score by join time; the sequence breaks ties so same-millisecond joins stay first-come, first-served.
redis.call('ZADD', prefix .. 'queue:' .. service, tonumber(joinedAt) * 1000 + (seq % 1000), id)
return number
`;

/**
 * KEYS[1] counters hash, KEYS[2] paused set, KEYS[3] recent list, KEYS[4] today's stats hash
 * ARGV: prefix, counter, now, recentMax, service1 [, service2, ...]
 * Picks the longest-waiting ticket among the given (unpaused) services.
 * Returns {'ok', ticketId} or {'err', code[, detail]}.
 */
export const CALL_NEXT = `
local prefix, counter, now, recentMax = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])

local busy = redis.call('HGET', KEYS[1], counter)
if busy then
  if redis.call('HGET', prefix .. 'ticket:' .. busy, 'status') == 'called' then
    return {'err', 'counter_busy', busy}
  end
  redis.call('HDEL', KEYS[1], counter)
end

local open = {}
for i = 5, #ARGV do
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
  local t = redis.call('HMGET', tk, 'status', 'joinedAt', 'number')
  if t[1] == 'waiting' then
    redis.call('HSET', tk, 'status', 'called', 'counter', counter, 'calledAt', now)
    redis.call('HSET', KEYS[1], counter, id)
    redis.call('HINCRBY', KEYS[4], bestSvc .. ':waitSum', math.max(0, now - tonumber(t[2])))
    redis.call('HINCRBY', KEYS[4], bestSvc .. ':waitCount', 1)
    redis.call('LPUSH', KEYS[3], cjson.encode({number = t[3], counter = tonumber(counter), service = bestSvc, at = now}))
    redis.call('LTRIM', KEYS[3], 0, recentMax - 1)
    return {'ok', id}
  end
end
return {'err', 'empty'}
`;

/**
 * Finish the ticket currently at a counter as served or no-show.
 * KEYS[1] counters hash, KEYS[2] today's stats hash, KEYS[3] counter-last hash
 * ARGV: prefix, counter, now, outcome, svcTimesMax, ttlSec, expectedId ('' = any)
 */
export const COMPLETE = `
local prefix, counter, now, outcome = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]
local svcMax, ttl, expected = tonumber(ARGV[5]), ARGV[6], ARGV[7]

local id = redis.call('HGET', KEYS[1], counter)
if not id then return {'err', 'no_active'} end
if expected ~= '' and expected ~= id then return {'err', 'stale', id} end

local tk = prefix .. 'ticket:' .. id
local t = redis.call('HMGET', tk, 'status', 'service', 'calledAt', 'number')
redis.call('HDEL', KEYS[1], counter)
if t[1] ~= 'called' then return {'err', 'no_active', id} end

redis.call('HSET', tk, 'status', outcome, 'endedAt', now)
redis.call('EXPIRE', tk, ttl)
if outcome == 'served' then
  local svcKey = prefix .. 'svctimes:' .. t[2]
  redis.call('LPUSH', svcKey, math.max(0, now - tonumber(t[3])))
  redis.call('LTRIM', svcKey, 0, svcMax - 1)
  redis.call('HINCRBY', KEYS[2], t[2] .. ':served', 1)
else
  redis.call('HINCRBY', KEYS[2], t[2] .. ':noShow', 1)
end
redis.call('HSET', KEYS[3], counter, cjson.encode({number = t[4], outcome = outcome, at = now}))
return {'ok', id}
`;

/**
 * Resident leaves the line — whether still waiting or already called.
 * KEYS[1] counters hash, KEYS[2] today's stats hash, KEYS[3] counter-last hash
 * ARGV: prefix, id, now, ttlSec
 * Returns {'ok', previousStatus} or {'err', code}.
 */
export const LEAVE = `
local prefix, id, now, ttl = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]
local tk = prefix .. 'ticket:' .. id
local t = redis.call('HMGET', tk, 'status', 'service', 'counter', 'number')
if not t[1] then return {'err', 'not_found'} end

if t[1] == 'waiting' then
  redis.call('ZREM', prefix .. 'queue:' .. t[2], id)
elseif t[1] == 'called' then
  if redis.call('HGET', KEYS[1], t[3]) == id then
    redis.call('HDEL', KEYS[1], t[3])
    redis.call('HSET', KEYS[3], t[3], cjson.encode({number = t[4], outcome = 'left', at = now}))
  end
else
  return {'err', 'not_active', t[1]}
end

redis.call('HSET', tk, 'status', 'left', 'endedAt', now)
redis.call('EXPIRE', tk, ttl)
redis.call('HINCRBY', KEYS[2], t[2] .. ':left', 1)
return {'ok', t[1]}
`;

/**
 * Re-announce the ticket currently at a counter.
 * KEYS[1] counters hash, KEYS[2] recent list
 * ARGV: prefix, counter, now, recentMax
 */
export const RECALL = `
local prefix, counter, now, recentMax = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
local id = redis.call('HGET', KEYS[1], counter)
if not id then return {'err', 'no_active'} end
local tk = prefix .. 'ticket:' .. id
local t = redis.call('HMGET', tk, 'status', 'number', 'service')
if t[1] ~= 'called' then return {'err', 'no_active'} end
redis.call('HINCRBY', tk, 'recallCount', 1)
redis.call('HSET', tk, 'recalledAt', now)
redis.call('LPUSH', KEYS[2], cjson.encode({number = t[2], counter = tonumber(counter), service = t[3], at = now, recall = true}))
redis.call('LTRIM', KEYS[2], 0, recentMax - 1)
return {'ok', id}
`;
